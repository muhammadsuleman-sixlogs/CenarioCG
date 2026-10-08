import express from "express";
import { RAGPipeline } from "../pipeline/rag_pipeline.js";
import { loadAllContexts } from "../context/context_store.js";
import { buildMultiSourceContextGraph, getGraphSummary } from "../context/context_graph.js";

const router = express.Router();

// --------------------------------------------------
// Application services
// --------------------------------------------------

// Create the existing RAG pipeline once when the backend starts.
const ragPipeline = new RAGPipeline();

// --------------------------------------------------
// Multi-source Context Graph
// --------------------------------------------------

// Load all available PostgreSQL Context Layers:
// { "db1": {...}, "db2": {...} }
// Pass values to the graph builder.
const contexts = Object.values(loadAllContexts());
const contextGraph = buildMultiSourceContextGraph(contexts);

// --------------------------------------------------
// Graph serialization
// --------------------------------------------------

/**
 * Convert the multi-source Context Graph into
 * JSON-friendly data for the frontend.
 */
export function graphToDict(graph) {
  const nodes = [];

  for (const [nodeId, data] of graph.nodes({ data: true })) {
    const strNodeId = String(nodeId);
    let sourceId = data?.source_id;

    // Fallback for source-aware graph IDs. Example: db1:project_tasks
    if (!sourceId && strNodeId.includes(":")) {
      sourceId = strNodeId.split(":")[0];
    }

    nodes.push({
      id: strNodeId,
      label: data?.table_name || strNodeId,
      type: data?.node_type || "entity",
      source_id: sourceId,
      columns: data?.columns || [],
      primary_keys: data?.primary_keys || []
    });
  }

  const edges = [];

  for (const [source, target, data] of graph.edges({ data: true })) {
    const relationshipType = data?.relationship_type || "DATABASE_RELATIONSHIP";
    let edgeType = "database";
    let label;

    if (relationshipType === "BUSINESS_RELATIONSHIP") {
      edgeType = "business";
      label = data?.business_relationship || relationshipType;
    } else if (relationshipType === "CROSS_SOURCE_RELATIONSHIP") {
      edgeType = "cross_source";
      label = data?.relationship_kind || "CROSS_SOURCE";
    } else {
      edgeType = "database";
      label = data?.database_relationship_type || relationshipType;
    }

    edges.push({
      id: `${source}-${target}-${edges.length}`,
      source: String(source),
      target: String(target),
      label,
      type: edgeType,
      relationship_type: relationshipType,
      source_column: data?.source_column || "",
      target_column: data?.target_column || "",
      target_source_id: data?.target_source_id || "",
      relationship_kind: data?.relationship_kind || "",
      confidence: data?.confidence ?? null
    });
  }

  return { nodes, edges };
}

// --------------------------------------------------
// Graph trace
// --------------------------------------------------

/**
 * Build the visual retrieval trace from actual
 * SourceTracker provenance.
 */
export function buildGraphTrace(graph, sources) {
  const safeSources = Array.isArray(sources) ? sources : [];

  const sourceEntities = [];
  const sourceTables = [];
  const sourceTableRefs = [];

  // --------------------------------------------------
  // Collect provenance
  // --------------------------------------------------
  for (const source of safeSources) {
    if (!source || typeof source !== "object") continue;

    const sourceType = source.source_type;
    // Security logs do not belong to the PostgreSQL Context Graph.
    if (sourceType !== "postgresql") continue;

    const rawSourceId = source.source_id;
    if (!rawSourceId) continue;
    const sourceId = String(rawSourceId);

    // Entities
    for (const entity of source.entities || []) {
      if (!entity) continue;
      const strEntity = String(entity);
      if (!sourceEntities.includes(strEntity)) {
        sourceEntities.push(strEntity);
      }
      const nodeId = `${sourceId}:${strEntity}`;
      if (graph.hasNode(nodeId) && !sourceTableRefs.includes(nodeId)) {
        sourceTableRefs.push(nodeId);
      }
    }

    // Tables
    for (const table of source.tables || []) {
      if (!table) continue;
      const strTable = String(table);
      if (!sourceTables.includes(strTable)) {
        sourceTables.push(strTable);
      }
      const nodeId = `${sourceId}:${strTable}`;
      if (graph.hasNode(nodeId) && !sourceTableRefs.includes(nodeId)) {
        sourceTableRefs.push(nodeId);
      }
    }
  }

  // --------------------------------------------------
  // Build trace nodes
  // --------------------------------------------------
  const usedNodes = sourceTableRefs;
  const traceNodes = [];

  for (const nodeId of usedNodes) {
    const nodeData = graph.getNode(nodeId) || {};
    let sourceId = nodeData.source_id;
    if (!sourceId && String(nodeId).includes(":")) {
      sourceId = String(nodeId).split(":")[0];
    }

    traceNodes.push({
      id: String(nodeId),
      label: nodeData.table_name || String(nodeId),
      type: nodeData.node_type || "entity",
      source_id: sourceId
    });
  }

  // --------------------------------------------------
  // Build trace edges
  // --------------------------------------------------
  const traceEdges = [];

  for (const sourceNode of usedNodes) {
    for (const targetNode of usedNodes) {
      if (sourceNode === targetNode) continue;
      if (!graph.hasEdge(sourceNode, targetNode)) continue;

      const edgeData = graph.getEdgeData(sourceNode, targetNode);
      if (!edgeData) continue;

      // In MultiDiGraph, edgeData is an object mapping edge_key -> relationship dict
      let relationships;
      if (
        typeof edgeData === "object" &&
        Object.values(edgeData).every(
          val =>
            val &&
            typeof val === "object" &&
            ("relationship_type" in val || "source_table" in val || "target_table" in val)
        )
      ) {
        relationships = Object.entries(edgeData);
      } else {
        relationships = [[0, edgeData]];
      }

      for (const [edgeKey, relationship] of relationships) {
        if (!relationship || typeof relationship !== "object") continue;

        const relationshipType = relationship.relationship_type || "RELATIONSHIP";
        let label;

        if (relationshipType === "BUSINESS_RELATIONSHIP") {
          label = relationship.business_relationship || relationshipType;
        } else if (relationshipType === "CROSS_SOURCE_RELATIONSHIP") {
          label = relationship.relationship_kind || "CROSS_SOURCE";
        } else {
          label = relationship.database_relationship_type || relationshipType;
        }

        traceEdges.push({
          id: `${sourceNode}-${targetNode}-${edgeKey}`,
          source: String(sourceNode),
          target: String(targetNode),
          label,
          relationship_type: relationshipType,
          relationship_kind: relationship.relationship_kind ?? null,
          confidence: relationship.confidence ?? null
        });
      }
    }
  }

  return {
    nodes: traceNodes,
    edges: traceEdges,
    source_entities: sourceEntities,
    source_tables: sourceTables,
    matched_graph_nodes: usedNodes
  };
}

// --------------------------------------------------
// Source trace
// --------------------------------------------------

/**
 * Build a frontend-friendly representation of the
 * actual sources used for the current answer.
 */
export function buildSourceTrace(sources, dataSources = null) {
  const safeSources = Array.isArray(sources) ? sources : [];
  const rawDataSources = Array.isArray(dataSources) ? dataSources : [];

  const normalizedDataSources = [];
  for (const sourceName of rawDataSources) {
    if (!sourceName) continue;
    const strName = String(sourceName);
    if (!normalizedDataSources.includes(strName)) {
      normalizedDataSources.push(strName);
    }
  }

  // PostgreSQL sources
  const postgresqlSources = [];
  for (const source of safeSources) {
    if (!source || typeof source !== "object") continue;
    if (source.source_type !== "postgresql") continue;

    const sourceId = source.source_id;
    if (!sourceId) continue;
    const strSourceId = String(sourceId);

    if (!postgresqlSources.includes(strSourceId)) {
      postgresqlSources.push(strSourceId);
    }
  }

  // External sources (Security Logs)
  const externalSources = [];
  for (const source of safeSources) {
    if (!source || typeof source !== "object") continue;
    const sourceType = source.source_type;

    if (sourceType === "security_logs_api") {
      externalSources.push({
        id: "security_logs",
        label: "Security Logs",
        type: "security_logs",
        source_type: sourceType,
        source: source.source || "security_logs",
        event_count: source.event_count || 0,
        truncated: Boolean(source.truncated)
      });
    }
  }

  return {
    data_sources: normalizedDataSources,
    postgresql_sources: postgresqlSources,
    external_sources: externalSources
  };
}

// --------------------------------------------------
// Chat endpoint
// --------------------------------------------------

router.post("/chat", async (req, res) => {
  try {
    const rawQuestion = req.body?.question;
    const question = typeof rawQuestion === "string" ? rawQuestion.trim() : "";

    // Validate client input
    if (!question) {
      return res.status(400).json({
        detail: "Question cannot be empty."
      });
    }

    // Existing RAG pipeline
    const result = await ragPipeline.ask(question);

    // Multi-source Context Graph
    const graphData = graphToDict(contextGraph);
    const graphSummary = getGraphSummary(contextGraph);

    // Provenance graph trace
    const graphTrace = buildGraphTrace(contextGraph, result.sources || []);

    // Source trace
    const sourceTrace = buildSourceTrace(result.sources || [], result.data_sources || []);

    // Clean frontend response (exact 7 keys matching Python backend)
    return res.json({
      question,
      answer: result.answer || "",
      sources: result.sources || [],
      graph: graphData,
      graph_summary: graphSummary,
      graph_trace: graphTrace,
      source_trace: sourceTrace
    });
  } catch (err) {
    console.error(`CHAT ERROR: ${err.name || "Error"}: ${err.message || err}`);

    const status = err.statusCode || err.status;
    if (status && status < 500) {
      return res.status(status).json({
        detail: err.detail || err.message || "Invalid request."
      });
    }

    return res.status(500).json({
      detail: "Unable to process the question."
    });
  }
});

// --------------------------------------------------
// Graph endpoint
// --------------------------------------------------

router.get("/graph", (req, res) => {
  try {
    const graphData = graphToDict(contextGraph);
    const graphSummary = getGraphSummary(contextGraph);

    return res.json({
      graph: graphData,
      graph_summary: graphSummary
    });
  } catch (err) {
    console.error(`GRAPH ERROR: ${err.name || "Error"}: ${err.message || err}`);

    return res.status(500).json({
      detail: "Unable to load context graph."
    });
  }
});

export default router;

