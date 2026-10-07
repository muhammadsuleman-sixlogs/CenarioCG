import os

import psycopg2

from dotenv import load_dotenv


load_dotenv()


def get_connection():
    """
    Create a PostgreSQL connection for the primary database.

    This project is designed to use a PostgreSQL account
    with read-only permissions.
    """
    return psycopg2.connect(
        host=os.getenv("POSTGRES_HOST"),
        port=os.getenv("POSTGRES_PORT", "11351"),
        database=os.getenv("POSTGRES_DATABASE"),
        user=os.getenv("POSTGRES_USER"),
        password=os.getenv("POSTGRES_PASSWORD"),
    )


def get_db2_connection():
    """
    Create a PostgreSQL connection for the second database.

    The connection is explicitly configured as read-only.
    """
    conn = psycopg2.connect(
        host=os.getenv("DB_HOST"),
        port=os.getenv("DB_PORT", "5432"),
        database=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
    )

    conn.set_session(readonly=True)

    return conn