import json
from pathlib import Path
from typing import Any

import networkx as nx

CONTEXT_FILE = (
    Path(__file__).resolve().parent
    / "context.json"
)

BUSINESS_LOGIC_FILE = (
    Path(__file__).resolve().parent
    / "business_relationships.json"
)


def load_context() -> dict[str, Any]:
    """
    Load the automatically discovered database context
    from local storage.

    PostgreSQL is not accessed here.
    """

    if not CONTEXT_FILE.exists():
        raise FileNotFoundError(
            f"Context file not found: {CONTEXT_FILE}"
        )

    with open(
        CONTEXT_FILE,
        "r",
        encoding="utf-8",
    ) as file:
        return json.load(file)


def load_business_relationships() -> list[dict[str, Any]]:
    """
    Load validated business relationships from local storage.

    If business relationships have not yet been generated,
    return an empty list.

    PostgreSQL is not accessed here.
    """

    if not BUSINESS_LOGIC_FILE.exists():
        return []

    with open(
        BUSINESS_LOGIC_FILE,
        "r",
        encoding="utf-8",
    ) as file:
        data = json.load(file)

    return data.get(
        "relationships",
        [],
    )


def build_context_graph(
    context: dict[str, Any] | None = None,
    business_relationships: list[dict[str, Any]] | None = None,
) -> nx.MultiDiGraph:
    """
    Build the Context Graph from:

    1. Automatically discovered PostgreSQL schema
    2. Validated business relationships

    This function only builds an in-memory graph.
    It never modifies PostgreSQL.
    """

    if context is None:
        context = load_context()

    if business_relationships is None:
        business_relationships = (
            load_business_relationships()
        )

    graph = nx.MultiDiGraph()

    tables = context.get(
        "tables",
        {},
    )

    database_relationships = context.get(
        "relationships",
        [],
    )

    # -----------------------------------------------------
    # Add table nodes
    # -----------------------------------------------------

    for table_name, table_info in tables.items():
        columns = table_info.get(
            "columns",
            [],
        )

        primary_keys = table_info.get(
            "primary_keys",
            [],
        )

        graph.add_node(
            table_name,
            node_type="table",
            table_name=table_name,
            columns=columns,
            primary_keys=primary_keys,
        )

    # -----------------------------------------------------
    # Add PostgreSQL-derived relationships
    # -----------------------------------------------------

    for relationship in database_relationships:
        child_table = relationship.get(
            "source_table"
        )

        child_column = relationship.get(
            "source_column"
        )

        parent_table = relationship.get(
            "target_table"
        )

        parent_column = relationship.get(
            "target_column"
        )

        if not child_table or not parent_table:
            continue

        evidence = (
            f"{child_table}.{child_column} -> "
            f"{parent_table}.{parent_column}"
        )

        graph.add_edge(
            parent_table,
            child_table,
            relationship_type="DATABASE_RELATIONSHIP",
            database_relationship_type=relationship.get(
                "relationship_type",
                "FOREIGN_KEY",
            ),
            parent_table=parent_table,
            parent_column=parent_column,
            child_table=child_table,
            child_column=child_column,
            evidence=evidence,
            confidence=relationship.get(
                "confidence",
                1.0,
            ),
            source=relationship.get(
                "source",
                "postgresql_foreign_key",
            ),
        )

    # -----------------------------------------------------
    # Add validated business relationships
    # -----------------------------------------------------

    for relationship in business_relationships:
        source_table = relationship.get(
            "source_table"
        )

        target_table = relationship.get(
            "target_table"
        )

        if not source_table or not target_table:
            continue

        if (
            source_table not in graph
            or target_table not in graph
        ):
            continue

        graph.add_edge(
            source_table,
            target_table,
            relationship_type="BUSINESS_RELATIONSHIP",
            business_relationship=relationship.get(
                "business_relationship"
            ),
            reason=relationship.get(
                "reason"
            ),
            evidence=relationship.get(
                "evidence",
                [],
            ),
            confidence=relationship.get(
                "confidence",
                0.0,
            ),
            source="gpt_validated",
        )

    return graph


def get_graph_summary(
    graph: nx.MultiDiGraph,
) -> dict[str, int]:
    """
    Return basic graph statistics.
    """

    database_relationships = 0
    business_relationships = 0

    for _, _, data in graph.edges(
        data=True
    ):
        relationship_type = data.get(
            "relationship_type"
        )

        if relationship_type == (
            "DATABASE_RELATIONSHIP"
        ):
            database_relationships += 1

        elif relationship_type == (
            "BUSINESS_RELATIONSHIP"
        ):
            business_relationships += 1

    return {
        "nodes": graph.number_of_nodes(),
        "edges": graph.number_of_edges(),
        "database_relationships": (
            database_relationships
        ),
        "business_relationships": (
            business_relationships
        ),
    }


def get_related_tables(
    graph: nx.MultiDiGraph,
    table_name: str,
) -> dict[str, list[str]]:
    """
    Return tables connected to a table.
    """

    if table_name not in graph:
        return {
            "parents": [],
            "children": [],
        }

    parents = list(
        graph.predecessors(table_name)
    )

    children = list(
        graph.successors(table_name)
    )

    return {
        "parents": sorted(parents),
        "children": sorted(children),
    }


def get_relationships(
    graph: nx.MultiDiGraph,
    source_table: str,
    target_table: str,
) -> list[dict[str, Any]]:
    """
    Return all relationship metadata between two tables.

    Multiple database or business relationships can exist
    between the same pair of tables.
    """

    if not graph.has_edge(
        source_table,
        target_table,
    ):
        return []

    relationships = []

    edge_data = graph.get_edge_data(
        source_table,
        target_table,
    )

    if not edge_data:
        return []

    for _, relationship in edge_data.items():
        relationships.append(
            dict(relationship)
        )

    return relationships