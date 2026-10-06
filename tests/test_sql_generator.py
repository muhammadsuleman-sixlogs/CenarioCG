from context.context_store import load_context
from retrieval.sql_generator import SQLGenerator
from retrieval.sql_validator import validate_sql_syntax


def test_sql_generation():
    context = load_context()

    tables = list(
        context.get("tables", {}).keys()
    )

    assert tables, "No tables found in Context Layer."

    test_table = tables[0]

    columns = context["tables"][test_table].get(
        "columns",
        [],
    )

    assert columns, (
        f"No columns found for table {test_table}."
    )

    test_column = columns[0]["name"]

    contract = {
        "question": (
            "Retrieve the first 5 records from the selected data source."
        ),
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
        "limit": 5,
        "entities": [],
        "needs_conversation_context": False,
    }

    generator = SQLGenerator(context)

    query = generator.generate(contract)

    assert query
    assert query.strip()

    normalized = query.strip().upper()

    assert (
        normalized.startswith("SELECT")
        or normalized.startswith("WITH")
    )

    # --------------------------------------------------
    # Verify read-only SQL
    # --------------------------------------------------

    print("Generated SQL:")
    print(query)

    print(
        "Generated SQL passed read-only validation."
    )

    # --------------------------------------------------
    # Verify PostgreSQL syntax
    # --------------------------------------------------

    validate_sql_syntax(query)

    print(
        "Generated SQL passed syntax validation."
    )

    # --------------------------------------------------
    # Verify requested LIMIT
    # --------------------------------------------------

    assert "LIMIT 5" in normalized, (
        "Generated SQL did not respect contract limit."
    )

    print(
        "Generated SQL respected requested LIMIT."
    )

    print(
        "Dynamic SQL generation passed."
    )


def test_ranking_uses_distinct_on_not_group_by():
    """Latest-per-group ranking must not emit invalid GROUP BY SQL."""
    context = {
        "tables": {
            "projects": {
                "columns": [
                    {"name": "project_id"},
                    {"name": "project_title"},
                    {"name": "project_code"},
                ],
                "primary_keys": ["project_id"],
            },
            "sessions": {
                "columns": [
                    {"name": "session_id"},
                    {"name": "project_id"},
                    {"name": "meeting_title"},
                    {"name": "created_at"},
                ],
                "primary_keys": ["session_id"],
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
    }

    contract = {
        "question": "Return project name/code and latest meeting title",
        "required_tables": ["projects", "sessions"],
        "required_columns": [
            "projects.project_title",
            "projects.project_code",
            "sessions.meeting_title",
            "sessions.created_at",
            "sessions.project_id",
        ],
        "relationships": [
            {
                "source_table": "sessions",
                "source_column": "project_id",
                "target_table": "projects",
                "target_column": "project_id",
                "relationship_type": "FOREIGN_KEY",
            }
        ],
        "filters": [],
        "operations": ["lookup", "ranking"],
        "grouping": [
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
    }

    query = SQLGenerator(context, source_id="db2").generate(contract)
    normalized = " ".join(query.upper().split())

    assert "SELECT DISTINCT ON" in normalized
    assert "GROUP BY" not in normalized
    assert "ORDER BY" in normalized
    assert "CREATED_AT" in normalized and "DESC" in normalized
    validate_sql_syntax(query)

    print("Ranking DISTINCT ON generation passed.")


def test_runtime_bound_filter_with_placeholder_and_in_coercion():
    """Placeholder filters for runtime-bound columns must not fail with IN filter value must be a list."""
    context = {
        "tables": {
            "projects": {
                "columns": [
                    {"name": "id"},
                    {"name": "project_name"},
                ],
                "primary_keys": ["id"],
            },
        },
        "relationships": [],
    }

    contract = {
        "question": "project details",
        "required_tables": ["projects"],
        "required_columns": ["projects.id", "projects.project_name"],
        "filters": [
            {"field": "projects.id", "operator": "in", "value": None},
            {"field": "projects.project_name", "operator": "in", "value": "SingleName"},
        ],
        "operations": ["lookup"],
        "relationships": [],
    }

    runtime_bindings = [
        {
            "index": 0,
            "to_table": "projects",
            "to_column": "id",
            "operator": "in",
        }
    ]

    generator = SQLGenerator(context, source_id="db1")
    query = generator.generate(
        contract,
        source_id="db1",
        runtime_bindings={"bindings": runtime_bindings, "parameters": [["uuid-1", "uuid-2"]]},
    )

    normalized = " ".join(query.upper().split())
    assert "CAST(\"PROJECTS\".\"ID\" AS TEXT) = ANY(%S)" in normalized
    assert "\"PROJECTS\".\"PROJECT_NAME\" IN ('SINGLENAME')" in normalized
    validate_sql_syntax(query)


if __name__ == "__main__":
    test_sql_generation()
    test_ranking_uses_distinct_on_not_group_by()
    test_runtime_bound_filter_with_placeholder_and_in_coercion()

    print(
        "All SQL generator tests passed."
    )