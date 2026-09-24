from __future__ import annotations

import re


def extract_entity_search_text(question: str) -> str | None:
    """
    Extract a likely entity reference from a natural-language question.

    This utility is intentionally schema-independent.

    It does not contain:
    - table names
    - column names
    - entity names
    - database-specific logic

    The extracted value is only a search candidate.
    Entity type and source must be resolved later using
    discovered Context Layer metadata and/or conversation context.
    """
    if not question or not question.strip():
        return None

    text = question.strip()

    # Prefer explicitly quoted values.
    quoted = re.findall(
        r"""["']([^"']+)["']""",
        text,
    )

    if quoted:
        value = quoted[-1].strip()
        return value or None

    # Detect identifier-like values such as:
    # ABC-123
    # TKT-MU2JXPTA-WXL
    # dag-gidv-bvj
    identifier_matches = re.findall(
        r"\b[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\b",
        text,
    )

    if identifier_matches:
        return identifier_matches[-1]

    # Detect standalone numeric identifiers.
    numeric_matches = re.findall(
        r"\b\d+\b",
        text,
    )

    if numeric_matches:
        return numeric_matches[-1]

    return None

