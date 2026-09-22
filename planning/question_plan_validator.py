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
        source_ids: list[str] | None = None,
    ) -> set[str]:
        """
        Return dynamically discovered PostgreSQL table names.
        """

        tables: set[str] = set()

        selected_sources = (
            source_ids
            if source_ids is not None
            else self._available_postgresql_sources()
        )

        for source_id in selected_sources:
            context = self.contexts.get(source_id)

            if not isinstance(context, dict):
                continue

            context_tables = context.get(
                "tables",
                {},
            )

            if not isinstance(context_tables, dict):
                continue

            tables.update(
                str(table_name)
                for table_name in context_tables.keys()
            )

        return tables

    def _known_columns(
        self,
        source_ids: list[str] | None = None,
    ) -> dict[str, set[str]]:
        """
        Return dynamically discovered PostgreSQL columns.

        Sensitive fields are deliberately excluded from this catalog.

        This prevents protected fields from being considered valid
        retrieval targets.
        """

        columns_by_table: dict[str, set[str]] = {}

        selected_sources = (
            source_ids
            if source_ids is not None
            else self._available_postgresql_sources()
        )

        for source_id in selected_sources:
            context = self.contexts.get(source_id)

            if not isinstance(context, dict):
                continue

            tables = context.get(
                "tables",
                {},
            )

            if not isinstance(tables, dict):
                continue

            for table_name, table_info in tables.items():
                if not isinstance(table_info, dict):
                    continue

                normalized_table = str(table_name).strip()

                if not normalized_table:
                    continue

                columns = table_info.get(
                    "columns",
                    [],
                )

                if not isinstance(columns, list):
                    continue

                table_columns = columns_by_table.setdefault(
                    normalized_table,
                    set(),
                )

                for column in columns:
                    if not isinstance(column, dict):
                        continue

                    column_name = column.get("name")

                    if not isinstance(column_name, str):
                        continue

                    column_name = column_name.strip()

                    if not column_name:
                        continue

                    # Defense in depth:
                    # never expose protected fields as valid columns.
                    if is_sensitive_field_name(column_name):
                        continue

                    table_columns.add(column_name)

        return columns_by_table

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
            entity_id = entity.get("id") if isinstance(entity, dict) else entity
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
        known_columns: dict[str, set[str]],
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

        if table_name not in known_columns:
            errors.append(
                f"Unknown table in {field_type}: "
                f"{table_name}"
            )
            return False

        if column_name not in known_columns[table_name]:
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
        known_columns: dict[str, set[str]],
    ) -> None:
        required_columns = plan.get(
            "required_columns",
            [],
        )

        if not isinstance(
            required_columns,
            list,
        ):
            errors.append(
                "required_columns must be a list."
            )
            return

        for field_reference in required_columns:
            self._validate_field_reference(
                field_reference,
                known_columns,
                errors,
                "required_columns",
            )

    def _validate_sorting(
        self,
        plan: dict[str, Any],
        errors: list[str],
        known_columns: dict[str, set[str]],
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
        known_columns: dict[str, set[str]],
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
        known_columns: dict[str, set[str]],
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

    def _validate_tables(
        self,
        plan: dict[str, Any],
        errors: list[str],
        known_tables: set[str],
    ) -> None:
        required_tables = plan.get(
            "required_tables",
            [],
        )

        if not isinstance(
            required_tables,
            list,
        ):
            errors.append(
                "required_tables must be a list."
            )
            return

        for table_name in required_tables:
            if not isinstance(
                table_name,
                str,
            ):
                errors.append(
                    "Each required table must be a string."
                )
                continue

            if table_name not in known_tables:
                errors.append(
                    f"Unknown required table: {table_name}"
                )

    def _validate_relationships(
        self,
        plan: dict[str, Any],
        errors: list[str],
        known_relationships: list[dict[str, Any]],
    ) -> None:
        relationships = plan.get(
            "relationships",
            [],
        )

        if not isinstance(
            relationships,
            list,
        ):
            errors.append(
                "relationships must be a list."
            )
            return

        known_pairs: set[tuple[str, str]] = set()

        for relationship in known_relationships:
            if not isinstance(
                relationship,
                dict,
            ):
                continue

            source_table = relationship.get(
                "source_table"
            )
            target_table = relationship.get(
                "target_table"
            )

            if source_table and target_table:
                known_pairs.add(
                    (
                        str(source_table),
                        str(target_table),
                    )
                )

        for relationship in relationships:
            if not isinstance(
                relationship,
                dict,
            ):
                errors.append(
                    "Each relationship must be a dictionary."
                )
                continue

            source_table = relationship.get(
                "source_table"
            )
            target_table = relationship.get(
                "target_table"
            )

            if not source_table or not target_table:
                errors.append(
                    "Relationship must contain "
                    "source_table and target_table."
                )
                continue

            pair = (
                str(source_table),
                str(target_table),
            )

            reverse_pair = (
                str(target_table),
                str(source_table),
            )

            if (
                pair not in known_pairs
                and reverse_pair not in known_pairs
            ):
                errors.append(
                    "Unknown relationship: "
                    f"{source_table} -> {target_table}"
                )

    def _validate_table_column_consistency(
        self,
        plan: dict[str, Any],
        errors: list[str],
    ) -> None:
        required_tables = plan.get(
            "required_tables",
            [],
        )

        required_columns = plan.get(
            "required_columns",
            [],
        )

        if not isinstance(
            required_tables,
            list,
        ):
            return

        if not isinstance(
            required_columns,
            list,
        ):
            return

        table_set = set(
            required_tables
        )

        for field_reference in required_columns:
            parsed = self._parse_field_reference(
                field_reference
            )

            if parsed is None:
                continue

            table_name, _ = parsed

            if table_name not in table_set:
                errors.append(
                    "Required column references a table that "
                    "is not included in required_tables: "
                    f"{field_reference}"
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

            known_relationships = (
                self._known_relationships(
                    selected_postgresql_sources
                )
            )

            self._validate_tables(
                plan,
                errors,
                known_tables,
            )

            self._validate_columns(
                plan,
                errors,
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
                known_relationships,
            )

            self._validate_table_column_consistency(
                plan,
                errors,
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