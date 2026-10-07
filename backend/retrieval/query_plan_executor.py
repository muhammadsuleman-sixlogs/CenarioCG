from __future__ import annotations

from collections.abc import Callable
from concurrent.futures import (
    ThreadPoolExecutor,
    as_completed,
)
from typing import Any

from planning.query_plan import (
    InputBinding,
    QueryPlan,
    QueryStep,
)


StepExecutor = Callable[
    [QueryStep, dict[str, Any]],
    dict[str, Any],
]


class QueryPlanExecutor:
    """
    Dependency-aware execution engine for QueryPlan.

    Architecture:

        QueryPlan
            |
            v
        dependency layers
            |
            +----------------------+
            |                      |
            v                      v
        independent             dependent
        branches                 branches
            |                      |
            +----------+-----------+
                       |
                       v
                 runtime bindings
                       |
                       v
                source executor
                       |
                       v
                 final result

    Responsibilities:
        - execute dependency-aware plans
        - execute independent source steps concurrently
        - resolve runtime key bindings
        - perform local relational/set operations
        - preserve source boundaries
        - preserve failure states

    This class never:
        - calls an LLM
        - generates SQL
        - changes PostgreSQL
        - invents relationships
        - embeds runtime values into SQL
        - converts upstream failures into empty results
    """

    MAX_STEPS = 16
    MAX_BINDING_VALUES = 500
    MAX_TOTAL_BINDING_VALUES = 2_000
    MAX_PARAMETER_BINDINGS = 64
    MAX_PARALLEL_BRANCHES = 4
    MAX_DEPENDENCY_DEPTH = 16

    FAILURE_STATUSES = {
        "retrieval_failed",
        "retryable_failure",
        "permanent_failure",
        "timeout",
    }

    SUCCESS_STATUSES = {
        "success_with_data",
        "success_empty",
        "success",
    }

    def execute(
        self,
        plan: QueryPlan,
        step_executor: StepExecutor,
    ) -> dict[str, Any]:
        """
        Execute a validated QueryPlan.

        Independent steps in the same dependency layer can run
        concurrently.

        Results are inserted into the returned dictionary in deterministic
        step-id order even when execution completes in a different order.
        """

        if not isinstance(
            plan,
            QueryPlan,
        ):
            raise ValueError(
                "plan must be a QueryPlan instance."
            )

        if not callable(
            step_executor,
        ):
            raise ValueError(
                "step_executor must be callable."
            )

        # The canonical QuestionPlanValidator validates the semantic
        # execution graph before this executor is called. The legacy
        # QueryPlan validator incorrectly interprets logical `inputs` on
        # source_query/final_query steps as execution-step references.
        steps = list(
            plan.steps
        )

        if len(steps) > self.MAX_STEPS:
            raise ValueError(
                f"Query plan exceeds the maximum of "
                f"{self.MAX_STEPS} steps."
            )

        layers = self._build_execution_layers(
            plan
        )

        results: dict[
            str,
            dict[str, Any],
        ] = {}

        for layer in layers:
            layer_results = self._execute_layer(
                layer=layer,
                results=results,
                step_executor=step_executor,
            )

            for step in sorted(
                layer,
                key=lambda item: item.step_id,
            ):
                results[
                    step.step_id
                ] = layer_results[
                    step.step_id
                ]

        final_result = results.get(
            plan.final_step
        )

        if final_result is None:
            raise ValueError(
                f"Final step {plan.final_step!r} "
                "did not produce a result."
            )

        self._raise_if_failed_result(
            step_id=plan.final_step,
            result=final_result,
        )

        return {
            "status": "success",
            "final_step": plan.final_step,
            "steps": results,
            "result": final_result,
            "plan": plan.to_dict(),
        }

    # ------------------------------------------------------------------
    # Dependency graph
    # ------------------------------------------------------------------

    def _build_execution_layers(
        self,
        plan: QueryPlan,
    ) -> list[list[QueryStep]]:
        """
        Build deterministic dependency layers without requiring any extra
        function in planning.query_plan.

        A step belongs to the earliest layer after all of its dependencies
        and set-operation inputs are complete.

        This gives us parallelism for truly independent branches.
        """

        step_map = {
            step.step_id: step
            for step in plan.steps
        }

        pending = set(
            step_map
        )

        completed: set[str] = set()

        layers: list[
            list[QueryStep]
        ] = []

        while pending:
            ready: list[
                QueryStep
            ] = []

            for step_id in sorted(
                pending
            ):
                step = step_map[
                    step_id
                ]

                dependencies = set(step.depends_on)

                # For source_query/final_query, `inputs` are logical
                # input names, not execution-step IDs. Only set_operation
                # uses `inputs` as step IDs.
                if step.step_type == "set_operation":
                    dependencies.update(step.inputs)

                if dependencies.issubset(
                    completed
                ):
                    ready.append(
                        step
                    )

            if not ready:
                raise ValueError(
                    "Unable to build query-plan execution layers. "
                    "The plan contains unresolved dependencies."
                )

            layers.append(
                ready
            )

            for step in ready:
                pending.remove(
                    step.step_id
                )
                completed.add(
                    step.step_id
                )

        return layers

    # ------------------------------------------------------------------
    # Layer execution
    # ------------------------------------------------------------------

    def _execute_layer(
        self,
        layer: list[QueryStep],
        results: dict[str, dict[str, Any]],
        step_executor: StepExecutor,
    ) -> dict[str, dict[str, Any]]:
        if not layer:
            return {}

        if len(layer) == 1:
            step = layer[0]

            return {
                step.step_id: self._execute_step(
                    step=step,
                    results=results,
                    step_executor=step_executor,
                )
            }

        max_workers = min(
            self.MAX_PARALLEL_BRANCHES,
            len(layer),
        )

        completed: dict[
            str,
            dict[str, Any],
        ] = {}

        with ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix="query-step",
        ) as executor:
            futures = {
                executor.submit(
                    self._execute_step,
                    step,
                    results,
                    step_executor,
                ): step
                for step in layer
            }

            try:
                for future in as_completed(
                    futures
                ):
                    step = futures[
                        future
                    ]

                    completed[
                        step.step_id
                    ] = future.result()

            except Exception:
                for future in futures:
                    future.cancel()

                raise

        # Deterministic result order.
        return {
            step.step_id: completed[
                step.step_id
            ]
            for step in sorted(
                layer,
                key=lambda item: item.step_id,
            )
        }

    # ------------------------------------------------------------------
    # Step execution
    # ------------------------------------------------------------------

    def _execute_step(
        self,
        step: QueryStep,
        results: dict[str, dict[str, Any]],
        step_executor: StepExecutor,
    ) -> dict[str, Any]:
        # `inputs` are execution-step references only for set_operation.
        # For source_query/final_query, inputs may be logical field names.
        inputs = (
            {
                input_id: results[
                    input_id
                ]
                for input_id in step.inputs
            }
            if step.step_type == "set_operation"
            else {}
        )

        dependencies = {
            dependency_id: results[
                dependency_id
            ]
            for dependency_id in step.depends_on
        }

        self._reject_failed_dependencies(
            step=step,
            dependencies=dependencies,
        )

        runtime_bindings = (
            self._resolve_input_bindings(
                step=step,
                results=results,
            )
        )

        context = {
            "inputs": inputs,
            "dependencies": dependencies,
            "results": results,
            "runtime_bindings": runtime_bindings,
        }

        if step.step_type in {
            "source_query",
            "final_query",
        }:
            if runtime_bindings.get(
                "skip"
            ):
                result = self._empty_source_result(
                    step=step,
                    reason=runtime_bindings[
                        "reason"
                    ],
                )
            else:
                result = step_executor(
                    step,
                    context,
                )

            if not isinstance(
                result,
                dict,
            ):
                raise ValueError(
                    f"Step {step.step_id!r} executor "
                    "must return a dictionary."
                )

            self._validate_result_status(
                step=step,
                result=result,
            )

            return self._attach_provenance(
                result=result,
                step=step,
                runtime_bindings=runtime_bindings,
            )

        if step.step_type == "set_operation":
            result = self._execute_set_operation(
                step=step,
                inputs=inputs,
            )

            self._validate_result_status(
                step=step,
                result=result,
            )

            return result

        raise ValueError(
            f"Unsupported query step type: "
            f"{step.step_type!r}"
        )

    # ------------------------------------------------------------------
    # Dependency failures
    # ------------------------------------------------------------------

    def _reject_failed_dependencies(
        self,
        step: QueryStep,
        dependencies: dict[str, dict[str, Any]],
    ) -> None:
        """
        An upstream failure is NOT equivalent to empty data.

        This is critical for authoritative answers.
        """

        for dependency_id, result in dependencies.items():
            status = self._result_status(
                result
            )

            if status in self.FAILURE_STATUSES:
                message = self._error_message(
                    result
                )

                raise RuntimeError(
                    f"Step {step.step_id!r} cannot execute because "
                    f"dependency {dependency_id!r} failed: "
                    f"{message}"
                )

    @staticmethod
    def _error_message(
        result: dict[str, Any],
    ) -> str:
        error = result.get(
            "error"
        )

        if isinstance(
            error,
            dict,
        ):
            message = error.get(
                "message"
            )

            if message:
                return str(
                    message
                )

        return "upstream retrieval failed"

    # ------------------------------------------------------------------
    # Runtime binding resolution
    # ------------------------------------------------------------------

    def _resolve_input_bindings(
        self,
        step: QueryStep,
        results: dict[str, dict[str, Any]],
    ) -> dict[str, Any]:
        """
        Resolve dependency values into PostgreSQL parameter values.

        Actual values remain outside SQL.

        The returned binding indexes are contiguous and deterministic in
        input_bindings order.
        """

        if not step.input_bindings:
            return {
                "bindings": [],
                "parameters": [],
                "skip": False,
                "reason": "",
            }

        if len(
            step.input_bindings
        ) > self.MAX_PARAMETER_BINDINGS:
            raise ValueError(
                f"Step {step.step_id!r} exceeds the maximum of "
                f"{self.MAX_PARAMETER_BINDINGS} runtime bindings."
            )

        resolved: list[
            dict[str, Any]
        ] = []

        parameters: list[Any] = []

        total_values = 0

        for binding in step.input_bindings:
            source_result = results.get(
                binding.from_step
            )

            if source_result is None:
                raise ValueError(
                    f"Input binding source step "
                    f"{binding.from_step!r} has not produced "
                    f"a result for step {step.step_id!r}."
                )

            status = self._result_status(
                source_result
            )

            if status in self.FAILURE_STATUSES:
                raise RuntimeError(
                    f"Cannot resolve runtime binding for step "
                    f"{step.step_id!r}: dependency "
                    f"{binding.from_step!r} failed: "
                    f"{self._error_message(source_result)}"
                )

            rows = self._extract_rows(
                source_result
            )

            values = self._extract_binding_values(
                rows=rows,
                binding=binding,
            )

            if len(
                values
            ) > self.MAX_BINDING_VALUES:
                raise ValueError(
                    f"Runtime binding from "
                    f"{binding.from_step!r} produced more than "
                    f"{self.MAX_BINDING_VALUES} values."
                )

            total_values += len(
                values
            )

            if (
                total_values
                > self.MAX_TOTAL_BINDING_VALUES
            ):
                raise ValueError(
                    f"Step {step.step_id!r} exceeded the maximum "
                    f"runtime binding value count of "
                    f"{self.MAX_TOTAL_BINDING_VALUES}."
                )

            # ----------------------------------------------------------
            # IN
            #
            # No upstream values means the dependent query cannot match.
            # Skip safely.
            # ----------------------------------------------------------

            if binding.operator == "in":
                if not values:
                    return {
                        "bindings": [],
                        "parameters": [],
                        "skip": True,
                        "reason": (
                            f"Dependency step "
                            f"{binding.from_step!r} produced no "
                            "values for an IN binding."
                        ),
                    }

                resolved_operator = "in"
                parameter_value: Any = list(
                    values
                )

            # ----------------------------------------------------------
            # EQUALS
            #
            # Single upstream value uses scalar equality; multiple upstream
            # values generalize to IN set-membership so multi-record queries
            # execute without runtime failure.
            # ----------------------------------------------------------

            elif binding.operator == "equals":
                if not values:
                    return {
                        "bindings": [],
                        "parameters": [],
                        "skip": True,
                        "reason": (
                            f"Dependency step "
                            f"{binding.from_step!r} produced no "
                            "value for an equality binding."
                        ),
                    }

                if len(values) == 1:
                    resolved_operator = "equals"
                    parameter_value = values[0]
                else:
                    resolved_operator = "in"
                    parameter_value = list(values)

            # ----------------------------------------------------------
            # NOT_IN
            #
            # IMPORTANT:
            # Empty exclusion set means "exclude nothing".
            # Therefore the dependent query MUST still run.
            # ----------------------------------------------------------

            elif binding.operator == "not_in":
                if not values:
                    continue

                resolved_operator = "not_in"
                parameter_value = list(
                    values
                )

            else:
                raise ValueError(
                    f"Unsupported input binding operator: "
                    f"{binding.operator!r}"
                )

            # The index is the index in the *actual emitted bindings*,
            # not the original raw input_bindings list.
            runtime_index = len(
                resolved
            )

            resolved.append(
                {
                    "index": runtime_index,
                    "from_step": binding.from_step,
                    "from_column": binding.from_column,
                    "to_table": binding.to_table,
                    "to_column": binding.to_column,
                    "operator": resolved_operator,
                    "values": values,
                }
            )

            parameters.append(
                parameter_value
            )

        return {
            "bindings": resolved,
            "parameters": parameters,
            "skip": False,
            "reason": "",
        }

    def _extract_binding_values(
        self,
        rows: list[dict[str, Any]],
        binding: InputBinding,
    ) -> list[Any]:
        values: list[Any] = []

        for row in rows:
            if (
                binding.from_column
                not in row
            ):
                raise ValueError(
                    f"Input binding source column "
                    f"{binding.from_column!r} is missing "
                    f"from step {binding.from_step!r} output."
                )

            value = row.get(
                binding.from_column
            )

            if value is None:
                continue

            if not any(
                self._values_equal(
                    value,
                    existing,
                )
                for existing in values
            ):
                values.append(
                    value
                )

        return values

    # ------------------------------------------------------------------
    # Result helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _result_status(
        result: dict[str, Any],
    ) -> str | None:
        if not isinstance(
            result,
            dict,
        ):
            return None

        status = result.get(
            "execution_status"
        )

        if isinstance(
            status,
            str,
        ):
            return status.strip().lower()

        status = result.get(
            "retrieval_status"
        )

        if isinstance(
            status,
            str,
        ):
            return status.strip().lower()

        status = result.get(
            "status"
        )

        if isinstance(
            status,
            str,
        ):
            return status.strip().lower()

        return None

    def _validate_result_status(
        self,
        step: QueryStep,
        result: dict[str, Any],
    ) -> None:
        status = self._result_status(
            result
        )

        if status is None:
            return

        allowed = (
            self.SUCCESS_STATUSES
            | self.FAILURE_STATUSES
        )

        if status not in allowed:
            raise ValueError(
                f"Step {step.step_id!r} returned unsupported "
                f"execution status: {status!r}"
            )

    def _raise_if_failed_result(
        self,
        step_id: str,
        result: dict[str, Any],
    ) -> None:
        status = self._result_status(
            result
        )

        if status in self.FAILURE_STATUSES:
            raise RuntimeError(
                f"Final step {step_id!r} failed: "
                f"{self._error_message(result)}"
            )

    @staticmethod
    def _extract_rows(
        result: dict[str, Any],
    ) -> list[dict[str, Any]]:
        retrieval = result.get(
            "retrieval"
        )

        if isinstance(
            retrieval,
            dict,
        ):
            rows = retrieval.get(
                "rows",
                [],
            )
        else:
            rows = result.get(
                "rows",
                [],
            )

        if not isinstance(
            rows,
            list,
        ):
            raise ValueError(
                "Retrieval result rows must be a list."
            )

        return [
            row
            for row in rows
            if isinstance(
                row,
                dict,
            )
        ]

    @staticmethod
    def _values_equal(
        left: Any,
        right: Any,
    ) -> bool:
        try:
            result = left == right

            if isinstance(
                result,
                bool,
            ):
                return result

            return bool(
                result
            )

        except Exception:
            return repr(
                left
            ) == repr(
                right
            )

    # ------------------------------------------------------------------
    # Empty dependent result
    # ------------------------------------------------------------------

    @staticmethod
    def _empty_source_result(
        step: QueryStep,
        reason: str,
    ) -> dict[str, Any]:
        return {
            "source_type": "postgresql",
            "source_id": step.source_id,
            "retrieval_status": "success_empty",
            "execution_status": "success_empty",
            "retrieval": {
                "rows": [],
                "row_count": 0,
                "columns": [],
            },
            "sql": None,
            "repaired": False,
            "sources": [],
            "runtime_binding_skip": reason,
        }

    # ------------------------------------------------------------------
    # Local relational/set operations
    # ------------------------------------------------------------------

    def _execute_set_operation(
        self,
        step: QueryStep,
        inputs: dict[str, dict[str, Any]],
    ) -> dict[str, Any]:
        ordered_inputs = [
            inputs[input_id]
            for input_id in step.inputs
        ]

        if not ordered_inputs:
            raise ValueError(
                f"Set operation {step.step_id!r} "
                "has no input results."
            )

        # Set operations cannot consume failed inputs.
        for input_id, result in zip(
            step.inputs,
            ordered_inputs,
        ):
            status = self._result_status(
                result
            )

            if status in self.FAILURE_STATUSES:
                raise RuntimeError(
                    f"Set operation {step.step_id!r} cannot execute "
                    f"because input {input_id!r} failed: "
                    f"{self._error_message(result)}"
                )

        rows_by_input = [
            self._extract_rows(
                result
            )
            for result in ordered_inputs
        ]

        if step.operator == "distinct":
            rows = self._distinct_rows(
                rows=rows_by_input[0],
                key_columns=step.key_columns,
            )

        elif step.operator == "intersect":
            rows = self._intersect_rows(
                row_sets=rows_by_input,
                key_columns=step.key_columns,
            )

        elif step.operator == "union":
            all_rows = [
                row
                for rows in rows_by_input
                for row in rows
            ]

            rows = self._distinct_rows(
                rows=all_rows,
                key_columns=step.key_columns,
            )

        elif step.operator == "union_all":
            rows = [
                row
                for rows in rows_by_input
                for row in rows
            ]

        elif step.operator == "except":
            rows = self._except_rows(
                first_rows=rows_by_input[0],
                excluded_sets=rows_by_input[1:],
                key_columns=step.key_columns,
            )

        else:
            raise ValueError(
                f"Unsupported set operator: "
                f"{step.operator!r}"
            )

        status = (
            "success_with_data"
            if rows
            else "success_empty"
        )

        provenance = {
            "operation": step.operator,
            "inputs": list(
                step.inputs
            ),
            "key_columns": list(
                step.key_columns
            ),
        }

        return {
            "source_type": "relational_operation",
            "source_id": None,
            "retrieval_status": status,
            "execution_status": status,
            "retrieval": {
                "rows": rows,
                "row_count": len(
                    rows
                ),
                "columns": self._columns(
                    rows
                ),
                "provenance": provenance,
            },
            "provenance": provenance,
        }

    # ------------------------------------------------------------------
    # Set-operation helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _key(
        row: dict[str, Any],
        key_columns: list[str],
    ) -> tuple[Any, ...]:
        if not key_columns:
            raise ValueError(
                "Set operations require explicit key_columns."
            )

        missing = [
            column
            for column in key_columns
            if column not in row
        ]

        if missing:
            raise ValueError(
                "Set-operation key column(s) missing "
                f"from row: {missing}"
            )

        return tuple(
            row[column]
            for column in key_columns
        )

    def _distinct_rows(
        self,
        rows: list[dict[str, Any]],
        key_columns: list[str],
    ) -> list[dict[str, Any]]:
        seen: list[
            tuple[Any, ...]
        ] = []

        output: list[
            dict[str, Any]
        ] = []

        for row in rows:
            key = self._key(
                row,
                key_columns,
            )

            if any(
                self._keys_equal(
                    key,
                    existing,
                )
                for existing in seen
            ):
                continue

            seen.append(
                key
            )

            output.append(
                row
            )

        return output

    def _intersect_rows(
        self,
        row_sets: list[
            list[dict[str, Any]]
        ],
        key_columns: list[str],
    ) -> list[dict[str, Any]]:
        if not row_sets:
            return []

        key_sets: list[
            list[tuple[Any, ...]]
        ] = []

        for rows in row_sets:
            keys: list[
                tuple[Any, ...]
            ] = []

            for row in rows:
                key = self._key(
                    row,
                    key_columns,
                )

                if not any(
                    self._keys_equal(
                        key,
                        existing,
                    )
                    for existing in keys
                ):
                    keys.append(
                        key
                    )

            key_sets.append(
                keys
            )

        common = [
            key
            for key in key_sets[0]
            if all(
                any(
                    self._keys_equal(
                        key,
                        candidate,
                    )
                    for candidate in keys
                )
                for keys in key_sets[1:]
            )
        ]

        output: list[
            dict[str, Any]
        ] = []

        seen: list[
            tuple[Any, ...]
        ] = []

        for row in row_sets[0]:
            key = self._key(
                row,
                key_columns,
            )

            if not any(
                self._keys_equal(
                    key,
                    candidate,
                )
                for candidate in common
            ):
                continue

            if any(
                self._keys_equal(
                    key,
                    existing,
                )
                for existing in seen
            ):
                continue

            output.append(
                row
            )

            seen.append(
                key
            )

        return output

    def _except_rows(
        self,
        first_rows: list[
            dict[str, Any]
        ],
        excluded_sets: list[
            list[dict[str, Any]]
        ],
        key_columns: list[str],
    ) -> list[dict[str, Any]]:
        excluded: list[
            tuple[Any, ...]
        ] = []

        for rows in excluded_sets:
            for row in rows:
                key = self._key(
                    row,
                    key_columns,
                )

                if not any(
                    self._keys_equal(
                        key,
                        existing,
                    )
                    for existing in excluded
                ):
                    excluded.append(
                        key
                    )

        output: list[
            dict[str, Any]
        ] = []

        seen: list[
            tuple[Any, ...]
        ] = []

        for row in first_rows:
            key = self._key(
                row,
                key_columns,
            )

            if any(
                self._keys_equal(
                    key,
                    candidate,
                )
                for candidate in excluded
            ):
                continue

            if any(
                self._keys_equal(
                    key,
                    existing,
                )
                for existing in seen
            ):
                continue

            output.append(
                row
            )

            seen.append(
                key
            )

        return output

    @staticmethod
    def _keys_equal(
        left: tuple[Any, ...],
        right: tuple[Any, ...],
    ) -> bool:
        if len(left) != len(right):
            return False

        return all(
            QueryPlanExecutor._values_equal(
                left_value,
                right_value,
            )
            for left_value, right_value in zip(
                left,
                right,
            )
        )

    @staticmethod
    def _columns(
        rows: list[dict[str, Any]],
    ) -> list[str]:
        columns: list[str] = []

        for row in rows:
            for column in row:
                if column not in columns:
                    columns.append(
                        column
                    )

        return columns

    # ------------------------------------------------------------------
    # Provenance
    # ------------------------------------------------------------------

    @staticmethod
    def _attach_provenance(
        result: dict[str, Any],
        step: QueryStep,
        runtime_bindings: dict[str, Any],
    ) -> dict[str, Any]:
        output = dict(
            result
        )

        output[
            "step_id"
        ] = step.step_id

        output[
            "source_id"
        ] = step.source_id

        output[
            "query_step_type"
        ] = step.step_type

        output[
            "inputs"
        ] = list(
            step.inputs
        )

        output[
            "dependencies"
        ] = list(
            step.depends_on
        )

        output[
            "runtime_bindings"
        ] = {
            "count": len(
                runtime_bindings.get(
                    "bindings",
                    [],
                )
            ),
            "from_steps": [
                binding.get(
                    "from_step"
                )
                for binding in runtime_bindings.get(
                    "bindings",
                    [],
                )
            ],
            "target_columns": [
                {
                    "table": binding.get(
                        "to_table"
                    ),
                    "column": binding.get(
                        "to_column"
                    ),
                    "operator": binding.get(
                        "operator"
                    ),
                }
                for binding in runtime_bindings.get(
                    "bindings",
                    [],
                )
            ],
        }

        return output