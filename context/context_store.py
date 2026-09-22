import json
from pathlib import Path


CONTEXT_DIR = Path("context")

DB1_CONTEXT_FILE = CONTEXT_DIR / "context_db1.json"
DB2_CONTEXT_FILE = CONTEXT_DIR / "context_db2.json"

# Backward-compatible existing context file.
LEGACY_CONTEXT_FILE = CONTEXT_DIR / "context.json"


def _get_context_file(source_id: str) -> Path:
    """
    Return the local context file for a PostgreSQL source.
    """

    if source_id == "db1":
        return DB1_CONTEXT_FILE

    if source_id == "db2":
        return DB2_CONTEXT_FILE

    raise ValueError(
        f"Unsupported context source: {source_id}"
    )


def save_context(
    context: dict,
    source_id: str = "db1",
) -> None:
    """
    Save one source's discovered Context Layer locally.

    This writes ONLY to application-local storage.
    It does NOT write anything to PostgreSQL.
    """

    if not isinstance(context, dict):
        raise ValueError(
            "Context must be a dictionary."
        )

    CONTEXT_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    context_file = _get_context_file(source_id)

    with context_file.open(
        "w",
        encoding="utf-8",
    ) as file:
        json.dump(
            context,
            file,
            indent=2,
            default=str,
        )

    print(
        f"{source_id.upper()} context saved to: "
        f"{context_file}"
    )


def load_context(
    source_id: str = "db1",
) -> dict:
    """
    Load one source's previously generated Context Layer.
    """

    context_file = _get_context_file(source_id)

    # Backward compatibility:
    # existing context/context.json is treated as DB1
    # when the new DB1 file has not been created yet.
    if not context_file.exists():

        if (
            source_id == "db1"
            and LEGACY_CONTEXT_FILE.exists()
        ):
            with LEGACY_CONTEXT_FILE.open(
                "r",
                encoding="utf-8",
            ) as file:
                return json.load(file)

        raise FileNotFoundError(
            f"Context file not found for {source_id}: "
            f"{context_file}"
        )

    with context_file.open(
        "r",
        encoding="utf-8",
    ) as file:
        return json.load(file)


def load_all_contexts() -> dict[str, dict]:
    """
    Load all available PostgreSQL Context Layers.

    Returns:
        {
            "db1": {...},
            "db2": {...}
        }

    Only sources with an available context file are loaded.
    """

    contexts: dict[str, dict] = {}

    for source_id in ("db1", "db2"):
        try:
            contexts[source_id] = load_context(
                source_id=source_id
            )
        except FileNotFoundError:
            continue

    if not contexts:
        raise FileNotFoundError(
            "No PostgreSQL Context Layer files were found."
        )

    return contexts


if __name__ == "__main__":
    from context.context_builder import build_context

    print("=" * 70)
    print("CONTEXT STORE TEST")
    print("=" * 70)

    # Preserve the existing behavior:
    # build and save DB1 context.
    context = build_context(
        source_id="db1"
    )

    save_context(
        context,
        source_id="db1",
    )

    loaded_context = load_context(
        source_id="db1"
    )

    print(
        f"DB1 Tables: "
        f"{len(loaded_context['tables'])}"
    )

    print(
        f"DB1 Relationships: "
        f"{len(loaded_context['relationships'])}"
    )

    print("\nContext store test passed.")