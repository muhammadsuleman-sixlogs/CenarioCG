from database.readonly_guard import validate_read_only_query


def test_allowed_select():
    validate_read_only_query(
        "SELECT * FROM some_table"
    )
    print("Allowed SELECT test passed.")


def test_allowed_with():
    validate_read_only_query(
        """
        WITH data AS (
            SELECT 1 AS value
        )
        SELECT * FROM data
        """
    )
    print("Allowed WITH test passed.")


def test_blocked_writes():

    blocked_queries = [
        "INSERT INTO some_table VALUES (1)",
        "UPDATE some_table SET value = 1",
        "DELETE FROM some_table",
        "DROP TABLE some_table",
        "ALTER TABLE some_table ADD COLUMN x TEXT",
        "CREATE TABLE some_table (id INT)",
        "TRUNCATE some_table",
        "GRANT SELECT ON some_table TO user",
        "REVOKE SELECT ON some_table FROM user",
        "MERGE INTO some_table USING other_table ON true",
        "CALL some_function()",
        "DO $$ BEGIN NULL; END $$",
        "LOCK TABLE some_table",
    ]

    for query in blocked_queries:
        try:
            validate_read_only_query(query)
        except ValueError:
            continue

        raise AssertionError(
            f"Write operation was not blocked: {query}"
        )

    print("Blocked write-operation tests passed.")


def test_blocked_modifying_cte():

    blocked_queries = [
        """
        WITH changed AS (
            UPDATE some_table
            SET value = 1
            RETURNING *
        )
        SELECT * FROM changed
        """,
        """
        WITH deleted AS (
            DELETE FROM some_table
            RETURNING *
        )
        SELECT * FROM deleted
        """,
        """
        WITH inserted AS (
            INSERT INTO some_table VALUES (1)
            RETURNING *
        )
        SELECT * FROM inserted
        """,
    ]

    for query in blocked_queries:
        try:
            validate_read_only_query(query)
        except ValueError:
            continue

        raise AssertionError(
            f"Modifying CTE was not blocked: {query}"
        )

    print("Modifying CTE tests passed.")


def test_blocked_multiple_statements():

    queries = [
        "SELECT 1; SELECT 2;",
        "SELECT 1; DELETE FROM some_table;",
        "SELECT 1; UPDATE some_table SET value = 1;",
    ]

    for query in queries:
        try:
            validate_read_only_query(query)
        except ValueError:
            continue

        raise AssertionError(
            f"Multiple statements were not blocked: {query}"
        )

    print("Multiple-statement tests passed.")


def test_blocked_locking():

    queries = [
        "SELECT * FROM some_table FOR UPDATE",
        "SELECT * FROM some_table FOR SHARE",
        "SELECT * FROM some_table FOR NO KEY UPDATE",
    ]

    for query in queries:
        try:
            validate_read_only_query(query)
        except ValueError:
            continue

        raise AssertionError(
            f"Locking query was not blocked: {query}"
        )

    print("Locking-query tests passed.")


def test_blocked_transaction_control():

    queries = [
        "BEGIN",
        "START TRANSACTION",
        "COMMIT",
        "ROLLBACK",
        "SAVEPOINT test_point",
    ]

    for query in queries:
        try:
            validate_read_only_query(query)
        except ValueError:
            continue

        raise AssertionError(
            f"Transaction statement was not blocked: {query}"
        )

    print("Transaction-control tests passed.")


def test_empty_query():

    try:
        validate_read_only_query("")
    except ValueError:
        print("Empty query rejection passed.")
        return

    raise AssertionError(
        "Empty query was not rejected."
    )


def test_non_select_query():

    try:
        validate_read_only_query(
            "EXPLAIN SELECT * FROM some_table"
        )
    except ValueError:
        print("Non-SELECT query rejection passed.")
        return

    raise AssertionError(
        "Non-SELECT query was not rejected."
    )


if __name__ == "__main__":

    test_allowed_select()
    test_allowed_with()
    test_blocked_writes()
    test_blocked_modifying_cte()
    test_blocked_multiple_statements()
    test_blocked_locking()
    test_blocked_transaction_control()
    test_empty_query()
    test_non_select_query()

    print("All read-only guard tests passed.")