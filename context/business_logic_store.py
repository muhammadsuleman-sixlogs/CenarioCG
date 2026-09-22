import json
from pathlib import Path
from typing import Any


BUSINESS_LOGIC_FILE = (
    Path(__file__).resolve().parent
    / "business_relationships.json"
)


def _load_store() -> dict[str, Any]:
    """
    Load the local business-relationship store.

    PostgreSQL is never accessed here.
    """

    if not BUSINESS_LOGIC_FILE.exists():
        return {
            "relationships": []
        }

    with open(
        BUSINESS_LOGIC_FILE,
        "r",
        encoding="utf-8",
    ) as file:
        data = json.load(file)

    if not isinstance(data, dict):
        return {
            "relationships": []
        }

    return data


def save_business_relationships(
    relationships: list[dict[str, Any]],
    source_id: str = "db1",
) -> None:
    """
    Save validated business relationships locally.

    Relationships are stored with their source identity so
    multiple databases can coexist safely.

    This writes only to the application's local storage.
    PostgreSQL is never modified.
    """

    if not source_id:
        raise ValueError(
            "source_id is required when saving business relationships."
        )

    store = _load_store()

    existing_relationships = store.get(
        "relationships",
        [],
    )

    if not isinstance(existing_relationships, list):
        existing_relationships = []

    # Remove previously stored relationships for this source.
    remaining_relationships = [
        relationship
        for relationship in existing_relationships
        if relationship.get("source_id") != source_id
    ]

    # Add source identity to each newly saved relationship.
    source_relationships = []

    for relationship in relationships:
        relationship_copy = dict(relationship)

        relationship_copy.setdefault(
            "source_id",
            source_id,
        )

        source_relationships.append(
            relationship_copy
        )

    store["relationships"] = (
        remaining_relationships
        + source_relationships
    )

    with open(
        BUSINESS_LOGIC_FILE,
        "w",
        encoding="utf-8",
    ) as file:
        json.dump(
            store,
            file,
            indent=2,
            ensure_ascii=False,
        )


def load_business_relationships(
    source_id: str | None = None,
) -> list[dict[str, Any]]:
    """
    Load previously validated business relationships
    from local storage.

    If source_id is provided, only relationships belonging
    to that source are returned.

    If source_id is None, all stored relationships are returned.
    """

    store = _load_store()

    relationships = store.get(
        "relationships",
        [],
    )

    if not isinstance(relationships, list):
        return []

    if source_id is None:
        return relationships

    return [
        relationship
        for relationship in relationships
        if relationship.get("source_id") == source_id
    ]