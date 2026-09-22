from database.connection import get_db2_connection
from database.schema_discovery import discover_schema, print_schema


def main():
    schema = discover_schema(get_db2_connection)
    print_schema(schema, "Second PostgreSQL")


if __name__ == "__main__":
    main()