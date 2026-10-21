import express from "express";
import { RAGPipeline } from "../pipeline/rag_pipeline.js";
import { loadAllContexts } from "../context/context_store.js";
import { buildMultiSourceContextGraph, getGraphSummary } from "../context/context_graph.js";
import { ConversationStore } from "../context/conversation_store.js";
import { resolveAuthorizedWorkspace } from "../auth/authorization.js";
import { createRequestId, logRuntimeDiagnostic } from "../diagnostics/runtime_diagnostics.js";
import { filterSensitiveColumns } from "../security/sensitive_data_policy.js";
import {
  opaque_public_ref,
  project_public_response,
  public_source_descriptor
} from "../security/output_security_policy.js";

const router = express.Router();

// --------------------------------------------------
// Application services
// --------------------------------------------------

// Immutable context metadata is loaded by the pipeline; mutable history belongs
// to a server-owned conversation, never a module-global pipeline instance.
const conversationStore = new ConversationStore();

// --------------------------------------------------
// Multi-source Context Graph
// --------------------------------------------------

function loadCurrentContextGraph() {
  return buildMultiSourceContextGraph(Object.values(loadAllContexts()));
}

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
      columns: filterSensitiveColumns(data?.columns || []),
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
      source_column: data?.source_column || data?.child_column || "",
      target_column: data?.target_column || data?.parent_column || "",
      parent_table: data?.parent_table || "",
      parent_column: data?.parent_column || "",
      child_table: data?.child_table || "",
      child_column: data?.child_column || "",
      source_table: data?.source_table || "",
      target_table: data?.target_table || "",
      source_id: data?.source_id || "",
      target_source_id: data?.target_source_id || "",
      relationship_kind: data?.relationship_kind || "",
      business_relationship: data?.business_relationship || "",
      reason: data?.reason || "",
      evidence: data?.evidence || null,
      confidence: data?.confidence ?? null,
      matching_identifier_count: data?.matching_identifier_count ?? null,
      overlap_detected: data?.overlap_detected ?? null
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

function sourceDescriptorFor(source) {
  return public_source_descriptor(
    source?.source_id || source?.source,
    source?.source_type || "postgresql",
    {
      row_count: source?.row_count,
      event_count: source?.event_count,
      retrieval_status: source?.retrieval_status,
      truncated: source?.truncated
    }
  );
}

export function projectPublicSources(sources) {
  const output = [];
  const seen = new Set();

  for (const source of Array.isArray(sources) ? sources : []) {
    if (!source || typeof source !== "object") continue;
    const descriptor = sourceDescriptorFor(source);
    if (seen.has(descriptor.source_ref)) continue;
    seen.add(descriptor.source_ref);
    output.push(descriptor);
  }

  return output;
}

export function projectPublicGraph(graphData) {
  const nodes = Array.isArray(graphData?.nodes) ? graphData.nodes : [];
  const nodeRefs = new Map(nodes.map(node => [
    String(node?.id || ""),
    opaque_public_ref("node", node?.id || "")
  ]));

  const projectedNodes = nodes.map(node => {
    const source = public_source_descriptor(node?.source_id, "postgresql");
    return {
      id: nodeRefs.get(String(node?.id || "")),
      label: node?.label || "Entity",
      type: node?.type || "entity",
      source_key: source.source_key,
      source_label: source.source_label
    };
  });

  const projectedEdges = (Array.isArray(graphData?.edges) ? graphData.edges : []).map((edge, index) => ({
    id: opaque_public_ref("edge", `${edge?.source || ""}:${edge?.target || ""}:${edge?.id || index}`),
    source: nodeRefs.get(String(edge?.source || "")) || opaque_public_ref("node", edge?.source || ""),
    target: nodeRefs.get(String(edge?.target || "")) || opaque_public_ref("node", edge?.target || ""),
    label: edge?.label || "Relationship",
    type: edge?.type || "database",
    relationship_type: edge?.relationship_type || "RELATIONSHIP",
    confidence: edge?.confidence ?? null
  }));

  return { graph: { nodes: projectedNodes, edges: projectedEdges }, nodeRefs };
}

export function projectPublicGraphTrace(graphTrace, nodeRefs) {
  const mapNode = value => nodeRefs.get(String(value || "")) || opaque_public_ref("node", value || "");
  const trace = graphTrace && typeof graphTrace === "object" ? graphTrace : {};

  return {
    nodes: (Array.isArray(trace.nodes) ? trace.nodes : []).map(node => ({
      id: mapNode(node?.id),
      label: node?.label || "Entity",
      type: node?.type || "entity"
    })),
    edges: (Array.isArray(trace.edges) ? trace.edges : []).map((edge, index) => ({
      id: opaque_public_ref("edge", `${edge?.source || ""}:${edge?.target || ""}:${edge?.id || index}`),
      source: mapNode(edge?.source),
      target: mapNode(edge?.target),
      label: edge?.label || "Relationship",
      relationship_type: edge?.relationship_type || "RELATIONSHIP",
      confidence: edge?.confidence ?? null
    })),
    source_entities: (Array.isArray(trace.matched_graph_nodes) ? trace.matched_graph_nodes : []).map(mapNode),
    source_tables: (Array.isArray(trace.matched_graph_nodes) ? trace.matched_graph_nodes : []).map(mapNode),
    matched_graph_nodes: (Array.isArray(trace.matched_graph_nodes) ? trace.matched_graph_nodes : []).map(mapNode)
  };
}

export function projectPublicSourceTrace(sources, dataSources = null) {
  const sourceDescriptors = projectPublicSources(sources);
  const descriptorByKey = new Map(sourceDescriptors.map(item => [item.source_key, item]));
  const dataSourceLabels = [];

  for (const source of sourceDescriptors) {
    if (!dataSourceLabels.includes(source.source_label)) dataSourceLabels.push(source.source_label);
  }

  for (const sourceType of Array.isArray(dataSources) ? dataSources : []) {
    if (String(sourceType).toLowerCase() === "security_logs" && !dataSourceLabels.includes("Security Logs")) {
      dataSourceLabels.push("Security Logs");
    }
  }

  return {
    data_sources: dataSourceLabels,
    postgresql_sources: sourceDescriptors
      .filter(item => item.source_type === "postgresql")
      .map(item => ({ source_ref: item.source_ref, source_key: item.source_key, source_label: item.source_label })),
    external_sources: sourceDescriptors
      .filter(item => item.source_type !== "postgresql")
      .map(item => ({
        id: item.source_ref,
        source_ref: item.source_ref,
        source_key: item.source_key,
        label: item.source_label,
        source_type: item.source_type,
        event_count: item.event_count || 0,
        truncated: Boolean(item.truncated)
      }))
  };
}

// --------------------------------------------------
// Chat endpoint
// --------------------------------------------------

router.post("/chat", async (req, res) => {
  const requestId = createRequestId();
  res.setHeader("X-Request-ID", requestId);
  try {
    const rawQuestion = req.body?.question;
    const question = typeof rawQuestion === "string" ? rawQuestion.trim() : "";

    // Validate client input
    if (!question) {
      return res.status(400).json({
        detail: "Question cannot be empty."
      });
    }

    const principal = req.auth?.principal;
    const authorization = resolveAuthorizedWorkspace(principal, req.body?.workspace_id);
    const { conversation, created } = conversationStore.getOrCreate({
      conversationId: req.body?.conversation_id,
      principal,
      workspaceId: authorization.workspace_id
    });

    // A request-local orchestrator owns only the selected conversation manager.
    // Context metadata and source pools remain process-reused underneath.
    const ragPipeline = new RAGPipeline(conversation.context_manager);
    const result = await ragPipeline.ask(question, {
      workspace_id: authorization.workspace_id,
      authorization,
      request_id: requestId
    });

    // Multi-source Context Graph. Internal graph identifiers stay server-side.
    const contextGraph = loadCurrentContextGraph();
    const internalGraphData = graphToDict(contextGraph);
    const { graph: graphData, nodeRefs } = projectPublicGraph(internalGraphData);
    const graphSummary = getGraphSummary(contextGraph);

    // Provenance graph trace
    const graphTrace = projectPublicGraphTrace(
      buildGraphTrace(contextGraph, result.sources || []),
      nodeRefs
    );

    // Source trace
    const sourceTrace = projectPublicSourceTrace(result.sources || [], result.data_sources || []);
    const publicSources = projectPublicSources(result.sources || []);

    // Clean frontend response (exact 7 keys matching Python backend)
    return res.json(project_public_response({
      question,
      answer: result.answer || "",
      sources: publicSources,
      graph: graphData,
      graph_summary: graphSummary,
      graph_trace: graphTrace,
      source_trace: sourceTrace
      ,conversation_id: conversation.id
      ,conversation_created: created
    }));
  } catch (err) {
    logRuntimeDiagnostic(err, { requestId, phase: "chat_request" });

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
    const freshContextGraph = loadCurrentContextGraph();
    const { graph: graphData } = projectPublicGraph(graphToDict(freshContextGraph));
    const graphSummary = getGraphSummary(freshContextGraph);

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

