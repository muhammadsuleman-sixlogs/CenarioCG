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
        "data_sources": ["postgresql"],
        "postgresql_sources": ["db1"],
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
        "data_sources": ["postgresql"],
        "postgresql_sources": ["db1"],
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
        "unknown table" in error.lower()
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
        "data_sources": ["postgresql"],
        "postgresql_sources": ["db1"],
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
        "unknown column" in error.lower()
        for error in result["errors"]
    )

    print("Unknown column rejection passed.")


def test_ambiguous_join_key_qualified_from_required_tables():
    """Bare join keys shared by related tables should resolve via table order."""
    contexts = {
        "db1": {
            "tables": {
                "project_details": {
                    "columns": [
                        {"name": "id"},
                        {"name": "project_id_display"},
                        {"name": "project_name"},
                    ]
                }
            },
            "relationships": [],
        },
        "db2": {
            "tables": {
                "projects": {
                    "columns": [
                        {"name": "project_id"},
                        {"name": "project_title"},
                        {"name": "project_code"},
                    ]
                },
                "sessions": {
                    "columns": [
                        {"name": "session_id"},
                        {"name": "project_id"},
                        {"name": "meeting_title"},
                        {"name": "created_at"},
                    ]
                },
            },
            "relationships": [
                {
                    "source_table": "sessions",
                    "source_column": "project_id",
                    "target_table": "projects",
                    "target_column": "project_id",
                    "relationship_type": "FOREIGN_KEY",
                }
            ],
        },
    }

    plan = {
        "question": "Find matched projects with latest meeting title",
        "data_sources": ["postgresql"],
        "postgresql_sources": ["db1", "db2"],
        "required_tables": ["project_details", "projects", "sessions"],
        "required_columns": [
            "project_details.project_id_display",
            "projects.project_title",
            "projects.project_code",
            "sessions.meeting_title",
        ],
        "relationships": [],
        "filters": [],
        "operations": ["lookup", "ranking"],
        "confidence": 0.9,
        "execution_plan": {
            "mode": "multi_step",
            "steps": [
                {
                    "id": "s1",
                    "type": "source_query",
                    "source_id": "db1",
                    "contract": {
                        "question": "Find project keys in DB1",
                        "data_sources": ["postgresql"],
                        "postgresql_sources": ["db1"],
                        "required_tables": ["project_details"],
                        "required_columns": [
                            "project_details.id",
                            "project_details.project_id_display",
                            "project_details.project_name",
                        ],
                        "relationships": [],
                        "filters": [],
                        "operations": ["lookup"],
                        "grouping": [],
                        "sorting": [],
                        "limit": None,
                        "entities": [],
                    },
                    "depends_on": [],
                    "inputs": [],
                    "input_bindings": [],
                    "operator": None,
                    "key_columns": ["id"],
                    "output_columns": [
                        "id",
                        "project_name",
                        "project_id_display",
                    ],
                    "purpose": "Produce DB1 project keys",
                },
                {
                    "id": "s2",
                    "type": "source_query",
                    "source_id": "db2",
                    "contract": {
                        "question": "Retrieve project and meeting fields",
                        "data_sources": ["postgresql"],
                        "postgresql_sources": ["db2"],
                        "required_tables": ["projects", "sessions"],
                        "required_columns": [
                            "project_id",
                            "project_title",
                            "project_code",
                            "meeting_title",
                            "created_at",
                            "session_id",
                            "project_id",
                        ],
                        "relationships": [
                            {
                                "source_table": "sessions",
                                "source_column": "project_id",
                                "target_table": "projects",
                                "target_column": "project_id",
                                "relationship_type": "FOREIGN_KEY",
                                "source_id": "db2",
                            }
                        ],
                        "filters": [],
                        "operations": ["ranking"],
                        "grouping": [
                            "projects.project_id",
                            "projects.project_title",
                            "projects.project_code",
                        ],
                        "sorting": [
                            {
                                "field": "sessions.created_at",
                                "direction": "desc",
                            }
                        ],
                        "limit": None,
                        "entities": [],
                    },
                    "depends_on": ["s1"],
                    "inputs": ["s1"],
                    "input_bindings": [
                        {
                            "from_step": "s1",
                            "from_column": "project_id_display",
                            "to_table": "projects",
                            "to_column": "project_id",
                            "operator": "in",
                        }
                    ],
                    "operator": None,
                    "key_columns": [],
                    "output_columns": [
                        "projects.project_title",
                        "projects.project_code",
                        "sessions.meeting_title",
                        "sessions.created_at",
                        "projects.project_id",
                    ],
                    "purpose": "Retrieve matched project meeting fields",
                },
            ],
            "final_step": "s2",
            "reason": "test",
        },
    }

    validator = QuestionPlanValidator(contexts)
    result = validator.validate(plan)

    assert result["valid"] is True, result["errors"]
    step_columns = result["plan"]["execution_plan"]["steps"][1][
        "required_columns"
    ]
    assert "projects.project_id" in step_columns
    assert "project_id" not in step_columns
    assert step_columns.count("projects.project_id") == 1

    print("Ambiguous join-key qualification passed.")


if __name__ == "__main__":
    test_valid_plan()
    test_unknown_table_rejected()
    test_unknown_column_rejected()
    test_ambiguous_join_key_qualified_from_required_tables()

    print(
        "All question plan validator tests passed."
    )