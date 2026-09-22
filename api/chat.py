from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from pipeline.rag_pipeline import RAGPipeline

from context.context_store import (
    load_all_contexts,
)

from context.context_graph import (
    build_multi_source_context_graph,
    get_graph_summary,
)


router = APIRouter()


# --------------------------------------------------
# Application services
# --------------------------------------------------

# Create the existing RAG pipeline once when the backend starts.
rag_pipeline = RAGPipeline()


# --------------------------------------------------
# Multi-source Context Graph
# --------------------------------------------------

# Load all available PostgreSQL Context Layers.
#
# {
#     "db1": {...},
#     "db2": {...}
# }
#
# Convert dictionary values to a list so the graph builder receives:
#
# [
#     DB1 context dictionary,
#     DB2 context dictionary
# ]
#
# The Context Graph keeps each source isolated while using
# source-qualified node IDs such as:
#
#     db1:project_tasks
#     db2:transcripts
#
# No table names are hardcoded here.

contexts = list(
    load_all_contexts().values()
)

context_graph = build_multi_source_context_graph(
    contexts=contexts
)


# --------------------------------------------------
# Request model
# --------------------------------------------------

class ChatRequest(BaseModel):
    question: str
    workspace_id: str | None = None


# --------------------------------------------------
# Graph serialization
# --------------------------------------------------

def graph_to_dict(graph):
    """
    Convert the multi-source NetworkX Context Graph into
    JSON-friendly data for the frontend.
    """

    nodes = []

    for node, data in graph.nodes(data=True):
        node_id = str(node)

        source_id = data.get(
            "source_id"
        )

        # Fallback for source-aware graph IDs.
        #
        # Example:
        #     db1:project_tasks

        if not source_id and ":" in node_id:
            source_id = node_id.split(
                ":",
                1,
            )[0]

        nodes.append(
            {
                "id": node_id,
                "label": data.get(
                    "table_name",
                    node_id,
                ),
                "type": data.get(
                    "node_type",
                    "entity",
                ),
                "source_id": source_id,
                "columns": data.get(
                    "columns",
                    [],
                ),
                "primary_keys": data.get(
                    "primary_keys",
                    [],
                ),
            }
        )

    edges = []

    for source, target, data in graph.edges(
        data=True
    ):
        relationship_type = data.get(
            "relationship_type",
            "DATABASE_RELATIONSHIP",
        )

        if relationship_type == "BUSINESS_RELATIONSHIP":
            edge_type = "business"

            label = (
                data.get(
                    "business_relationship"
                )
                or relationship_type
            )

        else:
            edge_type = "database"

            label = (
                data.get(
                    "database_relationship_type"
                )
                or relationship_type
            )

        edges.append(
            {
                "id": (
                    f"{source}-"
                    f"{target}-"
                    f"{len(edges)}"
                ),
                "source": str(source),
                "target": str(target),
                "label": label,
                "type": edge_type,
                "relationship_type": (
                    relationship_type
                ),
                "source_column": data.get(
                    "source_column",
                    "",
                ),
                "target_column": data.get(
                    "target_column",
                    "",
                ),
                "confidence": data.get(
                    "confidence",
                    None,
                ),
            }
        )

    return {
        "nodes": nodes,
        "edges": edges,
    }


# --------------------------------------------------
# Graph trace
# --------------------------------------------------

def build_graph_trace(
    graph,
    sources: list[dict],
) -> dict:
    """
    Build the visual retrieval trace from actual
    SourceTracker provenance.

    PostgreSQL source-aware provenance uses:

        source_id + table

    to resolve source-qualified graph nodes.

    Example:

        source_id = db2
        table = transcripts

    becomes:

        db2:transcripts

    Security/SIEM resources are intentionally excluded
    from the PostgreSQL Context Graph because they are
    external API resources rather than PostgreSQL tables.
    """

    if not isinstance(
        sources,
        list,
    ):
        sources = []

    source_entities: list[str] = []
    source_tables: list[str] = []

    # Keep the actual source ID associated with each table/entity.
    source_table_refs: list[str] = []

    # --------------------------------------------------
    # Collect provenance
    # --------------------------------------------------

    for source in sources:
        if not isinstance(
            source,
            dict,
        ):
            continue

        source_type = source.get(
            "source_type"
        )

        # Security logs do not belong to the PostgreSQL
        # Context Graph.
        if source_type != "postgresql":
            continue

        source_id = source.get(
            "source_id"
        )

        if not source_id:
            continue

        source_id = str(
            source_id
        )

        # ----------------------------------------------
        # Entities
        # ----------------------------------------------

        for entity in source.get(
            "entities",
            [],
        ):
            if not entity:
                continue

            entity = str(entity)

            if entity not in source_entities:
                source_entities.append(
                    entity
                )

            node_id = (
                f"{source_id}:{entity}"
            )

            if (
                node_id in graph
                and node_id not in source_table_refs
            ):
                source_table_refs.append(
                    node_id
                )

        # ----------------------------------------------
        # Tables
        # ----------------------------------------------

        for table in source.get(
            "tables",
            [],
        ):
            if not table:
                continue

            table = str(table)

            if table not in source_tables:
                source_tables.append(
                    table
                )

            node_id = (
                f"{source_id}:{table}"
            )

            if (
                node_id in graph
                and node_id not in source_table_refs
            ):
                source_table_refs.append(
                    node_id
                )

    # --------------------------------------------------
    # Build trace nodes
    # --------------------------------------------------

    used_nodes = source_table_refs

    trace_nodes = []

    for node_id in used_nodes:
        node_data = graph.nodes[
            node_id
        ]

        source_id = node_data.get(
            "source_id"
        )

        if not source_id and ":" in str(node_id):
            source_id = str(node_id).split(
                ":",
                1,
            )[0]

        trace_nodes.append(
            {
                "id": str(node_id),
                "label": node_data.get(
                    "table_name",
                    node_id,
                ),
                "type": node_data.get(
                    "node_type",
                    "entity",
                ),
                "source_id": source_id,
            }
        )

    # --------------------------------------------------
    # Build trace edges
    # --------------------------------------------------

    trace_edges = []

    for source_node in used_nodes:
        for target_node in used_nodes:

            if source_node == target_node:
                continue

            if not graph.has_edge(
                source_node,
                target_node,
            ):
                continue

            edge_data = graph.get_edge_data(
                source_node,
                target_node,
            )

            if not edge_data:
                continue

            # NetworkX MultiDiGraph:
            #
            # edge_data = {
            #     edge_key: relationship_data
            # }
            #
            # NetworkX DiGraph:
            #
            # edge_data can be a relationship dict.

            if all(
                isinstance(
                    value,
                    dict,
                )
                and (
                    "relationship_type" in value
                    or "source_table" in value
                    or "target_table" in value
                )
                for value in edge_data.values()
            ):
                relationships = edge_data.items()

            else:
                relationships = [
                    (
                        0,
                        edge_data,
                    )
                ]

            for (
                edge_key,
                relationship,
            ) in relationships:

                if not isinstance(
                    relationship,
                    dict,
                ):
                    continue

                relationship_type = relationship.get(
                    "relationship_type",
                    "RELATIONSHIP",
                )

                if (
                    relationship_type
                    == "BUSINESS_RELATIONSHIP"
                ):
                    label = (
                        relationship.get(
                            "business_relationship"
                        )
                        or relationship_type
                    )

                else:
                    label = (
                        relationship.get(
                            "database_relationship_type"
                        )
                        or relationship_type
                    )

                trace_edges.append(
                    {
                        "id": (
                            f"{source_node}-"
                            f"{target_node}-"
                            f"{edge_key}"
                        ),
                        "source": str(
                            source_node
                        ),
                        "target": str(
                            target_node
                        ),
                        "label": label,
                        "relationship_type": (
                            relationship_type
                        ),
                        "confidence": (
                            relationship.get(
                                "confidence"
                            )
                        ),
                    }
                )

    return {
        "nodes": trace_nodes,
        "edges": trace_edges,

        # Preserve original provenance for
        # frontend attribution.
        "source_entities": source_entities,
        "source_tables": source_tables,
        "matched_graph_nodes": used_nodes,
    }


# --------------------------------------------------
# Source trace
# --------------------------------------------------

def build_source_trace(
    sources: list[dict],
    data_sources: list[str] | None = None,
    security_resource: str | None = None,
) -> dict:
    """
    Build a frontend-friendly representation of the
    actual sources used for the current answer.

    PostgreSQL is separated into its actual source IDs:

        db1
        db2

    Security Logs remains represented separately,
    including the exact logical security resource
    selected by the planner.
    """

    if not isinstance(
        sources,
        list,
    ):
        sources = []

    if not isinstance(
        data_sources,
        list,
    ):
        data_sources = []

    normalized_data_sources = []

    for source_name in data_sources:
        if not source_name:
            continue

        source_name = str(
            source_name
        )

        if (
            source_name
            not in normalized_data_sources
        ):
            normalized_data_sources.append(
                source_name
            )

    # --------------------------------------------------
    # PostgreSQL sources
    # --------------------------------------------------

    postgresql_sources = []

    for source in sources:
        if not isinstance(
            source,
            dict,
        ):
            continue

        if source.get(
            "source_type"
        ) != "postgresql":
            continue

        source_id = source.get(
            "source_id"
        )

        if not source_id:
            continue

        source_id = str(
            source_id
        )

        if (
            source_id
            not in postgresql_sources
        ):
            postgresql_sources.append(
                source_id
            )

    # --------------------------------------------------
    # External sources
    # --------------------------------------------------

    external_sources = []

    for source in sources:
        if not isinstance(
            source,
            dict,
        ):
            continue

        source_type = source.get(
            "source_type"
        )

        if source_type != "security_logs_api":
            continue

        # Prefer the actual resource returned by the
        # retrieval layer. Fall back to the validated
        # planner resource.
        actual_resource = source.get(
            "resource"
        )

        if not actual_resource:
            actual_resource = security_resource

        external_sources.append(
            {
                "id": "security_logs",
                "label": "Security Logs",
                "type": "security_logs",
                "source_type": source_type,

                # Exact logical SIEM resource used.
                "resource": actual_resource,

                "source": source.get(
                    "source",
                    "security_logs",
                ),

                "event_count": source.get(
                    "event_count",
                    0,
                ),

                "truncated": source.get(
                    "truncated",
                    False,
                ),

                # Workspace ID is returned only if the
                # trusted runtime retrieval layer supplied it.
                "workspace_id": source.get(
                    "workspace_id"
                ),
            }
        )

    return {
        "data_sources": (
            normalized_data_sources
        ),

        "postgresql_sources": (
            postgresql_sources
        ),

        "external_sources": (
            external_sources
        ),

        # Planner-selected resource. This is only the
        # logical resource name, never a URL/token/header.
        "security_resource": security_resource,
    }


# --------------------------------------------------
# Chat endpoint
# --------------------------------------------------

@router.post("/chat")
def chat(
    request: ChatRequest,
):
    """
    Run the existing RAG pipeline and return the
    frontend-required response.

    PostgreSQL remains read-only because the endpoint
    uses the existing RAG pipeline and read-only
    retrieval executor.

    Workspace ID is supplied through runtime request
    context and is never generated by the LLM.
    """

    try:
        question = request.question.strip()

        workspace_id = (
            request.workspace_id.strip()
            if (
                isinstance(
                    request.workspace_id,
                    str,
                )
                and request.workspace_id.strip()
            )
            else None
        )

        # --------------------------------------------------
        # Validate client input
        # --------------------------------------------------

        if not question:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Question cannot be empty."
                ),
            )

        if (
            workspace_id is not None
            and len(workspace_id) > 256
        ):
            raise HTTPException(
                status_code=400,
                detail=(
                    "workspace_id is too long."
                ),
            )

        # --------------------------------------------------
        # Existing RAG pipeline
        # --------------------------------------------------

        result = rag_pipeline.ask(
            question,
            workspace_id=workspace_id,
        )

        # --------------------------------------------------
        # Multi-source Context Graph
        # --------------------------------------------------

        graph_data = graph_to_dict(
            context_graph
        )

        graph_summary = get_graph_summary(
            context_graph
        )

        # --------------------------------------------------
        # Provenance graph trace
        # --------------------------------------------------

        graph_trace = build_graph_trace(
            context_graph,
            result.get(
                "sources",
                [],
            ),
        )

        # --------------------------------------------------
        # Source trace
        # --------------------------------------------------

        security_resource = result.get(
            "security_resource"
        )

        source_trace = build_source_trace(
            result.get(
                "sources",
                [],
            ),
            result.get(
                "data_sources",
                [],
            ),
            security_resource=security_resource,
        )

        # --------------------------------------------------
        # Clean frontend response
        # --------------------------------------------------

        return {
            "question": question,

            "answer": result.get(
                "answer",
                "",
            ),

            "sources": result.get(
                "sources",
                [],
            ),

            "data_sources": result.get(
                "data_sources",
                [],
            ),

            "security_resource": security_resource,

            "graph": graph_data,

            "graph_summary": graph_summary,

            "graph_trace": graph_trace,

            "source_trace": source_trace,
        }

    except HTTPException:
        # Preserve intentional HTTP errors.
        raise

    except Exception as exc:
        print(
            f"CHAT ERROR: "
            f"{type(exc).__name__}: {exc}"
        )

        raise HTTPException(
            status_code=500,
            detail=(
                "Unable to process the question."
            ),
        )


# --------------------------------------------------
# Graph endpoint
# --------------------------------------------------

@router.get("/graph")
def get_graph():
    """
    Return the initial multi-source Context Graph.
    """

    try:
        graph_data = graph_to_dict(
            context_graph
        )

        graph_summary = get_graph_summary(
            context_graph
        )

        return {
            "graph": graph_data,
            "graph_summary": graph_summary,
        }

    except Exception as exc:
        print(
            f"GRAPH ERROR: "
            f"{type(exc).__name__}: {exc}"
        )

        raise HTTPException(
            status_code=500,
            detail=(
                "Unable to load context graph."
            ),
        )

