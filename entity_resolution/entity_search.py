from __future__ import annotations

import re


MAX_SEARCH_TEXT_LENGTH = 256


QUOTED_VALUE_PATTERN = re.compile(
    r"""["']([^"']+)["']"""
)

EMAIL_PATTERN = re.compile(
    r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"
)

IDENTIFIER_PATTERN = re.compile(
    r"\b[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\b"
)

EXPLICIT_NUMERIC_IDENTIFIER_PATTERN = re.compile(
    r"\b(?:id|identifier|code|reference|number|key)"
    r"\s*(?:is|=|:)?\s*(\d+)\b",
    re.IGNORECASE,
)


def extract_entity_search_text(
    question: str,
) -> str | None:
    """
    Extract an explicit entity reference from a natural-language question.

    This function intentionally does NOT try to identify arbitrary names
    such as "Umar daraz". Free-form semantic interpretation belongs to
    QuestionPlanner.

    Supported explicit forms:
        "ABC-123"
        "TKT-001-XYZ"
        "user@example.com"
        "ID 123"
        'project "ABC-123"'

    Returned text is only a search candidate. It is not an entity identity.
    """

    if (
        not isinstance(
            question,
            str,
        )
        or not question.strip()
    ):
        return None

    text = question.strip()

    if len(text) > MAX_SEARCH_TEXT_LENGTH:
        text = text[:MAX_SEARCH_TEXT_LENGTH]

    # Explicitly quoted values.
    quoted = QUOTED_VALUE_PATTERN.findall(
        text
    )

    if quoted:
        value = quoted[-1].strip()
        if value:
            return value

    # Email addresses.
    email_matches = EMAIL_PATTERN.findall(
        text
    )

    if email_matches:
        return email_matches[-1].strip()

    # Identifier-like values.
    identifier_matches = IDENTIFIER_PATTERN.findall(
        text
    )

    if identifier_matches:
        return identifier_matches[-1].strip()

    # Numeric values are considered entities only when the question
    # explicitly identifies them as an ID/code/reference/etc.
    numeric_matches = (
        EXPLICIT_NUMERIC_IDENTIFIER_PATTERN.findall(
            text
        )
    )

    if numeric_matches:
        return numeric_matches[-1].strip()

    return None