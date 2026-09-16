import re


def extract_entity_search_text(question: str) -> str | None:
    """
    Extract a likely entity reference from a natural-language question.

    This utility is intentionally schema-independent and does not
    contain table names, entity names, or database-specific logic.
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
        return quoted[-1].strip()

    # Detect identifier-like values such as:
    # ABC-123, TKT-MU2JXPTA-WXLJ, 106, etc.
    identifier_matches = re.findall(
        r"\b[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\b",
        text,
    )

    if identifier_matches:
        return identifier_matches[-1]

    return None