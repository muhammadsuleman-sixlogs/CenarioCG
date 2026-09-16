from context.context_store import load_context

from context.business_logic_validator import (
    get_known_tables,
    get_known_columns,
    validate_relationship,
    validate_relationships,
)


def test_known_schema():
    context = load_context()

    tables = get_known_tables(context)
    columns = get_known_columns(context)

    assert len(tables) > 0
    assert len(columns) > 0

    print(f"Discovered tables: {len(tables)}")
    print("Schema extraction test passed.")


def test_valid_relationship():
    context = load_context()

    tables = list(get_known_tables(context))

    source_table = tables[0]
    target_table = tables[1]

    relationship = {
        "source_table": source_table,
        "target_table": target_table,
        "business_relationship": "TEST_RELATIONSHIP",
        "reason": "Test relationship.",
        "evidence": [
            f"{source_table} and {target_table} "
            "exist in the discovered schema."
        ],
        "confidence": 0.5,
    }

    is_valid, reason = validate_relationship(
        relationship,
        context,
    )

    assert is_valid is True

    print(reason)
    print("Valid relationship test passed.")


def test_unknown_table_rejected():
    context = load_context()

    relationship = {
        "source_table": "TABLE_THAT_DOES_NOT_EXIST",
        "target_table": "ANOTHER_UNKNOWN_TABLE",
        "business_relationship": "INVALID",
        "reason": "This should be rejected.",
        "evidence": [
            "Intentional invalid test."
        ],
        "confidence": 0.9,
    }

    is_valid, reason = validate_relationship(
        relationship,
        context,
    )

    assert is_valid is False

    print(reason)
    print("Unknown table rejection test passed.")


def test_invalid_confidence_rejected():
    context = load_context()

    tables = list(get_known_tables(context))

    relationship = {
        "source_table": tables[0],
        "target_table": tables[1],
        "business_relationship": "INVALID",
        "reason": "Invalid confidence test.",
        "evidence": [
            "Intentional validation test."
        ],
        "confidence": 1.5,
    }

    is_valid, reason = validate_relationship(
        relationship,
        context,
    )

    assert is_valid is False
    assert "confidence" in reason.lower()

    print(reason)
    print("Invalid confidence rejection test passed.")


def test_missing_evidence_rejected():
    context = load_context()

    tables = list(get_known_tables(context))

    relationship = {
        "source_table": tables[0],
        "target_table": tables[1],
        "business_relationship": "INVALID",
        "reason": "Missing evidence test.",
        "evidence": [],
        "confidence": 0.8,
    }

    is_valid, reason = validate_relationship(
        relationship,
        context,
    )

    assert is_valid is False
    assert "evidence" in reason.lower()

    print(reason)
    print("Missing evidence rejection test passed.")


def test_multiple_relationships():
    context = load_context()

    tables = list(get_known_tables(context))

    valid_relationship = {
        "source_table": tables[0],
        "target_table": tables[1],
        "business_relationship": "VALID_TEST",
        "reason": "Valid test.",
        "evidence": [
            "Both tables exist in the discovered schema."
        ],
        "confidence": 0.8,
    }

    invalid_relationship = {
        "source_table": "UNKNOWN_TABLE",
        "target_table": tables[0],
        "business_relationship": "INVALID_TEST",
        "reason": "Invalid test.",
        "evidence": [
            "Intentional invalid test."
        ],
        "confidence": 0.8,
    }

    result = validate_relationships(
        [
            valid_relationship,
            invalid_relationship,
        ],
        context,
    )

    assert len(result["valid"]) == 1
    assert len(result["invalid"]) == 1

    print("Multiple relationship validation test passed.")


if __name__ == "__main__":
    test_known_schema()
    test_valid_relationship()
    test_unknown_table_rejected()
    test_invalid_confidence_rejected()
    test_missing_evidence_rejected()
    test_multiple_relationships()

    print("All business relationship validator tests passed.")