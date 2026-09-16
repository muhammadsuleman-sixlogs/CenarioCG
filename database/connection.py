import os

import psycopg2
from dotenv import load_dotenv


load_dotenv()


def get_connection():
    """
    Create a PostgreSQL connection.

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