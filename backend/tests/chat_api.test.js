import { test } from "node:test";
import assert from "node:assert";
import {
  graphToDict,
  buildGraphTrace,
  buildSourceTrace,
  projectPublicGraph,
  projectPublicGraphTrace,
  projectPublicSources,
  projectPublicSourceTrace
} from "../api/chat.js";
import { MultiDiGraph } from "../context/context_graph.js";

test("graphToDict converts MultiDiGraph into exact frontend node and edge structures", () => {
  const g = new MultiDiGraph();
  g.addNode("db1:project_tasks", {
    table_name: "project_tasks",
    node_type: "table",
    source_id: "db1",
    columns: ["id", "title"],
    primary_keys: ["id"]
  });
  g.addNode("db1:project_details", {
    table_name: "project_details",
    node_type: "table",
    source_id: "db1",
    columns: ["id", "project_name"],
    primary_keys: ["id"]
  });
  g.addEdge("db1:project_details", "db1:project_tasks", {
    relationship_type: "DATABASE_RELATIONSHIP",
    database_relationship_type: "FOREIGN_KEY",
    source_column: "project_id",
    target_column: "id",
    target_source_id: "db1",
    confidence: 1.0
  });

  const dict = graphToDict(g);
  assert.strictEqual(dict.nodes.length, 2);
  assert.strictEqual(dict.nodes[0].id, "db1:project_tasks");
  assert.strictEqual(dict.nodes[0].source_id, "db1");
  assert.strictEqual(dict.edges.length, 1);
  assert.strictEqual(dict.edges[0].source, "db1:project_details");
  assert.strictEqual(dict.edges[0].target, "db1:project_tasks");
  assert.strictEqual(dict.edges[0].label, "FOREIGN_KEY");
  assert.strictEqual(dict.edges[0].type, "database");
});

test("graphToDict removes protected columns from frontend schema metadata", () => {
  const g = new MultiDiGraph();
  g.addNode("db1:users", {
    table_name: "users",
    node_type: "table",
    source_id: "db1",
    columns: [
      { name: "id", type: "uuid" },
      { name: "email", type: "text" },
      { name: "password_hash", type: "text" },
    ],
    primary_keys: ["id"],
  });

  const node = graphToDict(g).nodes[0];
  assert.deepStrictEqual(node.columns.map(column => column.name), ["id", "email"]);
});

test("buildGraphTrace resolves source-qualified nodes and constructs trace edges with exact edgeKeys", () => {
  const g = new MultiDiGraph();
  g.addNode("db1:project_tasks", { table_name: "project_tasks", node_type: "table", source_id: "db1" });
  g.addNode("db1:project_details", { table_name: "project_details", node_type: "table", source_id: "db1" });
  g.addEdge("db1:project_details", "db1:project_tasks", {
    relationship_type: "DATABASE_RELATIONSHIP",
    database_relationship_type: "FOREIGN_KEY"
  });

  const sources = [
    {
      source_type: "postgresql",
      source_id: "db1",
      tables: ["project_tasks", "project_details"],
      entities: []
    }
  ];

  const trace = buildGraphTrace(g, sources);
  assert.strictEqual(trace.nodes.length, 2);
  assert.deepStrictEqual(trace.source_tables, ["project_tasks", "project_details"]);
  assert.deepStrictEqual(trace.matched_graph_nodes, ["db1:project_tasks", "db1:project_details"]);
  assert.strictEqual(trace.edges.length, 1);
  assert.strictEqual(trace.edges[0].source, "db1:project_details");
  assert.strictEqual(trace.edges[0].target, "db1:project_tasks");
  assert.strictEqual(trace.edges[0].id, "db1:project_details-db1:project_tasks-0");
  assert.strictEqual(trace.edges[0].label, "FOREIGN_KEY");
});

test("buildSourceTrace normalizes data sources and categorizes PostgreSQL and Security Logs sources", () => {
  const sources = [
    { source_type: "postgresql", source_id: "db1" },
    { source_type: "postgresql", source_id: "db1" }, // duplicate
    { source_type: "postgresql", source_id: "db2" },
    {
      source_type: "security_logs_api",
      source: "security_logs",
      event_count: 5,
      truncated: false
    }
  ];

  const trace = buildSourceTrace(sources, ["postgresql", "security_logs", "postgresql", ""]);
  assert.deepStrictEqual(trace.data_sources, ["postgresql", "security_logs"]);
  assert.deepStrictEqual(trace.postgresql_sources, ["db1", "db2"]);
  assert.strictEqual(trace.external_sources.length, 1);
  assert.strictEqual(trace.external_sources[0].id, "security_logs");
  assert.strictEqual(trace.external_sources[0].event_count, 5);
});

test("public graph projection preserves connectivity without internal source or schema identifiers", () => {
  const internal = {
    nodes: [
      { id: "db1:companies", label: "companies", type: "table", source_id: "db1", columns: [{ name: "id" }] },
      { id: "db2:projects", label: "projects", type: "table", source_id: "db2", columns: [{ name: "id" }] }
    ],
    edges: [{ id: "db1:companies-db2:projects-0", source: "db1:companies", target: "db2:projects", label: "PROJECT_COMPANY", type: "cross_source", source_id: "db1" }]
  };

  const projected = projectPublicGraph(internal);
  assert.equal(projected.graph.nodes.length, 2);
  assert.equal(projected.graph.edges.length, 1);
  assert.notEqual(projected.graph.nodes[0].id, "db1:companies");
  assert.equal(projected.graph.nodes[0].source_label, "Base DB");
  assert.equal(projected.graph.nodes[1].source_label, "Companion DB");
  assert.equal(projected.graph.edges[0].source, projected.graph.nodes[0].id);
  assert.equal(projected.graph.edges[0].target, projected.graph.nodes[1].id);
  assert.equal("source_id" in projected.graph.nodes[0], false);
  assert.equal("columns" in projected.graph.nodes[0], false);

  const trace = projectPublicGraphTrace({
    matched_graph_nodes: ["db1:companies", "db2:projects"],
    nodes: [{ id: "db1:companies", label: "companies" }],
    edges: [{ id: "db1:companies-db2:projects-0", source: "db1:companies", target: "db2:projects", label: "PROJECT_COMPANY" }]
  }, projected.nodeRefs);
  assert.deepEqual(trace.matched_graph_nodes, [projected.graph.nodes[0].id, projected.graph.nodes[1].id]);
  assert.equal(trace.edges[0].source, projected.graph.nodes[0].id);
  assert.equal(trace.edges[0].target, projected.graph.nodes[1].id);
});

test("public source projection exposes safe labels and no raw source identifiers or SQL", () => {
  const sources = projectPublicSources([
    { source_type: "postgresql", source_id: "db1", query: "SELECT secret FROM users", row_count: 2 },
    { source_type: "postgresql", source_id: "db2", query: "SELECT id FROM projects", row_count: 0 }
  ]);
  assert.deepEqual(sources.map(source => source.source_label), ["Base DB", "Companion DB"]);
  assert.equal(sources.some(source => JSON.stringify(source).includes("db1")), false);
  assert.equal(sources.some(source => JSON.stringify(source).includes("SELECT")), false);

  const trace = projectPublicSourceTrace([
    { source_type: "postgresql", source_id: "db1" },
    { source_type: "postgresql", source_id: "db2" }
  ], ["postgresql"]);
  assert.deepEqual(trace.data_sources, ["Base DB", "Companion DB"]);
  assert.deepEqual(trace.postgresql_sources.map(source => source.source_label), ["Base DB", "Companion DB"]);
  assert.equal(JSON.stringify(trace).includes("db1"), false);
  assert.equal(JSON.stringify(trace).includes("db2"), false);
});
