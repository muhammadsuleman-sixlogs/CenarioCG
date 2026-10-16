import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextManager } from "../context/context_manager.js";
import { loadTestContexts, OFFLINE_PROVIDER } from "./test_context.js";
import {
  findSemanticCandidates,
  findVerifiedPaths,
  attachSemanticCatalog,
  catalogFingerprint,
  getSemanticCatalogStatus,
  loadSemanticCatalog,
  validateSemanticCatalog
} from "../context/semantic_catalog.js";
import { QuestionPlanner } from "../planning/question_planner.js";
import { QuestionPlanValidator } from "../planning/question_plan_validator.js";
import { SourceRouter } from "../planning/source_router.js";
import { RAGPipeline } from "../pipeline/rag_pipeline.js";
import { SQLGenerator } from "../retrieval/sql_generator.js";
import { QueryPlan } from "../planning/query_plan.js";
import { QueryPlanExecutor } from "../retrieval/query_plan_executor.js";
import { validateReadOnlyQuery } from "../database/readonly_guard.js";

const contexts = loadTestContexts();

test("semantic catalog resolves reported generic questions to authorized candidates", () => {
  const recentMeetings = findSemanticCandidates("Show me recent meetings", contexts);
  assert.deepEqual(recentMeetings[0].source_id, "db2");
  assert.deepEqual(recentMeetings[0].table, "sessions");
  assert.equal(recentMeetings[0].ordering_column, "created_at");

  const transcript = findSemanticCandidates("Show me latest meetings transcript", contexts);
  assert.equal(transcript[0].table, "transcripts");

  const recentProject = findSemanticCandidates("Show me most recent project", contexts);
  assert.equal(recentProject[0].source_id, "db1");
  assert.equal(recentProject[0].table, "project_details");
});

test("semantic catalog preserves ambiguity and authorization boundaries", () => {
  const projects = findSemanticCandidates("project", contexts);
  assert.equal(projects[0].score, projects[1].score);
  assert.deepEqual(new Set(findSemanticCandidates("project", contexts, ["db2"]).map(item => item.source_id)), new Set(["db2"]));
  assert.deepEqual(new Set(findSemanticCandidates("meeting", contexts, ["db1"]).map(item => item.source_id)), new Set());

  const router = new SourceRouter(contexts);
  assert.throws(
    () => router.route({ question: "project", data_sources: ["postgresql"], postgresql_sources: [], required_tables: [], required_columns: [] }),
    /could not deterministically identify/
  );
});

test("project-to-meetings uses only the evidence-backed verified path", () => {
  const paths = findVerifiedPaths("Show me project's meetings", contexts, ["db1", "db2"]);
  const uuidPath = paths.find(path => path.steps.at(-1)?.table === "sessions" && path.steps[0]?.column === "id");
  assert.ok(uuidPath);
  assert.deepEqual(uuidPath.steps.map(step => `${step.source_id}.${step.table}.${step.column}`), [
    "db1.project_details.id",
    "db2.projects.project_id",
    "db2.sessions.project_id"
  ]);
  const codePath = findVerifiedPaths("Show me meetings for project code XAZM-9573", contexts, ["db1", "db2"])
    .find(path => path.steps.at(-1)?.table === "sessions" && path.steps[0]?.column === "project_id_display");
  assert.ok(codePath);
  const db2OnlyPaths = findVerifiedPaths("Show me project's meetings", contexts, ["db2"]);
  assert.ok(db2OnlyPaths.length > 0);
  assert.ok(db2OnlyPaths.every(path => path.steps.every(step => step.source_id === "db2")));
});

test("verified project-to-company traversal is visible to the active planner", async () => {
  const paths = findVerifiedPaths("Which company owns it?", contexts, ["db1", "db2"], {
    active: { source_id: "db2", table: "projects", stable_keys: { project_id: "p1" } }
  });
  assert.ok(paths.length > 0);
  assert.deepEqual(paths[0].steps.map(step => `${step.source_id}.${step.table}.${step.column}`), [
    "db2.projects.project_id",
    "db1.project_details.id",
    "db1.companies.id"
  ]);

  const planner = new QuestionPlanner(contexts);
  const plan = planner._normalize_plan({
    data_sources: ["postgresql"], postgresql_sources: ["db2"], required_tables: ["companies"],
    required_columns: [], filters: [], relationships: [], operations: ["lookup"]
  }, "Which company owns it?", {
    active_context: { source_id: "db2", table: "projects", stable_keys: { project_id: "p1" } }
  });
  assert.deepEqual(plan.execution_plan.steps.map(step => step.source_id), ["db2", "db1", "db1"]);
  assert.deepEqual(plan.execution_plan.steps.slice(1).map(step => step.input_bindings[0]), [
    { from_step: "s1", from_column: "project_id", to_table: "project_details", to_column: "id", operator: "in" },
    { from_step: "s2", from_column: "company_id", to_table: "companies", to_column: "id", operator: "in" }
  ]);
  const validation = new QuestionPlanValidator(contexts).validate(plan);
  assert.equal(validation.valid, true, validation.errors.join("; "));

  const queryPlan = QueryPlan.from_dict(plan.execution_plan);
  const generators = { db1: new SQLGenerator(contexts.db1, "db1"), db2: new SQLGenerator(contexts.db2, "db2") };
  const sqlByStep = [];
  const executor = new QueryPlanExecutor();
  const execution = await executor.execute(queryPlan, async (step, runtime) => {
    const generated = generators[step.source_id].generate(step.contract, step.source_id, runtime.runtime_bindings);
    validateReadOnlyQuery(generated);
    sqlByStep.push({ id: step.step_id, source_id: step.source_id, sql: generated, bindings: runtime.runtime_bindings });
    if (step.step_id === "s1") return { status: "success_with_data", rows: [{ project_id: "p1" }] };
    if (step.step_id === "s2") return { status: "success_with_data", rows: [{ id: "p1", company_id: "company-1" }] };
    return { status: "success_with_data", rows: [{ id: "company-1", name: "Example Company" }] };
  });
  assert.equal(execution.status, "success");
  assert.deepEqual(sqlByStep.map(item => item.source_id), ["db2", "db1", "db1"]);
  assert.match(sqlByStep[0].sql, /"projects"\."project_id"/);
  assert.match(sqlByStep[1].sql, /"project_details"\."id"/);
  assert.match(sqlByStep[2].sql, /"companies"\."id"/);
  assert.deepEqual(sqlByStep[1].bindings.parameters, [["p1"]]);
  assert.deepEqual(sqlByStep[2].bindings.parameters, [["company-1"]]);
});

test("meeting follow-up uses the verified project_id and never adds phrase-derived filters", async () => {
  const planner = new QuestionPlanner(contexts);
  planner.client = OFFLINE_PROVIDER;
  const plan = await planner.plan("Which project is associated with this meeting? Show me its project name and details.", {
    active_context: {
      source_id: "db2",
      table: "sessions",
      stable_keys: {
        session_id: "03caf591-0016-46ce-bc58-637a0c92c207",
        project_id: "9bbd6019-0c45-4077-9040-cc02d6dca87b",
        meeting_id: "vou-awaw-ypu"
      }
    }
  });
  assert.deepEqual(plan.postgresql_sources, ["db2"]);
  assert.deepEqual(plan.required_tables, ["projects"]);
  assert.deepEqual(plan.filters, [{
    table: "projects", field: "project_id", operator: "=", value: "9bbd6019-0c45-4077-9040-cc02d6dca87b"
  }]);
  assert.equal(plan.filters.some(filter => String(filter.value).includes("which")), false);
  assert.equal(new QuestionPlanValidator(contexts).validate(plan).valid, true);
});

test("invoice company follow-up binds the verified company_id, not the invoice id", async () => {
  const planner = new QuestionPlanner(contexts);
  planner.client = OFFLINE_PROVIDER;
  const plan = await planner.plan("What is the company name of that invoice?", {
    active_context: {
      source_id: "db1",
      table: "invoices",
      stable_keys: { id: "invoice-1", company_id: "company-1" }
    }
  });

  assert.deepEqual(plan.postgresql_sources, ["db1"]);
  assert.deepEqual(plan.required_tables, ["companies"]);
  assert.deepEqual(plan.filters, [{ table: "companies", field: "id", operator: "=", value: "company-1" }]);
  assert.ok(!plan.filters.some(filter => filter.value === "invoice-1"));

  const validation = new QuestionPlanValidator(contexts).validate(plan);
  assert.equal(validation.valid, true, validation.errors.join("; "));
  const prepared = new SQLGenerator(contexts.db1, "db1").generatePrepared(plan, "db1");
  const sql = prepared.query;
  validateReadOnlyQuery(sql);
  assert.match(sql, /FROM "companies"/i);
  assert.match(sql, /"companies"\."id"\s*=\s*%s/i);
  assert.deepEqual(prepared.parameters, ["company-1"]);
  assert.doesNotMatch(sql, /invoice-1/i);
});

test("missing related-entity context binding fails closed instead of retrieving broadly", () => {
  const planner = new QuestionPlanner(contexts);
  const plan = planner._normalize_plan({
    data_sources: ["postgresql"],
    postgresql_sources: ["db1"],
    required_tables: ["companies"],
    required_columns: ["companies.name"],
    relationships: [],
    filters: [],
    operations: ["lookup"]
  }, "What is the company name of that invoice?", {
    active_context: { source_id: "db1", table: "invoices", stable_keys: {} }
  });

  assert.equal(plan.clarification_required?.type, "missing_context_binding");
  assert.deepEqual(plan.filters, []);
});

test("unfamiliar schema names use the same token and graph machinery", () => {
  const unfamiliar = {
    alpha: {
      source_id: "alpha",
      tables: {
        ledger_items: { columns: [{ name: "ledger_key" }, { name: "created_on", type: "timestamp" }], primary_keys: ["ledger_key"] }
      },
      relationships: [],
      semantic_catalog: { entities: { ledger_items: { entity_type: "ledger_record", synonyms: ["ledger artifact"], ordering: { column: "created_on" }, provenance: ["fixture"] } }, verified_paths: [{ id: "ledger-to-signal", validation_status: "validated", steps: [{ source_id: "alpha", table: "ledger_items", column: "ledger_key" }, { source_id: "beta", table: "signal_events", column: "ledger_key" }], provenance: ["fixture"] }] }
    },
    beta: {
      source_id: "beta",
      tables: { signal_events: { columns: [{ name: "ledger_key" }, { name: "occurred_on", type: "timestamp" }], primary_keys: ["event_key"] } },
      relationships: [],
      semantic_catalog: { entities: { signal_events: { entity_type: "signal_event", synonyms: ["signal event"], ordering: { column: "occurred_on" }, provenance: ["fixture"] } }, verified_paths: [] }
    }
  };
  const candidates = findSemanticCandidates("show recent signal events", unfamiliar);
  assert.equal(candidates[0].source_id, "beta");
  assert.equal(candidates[0].table, "signal_events");
  const paths = findVerifiedPaths("show ledger artifacts and signal events", unfamiliar, ["alpha", "beta"]);
  assert.equal(paths.length, 1);
  assert.deepEqual(paths[0].steps.map(step => step.table), ["ledger_items", "signal_events"]);
});

test("catalog validation distinguishes unknown and stale freshness without rejecting unknown snapshots", () => {
  const catalog = { ...loadSemanticCatalog(), technical_fingerprint: catalogFingerprint(contexts) };
  delete catalog.generated_at;
  assert.deepEqual(validateSemanticCatalog(contexts, catalog), []);
  assert.equal(getSemanticCatalogStatus(contexts, catalog).freshness_status, "unknown");
  const stale = { ...catalog, generated_at: new Date(0).toISOString() };
  assert.equal(getSemanticCatalogStatus(contexts, stale, 2, 1).freshness_status, "stale");
  assert.equal(Boolean(attachSemanticCatalog(contexts, stale).contexts.db1.semantic_catalog), false);
  assert.equal(getSemanticCatalogStatus(contexts, { ...catalog, technical_fingerprint: "wrong" }).validation_status, "invalid");
  assert.equal(getSemanticCatalogStatus(contexts, { ...catalog, sources: { db2: { entities: { missing: { synonyms: ["x"] } } } } }).validation_status, "invalid");
});

test("planner-provider failure falls back to a semantic, source-qualified plan", async () => {
  const planner = new QuestionPlanner(contexts);
  planner.client = OFFLINE_PROVIDER;
  const plan = await planner.plan("Show me recent meetings");
  assert.deepEqual(plan.postgresql_sources, ["db2"]);
  assert.deepEqual(plan.required_tables, ["sessions"]);
  assert.ok(plan.sorting.some(item => item.field === "sessions.created_at"));
});

test("provider status filters are ignored when the original question has no status intent", () => {
  const planner = new QuestionPlanner(contexts);
  const plan = planner._normalize_plan({
    data_sources: ["postgresql"],
    postgresql_sources: ["db1"],
    required_tables: ["tickets"],
    required_columns: ["tickets.id", "tickets.status"],
    filters: [{ table: "tickets", field: "status", operator: "=", value: "associated" }],
    relationships: [],
    operations: ["lookup"],
    clarification_required: { type: "business_status_semantics", message: "provider-invented clarification" }
  }, "Which project is associated with it?");
  assert.equal(plan.clarification_required, undefined);
  assert.equal(plan.filters.some(filter => String(filter.field || filter.column).toLowerCase() === "status"), false);
});

test("an established DB1 project builds a validated DB1-to-DB2 meeting plan", () => {
  const planner = new QuestionPlanner(contexts);
  const plan = planner._normalize_plan({
    data_sources: ["postgresql"], postgresql_sources: [], required_tables: [], required_columns: [],
    relationships: [], filters: [], operations: [], confidence: 0.8
  }, "Show its meetings", {
    active_context: { source_id: "db1", table: "project_details", stable_keys: { project_id_display: "XAZM-9573" } }
  });
  assert.deepEqual(plan.postgresql_sources, ["db1", "db2"]);
  assert.equal(plan.execution_plan.steps.length, 3);
  assert.equal(plan.execution_plan.steps[1].input_bindings[0].from_step, "s1");
  assert.equal(plan.execution_plan.steps[2].input_bindings[0].to_table, "sessions");
  const validation = new QuestionPlanValidator(contexts).validate(plan);
  assert.equal(validation.valid, true, validation.errors.join("; "));
});

test("mocked question-to-SQL-to-evidence path remains read-only and source-qualified", async () => {
  const pipeline = new RAGPipeline(new ContextManager());
  const validator = new QuestionPlanValidator(contexts);
  pipeline.plan_validator = validator;
  pipeline.planValidator = validator;
  pipeline.planner = {
    async plan() {
      return {
        question: "Show me recent meetings",
        data_sources: ["postgresql"],
        postgresql_sources: ["db2"],
        required_tables: ["sessions"],
        required_columns: ["sessions.id", "sessions.meeting_title", "sessions.created_at"],
        relationships: [], filters: [], operations: ["ranking"],
        sorting: [{ field: "sessions.created_at", direction: "desc" }],
        limit: 10, confidence: 0.95
      };
    },
    async resolveEntity() { return undefined; }
  };
  pipeline.entity_resolver = { async resolve() { return []; } };
  pipeline.source_router = new SourceRouter(contexts);
  pipeline.sql_generators = { db2: new SQLGenerator(contexts.db2, "db2") };
  let generatedSql = null;
  pipeline.executor = {
    async execute(sql) {
      generatedSql = sql;
      validateReadOnlyQuery(sql);
      return { rows: [{ id: 7, meeting_title: "Planning", created_at: "2026-10-10T12:00:00Z" }], row_count: 1, columns: ["id", "meeting_title", "created_at"] };
    }
  };
  pipeline.answer_generator = { async generate() { return "Planning meeting retrieved."; } };

  const result = await pipeline.ask("Show me recent meetings", {
    workspace_id: "workspace-test",
    authorization: { postgresql_sources: ["db2"], security_resources: [] }
  });
  assert.equal(result.retrieval_status, "success_with_data");
  assert.match(generatedSql, /^SELECT /i);
  assert.match(generatedSql, /"sessions"\."created_at"/);
  assert.equal(result.answer, "Planning meeting retrieved.");
  assert.equal(result.sources[0].source_type, "postgresql");
  assert.equal(result.sources[0].source_id, "db2");
});

test("failed mocked retrieval remains a retrieval failure and never reaches answer synthesis", async () => {
  const pipeline = new RAGPipeline(new ContextManager());
  pipeline.planner = { async plan() { return { question: "Show meetings", data_sources: ["postgresql"], postgresql_sources: ["db2"], required_tables: ["sessions"], required_columns: ["sessions.id"], relationships: [], filters: [], operations: ["lookup"], limit: 10, confidence: 0.9 }; } };
  pipeline.entity_resolver = { async resolve() { return []; } };
  pipeline.plan_validator = new QuestionPlanValidator(contexts);
  pipeline.planValidator = pipeline.plan_validator;
  pipeline.source_router = new SourceRouter(contexts);
  pipeline.executor = { async execute() { throw new Error("mock source unavailable"); } };
  let answered = false;
  pipeline.answer_generator = { async generate() { answered = true; return "unexpected"; } };
  const result = await pipeline.ask("Show meetings", { workspace_id: "workspace-test", authorization: { postgresql_sources: ["db2"], security_resources: [] } });
  assert.equal(result.retrieval_status, "source_unavailable");
  assert.equal(answered, false);
});
