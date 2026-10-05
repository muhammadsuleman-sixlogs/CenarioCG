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


if __name__ == "__main__":
    test_sql_generation()
    test_ranking_uses_distinct_on_not_group_by()

    print(
        "All SQL generator tests passed."
    )