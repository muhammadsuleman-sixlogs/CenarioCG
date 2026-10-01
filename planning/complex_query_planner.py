from __future__ import annotations

from typing import Any, Dict, List, Optional, Set

from planning.query_plan import (
    InputBinding,
    QueryPlan,
    QueryStep,
)


class ComplexQueryPlanner:
    """
    Deterministic adapter for the canonical execution plan.

    Important architecture rule:

        QuestionPlanner = WHAT?

        ComplexQueryPlanner = HOW TO REPRESENT THE ALREADY-DECIDED PLAN?

    This class MUST NOT:

    - call an LLM
    - create another QuestionPlanner
    - reinterpret user intent
    - invent tables, columns, relationships, sources, or joins
    - perform database access
    - repair semantic meaning

    The semantic decision is already made by QuestionPlanner.

    This class only converts the validated nested `execution_plan`
    into the QueryPlan / QueryStep intermediate representation.
    """

    def __init__(
        self,
        *args: Any,
        **kwargs: Any,
    ) -> None:
        # Kept intentionally compatible with older construction code.
        # No context, model, or LLM client is stored.
        self.max_steps = 16

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def should_decompose(
        self,
        question: Optional[str] = None,
        validated_plan: Optional[Dict[str, Any]] = None,
        *args: Any,
        **kwargs: Any,
    ) -> bool:
        """
        Return True only when the canonical plan explicitly contains
        a genuine multi-step execution plan.

        Important routing rule:

            - No execution_plan -> normal retrieval
            - Invalid/missing steps -> normal retrieval
            - One-step execution_plan -> normal retrieval
            - Multiple steps -> complex retrieval
            - mode='multi_step' alone is NOT enough when there is
              only one step

        No semantic inference is performed here.
        """

        plan = validated_plan or {}

        execution_plan = plan.get(
            "execution_plan"
        )

        if not isinstance(
            execution_plan,
            dict,
        ):
            return False

        steps = execution_plan.get(
            "steps"
        )

        if not isinstance(
            steps,
            list,
        ):
            return False

        mode = str(
            execution_plan.get(
                "mode",
                "",
            )
        ).strip().lower()

        # One-step plan = normal retrieval.
        if len(steps) <= 1:
            return False

        # Multiple steps represent coordinated execution.
        #
        # `mode == "multi_step"` is the canonical mode, while
        # `len(steps) > 1` provides deterministic protection if the
        # mode is omitted or malformed but the validated structure
        # clearly contains multiple steps.
        return (
            mode == "multi_step"
            or len(steps) > 1
        )

    def build(
        self,
        question_or_plan: Any = None,
        validated_plan: Optional[Dict[str, Any]] = None,
        *args: Any,
        **kwargs: Any,
    ) -> QueryPlan:
        """
        Convert the canonical execution_plan into QueryPlan.

        Supports both historical call styles:

            build(question, validated_plan)
            build(validated_plan)

        The question is not interpreted here.
        """

        plan = self._resolve_plan_input(
            question_or_plan=question_or_plan,
            validated_plan=validated_plan,
        )

        execution_plan = plan.get(
            "execution_plan"
        )

        if not isinstance(
            execution_plan,
            dict,
        ):
            raise ValueError(
                "missing_execution_plan: complex execution requires "
                "the canonical execution_plan produced by QuestionPlanner"
            )

        query_plan = self._compile_execution_plan(
            execution_plan
        )

        # QuestionPlanValidator has already validated the canonical
        # execution graph. Do not re-run the legacy QueryPlan validator here: 
        # it treats `inputs` as step IDs, while source_query/final_query
        # inputs are logical field names and runtime flow is represented by
        # `depends_on` + `input_bindings`.
        return query_plan

    # ------------------------------------------------------------------
    # Input handling
    # ------------------------------------------------------------------

    @staticmethod
    def _resolve_plan_input(
        question_or_plan: Any,
        validated_plan: Optional[Dict[str, Any]],
    ) -> Dict[str, Any]:
        if isinstance(
            validated_plan,
            dict,
        ):
            return validated_plan

        if isinstance(
            question_or_plan,
            dict,
        ):
            return question_or_plan

        raise ValueError(
            "validated_plan must be supplied when building an execution plan"
        )

    # ------------------------------------------------------------------
    # Compilation
    # ------------------------------------------------------------------

    def _compile_execution_plan(
        self,
        execution_plan: Dict[str, Any],
    ) -> QueryPlan:
        mode = str(
            execution_plan.get(
                "mode"
            )
            or "multi_step"
        ).strip().lower()

        if mode not in {
            "single",
            "multi_step",
        }:
            raise ValueError(
                f"invalid execution_plan mode: {mode!r}"
            )

        raw_steps = execution_plan.get(
            "steps"
        )

        if (
            not isinstance(
                raw_steps,
                list,
            )
            or not raw_steps
        ):
            raise ValueError(
                "execution_plan.steps must contain at least one step"
            )

        if len(raw_steps) > self.max_steps:
            raise ValueError(
                f"execution_plan exceeds maximum of "
                f"{self.max_steps} steps"
            )

        steps: List[QueryStep] = []

        for raw_step in raw_steps:
            steps.append(
                self._compile_step(
                    raw_step
                )
            )

        # Runtime bindings reference the producer's actual emitted row key.
        # Planner metadata may declare a qualified field such as table.id,
        # while psycopg2 exposes the SELECT alias as id. Normalize that
        # representation deterministically after all steps are known.
        self._normalize_runtime_binding_columns(steps)

        final_step = self._resolve_final_step(
            execution_plan=execution_plan,
            steps=steps,
        )

        reason = str(
            execution_plan.get(
                "reason"
            )
            or ""
        ).strip()

        return QueryPlan(
            mode=mode,
            steps=steps,
            final_step=final_step,
            reason=reason,
        )

    def _compile_step(
        self,
        raw_step: Any,
    ) -> QueryStep:
        if not isinstance(
            raw_step,
            dict,
        ):
            raise ValueError(
                "each execution_plan step must be an object"
            )

        step_id = str(
            raw_step.get(
                "id"
            )
            or ""
        ).strip()

        if not step_id:
            raise ValueError(
                "execution_plan step is missing id"
            )

        step_type = str(
            raw_step.get(
                "type"
            )
            or ""
        ).strip().lower()

        if step_type not in {
            "source_query",
            "set_operation",
            "final_query",
        }:
            raise ValueError(
                f"unsupported execution step type: "
                f"{step_type!r}"
            )

        source_id = raw_step.get(
            "source_id"
        )

        if source_id is not None:
            source_id = (
                str(source_id).strip()
                or None
            )

        contract = raw_step.get(
            "contract"
        )

        if contract is None:
            contract = {}

        if not isinstance(
            contract,
            dict,
        ):
            raise ValueError(
                f"step {step_id!r} contract must be an object"
            )

        depends_on = self._string_list(
            raw_step.get(
                "depends_on"
            ),
            field_name=f"{step_id}.depends_on",
        )

        inputs = self._string_list(
            raw_step.get(
                "inputs"
            ),
            field_name=f"{step_id}.inputs",
        )

        # For source_query/final_query steps, `inputs` are logical input
        # names, not execution-step references. Runtime data flow is carried
        # by `input_bindings` and `depends_on`. Keep logical inputs in the
        # canonical plan, but do not copy them into QueryStep.inputs because
        # QueryPlan validation treats that field as step references.
        if step_type in {
            "source_query",
            "final_query",
        }:
            inputs = []

        input_bindings = self._compile_bindings(
            raw_step.get(
                "input_bindings"
            ),
            step_id=step_id,
        )

        operator = raw_step.get(
            "operator"
        )

        if operator is not None:
            operator = (
                str(operator).strip().lower()
                or None
            )

        key_columns = self._string_list(
            raw_step.get(
                "key_columns"
            ),
            field_name=f"{step_id}.key_columns",
        )

        output_columns = self._string_list(
            raw_step.get(
                "output_columns"
            ),
            field_name=f"{step_id}.output_columns",
        )

        purpose = str(
            raw_step.get(
                "purpose"
            )
            or ""
        ).strip()

        return QueryStep(
            step_id=step_id,
            step_type=step_type,
            source_id=source_id,
            contract=contract,
            depends_on=depends_on,
            inputs=inputs,
            input_bindings=input_bindings,
            operator=operator,
            key_columns=key_columns,
            output_columns=output_columns,
            purpose=purpose,
        )

    @staticmethod
    def _normalize_runtime_binding_columns(
        steps: List[QueryStep],
    ) -> None:
        step_map = {step.step_id: step for step in steps}

        for consumer in steps:
            if not consumer.input_bindings:
                continue

            normalized: List[InputBinding] = []

            for binding in consumer.input_bindings:
                producer = step_map.get(binding.from_step)
                if producer is None:
                    normalized.append(binding)
                    continue

                declared = [
                    *producer.output_columns,
                    *producer.key_columns,
                ]
                producer_contract = producer.contract
                if isinstance(producer_contract, dict):
                    required = producer_contract.get("required_columns", [])
                    if isinstance(required, list):
                        declared.extend(
                            str(value).strip()
                            for value in required
                            if isinstance(value, str) and value.strip()
                        )

                match = next(
                    (
                        value
                        for value in declared
                        if str(value).strip().lower() == binding.from_column.lower()
                        or (
                            "." in str(value)
                            and str(value).rsplit(".", 1)[-1].lower()
                            == binding.from_column.lower()
                        )
                    ),
                    None,
                )

                if match and "." in str(match):
                    from_column = str(match).rsplit(".", 1)[-1]
                    normalized.append(
                        InputBinding(
                            from_step=binding.from_step,
                            from_column=from_column,
                            to_table=binding.to_table,
                            to_column=binding.to_column,
                            operator=binding.operator,
                        )
                    )
                else:
                    normalized.append(binding)

            consumer.input_bindings = normalized

    def _compile_bindings(
        self,
        raw_bindings: Any,
        *,
        step_id: str,
    ) -> List[InputBinding]:
        if raw_bindings is None:
            return []

        if not isinstance(
            raw_bindings,
            list,
        ):
            raise ValueError(
                f"{step_id}.input_bindings must be a list"
            )

        bindings: List[InputBinding] = []

        for index, raw_binding in enumerate(
            raw_bindings
        ):
            if not isinstance(
                raw_binding,
                dict,
            ):
                raise ValueError(
                    f"{step_id}.input_bindings[{index}] "
                    "must be an object"
                )

            from_step = str(
                raw_binding.get(
                    "from_step"
                )
                or ""
            ).strip()

            from_column = str(
                raw_binding.get(
                    "from_column"
                )
                or ""
            ).strip()

            to_table = str(
                raw_binding.get(
                    "to_table"
                )
                or ""
            ).strip()

            to_column = str(
                raw_binding.get(
                    "to_column"
                )
                or ""
            ).strip()

            operator = str(
                raw_binding.get(
                    "operator"
                )
                or "in"
            ).strip().lower()

            if not from_step:
                raise ValueError(
                    f"{step_id}.input_bindings[{index}] "
                    "is missing from_step"
                )

            if not from_column:
                raise ValueError(
                    f"{step_id}.input_bindings[{index}] "
                    "is missing from_column"
                )

            if not to_table:
                raise ValueError(
                    f"{step_id}.input_bindings[{index}] "
                    "is missing to_table"
                )

            if not to_column:
                raise ValueError(
                    f"{step_id}.input_bindings[{index}] "
                    "is missing to_column"
                )

            if operator not in {
                "in",
                "not_in",
                "equals",
            }:
                raise ValueError(
                    f"{step_id}.input_bindings[{index}] "
                    f"has unsupported operator {operator!r}"
                )

            bindings.append(
                InputBinding(
                    from_step=from_step,
                    from_column=from_column,
                    to_table=to_table,
                    to_column=to_column,
                    operator=operator,
                )
            )

        return bindings

    # ------------------------------------------------------------------
    # Validation helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _string_list(
        value: Any,
        *,
        field_name: str,
    ) -> List[str]:
        if value is None:
            return []

        if not isinstance(
            value,
            list,
        ):
            raise ValueError(
                f"{field_name} must be a list"
            )

        result: List[str] = []

        for item in value:
            text = str(
                item
            ).strip()

            if not text:
                raise ValueError(
                    f"{field_name} contains an empty value"
                )

            result.append(
                text
            )

        return result

    @staticmethod
    def _resolve_final_step(
        execution_plan: Dict[str, Any],
        steps: List[QueryStep],
    ) -> str:
        requested_final = str(
            execution_plan.get(
                "final_step"
            )
            or ""
        ).strip()

        step_ids: Set[str] = {
            step.step_id
            for step in steps
        }

        if requested_final:
            if requested_final not in step_ids:
                raise ValueError(
                    f"execution_plan.final_step "
                    f"{requested_final!r} does not reference "
                    "an existing step"
                )

            return requested_final

        # Deterministic fallback only.
        #
        # Prefer the explicit final_query step, otherwise use the
        # last declared step.
        final_candidates = [
            step.step_id
            for step in steps
            if step.step_type == "final_query"
        ]

        if len(final_candidates) == 1:
            return final_candidates[0]

        if len(final_candidates) > 1:
            raise ValueError(
                "execution_plan contains multiple final_query steps "
                "without an explicit final_step"
            )

        return steps[-1].step_id