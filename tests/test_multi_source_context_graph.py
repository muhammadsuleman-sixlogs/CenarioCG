from context.context_builder import build_context
from context.context_graph import (
    build_multi_source_context_graph,
    get_graph_summary,
)


def test_multi_source_context_graph():
    print("\n" + "=" * 70)
    print("MULTI-SOURCE CONTEXT GRAPH TEST")
    print("=" * 70)

    print("\nBuilding DB1 context...")
    db1_context = build_context("db1")

    print(
        f"DB1 tables: "
        f"{len(db1_context['tables'])}"
    )

    print(
        f"DB1 relationships: "
        f"{len(db1_context['relationships'])}"
    )

    print("\nBuilding DB2 context...")
    db2_context = build_context("db2")

    print(
        f"DB2 tables: "
        f"{len(db2_context['tables'])}"
    )

    print(
        f"DB2 relationships: "
        f"{len(db2_context['relationships'])}"
    )

    graph = build_multi_source_context_graph(
        contexts=[
            db1_context,
            db2_context,
        ]
    )

    summary = get_graph_summary(graph)

    print("\n" + "-" * 70)
    print("COMBINED GRAPH")
    print("-" * 70)

    print(
        f"\nTotal nodes: "
        f"{summary['nodes']}"
    )

    print(
        f"Total edges: "
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

    assert summary["nodes"] > 0
    assert summary["edges"] > 0

    # --------------------------------------------------
    # Verify both sources exist
    # --------------------------------------------------

    db1_nodes = [
        node
        for node, data in graph.nodes(data=True)
        if data.get("source_id") == "db1"
    ]

    db2_nodes = [
        node
        for node, data in graph.nodes(data=True)
        if data.get("source_id") == "db2"
    ]

    print("\n" + "-" * 70)
    print("SOURCE VALIDATION")
    print("-" * 70)

    print(
        f"\nDB1 graph nodes: "
        f"{len(db1_nodes)}"
    )

    print(
        f"DB2 graph nodes: "
        f"{len(db2_nodes)}"
    )

    assert len(db1_nodes) == len(
        db1_context["tables"]
    )

    assert len(db2_nodes) == len(
        db2_context["tables"]
    )

    # --------------------------------------------------
    # Verify source-qualified node IDs
    # --------------------------------------------------

    assert all(
        node.startswith("db1:")
        for node in db1_nodes
    )

    assert all(
        node.startswith("db2:")
        for node in db2_nodes
    )

    print(
        "\nSource-qualified node IDs "
        "validated."
    )

    # --------------------------------------------------
    # Verify there is no accidental node collision
    # --------------------------------------------------

    assert not any(
        node in db2_nodes
        for node in db1_nodes
    )

    print(
        "DB1/DB2 node isolation validated."
    )

    print("\n" + "=" * 70)
    print("MULTI-SOURCE GRAPH TEST PASSED")
    print("=" * 70)


if __name__ == "__main__":
    test_multi_source_context_graph()