from __future__ import annotations

from copy import deepcopy
from typing import Any


class RetrievalContract:
    """
    Source-local retrieval contract.

    This is NOT the canonical multi-source query plan.

    Responsibilities:
        - describe one retrieval operation
        - preserve the validated question-plan fields
        - identify the logical data-source type
        - optionally identify the concrete PostgreSQL source
        - provide a stable dictionary consumed by retrieval components

    Multi-step orchestration belongs to:
        planning.query_plan.QueryPlan

    Runtime cross-source values belong to:
        planning.query_plan.InputBinding

    SQL generation belongs to:
        retrieval.sql_generator

    PostgreSQL remains strictly read-only.
    """

    ALLOWED_DATA_SOURCES = {
        "postgresql",
        "security_logs",
    }

    OPERATION_ALIASES = {
        "lookup": "lookup",
        "count": "count",
        "sum": "sum",
        "average": "average",
        "avg": "average",
        "mean": "average",
        "minimum": "minimum",
        "min": "minimum",
        "maximum": "maximum",
        "max": "maximum",
        "comparison": "comparison",
        "ranking": "ranking",
        "grouping": "grouping",
        "aggregation": "aggregation",
        "general": "general",
    }

    FILTER_OPERATOR_ALIASES = {
        "eq": "=",
        "equals": "=",
        "==": "=",
    }

    def __init__(
        self,
        question: str,
        required_tables: list[str],
        postgresql_sources: list[str] | None = None,
        required_columns: list[str] | None = None,
        relationships: list[dict[str, Any]] | None = None,
        filters: list[Any] | None = None,
        operations: list[str] | None = None,
        grouping: list[str] | None = None,
        sorting: list[Any] | None = None,
        limit: int | None = None,
        entities: list[Any] | None = None,
        needs_conversation_context: bool = False,
        data_sources: list[str] | None = None,
        requested_metrics: list[dict[str, Any]] | None = None,
        source_id: str | None = None,
    ):
        if not isinstance(question, str) or not question.strip():
            raise ValueError(
                "Question cannot be empty."
            )

        if not isinstance(required_tables, list):
            raise ValueError(
                "required_tables must be a list."
            )

        if not all(
            isinstance(item, str) and item.strip()
            for item in required_tables
        ):
            raise ValueError(
                "required_tables must contain non-empty strings."
            )

        if required_columns is None:
            required_columns = []

        if not isinstance(required_columns, list):
            raise ValueError(
                "required_columns must be a list."
            )

        if not all(
            isinstance(item, str) and item.strip()
            for item in required_columns
        ):
            raise ValueError(
                "required_columns must contain non-empty strings."
            )

        if relationships is None:
            relationships = []

        if not isinstance(relationships, list):
            raise ValueError(
                "relationships must be a list."
            )

        if filters is None:
            filters = []

        if not isinstance(filters, list):
            raise ValueError(
                "filters must be a list."
            )

        if operations is None:
            operations = []

        if not isinstance(operations, list):
            raise ValueError(
                "operations must be a list."
            )

        if not all(
            isinstance(item, str) and item.strip()
            for item in operations
        ):
            raise ValueError(
                "operations must contain non-empty strings."
            )

        if grouping is None:
            grouping = []

        if not isinstance(grouping, list):
            raise ValueError(
                "grouping must be a list."
            )

        if not all(
            isinstance(item, str) and item.strip()
            for item in grouping
        ):
            raise ValueError(
                "grouping must contain non-empty strings."
            )

        if sorting is None:
            sorting = []

        if not isinstance(sorting, list):
            raise ValueError(
                "sorting must be a list."
            )

        if limit is not None:
            if (
                isinstance(limit, bool)
                or not isinstance(limit, int)
            ):
                raise ValueError(
                    "limit must be an integer."
                )

            if limit < 1:
                raise ValueError(
                    "limit must be greater than 0."
                )

        if entities is None:
            entities = []

        if not isinstance(entities, list):
            raise ValueError(
                "entities must be a list."
            )

        if requested_metrics is None:
            requested_metrics = []

        if not isinstance(requested_metrics, list):
            raise ValueError(
                "requested_metrics must be a list."
            )

        if data_sources is None:
            data_sources = ["postgresql"]

        if not isinstance(data_sources, list):
            raise ValueError(
                "data_sources must be a list."
            )

        normalized_data_sources = self._normalize_data_sources(
            data_sources
        )

        if not normalized_data_sources:
            raise ValueError(
                "At least one data source is required."
            )

        if postgresql_sources is None:
            postgresql_sources = []

        if not isinstance(postgresql_sources, list):
            raise ValueError(
                "postgresql_sources must be a list."
            )

        normalized_postgresql_sources = self._normalize_source_ids(
            postgresql_sources
        )

        normalized_source_id = None

        if source_id is not None:
            if (
                not isinstance(source_id, str)
                or not source_id.strip()
            ):
                raise ValueError(
                    "source_id must be a non-empty string."
                )

            normalized_source_id = source_id.strip().lower()

            if normalized_data_sources == ["postgresql"]:
                if (
                    normalized_postgresql_sources
                    and normalized_source_id
                    not in normalized_postgresql_sources
                ):
                    raise ValueError(
                        "source_id must be one of postgresql_sources "
                        "for a PostgreSQL retrieval contract."
                    )

                if not normalized_postgresql_sources:
                    normalized_postgresql_sources = [
                        normalized_source_id
                    ]

        self.question = question.strip()

        self.source_id = normalized_source_id

        self.data_sources = normalized_data_sources

        self.postgresql_sources = (
            normalized_postgresql_sources
        )

        self.required_tables = self._unique_strings(
            required_tables
        )

        self.required_columns = self._unique_strings(
            required_columns
        )

        self.relationships = deepcopy(
            relationships
        )

        self.filters = deepcopy(
            filters
        )

        self.operations = self._normalize_operations(
            operations
        )

        self.grouping = self._unique_strings(
            grouping
        )

        self.sorting = deepcopy(
            sorting
        )

        self.limit = limit

        self.entities = deepcopy(
            entities
        )

        self.needs_conversation_context = bool(
            needs_conversation_context
        )

        self.requested_metrics = (
            self._normalize_requested_metrics(
                requested_metrics
            )
        )

    @classmethod
    def _normalize_data_sources(
        cls,
        data_sources: list[Any],
    ) -> list[str]:
        normalized: list[str] = []

        for source in data_sources:
            if not isinstance(source, str):
                raise ValueError(
                    "data_sources must contain strings."
                )

            value = source.strip().lower()

            if not value:
                raise ValueError(
                    "data_sources must contain non-empty strings."
                )

            # Physical PostgreSQL source IDs such as db1/db2 are
            # intentionally NOT accepted as logical data_sources.
            if value not in cls.ALLOWED_DATA_SOURCES:
                raise ValueError(
                    f"Unsupported data source: {value!r}. "
                    f"Allowed sources: "
                    f"{sorted(cls.ALLOWED_DATA_SOURCES)}"
                )

            normalized.append(value)

        return list(
            dict.fromkeys(normalized)
        )

    @staticmethod
    def _normalize_source_ids(
        source_ids: list[Any],
    ) -> list[str]:
        normalized: list[str] = []

        for source_id in source_ids:
            if (
                not isinstance(source_id, str)
                or not source_id.strip()
            ):
                raise ValueError(
                    "postgresql_sources must contain "
                    "non-empty strings."
                )

            normalized.append(
                source_id.strip().lower()
            )

        return list(
            dict.fromkeys(normalized)
        )

    @classmethod
    def _normalize_operations(
        cls,
        operations: list[str],
    ) -> list[str]:
        normalized: list[str] = []

        for operation in operations:
            value = operation.strip().lower()

            value = cls.OPERATION_ALIASES.get(
                value,
                value,
            )

            normalized.append(value)

        return list(
            dict.fromkeys(normalized)
        )

    @classmethod
    def _normalize_filter(
        cls,
        filter_value: Any,
    ) -> Any:
        if not isinstance(filter_value, dict):
            return deepcopy(filter_value)

        normalized = deepcopy(
            filter_value
        )

        operator = normalized.get(
            "operator"
        )

        if isinstance(operator, str):
            operator = operator.strip().lower()

            normalized["operator"] = (
                cls.FILTER_OPERATOR_ALIASES.get(
                    operator,
                    operator,
                )
            )

        return normalized

    @classmethod
    def _normalize_requested_metrics(
        cls,
        metrics: list[Any],
    ) -> list[dict[str, Any]]:
        normalized: list[dict[str, Any]] = []

        for metric in metrics:
            if not isinstance(metric, dict):
                raise ValueError(
                    "Each requested metric must be an object."
                )

            item = deepcopy(metric)

            operation = item.get(
                "operation"
            )

            if isinstance(operation, str):
                operation = operation.strip().lower()
                item["operation"] = (
                    cls.OPERATION_ALIASES.get(
                        operation,
                        operation,
                    )
                )

            source_id = item.get(
                "source_id"
            )

            if source_id is not None:
                if (
                    not isinstance(source_id, str)
                    or not source_id.strip()
                ):
                    raise ValueError(
                        "requested_metrics source_id must "
                        "be a non-empty string."
                    )

                item["source_id"] = (
                    source_id.strip().lower()
                )

            normalized.append(item)

        return normalized

    @staticmethod
    def _unique_strings(
        values: list[str],
    ) -> list[str]:
        return list(
            dict.fromkeys(
                item.strip()
                for item in values
            )
        )

    def normalized_filters(
        self,
    ) -> list[Any]:
        """
        Return filters in deterministic canonical operator form.

        The stored contract remains independent from SQL syntax generation.
        """

        return [
            self._normalize_filter(value)
            for value in self.filters
        ]

    def to_dict(
        self,
    ) -> dict[str, Any]:
        """
        Convert the contract to an isolated plain dictionary.

        Deep copies prevent downstream SQL generation/execution code from
        mutating the planner's semantic representation.
        """

        return {
            "question": self.question,
            "source_id": self.source_id,
            "data_sources": list(
                self.data_sources
            ),
            "postgresql_sources": list(
                self.postgresql_sources
            ),
            "required_tables": list(
                self.required_tables
            ),
            "required_columns": list(
                self.required_columns
            ),
            "relationships": deepcopy(
                self.relationships
            ),
            "filters": self.normalized_filters(),
            "operations": list(
                self.operations
            ),
            "grouping": list(
                self.grouping
            ),
            "sorting": deepcopy(
                self.sorting
            ),
            "limit": self.limit,
            "entities": deepcopy(
                self.entities
            ),
            "needs_conversation_context": (
                self.needs_conversation_context
            ),
            "requested_metrics": deepcopy(
                self.requested_metrics
            ),
        }

    @classmethod
    def from_plan(
        cls,
        plan: dict[str, Any],
        source_id: str | None = None,
    ) -> "RetrievalContract":
        """
        Build a source-local retrieval contract from a validated
        question plan.

        `source_id` is optional for backward compatibility.

        The caller remains responsible for QuestionPlanValidator validation
        before invoking this method.
        """

        if not isinstance(plan, dict):
            raise ValueError(
                "Question plan must be a dictionary."
            )

        resolved_source_id = source_id

        if resolved_source_id is None:
            candidate = plan.get(
                "source_id"
            )

            if isinstance(candidate, str):
                resolved_source_id = candidate

        return cls(
            question=plan.get(
                "question",
                "",
            ),
            source_id=resolved_source_id,
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
            requested_metrics=plan.get(
                "requested_metrics",
                [],
            ),
        )


def create_retrieval_contract(
    validated_plan: dict[str, Any],
    source_id: str | None = None,
) -> RetrievalContract:
    """
    Create a source-local retrieval contract from a plan that has already
    passed deterministic validation.

    For multi-step execution, callers should pass the QueryStep's concrete
    source_id.

    Runtime InputBinding values must not be placed into this contract.
    """

    if not isinstance(validated_plan, dict):
        raise ValueError(
            "Validated question plan must be a dictionary."
        )

    return RetrievalContract.from_plan(
        validated_plan,
        source_id=source_id,
    )