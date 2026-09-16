import sqlglot
from sqlglot import exp


def validate_sql_syntax(query: str) -> None:
    """
    Validate that SQL is syntactically valid PostgreSQL.

    This function:
    - does not access PostgreSQL
    - does not modify PostgreSQL
    - does not make API calls
    """

    if not query or not query.strip():
        raise ValueError("SQL query cannot be empty.")

    try:
        statements = sqlglot.parse(
            query,
            read="postgres",
        )
    except Exception as exc:
        raise ValueError(
            f"Invalid SQL syntax: {exc}"
        ) from exc

    if len(statements) != 1:
        raise ValueError(
            "SQL must contain exactly one statement."
        )

    statement = statements[0]

    if not isinstance(statement, (exp.Select, exp.Union, exp.With)):
        raise ValueError(
            "Only SELECT/WITH queries are allowed."
        )