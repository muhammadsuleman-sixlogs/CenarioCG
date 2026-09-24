from typing import Any


class RetrievalContract:
    """
    Structured, validated description of the data retrieval required
    to answer a user question.

    This contract does not access or modify PostgreSQL.

    data_sources identifies which live sources are required:
    - postgresql
    - security_logs

    PostgreSQL-specific retrieval details remain in the fields such as
    required_tables, required_columns, relationships, filters, etc.
    """

    ALLOWED_DATA_SOURCES = {
        "postgresql",
        "security_logs",
    }

    def __init__(
        self,
        question: str,
        required_tables: list[str],
        postgresql_sources: list[str] | None = None,
        required_columns: list[str] = None,
        relationships: list[dict[str, Any]] | None = None,
        filters: list[Any] | None = None,
        operations: list[str] | None = None,
        grouping: list[str] | None = None,
        sorting: list[str] | None = None,
        limit: int | None = None,
        entities: list[Any] | None = None,
        needs_conversation_context: bool = False,
        data_sources: list[str] | None = None,
    ):
        if not question or not question.strip():
            raise ValueError("Question cannot be empty.")

        if not isinstance(required_tables, list):
            raise ValueError("required_tables must be a list.")

        if required_columns is None:
            required_columns = []

        if not isinstance(required_columns, list):
            raise ValueError("required_columns must be a list.")

        if relationships is not None and not isinstance(
            relationships,
            list,
        ):
            raise ValueError("relationships must be a list.")

        if filters is not None and not isinstance(
            filters,
            list,
        ):
            raise ValueError("filters must be a list.")

        if operations is not None and not isinstance(
            operations,
            list,
        ):
            raise ValueError("operations must be a list.")

        if grouping is not None and not isinstance(
            grouping,
            list,
        ):
            raise ValueError("grouping must be a list.")

        if sorting is not None and not isinstance(
            sorting,
            list,
        ):
            raise ValueError("sorting must be a list.")

        if limit is not None:
            if not isinstance(limit, int):
                raise ValueError("limit must be an integer.")

            if limit < 1:
                raise ValueError("limit must be greater than 0.")

        if data_sources is None:
            data_sources = ["postgresql"]

        if not isinstance(data_sources, list):
            raise ValueError(
                "data_sources must be a list."
            )

        invalid_sources = [
            source
            for source in data_sources
            if source not in self.ALLOWED_DATA_SOURCES
        ]

        if invalid_sources:
            raise ValueError(
                "Unsupported data source(s): "
                f"{invalid_sources}. "
                f"Allowed sources: "
                f"{sorted(self.ALLOWED_DATA_SOURCES)}"
            )

        if not data_sources:
            raise ValueError(
                "At least one data source is required."
            )

        if postgresql_sources is None:
            postgresql_sources = []

        if not isinstance(postgresql_sources, list):
            raise ValueError(
                "postgresql_sources must be a list."
            )

        if any(
            not isinstance(source, str) or not source.strip()
            for source in postgresql_sources
        ):
            raise ValueError(
                "postgresql_sources must contain non-empty strings."
            )

        self.question = question.strip()
        self.postgresql_sources = postgresql_sources
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
        self.data_sources = data_sources

    def to_dict(self) -> dict[str, Any]:
        """
        Convert the contract into a plain dictionary.
        """
        return {
            "question": self.question,
            "data_sources": self.data_sources,
            "postgresql_sources": self.postgresql_sources,
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
            raise ValueError(
                "Question plan must be a dictionary."
            )

        return cls(
            question=plan.get(
                "question",
                "",
            ),
            postgresql_sources=plan.get(
                "postgresql_sources",
                [],
            ),
            data_sources=plan.get(
                "data_sources",
                ["postgresql"],
            ),
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
            limit=plan.get(
                "limit",
            ),
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
    Create a retrieval contract from a question plan that has
    already passed QuestionPlanValidator.

    The caller is responsible for validating the plan before
    calling this function.
    """
    if not isinstance(validated_plan, dict):
        raise ValueError(
            "Validated question plan must be a dictionary."
        )

    return RetrievalContract.from_plan(
        validated_plan
    )

