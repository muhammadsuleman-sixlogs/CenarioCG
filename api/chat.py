from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from pipeline.rag_pipeline import RAGPipeline
from context.context_graph import (
    build_context_graph,
    get_graph_summary,
)

router = APIRouter()


# Create the existing RAG pipeline once when the backend starts.
rag_pipeline = RAGPipeline()


# Build the existing Context Graph once when the backend starts.
context_graph = build_context_graph()


class ChatRequest(BaseModel):
    question: str


def graph_to_dict(graph):
    """
    Convert the existing NetworkX Context Graph
    into JSON-friendly data for the frontend.
    """

    nodes = []

    for node, data in graph.nodes(data=True):
        nodes.append(
            {
                "id": str(node),
                "label": data.get("table_name", node),
                "type": data.get("node_type", "entity"),
                "columns": data.get("columns", []),
                "primary_keys": data.get("primary_keys", []),
            }
        )

    edges = []

    for source, target, data in graph.edges(data=True):
        relationship_type = data.get(
            "relationship_type",
            "DATABASE_RELATIONSHIP",
        )

        if relationship_type == "BUSINESS_RELATIONSHIP":
            edge_type = "business"

            label = (
                data.get("business_relationship")
                or relationship_type
            )
        else:
            edge_type = "database"

            label = (
                data.get("database_relationship_type")
                or relationship_type
            )

        edges.append(
            {
                "id": (
                    f"{source}-{target}-"
                    f"{len(edges)}"
                ),
                "source": str(source),
                "target": str(target),
                "label": label,
                "type": edge_type,
                "relationship_type": relationship_type,
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


def build_graph_trace(
    graph,
    sources: list[dict],
) -> dict:
    """
    Build the visual trace from the actual provenance
    returned by SourceTracker.

    No database/table names are hardcoded.
    """

    source_entities = []
    source_tables = []

    for source in sources:
        for entity in source.get("entities", []):
            if entity:
                entity = str(entity)

                if entity not in source_entities:
                    source_entities.append(entity)

        for table in source.get("tables", []):
            if table:
                table = str(table)

                if table not in source_tables:
                    source_tables.append(table)

    # Entities that actually exist as graph nodes.
    used_nodes = [
        entity
        for entity in source_entities
        if entity in graph
    ]

    # If SourceTracker has tables that weren't included
    # in entities, include those too.
    for table in source_tables:
        if table in graph and table not in used_nodes:
            used_nodes.append(table)

    trace_nodes = []

    for table in used_nodes:
        node_data = graph.nodes[table]

        trace_nodes.append(
            {
                "id": str(table),
                "label": node_data.get(
                    "table_name",
                    table,
                ),
                "type": node_data.get(
                    "node_type",
                    "entity",
                ),
            }
        )

    trace_edges = []

    # Find real relationships between the retrieved nodes.
    for source_table in used_nodes:
        for target_table in used_nodes:

            if source_table == target_table:
                continue

            if not graph.has_edge(
                source_table,
                target_table,
            ):
                continue

            edge_data = graph.get_edge_data(
                source_table,
                target_table,
            )

            if not edge_data:
                continue

            for edge_key, relationship in edge_data.items():

                trace_edges.append(
                    {
                        "id": (
                            f"{source_table}-"
                            f"{target_table}-"
                            f"{edge_key}"
                        ),
                        "source": str(source_table),
                        "target": str(target_table),
                        "label": (
                            relationship.get(
                                "business_relationship"
                            )
                            or relationship.get(
                                "database_relationship_type"
                            )
                            or relationship.get(
                                "relationship_type",
                                "RELATIONSHIP",
                            )
                        ),
                        "relationship_type": relationship.get(
                            "relationship_type"
                        ),
                        "confidence": relationship.get(
                            "confidence"
                        ),
                    }
                )

    return {
        "nodes": trace_nodes,
        "edges": trace_edges,

        # Keep original provenance visible to frontend for source attribution
        "source_entities": source_entities,
        "source_tables": source_tables,

        "matched_graph_nodes": used_nodes,
    }


@router.post("/chat")
def chat(request: ChatRequest):
    """
    Run the existing RAG pipeline and return
    only the information required by the frontend.

    PostgreSQL remains read-only because this endpoint
    uses the existing RAGPipeline/retrieval executor.
    """

    try:
        question = request.question.strip()

        if not question:
            raise ValueError(
                "Question cannot be empty."
            )

        # -----------------------------------------
        # Existing RAG pipeline
        # -----------------------------------------

        result = rag_pipeline.ask(question)

        # -----------------------------------------
        # Existing Context Graph
        # -----------------------------------------

        graph_data = graph_to_dict(context_graph)

        graph_summary = get_graph_summary(
            context_graph
        )

        graph_trace = build_graph_trace(
            context_graph,
            result.get("sources", []),
        )

        # -----------------------------------------
        # Clean frontend response
        # -----------------------------------------

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
            "graph": graph_data,
            "graph_summary": graph_summary,
            "graph_trace": graph_trace,
        }

    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        )

    except Exception as exc:
        print(f"CHAT ERROR: {type(exc).__name__}: {exc}")

        raise HTTPException(
            status_code=500,
            detail="Unable to process the question.",
        )


@router.get("/graph")
def get_graph():
    """
    Fetch the initial Context Graph structure and
    summary metrics for initial rendering.
    """
    try:
        graph_data = graph_to_dict(context_graph)
        graph_summary = get_graph_summary(context_graph)

        return {
            "graph": graph_data,
            "graph_summary": graph_summary,
        }

    except Exception:
        raise HTTPException(
            status_code=500,
            detail="Unable to load context graph.",
        )