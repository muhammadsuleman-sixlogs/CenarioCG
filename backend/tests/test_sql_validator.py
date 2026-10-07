from retrieval.sql_validator import validate_sql_syntax


def test_valid_select():
    query = """
    SELECT id
    FROM example_table
    LIMIT 10;
    """

    validate_sql_syntax(query)

    print("Valid SELECT passed.")


def test_valid_cte():
    query = """
    WITH recent AS (
        SELECT id
        FROM example_table
    )
    SELECT id
    FROM recent
    LIMIT 10;
    """

    validate_sql_syntax(query)

    print("Valid CTE passed.")


def test_invalid_sql():
    query = """
    SELECT id
    FROM example_table
    ORDER BYcreated_at DESC
    LIMIT 10;
    """

    try:
        validate_sql_syntax(query)
    except ValueError:
        print("Invalid SQL rejection passed.")
        return

    raise AssertionError(
        "Invalid SQL was incorrectly accepted."
    )


def test_multiple_statements():
    query = """
    SELECT id
    FROM example_table;

    SELECT id
    FROM example_table;
    """

    try:
        validate_sql_syntax(query)
    except ValueError:
        print("Multiple statement rejection passed.")
        return

    raise AssertionError(
        "Multiple statements were incorrectly accepted."
    )


if __name__ == "__main__":
    test_valid_select()
    test_valid_cte()
    test_invalid_sql()
    test_multiple_statements()

    print("All SQL validator tests passed.")