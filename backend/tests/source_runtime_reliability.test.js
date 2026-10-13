import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAllContexts } from "../context/context_store.js";
import { QuestionPlanValidator } from "../planning/question_plan_validator.js";
import { ComplexQueryPlanner } from "../planning/complex_query_planner.js";
import { RAGPipeline } from "../pipeline/rag_pipeline.js";
import { RetrievalExecutor } from "../retrieval/retrieval_executor.js";
import { ContextManager } from "../context/context_manager.js";
import { SourceRouter } from "../planning/source_router.js";
import { classifyRuntimeError, diagnosticRecord } from "../diagnostics/runtime_diagnostics.js";

const contexts = loadAllContexts();

function basePlan(sourceId, table, columns) {
  return {
    question: `read ${table}`,
    data_sources: ["postgresql"],
    postgresql_sources: [sourceId],
    required_tables: [table],
    required_columns: columns,
    relationships: [],
    filters: [],
    operations: ["lookup"],
    limit: 10,
    confidence: 0.9
  };
}

test("repaired single-source output receives its one explicit top-level source", () => {
  const plan = {
    ...basePlan("db1", "project_details", ["project_details.id"]),
    execution_plan: {
      mode: "single",
      steps: [{ id: "s1", type: "source_query", source_id: "", contract: {} }],
      final_step: "s1"
    }
  };
  const validation = new QuestionPlanValidator(contexts).validate(plan);
  assert.equal(validation.valid, true, validation.errors.join("; "));
  assert.equal(validation.plan.execution_plan.steps[0].source_id, "db1");
  assert.deepEqual(validation.plan.execution_plan.steps[0].contract.postgresql_sources, ["db1"]);
});

test("multi-source execution plans reject any executable step without an explicit source", () => {
  const plan = {
    ...basePlan("db1", "project_details", ["project_details.id"]),
    postgresql_sources: ["db1", "db2"],
    execution_plan: {
      mode: "multi_step",
      steps: [
        { id: "s1", type: "source_query", source_id: "db1", contract: basePlan("db1", "project_details", ["project_details.id"]) },
        { id: "s2", type: "source_query", source_id: "", contract: basePlan("db2", "projects", ["projects.id"]), depends_on: ["s1"] }
      ],
      final_step: "s2"
    }
  };
  const validation = new QuestionPlanValidator(contexts).validate(plan);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(error => /source_id/i.test(error)));
});

test("simple DB1 and DB2 pipeline execution passes only explicit source IDs to retrieval", async () => {
  const calls = [];
  async function askWithSource(question, sourceId, table, columns) {
    const pipeline = new RAGPipeline(new ContextManager());
    const validator = new QuestionPlanValidator(contexts);
    pipeline.plan_validator = validator;
    pipeline.planValidator = validator;
    pipeline.planner.contexts = contexts;
    pipeline.source_router = new SourceRouter(contexts);
    pipeline.planner = { contexts, async plan() { return basePlan(sourceId, table, columns); } };
    pipeline.entity_resolver = { async resolve() { return []; } };
    pipeline.executor = { async execute(sql, source) { calls.push({ sql, sourceId: source }); return { rows: [{ id: "r1" }], row_count: 1, columns: ["id"] }; } };
    pipeline.answer_generator = { async generate() { return "mock answer"; } };
    await pipeline.ask(question, { workspace_id: "w", authorization: { postgresql_sources: [sourceId], security_resources: [] } });
  }
  await askWithSource("show project", "db1", "project_details", ["project_details.id"]);
  await askWithSource("show sessions", "db2", "sessions", ["sessions.id"]);
  assert.deepEqual(calls.map(call => call.sourceId), ["db1", "db2"]);
});

test("bounded evidence lineage does not expand large read-only list results", () => {
  const pipeline = new RAGPipeline(new ContextManager());
  const rows = Array.from({ length: 75 }, (_, index) => ({ id: `row-${index}` }));
  const evidence = pipeline._prepareEvidence([{
    source_id: "db1",
    retrieval_status: "success_with_data",
    retrieval: { rows, columns: ["id"], row_count: rows.length },
    sources: [{ source_id: "db1", tables: ["users"] }]
  }]);

  assert.equal(evidence.items.length, 50);
  assert.equal(evidence.items.at(-1).row.id, "row-49");
  assert.equal(evidence.items.every(item => item.truncated), true);
  assert.equal(evidence.postgresql.rows.length, 50);
  assert.equal(evidence.postgresql.total_retrieved, 75);
  assert.equal(evidence.postgresql.truncated, true);
});

test("multi-step DB1 to DB2 execution preserves explicit source IDs through bindings", async () => {
  const calls = [];
  const pipeline = new RAGPipeline(new ContextManager());
  const validator = new QuestionPlanValidator(contexts);
  pipeline.plan_validator = validator;
  pipeline.planValidator = validator;
  pipeline.source_router = new SourceRouter(contexts);
  pipeline.planner = {
    async plan() {
      return {
        question: "lookup related records",
        data_sources: ["postgresql"],
        postgresql_sources: ["db1", "db2"],
        required_tables: ["project_details", "projects"],
        required_columns: ["project_details.id", "projects.id"],
        relationships: [], filters: [], operations: ["lookup"], limit: 10, confidence: 0.9,
        execution_plan: {
          mode: "multi_step",
          steps: [
            { id: "s1", type: "source_query", source_id: "db1", contract: basePlan("db1", "project_details", ["project_details.id"]), output_columns: ["project_details.id"] },
            { id: "s2", type: "source_query", source_id: "db2", contract: basePlan("db2", "projects", ["projects.id"]), depends_on: ["s1"], input_bindings: [{ from_step: "s1", from_column: "id", to_table: "projects", to_column: "id", operator: "in" }] }
          ],
          final_step: "s2"
        }
      };
    }
  };
  pipeline.entity_resolver = { async resolve() { return []; } };
  pipeline.executor = { async execute(sql, sourceId) { calls.push({ sql, sourceId }); return { rows: [{ id: "r1" }], row_count: 1, columns: ["id"] }; } };
  pipeline.answer_generator = { async generate() { return "mock answer"; } };

  const result = await pipeline.ask("lookup related records", { workspace_id: "w", authorization: { postgresql_sources: ["db1", "db2"], security_resources: [] } });
  assert.equal(result.retrieval_status, "success_with_data");
  assert.deepEqual(calls.map(call => call.sourceId), ["db1", "db2"]);
  assert.ok(calls.every(call => call.sourceId));
});

test("runtime diagnostics distinguish source, SQL, network, authentication, and query errors", () => {
  const cases = [
    [Object.assign(new Error("source_id must be a non-empty string"), { code: "MISSING_SOURCE_ID" }), "missing_source_id"],
    [Object.assign(new Error("unsafe SQL"), { code: "SQL_VALIDATION_ERROR" }), "sql_validation_error"],
    [Object.assign(new Error("connect EACCES"), { code: "EACCES" }), "network_failure"],
    [Object.assign(new Error("password authentication failed"), { code: "28P01" }), "database_authentication_failure"],
    [new Error("query failed"), "query_execution_error"]
  ];
  for (const [error, category] of cases) assert.equal(classifyRuntimeError(error), category);
  assert.deepEqual(diagnosticRecord(cases[2][0], { requestId: "req-1", sourceId: "db2", stepId: "s2" }), {
    request_id: "req-1", phase: "runtime", category: "network_failure", source_id: "db2", step_id: "s2", error_code: "EACCES", error_name: "Error", message: "connect EACCES"
  });
});

test("retrieval executor routes registered PostgreSQL sources at the connection boundary", () => {
  assert.match(RetrievalExecutor.CONNECTION_FACTORY.toString(), /getConnection\(sourceId\)/);
  assert.throws(() => new RetrievalExecutor()._validate_source(""), error => error.code === "MISSING_SOURCE_ID");
});
