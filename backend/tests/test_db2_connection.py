from database.connection import get_db2_connection


conn = get_db2_connection()

try:
    with conn.cursor() as cursor:
        cursor.execute("SELECT 1;")
        print("DB2 connection successful:", cursor.fetchone())

        cursor.execute("SHOW transaction_read_only;")
        print("Read-only mode:", cursor.fetchone())

finally:
    conn.close()