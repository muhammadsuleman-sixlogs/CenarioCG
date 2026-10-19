import assert from "node:assert/strict";
import { test } from "node:test";
import { QuestionPlanner } from "../planning/question_planner.js";
import { RAGPipeline } from "../pipeline/rag_pipeline.js";
import { loadTestContexts, OFFLINE_PROVIDER } from "./test_context.js";
import {
  isMutationQuestionIntent,
  isSensitiveQuestionIntent
} from "../security/sensitive_data_policy.js";

const contexts = loadTestContexts();

function relationshipSignature(plan) {
  return {
    sources: plan.postgresql_sources,
    steps: (plan.execution_plan?.steps || []).map(step => ({
      source_id: step.source_id,
      table: step.contract?.required_tables?.[0],
      depends_on: step.depends_on,
      bindings: (step.input_bindings || []).map(binding => ({
        from_column: binding.from_column,
        to_table: binding.to_table,
        to_column: binding.to_column
      }))
    }))
  };
}

test("explicit mutation intent is rejected while read-only change terminology remains allowed", () => {
  for (const question of [
    "Insert a new ticket row.",
    "Update the company name to Example.",
    "Delete all inactive tickets.",
    "Drop the old projects table.",
    "Alter the users table.",
    "Truncate the audit table.",
    "Run a write query against the audit database."
  ]) assert.equal(isMutationQuestionIntent(question), true, question);

  for (const question of [
    "Which users were updated recently?",
    "Show deleted-status records.",
    "How many tickets were closed yesterday?",
    "Show tickets with a note saying update the plan."
  ]) assert.equal(isMutationQuestionIntent(question), false, question);
  assert.equal(isSensitiveQuestionIntent("Show deleted-status records."), false);
});

test("mutation intent fails before provider planning", async () => {
  const planner = new QuestionPlanner(contexts);
  let providerCalls = 0;
  planner.client = { responses: { async create() { providerCalls += 1; return { output_text: "{}" }; } } };
  await assert.rejects(
    planner.plan("Delete all inactive tickets."),
    error => error.code === "READ_ONLY_MUTATION_REJECTED" && error.isReadOnlyMutationViolation === true
  );
  assert.equal(providerCalls, 0);
});

test("pipeline returns a controlled read-only refusal without answer synthesis", async () => {
  const pipeline = new RAGPipeline();
  pipeline.planner = new QuestionPlanner(contexts);
  pipeline.planner.client = OFFLINE_PROVIDER;
  let answerCalls = 0;
  pipeline.answer_generator = { async generate() { answerCalls += 1; return "unexpected"; } };
  const result = await pipeline.ask("Run a write query against the audit database.", {
    workspace_id: "offline",
    authorization: { postgresql_sources: ["db1", "db2"], security_resources: [] }
  });
  assert.equal(result.error.type, "read_only_source");
  assert.match(result.answer, /read-only/i);
  assert.equal(answerCalls, 0);
});

test("explicit email identity predicates remain source-qualified and complete", async () => {
  const planner = new QuestionPlanner(contexts);
  planner.client = OFFLINE_PROVIDER;
  for (const question of [
    "Which company does this user belong to? morgan@example.test",
    "Show the account for login morgan@example.test.",
    "List users matching morgan@example.test."
  ]) {
    const plan = await planner.plan(question);
    const filters = [
      ...(plan.filters || []),
      ...(plan.execution_plan?.steps || []).flatMap(step => step.contract?.filters || [])
    ];
    assert.ok(filters.some(filter => filter.field === "email" && filter.value === "morgan@example.test"), question);
    const completeness = planner.assess_semantic_completeness(plan, question);
    if (/belong/i.test(question)) assert.equal(completeness.complete, false, question);
    else assert.equal(completeness.complete, true, question);
  }
  const incomplete = { required_tables: ["users"], filters: [] };
  assert.equal(planner.assess_semantic_completeness(incomplete, "List users matching morgan@example.test.").complete, false);
});

test("possessive and assignment paraphrases compile to the same verified graph", async () => {
  const planner = new QuestionPlanner(contexts);
  planner.client = OFFLINE_PROVIDER;
  const equivalent = [
    "Show Umar's company users and their tasks.",
    "Show tasks assigned to users belonging to Umar's company.",
    "Which tasks belong to employees at Umar's company?"
  ];
  const plans = await Promise.all(equivalent.map(question => planner.plan(question)));
  const signatures = plans.map(relationshipSignature);
  assert.deepEqual(signatures[1], signatures[0]);
  assert.deepEqual(signatures[2], signatures[0]);
  for (let index = 0; index < equivalent.length; index++) {
    assert.equal(planner.assess_semantic_completeness(plans[index], equivalent[index]).complete, true);
  }
});
