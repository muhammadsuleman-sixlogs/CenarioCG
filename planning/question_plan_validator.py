from typing import Any

from context.context_store import load_context


class QuestionPlanValidator:
    """
    Validate an LLM-generated question plan against the dynamically
    discovered Context Layer.

    This class does not access or modify PostgreSQL.
    """

    def __init__(self, context: dict[str, Any] | None = None):
        self.context = context if context is not None else load_context()

    def _known_tables(self) -> set[str]:
        return set(self.context.get("tables", {}).keys())

    def _known_columns(self) -> dict[str, set[str]]:
        result: dict[str, set[str]] = {}

        for table_name, table_info in self.context.get("tables", {}).items():
            result[table_name] = {
                column.get("name")
                for column in table_info.get("columns", [])
                if column.get("name")
            }

        return result

    def _known_relationships(self) -> list[dict[str, Any]]:
        relationships = []

        for relationship in self.context.get("relationships", []):
            relationships.append(relationship)

        for relationship in self.context.get(
            "business_relationships", []
        ):
            relationships.append(relationship)

        return relationships

    def _validate_tables(
        self,
        required_tables: list[Any],
    ) -> list[str]:

        errors = []
        known_tables = self._known_tables()

        for table in required_tables:
            if not isinstance(table, str):
                errors.append(
                    f"Invalid table reference: {table!r}"
                )
                continue

            if table not in known_tables:
                errors.append(
                    f"Unknown table: {table}"
                )

        return errors

    def _validate_columns(
        self,
        required_columns: list[Any],
    ) -> list[str]:

        errors = []
        known_columns = self._known_columns()

        for column_reference in required_columns:

            if not isinstance(column_reference, str):
                errors.append(
                    f"Invalid column reference: {column_reference!r}"
                )
                continue

            if "." not in column_reference:
                errors.append(
                    f"Column must use table.column format: "
                    f"{column_reference}"
                )
                continue

            table_name, column_name = column_reference.split(
                ".", 1
            )

            if table_name not in known_columns:
                errors.append(
                    f"Unknown table in column reference: "
                    f"{table_name}"
                )
                continue

            if column_name not in known_columns[table_name]:
                errors.append(
                    f"Unknown column: "
                    f"{table_name}.{column_name}"
                )

        return errors

    def _validate_relationships(
        self,
        requested_relationships: list[Any],
    ) -> list[str]:

        errors = []
        known_relationships = self._known_relationships()

        for requested in requested_relationships:

            if not isinstance(requested, dict):
                errors.append(
                    f"Invalid relationship format: {requested!r}"
                )
                continue

            source_table = requested.get("source_table")
            target_table = requested.get("target_table")

            if not source_table or not target_table:
                errors.append(
                    "Relationship must contain "
                    "source_table and target_table."
                )
                continue

            found = False

            for known in known_relationships:

                if (
                    known.get("source_table") == source_table
                    and known.get("target_table") == target_table
                ):
                    found = True
                    break

                if (
                    known.get("target_table") == source_table
                    and known.get("source_table") == target_table
                ):
                    found = True
                    break

            if not found:
                errors.append(
                    "Unknown relationship: "
                    f"{source_table} -> {target_table}"
                )

        return errors

    def validate(
        self,
        plan: dict[str, Any],
    ) -> dict[str, Any]:

        if not isinstance(plan, dict):
            raise ValueError("Question plan must be a dictionary.")

        errors: list[str] = []

        required_tables = plan.get(
            "required_tables",
            [],
        )

        required_columns = plan.get(
            "required_columns",
            [],
        )

        relationships = plan.get(
            "relationships",
            [],
        )

        if not isinstance(required_tables, list):
            errors.append(
                "required_tables must be a list."
            )
            required_tables = []

        if not isinstance(required_columns, list):
            errors.append(
                "required_columns must be a list."
            )
            required_columns = []

        if not isinstance(relationships, list):
            errors.append(
                "relationships must be a list."
            )
            relationships = []

        errors.extend(
            self._validate_tables(required_tables)
        )

        errors.extend(
            self._validate_columns(required_columns)
        )

        errors.extend(
            self._validate_relationships(relationships)
        )

        return {
            "valid": len(errors) == 0,
            "errors": errors,
            "plan": plan,
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
        "Known tables:",
        len(validator._known_tables()),
    )

    print(
        "Known relationships:",
        len(validator._known_relationships()),
    )