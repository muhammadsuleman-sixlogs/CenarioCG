from __future__ import annotations

from copy import deepcopy
from typing import Any

from security.output_security_policy import (
    sanitize_output_text,
)
from security.sensitive_data_policy import (
    is_sensitive_field_name,
)


"""
Evidence security layer for the Context Layer.

Purpose:
- Protect retrieved evidence before it reaches the LLM.
- Protect retrieved evidence before it is returned by the API.
- Remove sensitive PostgreSQL fields from retrieved rows.
- Redact credential-like values inside security-log payloads.
- Preserve normal business data and provenance.

This module does not access or modify any database.
"""


def _sanitize_postgresql_rows(
    rows: Any,
) -> list[dict[str, Any]]:
    """
    Remove sensitive fields from PostgreSQL result rows.

    The SQL layer already blocks sensitive field references.
    This is an additional defense in depth in case a protected
    value reaches the evidence layer unexpectedly.
    """

    if not isinstance(rows, list):
        return []

    sanitized_rows: list[dict[str, Any]] = []

    for row in rows:
        if not isinstance(row, dict):
            continue

        sanitized_row: dict[str, Any] = {}

        for column_name, value in row.items():

            if is_sensitive_field_name(column_name):
                continue

            sanitized_row[column_name] = _sanitize_value(
                value
            )

        sanitized_rows.append(sanitized_row)

    return sanitized_rows


def _sanitize_value(
    value: Any,
) -> Any:
    """
    Recursively sanitize arbitrary retrieved values.

    Strings are passed through the credential-value redaction
    policy.

    Dictionaries and lists are recursively sanitized.

    Other primitive values are preserved unchanged.
    """

    if isinstance(value, str):
        return sanitize_output_text(value)

    if isinstance(value, dict):
        return {
            key: _sanitize_value(item)
            for key, item in value.items()
        }

    if isinstance(value, list):
        return [
            _sanitize_value(item)
            for item in value
        ]

    if isinstance(value, tuple):
        return tuple(
            _sanitize_value(item)
            for item in value
        )

    return value


def sanitize_postgresql_retrieval(
    retrieval: Any,
) -> dict[str, Any]:
    """
    Sanitize a PostgreSQL retrieval result.

    Sensitive result columns are removed from rows.

    Provenance and metadata are preserved.
    """

    if not isinstance(retrieval, dict):
        return {}

    sanitized = deepcopy(retrieval)

    if "rows" in sanitized:
        sanitized["rows"] = _sanitize_postgresql_rows(
            sanitized["rows"]
        )

    if "columns" in sanitized:
        columns = sanitized["columns"]

        if isinstance(columns, list):
            sanitized["columns"] = [
                column
                for column in columns
                if not is_sensitive_field_name(column)
            ]

    sanitized = _sanitize_value(sanitized)

    return sanitized


def sanitize_security_logs_retrieval(
    retrieval: Any,
) -> dict[str, Any]:
    """
    Sanitize security/SIEM retrieval data.

    Security events may contain credentials or secrets inside
    arbitrary message fields, so recursive value sanitization
    is required.

    The structure and provenance are preserved.
    """

    if not isinstance(retrieval, dict):
        return {}

    sanitized = deepcopy(retrieval)

    return _sanitize_value(sanitized)


def sanitize_evidence(
    evidence: Any,
) -> dict[str, Any]:
    """
    Sanitize the complete evidence object before it is supplied
    to the LLM or returned through the API.

    PostgreSQL retrievals receive field-level protection.

    Security-log retrievals receive recursive value-level
    protection.

    Unknown evidence structures are recursively sanitized
    without being discarded.
    """

    if not isinstance(evidence, dict):
        return {}

    sanitized = deepcopy(evidence)

    postgresql_retrieval = sanitized.get(
        "postgresql_retrieval"
    )

    if isinstance(postgresql_retrieval, dict):
        sanitized["postgresql_retrieval"] = (
            sanitize_postgresql_retrieval(
                postgresql_retrieval
            )
        )

    postgresql_retrievals = sanitized.get(
        "postgresql_retrievals"
    )

    if isinstance(postgresql_retrievals, dict):
        sanitized["postgresql_retrievals"] = {
            source_id: sanitize_postgresql_retrieval(
                retrieval
            )
            for source_id, retrieval
            in postgresql_retrievals.items()
        }

    security_logs_retrieval = sanitized.get(
        "security_logs_retrieval"
    )

    if isinstance(security_logs_retrieval, dict):
        sanitized["security_logs_retrieval"] = (
            sanitize_security_logs_retrieval(
                security_logs_retrieval
            )
        )

    return _sanitize_value(sanitized)


def sanitize_api_response(
    response: Any,
) -> dict[str, Any]:
    """
    Final security boundary for the API response.

    This ensures that raw evidence and retrieval payloads
    cannot bypass the evidence-security layer.
    """

    if not isinstance(response, dict):
        return {}

    sanitized = deepcopy(response)

    if "evidence" in sanitized:
        sanitized["evidence"] = sanitize_evidence(
            sanitized["evidence"]
        )

    if "postgresql_retrieval" in sanitized:
        sanitized["postgresql_retrieval"] = (
            sanitize_postgresql_retrieval(
                sanitized["postgresql_retrieval"]
            )
        )

    if "postgresql_retrievals" in sanitized:
        retrievals = sanitized["postgresql_retrievals"]

        if isinstance(retrievals, dict):
            sanitized["postgresql_retrievals"] = {
                source_id: sanitize_postgresql_retrieval(
                    retrieval
                )
                for source_id, retrieval
                in retrievals.items()
            }

    if "security_logs_retrieval" in sanitized:
        sanitized["security_logs_retrieval"] = (
            sanitize_security_logs_retrieval(
                sanitized["security_logs_retrieval"]
            )
        )

    return _sanitize_value(sanitized)
