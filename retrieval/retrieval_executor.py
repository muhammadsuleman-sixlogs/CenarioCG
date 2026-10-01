from __future__ import annotations

from typing import Any

from database.connection import (
    get_connection,
    get_db2_connection,
)
from database.readonly_guard import (
    validate_read_only_query,
)
from retrieval.sql_validator import (
    validate_sql_syntax,
)


class RetrievalExecutor:
    """
    Final PostgreSQL execution boundary.

    Responsibilities:
        - validate source selection
        - validate read-only SQL
        - execute parameterized SQL
        - protect the PostgreSQL session as read-only
        - return source-preserved retrieval results

    This class does NOT:
        - generate SQL
        - call an LLM
        - modify database data/schema
        - convert execution failures into empty results

    PostgreSQL remains strictly READ-ONLY.
    """

    CONNECTIONS = {
        "db1": get_connection,
        "db2": get_db2_connection,
    }

    MAX_ROWS_RETURNED = 50_000
    FETCH_BATCH_SIZE = 1_000

    def execute(
        self,
        query: str,
        source_id: str = "db1",
        parameters: list[Any] | tuple[Any, ...] | None = None,
    ) -> dict[str, Any]:
        """
        Execute one validated read-only PostgreSQL query.

        Parameter values are passed separately from SQL.

        If the query produces more than MAX_ROWS_RETURNED rows, execution
        fails rather than silently truncating the result.
        """

        source_id = self._validate_source(
            source_id
        )

        query = self._validate_query(
            query
        )

        normalized_parameters = (
            self._normalize_parameters(
                parameters
            )
        )

        connection_factory = self.CONNECTIONS[
            source_id
        ]

        connection = connection_factory()

        try:
            connection.set_session(
                readonly=True
            )

            with connection.cursor() as cursor:
                cursor.arraysize = (
                    self.FETCH_BATCH_SIZE
                )

                cursor.execute(
                    query,
                    normalized_parameters,
                )

                description = cursor.description

                if description is None:
                    raise ValueError(
                        "Read-only retrieval query returned no result "
                        "description."
                    )

                column_names = [
                    description_item[0]
                    for description_item in description
                ]

                rows = self._fetch_rows(
                    cursor
                )

                result_rows = [
                    dict(
                        zip(
                            column_names,
                            row,
                        )
                    )
                    for row in rows
                ]

                row_count = len(
                    result_rows
                )

                retrieval_status = (
                    "success_with_data"
                    if row_count > 0
                    else "success_empty"
                )

                return {
                    "retrieval_status": retrieval_status,
                    "rows": result_rows,
                    "row_count": row_count,
                    "columns": column_names,
                    "provenance": {
                        "query": query,
                        "source_type": "postgresql",
                        "source_id": source_id,
                        "source": source_id,
                    },
                }

        finally:
            connection.close()

    @classmethod
    def _validate_source(
        cls,
        source_id: str,
    ) -> str:
        if (
            not isinstance(
                source_id,
                str,
            )
            or not source_id.strip()
        ):
            raise ValueError(
                "source_id must be a non-empty string."
            )

        normalized = (
            source_id.strip().lower()
        )

        if normalized not in cls.CONNECTIONS:
            raise ValueError(
                f"Unsupported PostgreSQL source: {normalized}"
            )

        return normalized

    @staticmethod
    def _validate_query(
        query: str,
    ) -> str:
        if (
            not isinstance(
                query,
                str,
            )
            or not query.strip()
        ):
            raise ValueError(
                "query must be a non-empty string."
            )

        normalized = query.strip()

        validate_read_only_query(
            normalized
        )

        validate_sql_syntax(
            normalized
        )

        return normalized

    @staticmethod
    def _normalize_parameters(
        parameters: list[Any] | tuple[Any, ...] | None,
    ) -> list[Any]:
        if parameters is None:
            return []

        if not isinstance(
            parameters,
            (list, tuple),
        ):
            raise ValueError(
                "PostgreSQL parameters must be a list or tuple."
            )

        return list(parameters)

    def _fetch_rows(
        self,
        cursor: Any,
    ) -> list[tuple[Any, ...]]:
        """
        Fetch in bounded batches.

        We deliberately detect overflow rather than returning a partial
        result. Partial data would violate the authoritative-answer rule.
        """

        rows: list[tuple[Any, ...]] = []

        while True:
            remaining = (
                self.MAX_ROWS_RETURNED
                + 1
                - len(rows)
            )

            if remaining <= 0:
                raise ValueError(
                    "Retrieval exceeded the maximum allowed result size."
                )

            batch_size = min(
                self.FETCH_BATCH_SIZE,
                remaining,
            )

            batch = cursor.fetchmany(
                batch_size
            )

            if not batch:
                break

            rows.extend(
                batch
            )

            if len(rows) > self.MAX_ROWS_RETURNED:
                raise ValueError(
                    "Retrieval exceeded the maximum allowed result "
                    f"size of {self.MAX_ROWS_RETURNED} rows."
                )

            if len(batch) < batch_size:
                break

        return rows


def execute_retrieval(
    query: str,
    source_id: str = "db1",
    parameters: list[Any] | tuple[Any, ...] | None = None,
) -> dict[str, Any]:
    """
    Convenience wrapper for read-only PostgreSQL retrieval.
    """

    executor = RetrievalExecutor()

    return executor.execute(
        query=query,
        source_id=source_id,
        parameters=parameters,
    )