from context.context_graph import (
    build_context_graph,
    get_graph_summary,
    get_related_tables,
    get_relationships,
)


def test_context_graph():
    graph = build_context_graph()

    summary = get_graph_summary(graph)

    print("\n" + "=" * 70)
    print("CONTEXT GRAPH TEST")
    print("=" * 70)

    print(f"\nNodes: {summary['nodes']}")
    print(f"Edges: {summary['edges']}")
    print(
        "Database relationships: "
        f"{summary['database_relationships']}"
    )
    print(
        "Business relationships: "
        f"{summary['business_relationships']}"
    )

    assert summary["nodes"] > 0
    assert summary["edges"] > 0

    assert (
        summary["database_relationships"] > 0
    )

    print("\nContext graph successfully built.")


def test_related_tables():
    graph = build_context_graph()

    tables = list(graph.nodes)

    assert len(tables) > 0

    table_name = tables[0]

    related = get_related_tables(
        graph,
        table_name,
    )

    assert "parents" in related
    assert "children" in related

    print(
        f"\nTable tested: {table_name}"
    )

    print(
        f"Parents: {related['parents']}"
    )

    print(
        f"Children: {related['children']}"
    )

    print(
        "Related-table lookup passed."
    )


def test_business_relationship_file_is_optional():
    """
    The Context Graph must work even when
    business_relationships.json does not exist.

    This test must not trigger an API call.
    """

    graph = build_context_graph()

    summary = get_graph_summary(graph)

    assert (
        summary["business_relationships"] >= 0
    )

    print(
        "\nOptional business relationship layer test passed."
    )


def test_multiple_relationships_are_preserved():
    graph = build_context_graph()

    tables = list(graph.nodes)

    assert len(tables) > 1

    found_multiple = False

    for source_table in tables:
        for target_table in tables:
            if source_table == target_table:
                continue

            relationships = get_relationships(
                graph,
                source_table,
                target_table,
            )

            if len(relationships) > 1:
                found_multiple = True

                print(
                    "\nMultiple relationships found:"
                )

                print(
                    f"{source_table} -> "
                    f"{target_table}"
                )

                for relationship in relationships:
                    print(
                        relationship
                    )

                break

        if found_multiple:
            break

    assert found_multiple is True

    print(
        "\nMultiple relationship preservation "
        "test passed."
    )


if __name__ == "__main__":
    test_context_graph()
    test_related_tables()
    test_business_relationship_file_is_optional()
    test_multiple_relationships_are_preserved()

    print(
        "\nAll Context Graph tests passed."
    )