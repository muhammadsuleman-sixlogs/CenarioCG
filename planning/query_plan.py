from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


ALLOWED_STEP_TYPES = {
    "source_query",
    "set_operation",
    "final_query",
}

ALLOWED_SET_OPERATIONS = {
    "intersect",
    "union",
    "union_all",
    "except",
    "distinct",
}

ALLOWED_BINDING_OPERATORS = {
    "in",
    "not_in",
    "equals",
}

BINDING_OPERATOR_ALIASES = {
    "eq": "equals",
    "=": "equals",
    "==": "equals",
}


@dataclass
class InputBinding:
    """
    Runtime dependency between two query steps.

    The binding describes:
        earlier_step.output_column
            ->
        current_step.to_table.to_column

    No runtime values are stored in the plan.

    At execution time:
        1. from_step is executed.
        2. from_column values are extracted.
        3. Values are deduplicated/batched.
        4. Values are bound to the target source query as parameters.

    This is the mechanism used for logical DB1 -> DB2 relationships.
    It must never become a cross-database SQL JOIN.
    """

    from_step: str
    from_column: str
    to_table: str
    to_column: str
    operator: str = "in"

    def __post_init__(self) -> None:
        self.from_step = self.from_step.strip()
        self.from_column = self.from_column.strip()
        self.to_table = self.to_table.strip()
        self.to_column = self.to_column.strip()
        self.operator = _normalize_binding_operator(self.operator)

        for name, value in (
            ("from_step", self.from_step),
            ("from_column", self.from_column),
            ("to_table", self.to_table),
            ("to_column", self.to_column),
        ):
            if not value:
                raise ValueError(
                    f"Input binding {name} must be a non-empty string."
                )

    def to_dict(self) -> dict[str, str]:
        return {
            "from_step": self.from_step,
            "from_column": self.from_column,
            "to_table": self.to_table,
            "to_column": self.to_column,
            "operator": self.operator,
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "InputBinding":
        if not isinstance(value, dict):
            raise ValueError("Input binding must be an object.")

        fields = {
            "from_step": value.get("from_step"),
            "from_column": value.get("from_column"),
            "to_table": value.get("to_table"),
            "to_column": value.get("to_column"),
        }

        for field_name, field_value in fields.items():
            if not isinstance(field_value, str) or not field_value.strip():
                raise ValueError(
                    f"Input binding {field_name} must be a non-empty string."
                )

        operator = value.get("operator", "in")
        if not isinstance(operator, str) or not operator.strip():
            raise ValueError(
                "Input binding operator must be a non-empty string."
            )

        return cls(
            from_step=fields["from_step"].strip(),
            from_column=fields["from_column"].strip(),
            to_table=fields["to_table"].strip(),
            to_column=fields["to_column"].strip(),
            operator=operator.strip().lower(),
        )


@dataclass
class QueryStep:
    """
    One node in the dependency-aware execution DAG.

    QueryStep contains semantic retrieval instructions rather than raw SQL.
    SQL generation happens later after validation and optimization.
    """

    step_id: str
    step_type: str
    source_id: str | None = None
    contract: dict[str, Any] = field(default_factory=dict)
    depends_on: list[str] = field(default_factory=list)
    inputs: list[str] = field(default_factory=list)
    input_bindings: list[InputBinding] = field(default_factory=list)
    operator: str | None = None
    key_columns: list[str] = field(default_factory=list)
    output_columns: list[str] = field(default_factory=list)
    purpose: str = ""

    def __post_init__(self) -> None:
        self.step_id = self.step_id.strip()

        if not self.step_id:
            raise ValueError("Query step id must be a non-empty string.")

        if self.step_type not in ALLOWED_STEP_TYPES:
            raise ValueError(
                f"Unsupported query step type: {self.step_type!r}"
            )

        if self.source_id is not None:
            self.source_id = self.source_id.strip().lower()
            if not self.source_id:
                raise ValueError("source_id must be a non-empty string.")

        if not isinstance(self.contract, dict):
            raise ValueError("Query step contract must be an object.")

        self.depends_on = _normalize_string_list(
            self.depends_on,
            "depends_on",
        )

        self.inputs = _normalize_string_list(
            self.inputs,
            "inputs",
        )

        self.key_columns = _normalize_string_list(
            self.key_columns,
            "key_columns",
        )

        self.output_columns = _normalize_string_list(
            self.output_columns,
            "output_columns",
        )

        normalized_bindings: list[InputBinding] = []

        for binding in self.input_bindings:
            if isinstance(binding, InputBinding):
                normalized_bindings.append(binding)
            elif isinstance(binding, dict):
                normalized_bindings.append(
                    InputBinding.from_dict(binding)
                )
            else:
                raise ValueError(
                    "Query step input_bindings must contain "
                    "InputBinding objects or objects."
                )

        self.input_bindings = normalized_bindings

        if self.operator is not None:
            if not isinstance(self.operator, str) or not self.operator.strip():
                raise ValueError(
                    "Query step operator must be a non-empty string."
                )
            self.operator = self.operator.strip().lower()

        self.purpose = str(self.purpose or "")

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.step_id,
            "type": self.step_type,
            "source_id": self.source_id,
            "contract": self.contract,
            "depends_on": list(self.depends_on),
            "inputs": list(self.inputs),
            "input_bindings": [
                binding.to_dict()
                for binding in self.input_bindings
            ],
            "operator": self.operator,
            "key_columns": list(self.key_columns),
            "output_columns": list(self.output_columns),
            "purpose": self.purpose,
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "QueryStep":
        if not isinstance(value, dict):
            raise ValueError("Query step must be an object.")

        step_id = value.get("id")
        step_type = value.get("type")

        if not isinstance(step_id, str) or not step_id.strip():
            raise ValueError(
                "Query step id must be a non-empty string."
            )

        if step_type not in ALLOWED_STEP_TYPES:
            raise ValueError(
                f"Unsupported query step type: {step_type!r}"
            )

        source_id = value.get("source_id")

        if source_id is not None:
            if not isinstance(source_id, str) or not source_id.strip():
                raise ValueError(
                    "source_id must be a non-empty string."
                )
            source_id = source_id.strip().lower()

        depends_on = value.get("depends_on", [])
        inputs = value.get("inputs", [])
        raw_bindings = value.get("input_bindings", [])
        key_columns = value.get("key_columns", [])
        output_columns = value.get("output_columns", [])

        for field_name, field_value in (
            ("depends_on", depends_on),
            ("inputs", inputs),
            ("key_columns", key_columns),
            ("output_columns", output_columns),
        ):
            if not isinstance(field_value, list) or not all(
                isinstance(item, str) and item.strip()
                for item in field_value
            ):
                raise ValueError(
                    f"Query step {field_name} must be a list of strings."
                )

        if not isinstance(raw_bindings, list):
            raise ValueError(
                "Query step input_bindings must be a list."
            )

        input_bindings = [
            InputBinding.from_dict(item)
            for item in raw_bindings
        ]

        operator = value.get("operator")

        if operator is not None:
            if not isinstance(operator, str) or not operator.strip():
                raise ValueError(
                    "Query step operator must be a non-empty string."
                )
            operator = operator.strip().lower()

        contract = value.get("contract", {})

        if not isinstance(contract, dict):
            raise ValueError(
                "Query step contract must be an object."
            )

        return cls(
            step_id=step_id.strip(),
            step_type=step_type,
            source_id=source_id,
            contract=contract,
            depends_on=[item.strip() for item in depends_on],
            inputs=[item.strip() for item in inputs],
            input_bindings=input_bindings,
            operator=operator,
            key_columns=[item.strip() for item in key_columns],
            output_columns=[item.strip() for item in output_columns],
            purpose=str(value.get("purpose") or ""),
        )


@dataclass
class QueryPlan:
    """
    Dependency-aware execution plan.

    The plan describes HOW execution must be coordinated after the
    semantic question has already been interpreted.

    Important source-separation rule:

        DB1 step
            ->
        runtime key binding
            ->
        DB2 step

    is valid.

    A direct SQL JOIN between DB1 and DB2 is not represented here.
    """

    mode: str
    steps: list[QueryStep]
    final_step: str
    reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "steps": [
                step.to_dict()
                for step in self.steps
            ],
            "final_step": self.final_step,
            "reason": self.reason,
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "QueryPlan":
        if not isinstance(value, dict):
            raise ValueError("Query plan must be an object.")

        mode = value.get("mode", "single")

        if mode not in {"single", "multi_step"}:
            raise ValueError(
                f"Unsupported query plan mode: {mode!r}"
            )

        raw_steps = value.get("steps", [])

        if not isinstance(raw_steps, list) or not raw_steps:
            raise ValueError(
                "Query plan must contain at least one step."
            )

        steps = [
            QueryStep.from_dict(item)
            for item in raw_steps
        ]

        final_step = value.get("final_step")

        if not isinstance(final_step, str) or not final_step.strip():
            raise ValueError(
                "Query plan final_step must be a non-empty string."
            )

        plan = cls(
            mode=mode,
            steps=steps,
            final_step=final_step.strip(),
            reason=str(value.get("reason") or ""),
        )

        validate_query_plan(plan)
        return plan

    @classmethod
    def from_legacy_plan(
        cls,
        plan: dict[str, Any],
        source_id: str,
    ) -> "QueryPlan":
        """
        Wrap the existing RetrievalContract-shaped plan as one step.

        This preserves compatibility while the system transitions to the
        dependency-aware execution model.
        """
        if not isinstance(plan, dict):
            raise ValueError(
                "Legacy retrieval plan must be an object."
            )

        if not isinstance(source_id, str) or not source_id.strip():
            raise ValueError(
                "source_id must be a non-empty string."
            )

        normalized_source = source_id.strip().lower()

        step = QueryStep(
            step_id="s1",
            step_type="final_query",
            source_id=normalized_source,
            contract=plan,
            output_columns=list(
                plan.get("required_columns", [])
            ),
            purpose="Execute the validated retrieval contract.",
        )

        result = cls(
            mode="single",
            steps=[step],
            final_step="s1",
            reason="Legacy single-source retrieval plan.",
        )

        validate_query_plan(result)
        return result


def validate_query_plan(plan: QueryPlan) -> None:
    """
    Validate execution-plan structure only.

    Database schema validation, relationship validation and business
    semantics belong to the deterministic planning/validation layer.
    """

    if not isinstance(plan, QueryPlan):
        raise ValueError(
            "plan must be a QueryPlan instance."
        )

    if plan.mode not in {"single", "multi_step"}:
        raise ValueError(
            f"Unsupported query plan mode: {plan.mode!r}"
        )

    if not plan.steps:
        raise ValueError(
            "Query plan must contain at least one step."
        )

    step_ids = [
        step.step_id
        for step in plan.steps
    ]

    if any(not step_id.strip() for step_id in step_ids):
        raise ValueError(
            "Query plan contains an empty step ID."
        )

    if len(step_ids) != len(set(step_ids)):
        raise ValueError(
            "Query plan contains duplicate step IDs."
        )

    step_map = {
        step.step_id: step
        for step in plan.steps
    }

    if plan.final_step not in step_map:
        raise ValueError(
            f"Final step {plan.final_step!r} does not exist."
        )

    for step in plan.steps:
        _validate_step_dependencies(step, step_map)
        _validate_step_bindings(step, step_map)
        _validate_step_type_constraints(step)

    _assert_acyclic(step_map)


def _validate_step_dependencies(
    step: QueryStep,
    step_map: dict[str, QueryStep],
) -> None:
    """Validate all dependency references."""

    if step.step_id in step.depends_on:
        raise ValueError(
            f"Step {step.step_id!r} cannot depend on itself."
        )

    if step.step_id in step.inputs:
        raise ValueError(
            f"Step {step.step_id!r} cannot reference itself as an input."
        )

    unknown_dependencies = (
        set(step.depends_on) - set(step_map)
    )

    if unknown_dependencies:
        raise ValueError(
            f"Step {step.step_id!r} references unknown "
            f"dependency(ies): {sorted(unknown_dependencies)}"
        )

    unknown_inputs = (
        set(step.inputs) - set(step_map)
    )

    if unknown_inputs:
        raise ValueError(
            f"Step {step.step_id!r} references unknown "
            f"input(s): {sorted(unknown_inputs)}"
        )


def _validate_step_bindings(
    step: QueryStep,
    step_map: dict[str, QueryStep],
) -> None:
    """
    Validate runtime binding topology.

    A binding is a real DAG edge and therefore its source step must also be
    declared in depends_on.
    """

    if step.step_type not in {
        "source_query",
        "final_query",
    }:
        if step.input_bindings:
            raise ValueError(
                f"Step {step.step_id!r} of type "
                f"{step.step_type!r} cannot contain input_bindings."
            )
        return

    for binding in step.input_bindings:
        if binding.from_step == step.step_id:
            raise ValueError(
                f"Step {step.step_id!r} cannot bind from itself."
            )

        if binding.from_step not in step_map:
            raise ValueError(
                f"Step {step.step_id!r} binding references unknown "
                f"from_step {binding.from_step!r}."
            )

        if binding.from_step not in step.depends_on:
            raise ValueError(
                f"Step {step.step_id!r} binding source "
                f"{binding.from_step!r} must also appear in depends_on."
            )

        source_step = step_map[binding.from_step]

        _validate_binding_output_reference(
            step=step,
            binding=binding,
            source_step=source_step,
        )


def _validate_binding_output_reference(
    step: QueryStep,
    binding: InputBinding,
    source_step: QueryStep,
) -> None:
    """
    Ensure the producing step declares the value required by the binding.

    If output_columns/key_columns are declared, the binding source column
    must be one of them. This prevents an execution-time request for a value
    that the producing step never promised to return.
    """

    declared_outputs = set(source_step.output_columns)
    declared_keys = set(source_step.key_columns)

    if not declared_outputs and not declared_keys:
        return

    if (
        binding.from_column not in declared_outputs
        and binding.from_column not in declared_keys
    ):
        raise ValueError(
            f"Step {step.step_id!r} binding expects column "
            f"{binding.from_column!r} from step "
            f"{source_step.step_id!r}, but that column is not declared "
            "in the source step output_columns or key_columns."
        )


def _validate_step_type_constraints(step: QueryStep) -> None:
    """Validate constraints that depend only on the step type."""

    if step.step_type in {
        "source_query",
        "final_query",
    }:
        if not step.source_id:
            raise ValueError(
                f"Source query step {step.step_id!r} requires source_id."
            )

    if step.step_type == "set_operation":
        if step.source_id is not None:
            raise ValueError(
                f"Set operation step {step.step_id!r} must not "
                "declare source_id."
            )

        if step.operator not in ALLOWED_SET_OPERATIONS:
            raise ValueError(
                f"Unsupported set operator on step "
                f"{step.step_id!r}: {step.operator!r}"
            )

        if step.operator in {
            "intersect",
            "union",
            "union_all",
            "except",
        }:
            if len(step.inputs) < 2:
                raise ValueError(
                    f"Set operation {step.step_id!r} requires "
                    "at least two inputs."
                )

        elif step.operator == "distinct":
            if len(step.inputs) != 1:
                raise ValueError(
                    f"Distinct operation {step.step_id!r} requires "
                    "exactly one input."
                )

        if step.depends_on:
            missing_inputs = (
                set(step.inputs) - set(step.depends_on)
            )

            if missing_inputs:
                raise ValueError(
                    f"Set operation step {step.step_id!r} has inputs "
                    f"not represented in depends_on: "
                    f"{sorted(missing_inputs)}"
                )


def _assert_acyclic(
    step_map: dict[str, QueryStep],
) -> None:
    """Reject dependency cycles before execution."""

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(step_id: str) -> None:
        if step_id in visiting:
            raise ValueError(
                "Query plan contains a dependency cycle."
            )

        if step_id in visited:
            return

        visiting.add(step_id)

        step = step_map[step_id]

        dependencies = [
            *step.depends_on,
            *step.inputs,
        ]

        for dependency in dependencies:
            visit(dependency)

        visiting.remove(step_id)
        visited.add(step_id)

    for step_id in step_map:
        visit(step_id)


def execution_order(
    plan: QueryPlan,
) -> list[QueryStep]:
    """
    Return a deterministic topological execution order.

    This remains sequential for compatibility.

    Use execution_layers() when the execution engine is ready to run
    independent branches concurrently.
    """

    validate_query_plan(plan)

    step_map = {
        step.step_id: step
        for step in plan.steps
    }

    pending = set(step_map)
    result: list[QueryStep] = []

    while pending:
        ready = [
            step_map[step_id]
            for step_id in sorted(pending)
            if all(
                dependency not in pending
                for dependency in _all_step_dependencies(
                    step_map[step_id]
                )
            )
        ]

        if not ready:
            raise ValueError(
                "Unable to resolve query-plan execution order."
            )

        for step in ready:
            result.append(step)
            pending.remove(step.step_id)

    return result


def execution_layers(
    plan: QueryPlan,
) -> list[list[QueryStep]]:
    """
    Group the DAG into deterministic parallel execution layers.

    Example:

        Layer 1:
            DB1 projects
            security overview

        Layer 2:
            DB1 aggregate

        Layer 3:
            DB2 meetings bound by DB1 keys

        Layer 4:
            final aggregation

    Steps within one layer have no unresolved dependencies on another
    step in the same layer and can therefore be scheduled concurrently
    by the executor, subject to its MAX_PARALLEL_BRANCHES limit.
    """

    validate_query_plan(plan)

    step_map = {
        step.step_id: step
        for step in plan.steps
    }

    remaining = set(step_map)
    completed: set[str] = set()
    layers: list[list[QueryStep]] = []

    while remaining:
        ready = [
            step_map[step_id]
            for step_id in sorted(remaining)
            if all(
                dependency in completed
                for dependency in _all_step_dependencies(
                    step_map[step_id]
                )
            )
        ]

        if not ready:
            raise ValueError(
                "Unable to resolve query-plan execution layers."
            )

        layers.append(ready)

        completed.update(
            step.step_id
            for step in ready
        )

        remaining.difference_update(
            step.step_id
            for step in ready
        )

    return layers


def binding_dependencies(
    plan: QueryPlan,
) -> list[tuple[str, str]]:
    """
    Return runtime binding edges as (from_step, to_step).

    Useful to execution and tracing layers when building the actual
    dependency graph.
    """

    validate_query_plan(plan)

    result: list[tuple[str, str]] = []

    for step in plan.steps:
        for binding in step.input_bindings:
            result.append(
                (
                    binding.from_step,
                    step.step_id,
                )
            )

    return result


def get_step(
    plan: QueryPlan,
    step_id: str,
) -> QueryStep:
    """Return one step by ID with deterministic validation."""

    validate_query_plan(plan)

    if not isinstance(step_id, str) or not step_id.strip():
        raise ValueError(
            "step_id must be a non-empty string."
        )

    for step in plan.steps:
        if step.step_id == step_id.strip():
            return step

    raise ValueError(
        f"Query plan step {step_id!r} does not exist."
    )


def _all_step_dependencies(
    step: QueryStep,
) -> list[str]:
    """Return all dependency edges without duplicates."""

    return list(
        dict.fromkeys(
            [
                *step.depends_on,
                *step.inputs,
            ]
        )
    )


def _normalize_binding_operator(
    operator: str,
) -> str:
    if not isinstance(operator, str):
        raise ValueError(
            "Input binding operator must be a string."
        )

    normalized = operator.strip().lower()

    normalized = BINDING_OPERATOR_ALIASES.get(
        normalized,
        normalized,
    )

    if normalized not in ALLOWED_BINDING_OPERATORS:
        raise ValueError(
            f"Unsupported input binding operator: {operator!r}"
        )

    return normalized


def _normalize_string_list(
    values: list[str],
    field_name: str,
) -> list[str]:
    if not isinstance(values, list):
        raise ValueError(
            f"Query step {field_name} must be a list of strings."
        )

    normalized: list[str] = []

    for value in values:
        if not isinstance(value, str) or not value.strip():
            raise ValueError(
                f"Query step {field_name} must contain "
                "non-empty strings."
            )

        normalized.append(value.strip())

    return list(dict.fromkeys(normalized))