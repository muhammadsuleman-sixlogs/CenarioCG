from __future__ import annotations

from typing import Any


def normalize_entity_candidates(
    candidates: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """
    Normalize EntityResolver output into the standard Context Layer
    conversational-entity representation.

    This function:
        - preserves source provenance
        - preserves the discovered table/column
        - preserves match evidence
        - clamps invalid confidence values
        - removes duplicate candidates

    It does not:
        - query PostgreSQL
        - infer entity identity
        - invent identifiers
        - select a winner
    """

    if not isinstance(
        candidates,
        list,
    ):
        raise ValueError(
            "Entity candidates must be a list."
        )

    normalized: list[
        dict[str, Any]
    ] = []

    seen: set[
        tuple[str, str, str, str]
    ] = set()

    for candidate in candidates:
        if not isinstance(
            candidate,
            dict,
        ):
            continue

        entity_id = candidate.get(
            "value"
        )
        entity_type = candidate.get(
            "entity_type"
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

        source_id = candidate.get(
            "source_id"
        )

        if (
            not isinstance(
                source_id,
                str,
            )
            or not source_id.strip()
        ):
            source_id = None
        else:
            source_id = source_id.strip().lower()

        entity_table = candidate.get(
            "entity_table"
        )

        if (
            not isinstance(
                entity_table,
                str,
            )
            or not entity_table.strip()
        ):
            entity_table = None
        else:
            entity_table = entity_table.strip()

        entity_column = candidate.get(
            "entity_column"
        )

        if (
            not isinstance(
                entity_column,
                str,
            )
            or not entity_column.strip()
        ):
            entity_column = None
        else:
            entity_column = entity_column.strip()

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
            confidence = 0.0

        confidence = max(
            0.0,
            min(
                1.0,
                confidence,
            ),
        )

        normalized_id = str(
            entity_id
        ).strip()

        normalized_type = (
            entity_type.strip()
        )

        dedupe_key = (
            source_id or "",
            normalized_type.lower(),
            entity_table.lower()
            if entity_table
            else "",
            normalized_id.lower(),
        )

        if dedupe_key in seen:
            continue

        seen.add(
            dedupe_key
        )

        normalized.append(
            {
                "type": normalized_type,
                "id": normalized_id,
                "source_id": source_id,
                "entity_table": entity_table,
                "entity_column": entity_column,
                "confidence": confidence,
                "evidence": candidate.get(
                    "evidence"
                ),
                "match_type": candidate.get(
                    "match_type"
                ),
                "context_role": "entity_reference",
            }
        )

    normalized.sort(
        key=lambda item: (
            -float(
                item.get(
                    "confidence",
                    0.0,
                )
            ),
            str(
                item.get(
                    "source_id"
                    or "",
                )
            ),
            str(
                item.get(
                    "entity_table"
                    or "",
                )
            ),
            str(
                item.get(
                    "entity_column"
                    or "",
                )
            ),
            str(
                item.get(
                    "id",
                    "",
                )
            ),
        )
    )

    return normalized