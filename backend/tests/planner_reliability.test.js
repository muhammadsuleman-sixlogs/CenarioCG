import { test } from "node:test";
import assert from "node:assert";
import { QuestionPlanner } from "../planning/question_planner.js";
import { RAGPipeline } from "../pipeline/rag_pipeline.js";
import { loadAllContexts } from "../context/context_store.js";

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

test("incomplete provider count plans use the bounded metadata fallback", async () => {
  const planner = new QuestionPlanner(loadAllContexts());
  planner.client = {
    responses: {
      async create() {
        return { output_text: JSON.stringify({
          data_sources: ["postgresql"],
          postgresql_sources: ["db1"],
          required_tables: [],
          required_columns: [],
          filters: [],
          operations: ["count"]
        }) };
      }
    }
  };

  const plan = await planner.plan("What is the total number of companies?");
  assert.ok(plan.execution_plan.steps.every(step => step.contract.required_tables.includes("companies")));
  assert.equal(plan.operations.includes("count"), true);
});

test("provider steps without an executable table use the bounded metadata fallback", async () => {
  const planner = new QuestionPlanner(loadAllContexts());
  planner.client = {
    responses: {
      async create() {
        return { output_text: JSON.stringify({
          data_sources: ["postgresql"],
          postgresql_sources: ["db1"],
          required_tables: [],
          required_columns: [],
          filters: [],
          operations: ["lookup"],
          execution_plan: {
            mode: "single",
            steps: [{ id: "s1", type: "source_query", source_id: "db1", contract: { required_tables: [] } }]
          }
        }) };
      }
    }
  };
  const plan = await planner.plan("List all projects.");
  assert.ok(plan.execution_plan.steps.every(step => step.contract.required_tables.length > 0));
});

test("explicit multi-source status and recent intents stay on grounded metadata plans", async () => {
  const planner = new QuestionPlanner(loadAllContexts());
  planner.client = {
    responses: {
      async create() {
        return { output_text: JSON.stringify({
          data_sources: ["postgresql"],
          postgresql_sources: ["db1", "db2"],
          required_tables: [],
          filters: [],
          operations: [],
          clarification_required: { type: "business_status_semantics" }
        }) };
      }
    }
  };

  const active = await planner.plan("Show active projects.");
  assert.equal(active.clarification_required, undefined);
  assert.equal(active.execution_plan.steps.length, 2);
  assert.ok(active.execution_plan.steps.every(step => step.contract.filters.length === 1));

  const recent = await planner.plan("Show recent meetings.");
  assert.deepStrictEqual(recent.required_tables, ["sessions"]);
  assert.deepStrictEqual(recent.sorting, [{ field: "sessions.created_at", direction: "desc" }]);
});

test("explicit entity changes do not inherit prior stable identifiers", () => {
  const planner = new QuestionPlanner({
    db2: {
      tables: {
        sessions: { columns: [{ name: "id" }, { name: "session_id" }] },
        meeting_summaries: { columns: [{ name: "id" }, { name: "session_id" }] },
        users: { columns: [{ name: "id" }, { name: "email" }] }
      },
      relationships: [{ source_table: "meeting_summaries", source_column: "session_id", target_table: "sessions", target_column: "session_id" }]
    }
  });
  const plan = planner._normalize_plan({
    data_sources: ["postgresql"],
    postgresql_sources: ["db2"],
    required_tables: ["meeting_summaries"],
    required_columns: ["meeting_summaries.id"],
    filters: [{ table: "meeting_summaries", field: "session_id", operator: "=", value: "session-1" }],
    relationships: [],
    operations: ["lookup"],
    needs_conversation_context: true
  }, "List meeting summaries.", {
    active_context: {
      source_id: "db2",
      table: "sessions",
      stable_keys: { session_id: "session-1" }
    }
  });

  assert.equal(plan.needs_conversation_context, false);
  assert.equal(plan.filters.some(filter => filter.value === "session-1"), false);
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

test("reported basic and follow-up questions retain source-local intent and anchors", async () => {
  const planner = new QuestionPlanner(loadAllContexts());
  planner.client = null;

  const recent = await planner.plan("Show me recent meetings");
  assert.deepStrictEqual(recent.postgresql_sources, ["db2"]);
  assert.deepStrictEqual(recent.required_tables, ["sessions"]);
  assert.deepStrictEqual(recent.sorting, [{ field: "sessions.created_at", direction: "desc" }]);

  const companies = await planner.plan("Show me total companies");
  assert.deepStrictEqual(companies.postgresql_sources, ["db1", "db2"]);
  assert.equal(companies.execution_plan.steps.length, 2);
  assert.ok(companies.execution_plan.steps.every(step => step.depends_on.length === 0));

  const sessionContext = {
    active_context: {
      source_id: "db2",
      table: "sessions",
      stable_keys: { session_id: "9bbd6019-0c45-4077-9040-cc02d6dca87b", project_id: "9bbd6019-0c45-4077-9040-cc02d6dca87b" }
    }
  };
  const associated = planner._normalize_plan({
    data_sources: ["postgresql"],
    postgresql_sources: ["db2"],
    required_tables: ["projects"],
    required_columns: ["projects.project_id"],
    filters: [{ table: "projects", field: "status", operator: "=", value: "associated" }],
    relationships: [],
    operations: ["lookup"],
    clarification_required: { type: "business_status_semantics", message: "provider status clarification" }
  }, "Which project is associated with it?", sessionContext);
  assert.deepStrictEqual(associated.required_tables, ["projects"]);
  assert.ok(associated.filters.some(filter => filter.field === "project_id" && filter.value === sessionContext.active_context.stable_keys.project_id));
  assert.ok(!associated.filters.some(filter => String(filter.field).toLowerCase() === "status"));
  assert.equal(associated.clarification_required, undefined);

  const details = await planner.plan("Show me that project's details", {
    active_context: { source_id: "db2", table: "projects", stable_keys: { project_id: "9bbd6019-0c45-4077-9040-cc02d6dca87b" } }
  });
  assert.equal(details.execution_plan.steps[0].source_id, "db2");
  assert.equal(details.execution_plan.steps.at(-1).source_id, "db1");
  assert.equal(details.execution_plan.steps.at(-1).contract.required_tables[0], "project_details");
});

test("ordinary table nouns remain selectable when semantic candidates are present", async () => {
  const planner = new QuestionPlanner(loadAllContexts());
  planner.client = null;

  const invoices = await planner.plan("List recent invoices.");
  assert.deepStrictEqual(invoices.postgresql_sources, ["db1"]);
  assert.deepStrictEqual(invoices.required_tables, ["invoices"]);
  assert.deepStrictEqual(invoices.sorting, [{ field: "invoices.created_at", direction: "desc" }]);

  const actions = await planner.plan("Show action items for a project.");
  assert.deepStrictEqual(actions.postgresql_sources, ["db2"]);
  assert.deepStrictEqual(actions.required_tables, ["action_items"]);
});

test("aggregate amount wording is not converted into a status filter", async () => {
  const planner = new QuestionPlanner(loadAllContexts());
  planner.client = null;
  const plan = await planner.plan("What is the total invoice amount?");
  assert.deepStrictEqual(plan.postgresql_sources, ["db1"]);
  assert.deepStrictEqual(plan.required_tables, ["invoices"]);
  assert.deepStrictEqual(plan.operations, ["lookup", "sum"]);
  assert.deepStrictEqual(plan.requested_metrics, [{ operation: "sum", table: "invoices", column: "total_amount", source_id: "db1", label: "total_amount", distinct: false }]);
  assert.equal(plan.filters.some(filter => String(filter.field || filter.column).toLowerCase() === "status"), false);
});

test("status phrases use bounded runtime verification for list and count plans", async () => {
  const planner = new QuestionPlanner(loadAllContexts());
  planner.client = null;
  for (const question of ["Show pending tickets.", "How many projects are currently in progress?"]) {
    const plan = await planner.plan(question);
    assert.ok(plan.filters.some(filter => filter.verification === "runtime_distinct_required"), JSON.stringify(plan));
    assert.equal(plan.clarification_required, undefined, JSON.stringify(plan));
  }
});
