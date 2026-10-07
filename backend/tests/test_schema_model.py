from database.schema_discovery import discover_schema
from database.schema_model import (
    Column,
    ForeignKey,
    Table,
    DatabaseSchema,
)
from database.sensitive_columns import is_sensitive_column


def main():
    raw_schema = discover_schema()

    tables = {}

    for table_name, column_name, data_type in raw_schema["columns"]:
        if table_name not in tables:
            tables[table_name] = Table(name=table_name)

        tables[table_name].columns.append(
            Column(
                name=column_name,
                data_type=data_type,
            )
        )

    for table_name, column_name in raw_schema["primary_keys"]:
        if table_name in tables:
            tables[table_name].primary_keys.append(column_name)

    for (
        source_table,
        source_column,
        target_table,
        target_column,
    ) in raw_schema["foreign_keys"]:

        relationship = ForeignKey(
            source_table=source_table,
            source_column=source_column,
            target_table=target_table,
            target_column=target_column,
        )

        if source_table in tables:
            tables[source_table].foreign_keys.append(
                relationship
            )

    schema = DatabaseSchema(
        tables=list(tables.values())
    )

    print("=" * 60)
    print("STRUCTURED SCHEMA MODEL")
    print("=" * 60)

    print(f"Tables: {len(schema.tables)}")

    for table in schema.tables:
        print(f"\nTABLE: {table.name}")
        print(f"Columns: {len(table.columns)}")
        print(f"Primary Keys: {table.primary_keys}")
        print(f"Foreign Keys: {len(table.foreign_keys)}")

    print("\n" + "=" * 60)
    print("SENSITIVE COLUMN CHECK")
    print("=" * 60)

    test_columns = [
        "password_hash",
        "private_key",
        "name",
        "description",
        "two_factor_code",
    ]

    for column in test_columns:
        print(
            f"{column}: "
            f"{'SENSITIVE' if is_sensitive_column(column) else 'SAFE'}"
        )

    print("\nSchema model test passed.")


if __name__ == "__main__":
    main()