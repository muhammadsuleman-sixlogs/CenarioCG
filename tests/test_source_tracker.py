from tracing.source_tracker import SourceTracker


def test_source_tracker():

    tracker = SourceTracker()

    sql = """
    SELECT id, created_at
    FROM example_table
    LIMIT 3;
    """

    retrieval = {
        "rows": [
            {
                "id": 1,
                "created_at": "2026-09-15",
            },
            {
                "id": 2,
                "created_at": "2026-09-14",
            },
            {
                "id": 3,
                "created_at": "2026-09-13",
            },
        ],
        "row_count": 3,
        "columns": [
            "id",
            "created_at",
        ],
    }

    contract = {
        "required_tables": [
            "example_table",
        ],
        "required_columns": [
            "example_table.id",
            "example_table.created_at",
        ],
    }

    source = tracker.build_source(
        query=sql,
        retrieval=retrieval,
        contract=contract,
    )

    assert source["source_type"] == "postgresql"

    assert source["entities"] == [
        "example_table",
    ]

    assert source["tables"] == [
        "example_table",
    ]

    assert source["columns"] == [
        "id",
        "created_at",
    ]

    assert "id" in source["sql_columns"]
    assert "created_at" in source["sql_columns"]

    assert source["row_count"] == 3

    assert len(source["rows"]) == 3

    print("Source tracking passed.")
    print("Source:", source["source"])
    print("Entities:", source["entities"])
    print("Tables:", source["tables"])
    print("Columns:", source["columns"])
    print("Rows tracked:", source["row_count"])
    print("No API call required.")


if __name__ == "__main__":

    test_source_tracker()

    print(
        "All source tracker tests passed."
    )