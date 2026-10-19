import { test } from "node:test";
import assert from "node:assert/strict";
import { RAGPipeline } from "../pipeline/rag_pipeline.js";
import { QuestionPlanner } from "../planning/question_planner.js";
import { QuestionPlanValidator } from "../planning/question_plan_validator.js";
import { SourceRouter } from "../planning/source_router.js";
import { ContextManager } from "../context/context_manager.js";
import { validateReadOnlyQuery } from "../database/readonly_guard.js";
import { EvidenceManager } from "../llm/evidence_manager.js";
import { AnswerGenerator } from "../llm/answer_generator.js";
import { createLlmUsageTracker, measureAnswerEvidenceStructure, snapshotLlmUsage } from "../llm/usage_tracker.js";
import { loadTestContexts, OFFLINE_PROVIDER } from "./test_context.js";

function activeUserSet(values = ["u1", "u2"]) {
  return {
    source_id: "db1",
    table: "users",
    record_set: { key_column: "id", values, count: values.length },
    relationship_keys: { id: values, company_id: ["c1"] },
    validation_status: "retrieval_evidence_confirmed",
    provenance: "successful_source_retrieval"
  };
}

function relationshipResults(userRows, companyRows) {
  return [
    {
      source_type: "postgresql",
      source_id: "db1",
      execution_step_id: "s1",
      retrieval_status: "success_with_data",
      retrieval: { rows: userRows, row_count: userRows.length, columns: ["id", "company_id"] },
      sources: [{ source_type: "postgresql", source_id: "db1", tables: ["users"], columns: ["id", "company_id"], row_count: userRows.length }]
    },
    {
      source_type: "postgresql",
      source_id: "db1",
      execution_step_id: "s2",
      retrieval_status: "success_with_data",
      retrieval: { rows: companyRows, row_count: companyRows.length, columns: ["id", "name"] },
      sources: [{ source_type: "postgresql", source_id: "db1", tables: ["companies"], columns: ["id", "name"], row_count: companyRows.length }]
    }
  ];
}

test("named multi-row retrieval establishes a bounded source-qualified record set", () => {
  const pipeline = new RAGPipeline();
  const rows = Array.from({ length: 11 }, (_, index) => ({ id: `u-${index}`, company_id: "c1" }));
  pipeline._updateActiveEntityFromExecution(
    "show me user Umar Daraz status",
    { required_tables: ["users"], named_entity_lookup: true },
    [{ source_id: "db1", retrieval: { rows } }]
  );

  const active = pipeline.context_manager.getActiveContext();
  assert.equal(active.source_id, "db1");
  assert.equal(active.table, "users");
  assert.equal(active.record_set.count, 11);
  assert.deepEqual(active.record_set.values, rows.map(row => row.id));
  assert.deepEqual(active.relationship_keys.company_id, ["c1"]);
});

test("singular and plural follow-ups use the existing verified relationship path and IN binding", async () => {
  const contexts = loadTestContexts();
  const planner = new QuestionPlanner(contexts);
  planner.client = OFFLINE_PROVIDER;
  const conversation = { active_context: activeUserSet(), history: [], entities: [], pending_reference: null };

  for (const question of ["Which company does this user belong to?", "Which company do these users belong to?"]) {
    const plan = await planner.plan(question, conversation);
    assert.deepEqual(plan.required_tables, []);
    assert.equal(plan.execution_plan.steps[0].contract.filters[0].operator, "in");
    assert.deepEqual(plan.execution_plan.steps[0].contract.filters[0].value, ["u1", "u2"]);
    assert.equal(plan.execution_plan.steps[1].input_bindings[0].operator, "in");
    assert.deepEqual(plan.semantic_path.map(step => `${step.source_id}.${step.table}`), ["db1.users", "db1.companies"]);
    assert.equal(plan.semantic_path_evidence[0], "db1.users.company_id -> db1.companies.id");
  }
});

test("an explicit email qualifier narrows the bounded user set before relationship resolution", async () => {
  const contexts = loadTestContexts();
  const planner = new QuestionPlanner(contexts);
  planner.client = OFFLINE_PROVIDER;
  const conversation = { active_context: activeUserSet(Array.from({ length: 11 }, (_, index) => `u-${index + 1}`)), history: [], entities: [], pending_reference: null };
  const plan = await planner.plan("Which company does this user belong to? umar.daraz@sixlogs.com", conversation);
  const firstStep = plan.execution_plan.steps[0];
  const filters = firstStep.contract.filters;
  assert.deepEqual(filters[0], { table: "users", field: "id", operator: "in", value: conversation.active_context.record_set.values });
  assert.deepEqual(filters[1], { table: "users", field: "email", operator: "case_insensitive_equals", value: "umar.daraz@sixlogs.com" });
  assert.deepEqual(plan.semantic_path.map(step => `${step.source_id}.${step.table}`), ["db1.users", "db1.companies"]);
});

test("vague project association does not guess among multiple verified user roles", async () => {
  const contexts = loadTestContexts();
  const planner = new QuestionPlanner(contexts);
  planner.client = OFFLINE_PROVIDER;
  const conversation = { active_context: activeUserSet(), history: [], entities: [], pending_reference: null };
  const plan = await planner.plan("Show me the projects associated with those users", conversation);
  assert.equal(plan.clarification_required?.type, "relationship_role_ambiguous");
  assert.equal(plan.execution_plan, undefined);
});

test("singular multi-identity follow-ups permit only a verified common result", async () => {
  const contexts = loadTestContexts();
  const planner = new QuestionPlanner(contexts);
  planner.client = OFFLINE_PROVIDER;
  const conversation = { active_context: activeUserSet(), history: [], entities: [], pending_reference: null };
  const plan = await planner.plan("Which company does this user belong to?", conversation);
  const pipeline = new RAGPipeline();
  pipeline.plan_validator.contexts = contexts;

  const common = pipeline._resolveFollowupIdentityResolution(
    "Which company does this user belong to?",
    conversation,
    plan,
    relationshipResults(
      [{ id: "u1", company_id: "c1" }, { id: "u2", company_id: "c1" }],
      [{ id: "c1", name: "Cenario" }]
    )
  );
  assert.equal(common.status, "complete");
  assert.equal(common.scope, "common_across_matching_records");
  assert.equal(common.requires_clarification, undefined);
  assert.equal(common.mappings.length, 2);

  const conflicting = pipeline._resolveFollowupIdentityResolution(
    "Which company does this user belong to?",
    conversation,
    plan,
    relationshipResults(
      [{ id: "u1", company_id: "c1" }, { id: "u2", company_id: "c2" }],
      [{ id: "c1", name: "Cenario" }, { id: "c2", name: "Other" }]
    )
  );
  assert.equal(conflicting.status, "conflict");
  assert.equal(conflicting.requires_clarification, true);
  assert.equal(conflicting.missing_count, 0);

  const incomplete = pipeline._resolveFollowupIdentityResolution(
    "Which company does this user belong to?",
    conversation,
    plan,
    relationshipResults(
      [{ id: "u1", company_id: "c1" }],
      [{ id: "c1", name: "Cenario" }]
    )
  );
  assert.equal(incomplete.status, "incomplete");
  assert.equal(incomplete.requires_clarification, true);
  assert.deepEqual(incomplete.missing_identities, ["u2"]);
});

test("relationship answer evidence keeps final rows and source-qualified mappings only", () => {
  const manager = new EvidenceManager();
  const userRows = Array.from({ length: 11 }, (_, index) => ({
    id: `u${index + 1}`,
    company_id: "c1",
    email: `umar-${index + 1}@example.test`,
    department: "consulting",
    description: "A sufficiently detailed authorized user record that should not be replayed to the answer model."
  }));
  const internal = {
    items: [
      ...userRows.map((row, index) => ({ evidence_id: `e${index + 1}`, source_id: "db1", execution_step_id: "s1", table: "users", row })),
      { evidence_id: "e3", source_id: "db1", execution_step_id: "s2", table: "companies", row: { id: "c1", name: "Cenario" } }
    ],
    sources: [
      { source_type: "postgresql", source_id: "db1", tables: ["users"], columns: ["id", "company_id"], row_count: 11, rows: userRows },
      { source_type: "postgresql", source_id: "db1", tables: ["companies"], columns: ["id", "name"], row_count: 1, rows: [{ id: "c1" }] }
    ],
    postgresql: {
      rows: [...userRows, { id: "c1" }],
      sources: [{ source_id: "db1", rows: userRows }]
    }
  };
  const resolution = {
    mode: "singular",
    scope: "common_across_matching_records",
    status: "complete",
    requested_count: 2,
    matched_identity_count: 2,
    association_count: 2,
    missing_count: 0,
    conflict_count: 0,
    mappings: [
      { from_source_id: "db1", from_table: "users", from_key: "id", from_value: "u1", to_source_id: "db1", to_table: "companies", to_key: "id", to_values: ["c1"], status: "verified" },
      { from_source_id: "db1", from_table: "users", from_key: "id", from_value: "u2", to_source_id: "db1", to_table: "companies", to_key: "id", to_values: ["c1"], status: "verified" }
    ]
  };
  internal.relationship_resolution = resolution;
  const before = JSON.stringify(internal);
  const compact = manager.prepareAnswerEvidence(internal, {
    relationship: {
      final_step_id: "s2",
      source_ids: ["db1"],
      resolution,
      path: [{ source_id: "db1", table: "users", column: "id" }, { source_id: "db1", table: "companies", column: "id" }],
      evidence_relationships: ["db1.users.company_id -> db1.companies.id"]
    }
  });

  assert.equal(JSON.stringify(internal), before);
  assert.deepEqual(compact.items.map(item => item.row), [{ id: "c1", name: "Cenario" }]);
  assert.equal(compact.relationship_resolution.mappings.length, 2);
  assert.equal(compact.relationship_resolution.mappings[0].from_source_id, "db1");
  assert.deepEqual(compact.relationship_evidence, ["db1.users.company_id -> db1.companies.id"]);
  assert.equal(compact.postgresql, undefined);
  const fullMetrics = measureAnswerEvidenceStructure(internal);
  const compactMetrics = measureAnswerEvidenceStructure(compact);
  assert.ok(compactMetrics.evidence_characters < fullMetrics.evidence_characters);
  assert.equal(compactMetrics.duplicate_representation_count, 0);
  assert.equal(compactMetrics.canonical_row_count, 1);
});

test("same-looking identifiers remain separate across authorized sources", () => {
  const manager = new EvidenceManager();
  const internal = {
    items: [
      { evidence_id: "db1-company", source_id: "db1", execution_step_id: "db1-final", table: "companies", row: { id: "c1", name: "Cenario" } },
      { evidence_id: "db2-company", source_id: "db2", execution_step_id: "db2-final", table: "companies", row: { id: "c1", name: "Cenario" } }
    ],
    sources: [
      { source_type: "postgresql", source_id: "db1", tables: ["companies"], columns: ["id", "name"], row_count: 1 },
      { source_type: "postgresql", source_id: "db2", tables: ["companies"], columns: ["id", "name"], row_count: 1 }
    ],
    relationship_resolution: {
      status: "complete",
      mappings: [
        { from_source_id: "db1", from_table: "users", from_key: "id", from_value: "u1", to_source_id: "db1", to_table: "companies", to_key: "id", to_values: ["c1"], status: "verified" },
        { from_source_id: "db2", from_table: "users", from_key: "id", from_value: "u1", to_source_id: "db2", to_table: "companies", to_key: "id", to_values: ["c1"], status: "verified" }
      ]
    }
  };
  const compact = manager.prepareAnswerEvidence(internal, {
    relationship: {
      source_ids: ["db1", "db2"],
      resolution: internal.relationship_resolution,
      path: [],
      evidence_relationships: []
    }
  });
  assert.deepEqual(compact.items.map(item => item.source_id), ["db1", "db2"]);
  assert.equal(compact.relationship_resolution.mappings.length, 2);
  assert.deepEqual(compact.relationship_resolution.mappings.map(mapping => mapping.to_source_id), ["db1", "db2"]);
});

test("invalid conversation references are cleared before follow-up planning", () => {
  const pipeline = new RAGPipeline();
  pipeline.plan_validator.contexts = {
    db1: { tables: { users: { columns: [{ name: "id" }] } } }
  };
  const conversation = {
    active_context: { source_id: "db9", table: "users", stable_keys: { id: "u1" } },
    pending_reference: { source_id: "db1", table: "removed_users", stable_keys: { id: "u1" } },
    entities: []
  };
  pipeline._revalidateConversationReferences(conversation);
  assert.equal(conversation.active_context, null);
  assert.equal(conversation.pending_reference, null);
});

test("pipeline preserves the multi-row user set and sends only final relationship rows", async () => {
  const contexts = loadTestContexts();
  const manager = new ContextManager();
  const pipeline = new RAGPipeline(manager);
  pipeline.plan_validator = new QuestionPlanValidator(contexts);
  pipeline.planValidator = pipeline.plan_validator;
  pipeline.planner = new QuestionPlanner(contexts);
  pipeline.planner.client = OFFLINE_PROVIDER;
  pipeline.source_router = new SourceRouter(contexts);
  pipeline.entity_resolver = { async resolve() { return []; } };
  const userRows = Array.from({ length: 11 }, (_, index) => ({
    id: `u${index + 1}`,
    company_id: "c1",
    first_name: "Umar",
    last_name: "Daraz",
    consultant_status: "active"
  }));
  const captured = [];
  let queryCount = 0;
  pipeline.executor = {
    async execute(sql, sourceId) {
      validateReadOnlyQuery(sql);
      queryCount += 1;
      if (/FROM\s+"users"/i.test(sql)) {
        return { rows: userRows, row_count: userRows.length, columns: ["id", "company_id", "first_name", "last_name", "consultant_status"] };
      }
      return { rows: [{ id: "c1", name: "Cenario" }], row_count: 1, columns: ["id", "name"] };
    }
  };
  pipeline.answer_generator = {
    async generate(_question, evidence) {
      captured.push(evidence);
      return "All matching records belong to Cenario.";
    }
  };
  const auth = { workspace_id: "offline", authorization: { postgresql_sources: ["db1"], security_resources: [] } };

  const first = await pipeline.ask("Show me user Umar Daraz status", auth);
  const second = await pipeline.ask("Which company does this user belong to?", auth);

  assert.equal(first.retrieval_status, "success_with_data");
  assert.equal(second.retrieval_status, "success_with_data");
  assert.equal(queryCount, 3);
  assert.equal(manager.getActiveContext().record_set, undefined);
  assert.equal(captured.length, 2);
  assert.equal(captured[1].evidence_scope, "verified_relationship");
  assert.deepEqual(captured[1].items.map(item => item.row), [{ id: "c1", name: "Cenario" }]);
  assert.equal(captured[1].relationship_resolution.status, "complete");
  assert.equal(captured[1].relationship_resolution.scope, "common_across_matching_records");
  assert.equal(second.evidence.items.length, 12);
  assert.equal(second.evidence.sources.length, 2);
});

test("pipeline applies an explicit email to the prior user set before selecting the company", async () => {
  const contexts = loadTestContexts();
  const manager = new ContextManager();
  const pipeline = new RAGPipeline(manager);
  pipeline.plan_validator = new QuestionPlanValidator(contexts);
  pipeline.planValidator = pipeline.plan_validator;
  pipeline.planner = new QuestionPlanner(contexts);
  pipeline.planner.client = OFFLINE_PROVIDER;
  pipeline.source_router = new SourceRouter(contexts);
  pipeline.entity_resolver = { async resolve() { return []; } };
  const allUsers = Array.from({ length: 11 }, (_, index) => ({
    id: `u-${index + 1}`,
    email: index === 0 ? "umar.daraz@sixlogs.com" : `other-${index + 1}@example.test`,
    company_id: "c1",
    first_name: "Umar",
    last_name: "Daraz",
    consultant_status: "active"
  }));
  const capturedSql = [];
  let queryCount = 0;
  pipeline.executor = {
    async execute(sql) {
      validateReadOnlyQuery(sql);
      capturedSql.push(sql);
      queryCount += 1;
      if (/FROM\s+"users"|JOIN\s+"users"/i.test(sql)) {
        const rows = /LOWER\("users"\."email"\)/i.test(sql) ? [allUsers[0]] : allUsers;
        return { rows, row_count: rows.length, columns: ["id", "email", "company_id", "first_name", "last_name", "consultant_status"] };
      }
      return { rows: [{ id: "c1", name: "Cenario" }], row_count: 1, columns: ["id", "name"] };
    }
  };
  pipeline.answer_generator = { async generate() { return "Cenario"; } };
  const auth = { workspace_id: "offline", authorization: { postgresql_sources: ["db1"], security_resources: [] } };

  await pipeline.ask("Show me user Umar Daraz status", auth);
  const result = await pipeline.ask("Which company does this user belong to? umar.daraz@sixlogs.com", auth);

  assert.equal(result.retrieval_status, "success_with_data");
  assert.equal(queryCount, 3);
  assert.ok(capturedSql.some(sql => /"users"\."email"\s+ILIKE\s+%s/i.test(sql)));
  assert.equal(manager.getActiveContext().table, "companies");
  assert.equal(manager.getActiveContext().stable_keys.id, "c1");
  assert.equal(manager.getActiveContext().related_references[0].table, "users");

  const companyUsers = await pipeline.ask("Show me all users belonging to that company", auth);
  assert.equal(companyUsers.retrieval_status, "success_with_data");
  assert.ok(capturedSql.some(sql => /JOIN\s+"users"/i.test(sql) && /"users"\."company_id"\s*=\s+%s/i.test(sql)));
  assert.equal(manager.getActiveContext().table, "users");
});

test("answer-generation metrics remain structural and provider usage remains separate", async () => {
  const tracker = createLlmUsageTracker("followup-structural");
  let prompt = "";
  const answerGenerator = new AnswerGenerator({
    responses: {
      async create(options) {
        prompt = options.input;
        return {
          model: "mock-answer-model",
          output_text: "All matching records belong to Cenario.",
          usage: { input_tokens: 123, output_tokens: 9, input_tokens_details: { cached_tokens: 0 } }
        };
      }
    }
  }, "mock-answer-model");

  await answerGenerator.generate(
    "Which company does this user belong to?",
    {
      source_type: "postgresql",
      evidence_scope: "verified_relationship",
      items: [{ source_id: "db1", execution_step_id: "s2", table: "companies", row: { id: "c1", name: "Cenario" } }],
      sources: [{ source_type: "postgresql", source_id: "db1", tables: ["companies"], row_count: 1 }],
      relationship_resolution: { mappings: [{ from_source_id: "db1", to_source_id: "db1" }], status: "complete" }
    },
    null,
    null,
    tracker
  );

  const usage = snapshotLlmUsage(tracker);
  assert.match(prompt, /Cenario/);
  assert.equal(usage.stages.answer.totals.input_tokens.value, 123);
  assert.equal(usage.answer_evidence.canonical_row_count, 1);
  assert.equal(usage.answer_evidence.relationship_mapping_count, 1);
  assert.equal(usage.answer_evidence.duplicate_representation_count, 0);
  assert.equal(typeof usage.answer_evidence.prompt_characters, "number");
  assert.equal(Object.prototype.hasOwnProperty.call(usage.answer_evidence, "prompt"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(usage.answer_evidence, "evidence"), false);
});
