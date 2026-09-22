from __future__ import annotations

import sqlglot

from sqlglot import exp

from security.sensitive_data_policy import (
    is_sensitive_field_name,
)


def _validate_no_sensitive_fields(
    query: str,
) -> None:
    """
    Inspect the parsed SQL AST and reject references to sensitive
    or credential-related fields.

    This is a defense-in-depth layer.

    It does not modify the SQL and does not access the database.
    """

    try:
        statement = sqlglot.parse_one(
            query,
            read="postgres",
        )

    except Exception as exc:
        raise ValueError(
            f"Unable to inspect SQL for sensitive fields: {exc}"
        ) from exc

    # Inspect actual column references in the SQL AST.
    for column in statement.find_all(
        exp.Column
    ):
        column_name = column.name

        if is_sensitive_field_name(
            column_name
        ):
            table_name = column.table

            if table_name:
                field_reference = (
                    f"{table_name}.{column_name}"
                )
            else:
                field_reference = column_name

            raise ValueError(
                "Access to sensitive or credential fields "
                f"is not permitted: {field_reference}"
            )

    # Reject wildcard projections such as:
    #
    # SELECT *
    # SELECT table.*
    #
    # because they can implicitly retrieve protected columns.
    #
    # COUNT(*) is allowed because it does not retrieve the
    # underlying column values.
    for select in statement.find_all(
        exp.Select
    ):
        for projection in select.expressions:

            if isinstance(
                projection,
                exp.Star,
            ):
                raise ValueError(
                    "Wildcard SELECT projections are not permitted "
                    "because they may retrieve sensitive fields."
                )

            if (
                isinstance(
                    projection,
                    exp.Column,
                )
                and isinstance(
                    projection.this,
                    exp.Star,
                )
            ):
                raise ValueError(
                    "Wildcard SELECT projections are not permitted "
                    "because they may retrieve sensitive fields."
                )


def validate_sql_syntax(
    query: str,
) -> None:
    """
    Validate that SQL is syntactically valid and contains exactly
    one read-only SELECT/WITH statement.

    Also validates that the SQL does not reference sensitive fields.
    """

    if not query or not query.strip():
        raise ValueError(
            "SQL query cannot be empty."
        )

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

    if not isinstance(
        statement,
        (
            exp.Select,
            exp.Union,
            exp.With,
        ),
    ):
        raise ValueError(
            "Only SELECT/WITH queries are allowed."
        )

    # Final SQL-level sensitive-data validation.
    _validate_no_sensitive_fields(
        query
    )
