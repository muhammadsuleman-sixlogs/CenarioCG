from typing import Any

from database.connection import get_connection
from database.readonly_guard import validate_read_only_query


class RetrievalExecutor:
    """
    Execute validated read-only SQL against PostgreSQL.

    This class contains no INSERT, UPDATE, DELETE, or schema-changing
    operations.
    """

    def execute(self, query: str) -> dict[str, Any]:
        """
        Execute one read-only SQL query and return rows plus provenance.
        """

        # Defense in depth:
        # validate immediately before database execution.
        validate_read_only_query(query)

        connection = get_connection()

        try:
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
                        "source": "postgresql",
                    },
                }

        finally:
            connection.close()


def execute_retrieval(query: str) -> dict[str, Any]:
    """
    Convenience function for read-only retrieval.
    """

    executor = RetrievalExecutor()

    return executor.execute(query)