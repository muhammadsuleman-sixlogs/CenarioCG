import os
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()


OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5.4-nano-2026-03-17")


def get_openai_client() -> OpenAI:
    """
    Create and return the OpenAI client.
    The API key is loaded from environment variables.
    """

    api_key = os.getenv("OPENAI_API_KEY")

    if not api_key:
        raise ValueError(
            "OPENAI_API_KEY is not configured."
        )

    return OpenAI(api_key=api_key)