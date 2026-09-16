import json
from pathlib import Path


CONTEXT_FILE = Path("context/context.json")


def save_context(context: dict) -> None:
    """
    Save the generated context locally.

    This writes ONLY to the application's local storage.
    It does NOT write anything to PostgreSQL.
    """
    CONTEXT_FILE.parent.mkdir(parents=True, exist_ok=True)

    with CONTEXT_FILE.open("w", encoding="utf-8") as file:
        json.dump(context, file, indent=2)

    print(f"Context saved to: {CONTEXT_FILE}")


def load_context() -> dict:
    """
    Load the previously generated context.
    """
    if not CONTEXT_FILE.exists():
        raise FileNotFoundError(
            f"Context file not found: {CONTEXT_FILE}"
        )

    with CONTEXT_FILE.open("r", encoding="utf-8") as file:
        return json.load(file)


if __name__ == "__main__":
    from context.context_builder import build_context

    context = build_context()
    save_context(context)

    loaded_context = load_context()

    print("=" * 70)
    print("CONTEXT STORE TEST")
    print("=" * 70)
    print(f"Tables: {len(loaded_context['tables'])}")
    print(f"Relationships: {len(loaded_context['relationships'])}")
    print("\nContext store test passed.")