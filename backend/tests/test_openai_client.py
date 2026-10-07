from llm.openai_client import get_openai_client


def test_openai_client():
    client = get_openai_client()

    assert client is not None

    print("OpenAI client initialized successfully.")


if __name__ == "__main__":
    test_openai_client()

    print("OpenAI client test passed.")