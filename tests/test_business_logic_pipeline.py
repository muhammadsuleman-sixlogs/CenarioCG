from context.business_logic_pipeline import (
    infer_and_validate_business_relationships,
)


def test_business_logic_pipeline():
    result = infer_and_validate_business_relationships()

    assert isinstance(result, dict)
    assert "valid" in result
    assert "invalid" in result

    print("\n" + "=" * 70)
    print("BUSINESS LOGIC PIPELINE")
    print("=" * 70)

    print(
        f"\nValid relationships: "
        f"{len(result['valid'])}"
    )

    for relationship in result["valid"]:
        print("\nVALID:")
        print(relationship)

    print(
        f"\nInvalid relationships: "
        f"{len(result['invalid'])}"
    )

    for relationship in result["invalid"]:
        print("\nINVALID:")
        print(relationship)

    print("\n" + "=" * 70)
    print("Business logic pipeline test passed.")


if __name__ == "__main__":
    test_business_logic_pipeline()