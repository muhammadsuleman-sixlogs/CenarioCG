from context.context_store import load_context
from planning.question_plan_validator import QuestionPlanValidator


def test_valid_plan():
    context = load_context()

    table_names = list(
        context.get("tables", {}).keys()
    )

    assert table_names

    test_table = table_names[0]

    columns = context["tables"][test_table].get(
        "columns",
        [],
    )

    assert columns

    test_column = columns[0]["name"]

    plan = {
        "question": "Test question",
        "required_tables": [
            test_table
        ],
        "required_columns": [
            f"{test_table}.{test_column}"
        ],
        "relationships": [],
        "operations": [
            "lookup"
        ],
        "filters": [],
        "confidence": 1.0,
    }

    validator = QuestionPlanValidator(context)

    result = validator.validate(plan)

    assert result["valid"] is True
    assert result["errors"] == []

    print("Valid question plan passed.")


def test_unknown_table_rejected():

    plan = {
        "question": "Test question",
        "required_tables": [
            "TABLE_THAT_DOES_NOT_EXIST"
        ],
        "required_columns": [],
        "relationships": [],
        "operations": [],
        "filters": [],
        "confidence": 1.0,
    }

    validator = QuestionPlanValidator()

    result = validator.validate(plan)

    assert result["valid"] is False
    assert any(
        "Unknown table" in error
        for error in result["errors"]
    )

    print("Unknown table rejection passed.")


def test_unknown_column_rejected():

    context = load_context()

    table_names = list(
        context.get("tables", {}).keys()
    )

    assert table_names

    test_table = table_names[0]

    plan = {
        "question": "Test question",
        "required_tables": [
            test_table
        ],
        "required_columns": [
            f"{test_table}.COLUMN_THAT_DOES_NOT_EXIST"
        ],
        "relationships": [],
        "operations": [],
        "filters": [],
        "confidence": 1.0,
    }

    validator = QuestionPlanValidator(context)

    result = validator.validate(plan)

    assert result["valid"] is False
    assert any(
        "Unknown column" in error
        for error in result["errors"]
    )

    print("Unknown column rejection passed.")


if __name__ == "__main__":
    test_valid_plan()
    test_unknown_table_rejected()
    test_unknown_column_rejected()

    print(
        "All question plan validator tests passed."
    )