from context.context_builder import build_context
from context.business_logic_pipeline import (
    infer_and_validate_business_relationships,
)


def main():
    print("=" * 70)
    print("DB2 BUSINESS RELATIONSHIP TEST")
    print("=" * 70)

    context = build_context(
        source_id="db2"
    )

    result = (
        infer_and_validate_business_relationships(
            context=context,
            source_id="db2",
        )
    )

    print()
    print("=" * 70)
    print("DB2 TEST COMPLETE")
    print("=" * 70)

    print(
        f"Valid relationships: "
        f"{len(result['valid'])}"
    )

    print(
        f"Invalid relationships: "
        f"{len(result['invalid'])}"
    )


if __name__ == "__main__":
    main()