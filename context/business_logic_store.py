import json
from pathlib import Path
from typing import Any


BUSINESS_LOGIC_FILE = (
    Path(__file__).resolve().parent
    / "business_relationships.json"
)


def save_business_relationships(
    relationships: list[dict[str, Any]],
) -> None:
    """
    Save validated business relationships locally.

    This writes only to the application's local storage.
    PostgreSQL is never modified.
    """

    payload = {
        "relationships": relationships,
    }

    with open(
        BUSINESS_LOGIC_FILE,
        "w",
        encoding="utf-8",
    ) as file:
        json.dump(
            payload,
            file,
            indent=2,
            ensure_ascii=False,
        )


def load_business_relationships() -> list[dict[str, Any]]:
    """
    Load previously validated business relationships
    from local storage.
    """

    if not BUSINESS_LOGIC_FILE.exists():
        return []

    with open(
        BUSINESS_LOGIC_FILE,
        "r",
        encoding="utf-8",
    ) as file:
        data = json.load(file)

    return data.get(
        "relationships",
        [],
    )