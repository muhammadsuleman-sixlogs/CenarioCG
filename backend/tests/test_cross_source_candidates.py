from context.context_builder import build_context
from context.cross_source_inference import (
    find_cross_source_candidates,
)


def test_cross_source_candidates():
    print("\n" + "=" * 70)
    print("CROSS-SOURCE CANDIDATE TEST")
    print("=" * 70)

    print("\nBuilding DB1 context...")
    db1_context = build_context("db1")

    print("Building DB2 context...")
    db2_context = build_context("db2")

    candidates = find_cross_source_candidates(
        db1_context,
        db2_context,
    )

    strong = [
        candidate
        for candidate in candidates
        if candidate["strength"] == "strong"
    ]

    possible = [
        candidate
        for candidate in candidates
        if candidate["strength"] == "possible"
    ]

    print("\n" + "-" * 70)
    print("CANDIDATE RESULTS")
    print("-" * 70)

    print(
        f"\nTotal candidates: {len(candidates)}"
    )

    print(
        f"Strong candidates: {len(strong)}"
    )

    print(
        f"Possible candidates: {len(possible)}"
    )

    print("\n" + "-" * 70)
    print("TOP CANDIDATES")
    print("-" * 70)

    for candidate in candidates[:20]:
        print(
            f"\n"
            f"{candidate['source_system']}:"
            f"{candidate['source_table']}."
            f"{candidate['source_column']}"
            f" -> "
            f"{candidate['target_system']}:"
            f"{candidate['target_table']}."
            f"{candidate['target_column']}"
        )

        print(
            f"Strength: "
            f"{candidate['strength']}"
        )

        print(
            f"Table similarity: "
            f"{candidate['table_similarity']}"
        )

        print(
            f"Evidence: "
            f"{candidate['evidence']}"
        )

    assert isinstance(
        candidates,
        list,
    )

    for candidate in candidates:
        assert (
            candidate["source_system"]
            == "db1"
        )

        assert (
            candidate["target_system"]
            == "db2"
        )

        assert candidate["source_table"]
        assert candidate["target_table"]
        assert candidate["source_column"]
        assert candidate["target_column"]

        assert candidate["strength"] in {
            "strong",
            "possible",
        }

        assert candidate["evidence"]

    print("\n" + "=" * 70)
    print(
        "CROSS-SOURCE CANDIDATE TEST PASSED"
    )
    print("=" * 70)


if __name__ == "__main__":
    test_cross_source_candidates()