import { test } from "node:test";
import assert from "node:assert";
import { ContextManager } from "../context/context_manager.js";
import { loadContext, loadAllContexts } from "../context/context_store.js";
import {
  MultiDiGraph,
  buildMultiSourceContextGraph,
  getGraphSummary,
  getRelatedTables,
  getRelationships,
  makeNodeId
} from "../context/context_graph.js";
import {
  validateRelationship,
  validateRelationships,
  getKnownTables,
  getKnownColumns
} from "../context/business_logic_validator.js";

test("ContextManager bounds conversation turns, text length, and manages entities", () => {
  const cm = new ContextManager({
    maxTurns: 3,
    maxItems: 5,
    maxQuestionChars: 100,
    maxAnswerChars: 100,
    maxEntityChars: 50
  });

  // Turn 1
  cm.addTurn("Show me project AVID-4207", "Project AVID-4207 is active", [
    { type: "project", id: "AVID-4207", name: "Avid Project" }
  ]);

  assert.strictEqual(cm.getHistory().length, 1);
  assert.strictEqual(cm.getEntities().length, 1);
  assert.strictEqual(cm.getLastTurn().question, "Show me project AVID-4207");
  assert.strictEqual(cm.getLastEntities()[0].id, "AVID-4207");

  // Turn 2
  cm.addTurn("What are its tasks?", "It has 4 tasks", [
    { type: "task", id: "TASK-1" }
  ]);

  assert.strictEqual(cm.getHistory().length, 2);
  assert.strictEqual(cm.getEntities().length, 2);

  // Turn 3
  cm.addTurn("Who is the lead?", "Lead is John", []);
  assert.strictEqual(cm.getHistory().length, 3);

  // Turn 4 (triggers trimming to maxTurns = 3)
  cm.addTurn("What about the budget?", "Budget is $10k", []);
  assert.strictEqual(cm.getHistory().length, 3);
  assert.strictEqual(cm.getHistory()[0].question, "What are its tasks?");

  // Verify getPlanningContext marks conversational context for QuestionPlanner
  const planCtx = cm.getPlanningContext();
  assert.strictEqual(planCtx.authority.conversation_history, "reference_only");
  assert.strictEqual(planCtx.authority.current_business_data, "live_retrieval_required");
  assert.strictEqual(planCtx.entities.length, 2);
  assert.strictEqual(planCtx.entities[0].id, "AVID-4207"); // Retains original resolved project entity!
});

test("ContextStore loads both db1 and db2 contexts correctly", () => {
  const allContexts = loadAllContexts();
  assert.ok(allContexts.db1);
  assert.ok(allContexts.db2);
  assert.strictEqual(allContexts.db1.source_id, "db1");
  assert.strictEqual(allContexts.db2.source_id, "db2");

  assert.ok(Object.keys(allContexts.db1.tables).length > 0);
  assert.ok(Object.keys(allContexts.db2.tables).length > 0);
});

test("MultiDiGraph supports predecessors, successors, and exact summary statistics", () => {
  const g = new MultiDiGraph();
  g.addNode("db1:projects", { table_name: "projects" });
  g.addNode("db1:tasks", { table_name: "tasks" });
  g.addEdge("db1:projects", "db1:tasks", {
    relationship_type: "DATABASE_RELATIONSHIP",
    database_relationship_type: "FOREIGN_KEY"
  });

  assert.strictEqual(g.number_of_nodes(), 2);
  assert.strictEqual(g.numberOfNodes(), 2);
  assert.strictEqual(g.number_of_edges(), 1);
  assert.strictEqual(g.numberOfEdges(), 1);

  assert.deepStrictEqual(g.predecessors("db1:tasks"), ["db1:projects"]);
  assert.deepStrictEqual(g.successors("db1:projects"), ["db1:tasks"]);

  const summary = getGraphSummary(g);
  // UI contracts: MUST have 'nodes' and 'edges'
  assert.strictEqual(summary.nodes, 2);
  assert.strictEqual(summary.edges, 1);
  assert.strictEqual(summary.database_relationships, 1);

  const related = getRelatedTables(g, "tasks", "db1");
  assert.deepStrictEqual(related.parents, ["projects"]);
  assert.deepStrictEqual(related.children, []);

  const rels = getRelationships(g, "projects", "tasks", "db1");
  assert.strictEqual(rels.length, 1);
  assert.strictEqual(rels[0].database_relationship_type, "FOREIGN_KEY");
});

test("BusinessLogicValidator validates candidate relationships against discovered schema", () => {
  const mockContext = {
    source_id: "db1",
    tables: {
      projects: {
        columns: [{ name: "id", type: "uuid" }, { name: "name", type: "text" }]
      },
      tasks: {
        columns: [{ name: "id", type: "uuid" }, { name: "project_id", type: "uuid" }]
      }
    },
    relationships: []
  };

  const validRel = {
    source_id: "db1",
    source_table: "tasks",
    target_table: "projects",
    source_column: "project_id",
    target_column: "id",
    confidence: 0.9,
    evidence: ["tasks.project_id points to projects.id"]
  };

  const [isValid, reason] = validateRelationship(validRel, mockContext);
  assert.strictEqual(isValid, true);

  // Missing table fails
  const invalidRel = {
    ...validRel,
    source_table: "nonexistent_table"
  };
  const [isInvalid, invalidReason] = validateRelationship(invalidRel, mockContext);
  assert.strictEqual(isInvalid, false);
  assert.ok(invalidReason.includes("Unknown source table"));
});
