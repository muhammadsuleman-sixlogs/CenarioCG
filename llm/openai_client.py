import os

from dotenv import load_dotenv
from openai import OpenAI


load_dotenv()


def get_openai_client() -> OpenAI:
    """
    Create and return the OpenAI client.

    The API key is loaded from the local .env file.
    """

    api_key = os.getenv("OPENAI_API_KEY")

    if not api_key:
        raise ValueError(
            "OPENAI_API_KEY is not configured in .env"
        )

    return OpenAI(api_key=api_key)