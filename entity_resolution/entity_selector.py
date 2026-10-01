from __future__ import annotations

from typing import Any


DEFAULT_MIN_CONFIDENCE = 0.90
DEFAULT_AMBIGUITY_MARGIN = 0.05


def select_entity(
    candidates: list[dict[str, Any]],
    min_confidence: float = DEFAULT_MIN_CONFIDENCE,
    ambiguity_margin: float = DEFAULT_AMBIGUITY_MARGIN,
) -> dict[str, Any] | None:
    """
    Select one unambiguous entity candidate.

    An entity is selected only when:
        - required identity fields are present
        - confidence meets the threshold
        - a competing candidate is not sufficiently close
        - the competing candidate does not represent the same resolved
          source/type/table identity

    When ambiguity remains, return None rather than guessing.
    """

    if not isinstance(
        candidates,
        list,
    ):
        raise ValueError(
            "Entity candidates must be a list."
        )

    if not (
        0.0
        <= float(min_confidence)
        <= 1.0
    ):
        raise ValueError(
            "min_confidence must be between 0 and 1."
        )

    if float(ambiguity_margin) < 0:
        raise ValueError(
            "ambiguity_margin cannot be negative."
        )

    valid_candidates = []

    for candidate in candidates:
        if not isinstance(
            candidate,
            dict,
        ):
            continue

        try:
            confidence = float(
                candidate.get(
                    "confidence",
                    0.0,
                )
            )
        except (
            TypeError,
            ValueError,
        ):
            continue

        if confidence < min_confidence:
            continue

        entity_id = candidate.get(
            "id"
        )
        entity_type = candidate.get(
            "type"
        )

        if (
            entity_id is None
            or not str(entity_id).strip()
            or not isinstance(
                entity_type,
                str,
            )
            or not entity_type.strip()
        ):
            continue

        valid_candidates.append(
            candidate
        )

    if not valid_candidates:
        return None

    valid_candidates.sort(
        key=lambda candidate: (
            -float(
                candidate.get(
                    "confidence",
                    0.0,
                )
            ),
            str(
                candidate.get(
                    "source_id"
                    or "",
                )
            ),
            str(
                candidate.get(
                    "entity_table"
                    or "",
                )
            ),
            str(
                candidate.get(
                    "entity_column"
                    or "",
                )
            ),
            str(
                candidate.get(
                    "id",
                    "",
                )
            ),
        )
    )

    best = valid_candidates[0]

    best_confidence = float(
        best.get(
            "confidence",
            0.0,
        )
    )

    competitors = valid_candidates[1:]

    for competitor in competitors:
        competitor_confidence = float(
            competitor.get(
                "confidence",
                0.0,
            )
        )

        if (
            best_confidence
            - competitor_confidence
            > ambiguity_margin
        ):
            break

        if not _same_entity_reference(
            best,
            competitor,
        ):
            return None

    return dict(
        best
    )


def _same_entity_reference(
    left: dict[str, Any],
    right: dict[str, Any],
) -> bool:
    """
    Determine whether two candidates describe the same discovered entity
    reference rather than merely similar text.
    """

    left_source = str(
        left.get(
            "source_id"
            or "",
        )
    ).lower()

    right_source = str(
        right.get(
            "source_id"
            or "",
        )
    ).lower()

    left_type = str(
        left.get(
            "type"
            or "",
        )
    ).lower()

    right_type = str(
        right.get(
            "type"
            or "",
        )
    ).lower()

    left_table = str(
        left.get(
            "entity_table"
            or "",
        )
    ).lower()

    right_table = str(
        right.get(
            "entity_table"
            or "",
        )
    ).lower()

    left_id = str(
        left.get(
            "id"
            or "",
        )
    ).lower()

    right_id = str(
        right.get(
            "id"
            or "",
        )
    ).lower()

    return (
        left_source == right_source
        and left_type == right_type
        and left_table == right_table
        and left_id == right_id
    )