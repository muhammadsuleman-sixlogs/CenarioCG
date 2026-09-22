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
    Execute validated read-only PostgreSQL retrieval queries.

    This is the final security boundary before SQL reaches
    PostgreSQL.

    Both the read-only policy and SQL-level sensitive-data
    validation are enforced immediately before execution.
    """

    CONNECTIONS = {
        "db1": get_connection,
        "db2": get_db2_connection,
    }

    def execute(
        self,
        query: str,
        source_id: str = "db1",
    ) -> dict[str, Any]:

        if not isinstance(source_id, str) or not source_id.strip():
            raise ValueError(
                "source_id must be a non-empty string."
            )

        source_id = source_id.strip().lower()

        if source_id not in self.CONNECTIONS:
            raise ValueError(
                f"Unsupported PostgreSQL source: {source_id}"
            )

        # ---------------------------------------------------------
        # FINAL SECURITY VALIDATION
        # ---------------------------------------------------------
        #
        # These checks happen immediately before obtaining a
        # database connection and executing SQL.
        #
        # 1. Only read-only SQL is allowed.
        # 2. SQL must be syntactically valid.
        # 3. Sensitive/credential fields are rejected.
        #
        validate_read_only_query(query)
        validate_sql_syntax(query)
        

        connection_factory = self.CONNECTIONS[source_id]
        connection = connection_factory()

        try:
            # PostgreSQL session-level read-only protection.
            connection.set_session(readonly=True)

            with connection.cursor() as cursor:
                cursor.execute(query)

                rows = cursor.fetchall()

                column_names = [
                    description[0]
                    for description in cursor.description
                ]

                result_rows = [
                    dict(zip(column_names, row))
                    for row in rows
                ]

                return {
                    "rows": result_rows,
                    "row_count": len(result_rows),
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


def execute_retrieval(
    query: str,
    source_id: str = "db1",
) -> dict[str, Any]:
    """
    Convenience wrapper for read-only retrieval.
    """

    executor = RetrievalExecutor()

    return executor.execute(
        query=query,
        source_id=source_id,
    )