import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextManager } from "../context/context_manager.js";
import { loadTestContexts, OFFLINE_PROVIDER } from "./test_context.js";
import { RAGPipeline } from "../pipeline/rag_pipeline.js";
import { QuestionPlanner } from "../planning/question_planner.js";
import { QuestionPlanValidator } from "../planning/question_plan_validator.js";
import { SourceRouter } from "../planning/source_router.js";
import { validateReadOnlyQuery } from "../database/readonly_guard.js";
import { AnswerGenerator } from "../llm/answer_generator.js";

const contexts = loadTestContexts();
const bothSources = { workspace_id: "offline", authorization: { postgresql_sources: ["db1", "db2"], security_resources: [] } };

function offlinePipeline(contextManager = new ContextManager()) {
  const pipeline = new RAGPipeline(contextManager);
  pipeline.plan_validator = new QuestionPlanValidator(contexts);
  pipeline.planValidator = pipeline.plan_validator;
  pipeline.planner = new QuestionPlanner(contexts);
  // A truthy non-provider deliberately exercises only deterministic fallback
  // planning; these tests never call OpenAI or a database.
  pipeline.planner.client = OFFLINE_PROVIDER;
  pipeline.source_router = new SourceRouter(contexts);
  pipeline.entity_resolver = { async resolve() { return []; } };
  return pipeline;
}

test("ordinary aggregate wording reaches SQL, mocked execution, and answer synthesis", async () => {
  const pipeline = offlinePipeline();
  const sqlCalls = [];
  let evidence = null;
  pipeline.executor = {
    async execute(sql, sourceId) {
      validateReadOnlyQuery(sql);
      sqlCalls.push({ sql, sourceId });
      return { rows: [{ count: sourceId === "db1" ? "11" : "7" }], row_count: 1, columns: ["count"] };
    }
  };
  pipeline.answer_generator = { async generate(_question, suppliedEvidence) { evidence = suppliedEvidence; return "DB1 has 11 projects and DB2 has 7 projects; the scopes were kept separate."; } };

  const result = await pipeline.ask("Show me total projects.", bothSources);

  assert.equal(result.retrieval_status, "success_with_data");
  assert.deepEqual(sqlCalls.map(call => call.sourceId), ["db1", "db2"]);
  assert.ok(sqlCalls.every(call => /^SELECT COUNT\(\*\)/i.test(call.sql)));
  assert.equal(result.candidate_resolution_result.combined_total, null);
  assert.equal(evidence.candidate_resolution.overlap_status, "unknown");
  assert.equal(result.answer.includes("DB1 has 11"), true);
});

test("meeting-project-company retrieval uses the approved dependent path and compact graph evidence", async () => {
  const pipeline = offlinePipeline();
  const calls = [];
  let answerEvidence = null;
  pipeline.executor = {
    async execute(sql, sourceId, parameters = []) {
      validateReadOnlyQuery(sql);
      calls.push({ sql, sourceId, parameters });
      if (/FROM "sessions"/i.test(sql)) return { rows: [{ project_id: "p1", meeting_title: "Planning" }], row_count: 1, columns: ["project_id", "meeting_title"] };
      if (/FROM "projects"/i.test(sql)) return { rows: [{ project_id: "p1", project_title: "Launch" }], row_count: 1, columns: ["project_id", "project_title"] };
      if (/FROM "project_details"/i.test(sql)) return { rows: [{ id: "p1", company_id: "c1", project_name: "Launch" }], row_count: 1, columns: ["id", "company_id", "project_name"] };
      return { rows: [{ id: "c1", name: "Acme" }], row_count: 1, columns: ["id", "name"] };
    }
  };
  pipeline.answer_generator = { async generate(_question, evidence) { answerEvidence = evidence; return "Planning belongs to Launch at Acme."; } };

  const result = await pipeline.ask("Which meeting belongs to which project and company?", bothSources);
  assert.equal(result.retrieval_status, "success_with_data");
  assert.deepEqual(calls.filter(call => !/ANY\(\$1\)/i.test(call.sql)).map(call => `${call.sourceId || call.source_id}:${/FROM "sessions"/i.test(call.sql) ? "sessions" : /FROM "projects"/i.test(call.sql) ? "projects" : /FROM "project_details"/i.test(call.sql) ? "project_details" : "companies"}`), [
    "db2:sessions", "db2:projects", "db1:project_details", "db1:companies"
  ]);
  assert.equal(calls.some(call => call.sourceId === "db2" && /FROM "companies"/i.test(call.sql)), false);
  assert.deepEqual(answerEvidence.items.map(item => item.execution_step_id), ["s1", "s2", "s3", "s4"]);
  assert.equal(result.evidence.complex_execution.steps.length, 4);
});

test("semantic relationship rejection prevents retrieval and answer generation", async () => {
  const pipeline = offlinePipeline();
  const validPlan = await pipeline.planner.plan("Show me recent meetings.");
  pipeline.planner.plan = async () => validPlan;
  pipeline.planner.assess_semantic_completeness = () => ({ complete: false, reason: "incomplete_verified_relationship_path" });
  let retrievalCalled = false;
  let answerCalled = false;
  pipeline.executor = { async execute() { retrievalCalled = true; throw new Error("must not execute"); } };
  pipeline.answer_generator = { async generate() { answerCalled = true; return "must not run"; } };

  const result = await pipeline.ask("Which meeting belongs to which project and company?", bothSources);
  assert.equal(result.retrieval_status, "planning_failed");
  assert.equal(result.error.type, "PLAN_SEMANTICALLY_INCOMPLETE");
  assert.equal(retrievalCalled, false);
  assert.equal(answerCalled, false);
});

test("recent meeting and latest transcript plans reach ordered read-only SQL and answers", async () => {
  for (const [question, expectedTable, expectedOrder] of [
    ["Show me recent meetings.", "sessions", /ORDER BY "sessions"\."created_at" DESC/i],
    ["Show me latest meetings transcript.", "transcripts", /ORDER BY "sessions"\."created_at" DESC/i]
  ]) {
    const pipeline = offlinePipeline();
    const calls = [];
    pipeline.executor = {
      async execute(sql, sourceId) {
        validateReadOnlyQuery(sql);
        calls.push({ sql, sourceId });
        return { rows: [{ id: "r1", session_id: "session-1", meeting_title: "Planning" }], row_count: 1, columns: ["id", "session_id", "meeting_title"] };
      }
    };
    pipeline.answer_generator = { async generate() { return "Grounded answer"; } };

    const result = await pipeline.ask(question, { workspace_id: "offline", authorization: { postgresql_sources: ["db2"], security_resources: [] } });

    assert.equal(result.retrieval_status, "success_with_data", question);
    assert.deepEqual(calls.map(call => call.sourceId), ["db2"], question);
    assert.match(calls[0].sql, new RegExp(`FROM "${expectedTable}"`, "i"), question);
    assert.match(calls[0].sql, expectedOrder, question);
    assert.equal(result.answer, "Grounded answer", question);
  }
});

test("provider answer failure keeps verified ticket context and renders bounded evidence fallback", async () => {
  const manager = new ContextManager();
  const pipeline = offlinePipeline(manager);
  pipeline.executor = {
    async execute(sql, sourceId) {
      validateReadOnlyQuery(sql);
      return {
        rows: [
          { id: "ticket-1", subject: "Payment review", status: "pending" },
          { id: "ticket-2", subject: "Access request", status: "open" }
        ],
        row_count: 2,
        columns: ["id", "subject", "status"]
      };
    }
  };
  pipeline.answer_generator = {
    async generate() { throw Object.assign(new Error("provider unavailable"), { code: "ECONNRESET" }); },
    buildFallbackAnswer(question, evidence) {
      return new AnswerGenerator({}).buildFallbackAnswer(question, evidence);
    }
  };

  const result = await pipeline.ask("Show me recent tickets", {
    workspace_id: "offline",
    authorization: { postgresql_sources: ["db1"], security_resources: [] }
  });

  assert.equal(result.retrieval_status, "success_with_data");
  assert.equal(result.answer_generation_status, "failed");
  assert.match(result.answer, /Payment review/);
  assert.match(result.answer, /ticket-2/);
  assert.equal(manager.get_history().length, 1);
  assert.equal(manager.getActiveContext().record_set.key_column, "id");
  assert.deepEqual(manager.getActiveContext().record_set.values, ["ticket-1", "ticket-2"]);
});

test("ticket status follow-up removes deictic context words before categorical verification", async () => {
  const planner = new QuestionPlanner(contexts);
  planner.client = OFFLINE_PROVIDER;
  const activeContext = {
    active_context: {
      source_id: "db1",
      table: "tickets",
      record_set: { key_column: "id", values: ["ticket-1", "ticket-2"], count: 2 },
      validation_status: "retrieval_evidence_confirmed"
    }
  };

  for (const [question, expectedStatus] of [
    ["Show only those pending.", "pending"],
    ["Which of these tickets are completed?", "completed"]
  ]) {
    const plan = await planner.plan(question, activeContext);
    assert.deepEqual(plan.filters, [
      { table: "tickets", field: "id", operator: "in", value: ["ticket-1", "ticket-2"] },
      {
        table: "tickets",
        field: "status",
        operator: "case_insensitive_equals",
        value: expectedStatus,
        verification: "runtime_distinct_required",
        provenance: "authorized_discovered_categorical_column"
      }
    ], question);
    assert.equal(plan.clarification_required, undefined, question);
  }
});

test("recent-first invoice follow-up retrieves the related company by the verified company_id", async () => {
  const manager = new ContextManager();
  const pipeline = offlinePipeline(manager);
  const calls = [];
  const answerEvidence = [];
  pipeline.executor = {
    async execute(sql, sourceId, parameters = []) {
      validateReadOnlyQuery(sql);
      calls.push({ sql, sourceId, parameters });
      if (calls.length === 1) {
        return {
          rows: [{ id: "invoice-1", company_id: "company-1", invoice_number: "INV-1", created_at: "2026-10-14T01:47:17Z" }],
          row_count: 1,
          columns: ["id", "company_id", "invoice_number", "created_at"]
        };
      }
      return {
        rows: [{ id: "company-1", name: "Example Company" }],
        row_count: 1,
        columns: ["id", "name"]
      };
    }
  };
  pipeline.answer_generator = {
    async generate(_question, evidence) {
      answerEvidence.push(evidence);
      return "Example Company is associated with the invoice.";
    }
  };
  const auth = { workspace_id: "offline", authorization: { postgresql_sources: ["db1"], security_resources: [] } };

  const invoice = await pipeline.ask("show me recent first invoice", auth);
  const company = await pipeline.ask("what is the company name of that invoice", auth);

  assert.equal(invoice.retrieval_status, "success_with_data");
  assert.equal(company.retrieval_status, "success_with_data");
  assert.equal(calls.filter(call => !/ANY\(\$1\)/i.test(call.sql)).length, 2);
  assert.match(calls[0].sql, /FROM "invoices"/i);
  const primaryCalls = calls.filter(call => !/ANY\(\$1\)/i.test(call.sql));
  assert.match(primaryCalls[1].sql, /FROM "companies"/i);
  assert.match(primaryCalls[1].sql, /"companies"\."id"\s*=\s*%s/i);
  assert.deepEqual(primaryCalls[1].parameters, ["company-1"]);
  assert.doesNotMatch(primaryCalls[1].sql, /invoice-1/i);
  assert.equal(company.answer, "Example Company is associated with the invoice.");
  assert.ok(answerEvidence[1].items.some(item => item.row?.name === "Example Company"));
  assert.deepEqual(manager.getActiveContext().stable_keys, { id: "company-1" });
});

test("source-qualified meeting details and project-to-meeting bindings reach mocked execution", async () => {
  const manager = new ContextManager();
  const pipeline = offlinePipeline(manager);
  const calls = [];
  let db2Call = 0;
  pipeline.executor = {
    async execute(sql, sourceId, parameters = []) {
      validateReadOnlyQuery(sql);
      calls.push({ sql, sourceId, parameters });
      if (sourceId === "db1") return { rows: [{ project_id_display: "P-1" }], row_count: 1, columns: ["project_id_display"] };
      db2Call += 1;
      if (db2Call === 1) return { rows: [{ project_id: "db2-project-1", project_code: "P-1" }], row_count: 1, columns: ["project_id", "project_code"] };
      return { rows: [{ session_id: "session-1", project_id: "db2-project-1", meeting_title: "Planning" }], row_count: 1, columns: ["session_id", "project_id", "meeting_title"] };
    }
  };
  pipeline.answer_generator = { async generate() { return "Grounded answer"; } };

  manager.setActiveContext({ source_id: "db2", table: "sessions", stable_keys: { session_id: "session-1" } });
  const detail = await pipeline.ask("Show me all details about that meeting.", { workspace_id: "offline", authorization: { postgresql_sources: ["db2"], security_resources: [] } });
  assert.equal(detail.retrieval_status, "success_with_data");
  assert.match(calls[0].sql, /"sessions"\."session_id" = %s/i);
  assert.deepEqual(calls[0].parameters, ["session-1"]);

  calls.length = 0;
  db2Call = 0;
  manager.setActiveContext({ source_id: "db1", table: "project_details", stable_keys: { project_id_display: "P-1" } });
  const related = await pipeline.ask("Show me that project's meetings.", bothSources);
  assert.equal(related.retrieval_status, "success_with_data");
  const primaryCalls = calls.filter(call => !/ANY\(\$1\)/i.test(call.sql));
  assert.deepEqual(primaryCalls.map(call => call.sourceId), ["db1", "db2", "db2"]);
  assert.match(primaryCalls[1].sql, /"projects"\."project_code"/i);
  assert.match(primaryCalls[2].sql, /"sessions"\."project_id"/i);
  assert.deepEqual(primaryCalls[2].parameters, [["db2-project-1"]]);
  assert.equal(related.answer, "Grounded answer");
  assert.deepEqual(manager.getActiveContext().stable_keys, { session_id: "session-1", project_id: "db2-project-1" });
  assert.equal(manager.getActiveContext().source_id, "db2");
  assert.equal(manager.getActiveContext().table, "sessions");
});

test("unverified status semantics clarify while source failures never invoke answer synthesis", async () => {
  const statusPipeline = offlinePipeline();
  const status = await statusPipeline.ask("Which tickets are pending?", { workspace_id: "offline", authorization: { postgresql_sources: ["db1"], security_resources: [] } });
  assert.equal(status.retrieval_status, "source_unavailable");
  assert.match(status.answer, /could not retrieve|authoritative|status|workflow/i);

  const unavailable = offlinePipeline();
  let answerCalled = false;
  unavailable.executor = { async execute() { throw Object.assign(new Error("offline source unavailable"), { code: "ECONNREFUSED" }); } };
  unavailable.answer_generator = { async generate() { answerCalled = true; return "must not run"; } };
  const result = await unavailable.ask("Show me recent meetings.", { workspace_id: "offline", authorization: { postgresql_sources: ["db2"], security_resources: [] } });
  assert.equal(result.retrieval_status, "source_unavailable");
  assert.equal(answerCalled, false);
});

test("an explicit schema-qualified identifier survives source failure and constrains its transcript follow-up", async () => {
  const manager = new ContextManager();
  const pipeline = offlinePipeline(manager);
  pipeline.executor = { async execute() { throw Object.assign(new Error("offline"), { code: "EACCES" }); } };
  pipeline.answer_generator = { async generate() { return "must not run"; } };

  const first = await pipeline.ask("Show me all details about the meeting with ID ukm-jueo-dha.", { workspace_id: "offline", authorization: { postgresql_sources: ["db2"], security_resources: [] } });
  assert.equal(first.retrieval_status, "source_unavailable");
  assert.deepEqual(manager.getPendingReference(), {
    source_id: "db2", table: "sessions", stable_keys: { meeting_id: "ukm-jueo-dha" },
    validation_status: "schema_validated_unretrieved", provenance: "explicit_user_identifier"
  });

  const calls = [];
  pipeline.executor = {
    async execute(sql, sourceId, parameters = []) {
      validateReadOnlyQuery(sql);
      calls.push({ sql, sourceId, parameters });
      return { rows: [{ meeting_id: "ukm-jueo-dha", session_id: "session-7", transcript_data: "grounded" }], row_count: 1, columns: ["meeting_id", "session_id", "transcript_data"] };
    }
  };
  pipeline.answer_generator = { async generate() { return "Grounded transcript answer"; } };
  const followup = await pipeline.ask("Show me its transcript.", { workspace_id: "offline", authorization: { postgresql_sources: ["db2"], security_resources: [] } });
  assert.equal(followup.retrieval_status, "success_with_data");
  assert.equal(calls[0].sourceId, "db2");
  assert.match(calls[0].sql, /"transcripts"\."meeting_id" = %s/i);
  assert.deepEqual(calls[0].parameters, ["ukm-jueo-dha"]);
  assert.equal(manager.getActiveContext().table, "sessions");
  assert.deepEqual(manager.getActiveContext().stable_keys, { meeting_id: "ukm-jueo-dha" });
});

test("meeting-to-project and explicit DB1/DB2 combination use only direct or approved paths", async () => {
  const planner = new QuestionPlanner(contexts);
  planner.client = OFFLINE_PROVIDER;
  const meeting = { active_context: { source_id: "db2", table: "sessions", stable_keys: { meeting_id: "ukm-jueo-dha" } } };
  const project = await planner.plan("Which project is this meeting associated with?", meeting);
  assert.deepEqual(project.postgresql_sources, ["db2"]);
  assert.deepEqual(project.required_tables, ["sessions", "projects"]);
  assert.deepEqual(project.filters, [{ table: "sessions", field: "meeting_id", operator: "=", value: "ukm-jueo-dha" }]);
  assert.equal(new QuestionPlanValidator(contexts).validate(project).valid, true);

  const combined = await planner.plan("Find related information about this project in DB1 and DB2 and combine the results.", {
    active_context: { source_id: "db2", table: "projects", stable_keys: { project_id: "p-1" } }
  });
  assert.equal(new QuestionPlanValidator(contexts).validate(combined).valid, true);
  assert.deepEqual(combined.execution_plan.steps.map(step => step.source_id), ["db2", "db1"]);
  assert.deepEqual(combined.execution_plan.steps[1].input_bindings, [{ from_step: "s1", from_column: "project_id", to_table: "project_details", to_column: "id", operator: "in" }]);
});

test("recent-list to explicit ID/title detail lookup bypasses malformed provider relationships and reaches answer synthesis", async () => {
  const manager = new ContextManager();
  const pipeline = offlinePipeline(manager);
  const calls = [];
  pipeline.executor = {
    async execute(sql, sourceId, parameters = []) {
      validateReadOnlyQuery(sql);
      calls.push({ sql, sourceId, parameters });
      if (/FROM "sessions"[\s\S]*ORDER BY/i.test(sql)) {
        return { rows: [{ meeting_id: "ukm-jueo-dha", session_id: "s-1", meeting_title: "meta briefing" }], row_count: 1, columns: [] };
      }
      return { rows: [{ meeting_id: "ukm-jueo-dha", session_id: "s-1", meeting_title: "meta briefing" }], row_count: 1, columns: [] };
    }
  };
  let answers = 0;
  pipeline.answer_generator = { async generate() { answers += 1; return "Grounded meeting answer"; } };
  const auth = { workspace_id: "offline", authorization: { postgresql_sources: ["db2"], security_resources: [] } };

  const listed = await pipeline.ask("Show me recent meetings", auth);
  assert.equal(listed.retrieval_status, "success_with_data");
  pipeline.planner.client = {
    responses: {
      async create() {
        return { output_text: JSON.stringify({
          data_sources: ["postgresql"], postgresql_sources: ["db2"],
          required_tables: ["usage_llm_events", "usage_recall_sessions"], required_columns: [],
          relationships: [{ source_table: "usage_llm_events", source_column: "id", target_table: "usage_recall_sessions", target_column: "id" }]
        }) };
      }
    }
  };
  const byId = await pipeline.ask("Show me all details about the meeting with ID ukm-jueo-dha", auth);
  const byTitle = await pipeline.ask("Show me meta briefing meeting details", auth);

  assert.equal(byId.retrieval_status, "success_with_data");
  assert.equal(byTitle.retrieval_status, "success_with_data");
  assert.equal(answers, 3);
  const detailCalls = calls.slice(1);
  assert.ok(detailCalls.every(call => call.sourceId === "db2"));
  assert.match(detailCalls[0].sql, /FROM "sessions"/i);
  assert.match(detailCalls[0].sql, /"sessions"\."meeting_id" = %s/i);
  assert.deepEqual(detailCalls[0].parameters, ["ukm-jueo-dha"]);
  assert.match(detailCalls[1].sql, /"sessions"\."meeting_title" ILIKE %s/i);
  assert.deepEqual(detailCalls[1].parameters, ["%meta briefing%"]);
  assert.ok(detailCalls.every(call => !/usage_llm_events|usage_recall_sessions/i.test(call.sql)));
});
