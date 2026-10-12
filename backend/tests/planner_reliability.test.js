import { test } from "node:test";
import assert from "node:assert";
import { QuestionPlanner } from "../planning/question_planner.js";
import { RAGPipeline } from "../pipeline/rag_pipeline.js";

const contexts = {
  db1: { tables: { work_items: { primary_keys: ["id"], columns: [{ name: "id", type: "uuid" }, { name: "created_at", type: "timestamp" }] } } },
  db2: { tables: { meeting_records: { primary_keys: ["meeting_id"], columns: [{ name: "meeting_id", type: "uuid" }, { name: "started_at", type: "timestamp" }] } } }
};

test("temporal completion selects the metadata-relevant table rather than one table per source", () => {
  const planner = new QuestionPlanner(contexts);
  const result = planner._complete_temporal_plan_if_needed({ data_sources: ["postgresql"], postgresql_sources: [], required_tables: [], required_columns: [], sorting: [], operations: [] }, "show recent meetings");
  assert.deepStrictEqual(result.postgresql_sources, ["db2"]);
  assert.deepStrictEqual(result.required_tables, ["meeting_records"]);
  assert.deepStrictEqual(result.sorting, [{ field: "meeting_records.started_at", direction: "desc" }]);
});

test("multi-row results establish context only for invariant stable identifiers", () => {
  const pipeline = new RAGPipeline();
  pipeline._updateActiveEntityFromExecution("show latest transcript", { required_tables: ["transcripts"] }, [{ source_id: "db2", retrieval: { rows: [{ transcript_id: "t1", segment_id: "a" }, { transcript_id: "t1", segment_id: "b" }] } }]);
  const active = pipeline.context_manager.getActiveContext();
  assert.strictEqual(active.transcript_id, "t1");
  assert.strictEqual(active.segment_id, undefined);
});

test("explicit display-filter retrieval establishes a follow-up anchor", () => {
  const pipeline = new RAGPipeline();
  pipeline._updateActiveEntityFromExecution(
    "show meta briefing meeting details",
    { required_tables: ["sessions"], filters: [{ table: "sessions", field: "meeting_title", operator: "contains", value: "meta briefing" }] },
    [{ source_id: "db2", retrieval: { rows: [{ meeting_id: "m1", meeting_title: "meta briefing" }] } }]
  );
  assert.equal(pipeline.context_manager.getActiveContext().meeting_id, "m1");
});

test("a follow-up traverses only a discovered same-source relationship", () => {
  const planner = new QuestionPlanner({ db2: { tables: { projects: { columns: [{ name: "project_id" }] }, sessions: { columns: [{ name: "project_ref" }] } }, relationships: [{ source_table: "sessions", source_column: "project_ref", target_table: "projects", target_column: "project_id" }] } });
  const plan = planner._normalize_plan({ data_sources: ["postgresql"], postgresql_sources: ["db2"], required_tables: ["sessions"], required_columns: [], filters: [], relationships: [], operations: ["lookup"], needs_conversation_context: true }, "show its meetings", { active_context: { source_id: "db2", table: "projects", stable_keys: { project_id: "p1" } } });
  assert.deepStrictEqual(plan.required_tables.sort(), ["projects", "sessions"]);
  assert.strictEqual(plan.relationships.length, 1);
  assert.ok(plan.filters.some(filter => filter.table === "projects" && filter.field === "project_id" && filter.value === "p1"));
});

test("an unambiguous detail follow-up becomes a source-qualified lookup", () => {
  const planner = new QuestionPlanner({ db2: { tables: { records: { columns: [{ name: "record_id" }, { name: "title" }] } } } });
  const plan = planner._normalize_plan({ data_sources: ["postgresql"], postgresql_sources: [], required_tables: [], required_columns: [], filters: [], operations: [] }, "show its details", { active_context: { source_id: "db2", table: "records", stable_keys: { record_id: "r1" } } });
  assert.deepStrictEqual(plan.postgresql_sources, ["db2"]);
  assert.deepStrictEqual(plan.required_tables, ["records"]);
  assert.ok(plan.filters.some(filter => (filter.field || filter.column) === "record_id" && filter.value === "r1"));
});

test("metadata fallback produces a safe count plan when the semantic planner is unavailable", () => {
  const planner = new QuestionPlanner({ db1: { tables: { companies: { primary_keys: ["company_id"], columns: [{ name: "company_id" }, { name: "name" }] } } } });
  const fallback = planner._build_metadata_fallback_plan("What is the total number of companies?");
  const plan = planner._normalize_plan(fallback, "What is the total number of companies?");
  assert.deepStrictEqual(plan.postgresql_sources, ["db1"]);
  assert.deepStrictEqual(plan.required_tables, ["companies"]);
  assert.deepStrictEqual(plan.operations, ["count"]);
});

test("approved status mappings resolve compact and punctuated natural-language variants", () => {
  const planner = new QuestionPlanner({
    db1: {
      tables: {
        projects: {
          primary_keys: ["id"],
          columns: [{ name: "id" }, { name: "status" }, { name: "name" }]
        }
      },
      semantic_catalog: {
        entities: {
          projects: {
            entity_type: "project",
            synonyms: ["project", "projects"],
            status_semantics: {
              column: "status",
              mappings: { "in progress": "in_progress", active: "active" },
              validation_status: "validated",
              provenance: ["approved-fixture"]
            }
          }
        }
      }
    }
  });
  const candidate = { source_id: "db1", table: "projects", columns: ["id", "status", "name"], entity_type: "project", matched_aliases: ["project", "projects"] };
  const filter = planner._verified_status_filter(candidate, "Show projects whose status is inprogress");
  assert.deepStrictEqual(filter, { table: "projects", field: "status", operator: "case_insensitive_equals", value: "in_progress" });
});

test("normalized plans expose one intent contract without changing legacy fields", () => {
  const planner = new QuestionPlanner({ db1: { tables: { users: { columns: [{ name: "id" }] } } } });
  const plan = planner._normalize_plan({
    data_sources: ["postgresql"], postgresql_sources: ["db1"], required_tables: ["users"],
    required_columns: ["users.id"], filters: [{ table: "users", field: "id", operator: "=", value: "u1" }],
    relationships: [], operations: ["lookup"], needs_conversation_context: false
  }, "Show user u1");
  assert.equal(plan.intent.version, 1);
  assert.deepStrictEqual(plan.intent.source_ids, ["db1"]);
  assert.equal(plan.intent.mandatory_filters[0].value, "u1");
  assert.deepStrictEqual(plan.required_tables, ["users"]);
});
