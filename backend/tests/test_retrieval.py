from context.context_store import load_context
from planning.question_plan_validator import (
    QuestionPlanValidator,
)
from retrieval.retrieval_contract import (
    create_retrieval_contract,
)


def build_validated_plan():

    context = load_context()

    tables = list(
        context.get("tables", {}).keys()
    )

    assert tables

    test_table = tables[0]

    columns = context["tables"][test_table].get(
        "columns",
        [],
    )

    assert columns

    test_column = columns[0]["name"]

    plan = {
        "question": "Test retrieval question",
        "required_tables": [
            test_table
        ],
        "required_columns": [
            f"{test_table}.{test_column}"
        ],
        "relationships": [],
        "filters": [],
        "operations": [
            "lookup"
        ],
        "grouping": [],
        "sorting": [],
        "limit": 10,
        "entities": [],
        "needs_conversation_context": False,
    }

    validator = QuestionPlanValidator(context)

    return validator.validate(plan)


def test_contract_creation():

    validated_plan = build_validated_plan()

    assert validated_plan["valid"] is True

    contract = create_retrieval_contract(
        validated_plan
    )

    result = contract.to_dict()

    assert result["question"] == (
        "Test retrieval question"
    )

    assert len(result["required_tables"]) == 1
    assert len(result["required_columns"]) == 1

    assert result["operations"] == [
        "lookup"
    ]

    assert result["limit"] == 10

    print("Retrieval contract creation passed.")


def test_invalid_plan_rejected():

    invalid_plan = {
        "valid": False,
        "errors": [
            "Unknown table"
        ],
        "plan": {
            "question": "Invalid question"
        },
    }

    try:
        create_retrieval_contract(
            invalid_plan
        )
    except ValueError:
        print(
            "Invalid plan rejection passed."
        )
        return

    raise AssertionError(
        "Invalid plan was not rejected."
    )


def test_contract_preserves_dynamic_schema():

    validated_plan = build_validated_plan()

    contract = create_retrieval_contract(
        validated_plan
    )

    context = load_context()

    expected_table = list(
        context["tables"].keys()
    )[0]

    expected_column = context[
        "tables"
    ][expected_table]["columns"][0]["name"]

    assert (
        contract.required_tables[0]
        == expected_table
    )

    assert (
        contract.required_columns[0]
        == f"{expected_table}.{expected_column}"
    )

    print(
        "Dynamic schema preservation passed."
    )


if __name__ == "__main__":

    test_contract_creation()
    test_invalid_plan_rejected()
    test_contract_preserves_dynamic_schema()

    print(
        "All retrieval contract tests passed."
    )