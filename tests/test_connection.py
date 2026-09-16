from database.connection import get_connection


def main():
    connection = get_connection()

    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1;")
            result = cursor.fetchone()

            print("Database connection successful.")
            print("SELECT 1 result:", result)

    finally:
        connection.close()


if __name__ == "__main__":
    main()