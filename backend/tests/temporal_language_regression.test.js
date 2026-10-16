import { test } from "node:test";
import assert from "node:assert/strict";
import { QuestionPlanner } from "../planning/question_planner.js";
import { QuestionPlanValidator } from "../planning/question_plan_validator.js";
import { loadTestContexts, OFFLINE_PROVIDER } from "./test_context.js";
import { RAGPipeline } from "../pipeline/rag_pipeline.js";
import { ContextManager } from "../context/context_manager.js";
import { SourceRouter } from "../planning/source_router.js";
import { validateReadOnlyQuery } from "../database/readonly_guard.js";

const contexts = loadTestContexts();

test("recent temporal intent never becomes a meeting title filter, including a malformed provider plan", async () => {
  const planner = new QuestionPlanner(contexts);
  planner.client = { responses: { async create() { return { output_text: JSON.stringify({
    data_sources: ["postgresql"], postgresql_sources: ["db2"], required_tables: ["sessions"],
    required_columns: ["sessions.meeting_title"], filters: [{ table: "sessions", field: "meeting_title", operator: "contains", value: "recent" }], operations: ["lookup"]
  }) }; } } };
  const plan = await planner.plan("Show me recent meetings");
  assert.deepEqual(plan.filters, []);
  assert.deepEqual(plan.sorting, [{ field: "sessions.created_at", direction: "desc" }]);
  assert.equal(new QuestionPlanValidator(contexts).validate(plan).valid, true);

  const pipeline = new RAGPipeline(new ContextManager());
  pipeline.plan_validator = new QuestionPlanValidator(contexts);
  pipeline.planValidator = pipeline.plan_validator;
  pipeline.planner = planner;
  pipeline.source_router = new SourceRouter(contexts);
  pipeline.entity_resolver = { async resolve() { return []; } };
  const calls = [];
  pipeline.executor = { async execute(sql, sourceId) { validateReadOnlyQuery(sql); calls.push({ sql, sourceId }); return { rows: [{ meeting_id: "m-1", created_at: "2026-10-11T00:00:00Z" }], row_count: 1, columns: [] }; } };
  pipeline.answer_generator = { async generate() { return "Grounded recent meeting"; } };
  const result = await pipeline.ask("Show me recent meetings", { workspace_id: "offline", authorization: { postgresql_sources: ["db2"], security_resources: [] } });
  assert.equal(result.retrieval_status, "success_with_data");
  assert.match(calls[0].sql, /ORDER BY "sessions"\."created_at" DESC/i);
  assert.doesNotMatch(calls[0].sql, /meeting_title.*recent/i);
  assert.equal(result.answer, "Grounded recent meeting");
});

test("quoted temporal-looking text remains an intentional literal search", async () => {
  const planner = new QuestionPlanner(contexts);
  planner.client = OFFLINE_PROVIDER;
  const plan = await planner.plan('Show me "recent" meeting details');
  assert.deepEqual(plan.filters, [{ table: "sessions", field: "meeting_title", operator: "contains", value: "recent" }]);
  assert.equal(plan.sorting.length, 0);
});

test("unfamiliar temporal entity uses discovered metadata rather than title text", async () => {
  const unfamiliar = {
    archive: {
      source_id: "archive",
      tables: { signal_packets: { columns: [{ name: "packet_id", type: "uuid" }, { name: "observed_at", type: "timestamp" }, { name: "packet_title", type: "text" }], primary_keys: ["packet_id"] } },
      relationships: [],
      semantic_catalog: { entities: { signal_packets: { entity_type: "signal_packet", synonyms: ["signal packet", "signal packets"], ordering: { column: "observed_at" }, provenance: ["fixture"] } }, verified_paths: [] }
    }
  };
  const planner = new QuestionPlanner(unfamiliar);
  planner.client = OFFLINE_PROVIDER;
  const plan = await planner.plan("Show newest signal packets");
  assert.deepEqual(plan.filters, []);
  assert.deepEqual(plan.sorting, [{ field: "signal_packets.observed_at", direction: "desc" }]);
});
