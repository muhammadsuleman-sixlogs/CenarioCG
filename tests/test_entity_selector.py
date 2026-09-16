from entity_resolution.entity_selector import select_entity


def test_select_best_entity():
    candidates = [
        {
            "type": "tickets",
            "id": "TKT-001",
            "confidence": 1.0,
        },
        {
            "type": "tickets",
            "id": "TKT-002",
            "confidence": 0.90,
        },
    ]

    result = select_entity(candidates)

    assert result is not None
    assert result["id"] == "TKT-001"

    print("Best entity selection passed.")


def test_reject_low_confidence():
    candidates = [
        {
            "type": "tickets",
            "id": "TKT-001",
            "confidence": 0.70,
        }
    ]

    result = select_entity(candidates)

    assert result is None

    print("Low-confidence rejection passed.")


def test_reject_ambiguous_candidates():
    candidates = [
        {
            "type": "tickets",
            "id": "TKT-001",
            "confidence": 1.0,
        },
        {
            "type": "tickets",
            "id": "TKT-002",
            "confidence": 1.0,
        },
    ]

    result = select_entity(candidates)

    assert result is None

    print("Ambiguous entity rejection passed.")


def test_empty_candidates():
    result = select_entity([])

    assert result is None

    print("Empty candidate handling passed.")


if __name__ == "__main__":
    test_select_best_entity()
    test_reject_low_confidence()
    test_reject_ambiguous_candidates()
    test_empty_candidates()

    print("All entity selector tests passed.")