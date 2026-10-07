from database.connection import get_connection, get_db2_connection


def discover_schema(connection_factory=get_connection):
    """
    Read PostgreSQL metadata without modifying the database.

    Discovers:
    - tables
    - columns
    - primary keys
    - foreign keys

    The connection_factory determines which database is inspected.
    """

    connection = connection_factory()

    try:
        with connection.cursor() as cursor:

            # 1. Discover tables and columns
            cursor.execute("""
                SELECT
                    table_name,
                    column_name,
                    data_type
                FROM information_schema.columns
                WHERE table_schema = 'public'
                ORDER BY table_name, ordinal_position;
            """)

            columns = cursor.fetchall()

            # 2. Discover primary keys
            cursor.execute("""
                SELECT
                    tc.table_name,
                    kcu.column_name
                FROM information_schema.table_constraints AS tc
                JOIN information_schema.key_column_usage AS kcu
                    ON tc.constraint_name = kcu.constraint_name
                    AND tc.table_schema = kcu.table_schema
                WHERE tc.constraint_type = 'PRIMARY KEY'
                  AND tc.table_schema = 'public'
                ORDER BY tc.table_name, kcu.ordinal_position;
            """)

            primary_keys = cursor.fetchall()

            # 3. Discover foreign keys
            cursor.execute("""
                SELECT DISTINCT
                    tc.table_name AS source_table,
                    kcu.column_name AS source_column,
                    ccu.table_name AS target_table,
                    ccu.column_name AS target_column
                FROM information_schema.table_constraints AS tc
                JOIN information_schema.key_column_usage AS kcu
                    ON tc.constraint_name = kcu.constraint_name
                    AND tc.table_schema = kcu.table_schema
                JOIN information_schema.constraint_column_usage AS ccu
                    ON tc.constraint_name = ccu.constraint_name
                    AND tc.table_schema = ccu.table_schema
                WHERE tc.constraint_type = 'FOREIGN KEY'
                  AND tc.table_schema = 'public'
                ORDER BY
                    tc.table_name,
                    kcu.column_name;
            """)

            foreign_keys = cursor.fetchall()

            return {
                "columns": columns,
                "primary_keys": primary_keys,
                "foreign_keys": foreign_keys,
            }

    finally:
        connection.close()


def print_schema(schema, source_name="PostgreSQL"):
    """Print discovered schema in a readable format."""

    columns = schema["columns"]
    primary_keys = schema["primary_keys"]
    foreign_keys = schema["foreign_keys"]

    tables = {}

    for table_name, column_name, data_type in columns:
        tables.setdefault(table_name, []).append(
            {
                "name": column_name,
                "type": data_type,
            }
        )

    print("\n" + "=" * 70)
    print(f"AUTOMATIC {source_name.upper()} SCHEMA DISCOVERY")
    print("=" * 70)

    print(f"\nTables discovered: {len(tables)}")

    for table_name, table_columns in tables.items():
        print(f"\nTABLE: {table_name}")

        for column in table_columns:
            print(
                f"  - {column['name']} "
                f"({column['type']})"
            )

    print("\n" + "-" * 70)
    print("PRIMARY KEYS")
    print("-" * 70)

    for table_name, column_name in primary_keys:
        print(f"  {table_name}.{column_name}")

    print("\n" + "-" * 70)
    print("FOREIGN KEY RELATIONSHIPS")
    print("-" * 70)

    for source_table, source_column, target_table, target_column in foreign_keys:
        print(
            f"  {source_table}.{source_column}"
            f" -> "
            f"{target_table}.{target_column}"
        )

    print("\n" + "=" * 70)


if __name__ == "__main__":
    schema = discover_schema()
    print_schema(schema, "Primary PostgreSQL")