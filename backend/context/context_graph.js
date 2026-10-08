import fs from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { loadBusinessRelationships } from "./business_logic_store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const CONTEXT_FILE = resolve(__dirname, "context.json");
export const BUSINESS_LOGIC_FILE = resolve(__dirname, "business_relationships.json");
export const CROSS_SOURCE_RELATIONSHIPS_FILE = resolve(__dirname, "cross_source_relationships.json");

export { loadBusinessRelationships };

/**
 * Load the automatically discovered database context from local storage.
 * PostgreSQL is not accessed here.
 */
export function loadContext() {
  if (!fs.existsSync(CONTEXT_FILE)) {
    throw new Error(`Context file not found: ${CONTEXT_FILE}`);
  }

  const data = fs.readFileSync(CONTEXT_FILE, "utf-8");
  return JSON.parse(data);
}

/**
 * Load validated cross-source relationship metadata from local storage.
 */
export function loadCrossSourceRelationships() {
  if (!fs.existsSync(CROSS_SOURCE_RELATIONSHIPS_FILE)) {
    return [];
  }

  try {
    const data = JSON.parse(fs.readFileSync(CROSS_SOURCE_RELATIONSHIPS_FILE, "utf-8"));
    if (!data || typeof data !== "object") {
      return [];
    }

    let candidates = [];
    for (const key of ["validated_relationships", "relationships", "validated", "results"]) {
      if (Array.isArray(data[key])) {
        candidates = data[key];
        break;
      }
    }

    if (!candidates.length) {
      for (const val of Object.values(data)) {
        if (val && typeof val === "object") {
          for (const key of ["validated_relationships", "relationships", "validated", "results"]) {
            if (Array.isArray(val[key])) {
              candidates = val[key];
              break;
            }
          }
          if (candidates.length) break;
        }
      }
    }

    function textValue(val) {
      if (val === null || val === undefined) return null;
      const s = String(val).trim();
      return s || null;
    }

    function nested(record, side, key) {
      const v = record[side];
      return v && typeof v === "object" ? v[key] : null;
    }

    const result = [];
    for (const item of candidates) {
      if (!item || typeof item !== "object") continue;
      const validity = item.validated ?? item.valid ?? item.accepted;
      if (validity !== undefined && validity !== true) continue;

      let sourceId =
        textValue(item.source_id) ||
        textValue(item.source_system) ||
        textValue(item.source_database) ||
        textValue(nested(item, "source", "source_id")) ||
        textValue(nested(item, "source", "system"));

      let targetId =
        textValue(item.target_source_id) ||
        textValue(item.target_system) ||
        textValue(item.target_database) ||
        textValue(nested(item, "target", "source_id")) ||
        textValue(nested(item, "target", "system"));

      const sourceTable = textValue(item.source_table) || textValue(nested(item, "source", "table"));
      const targetTable = textValue(item.target_table) || textValue(nested(item, "target", "table"));
      const sourceColumn = textValue(item.source_column) || textValue(nested(item, "source", "column"));
      const targetColumn = textValue(item.target_column) || textValue(nested(item, "target", "column"));

      if (!sourceId || !targetId || !sourceTable || !targetTable || !sourceColumn || !targetColumn) {
        continue;
      }

      sourceId = sourceId.toLowerCase();
      targetId = targetId.toLowerCase();

      if (sourceId === targetId) continue;

      result.push({
        source_id: sourceId,
        source_table: sourceTable,
        source_column: sourceColumn,
        target_source_id: targetId,
        target_table: targetTable,
        target_column: targetColumn,
        relationship_type: "CROSS_SOURCE_RELATIONSHIP",
        relationship_kind: textValue(item.relationship_kind) || textValue(item.kind) || "reference",
        confidence: item.confidence ?? null,
        matching_identifier_count: item.matching_identifier_count ?? null,
        overlap_detected: item.overlap_detected ?? null,
        evidence: item.evidence || [],
        source: item.source || "cross_source_validator"
      });
    }

    const unique = new Map();
    for (const rel of result) {
      const key = `${rel.source_id}:${rel.source_table}:${rel.source_column}->${rel.target_source_id}:${rel.target_table}:${rel.target_column}`;
      unique.set(key, rel);
    }

    return Array.from(unique.values());
  } catch {
    return [];
  }
}

/**
 * Create a globally unique graph node ID.
 * Example: db1:project_tasks
 */
export function makeNodeId(sourceId, tableName) {
  return `${sourceId}:${tableName}`;
}

/**
 * In-memory MultiDiGraph matching NetworkX MultiDiGraph semantics.
 */
export class MultiDiGraph {
  constructor() {
    this._nodes = new Map();
    this._adjacency = new Map(); // source -> Map<target, Array<edgeData>>
    this._predecessors = new Map(); // target -> Set<source>
  }

  addNode(id, data = {}) {
    const sId = String(id);
    this._nodes.set(sId, { ...data });
    if (!this._adjacency.has(sId)) {
      this._adjacency.set(sId, new Map());
    }
    if (!this._predecessors.has(sId)) {
      this._predecessors.set(sId, new Set());
    }
  }

  hasNode(id) {
    return this._nodes.has(String(id));
  }

  getNode(id) {
    return this._nodes.get(String(id));
  }

  addEdge(source, target, data = {}) {
    const s = String(source);
    const t = String(target);
    if (!this.hasNode(s)) this.addNode(s);
    if (!this.hasNode(t)) this.addNode(t);

    if (!this._adjacency.get(s).has(t)) {
      this._adjacency.get(s).set(t, []);
    }
    this._adjacency.get(s).get(t).push({ ...data });
    this._predecessors.get(t).add(s);
  }

  hasEdge(source, target) {
    const s = String(source);
    const t = String(target);
    return (
      this._adjacency.has(s) &&
      this._adjacency.get(s).has(t) &&
      this._adjacency.get(s).get(t).length > 0
    );
  }

  getEdgeData(source, target) {
    const s = String(source);
    const t = String(target);
    if (!this.hasEdge(s, t)) return null;

    const list = this._adjacency.get(s).get(t);
    const edgeObj = {};
    list.forEach((item, idx) => {
      edgeObj[idx] = item;
    });
    return edgeObj;
  }

  predecessors(nodeId) {
    const sId = String(nodeId);
    if (!this._predecessors.has(sId)) return [];
    return Array.from(this._predecessors.get(sId));
  }

  successors(nodeId) {
    const sId = String(nodeId);
    if (!this._adjacency.has(sId)) return [];
    return Array.from(this._adjacency.get(sId).keys());
  }

  number_of_nodes() {
    return this._nodes.size;
  }

  numberOfNodes() {
    return this._nodes.size;
  }

  number_of_edges() {
    let count = 0;
    for (const targetMap of this._adjacency.values()) {
      for (const edgeList of targetMap.values()) {
        count += edgeList.length;
      }
    }
    return count;
  }

  numberOfEdges() {
    return this.number_of_edges();
  }

  nodes(opts = { data: false }) {
    if (opts.data) {
      return Array.from(this._nodes.entries());
    }
    return Array.from(this._nodes.keys());
  }

  edges(opts = { data: false }) {
    const result = [];
    for (const [source, targetMap] of this._adjacency.entries()) {
      for (const [target, edgeList] of targetMap.entries()) {
        for (const data of edgeList) {
          if (opts.data) {
            result.push([source, target, data]);
          } else {
            result.push([source, target]);
          }
        }
      }
    }
    return result;
  }
}

/**
 * Build a single-source Context Graph from schema and business relationships.
 */
export function buildContextGraph(context = null, businessRelationships = null) {
  let activeContext = context;
  if (!activeContext) {
    activeContext = loadContext();
  }

  const sourceId = activeContext?.source_id || "db1";

  let bizRels = businessRelationships;
  if (!bizRels) {
    bizRels = loadBusinessRelationships(sourceId);
  }

  const graph = new MultiDiGraph();
  const tables = activeContext?.tables || {};
  const databaseRelationships = activeContext?.relationships || [];

  // 1. Add table nodes
  for (const [tableName, tableInfo] of Object.entries(tables)) {
    const nodeId = makeNodeId(sourceId, tableName);
    graph.addNode(nodeId, {
      node_type: "table",
      source_id: sourceId,
      table_name: tableName,
      columns: tableInfo?.columns || [],
      primary_keys: tableInfo?.primary_keys || []
    });
  }

  // 2. Add database relationships (parent -> child)
  for (const relationship of databaseRelationships) {
    const childTable = relationship.source_table;
    const childColumn = relationship.source_column;
    const parentTable = relationship.target_table;
    const parentColumn = relationship.target_column;

    if (!childTable || !parentTable) continue;

    const childNode = makeNodeId(sourceId, childTable);
    const parentNode = makeNodeId(sourceId, parentTable);

    if (!graph.hasNode(childNode) || !graph.hasNode(parentNode)) continue;

    const evidence = `${childTable}.${childColumn} -> ${parentTable}.${parentColumn}`;

    graph.addEdge(parentNode, childNode, {
      relationship_type: "DATABASE_RELATIONSHIP",
      database_relationship_type: relationship.relationship_type || "FOREIGN_KEY",
      source_id: sourceId,
      parent_table: parentTable,
      parent_column: parentColumn,
      child_table: childTable,
      child_column: childColumn,
      source_column: relationship.source_column || "",
      target_column: relationship.target_column || "",
      target_source_id: sourceId,
      evidence,
      confidence: relationship.confidence ?? 1.0,
      source: relationship.source || "postgresql_foreign_key"
    });
  }

  // 3. Add business relationships
  for (const relationship of bizRels) {
    const relSourceId = relationship.source_id || sourceId;
    if (relSourceId !== sourceId) continue;

    const sourceTable = relationship.source_table;
    const targetTable = relationship.target_table;
    if (!sourceTable || !targetTable) continue;

    const sourceNode = makeNodeId(sourceId, sourceTable);
    const targetNode = makeNodeId(sourceId, targetTable);

    if (!graph.hasNode(sourceNode) || !graph.hasNode(targetNode)) continue;

    graph.addEdge(sourceNode, targetNode, {
      relationship_type: "BUSINESS_RELATIONSHIP",
      source_id: sourceId,
      target_source_id: sourceId,
      business_relationship: relationship.business_relationship || "BUSINESS_RELATIONSHIP",
      reason: relationship.reason,
      evidence: relationship.evidence || [],
      confidence: relationship.confidence || 0.0,
      source: "gpt_validated"
    });
  }

  return graph;
}

/**
 * Build one source-aware Context Graph from multiple independently discovered contexts.
 */
export function buildMultiSourceContextGraph(contexts, businessRelationships = null) {
  const graph = new MultiDiGraph();

  let businessRels = businessRelationships;
  if (!businessRels) {
    businessRels = [];
    for (const context of contexts) {
      const sourceId = context.source_id;
      if (sourceId) {
        businessRels.push(...loadBusinessRelationships(sourceId));
      }
    }
  }

  // 1. Add table nodes and intra-database foreign keys
  for (const context of contexts) {
    const sourceId = context.source_id;
    if (!sourceId) continue;

    const tables = context.tables || {};
    const databaseRelationships = context.relationships || [];

    for (const [tableName, tableInfo] of Object.entries(tables)) {
      const nodeId = makeNodeId(sourceId, tableName);
      graph.addNode(nodeId, {
        node_type: "table",
        source_id: sourceId,
        table_name: tableName,
        columns: tableInfo.columns || [],
        primary_keys: tableInfo.primary_keys || []
      });
    }

    for (const relationship of databaseRelationships) {
      const childTable = relationship.source_table;
      const childColumn = relationship.source_column;
      const parentTable = relationship.target_table;
      const parentColumn = relationship.target_column;

      if (!childTable || !parentTable) continue;

      const childNode = makeNodeId(sourceId, childTable);
      const parentNode = makeNodeId(sourceId, parentTable);

      if (graph.hasNode(childNode) && graph.hasNode(parentNode)) {
        const evidence = `${childTable}.${childColumn} -> ${parentTable}.${parentColumn}`;

        graph.addEdge(parentNode, childNode, {
          relationship_type: "DATABASE_RELATIONSHIP",
          database_relationship_type: relationship.relationship_type || "FOREIGN_KEY",
          source_id: sourceId,
          parent_table: parentTable,
          parent_column: parentColumn,
          child_table: childTable,
          child_column: childColumn,
          source_column: relationship.source_column || "",
          target_column: relationship.target_column || "",
          target_source_id: sourceId,
          evidence,
          confidence: relationship.confidence ?? 1.0,
          source: relationship.source || "postgresql_foreign_key"
        });
      }
    }
  }

  // 2. Add validated business relationships
  for (const relationship of businessRels) {
    const sourceId = relationship.source_id;
    const sourceTable = relationship.source_table;
    const targetTable = relationship.target_table;
    if (!sourceId || !sourceTable || !targetTable) continue;

    const sourceNode = makeNodeId(sourceId, sourceTable);
    const targetNode = makeNodeId(sourceId, targetTable);

    if (graph.hasNode(sourceNode) && graph.hasNode(targetNode)) {
      graph.addEdge(sourceNode, targetNode, {
        relationship_type: "BUSINESS_RELATIONSHIP",
        source_id: sourceId,
        target_source_id: sourceId,
        business_relationship: relationship.business_relationship || "BUSINESS_RELATIONSHIP",
        reason: relationship.reason,
        evidence: relationship.evidence || [],
        confidence: relationship.confidence || 0.0,
        source: "gpt_validated"
      });
    }
  }

  // 3. Add validated cross-source relationships
  const crossSourceRels = loadCrossSourceRelationships();
  for (const rel of crossSourceRels) {
    const sourceNode = makeNodeId(rel.source_id, rel.source_table);
    const targetNode = makeNodeId(rel.target_source_id, rel.target_table);

    if (graph.hasNode(sourceNode) && graph.hasNode(targetNode)) {
      const evidence = `${rel.source_id}:${rel.source_table}.${rel.source_column} -> ${rel.target_source_id}:${rel.target_table}.${rel.target_column}`;

      graph.addEdge(sourceNode, targetNode, {
        relationship_type: "CROSS_SOURCE_RELATIONSHIP",
        relationship_kind: rel.relationship_kind || "reference",
        source_id: rel.source_id,
        target_source_id: rel.target_source_id,
        source_table: rel.source_table,
        target_table: rel.target_table,
        source_column: rel.source_column,
        target_column: rel.target_column,
        evidence,
        confidence: rel.confidence ?? null,
        matching_identifier_count: rel.matching_identifier_count ?? null,
        overlap_detected: rel.overlap_detected ?? null,
        source: rel.source || "cross_source_validator"
      });
    }
  }

  return graph;
}

/**
 * Return summary statistics for the Context Graph.
 *
 * KEYS MUST BE `nodes` AND `edges` TO MATCH PYTHON BACKEND AND FRONTEND App.jsx!
 */
export function getGraphSummary(graph) {
  let databaseRelationships = 0;
  let businessRelationships = 0;
  let crossSourceRelationships = 0;

  for (const [, , data] of graph.edges({ data: true })) {
    const type = data.relationship_type;
    if (type === "DATABASE_RELATIONSHIP") databaseRelationships++;
    else if (type === "BUSINESS_RELATIONSHIP") businessRelationships++;
    else if (type === "CROSS_SOURCE_RELATIONSHIP") crossSourceRelationships++;
  }

  return {
    nodes: graph.number_of_nodes(),
    edges: graph.number_of_edges(),
    database_relationships: databaseRelationships,
    business_relationships: businessRelationships,
    cross_source_relationships: crossSourceRelationships
  };
}

/**
 * Inspect parents and children of a table in the Context Graph.
 */
export function getRelatedTables(graph, tableName, sourceId = "db1") {
  const nodeId = makeNodeId(sourceId, tableName);
  if (!graph.hasNode(nodeId)) {
    return { parents: [], children: [] };
  }

  const parents = graph.predecessors(nodeId).map(pred => {
    const nodeData = graph.getNode(pred);
    return nodeData?.table_name || pred;
  });

  const children = graph.successors(nodeId).map(succ => {
    const nodeData = graph.getNode(succ);
    return nodeData?.table_name || succ;
  });

  return {
    parents: parents.sort(),
    children: children.sort()
  };
}

/**
 * Retrieve relationship records between two tables in the graph.
 */
export function getRelationships(graph, sourceTable, targetTable, sourceId = "db1") {
  const sourceNode = makeNodeId(sourceId, sourceTable);
  const targetNode = makeNodeId(sourceId, targetTable);

  if (!graph.hasEdge(sourceNode, targetNode)) {
    return [];
  }

  const edgeData = graph.getEdgeData(sourceNode, targetNode);
  if (!edgeData) return [];

  return Object.values(edgeData);
}

// snake_case aliases for 100% Python parity
export const load_context = loadContext;
export const load_business_relationships = loadBusinessRelationships;
export const load_cross_source_relationships = loadCrossSourceRelationships;
export const make_node_id = makeNodeId;
export const build_context_graph = buildContextGraph;
export const build_multi_source_context_graph = buildMultiSourceContextGraph;
export const get_graph_summary = getGraphSummary;
export const get_related_tables = getRelatedTables;
export const get_relationships = getRelationships;

export default {
  loadContext,
  load_context: loadContext,
  loadBusinessRelationships,
  load_business_relationships: loadBusinessRelationships,
  loadCrossSourceRelationships,
  load_cross_source_relationships: loadCrossSourceRelationships,
  makeNodeId,
  make_node_id: makeNodeId,
  MultiDiGraph,
  buildContextGraph,
  build_context_graph: buildContextGraph,
  buildMultiSourceContextGraph,
  build_multi_source_context_graph: buildMultiSourceContextGraph,
  getGraphSummary,
  get_graph_summary: getGraphSummary,
  getRelatedTables,
  get_related_tables: getRelatedTables,
  getRelationships,
  get_relationships: getRelationships,
  CONTEXT_FILE,
  BUSINESS_LOGIC_FILE,
  CROSS_SOURCE_RELATIONSHIPS_FILE
};
