from typing import Any


class RetrievalContract:
    """
    Structured, validated description of the data retrieval required
    to answer a user question.

    This contract does not access or modify PostgreSQL.
    """

    def __init__(
        self,
        question: str,
        required_tables: list[str],
        required_columns: list[str],
        relationships: list[dict[str, Any]] | None = None,
        filters: list[Any] | None = None,
        operations: list[str] | None = None,
        grouping: list[str] | None = None,
        sorting: list[str] | None = None,
        limit: int | None = None,
        entities: list[Any] | None = None,
        needs_conversation_context: bool = False,
    ):
        if not question or not question.strip():
            raise ValueError("Question cannot be empty.")

        if not isinstance(required_tables, list):
            raise ValueError("required_tables must be a list.")

        if not isinstance(required_columns, list):
            raise ValueError("required_columns must be a list.")

        if relationships is not None and not isinstance(
            relationships, list
        ):
            raise ValueError("relationships must be a list.")

        if filters is not None and not isinstance(filters, list):
            raise ValueError("filters must be a list.")

        if operations is not None and not isinstance(
            operations, list
        ):
            raise ValueError("operations must be a list.")

        if grouping is not None and not isinstance(
            grouping, list
        ):
            raise ValueError("grouping must be a list.")

        if sorting is not None and not isinstance(
            sorting, list
        ):
            raise ValueError("sorting must be a list.")

        if limit is not None:
            if not isinstance(limit, int):
                raise ValueError("limit must be an integer.")

            if limit < 1:
                raise ValueError("limit must be greater than 0.")

        self.question = question.strip()
        self.required_tables = required_tables
        self.required_columns = required_columns
        self.relationships = relationships or []
        self.filters = filters or []
        self.operations = operations or []
        self.grouping = grouping or []
        self.sorting = sorting or []
        self.limit = limit
        self.entities = entities or []
        self.needs_conversation_context = (
            needs_conversation_context
        )

    def to_dict(self) -> dict[str, Any]:
        """
        Convert the contract into a plain dictionary.
        """

        return {
            "question": self.question,
            "required_tables": self.required_tables,
            "required_columns": self.required_columns,
            "relationships": self.relationships,
            "filters": self.filters,
            "operations": self.operations,
            "grouping": self.grouping,
            "sorting": self.sorting,
            "limit": self.limit,
            "entities": self.entities,
            "needs_conversation_context": (
                self.needs_conversation_context
            ),
        }

    @classmethod
    def from_plan(
        cls,
        plan: dict[str, Any],
    ) -> "RetrievalContract":
        """
        Build a retrieval contract from a validated question plan.

        The caller is responsible for validating the plan before
        creating the contract.
        """

        if not isinstance(plan, dict):
            raise ValueError("Question plan must be a dictionary.")

        return cls(
            question=plan.get("question", ""),
            required_tables=plan.get(
                "required_tables",
                [],
            ),
            required_columns=plan.get(
                "required_columns",
                [],
            ),
            relationships=plan.get(
                "relationships",
                [],
            ),
            filters=plan.get(
                "filters",
                [],
            ),
            operations=plan.get(
                "operations",
                [],
            ),
            grouping=plan.get(
                "grouping",
                [],
            ),
            sorting=plan.get(
                "sorting",
                [],
            ),
            limit=plan.get("limit"),
            entities=plan.get(
                "entities",
                [],
            ),
            needs_conversation_context=plan.get(
                "needs_conversation_context",
                False,
            ),
        )


def create_retrieval_contract(
    validated_plan: dict[str, Any],
) -> RetrievalContract:
    """
    Create a retrieval contract from a validated question plan.
    """

    if not validated_plan.get("valid", False):
        errors = validated_plan.get(
            "errors",
            ["Question plan is not valid."],
        )

        raise ValueError(
            "Cannot create retrieval contract from "
            f"invalid plan: {errors}"
        )

    plan = validated_plan.get("plan")

    if not isinstance(plan, dict):
        raise ValueError(
            "Validated result does not contain a valid plan."
        )

    return RetrievalContract.from_plan(plan)