from __future__ import annotations

import re
from typing import Any


"""
Centralized sensitive-data policy for the Context Layer.

Purpose:
- Prevent credential/sensitive fields from being exposed to LLM prompts.
- Prevent retrieval plans from referencing protected fields.
- Provide reusable checks for downstream SQL validation.

This policy is generic and does not contain company-specific
table names, column names, entities, or business relationships.
"""


# Generic sensitive/credential field patterns.
#
# These patterns intentionally focus on credential-like fields.
# They are matched against the complete column name.
SENSITIVE_FIELD_PATTERNS = (
    r"^password$",
    r"^passwd$",
    r"^passcode$",
    r"^secret$",
    r".*_secret$",
    r"^api[_-]?key$",
    r".*_api[_-]?key$",
    r"^access[_-]?token$",
    r".*_access[_-]?token$",
    r"^refresh[_-]?token$",
    r".*_refresh[_-]?token$",
    r"^auth[_-]?token$",
    r".*_auth[_-]?token$",
    r"^bearer[_-]?token$",
    r".*_bearer[_-]?token$",
    r"^private[_-]?key$",
    r".*_private[_-]?key$",
    r"^client[_-]?secret$",
    r".*_client[_-]?secret$",
    r".*credential.*",
)


_COMPILED_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in SENSITIVE_FIELD_PATTERNS
)


def is_sensitive_field_name(field_name: Any) -> bool:
    """
    Return True when a field/column name matches a generic
    sensitive-data or credential pattern.

    Examples:
        password       -> True
        api_key        -> True
        access_token   -> True
        client_secret  -> True
        username       -> False
        email          -> False
    """

    if not isinstance(field_name, str):
        return False

    normalized = field_name.strip()

    if not normalized:
        return False

    return any(
        pattern.fullmatch(normalized)
        for pattern in _COMPILED_PATTERNS
    )


def is_sensitive_field_reference(field_reference: Any) -> bool:
    """
    Return True when a table.column reference points to a
    sensitive field.

    Expected format:
        table.column

    Examples:
        users.password       -> True
        accounts.api_key     -> True
        users.email          -> False
    """

    if not isinstance(field_reference, str):
        return False

    normalized = field_reference.strip()

    if not normalized:
        return False

    parts = normalized.split(".", 1)

    if len(parts) != 2:
        return False

    table_name, column_name = parts

    if not table_name.strip() or not column_name.strip():
        return False

    return is_sensitive_field_name(column_name)


def validate_not_sensitive_field(
    field_reference: str,
) -> None:
    """
    Raise ValueError when a table.column reference points to
    a protected sensitive field.

    This is intended for retrieval-plan validation and other
    pre-retrieval checks.
    """

    if is_sensitive_field_reference(field_reference):
        raise ValueError(
            "Access to sensitive or credential fields is not permitted."
        )


def filter_sensitive_columns(
    columns: list[Any],
) -> list[Any]:
    """
    Remove sensitive columns from a discovered column collection.

    This is intended for LLM-facing schema/context construction.

    The original Context Layer is not modified. A new list is returned.
    """

    if not isinstance(columns, list):
        return []

    filtered_columns: list[Any] = []

    for column in columns:
        if not isinstance(column, dict):
            continue

        column_name = column.get("name")

        if is_sensitive_field_name(column_name):
            continue

        filtered_columns.append(column)

    return filtered_columns


def sanitize_schema_context(
    schema_context: dict[str, Any],
) -> dict[str, Any]:
    """
    Return a copy of schema context with sensitive column definitions
    removed before the context is supplied to an LLM.

    This function does not modify the original context.

    Expected structure:

        {
            "tables": {
                "table_name": {
                    "columns": [...],
                    ...
                }
            },
            ...
        }
    """

    if not isinstance(schema_context, dict):
        return {}

    sanitized = dict(schema_context)

    tables = schema_context.get("tables")

    if not isinstance(tables, dict):
        return sanitized

    sanitized_tables: dict[str, Any] = {}

    for table_name, table_info in tables.items():
        if not isinstance(table_info, dict):
            continue

        sanitized_table = dict(table_info)

        columns = table_info.get("columns", [])

        sanitized_table["columns"] = filter_sensitive_columns(
            columns
        )

        sanitized_tables[table_name] = sanitized_table

    sanitized["tables"] = sanitized_tables

    return sanitized