from entity_resolution.entity_normalizer import (
    normalize_entity_candidates,
)


def test_normalize_entity_candidates():
    candidates = [
        {
            "entity_type": "tickets",
            "entity_table": "tickets",
            "entity_column": "reference_id",
            "value": "TKT-MU2JXPTA-WXLJ",
            "confidence": 1.0,
            "match_type": "exact",
            "evidence": "tickets.reference_id",
        }
    ]

    result = normalize_entity_candidates(candidates)

    assert result == [
        {
            "type": "tickets",
            "id": "TKT-MU2JXPTA-WXLJ",
            "confidence": 1.0,
            "evidence": "tickets.reference_id",
            "match_type": "exact",
        }
    ]

    print("Entity normalization passed.")


def test_invalid_candidates_are_skipped():
    candidates = [
        {
            "entity_type": "tickets",
            "value": None,
        },
        {
            "entity_type": None,
            "value": "TKT-123",
        },
        {},
    ]

    result = normalize_entity_candidates(candidates)

    assert result == []

    print("Invalid candidate handling passed.")


if __name__ == "__main__":
    test_normalize_entity_candidates()
    test_invalid_candidates_are_skipped()

    print("All entity normalizer tests passed.")