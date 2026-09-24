from __future__ import annotations

from typing import Any

from context.context_store import load_all_contexts
from security.sensitive_data_policy import (
    is_sensitive_field_name,
    validate_not_sensitive_field,
)


class QuestionPlanValidator:
    """
    Validate an LLM-generated question plan against the dynamically
    discovered multi-source Context Layer.

    This validator:
    - does not access PostgreSQL
    - does not modify PostgreSQL
    - does not execute SQL
    - does not contain company-specific table or column names
    - prevents sensitive PostgreSQL fields from entering retrieval
    """

    ALLOWED_DATA_SOURCES = {
        "postgresql",
        "security_logs",
    }

    ALLOWED_SECURITY_RESOURCES = {
        "security_logs",
        "cli_audit_logs",
        "security_logs_summary",
        "workspace_security_logs",
        "workspace_siem_status",
        "security_overview",
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

    ALLOWED_SORT_DIRECTIONS = {
        "asc",
        "desc",
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

    def __init__(
        self,
        context: dict[str, Any] | None = None,
        contexts: dict[str, Any] | None = None,
    ):
        """
        Initialize the validator.

        `context` supports a single Context Layer.
        `contexts` supports multiple Context Layer sources.

        When neither is supplied, all discovered contexts are loaded.
        """

        if contexts is not None:
            if not isinstance(contexts, dict):
                raise ValueError("contexts must be a dictionary.")

            self.contexts = contexts

        elif context is not None:
            if not isinstance(context, dict):
                raise ValueError("context must be a dictionary.")

            source_id = str(
                context.get(
                    "source_id",
                    "db1",
                )
            ).strip().lower()

            self.contexts = {
                source_id: context,
            }

        else:
            self.contexts = load_all_contexts()

        if not isinstance(self.contexts, dict):
            raise ValueError(
                "Context Layer sources must be a dictionary."
            )

    # ------------------------------------------------------------------
    # Context discovery
    # ------------------------------------------------------------------

    def _available_postgresql_sources(self) -> list[str]:
        """
        Return dynamically discovered PostgreSQL source IDs.
        """

        sources: list[str] = []

        for source_id, context in self.contexts.items():
            if not isinstance(context, dict):
                continue

            source_type = str(
                context.get(
                    "source_type",
                    "postgresql",
                )
            ).strip().lower()

            if source_type == "postgresql":
                sources.append(
                    str(source_id).strip().lower()
                )

        return sorted(set(sources))

    def _known_tables(
        self,
        source_ids: list[str],
    ) -> dict[str, set[str]]:
        """
        Return discovered tables grouped by PostgreSQL source.

        Each source remains isolated so a table discovered in one
        PostgreSQL database cannot accidentally validate a plan for
        another database.
        """

        known: dict[str, set[str]] = {}

        for source_id in source_ids:
            context = self.contexts.get(source_id)

            if not isinstance(context, dict):
                continue

            tables = context.get("tables", {})

            if not isinstance(tables, dict):
                continue

            known[source_id] = {
                str(table_name)
                for table_name in tables.keys()
            }

        return known

    def _known_columns(
        self,
        source_ids: list[str],
    ) -> dict[str, dict[str, set[str]]]:
        """
        Return discovered columns grouped by PostgreSQL source and table.

        Sensitive fields are excluded from the usable retrieval schema.
        """

        known: dict[str, dict[str, set[str]]] = {}

        for source_id in source_ids:
            context = self.contexts.get(source_id)

            if not isinstance(context, dict):
                continue

            tables = context.get("tables", {})

            if not isinstance(tables, dict):
                continue

            source_columns: dict[str, set[str]] = {}

            for table_name, table_info in tables.items():
                if not isinstance(table_info, dict):
                    continue

                columns = table_info.get("columns", [])

                if not isinstance(columns, list):
                    continue

                usable_columns: set[str] = set()

                for column in columns:
                    if not isinstance(column, dict):
                        continue

                    column_name = column.get("name")

                    if not column_name:
                        continue

                    column_name = str(column_name)

                    if is_sensitive_field_name(column_name):
                        continue

                    usable_columns.add(column_name)

                source_columns[str(table_name)] = usable_columns

            known[source_id] = source_columns

        return known

    def _known_relationships(
        self,
        source_ids: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """
        Return dynamically discovered PostgreSQL relationships.
        """

        relationships: list[dict[str, Any]] = []

        selected_sources = (
            source_ids
            if source_ids is not None
            else self._available_postgresql_sources()
        )

        for source_id in selected_sources:
            context = self.contexts.get(source_id)

            if not isinstance(context, dict):
                continue

            source_relationships = context.get(
                "relationships",
                [],
            )

            if not isinstance(
                source_relationships,
                list,
            ):
                continue

            for relationship in source_relationships:
                if isinstance(relationship, dict):
                    relationships.append(relationship)

        return relationships

    # ------------------------------------------------------------------
    # Basic validation
    # ------------------------------------------------------------------

    def _validate_data_sources(
        self,
        plan: dict[str, Any],
        errors: list[str],
    ) -> None:
        data_sources = plan.get(
            "data_sources",
            ["postgresql"],
        )

        if not isinstance(data_sources, list):
            errors.append(
                "data_sources must be a list."
            )
            return

        invalid_sources = [
            source
            for source in data_sources
            if source not in self.ALLOWED_DATA_SOURCES
        ]

        if invalid_sources:
            errors.append(
                "Unsupported data source(s): "
                f"{invalid_sources}. "
                f"Allowed sources: "
                f"{sorted(self.ALLOWED_DATA_SOURCES)}"
            )

        if not data_sources:
            errors.append(
                "At least one data source is required."
            )

    def _validate_security_resource(
        self,
        plan: dict[str, Any],
        errors: list[str],
    ) -> None:
        if "security_logs" not in plan.get(
            "data_sources",
            [],
        ):
            return

        resource = plan.get(
            "security_resource"
        )

        if not resource:
            errors.append(
                "security_resource is required when "
                "security_logs is selected."
            )
            return

        if resource not in self.ALLOWED_SECURITY_RESOURCES:
            errors.append(
                "Unsupported security resource: "
                f"{resource}. "
                f"Allowed resources: "
                f"{sorted(self.ALLOWED_SECURITY_RESOURCES)}"
            )

    def _validate_postgresql_sources(
        self,
        plan: dict[str, Any],
        errors: list[str],
    ) -> list[str]:
        """
        Validate selected PostgreSQL sources.

        Returns the valid selected PostgreSQL source IDs.
        """

        if "postgresql" not in plan.get(
            "data_sources",
            [],
        ):
            return []

        available_sources = set(
            self._available_postgresql_sources()
        )

        selected_sources = plan.get(
            "postgresql_sources",
            [],
        )

        if not isinstance(
            selected_sources,
            list,
        ):
            errors.append(
                "postgresql_sources must be a list."
            )
            return []

        if not selected_sources:
            errors.append(
                "postgresql_sources is required when "
                "postgresql is selected."
            )
            return []

        valid_sources: list[str] = []

        for source_id in selected_sources:
            if not isinstance(
                source_id,
                str,
            ):
                errors.append(
                    "Each PostgreSQL source ID must be a string."
                )
                continue

            normalized = source_id.strip().lower()

            if normalized not in available_sources:
                errors.append(
                    "Unknown PostgreSQL source: "
                    f"{normalized}"
                )
                continue

            valid_sources.append(normalized)

        if len(set(valid_sources)) != len(valid_sources):
            errors.append(
                "postgresql_sources contains duplicate source IDs."
            )

        return valid_sources

    def _validate_source_consistency(
        self,
        plan: dict[str, Any],
        errors: list[str],
    ) -> None:
        data_sources = plan.get(
            "data_sources",
            [],
        )

        has_postgresql = (
            "postgresql" in data_sources
        )

        has_security = (
            "security_logs" in data_sources
        )

        if not has_postgresql:
            if plan.get("required_tables"):
                errors.append(
                    "required_tables cannot be used without "
                    "the postgresql data source."
                )

            if plan.get("required_columns"):
                errors.append(
                    "required_columns cannot be used without "
                    "the postgresql data source."
                )

        if not has_security:
            if plan.get("security_resource"):
                errors.append(
                    "security_resource cannot be used without "
                    "the security_logs data source."
                )

    def _validate_question(
        self,
        plan: dict[str, Any],
        errors: list[str],
    ) -> None:
        question = plan.get("question")

        if not isinstance(question, str) or not question.strip():
            errors.append(
                "question must be a non-empty string."
            )

    # ------------------------------------------------------------------
    # Plan fields
    # ------------------------------------------------------------------

    def _validate_entities(
        self,
        plan: dict[str, Any],
        errors: list[str],
    ) -> None:
        entities = plan.get(
            "entities",
            [],
        )

        for entity in entities:
            entity_id = (
                entity.get("id")
                if isinstance(entity, dict)
                else entity
            )

            if isinstance(entity_id, bool):
                errors.append(
                    "Entity id must be a non-empty string or numeric value: "
                    f"{entity!r}"
                )

            elif isinstance(entity_id, str):
                if not entity_id.strip():
                    errors.append(
                        "Entity id must be a non-empty string or numeric value: "
                        f"{entity!r}"
                    )

            elif not isinstance(entity_id, (int, float)):
                errors.append(
                    "Entity id must be a non-empty string or numeric value: "
                    f"{entity!r}"
                )

    def _validate_limit(
        self,
        plan: dict[str, Any],
        errors: list[str],
    ) -> None:
        limit = plan.get("limit")

        if limit is None:
            return

        if not isinstance(
            limit,
            int,
        ):
            errors.append(
                "limit must be an integer."
            )
            return

        if limit < 1:
            errors.append(
                "limit must be greater than 0."
            )

    def _validate_confidence(
        self,
        plan: dict[str, Any],
        errors: list[str],
    ) -> None:
        confidence = plan.get(
            "confidence"
        )

        if confidence is None:
            return

        if not isinstance(
            confidence,
            (int, float),
        ):
            errors.append(
                "confidence must be numeric."
            )
            return

        if not 0 <= confidence <= 1:
            errors.append(
                "confidence must be between 0 and 1."
            )

    def _validate_operations(
        self,
        plan: dict[str, Any],
        errors: list[str],
    ) -> None:
        operations = plan.get(
            "operations",
            [],
        )

        if not isinstance(
            operations,
            list,
        ):
            errors.append(
                "operations must be a list."
            )
            return

        for operation in operations:
            if not isinstance(
                operation,
                str,
            ):
                errors.append(
                    "Each operation must be a string."
                )
                continue

            normalized = operation.strip().lower()

            if not normalized:
                errors.append(
                    "Operation cannot be empty."
                )
                continue

            # Operations may contain expressions such as:
            # count(table.column)
            #
            # Only the operation/function name is validated here.
            operation_name = normalized.split(
                "(",
                1,
            )[0].strip()

            if operation_name not in self.ALLOWED_OPERATIONS:
                errors.append(
                    f"Unsupported operation: {operation}"
                )

    # ------------------------------------------------------------------
    # Field validation
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_field_reference(
        field_reference: Any,
    ) -> tuple[str, str] | None:
        if not isinstance(
            field_reference,
            str,
        ):
            return None

        normalized = field_reference.strip()

        if not normalized:
            return None

        parts = normalized.split(
            ".",
            1,
        )

        if len(parts) != 2:
            return None

        table_name = parts[0].strip()
        column_name = parts[1].strip()

        if not table_name or not column_name:
            return None

        return table_name, column_name

    def _validate_field_reference(
        self,
        field_reference: Any,
        known_columns: dict[str, dict[str, set[str]]],
        errors: list[str],
        field_type: str,
    ) -> bool:
        parsed = self._parse_field_reference(
            field_reference
        )

        if parsed is None:
            errors.append(
                f"{field_type} must use "
                "table.column format: "
                f"{field_reference}"
            )
            return False

        table_name, column_name = parsed

        # Explicit sensitive-field check.
        try:
            validate_not_sensitive_field(
                f"{table_name}.{column_name}"
            )
        except ValueError as exc:
            errors.append(
                f"{field_type} references a protected field: "
                f"{table_name}.{column_name}. "
                f"{exc}"
            )
            return False

        matching_sources = [
            source_id
            for source_id, source_tables in known_columns.items()
            if table_name in source_tables
            and column_name in source_tables[table_name]
        ]

        if not matching_sources:
            known_table_names = {
                table
                for source_tables in known_columns.values()
                for table in source_tables
            }

            if table_name not in known_table_names:
                errors.append(
                    f"Unknown table in {field_type}: "
                    f"{table_name}"
                )
            else:
                errors.append(
                    f"Unknown column in {field_type}: "
                    f"{table_name}.{column_name}"
                )

            return False

        return True

    def _validate_columns(
        self,
        plan: dict[str, Any],
        errors: list[str],
        known_columns: dict[str, dict[str, set[str]]],
    ) -> None:
        """
        Backward-compatible wrapper for required column validation.
        """

        known_tables = self._known_tables(
            plan.get("postgresql_sources", [])
        )

        self._validate_required_columns(
            plan,
            errors,
            known_tables,
            known_columns,
        )

    def _validate_sorting(
        self,
        plan: dict[str, Any],
        errors: list[str],
        known_columns: dict[str, dict[str, set[str]]],
    ) -> None:
        sorting = plan.get(
            "sorting",
            [],
        )

        if sorting is None:
            return

        if not isinstance(
            sorting,
            list,
        ):
            errors.append(
                "sorting must be a list."
            )
            return

        for item in sorting:
            if isinstance(item, str):
                field_reference = item
                direction = "asc"

            elif isinstance(item, dict):
                field_reference = item.get(
                    "field"
                )
                direction = str(
                    item.get(
                        "direction",
                        "asc",
                    )
                ).strip().lower()

            else:
                errors.append(
                    "Each sorting item must be a string "
                    "or dictionary."
                )
                continue

            self._validate_field_reference(
                field_reference,
                known_columns,
                errors,
                "sorting",
            )

            if direction not in self.ALLOWED_SORT_DIRECTIONS:
                errors.append(
                    "Unsupported sorting direction: "
                    f"{direction}"
                )

    def _validate_filters(
        self,
        plan: dict[str, Any],
        errors: list[str],
        known_columns: dict[str, dict[str, set[str]]],
    ) -> None:
        """
        Validate PostgreSQL filter fields and operators.

        Security-log filters are intentionally not interpreted here.
        They remain owned by the security-log retrieval layer.
        """

        if "postgresql" not in plan.get(
            "data_sources",
            [],
        ):
            return

        filters = plan.get(
            "filters",
            [],
        )

        if filters is None:
            return

        if not isinstance(
            filters,
            list,
        ):
            errors.append(
                "filters must be a list."
            )
            return

        for index, item in enumerate(filters):
            if not isinstance(
                item,
                dict,
            ):
                errors.append(
                    f"Filter at index {index} must be a dictionary."
                )
                continue

            field_reference = item.get(
                "field"
            )

            operator = str(
                item.get(
                    "operator",
                    "=",
                )
            ).strip().lower()

            self._validate_field_reference(
                field_reference,
                known_columns,
                errors,
                f"filters[{index}].field",
            )

            if operator not in self.ALLOWED_FILTER_OPERATORS:
                errors.append(
                    f"Unsupported filter operator at "
                    f"index {index}: {operator}"
                )

    def _validate_grouping(
        self,
        plan: dict[str, Any],
        errors: list[str],
        known_columns: dict[str, dict[str, set[str]]],
    ) -> None:
        if "postgresql" not in plan.get(
            "data_sources",
            [],
        ):
            return

        grouping = plan.get(
            "grouping",
            [],
        )

        if grouping is None:
            return

        if not isinstance(
            grouping,
            list,
        ):
            errors.append(
                "grouping must be a list."
            )
            return

        for field_reference in grouping:
            self._validate_field_reference(
                field_reference,
                known_columns,
                errors,
                "grouping",
            )

    # ------------------------------------------------------------------
    # Table / relationship validation
    # ------------------------------------------------------------------

    def _validate_table_column_consistency(
        self,
        plan: dict[str, Any],
        errors: list[str],
        known_tables: dict[str, set[str]],
        known_columns: dict[str, dict[str, set[str]]],
    ) -> None:
        """
        Validate every table.column reference against the selected
        PostgreSQL source.

        A table/column is valid only when it exists in the same
        selected source.
        """

        source_ids = plan.get(
            "postgresql_sources",
            [],
        )

        if not isinstance(source_ids, list):
            return

        required_columns = plan.get(
            "required_columns",
            [],
        )

        if not isinstance(required_columns, list):
            return

        for field in required_columns:
            if not isinstance(field, str):
                continue

            parts = field.split(
                ".",
                1,
            )

            if len(parts) != 2:
                continue

            table_name, column_name = parts

            matching_sources = [
                source_id
                for source_id in source_ids
                if table_name
                in known_tables.get(
                    source_id,
                    set(),
                )
                and column_name
                in known_columns.get(
                    source_id,
                    {},
                ).get(
                    table_name,
                    set(),
                )
            ]

            if not matching_sources:
                errors.append(
                    f"Unknown or unavailable column for selected "
                    f"PostgreSQL sources: {field}"
                )

    def _validate_required_tables(
        self,
        plan: dict[str, Any],
        errors: list[str],
        known_tables: dict[str, set[str]],
    ) -> None:
        """
        Validate required tables against the explicitly selected
        PostgreSQL sources.
        """

        source_ids = plan.get(
            "postgresql_sources",
            [],
        )

        if not isinstance(source_ids, list):
            return

        required_tables = plan.get(
            "required_tables",
            [],
        )

        if not isinstance(required_tables, list):
            return

        for table_name in required_tables:
            if not isinstance(table_name, str):
                continue

            exists = any(
                table_name
                in known_tables.get(
                    source_id,
                    set(),
                )
                for source_id in source_ids
            )

            if not exists:
                errors.append(
                    f"Unknown table for selected PostgreSQL sources: "
                    f"{table_name}"
                )

    def _validate_required_columns(
        self,
        plan: dict[str, Any],
        errors: list[str],
        known_tables: dict[str, set[str]],
        known_columns: dict[str, dict[str, set[str]]],
    ) -> None:
        """
        Validate required_columns and ensure every referenced table
        belongs to one of the selected PostgreSQL sources.
        """

        source_ids = plan.get(
            "postgresql_sources",
            [],
        )

        if not isinstance(source_ids, list):
            return

        required_tables = plan.get(
            "required_tables",
            [],
        )

        if not isinstance(required_tables, list):
            required_tables = []

        required_columns = plan.get(
            "required_columns",
            [],
        )

        if not isinstance(required_columns, list):
            return

        for field in required_columns:
            if not isinstance(field, str):
                continue

            parts = field.split(
                ".",
                1,
            )

            if len(parts) != 2:
                continue

            table_name, column_name = parts

            if table_name not in required_tables:
                errors.append(
                    f"Required column references a table that is not "
                    f"in required_tables: {field}"
                )
                continue

            valid = False

            for source_id in source_ids:
                source_tables = known_tables.get(
                    source_id,
                    set(),
                )

                if table_name not in source_tables:
                    continue

                source_table_columns = known_columns.get(
                    source_id,
                    {},
                ).get(
                    table_name,
                    set(),
                )

                if column_name in source_table_columns:
                    valid = True
                    break

            if not valid:
                errors.append(
                    f"Unknown required column for selected "
                    f"PostgreSQL sources: {field}"
                )

    def _validate_relationships(
        self,
        plan: dict[str, Any],
        errors: list[str],
    ) -> None:
        """
        Validate discovered relationships while preserving PostgreSQL
        source boundaries.

        A relationship is valid only when its source and target tables
        exist within the same selected PostgreSQL source.
        """

        source_ids = plan.get(
            "postgresql_sources",
            [],
        )

        if not isinstance(source_ids, list):
            return

        required_relationships = plan.get(
            "relationships",
            [],
        )

        if not isinstance(required_relationships, list):
            return

        for relationship in required_relationships:
            if not isinstance(relationship, dict):
                continue

            source_table = relationship.get(
                "source_table"
            )

            target_table = relationship.get(
                "target_table"
            )

            if not source_table or not target_table:
                continue

            relationship_valid = False

            for source_id in source_ids:
                context = self.contexts.get(
                    source_id
                )

                if not isinstance(context, dict):
                    continue

                tables = context.get(
                    "tables",
                    {},
                )

                if not isinstance(tables, dict):
                    continue

                if (
                    source_table not in tables
                    or target_table not in tables
                ):
                    continue

                discovered_relationships = context.get(
                    "relationships",
                    [],
                )

                if not isinstance(
                    discovered_relationships,
                    list,
                ):
                    continue

                for discovered in discovered_relationships:
                    if not isinstance(
                        discovered,
                        dict,
                    ):
                        continue

                    discovered_source = discovered.get(
                        "source_table"
                    )

                    discovered_target = discovered.get(
                        "target_table"
                    )

                    same_direction = (
                        discovered_source == source_table
                        and discovered_target == target_table
                    )

                    reverse_direction = (
                        discovered_source == target_table
                        and discovered_target == source_table
                    )

                    if (
                        same_direction
                        or reverse_direction
                    ):
                        relationship_valid = True
                        break

                if relationship_valid:
                    break

            if not relationship_valid:
                errors.append(
                    "Unknown relationship for selected "
                    "PostgreSQL sources: "
                    f"{source_table} -> {target_table}"
                )

    # ------------------------------------------------------------------
    # Security-only consistency
    # ------------------------------------------------------------------

    def _validate_security_only_consistency(
        self,
        plan: dict[str, Any],
        errors: list[str],
    ) -> None:
        data_sources = plan.get(
            "data_sources",
            [],
        )

        if data_sources != ["security_logs"]:
            return

        postgres_fields = (
            plan.get("required_tables")
            or plan.get("required_columns")
            or plan.get("relationships")
            or plan.get("grouping")
        )

        if postgres_fields:
            errors.append(
                "A security-only plan cannot contain "
                "PostgreSQL retrieval fields."
            )

    # ------------------------------------------------------------------
    # Main validation
    # ------------------------------------------------------------------

    def validate(
        self,
        plan: dict[str, Any],
    ) -> dict[str, Any]:
        """
        Validate a question plan.

        Returns:
            {
                "valid": bool,
                "errors": [...],
                "plan": plan
            }
        """

        errors: list[str] = []

        if not isinstance(
            plan,
            dict,
        ):
            return {
                "valid": False,
                "errors": [
                    "Question plan must be a dictionary."
                ],
                "plan": plan,
            }

        self._validate_question(
            plan,
            errors,
        )

        self._validate_data_sources(
            plan,
            errors,
        )

        self._validate_security_resource(
            plan,
            errors,
        )

        selected_postgresql_sources = (
            self._validate_postgresql_sources(
                plan,
                errors,
            )
        )

        self._validate_source_consistency(
            plan,
            errors,
        )

        self._validate_entities(
            plan,
            errors,
        )

        self._validate_operations(
            plan,
            errors,
        )

        self._validate_limit(
            plan,
            errors,
        )

        self._validate_confidence(
            plan,
            errors,
        )

        if "postgresql" in plan.get(
            "data_sources",
            [],
        ):
            known_tables = self._known_tables(
                selected_postgresql_sources
            )

            known_columns = self._known_columns(
                selected_postgresql_sources
            )

            self._validate_required_tables(
                plan,
                errors,
                known_tables,
            )

            self._validate_required_columns(
                plan,
                errors,
                known_tables,
                known_columns,
            )

            self._validate_filters(
                plan,
                errors,
                known_columns,
            )

            self._validate_grouping(
                plan,
                errors,
                known_columns,
            )

            self._validate_sorting(
                plan,
                errors,
                known_columns,
            )

            self._validate_relationships(
                plan,
                errors,
            )

            self._validate_table_column_consistency(
                plan,
                errors,
                known_tables,
                known_columns,
            )

        self._validate_security_only_consistency(
            plan,
            errors,
        )

        return {
            "valid": len(errors) == 0,
            "errors": errors,
            "plan": plan,
        }
