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
  // General list query should NOT lock onto a single meeting as active context
  assert.strictEqual(pipeline.context_manager.getActiveContext(), null);

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
