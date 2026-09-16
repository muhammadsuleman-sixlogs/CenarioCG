from typing import Any


def normalize_entity_candidates(
    candidates: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """
    Convert EntityResolver candidates into the standard
    Context Layer entity representation.

    This function does not query PostgreSQL and does not
    invent entity identifiers.
    """

    normalized: list[dict[str, Any]] = []

    for candidate in candidates:
        entity_id = candidate.get("value")
        entity_type = candidate.get("entity_type")

        if not entity_id or not entity_type:
            continue

        normalized.append(
            {
                "type": entity_type,
                "id": str(entity_id),
                "confidence": candidate.get("confidence", 0.0),
                "evidence": candidate.get("evidence"),
                "match_type": candidate.get("match_type"),
            }
        )

    return normalized