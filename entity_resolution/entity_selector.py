from typing import Any


def select_entity(
    candidates: list[dict[str, Any]],
    min_confidence: float = 0.90,
) -> dict[str, Any] | None:
    """
    Select a single unambiguous entity candidate.

    Returns None when there is no sufficiently confident
    candidate or when the top candidates are ambiguous.
    """

    valid_candidates = [
        candidate
        for candidate in candidates
        if candidate.get("confidence", 0.0) >= min_confidence
        and candidate.get("id")
        and candidate.get("type")
    ]

    if not valid_candidates:
        return None

    valid_candidates.sort(
        key=lambda candidate: candidate["confidence"],
        reverse=True,
    )

    best = valid_candidates[0]

    if len(valid_candidates) == 1:
        return best

    second = valid_candidates[1]

    if best["confidence"] == second["confidence"]:
        return None

    return best