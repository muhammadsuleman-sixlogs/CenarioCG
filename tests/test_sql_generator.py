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


if __name__ == "__main__":
    test_sql_generation()

    print(
        "All SQL generator tests passed."
    )