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


def load_business_relationships(
    source_id: str | None = None,
) -> list[dict[str, Any]]:
    """
    Load validated business relationships from local storage.

    If source_id is provided, only relationships belonging
    to that source are returned.

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

    relationships = data.get(
        "relationships",
        [],
    )

    if not isinstance(
        relationships,
        list,
    ):
        return []

    if source_id is None:
        return relationships

    return [
        relationship
        for relationship in relationships
        if relationship.get(
            "source_id"
        ) == source_id
    ]


def make_node_id(
    source_id: str,
    table_name: str,
) -> str:
    """
    Create a globally unique graph node ID.

    The database source and actual table name are kept
    separate from the database itself.
    """

    return f"{source_id}:{table_name}"


def build_context_graph(
    context: dict[str, Any] | None = None,
    business_relationships: list[
        dict[str, Any]
    ] | None = None,
) -> nx.MultiDiGraph:
    """
    Build the Context Graph from:

    1. Automatically discovered database schema
    2. Validated business relationships

    This function only builds an in-memory graph.
    It never modifies PostgreSQL.
    """

    if context is None:
        context = load_context()

    source_id = context.get(
        "source_id",
        "db1",
    )

    if business_relationships is None:
        business_relationships = (
            load_business_relationships(
                source_id=source_id
            )
        )

    graph = nx.MultiDiGraph()

    tables = context.get(
        "tables",
        {}
    )

    database_relationships = context.get(
        "relationships",
        []
    )

    # --------------------------------------------------
    # 1. Add table nodes
    # --------------------------------------------------

    for table_name, table_info in tables.items():

        node_id = make_node_id(
            source_id,
            table_name,
        )

        columns = table_info.get(
            "columns",
            [],
        )

        primary_keys = table_info.get(
            "primary_keys",
            [],
        )

        graph.add_node(
            node_id,
            node_type="table",
            source_id=source_id,
            table_name=table_name,
            columns=columns,
            primary_keys=primary_keys,
        )

    # --------------------------------------------------
    # 2. Add database relationships
    # --------------------------------------------------

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

        child_node = make_node_id(
            source_id,
            child_table,
        )

        parent_node = make_node_id(
            source_id,
            parent_table,
        )

        if (
            child_node not in graph
            or parent_node not in graph
        ):
            continue

        evidence = (
            f"{child_table}.{child_column} -> "
            f"{parent_table}.{parent_column}"
        )

        graph.add_edge(
            parent_node,
            child_node,
            relationship_type=(
                "DATABASE_RELATIONSHIP"
            ),
            database_relationship_type=(
                relationship.get(
                    "relationship_type",
                    "FOREIGN_KEY",
                )
            ),
            source_id=source_id,
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

    # --------------------------------------------------
    # 3. Add business relationships
    # --------------------------------------------------

    for relationship in business_relationships:

        relationship_source_id = (
            relationship.get(
                "source_id",
                source_id,
            )
        )

        # Current stage only allows relationships
        # belonging to this context.
        if relationship_source_id != source_id:
            continue

        source_table = relationship.get(
            "source_table"
        )

        target_table = relationship.get(
            "target_table"
        )

        if not source_table or not target_table:
            continue

        source_node = make_node_id(
            source_id,
            source_table,
        )

        target_node = make_node_id(
            source_id,
            target_table,
        )

        if (
            source_node not in graph
            or target_node not in graph
        ):
            continue

        graph.add_edge(
            source_node,
            target_node,
            relationship_type=(
                "BUSINESS_RELATIONSHIP"
            ),
            source_id=source_id,
            business_relationship=(
                relationship.get(
                    "business_relationship"
                )
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


def build_multi_source_context_graph(
    contexts: list[dict[str, Any]],
    business_relationships: list[dict[str, Any]] | None = None,
) -> nx.MultiDiGraph:
    """
    Build one source-aware Context Graph from multiple
    independently discovered database contexts.

    Each source keeps its own namespace:

        db1:table_name
        db2:table_name

    No cross-source relationships are inferred here.
    """

    graph = nx.MultiDiGraph()

    if business_relationships is None:
        business_relationships = []

        for context in contexts:
            source_id = context.get("source_id")

            if source_id:
                business_relationships.extend(
                    load_business_relationships(
                        source_id=source_id
                    )
                )

    for context in contexts:
        source_id = context.get("source_id")

        if not source_id:
            continue

        tables = context.get("tables", {})
        database_relationships = context.get(
            "relationships",
            [],
        )

        # --------------------------------------------------
        # Add table nodes
        # --------------------------------------------------

        for table_name, table_info in tables.items():
            node_id = make_node_id(
                source_id,
                table_name,
            )

            graph.add_node(
                node_id,
                node_type="table",
                source_id=source_id,
                table_name=table_name,
                columns=table_info.get(
                    "columns",
                    [],
                ),
                primary_keys=table_info.get(
                    "primary_keys",
                    [],
                ),
            )

        # --------------------------------------------------
        # Add database relationships
        # --------------------------------------------------

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

            child_node = make_node_id(
                source_id,
                child_table,
            )

            parent_node = make_node_id(
                source_id,
                parent_table,
            )

            if (
                child_node not in graph
                or parent_node not in graph
            ):
                continue

            evidence = (
                f"{child_table}.{child_column} -> "
                f"{parent_table}.{parent_column}"
            )

            graph.add_edge(
                parent_node,
                child_node,
                relationship_type="DATABASE_RELATIONSHIP",
                database_relationship_type=(
                    relationship.get(
                        "relationship_type",
                        "FOREIGN_KEY",
                    )
                ),
                source_id=source_id,
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

    # ------------------------------------------------------
    # Add validated business relationships
    # ------------------------------------------------------

    for relationship in business_relationships:
        source_id = relationship.get(
            "source_id"
        )

        if not source_id:
            continue

        source_table = relationship.get(
            "source_table"
        )
        target_table = relationship.get(
            "target_table"
        )

        if not source_table or not target_table:
            continue

        source_node = make_node_id(
            source_id,
            source_table,
        )

        target_node = make_node_id(
            source_id,
            target_table,
        )

        if (
            source_node not in graph
            or target_node not in graph
        ):
            continue

        graph.add_edge(
            source_node,
            target_node,
            relationship_type="BUSINESS_RELATIONSHIP",
            source_id=source_id,
            business_relationship=(
                relationship.get(
                    "business_relationship"
                )
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
            source=relationship.get(
                "source",
                "gpt_validated",
            ),
        )

    return graph


def get_graph_summary(
    graph: nx.MultiDiGraph,
) -> dict[str, int]:

    database_relationships = 0
    business_relationships = 0

    for _, _, data in graph.edges(
        data=True
    ):

        relationship_type = data.get(
            "relationship_type"
        )

        if (
            relationship_type
            == "DATABASE_RELATIONSHIP"
        ):
            database_relationships += 1

        elif (
            relationship_type
            == "BUSINESS_RELATIONSHIP"
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
    source_id: str = "db1",
) -> dict[str, list[str]]:

    node_id = make_node_id(
        source_id,
        table_name,
    )

    if node_id not in graph:
        return {
            "parents": [],
            "children": [],
        }

    parents = [
        graph.nodes[node].get(
            "table_name",
            node,
        )
        for node in graph.predecessors(
            node_id
        )
    ]

    children = [
        graph.nodes[node].get(
            "table_name",
            node,
        )
        for node in graph.successors(
            node_id
        )
    ]

    return {
        "parents": sorted(parents),
        "children": sorted(children),
    }


def get_relationships(
    graph: nx.MultiDiGraph,
    source_table: str,
    target_table: str,
    source_id: str = "db1",
) -> list[dict[str, Any]]:

    source_node = make_node_id(
        source_id,
        source_table,
    )

    target_node = make_node_id(
        source_id,
        target_table,
    )

    if not graph.has_edge(
        source_node,
        target_node,
    ):
        return []

    relationships = []

    edge_data = graph.get_edge_data(
        source_node,
        target_node,
    )

    if not edge_data:
        return []

    for _, relationship in edge_data.items():
        relationships.append(
            dict(relationship)
        )

    return relationships