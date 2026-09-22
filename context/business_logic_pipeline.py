from typing import Any

from context.business_logic_inference import (
    infer_business_relationships,
)
from context.business_logic_validator import (
    validate_relationships,
)
from context.business_logic_store import (
    save_business_relationships,
)
from context.context_store import load_context


def infer_and_validate_business_relationships(
    context: dict[str, Any] | None = None,
    source_id: str | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """
    Run business-logic inference and validation for one
    database source.

    Flow:

        Context
          ↓
        GPT-5.6
          ↓
        Proposed relationships
          ↓
        Local validation
          ↓
        Valid relationships
          ↓
        Local business-logic store

    PostgreSQL is never modified.
    """

    if context is None:
        context = load_context()

    if source_id is None:
        source_id = context.get(
            "source_id",
            "db1",
        )

    # Make sure the context explicitly identifies
    # the source being processed.
    context = dict(context)
    context["source_id"] = source_id

    print()
    print("=" * 70)
    print(
        f"BUSINESS RELATIONSHIP PIPELINE - {source_id}"
    )
    print("=" * 70)

    print(
        f"Tables available: "
        f"{len(context.get('tables', {}))}"
    )

    print(
        f"Database relationships available: "
        f"{len(context.get('relationships', []))}"
    )

    # --------------------------------------------------
    # 1. LLM inference
    # --------------------------------------------------

    proposed_relationships = (
        infer_business_relationships(
            context
        )
    )

    print(
        f"Proposed business relationships: "
        f"{len(proposed_relationships)}"
    )

    # --------------------------------------------------
    # 2. Local validation
    # --------------------------------------------------

    validation_result = validate_relationships(
        proposed_relationships,
        context,
    )

    valid_relationships = (
        validation_result["valid"]
    )

    invalid_relationships = (
        validation_result["invalid"]
    )

    print(
        f"Valid relationships: "
        f"{len(valid_relationships)}"
    )

    print(
        f"Invalid relationships: "
        f"{len(invalid_relationships)}"
    )

    # --------------------------------------------------
    # 3. Local storage
    # --------------------------------------------------

    save_business_relationships(
        valid_relationships,
        source_id=source_id,
    )

    print(
        f"Saved relationships for source: "
        f"{source_id}"
    )

    print("=" * 70)

    return {
        "valid": valid_relationships,
        "invalid": invalid_relationships,
    }


def run_all_sources(
    contexts: dict[str, dict[str, Any]],
) -> dict[str, dict[str, list[dict[str, Any]]]]:
    """
    Run the business-relationship pipeline independently
    for every supplied database source.

    Cross-source relationships are NOT inferred here.
    """

    results: dict[
        str,
        dict[str, list[dict[str, Any]]],
    ] = {}

    for source_id, context in contexts.items():

        results[source_id] = (
            infer_and_validate_business_relationships(
                context=context,
                source_id=source_id,
            )
        )

    return results


if __name__ == "__main__":
    """
    Execute the existing DB1 context pipeline.

    DB2 will be executed separately after we verify that
    the existing DB1 pipeline still works correctly.
    """

    context = load_context()

    result = (
        infer_and_validate_business_relationships(
            context=context,
            source_id=context.get(
                "source_id",
                "db1",
            ),
        )
    )

    print()
    print("PIPELINE COMPLETE")
    print(
        f"Valid: {len(result['valid'])}"
    )
    print(
        f"Invalid: {len(result['invalid'])}"
    )