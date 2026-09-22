from context.business_logic_store import (
    save_business_relationships,
    load_business_relationships,
)


def test_business_logic_store():
    db1_relationships = [
        {
            "source_table": "test_source_a",
            "target_table": "test_target_a",
            "business_relationship": "test relationship",
            "reason": "test",
            "evidence": ["test evidence"],
            "confidence": 0.99,
        }
    ]

    db2_relationships = [
        {
            "source_table": "test_source_b",
            "target_table": "test_target_b",
            "business_relationship": "test relationship",
            "reason": "test",
            "evidence": ["test evidence"],
            "confidence": 0.98,
        }
    ]

    save_business_relationships(
        db1_relationships,
        source_id="test_db1",
    )

    save_business_relationships(
        db2_relationships,
        source_id="test_db2",
    )

    loaded_db1 = load_business_relationships(
        source_id="test_db1"
    )

    loaded_db2 = load_business_relationships(
        source_id="test_db2"
    )

    assert len(loaded_db1) == 1
    assert len(loaded_db2) == 1

    assert loaded_db1[0]["source_id"] == "test_db1"
    assert loaded_db2[0]["source_id"] == "test_db2"

    print("Business logic store test passed.")


if __name__ == "__main__":
    test_business_logic_store()