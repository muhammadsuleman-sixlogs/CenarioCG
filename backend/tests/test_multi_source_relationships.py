from context.context_builder import build_context
from context.context_graph import (
    build_multi_source_context_graph,
    get_graph_summary,
)


def test_multi_source_relationships():
    print("\n" + "=" * 70)
    print("MULTI-SOURCE RELATIONSHIP TEST")
    print("=" * 70)

    # --------------------------------------------------
    # Build both contexts
    # --------------------------------------------------

    print("\nBuilding DB1 context...")
    db1_context = build_context("db1")

    print("Building DB2 context...")
    db2_context = build_context("db2")

    # --------------------------------------------------
    # Build combined graph
    # --------------------------------------------------

    graph = build_multi_source_context_graph(
        contexts=[
            db1_context,
            db2_context,
        ]
    )

    summary = get_graph_summary(graph)

    print("\n" + "-" * 70)
    print("GRAPH SUMMARY")
    print("-" * 70)

    print(
        f"\nNodes: "
        f"{summary['nodes']}"
    )

    print(
        f"Edges: "
        f"{summary['edges']}"
    )

    print(
        f"Database relationships: "
        f"{summary['database_relationships']}"
    )

    print(
        f"Business relationships: "
        f"{summary['business_relationships']}"
    )

    # --------------------------------------------------
    # Collect relationships by source
    # --------------------------------------------------

    db1_edges = []
    db2_edges = []

    for source, target, data in graph.edges(
        data=True
    ):
        source_id = data.get("source_id")

        if source_id == "db1":
            db1_edges.append(
                (source, target, data)
            )

        elif source_id == "db2":
            db2_edges.append(
                (source, target, data)
            )

    # --------------------------------------------------
    # Validate source separation
    # --------------------------------------------------

    print("\n" + "-" * 70)
    print("SOURCE RELATIONSHIP VALIDATION")
    print("-" * 70)

    print(
        f"\nDB1 graph relationships: "
        f"{len(db1_edges)}"
    )

    print(
        f"DB2 graph relationships: "
        f"{len(db2_edges)}"
    )

    assert len(db1_edges) > 0
    assert len(db2_edges) > 0

    # --------------------------------------------------
    # Every DB1 edge must be DB1 -> DB1
    # --------------------------------------------------

    for source, target, data in db1_edges:
        assert source.startswith("db1:")
        assert target.startswith("db1:")
        assert data.get("source_id") == "db1"

    print(
        "\nDB1 relationships remain isolated."
    )

    # --------------------------------------------------
    # Every DB2 edge must be DB2 -> DB2
    # --------------------------------------------------

    for source, target, data in db2_edges:
        assert source.startswith("db2:")
        assert target.startswith("db2:")
        assert data.get("source_id") == "db2"

    print(
        "DB2 relationships remain isolated."
    )

    # --------------------------------------------------
    # Validate no cross-source relationship exists yet
    # --------------------------------------------------

    cross_source_edges = []

    for source, target, data in graph.edges(
        data=True
    ):
        source_id = data.get("source_id")

        if (
            source.startswith("db1:")
            and target.startswith("db2:")
        ) or (
            source.startswith("db2:")
            and target.startswith("db1:")
        ):
            cross_source_edges.append(
                (source, target, data)
            )

    print(
        f"\nCross-source relationships: "
        f"{len(cross_source_edges)}"
    )

    assert len(cross_source_edges) == 0

    print(
        "No unvalidated cross-source "
        "relationships detected."
    )

    print("\n" + "=" * 70)
    print("MULTI-SOURCE RELATIONSHIP TEST PASSED")
    print("=" * 70)


if __name__ == "__main__":
    test_multi_source_relationships()