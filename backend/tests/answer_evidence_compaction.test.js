import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraphTrace, buildSourceTrace } from "../api/chat.js";
import { MultiDiGraph } from "../context/context_graph.js";
import { AnswerGenerator } from "../llm/answer_generator.js";
import { EvidenceManager } from "../llm/evidence_manager.js";
import { RAGPipeline } from "../pipeline/rag_pipeline.js";
import { SourceTracker } from "../tracing/source_tracker.js";
import { sanitizeEvidence } from "../security/output_security_policy.js";

const taskColumns = [
  "id", "project_id", "milestone_id", "task_display_id", "task_name",
  "description", "assignee_id", "priority", "stage", "tags", "due_date",
  "start_date", "hours_logged", "hours_remaining", "dependencies", "files",
  "points", "status", "is_completed", "completed_at"
];

function makeRows(sourceId, count = 10, sensitive = false) {
  return Array.from({ length: count }, (_, index) => Object.fromEntries(
    taskColumns.map(column => [
      column,
      sensitive && column === "description"
        ? "access_token=secret-value-must-not-leak"
        : `${sourceId}-task-${index}`
    ])
  ));
}

function makeResult(sourceId, rows) {
  const tracker = new SourceTracker();
  const sql = `SELECT "project_tasks"."id", "project_tasks"."project_id" FROM "project_tasks" WHERE "project_tasks"."project_id" = %s LIMIT ${rows.length}`;
  const retrieval = { rows, row_count: rows.length, columns: taskColumns };
  const source = tracker.buildSource(sql, retrieval, { required_tables: ["project_tasks"] }, sourceId);
  return {
    source_type: "postgresql",
    source_id: sourceId,
    retrieval_status: "success_with_data",
    retrieval,
    sources: [source]
  };
}

function prepareAnswerEvidence(results) {
  const pipeline = new RAGPipeline();
  const internalEvidence = sanitizeEvidence(pipeline._prepareEvidence(results, null, null));
  const answerEvidence = pipeline.evidence_manager.prepareAnswerEvidence(internalEvidence);
  return { pipeline, internalEvidence, answerEvidence };
}

test("answer-facing provenance keeps all ten rows authoritative elsewhere", async () => {
  const { internalEvidence, answerEvidence } = prepareAnswerEvidence([
    makeResult("db1", makeRows("db1"))
  ]);
  let answerPrompt = "";
  const answerGenerator = new AnswerGenerator({
    responses: {
      async create({ input }) {
        answerPrompt = input;
        return { output_text: "All ten tasks are available." };
      }
    }
  }, "mock-answer-model");

  await answerGenerator.generate("Show recent project task details", answerEvidence);

  assert.equal(internalEvidence.postgresql.rows.length, 10);
  assert.equal(answerEvidence.items.length, 10);
  assert.equal(answerEvidence.postgresql.rows, undefined);
  assert.equal(internalEvidence.sources[0].rows.length, 10);
  assert.equal(answerEvidence.sources[0].rows, undefined);
  assert.equal(answerEvidence.postgresql.sources[0].rows, undefined);
  for (let index = 0; index < 10; index += 1) {
    assert.match(answerPrompt, new RegExp(`db1-task-${index}`));
  }
  assert.deepEqual(answerEvidence.items.map(item => item.source_id), Array(10).fill("db1"));
  assert.deepEqual(answerEvidence.items.map(item => item.table), Array(10).fill("project_tasks"));
});

test("pipeline sends compact evidence to the answer generator but returns full internal evidence", async () => {
  const pipeline = new RAGPipeline();
  const rows = makeRows("db1");
  let answerEvidence = null;
  pipeline.planner = {
    async plan() {
      return {
        question: "Show recent project task details",
        data_sources: ["postgresql"],
        postgresql_sources: ["db1"],
        required_tables: ["project_tasks"],
        required_columns: taskColumns.map(column => `project_tasks.${column}`),
        relationships: [],
        filters: [],
        operations: ["lookup"],
        limit: 10,
        confidence: 0.9
      };
    }
  };
  pipeline.executor = {
    async execute() {
      return { rows, row_count: rows.length, columns: taskColumns };
    }
  };
  pipeline.answer_generator = {
    async generate(_question, evidence) {
      answerEvidence = evidence;
      return "Grounded task details.";
    }
  };

  const result = await pipeline.ask("Show recent project task details", {
    workspace_id: "offline",
    authorization: { postgresql_sources: ["db1"], security_resources: [] }
  });

  assert.equal(result.answer, "Grounded task details.");
  assert.equal(result.evidence.sources[0].rows.length, 10);
  assert.equal(answerEvidence.sources[0].rows, undefined);
  assert.equal(answerEvidence.postgresql.rows, undefined);
  assert.equal(answerEvidence.items.length, 10);
  assert.equal(answerEvidence.items[0].row.id, "db1-task-0");
});

test("source provenance and graph/source tracing remain based on the original evidence", () => {
  const { internalEvidence, answerEvidence } = prepareAnswerEvidence([
    makeResult("db1", makeRows("db1"))
  ]);
  const graph = new MultiDiGraph();
  graph.addNode("db1:project_tasks", { table_name: "project_tasks", source_id: "db1" });

  assert.equal(internalEvidence.sources[0].source_id, "db1");
  assert.deepEqual(internalEvidence.sources[0].tables, ["project_tasks"]);
  assert.equal(internalEvidence.sources[0].rows.length, 10);
  assert.deepEqual(buildGraphTrace(graph, internalEvidence.sources).source_tables, ["project_tasks"]);
  assert.deepEqual(buildSourceTrace(internalEvidence.sources, ["postgresql"]).postgresql_sources, ["db1"]);
  assert.equal(answerEvidence.sources[0].source_id, "db1");
  assert.deepEqual(answerEvidence.sources[0].tables, ["project_tasks"]);
});

test("multi-source answer evidence keeps DB1 and DB2 provenance separated", () => {
  const { internalEvidence, answerEvidence } = prepareAnswerEvidence([
    makeResult("db1", makeRows("db1", 2)),
    makeResult("db2", makeRows("db2", 2))
  ]);

  assert.equal(answerEvidence.postgresql.rows, undefined);
  assert.equal(answerEvidence.items.length, 4);
  assert.deepEqual(answerEvidence.sources.map(source => source.source_id), ["db1", "db2"]);
  assert.deepEqual(answerEvidence.sources.map(source => source.tables), [["project_tasks"], ["project_tasks"]]);
  assert.ok(answerEvidence.sources.every(source => source.rows === undefined));
  assert.deepEqual(internalEvidence.sources.map(source => source.source_id), ["db1", "db2"]);
  assert.ok(internalEvidence.sources.every(source => source.rows.length === 2));
  assert.deepEqual(answerEvidence.postgresql.sources.map(source => source.source_id), ["db1", "db2"]);
  assert.ok(answerEvidence.postgresql.sources.every(source => source.rows === undefined));
  assert.deepEqual(
    answerEvidence.items.reduce((groups, item) => {
      groups[item.source_id] = (groups[item.source_id] || 0) + 1;
      return groups;
    }, {}),
    { db1: 2, db2: 2 }
  );
});

test("answer prompt is smaller while sensitive values remain sanitized", () => {
  const { internalEvidence, answerEvidence } = prepareAnswerEvidence([
    makeResult("db1", makeRows("db1", 10, true))
  ]);
  const answerGenerator = Object.create(AnswerGenerator.prototype);
  const fullPrompt = answerGenerator.buildPrompt("Show recent project task details", internalEvidence);
  const compactPrompt = answerGenerator.buildPrompt("Show recent project task details", answerEvidence);

  assert.ok(compactPrompt.length < fullPrompt.length);
  assert.ok(compactPrompt.length <= fullPrompt.length - 5000);
  assert.doesNotMatch(compactPrompt, /secret-value-must-not-leak/);
  assert.match(compactPrompt, /\[REDACTED\]/);
});

test("fallback answers continue to use complete internal evidence", () => {
  const { internalEvidence, answerEvidence } = prepareAnswerEvidence([
    makeResult("db1", makeRows("db1", 10))
  ]);
  const answerGenerator = new AnswerGenerator({});
  const fallback = answerGenerator.buildFallbackAnswer("Show recent project task details", internalEvidence);

  assert.match(fallback, /db1-task-0/);
  assert.equal(answerEvidence.sources[0].rows, undefined);
  assert.equal(internalEvidence.sources[0].rows.length, 10);
});

test("answer evidence preparation does not mutate its input", () => {
  const { internalEvidence } = prepareAnswerEvidence([
    makeResult("db1", makeRows("db1", 10))
  ]);
  const beforeRows = internalEvidence.sources[0].rows;
  const answerEvidence = new EvidenceManager().prepareAnswerEvidence(internalEvidence);

  assert.equal(internalEvidence.sources[0].rows, beforeRows);
  assert.equal(answerEvidence.sources[0].rows, undefined);
});

test("complex relationship evidence keeps canonical rows and strips wrapper copies", () => {
  const internalEvidence = {
    items: [
      { evidence_id: "e1", source_id: "db1", execution_step_id: "project", table: "project_details", row: { id: "p1", company_id: "c1" } },
      { evidence_id: "e2", source_id: "db2", execution_step_id: "meeting", table: "sessions", row: { id: "m1", project_id: "p1" } },
      { evidence_id: "e3", source_id: "db1", execution_step_id: "company", table: "companies", row: { id: "c1", name: "Acme" } }
    ],
    sources: [
      { source_id: "db1", tables: ["project_details"], rows: [{ id: "p1" }] },
      { source_id: "db2", tables: ["sessions"], rows: [{ id: "m1" }] },
      { source_id: "db1", tables: ["companies"], rows: [{ id: "c1" }] }
    ],
    postgresql: {
      rows: [{ id: "p1" }, { id: "m1" }, { id: "c1" }],
      sources: [{ source_id: "db1", rows: [{ id: "p1" }] }, { source_id: "db2", rows: [{ id: "m1" }] }]
    },
    complex_execution: {
      steps: [{ step_id: "project", evidence: { rows: [{ id: "p1" }], sources: [{ source_id: "db1", rows: [{ id: "p1" }] }] } }],
      final_result: { retrieval: { rows: [{ id: "c1" }] }, sources: [{ source_id: "db1", rows: [{ id: "c1" }] }] }
    },
    final_result: { rows: [{ id: "c1" }], sources: [{ source_id: "db1", rows: [{ id: "c1" }] }] }
  };

  const answerEvidence = new EvidenceManager().prepareAnswerEvidence(internalEvidence);

  assert.equal(answerEvidence.items.length, 3);
  assert.deepEqual(answerEvidence.items.map(item => item.row.id), ["p1", "m1", "c1"]);
  assert.deepEqual(answerEvidence.items.map(item => `${item.source_id}:${item.table}`), [
    "db1:project_details", "db2:sessions", "db1:companies"
  ]);
  assert.equal(answerEvidence.rows, undefined);
  assert.equal(answerEvidence.postgresql.rows, undefined);
  assert.ok(answerEvidence.sources.every(source => source.rows === undefined));
  assert.ok(answerEvidence.postgresql.sources.every(source => source.rows === undefined));
  assert.equal(answerEvidence.complex_execution.steps[0].evidence.rows, undefined);
  assert.equal(answerEvidence.complex_execution.steps[0].evidence.sources[0].rows, undefined);
  assert.equal(answerEvidence.complex_execution.final_result.retrieval.rows, undefined);
  assert.equal(answerEvidence.complex_execution.final_result.sources[0].rows, undefined);
  assert.equal(answerEvidence.final_result.rows, undefined);
  assert.equal(answerEvidence.final_result.sources[0].rows, undefined);
  assert.deepEqual(internalEvidence.complex_execution.steps[0].evidence.rows, [{ id: "p1" }]);
  assert.deepEqual(internalEvidence.sources[0].rows, [{ id: "p1" }]);
});
