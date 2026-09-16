from database.schema_discovery import discover_schema


def build_context():
    """
    Build an automatic context representation from
    PostgreSQL schema metadata.

    IMPORTANT:
    This function only reads database metadata.
    It never modifies the database.
    """

    schema = discover_schema()

    columns = schema["columns"]
    primary_keys = schema["primary_keys"]
    foreign_keys = schema["foreign_keys"]

    context = {
        "tables": {},
        "relationships": [],
    }

    # --------------------------------------------------
    # Build table/column context
    # --------------------------------------------------

    for table_name, column_name, data_type in columns:

        if table_name not in context["tables"]:
            context["tables"][table_name] = {
                "columns": [],
                "primary_keys": [],
            }

        context["tables"][table_name]["columns"].append(
            {
                "name": column_name,
                "type": data_type,
            }
        )

    # --------------------------------------------------
    # Add primary keys
    # --------------------------------------------------

    for table_name, column_name in primary_keys:

        if table_name in context["tables"]:
            context["tables"][table_name]["primary_keys"].append(
                column_name
            )

    # --------------------------------------------------
    # Add relationships
    # --------------------------------------------------

    for (
        source_table,
        source_column,
        target_table,
        target_column,
    ) in foreign_keys:

        context["relationships"].append(
            {
                "source_table": source_table,
                "source_column": source_column,
                "target_table": target_table,
                "target_column": target_column,
                "relationship_type": "FOREIGN_KEY",
                "confidence": 1.0,
                "source": "postgresql_foreign_key",
            }
        )

    return context


def print_context(context):

    print("=" * 70)
    print("AUTOMATIC CONTEXT LAYER")
    print("=" * 70)

    tables = context["tables"]
    relationships = context["relationships"]

    print(f"\nTables: {len(tables)}")
    print(f"Relationships: {len(relationships)}")

    print("\n" + "-" * 70)
    print("TABLE CONTEXT")
    print("-" * 70)

    for table_name, table_info in tables.items():

        print(f"\nTABLE: {table_name}")

        print(
            f"  Columns: "
            f"{len(table_info['columns'])}"
        )

        print(
            f"  Primary Keys: "
            f"{table_info['primary_keys']}"
        )

    print("\n" + "-" * 70)
    print("RELATIONSHIP CONTEXT")
    print("-" * 70)

    for relationship in relationships:

        print(
            f"  "
            f"{relationship['source_table']}."
            f"{relationship['source_column']}"
            f" -> "
            f"{relationship['target_table']}."
            f"{relationship['target_column']}"
            f" "
            f"[confidence="
            f"{relationship['confidence']}]"
        )

    print("\n" + "=" * 70)


if __name__ == "__main__":

    context = build_context()

    print_context(context)