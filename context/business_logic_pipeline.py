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
) -> dict[str, list[dict[str, Any]]]:
    """
    Run business-logic inference and validation.

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

    proposed_relationships = (
        infer_business_relationships(
            context
        )
    )

    validation_result = validate_relationships(
        proposed_relationships,
        context,
    )

    valid_relationships = (
        validation_result["valid"]
    )

    save_business_relationships(
        valid_relationships
    )

    return {
        "valid": valid_relationships,
        "invalid": validation_result["invalid"],
    }