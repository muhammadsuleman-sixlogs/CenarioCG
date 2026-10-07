from context.context_store import load_context
from retrieval.retrieval_executor import RetrievalExecutor


def test_read_only_retrieval():

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
        f"No columns found for {test_table}."
    )

    test_column = columns[0]["name"]

    query = f'''
        SELECT "{test_column}"
        FROM "{test_table}"
        LIMIT 3
    '''

    executor = RetrievalExecutor()

    result = executor.execute(query)

    assert "rows" in result
    assert "row_count" in result
    assert "columns" in result
    assert "provenance" in result

    assert result["row_count"] <= 3
    assert test_column in result["columns"]

    assert (
        result["provenance"]["source"]
        == "postgresql"
    )

    print("Read-only retrieval passed.")
    print("Rows returned:", result["row_count"])
    print("Columns:", result["columns"])


def test_write_query_blocked():

    executor = RetrievalExecutor()

    blocked_query = (
        "DELETE FROM table_that_does_not_exist"
    )

    try:
        executor.execute(blocked_query)
    except ValueError:
        print("Write query blocked before execution.")
        return

    raise AssertionError(
        "Write query was not blocked."
    )


if __name__ == "__main__":

    test_read_only_retrieval()
    test_write_query_blocked()

    print(
        "All retrieval executor tests passed."
    )