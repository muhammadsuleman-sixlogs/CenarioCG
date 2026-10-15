import { test } from "node:test";
import assert from "node:assert";
import { ContextManager } from "../context/context_manager.js";
import { QuestionPlanner } from "../planning/question_planner.js";
import { SQLGenerator } from "../retrieval/sql_generator.js";
import { RAGPipeline } from "../pipeline/rag_pipeline.js";
import { loadContext } from "../context/context_store.js";

test("Regression Test 1: 'show details of meta briefing meeting' -> 'does it have a transcript?' scopes transcripts by session_id", async () => {
  const pipeline = new RAGPipeline();
  const db2Context = loadContext("db2");
  const sqlGen = new SQLGenerator(db2Context, "db2");

  // Turn 1: "Show me recent meetings" (returns list of 5 meetings, including meta briefing)
  const turn1Question = "Show me recent meetings";
  const turn1Rows = [
    { session_id: "03caf591-0016-46ce-bc58-637a0c92c207", meeting_title: "meta briefing", meeting_id: "vou-awaw-ypu" },
    { session_id: "11111111-2222-3333-4444-555555555555", meeting_title: "sprint planning", meeting_id: "abc-defg-hij" },
    { session_id: "22222222-3333-4444-5555-666666666666", meeting_title: "daily standup", meeting_id: "klm-nopq-rst" },
    { session_id: "33333333-4444-5555-6666-777777777777", meeting_title: "product review", meeting_id: "uvw-xyza-bcd" },
    { session_id: "44444444-5555-6666-7777-888888888888", meeting_title: "design sync", meeting_id: "efg-hijk-lmn" }
  ];
  pipeline._updateActiveEntityFromExecution(turn1Question, { required_tables: ["sessions"] }, [
    { source_id: "db2", retrieval: { rows: turn1Rows } }
  ]);
  // General list query retains a plural source-qualified record set, never one meeting.
  assert.deepEqual(pipeline.context_manager.getActiveContext().record_set, {
    key_column: "session_id",
    values: turn1Rows.map(row => row.session_id),
    count: 5
  });

  // Turn 2: "show details of meta briefing meeting" (resolves to specific session)
  const turn2Question = "show details of meta briefing meeting";
  const metaBriefingSessionId = "03caf591-0016-46ce-bc58-637a0c92c207";
  const metaBriefingProjectId = "9bbd6019-0c45-4077-9040-cc02d6dca87b";
  const turn2Rows = [
    {
      session_id: metaBriefingSessionId,
      project_id: metaBriefingProjectId,
      meeting_title: "meta briefing",
      meeting_id: "vou-awaw-ypu"
    }
  ];

  pipeline._updateActiveEntityFromExecution(turn2Question, { required_tables: ["sessions"] }, [
    { source_id: "db2", retrieval: { rows: turn2Rows } }
  ]);
  pipeline.context_manager.addTurn(turn2Question, "Meeting meta briefing details: ID vou-awaw-ypu", [
    { type: "meeting", id: metaBriefingSessionId, session_id: metaBriefingSessionId, meeting_title: "meta briefing" }
  ]);

  const activeCtx = pipeline.context_manager.getActiveContext();
  assert.ok(activeCtx, "Active context must be set after resolving meta briefing");
  assert.strictEqual(activeCtx.session_id, metaBriefingSessionId);
  assert.strictEqual(activeCtx.meeting_title, "meta briefing");

  // Turn 3: "does it have a transcript?" (pronoun 'it' must resolve to active session)
  const turn3Question = "does it have a transcript?";
  const conversationContext = pipeline._getConversationContext();
  assert.ok(conversationContext.active_context, "ConversationContext must contain active_context");

  const rewritten = pipeline._rewriteFollowupQuestion(turn3Question, conversationContext);
  assert.ok(rewritten.includes(metaBriefingSessionId), "Rewritten question should reference active session_id");

  // Plan normalization ensures session_id filter on transcripts
  const plan = pipeline.planner._normalize_plan(
    {
      data_sources: ["postgresql"],
      postgresql_sources: ["db2"],
      required_tables: ["transcripts"],
      required_columns: [],
      operations: ["count"],
      filters: []
    },
    turn3Question,
    conversationContext
  );

  assert.ok(plan.filters.some(f => f.column === "session_id" && f.value === metaBriefingSessionId), "Plan must filter transcripts by active session_id");

  // Compile final SQL
  const sql = sqlGen.generate(plan, "db2");
  console.log("\n==================== TEST 1 GENERATED SQL ====================");
  console.log(sql);
  console.log("==============================================================\n");

  assert.ok(sql.includes(`FROM "transcripts"`), "Must query transcripts table");
  assert.ok(sql.includes(`"session_id" = '${metaBriefingSessionId}'`), "Must filter WHERE session_id = <meta briefing session>");
});

test("a bounded recent-first invoice keeps its source-qualified company binding", () => {
  const pipeline = new RAGPipeline();
  pipeline._updateActiveEntityFromExecution(
    "show me recent first invoice",
    { required_tables: ["invoices"], limit: 10 },
    [{ source_id: "db1", retrieval: { rows: [{ id: "invoice-1", company_id: "company-1", invoice_number: "INV-1" }] } }]
  );

  assert.deepEqual(pipeline.context_manager.getActiveContext().stable_keys, {
    id: "invoice-1",
    company_id: "company-1"
  });
});

test("complex follow-up preserves the established parent identity in the first execution step", () => {
  const planner = new QuestionPlanner({ db2: loadContext("db2") });
  const active = {
    source_id: "db2",
    table: "sessions",
    stable_keys: { meeting_id: "vou-awaw-ypu" }
  };
  const plan = planner._normalize_plan({
    data_sources: ["postgresql"],
    postgresql_sources: ["db2"],
    required_tables: [],
    required_columns: [],
    filters: [],
    operations: ["lookup"],
    needs_conversation_context: true,
    execution_plan: {
      mode: "multi_step",
      final_step: "s2",
      steps: [
        { id: "s1", type: "source_query", source_id: "db2", contract: { required_tables: ["sessions"], required_columns: ["sessions.project_id"], filters: [], operations: ["lookup"] }, depends_on: [], input_bindings: [] },
        { id: "s2", type: "final_query", source_id: "db2", contract: { required_tables: ["projects"], required_columns: ["projects.project_id"], filters: [], operations: ["lookup"] }, depends_on: ["s1"], input_bindings: [{ from_step: "s1", from_column: "project_id", to_table: "projects", to_column: "project_id", operator: "in" }] }
      ]
    }
  }, "Which project is associated with it?", { active_context: active });
  assert.deepEqual(plan.execution_plan.steps[0].contract.filters, [{ table: "sessions", field: "meeting_id", operator: "=", value: "vou-awaw-ypu" }]);
  assert.deepEqual(plan.execution_plan.steps[1].contract.filters, []);
});

test("plural list follow-ups resolve above/previous records to source-qualified IDs", () => {
  const pipeline = new RAGPipeline();
  const rows = [
    { session_id: "s-1", meeting_title: "alpha" },
    { session_id: "s-2", meeting_title: "beta" },
    { session_id: "s-3", meeting_title: "gamma" },
    { session_id: "s-4", meeting_title: "delta" },
    { session_id: "s-5", meeting_title: "epsilon" }
  ];
  pipeline._updateActiveEntityFromExecution(
    "show me recent meetings",
    { execution_plan: { final_step: "s1" }, required_tables: ["sessions"] },
    [{ source_id: "db2", execution_step_id: undefined, retrieval: { rows } }]
  );

  const active = pipeline.context_manager.getActiveContext();
  assert.deepEqual(active.record_set, { key_column: "session_id", values: ["s-1", "s-2", "s-3", "s-4", "s-5"], count: 5 });

  const plan = pipeline.planner._build_metadata_fallback_plan(
    "show me details of above meetings",
    { active_context: active }
  );
  assert.deepEqual(plan.filters, [{ table: "sessions", field: "session_id", operator: "in", value: ["s-1", "s-2", "s-3", "s-4", "s-5"] }]);
  assert.ok(!JSON.stringify(plan).toLowerCase().includes("meeting_title.*above"));
  const sql = new SQLGenerator(loadContext("db2"), "db2").generate(plan, "db2");
  assert.match(sql, /"session_id"\s+IN\s*\(/i);
  assert.doesNotMatch(sql, /above/i);

  const noIdentityPlan = pipeline.planner._build_metadata_fallback_plan("show me details of above meetings");
  assert.ok(!(noIdentityPlan?.filters || []).some(filter => String(filter.value || "").toLowerCase() === "above"));
});

test("an explicit new entity takes precedence over a plural context reference", () => {
  const pipeline = new RAGPipeline();
  const active = {
    source_id: "db2",
    table: "sessions",
    record_set: { key_column: "id", values: [97, 96, 95, 94, 91], count: 5 }
  };

  const plan = pipeline.planner._build_metadata_fallback_plan(
    "show me projects those status is inprogress",
    { active_context: active }
  );

  assert.ok(plan, "The planner should produce a plan for the explicit project request");
  assert.ok((plan.required_tables || []).some(table => String(table).toLowerCase() === "projects"));
  assert.ok(!(plan.filters || []).some(filter => String(filter.table).toLowerCase() === "sessions"));
  assert.ok(!(plan.filters || []).some(filter => String(filter.value).toLowerCase() === "those"));
});

test("Regression Test 2: Follow-up 'how many action items?' stays scoped to the same session", async () => {
  const pipeline = new RAGPipeline();
  const db2Context = loadContext("db2");
  const sqlGen = new SQLGenerator(db2Context, "db2");

  const metaBriefingSessionId = "03caf591-0016-46ce-bc58-637a0c92c207";
  pipeline.context_manager.setActiveContext({
    entity_type: "meeting",
    session_id: metaBriefingSessionId,
    id: metaBriefingSessionId,
    meeting_title: "meta briefing",
    meeting_id: "vou-awaw-ypu",
    source_id: "db2",
    table: "sessions"
  });

  const question = "how many action items?";
  const conversationContext = pipeline._getConversationContext();

  const rewritten = pipeline._rewriteFollowupQuestion(question, conversationContext);
  assert.ok(rewritten.includes(metaBriefingSessionId), "Rewritten question should reference active session_id");

  const plan = pipeline.planner._normalize_plan(
    {
      data_sources: ["postgresql"],
      postgresql_sources: ["db2"],
      required_tables: ["action_items"],
      required_columns: [],
      operations: ["count"],
      filters: []
    },
    question,
    conversationContext
  );

  assert.ok(plan.filters.some(f => f.column === "session_id" && f.value === metaBriefingSessionId), "Plan must filter action_items by active session_id");

  const sql = sqlGen.generate(plan, "db2");
  console.log("\n==================== TEST 2 GENERATED SQL ====================");
  console.log(sql);
  console.log("==============================================================\n");

  assert.ok(sql.includes(`FROM "action_items"`), "Must query action_items table");
  assert.ok(sql.includes(`"session_id" = '${metaBriefingSessionId}'`), "Must filter WHERE session_id = <meta briefing session>");
});

test("Regression Test 3: After asking 'show recent meetings', a new explicit meeting name replaces the active context", async () => {
  const pipeline = new RAGPipeline();
  const db2Context = loadContext("db2");
  const sqlGen = new SQLGenerator(db2Context, "db2");

  const initialSessionId = "03caf591-0016-46ce-bc58-637a0c92c207";
  pipeline.context_manager.setActiveContext({
    entity_type: "meeting",
    session_id: initialSessionId,
    id: initialSessionId,
    meeting_title: "meta briefing",
    meeting_id: "vou-awaw-ypu",
    source_id: "db2",
    table: "sessions"
  });

  // Intermediate turn: "show recent meetings"
  pipeline._updateActiveEntityFromExecution("show recent meetings", { required_tables: ["sessions"] }, [
    {
      source_id: "db2",
      retrieval: {
        rows: [
          { session_id: initialSessionId, meeting_title: "meta briefing" },
          { session_id: "99999999-aaaa-bbbb-cccc-dddddddddddd", meeting_title: "sprint retrospective" }
        ]
      }
    }
  ]);
  // The general query does not replace the active context with another arbitrary meeting
  assert.strictEqual(pipeline.context_manager.getActiveContext().session_id, initialSessionId);

  // New turn with explicit new meeting name: "show details of sprint retrospective meeting"
  const newSessionId = "99999999-aaaa-bbbb-cccc-dddddddddddd";
  const newQuestion = "show details of sprint retrospective meeting";
  pipeline._updateActiveEntityFromExecution(newQuestion, { required_tables: ["sessions"] }, [
    {
      source_id: "db2",
      retrieval: {
        rows: [
          {
            session_id: newSessionId,
            meeting_title: "sprint retrospective",
            meeting_id: "ret-sprint-999"
          }
        ]
      }
    }
  ]);

  const updatedActiveCtx = pipeline.context_manager.getActiveContext();
  assert.ok(updatedActiveCtx, "Active context must be present");
  assert.strictEqual(updatedActiveCtx.session_id, newSessionId, "Active context session_id must be replaced by the new explicit meeting");
  assert.strictEqual(updatedActiveCtx.meeting_title, "sprint retrospective");

  // Follow-up: "does it have a transcript?" should now query with the NEW session_id
  const followupQuestion = "does it have a transcript?";
  const conversationContext = pipeline._getConversationContext();
  const plan = pipeline.planner._normalize_plan(
    {
      data_sources: ["postgresql"],
      postgresql_sources: ["db2"],
      required_tables: ["transcripts"],
      required_columns: [],
      operations: ["count"],
      filters: []
    },
    followupQuestion,
    conversationContext
  );

  assert.ok(plan.filters.some(f => f.column === "session_id" && f.value === newSessionId), "Must filter by newSessionId");
  assert.ok(!plan.filters.some(f => f.value === initialSessionId), "Must NOT use old session ID");

  const sql = sqlGen.generate(plan, "db2");
  console.log("\n==================== TEST 3 GENERATED SQL ====================");
  console.log(sql);
  console.log("==============================================================\n");

  assert.ok(sql.includes(`FROM "transcripts"`), "Must query transcripts table");
  assert.ok(sql.includes(`"session_id" = '${newSessionId}'`), "Must filter WHERE session_id = <new sprint retrospective session>");
  assert.ok(!sql.includes(initialSessionId), "Must not contain initialSessionId");
});
