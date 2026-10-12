import { test } from "node:test";
import assert from "node:assert/strict";
import { QuestionPlanner } from "../planning/question_planner.js";
import { QuestionPlanValidator } from "../planning/question_plan_validator.js";
import { loadAllContexts } from "../context/context_store.js";
import { RAGPipeline } from "../pipeline/rag_pipeline.js";
import { ContextManager } from "../context/context_manager.js";
import { SourceRouter } from "../planning/source_router.js";
import { validateReadOnlyQuery } from "../database/readonly_guard.js";

const contexts = loadAllContexts();

test("structural numbered and bullet prefixes do not become meeting-title text", async () => {
  const planner = new QuestionPlanner(contexts);
  planner.client = null;
  for (const question of [
    "1. Show me meta briefing meeting details",
    "  2) Show me meta briefing meeting details",
    "#3 Find meta briefing meeting details",
    "• Show me meta briefing meeting details"
  ]) {
    const plan = await planner.plan(question);
    assert.deepEqual(plan.filters, [{ table: "sessions", field: "meeting_title", operator: "contains", value: "meta briefing" }], question);
    assert.equal(new QuestionPlanValidator(contexts).validate(plan).valid, true, question);
  }
});

test("numeric titles and identifiers remain user content rather than structural prefixes", async () => {
  const planner = new QuestionPlanner(contexts);
  planner.client = null;
  const literalTitle = await planner.plan('Show me "1 meta briefing" meeting details');
  assert.deepEqual(literalTitle.filters, [{ table: "sessions", field: "meeting_title", operator: "contains", value: "1 meta briefing" }]);
  const identifier = await planner.plan("1. Show me all details about the meeting with ID ukm-jueo-dha");
  assert.deepEqual(identifier.filters, [{ table: "sessions", field: "meeting_id", operator: "=", value: "ukm-jueo-dha" }]);
});

test("prefixed detail lookup reaches read-only SQL and answer synthesis while preserving the original question", async () => {
  const pipeline = new RAGPipeline(new ContextManager());
  pipeline.plan_validator = new QuestionPlanValidator(contexts);
  pipeline.planValidator = pipeline.plan_validator;
  pipeline.planner = new QuestionPlanner(contexts);
  pipeline.planner.client = null;
  pipeline.source_router = new SourceRouter(contexts);
  pipeline.entity_resolver = { async resolve() { return []; } };
  const calls = [];
  pipeline.executor = { async execute(sql, sourceId) { validateReadOnlyQuery(sql); calls.push({ sql, sourceId }); return { rows: [{ meeting_title: "meta briefing", meeting_id: "vou-awaw-ypu" }], row_count: 1, columns: [] }; } };
  pipeline.answer_generator = { async generate() { return "Grounded meeting detail"; } };
  const question = "1. Show me meta briefing meeting details";
  const result = await pipeline.ask(question, { workspace_id: "offline", authorization: { postgresql_sources: ["db2"], security_resources: [] } });
  assert.equal(result.question, question);
  assert.equal(result.retrieval_status, "success_with_data");
  assert.equal(result.answer, "Grounded meeting detail");
  assert.equal(calls[0].sourceId, "db2");
  assert.match(calls[0].sql, /"sessions"\."meeting_title" ILIKE '%meta briefing%'/i);
  assert.doesNotMatch(calls[0].sql, /1 meta briefing/i);
});

test("unfamiliar entity uses the same prefix parsing without a meeting-specific rule", async () => {
  const unfamiliar = {
    archive: {
      source_id: "archive",
      tables: { signal_records: { columns: [{ name: "signal_id", type: "uuid" }, { name: "signal_title", type: "text" }], primary_keys: ["signal_id"] } },
      relationships: [],
      semantic_catalog: { entities: { signal_records: { entity_type: "signal", synonyms: ["signal", "signals"], provenance: ["fixture"] } }, verified_paths: [] }
    }
  };
  const planner = new QuestionPlanner(unfamiliar);
  planner.client = null;
  const plan = await planner.plan("#3 Show delta marker signal details");
  assert.deepEqual(plan.filters, [{ table: "signal_records", field: "signal_title", operator: "contains", value: "delta marker" }]);
});
