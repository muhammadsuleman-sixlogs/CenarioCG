from __future__ import annotations

from copy import deepcopy
from typing import Any

from context.context_store import load_all_contexts

class QuestionPlanValidator:
    """
    Deterministically validate and canonicalize a QuestionPlanner plan
    against the dynamically discovered Context Layer.

    Responsibilities:
      - validate semantic-plan structure
      - validate source selection
      - validate source-local tables, columns, relationships
      - validate filters/grouping/sorting
      - validate entities and security resources
      - validate the nested execution_plan structure
      - normalize equivalent representations before validation

    This class does not call an LLM.
    This class does not access PostgreSQL.
    This class never modifies database schema/data.
    """

    ALLOWED_DATA_SOURCES = {
        "postgresql",
        "security_logs",
    }

    ALLOWED_OPERATIONS = {
        "lookup",
        "filter",
        "count",
        "sum",
        "average",
        "minimum",
        "maximum",
        "comparison",
        "ranking",
        "grouping",
        "aggregation",
        "general",
    }

    ALLOWED_FILTER_OPERATORS = {
        "=",
        "!=",
        "<>",
        ">",
        ">=",
        "<",
        "<=",
        "in",
        "not_in",
        "contains",
        "starts_with",
        "ends_with",
        "is_null",
        "is_not_null",
    }

    ALLOWED_SORT_DIRECTIONS = {
        "asc",
        "desc",
    }

    ALLOWED_SECURITY_RESOURCES = {
        "security_logs",
        "cli_audit_logs",
        "security_logs_summary",
        "workspace_security_logs",
        "workspace_siem_status",
        "security_overview",
    }

    ALLOWED_EXECUTION_STEP_TYPES = {
        "source_query",
        "final_query",
        "set_operation",
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

    MAX_EXECUTION_STEPS = 16
    MAX_DEPENDENCY_DEPTH = 16
    MAX_RUNTIME_BINDINGS = 64

    def __init__(
        self,
        context: dict[str, Any] | None = None,
    ) -> None:
        if context is not None:
            if "tables" in context:
                source_id = str(
                    context.get("source_id", "db1")
                ).strip().lower() or "db1"
                self.contexts = {
                    source_id: context,
                }
            else:
                self.contexts = context
        else:
            self.contexts = load_all_contexts()

        if not isinstance(self.contexts, dict):
            raise ValueError(
                "Context Layer sources must be a dictionary."
            )

        if not self.contexts:
            raise ValueError(
                "No PostgreSQL Context Layer sources are available."
            )

    # ------------------------------------------------------------------
    # Context helpers
    # ------------------------------------------------------------------

    def _available_postgresql_sources(self) -> list[str]:
        return [
            str(source_id).strip().lower()
            for source_id in self.contexts.keys()
        ]

    def _get_source_context(
        self,
        source_id: str,
    ) -> dict[str, Any]:
        context = self.contexts.get(source_id, {})
        return context if isinstance(context, dict) else {}

    @staticmethod
    def _find_key_ci(
        mapping: dict[str, Any],
        requested: str,
    ) -> str | None:
        target = str(requested).strip().lower()
        for key in mapping.keys():
            if str(key).strip().lower() == target:
                return str(key)
        return None

    def _known_tables(
        self,
        source_ids: list[str] | None = None,
    ) -> set[str]:
        source_ids = source_ids or self._available_postgresql_sources()
        result: set[str] = set()

        for source_id in source_ids:
            tables = self._get_source_context(source_id).get(
                "tables", {}
            )
            if isinstance(tables, dict):
                result.update(str(name) for name in tables.keys())

        return result

    def _known_columns(
        self,
        source_ids: list[str] | None = None,
    ) -> dict[str, set[str]]:
        source_ids = source_ids or self._available_postgresql_sources()
        result: dict[str, set[str]] = {}

        for source_id in source_ids:
            tables = self._get_source_context(source_id).get(
                "tables", {}
            )
            if not isinstance(tables, dict):
                continue

            for table_name, table_info in tables.items():
                if not isinstance(table_info, dict):
                    continue

                table_name = str(table_name)
                result.setdefault(table_name, set())

                columns = table_info.get("columns", [])

                if isinstance(columns, dict):
                    result[table_name].update(
                        str(name) for name in columns.keys()
                    )
                    continue

                if not isinstance(columns, list):
                    continue

                for column in columns:
                    if isinstance(column, str):
                        result[table_name].add(column)
                    elif isinstance(column, dict):
                        name = (
                            column.get("name")
                            or column.get("column")
                            or column.get("column_name")
                        )
                        if name:
                            result[table_name].add(str(name))

        return result

    def _known_relationships(
        self,
        source_ids: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        source_ids = source_ids or self._available_postgresql_sources()
        result: list[dict[str, Any]] = []

        for source_id in source_ids:
            context = self._get_source_context(source_id)

            for field_name in (
                "relationships",
                "business_relationships",
            ):
                relationships = context.get(field_name, [])
                if not isinstance(relationships, list):
                    continue

                for relationship in relationships:
                    if not isinstance(relationship, dict):
                        continue

                    item = dict(relationship)
                    item.setdefault("source_id", source_id)
                    result.append(item)

        return result

    # ------------------------------------------------------------------
    # Canonical normalization
    # ------------------------------------------------------------------

    @staticmethod
    def _canonical_required_column(value: Any) -> Any:
        """
        Normalize supported required-column representations.

        Supported:
            "table.column"
            {"table": "table", "column": "column"}
            {"table_name": "table", "column_name": "column"}
        """

        if isinstance(value, str):
            return value.strip()

        if not isinstance(value, dict):
            return value

        table = str(
            value.get("table")
            or value.get("table_name")
            or ""
        ).strip()

        column = str(
            value.get("column")
            or value.get("column_name")
            or ""
        ).strip()

        if table and column:
            return f"{table}.{column}"

        return value

    def _canonicalize_plan(
        self,
        plan: dict[str, Any],
    ) -> dict[str, Any]:
        """
        Canonicalize planner representations before validation.

        Field references are resolved only against the PostgreSQL source IDs
        selected by the plan and, when available, the plan's required tables.
        Ambiguous bare fields are intentionally left unchanged so validation
        rejects them instead of guessing.
        """

        normalized = deepcopy(plan)

        normalized["data_sources"] = self._canonical_string_list(
            normalized.get("data_sources", ["postgresql"])
        )
        normalized["postgresql_sources"] = self._canonical_string_list(
            normalized.get("postgresql_sources", [])
        )
        normalized["required_tables"] = self._canonical_string_list(
            normalized.get("required_tables", [])
        )
        normalized["required_columns"] = self._canonical_columns(
            normalized.get("required_columns", []),
            source_ids=normalized["postgresql_sources"],
            candidate_tables=normalized["required_tables"],
        )
        normalized["relationships"] = self._canonical_list(
            normalized.get("relationships", [])
        )
        normalized["filters"] = self._canonical_filters(
            normalized.get("filters", []),
            source_ids=normalized["postgresql_sources"],
            candidate_tables=normalized["required_tables"],
        )
        normalized["operations"] = self._canonical_string_list(
            normalized.get("operations", [])
        )
        normalized["grouping"] = self._canonical_grouping(
            normalized.get("grouping", []),
            source_ids=normalized["postgresql_sources"],
            candidate_tables=normalized["required_tables"],
        )
        normalized["sorting"] = self._canonical_sorting(
            normalized.get("sorting", []),
            source_ids=normalized["postgresql_sources"],
            candidate_tables=normalized["required_tables"],
        )
        normalized["entities"] = self._canonical_list(
            normalized.get("entities", [])
        )

        execution_plan = normalized.get("execution_plan")
        if isinstance(execution_plan, dict):
            normalized["execution_plan"] = self._canonicalize_execution_plan(
                execution_plan
            )

        return normalized

    def _canonicalize_execution_plan(
        self,
        execution_plan: dict[str, Any],
    ) -> dict[str, Any]:
        """Canonicalize execution steps without erasing nested contracts.

        `contract` is the authoritative retrieval specification for a step.
        Direct step-level retrieval fields are supported for compatibility,
        but they are merged only when they were actually present in the raw
        planner output. Generated empty defaults must never overwrite a
        populated nested contract.
        """
        normalized = deepcopy(execution_plan)

        raw_steps = normalized.get("steps", [])
        if not isinstance(raw_steps, list):
            return normalized

        canonical_steps: list[Any] = []

        retrieval_fields = (
            "question",
            "data_sources",
            "postgresql_sources",
            "required_tables",
            "required_columns",
            "relationships",
            "filters",
            "operations",
            "grouping",
            "sorting",
            "limit",
            "entities",
            "needs_conversation_context",
        )

        for raw_step in raw_steps:
            if not isinstance(raw_step, dict):
                canonical_steps.append(raw_step)
                continue

            original_step = deepcopy(raw_step)
            step = deepcopy(raw_step)

            step["depends_on"] = self._canonical_string_list(
                original_step.get("depends_on", [])
            )
            step["inputs"] = self._canonical_string_list(
                original_step.get("inputs", [])
            )
            step["key_columns"] = self._canonical_string_list(
                original_step.get("key_columns", [])
            )
            step["output_columns"] = self._canonical_string_list(
                original_step.get("output_columns", [])
            )

            step_source_id = original_step.get("source_id")
            if isinstance(step_source_id, str) and step_source_id.strip():
                step_source_ids = [step_source_id.strip().lower()]
            else:
                step_source_ids = self._canonical_string_list(
                    original_step.get("postgresql_sources", [])
                )

            # Start from the nested contract if it exists. This is critical
            # for multi-source plans because the top-level step may only
            # contain execution metadata while the contract contains the
            # source-local tables/columns.
            raw_contract = original_step.get("contract")
            contract = (
                deepcopy(raw_contract)
                if isinstance(raw_contract, dict)
                else {}
            )

            # Merge direct step fields only as FALLBACKS.
            #
            # The nested contract is authoritative. Planner output often has
            # execution metadata at step level plus a complete source-local
            # contract. In that representation, step-level fields may be
            # empty defaults. Those empty defaults must NEVER erase populated
            # values inside contract.
            for field_name in retrieval_fields:
                if field_name not in original_step:
                    continue

                direct_value = original_step[field_name]
                existing_value = contract.get(field_name)

                # A populated nested list always wins.
                if isinstance(existing_value, list) and existing_value:
                    continue

                # If both representations are empty, keep the nested value.
                if isinstance(existing_value, list) and not existing_value:
                    if isinstance(direct_value, list) and not direct_value:
                        continue

                value = direct_value

                if field_name == "postgresql_sources":
                    value = self._canonical_string_list(value)
                    if value:
                        step_source_ids = value

                elif field_name == "required_tables":
                    value = self._canonical_string_list(value)

                elif field_name == "required_columns":
                    candidate_tables = self._canonical_string_list(
                        contract.get("required_tables", [])
                        or original_step.get("required_tables", [])
                    )
                    value = self._canonical_columns(
                        value,
                        source_ids=step_source_ids,
                        candidate_tables=candidate_tables,
                    )

                elif field_name == "relationships":
                    value = self._canonical_list(value)

                elif field_name == "filters":
                    candidate_tables = self._canonical_string_list(
                        contract.get("required_tables", [])
                        or original_step.get("required_tables", [])
                    )
                    value = self._canonical_filters(
                        value,
                        source_ids=step_source_ids,
                        candidate_tables=candidate_tables,
                    )

                elif field_name == "operations":
                    value = self._canonical_string_list(value)

                elif field_name == "grouping":
                    candidate_tables = self._canonical_string_list(
                        contract.get("required_tables", [])
                        or original_step.get("required_tables", [])
                    )
                    value = self._canonical_grouping(
                        value,
                        source_ids=step_source_ids,
                        candidate_tables=candidate_tables,
                    )

                elif field_name == "sorting":
                    candidate_tables = self._canonical_string_list(
                        contract.get("required_tables", [])
                        or original_step.get("required_tables", [])
                    )
                    value = self._canonical_sorting(
                        value,
                        source_ids=step_source_ids,
                        candidate_tables=candidate_tables,
                    )

                contract[field_name] = value

            # Canonicalize whatever remains in the nested contract. The
            # nested contract wins when no explicit direct override exists.
            contract_source_ids = self._canonical_string_list(
                contract.get("postgresql_sources", step_source_ids)
            )
            contract_tables = self._canonical_string_list(
                contract.get("required_tables", [])
            )

            contract["data_sources"] = self._canonical_string_list(
                contract.get("data_sources", ["postgresql"])
            )
            contract["postgresql_sources"] = contract_source_ids
            contract["required_tables"] = contract_tables
            contract["required_columns"] = self._canonical_columns(
                contract.get("required_columns", []),
                source_ids=contract_source_ids,
                candidate_tables=contract_tables,
            )
            contract["relationships"] = self._canonical_list(
                contract.get("relationships", [])
            )
            contract["filters"] = self._canonical_filters(
                contract.get("filters", []),
                source_ids=contract_source_ids,
                candidate_tables=contract_tables,
            )
            contract["operations"] = self._canonical_string_list(
                contract.get("operations", [])
            )
            contract["grouping"] = self._canonical_grouping(
                contract.get("grouping", []),
                source_ids=contract_source_ids,
                candidate_tables=contract_tables,
            )
            contract["sorting"] = self._canonical_sorting(
                contract.get("sorting", []),
                source_ids=contract_source_ids,
                candidate_tables=contract_tables,
            )
            contract["entities"] = self._canonical_list(
                contract.get("entities", [])
            )

            # The nested contract is the canonical source of retrieval
            # semantics. Mirror it back to step-level fields so downstream
            # validation and execution see one consistent representation.
            for field_name in retrieval_fields:
                if field_name in contract:
                    step[field_name] = deepcopy(contract[field_name])

            step["contract"] = contract
            canonical_steps.append(step)

        normalized["steps"] = canonical_steps
        return normalized

    @staticmethod
    def _canonical_list(value: Any) -> list[Any]:
        if value is None:
            return []
        return list(value) if isinstance(value, list) else [value]

    @staticmethod
    def _canonical_string_list(value: Any) -> list[str]:
        if value is None:
            return []
        if not isinstance(value, list):
            value = [value]
        return [
            str(item).strip()
            for item in value
            if isinstance(item, (str, int, float))
            and str(item).strip()
        ]

    def _resolve_bare_column(
        self,
        column_name: str,
        source_ids: list[str] | None = None,
        candidate_tables: list[str] | None = None,
    ) -> str | None:
        """
        Resolve one bare column name only when its discovered location is
        unique within the selected PostgreSQL source/table scope.

        No semantic inference is performed. Ambiguity returns None.
        """

        if not isinstance(column_name, str) or not column_name.strip():
            return None

        target = column_name.strip().lower()

        normalized_sources = [
            str(source_id).strip().lower()
            for source_id in (source_ids or [])
            if isinstance(source_id, str) and source_id.strip()
        ]

        if not normalized_sources:
            normalized_sources = self._available_postgresql_sources()

        normalized_tables = {
            str(table).strip().lower()
            for table in (candidate_tables or [])
            if isinstance(table, str) and table.strip()
        }

        matches: list[tuple[str, str, str]] = []

        for source_id in normalized_sources:
            context = self._get_source_context(source_id)
            tables = context.get("tables", {})

            if not isinstance(tables, dict):
                continue

            for table_name, table_info in tables.items():
                actual_table = str(table_name)

                if (
                    normalized_tables
                    and actual_table.lower() not in normalized_tables
                ):
                    continue

                if not isinstance(table_info, dict):
                    continue

                columns = table_info.get("columns", [])

                if isinstance(columns, dict):
                    column_names = [
                        str(name)
                        for name in columns.keys()
                    ]
                elif isinstance(columns, list):
                    column_names = []
                    for column in columns:
                        if isinstance(column, str):
                            column_names.append(column)
                        elif isinstance(column, dict):
                            name = (
                                column.get("name")
                                or column.get("column")
                                or column.get("column_name")
                            )
                            if name:
                                column_names.append(str(name))
                else:
                    column_names = []

                for actual_column in column_names:
                    if actual_column.strip().lower() == target:
                        matches.append(
                            (
                                source_id,
                                actual_table,
                                actual_column,
                            )
                        )

        unique_matches = list(dict.fromkeys(matches))

        if len(unique_matches) != 1:
            return None

        _, table_name, column_name = unique_matches[0]
        return f"{table_name}.{column_name}"

    def _canonical_field_reference(
        self,
        value: Any,
        source_ids: list[str] | None = None,
        candidate_tables: list[str] | None = None,
    ) -> Any:
        """Normalize one field reference without guessing ambiguous fields."""

        if isinstance(value, str):
            value = value.strip()

            if not value:
                return value

            if value.count(".") == 1:
                return value

            resolved = self._resolve_bare_column(
                value,
                source_ids=source_ids,
                candidate_tables=candidate_tables,
            )

            return resolved if resolved is not None else value

        if isinstance(value, dict):
            field = value.get("field")

            if isinstance(field, (str, dict)):
                normalized_field = self._canonical_field_reference(
                    field,
                    source_ids=source_ids,
                    candidate_tables=candidate_tables,
                )
                if isinstance(normalized_field, str):
                    return normalized_field

            table = (
                value.get("table")
                or value.get("table_name")
            )
            column = (
                value.get("column")
                or value.get("column_name")
            )

            if table and column:
                return (
                    f"{str(table).strip()}."
                    f"{str(column).strip()}"
                )

            if column:
                resolved = self._resolve_bare_column(
                    str(column),
                    source_ids=source_ids,
                    candidate_tables=candidate_tables,
                )
                return resolved if resolved is not None else value

        return value

    def _canonical_columns(
        self,
        value: Any,
        source_ids: list[str] | None = None,
        candidate_tables: list[str] | None = None,
    ) -> list[Any]:
        if value is None:
            return []
        if not isinstance(value, list):
            value = [value]

        return [
            self._canonical_field_reference(
                item,
                source_ids=source_ids,
                candidate_tables=candidate_tables,
            )
            for item in value
        ]

    def _canonical_filters(
        self,
        value: Any,
        source_ids: list[str] | None = None,
        candidate_tables: list[str] | None = None,
    ) -> list[Any]:
        if value is None:
            return []
        if not isinstance(value, list):
            value = [value]

        result: list[Any] = []

        for item in value:
            if not isinstance(item, dict):
                result.append(item)
                continue

            current = deepcopy(item)

            if "field" in current:
                current["field"] = self._canonical_field_reference(
                    current.get("field"),
                    source_ids=source_ids,
                    candidate_tables=candidate_tables,
                )
            elif "column" in current:
                current["column"] = self._canonical_field_reference(
                    current.get("column"),
                    source_ids=source_ids,
                    candidate_tables=candidate_tables,
                )
            elif "column_name" in current:
                current["column_name"] = self._canonical_field_reference(
                    current.get("column_name"),
                    source_ids=source_ids,
                    candidate_tables=candidate_tables,
                )

            result.append(current)

        return result

    def _canonical_grouping(
        self,
        value: Any,
        source_ids: list[str] | None = None,
        candidate_tables: list[str] | None = None,
    ) -> list[Any]:
        if value is None:
            return []
        if not isinstance(value, list):
            value = [value]

        return [
            self._canonical_field_reference(
                item,
                source_ids=source_ids,
                candidate_tables=candidate_tables,
            )
            for item in value
        ]

    def _canonical_sorting(
        self,
        value: Any,
        source_ids: list[str] | None = None,
        candidate_tables: list[str] | None = None,
    ) -> list[Any]:
        if value is None:
            return []
        if isinstance(value, dict):
            value = [value]
        if not isinstance(value, list):
            return []

        result: list[Any] = []

        for item in value:
            if not isinstance(item, dict):
                result.append(item)
                continue

            current = deepcopy(item)

            if "field" in current:
                current["field"] = self._canonical_field_reference(
                    current.get("field"),
                    source_ids=source_ids,
                    candidate_tables=candidate_tables,
                )

            direction = current.get("direction")
            if isinstance(direction, str):
                current["direction"] = direction.strip().lower()

            result.append(current)

        return result

    # ------------------------------------------------------------------
    # Basic validation
    # ------------------------------------------------------------------

    def _validate_question(self, question: Any) -> list[str]:
        if not isinstance(question, str):
            return ["question must be a string."]
        if not question.strip():
            return ["question cannot be empty."]
        return []

    def _validate_data_sources(self, data_sources: Any) -> list[str]:
        if not isinstance(data_sources, list):
            return ["data_sources must be a list."]
        if not data_sources:
            return ["data_sources must contain at least one source."]

        errors: list[str] = []
        seen: set[str] = set()

        for source in data_sources:
            if not isinstance(source, str):
                errors.append(f"Invalid data source: {source!r}")
                continue

            source = source.strip().lower()
            if source not in self.ALLOWED_DATA_SOURCES:
                errors.append(f"Unsupported data source: {source}")
            if source in seen:
                errors.append(f"Duplicate data source: {source}")
            seen.add(source)

        return errors

    def _validate_postgresql_sources(
        self,
        postgresql_sources: Any,
        data_sources: list[str],
    ) -> list[str]:
        errors: list[str] = []

        if not isinstance(postgresql_sources, list):
            return ["postgresql_sources must be a list."]

        seen: set[str] = set()
        for source_id in postgresql_sources:
            if not isinstance(source_id, str):
                errors.append(
                    "PostgreSQL source ID must be a string: "
                    f"{source_id!r}"
                )
                continue

            source_id = source_id.strip().lower()
            if source_id not in self.contexts:
                errors.append(
                    f"Unknown PostgreSQL source: {source_id}"
                )
            if source_id in seen:
                errors.append(
                    f"Duplicate PostgreSQL source: {source_id}"
                )
            seen.add(source_id)

        if "postgresql" in data_sources and not postgresql_sources:
            errors.append(
                "postgresql_sources must contain at least one source "
                "when postgresql is selected."
            )

        if "postgresql" not in data_sources and postgresql_sources:
            errors.append(
                "postgresql_sources must be empty when postgresql is "
                "not selected."
            )

        return errors

    def _validate_entities(self, entities: Any) -> list[str]:
        if not isinstance(entities, list):
            return ["entities must be a list."]

        errors: list[str] = []
        available_sources = set(self._available_postgresql_sources())

        for entity in entities:
            if not isinstance(entity, dict):
                errors.append(f"Invalid entity format: {entity!r}")
                continue

            entity_type = entity.get("type")
            entity_id = entity.get("id")

            if not isinstance(entity_type, str) or not entity_type.strip():
                errors.append(
                    f"Entity type must be a non-empty string: {entity!r}"
                )

            if not isinstance(entity_id, str) or not entity_id.strip():
                errors.append(
                    f"Entity id must be a non-empty string: {entity!r}"
                )

            source_id = entity.get("source_id")
            if source_id is not None:
                if not isinstance(source_id, str):
                    errors.append(
                        f"Entity source_id must be a string: {entity!r}"
                    )
                elif source_id.strip().lower() not in available_sources:
                    errors.append(
                        f"Unknown entity PostgreSQL source: {source_id}"
                    )

        return errors

    def _validate_limit(self, limit: Any) -> list[str]:
        if limit is None:
            return []
        if isinstance(limit, bool) or not isinstance(limit, int):
            return ["limit must be a positive integer or null."]
        if limit <= 0:
            return ["limit must be greater than 0."]
        return []

    def _validate_confidence(self, confidence: Any) -> list[str]:
        if confidence is None:
            return []
        if isinstance(confidence, bool) or not isinstance(
            confidence, (int, float)
        ):
            return ["confidence must be a number between 0 and 1."]
        if not 0 <= confidence <= 1:
            return ["confidence must be between 0 and 1."]
        return []

    def _validate_operations(self, operations: Any) -> list[str]:
        if not isinstance(operations, list):
            return ["operations must be a list."]

        errors: list[str] = []
        for operation in operations:
            if not isinstance(operation, str):
                errors.append(f"Invalid operation: {operation!r}")
                continue

            operation_text = operation.strip()
            if not operation_text:
                errors.append("Operation cannot be empty.")
                continue

            operation_name = (
                operation_text
                .split("(", 1)[0]
                .strip()
                .lower()
            )

            if operation_name not in self.ALLOWED_OPERATIONS:
                errors.append(
                    f"Unsupported operation: {operation}"
                )

        return errors

    def _validate_security_resource(
        self,
        plan: dict[str, Any],
        data_sources: list[str],
    ) -> list[str]:
        resource = plan.get("security_resource")

        if "security_logs" not in data_sources:
            if resource not in (None, ""):
                return [
                    "security_resource must be null when security_logs "
                    "is not selected."
                ]
            return []

        if not isinstance(resource, str) or not resource.strip():
            return [
                "security_resource must be a non-empty string when "
                "security_logs is selected."
            ]

        if resource.strip() not in self.ALLOWED_SECURITY_RESOURCES:
            return [
                f"Unsupported security resource: {resource}"
            ]

        return []

    # ------------------------------------------------------------------
    # Schema validation
    # ------------------------------------------------------------------

    def _validate_tables(
        self,
        required_tables: list[Any],
        source_ids: list[str],
        prefix: str = "required_tables",
    ) -> list[str]:
        errors: list[str] = []
        known_tables = self._known_tables(source_ids)
        known_lower = {table.lower(): table for table in known_tables}

        for index, table in enumerate(required_tables):
            if not isinstance(table, str) or not table.strip():
                errors.append(
                    f"{prefix}[{index}] must be a non-empty table name."
                )
                continue

            if table.strip().lower() not in known_lower:
                errors.append(
                    f"{prefix}[{index}] references unknown table: {table}"
                )

        return errors

    def _validate_columns(
        self,
        required_columns: list[Any],
        source_ids: list[str],
        prefix: str = "required_columns",
    ) -> list[str]:
        errors: list[str] = []
        known_columns = self._known_columns(source_ids)
        table_lookup = {
            table.lower(): table
            for table in known_columns
        }

        for index, reference in enumerate(required_columns):
            if not isinstance(reference, str):
                errors.append(
                    f"{prefix}[{index}] must use table.column format."
                )
                continue

            reference = reference.strip()
            if reference.count(".") != 1:
                errors.append(
                    f"{prefix}[{index}] must use table.column format."
                )
                continue

            table_name, column_name = [
                part.strip()
                for part in reference.split(".", 1)
            ]

            if not table_name or not column_name:
                errors.append(
                    f"{prefix}[{index}] must use table.column format."
                )
                continue

            canonical_table = table_lookup.get(table_name.lower())
            if canonical_table is None:
                errors.append(
                    f"{prefix}[{index}] references unknown table: "
                    f"{table_name}"
                )
                continue

            columns = known_columns.get(canonical_table, set())
            if not any(
                column.lower() == column_name.lower()
                for column in columns
            ):
                errors.append(
                    f"{prefix}[{index}] references unknown column: "
                    f"{reference}"
                )

        return errors

    def _validate_relationships(
        self,
        requested_relationships: list[Any],
        source_ids: list[str],
        prefix: str = "relationships",
    ) -> list[str]:
        errors: list[str] = []
        known = self._known_relationships(source_ids)

        def endpoints(item: dict[str, Any]) -> tuple[str, str, str, str] | None:
            source_table = str(
                item.get("source_table")
                or item.get("from_table")
                or ""
            ).strip()
            source_column = str(
                item.get("source_column")
                or item.get("from_column")
                or ""
            ).strip()
            target_table = str(
                item.get("target_table")
                or item.get("to_table")
                or ""
            ).strip()
            target_column = str(
                item.get("target_column")
                or item.get("to_column")
                or ""
            ).strip()

            if not all((
                source_table,
                source_column,
                target_table,
                target_column,
            )):
                return None

            return (
                source_table,
                source_column,
                target_table,
                target_column,
            )

        def matches(
            left: tuple[str, str, str, str],
            right: tuple[str, str, str, str],
        ) -> bool:
            return (
                left[0].lower() == right[0].lower()
                and left[1].lower() == right[1].lower()
                and left[2].lower() == right[2].lower()
                and left[3].lower() == right[3].lower()
            ) or (
                left[0].lower() == right[2].lower()
                and left[1].lower() == right[3].lower()
                and left[2].lower() == right[0].lower()
                and left[3].lower() == right[1].lower()
            )

        for index, requested in enumerate(requested_relationships):
            if not isinstance(requested, dict):
                errors.append(
                    f"{prefix}[{index}] has invalid relationship format."
                )
                continue

            desired = endpoints(requested)
            if desired is None:
                errors.append(
                    f"{prefix}[{index}] must contain source/target table "
                    "and column information."
                )
                continue

            found = False
            for known_relationship in known:
                actual = endpoints(known_relationship)
                if actual is not None and matches(desired, actual):
                    found = True
                    break

            if not found:
                errors.append(
                    f"{prefix}[{index}] references an undiscovered "
                    "relationship: "
                    f"{desired[0]}.{desired[1]} -> "
                    f"{desired[2]}.{desired[3]}"
                )

        return errors

    def _validate_table_column_consistency(
        self,
        required_tables: list[Any],
        required_columns: list[Any],
        prefix: str = "required_columns",
    ) -> list[str]:
        errors: list[str] = []
        selected_tables = {
            table.lower()
            for table in required_tables
            if isinstance(table, str)
        }

        if not selected_tables:
            return errors

        for index, reference in enumerate(required_columns):
            if not isinstance(reference, str) or "." not in reference:
                continue

            table_name = reference.split(".", 1)[0].strip().lower()
            if table_name not in selected_tables:
                errors.append(
                    f"{prefix}[{index}] references table "
                    f"{reference.split('.', 1)[0]} that is not included "
                    "in required_tables."
                )

        return errors

    # ------------------------------------------------------------------
    # Filters / grouping / sorting
    # ------------------------------------------------------------------

    def _validate_field_reference(
        self,
        reference: Any,
        source_ids: list[str],
        field_label: str,
    ) -> list[str]:
        if isinstance(reference, dict):
            reference = self._canonical_required_column(reference)

        if not isinstance(reference, str):
            return [
                f"{field_label} must use table.column format."
            ]

        reference = reference.strip()
        if reference.count(".") != 1:
            return [
                f"{field_label} must use table.column format."
            ]

        return self._validate_columns(
            [reference],
            source_ids,
            prefix=field_label,
        )

    @staticmethod
    def _filter_runtime_bound(
        item: dict[str, Any],
        runtime_bindings: list[Any] | None,
    ) -> bool:
        """Return True only when an explicit binding targets this field."""
        if not isinstance(runtime_bindings, list):
            return False

        field = (
            item.get("field")
            or item.get("column")
            or item.get("column_name")
        )
        if not isinstance(field, str):
            return False

        field = field.strip().lower()
        if field.count(".") != 1:
            return False

        table_name, column_name = [
            part.strip()
            for part in field.split(".", 1)
        ]
        if not table_name or not column_name:
            return False

        for binding in runtime_bindings:
            if not isinstance(binding, dict):
                continue
            to_table = str(binding.get("to_table") or "").strip().lower()
            to_column = str(binding.get("to_column") or "").strip().lower()
            if to_table == table_name and to_column == column_name:
                return True

        return False

    def _validate_filters(
        self,
        filters: Any,
        source_ids: list[str],
        prefix: str = "filters",
        runtime_bindings: list[Any] | None = None,
    ) -> list[str]:
        if filters is None:
            return []
        if not isinstance(filters, list):
            return [f"{prefix} must be a list."]

        errors: list[str] = []
        for index, item in enumerate(filters):
            current_prefix = f"{prefix}[{index}]"

            if not isinstance(item, dict):
                errors.append(
                    f"{current_prefix} must be an object."
                )
                continue

            field = (
                item.get("field")
                or item.get("column")
                or item.get("column_name")
            )
            errors.extend(
                self._validate_field_reference(
                    field,
                    source_ids,
                    f"{current_prefix}.field",
                )
            )

            operator = str(
                item.get("operator")
                or item.get("op")
                or "="
            ).strip().lower()

            operator_aliases = {
                "eq": "=",
                "equals": "=",
                "ne": "!=",
                "not_equals": "!=",
                "gt": ">",
                "gte": ">=",
                "lt": "<",
                "lte": "<=",
                "not_in": "not_in",
            }
            operator = operator_aliases.get(operator, operator)

            if operator not in self.ALLOWED_FILTER_OPERATORS:
                errors.append(
                    f"{current_prefix}.operator is unsupported: "
                    f"{operator}"
                )

            if operator not in {"is_null", "is_not_null"}:
                if "value" not in item and not self._filter_runtime_bound(
                    item,
                    runtime_bindings,
                ):
                    errors.append(
                        f"{current_prefix} must contain value for operator "
                        f"{operator}, or have an explicit runtime binding."
                    )

        return errors

    def _validate_grouping(
        self,
        grouping: Any,
        source_ids: list[str],
        prefix: str = "grouping",
    ) -> list[str]:
        if grouping is None:
            return []
        if not isinstance(grouping, list):
            grouping = [grouping]

        errors: list[str] = []
        for index, item in enumerate(grouping):
            errors.extend(
                self._validate_field_reference(
                    item,
                    source_ids,
                    f"{prefix}[{index}]",
                )
            )
        return errors

    def _validate_sorting(
        self,
        sorting: Any,
        source_ids: list[str],
        prefix: str = "sorting",
    ) -> list[str]:
        if sorting is None:
            return []
        if isinstance(sorting, dict):
            sorting = [sorting]
        if not isinstance(sorting, list):
            return [f"{prefix} must be a list, object, or null."]

        errors: list[str] = []
        for index, item in enumerate(sorting):
            current_prefix = f"{prefix}[{index}]"
            if not isinstance(item, dict):
                errors.append(
                    f"{current_prefix} must be an object."
                )
                continue

            field = item.get("field")
            errors.extend(
                self._validate_field_reference(
                    field,
                    source_ids,
                    f"{current_prefix}.field",
                )
            )

            direction = str(
                item.get("direction", "desc")
            ).strip().lower()
            if direction not in self.ALLOWED_SORT_DIRECTIONS:
                errors.append(
                    f"{current_prefix}.direction must be asc or desc."
                )

        return errors

    # ------------------------------------------------------------------
    # Execution plan validation
    # ------------------------------------------------------------------

    @staticmethod
    def _execution_dependencies(step: dict[str, Any]) -> list[str]:
        """
        Return only explicit execution-step dependencies.

        `depends_on` contains step IDs.
        `inputs` is not globally a dependency field: source-query steps may
        use it for logical input/key names such as `company_id`, while
        set-operation steps use it to reference other execution steps.
        """
        values = step.get("depends_on", [])
        if not isinstance(values, list):
            return []

        return [
            str(value).strip()
            for value in values
            if str(value).strip()
        ]

    def _execution_depths(
        self,
        steps: dict[str, dict[str, Any]],
    ) -> tuple[dict[str, int], list[str]]:
        errors: list[str] = []
        depths: dict[str, int] = {}
        visiting: set[str] = set()
        visited: set[str] = set()

        def visit(step_id: str) -> int:
            if step_id in visiting:
                raise ValueError("execution_plan contains a dependency cycle.")
            if step_id in depths:
                return depths[step_id]

            visiting.add(step_id)
            step = steps[step_id]
            dependencies = self._execution_dependencies(step)

            if not dependencies:
                depth = 0
            else:
                depth = 0
                for dependency in dependencies:
                    if dependency not in steps:
                        errors.append(
                            f"execution step {step_id!r} references "
                            f"unknown dependency/input {dependency!r}."
                        )
                        continue
                    depth = max(depth, visit(dependency) + 1)

            visiting.remove(step_id)
            visited.add(step_id)
            depths[step_id] = depth
            return depth

        try:
            for step_id in steps:
                visit(step_id)
        except ValueError as exc:
            errors.append(str(exc))

        return depths, errors

    def _validate_binding(
        self,
        binding: Any,
        index: int,
        consumer_step: dict[str, Any],
        steps: dict[str, dict[str, Any]],
        selected_postgresql_sources: list[str],
    ) -> list[str]:
        prefix = (
            f"execution_plan.steps["
            f"{self._step_index(steps, consumer_step)}]"
            f".input_bindings[{index}]"
        )

        errors: list[str] = []

        if not isinstance(binding, dict):
            return [f"{prefix} must be an object."]

        from_step = str(binding.get("from_step") or "").strip()
        from_column = str(binding.get("from_column") or "").strip()
        to_table = str(binding.get("to_table") or "").strip()
        to_column = str(binding.get("to_column") or "").strip()
        operator = str(
            binding.get("operator") or "in"
        ).strip().lower()

        if not from_step:
            errors.append(f"{prefix}.from_step is required.")
        elif from_step not in steps:
            errors.append(
                f"{prefix}.from_step references unknown step "
                f"{from_step!r}."
            )

        if not from_column:
            errors.append(f"{prefix}.from_column is required.")

        if not to_table:
            errors.append(f"{prefix}.to_table is required.")

        if not to_column:
            errors.append(f"{prefix}.to_column is required.")

        if operator not in self.ALLOWED_BINDING_OPERATORS:
            errors.append(
                f"{prefix}.operator is unsupported: {operator!r}"
            )

        consumer_source = str(
            consumer_step.get("source_id") or ""
        ).strip().lower()

        if consumer_source and consumer_source in self.contexts:
            if to_table and to_column:
                errors.extend(
                    self._validate_columns(
                        [f"{to_table}.{to_column}"],
                        [consumer_source],
                        prefix=f"{prefix}.destination",
                    )
                )

        # Producer output/key declarations are used as deterministic
        # provenance constraints. If a producer explicitly declares them,
        # the binding must originate from one of those values.
        if from_step in steps and from_column:
            producer = steps[from_step]
            declared = []

            for field_name in ("output_columns", "key_columns"):
                values = producer.get(field_name, [])
                if isinstance(values, list):
                    declared.extend(
                        str(value).strip()
                        for value in values
                        if str(value).strip()
                    )

            producer_contract = producer.get("contract")
            if isinstance(producer_contract, dict):
                required = producer_contract.get("required_columns", [])
                if isinstance(required, list):
                    declared.extend(
                        str(value).strip()
                        for value in required
                        if isinstance(value, str) and value.strip()
                    )

            if declared:
                normalized_from = from_column.lower()
                matches = False
                for value in declared:
                    lowered = value.lower()
                    if lowered == normalized_from:
                        matches = True
                        break
                    if "." in value and value.rsplit(".", 1)[-1] == from_column:
                        matches = True
                        break

                if not matches:
                    errors.append(
                        f"{prefix}.from_column {from_column!r} is not "
                        "declared by the producer step output_columns, "
                        "key_columns, or required_columns."
                    )

        return errors

    @staticmethod
    def _step_index(
        steps: dict[str, dict[str, Any]],
        target: dict[str, Any],
    ) -> int:
        for index, step in enumerate(steps.values()):
            if step is target:
                return index
        return 0

    @staticmethod
    def _collect_execution_bindings(
        execution_plan: Any,
    ) -> list[Any]:
        """Collect explicit runtime input bindings from execution steps."""
        if not isinstance(execution_plan, dict):
            return []

        steps = execution_plan.get("steps", [])
        if not isinstance(steps, list):
            return []

        bindings: list[Any] = []
        for step in steps:
            if not isinstance(step, dict):
                continue
            step_bindings = step.get("input_bindings", [])
            if isinstance(step_bindings, list):
                bindings.extend(step_bindings)
        return bindings

    def _validate_execution_plan(
        self,
        execution_plan: Any,
        top_level_plan: dict[str, Any],
    ) -> list[str]:
        if execution_plan is None:
            return []

        if not isinstance(execution_plan, dict):
            return ["execution_plan must be an object."]

        errors: list[str] = []

        mode = str(
            execution_plan.get("mode", "single")
        ).strip().lower()
        if mode not in {"single", "multi_step"}:
            errors.append(
                f"execution_plan.mode is unsupported: {mode!r}"
            )

        raw_steps = execution_plan.get("steps")
        if not isinstance(raw_steps, list) or not raw_steps:
            return errors + [
                "execution_plan.steps must contain at least one step."
            ]

        if len(raw_steps) > self.MAX_EXECUTION_STEPS:
            errors.append(
                f"execution_plan.steps cannot exceed "
                f"{self.MAX_EXECUTION_STEPS} steps."
            )

        if mode == "single" and len(raw_steps) != 1:
            errors.append(
                "execution_plan.mode='single' requires exactly one step."
            )

        if mode == "multi_step" and len(raw_steps) < 2:
            errors.append(
                "execution_plan.mode='multi_step' requires at least two steps."
            )

        steps_by_id: dict[str, dict[str, Any]] = {}

        for index, raw_step in enumerate(raw_steps):
            prefix = f"execution_plan.steps[{index}]"

            if not isinstance(raw_step, dict):
                errors.append(f"{prefix} must be an object.")
                continue

            step_id = str(raw_step.get("id") or "").strip()
            step_type = str(raw_step.get("type") or "").strip().lower()

            if not step_id:
                errors.append(f"{prefix}.id is required.")
                continue

            if step_id in steps_by_id:
                errors.append(
                    f"{prefix}.id duplicates step {step_id!r}."
                )
                continue

            steps_by_id[step_id] = raw_step

            if step_type not in self.ALLOWED_EXECUTION_STEP_TYPES:
                errors.append(
                    f"{prefix}.type is unsupported: {step_type!r}"
                )

            depends_on = raw_step.get("depends_on", [])
            inputs = raw_step.get("inputs", [])

            if not isinstance(depends_on, list):
                errors.append(f"{prefix}.depends_on must be a list.")
            if not isinstance(inputs, list):
                errors.append(f"{prefix}.inputs must be a list.")

            source_id = raw_step.get("source_id")

            if step_type in {"source_query", "final_query"}:
                if not isinstance(source_id, str) or not source_id.strip():
                    errors.append(
                        f"{prefix}.source_id is required for {step_type}."
                    )
                elif source_id.strip().lower() not in self.contexts:
                    errors.append(
                        f"{prefix}.source_id references unknown PostgreSQL "
                        f"source: {source_id}"
                    )

            if step_type == "set_operation":
                operator = str(
                    raw_step.get("operator") or ""
                ).strip().lower()
                if operator not in self.ALLOWED_SET_OPERATIONS:
                    errors.append(
                        f"{prefix}.operator is unsupported: {operator!r}"
                    )

                input_count = len(inputs) if isinstance(inputs, list) else 0
                if operator in {
                    "intersect",
                    "union",
                    "union_all",
                    "except",
                } and input_count < 2:
                    errors.append(
                        f"{prefix}.operator {operator!r} requires at least "
                        "two inputs."
                    )
                elif operator == "distinct" and input_count < 1:
                    errors.append(
                        f"{prefix}.operator 'distinct' requires an input."
                    )

                # For set operations only, `inputs` are execution-step IDs.
                # Do not apply this rule to source_query/final_query steps,
                # where inputs may be logical key/field names such as
                # `company_id`.
                if isinstance(inputs, list):
                    for input_index, input_ref in enumerate(inputs):
                        input_id = str(input_ref).strip()
                        if not input_id:
                            errors.append(
                                f"{prefix}.inputs[{input_index}] must be a "
                                "non-empty execution step ID."
                            )
                            continue

                        if input_id not in steps_by_id:
                            errors.append(
                                f"{prefix}.inputs[{input_index}] references "
                                f"unknown execution step {input_id!r}."
                            )

            required_tables = raw_step.get("required_tables", [])
            required_columns = raw_step.get("required_columns", [])
            relationships = raw_step.get("relationships", [])
            filters = raw_step.get("filters", [])
            grouping = raw_step.get("grouping", [])
            sorting = raw_step.get("sorting", [])

            # The nested step is source-local. This avoids the old bug where
            # DB1 and DB2 had to share one ambiguous top-level schema scope.
            if isinstance(source_id, str) and source_id.strip().lower() in self.contexts:
                source = [source_id.strip().lower()]

                errors.extend(
                    self._validate_tables(
                        required_tables,
                        source,
                        prefix=f"{prefix}.required_tables",
                    )
                )
                errors.extend(
                    self._validate_columns(
                        required_columns,
                        source,
                        prefix=f"{prefix}.required_columns",
                    )
                )
                errors.extend(
                    self._validate_relationships(
                        relationships,
                        source,
                        prefix=f"{prefix}.relationships",
                    )
                )
                errors.extend(
                    self._validate_filters(
                        filters,
                        source,
                        prefix=f"{prefix}.filters",
                        runtime_bindings=raw_step.get(
                            "input_bindings",
                            [],
                        ),
                    )
                )
                errors.extend(
                    self._validate_grouping(
                        grouping,
                        source,
                        prefix=f"{prefix}.grouping",
                    )
                )
                errors.extend(
                    self._validate_sorting(
                        sorting,
                        source,
                        prefix=f"{prefix}.sorting",
                    )
                )

                contract = raw_step.get("contract", {})
                if isinstance(contract, dict):
                    contract_tables = contract.get("required_tables", [])
                    contract_columns = contract.get("required_columns", [])
                    contract_relationships = contract.get("relationships", [])
                    contract_filters = contract.get("filters", [])
                    contract_grouping = contract.get("grouping", [])
                    contract_sorting = contract.get("sorting", [])

                    errors.extend(
                        self._validate_tables(
                            contract_tables,
                            source,
                            prefix=f"{prefix}.contract.required_tables",
                        )
                    )
                    errors.extend(
                        self._validate_columns(
                            contract_columns,
                            source,
                            prefix=f"{prefix}.contract.required_columns",
                        )
                    )
                    errors.extend(
                        self._validate_relationships(
                            contract_relationships,
                            source,
                            prefix=f"{prefix}.contract.relationships",
                        )
                    )
                    errors.extend(
                        self._validate_filters(
                            contract_filters,
                            source,
                            prefix=f"{prefix}.contract.filters",
                            runtime_bindings=raw_step.get(
                                "input_bindings",
                                [],
                            ),
                        )
                    )
                    errors.extend(
                        self._validate_grouping(
                            contract_grouping,
                            source,
                            prefix=f"{prefix}.contract.grouping",
                        )
                    )
                    errors.extend(
                        self._validate_sorting(
                            contract_sorting,
                            source,
                            prefix=f"{prefix}.contract.sorting",
                        )
                    )

            bindings = raw_step.get("input_bindings", [])
            if bindings is not None and not isinstance(bindings, list):
                errors.append(
                    f"{prefix}.input_bindings must be a list."
                )
            elif isinstance(bindings, list):
                if len(bindings) > self.MAX_RUNTIME_BINDINGS:
                    errors.append(
                        f"{prefix}.input_bindings cannot exceed "
                        f"{self.MAX_RUNTIME_BINDINGS}."
                    )

                for binding_index, binding in enumerate(bindings):
                    errors.extend(
                        self._validate_binding(
                            binding,
                            binding_index,
                            raw_step,
                            steps_by_id,
                            top_level_plan.get(
                                "postgresql_sources",
                                [],
                            ),
                        )
                    )

        # Validate dependency references and acyclicity after IDs are known.
        depths, depth_errors = self._execution_depths(steps_by_id)
        errors.extend(depth_errors)

        for step_id, depth in depths.items():
            if depth >= self.MAX_DEPENDENCY_DEPTH:
                errors.append(
                    f"execution step {step_id!r} exceeds maximum dependency "
                    f"depth of {self.MAX_DEPENDENCY_DEPTH}."
                )

        final_step = str(
            execution_plan.get("final_step") or ""
        ).strip()
        if not final_step:
            errors.append(
                "execution_plan.final_step must be a non-empty step ID."
            )
        elif final_step not in steps_by_id:
            errors.append(
                f"execution_plan.final_step references unknown step: "
                f"{final_step}"
            )

        return errors

    # ------------------------------------------------------------------
    # Main validation
    # ------------------------------------------------------------------

    def validate(
        self,
        plan: dict[str, Any],
    ) -> dict[str, Any]:
        if not isinstance(plan, dict):
            return {
                "valid": False,
                "errors": [
                    "Question plan must be a dictionary."
                ],
                "plan": plan,
            }

        # CRITICAL: normalize planner representations before ANY validation.
        # This is what fixes the observed:
        #   required_columns[0] must use table.column format.
        # error when the planner returned {table, column} objects.
        normalized_plan = self._canonicalize_plan(plan)

        errors: list[str] = []

        question = normalized_plan.get("question")
        data_sources = normalized_plan.get(
            "data_sources",
            ["postgresql"],
        )
        postgresql_sources = normalized_plan.get(
            "postgresql_sources",
            [],
        )
        required_tables = normalized_plan.get(
            "required_tables",
            [],
        )
        required_columns = normalized_plan.get(
            "required_columns",
            [],
        )
        relationships = normalized_plan.get(
            "relationships",
            [],
        )
        operations = normalized_plan.get(
            "operations",
            [],
        )
        entities = normalized_plan.get(
            "entities",
            [],
        )
        filters = normalized_plan.get(
            "filters",
            [],
        )
        grouping = normalized_plan.get(
            "grouping",
            [],
        )
        sorting = normalized_plan.get(
            "sorting",
            [],
        )

        # --------------------------------------------------------------
        # Top-level validation
        # --------------------------------------------------------------

        errors.extend(
            self._validate_question(question)
        )
        errors.extend(
            self._validate_data_sources(data_sources)
        )

        normalized_sources = (
            [
                source.strip().lower()
                for source in postgresql_sources
                if isinstance(source, str)
            ]
            if isinstance(postgresql_sources, list)
            else postgresql_sources
        )

        if isinstance(data_sources, list):
            errors.extend(
                self._validate_postgresql_sources(
                    normalized_sources,
                    [
                        source.strip().lower()
                        for source in data_sources
                        if isinstance(source, str)
                    ],
                )
            )

        errors.extend(
            self._validate_security_resource(
                normalized_plan,
                [
                    source.strip().lower()
                    for source in data_sources
                    if isinstance(source, str)
                ] if isinstance(data_sources, list) else [],
            )
        )

        errors.extend(
            self._validate_entities(entities)
        )
        errors.extend(
            self._validate_operations(operations)
        )
        errors.extend(
            self._validate_limit(
                normalized_plan.get("limit")
            )
        )
        errors.extend(
            self._validate_confidence(
                normalized_plan.get("confidence")
            )
        )

        normalized_data_sources = (
            [
                source.strip().lower()
                for source in data_sources
                if isinstance(source, str)
            ]
            if isinstance(data_sources, list)
            else []
        )

        has_execution_plan = isinstance(
            normalized_plan.get("execution_plan"),
            dict,
        )

        # --------------------------------------------------------------
        # PostgreSQL schema validation
        # --------------------------------------------------------------
        # For explicit multi-source execution plans, source-local nested
        # steps are authoritative. Top-level metadata can be ambiguous when
        # the same table exists in DB1 and DB2, so avoid rejecting it merely
        # for that reason.

        if "postgresql" in normalized_data_sources:
            if isinstance(normalized_sources, list) and normalized_sources:
                if not has_execution_plan or len(normalized_sources) == 1:
                    errors.extend(
                        self._validate_tables(
                            required_tables,
                            normalized_sources,
                        )
                    )
                    errors.extend(
                        self._validate_columns(
                            required_columns,
                            normalized_sources,
                        )
                    )
                    errors.extend(
                        self._validate_relationships(
                            relationships,
                            normalized_sources,
                        )
                    )
                    errors.extend(
                        self._validate_filters(
                            filters,
                            normalized_sources,
                            runtime_bindings=self._collect_execution_bindings(
                                normalized_plan.get("execution_plan")
                            ),
                        )
                    )
                    errors.extend(
                        self._validate_grouping(
                            grouping,
                            normalized_sources,
                        )
                    )
                    errors.extend(
                        self._validate_sorting(
                            sorting,
                            normalized_sources,
                        )
                    )

                    errors.extend(
                        self._validate_table_column_consistency(
                            required_tables,
                            required_columns,
                        )
                    )

        # --------------------------------------------------------------
        # Security-only plan
        # --------------------------------------------------------------

        if normalized_data_sources == ["security_logs"]:
            if required_tables:
                errors.append(
                    "security_logs-only plans must have empty required_tables."
                )
            if required_columns:
                errors.append(
                    "security_logs-only plans must have empty required_columns."
                )
            if relationships:
                errors.append(
                    "security_logs-only plans must have empty relationships."
                )
            if sorting:
                errors.append(
                    "security_logs-only plans must have empty sorting."
                )

        # --------------------------------------------------------------
        # Nested execution plan
        # --------------------------------------------------------------

        errors.extend(
            self._validate_execution_plan(
                normalized_plan.get("execution_plan"),
                normalized_plan,
            )
        )

        return {
            "valid": len(errors) == 0,
            "errors": errors,
            # Return the CANONICALIZED plan so downstream components never
            # receive the old {table, column} representation accidentally.
            "plan": normalized_plan,
        }

def validate_question_plan(
    plan: dict[str, Any],
) -> dict[str, Any]:
    validator = QuestionPlanValidator()
    return validator.validate(plan)

if __name__ == "__main__":
    validator = QuestionPlanValidator()

    print(
        "Question plan validator initialized successfully."
    )
    print(
        "Available PostgreSQL sources:",
        validator._available_postgresql_sources(),
    )
