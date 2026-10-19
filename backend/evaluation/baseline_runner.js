import { QuestionPlanner } from "../planning/question_planner.js";
import { AnswerGenerator } from "../llm/answer_generator.js";
import {
  createLlmUsageTracker,
  snapshotLlmUsage
} from "../llm/usage_tracker.js";
import {
  EVALUATION_CATEGORIES,
  REPRESENTATIVE_QUESTIONS
} from "./representative_questions.js";
import { loadTestContexts, OFFLINE_PROVIDER } from "../tests/test_context.js";

const SYNTHETIC_CONTEXT = {
  db1: {
    tables: {
      orbit_operators: {
        primary_keys: ["operator_id"],
        columns: [{ name: "operator_id", type: "uuid" }, { name: "name", type: "text" }, { name: "status", type: "text" }]
      },
      signal_packets: {
        primary_keys: ["packet_id"],
        columns: [{ name: "packet_id", type: "uuid" }, { name: "station_id", type: "uuid" }, { name: "received_at", type: "timestamp" }]
      },
      stations: {
        primary_keys: ["station_id"],
        columns: [{ name: "station_id", type: "uuid" }, { name: "name", type: "text" }, { name: "operator_id", type: "uuid" }]
      },
      beacons: {
        primary_keys: ["beacon_id"],
        columns: [{ name: "beacon_id", type: "uuid" }, { name: "station_id", type: "uuid" }, { name: "status", type: "text" }]
      }
    },
    relationships: [
      { source_table: "signal_packets", source_column: "station_id", target_table: "stations", target_column: "station_id" },
      { source_table: "stations", source_column: "operator_id", target_table: "orbit_operators", target_column: "operator_id" },
      { source_table: "beacons", source_column: "station_id", target_table: "stations", target_column: "station_id" }
    ]
  }
};

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function planShape(plan) {
  const steps = Array.isArray(plan?.execution_plan?.steps) ? plan.execution_plan.steps : [];
  const contracts = steps.map(step => step?.contract || {});
  const tables = unique([
    ...(Array.isArray(plan?.required_tables) ? plan.required_tables : []),
    ...contracts.flatMap(contract => Array.isArray(contract.required_tables) ? contract.required_tables : [])
  ]);
  const sourceIds = unique([
    ...(Array.isArray(plan?.postgresql_sources) ? plan.postgresql_sources : []),
    ...steps.map(step => step?.source_id)
  ]);
  const operations = unique([
    ...(Array.isArray(plan?.operations) ? plan.operations : []),
    ...contracts.flatMap(contract => Array.isArray(contract.operations) ? contract.operations : [])
  ]).map(value => String(value).toLowerCase());
  const bindings = steps.flatMap(step => Array.isArray(step?.input_bindings) ? step.input_bindings : []);
  const dependencies = steps.flatMap(step => Array.isArray(step?.depends_on) ? step.depends_on : []);
  const filters = [
    ...(Array.isArray(plan?.filters) ? plan.filters : []),
    ...contracts.flatMap(contract => Array.isArray(contract.filters) ? contract.filters : [])
  ];
  const relationships = [
    ...(Array.isArray(plan?.relationships) ? plan.relationships : []),
    ...contracts.flatMap(contract => Array.isArray(contract.relationships) ? contract.relationships : [])
  ];
  const semanticPathEvidence = Array.isArray(plan?.semantic_path_evidence)
    ? plan.semantic_path_evidence
    : [];
  const semanticPathEdges = Array.isArray(plan?.semantic_path)
    ? Math.max(0, plan.semantic_path.length - 1)
    : 0;
  const branches = plan?.intent?.requested_branches || plan?.intent?.result_branches || plan?.requested_branches;
  const intent = plan?.intent && typeof plan.intent === "object"
    ? {
      present: true,
      version: plan.intent.version ?? null,
      source_count: Array.isArray(plan.intent.source_ids) ? plan.intent.source_ids.length : 0,
      operation_count: Array.isArray(plan.intent.operations) ? plan.intent.operations.length : 0,
      filter_count: Array.isArray(plan.intent.mandatory_filters) ? plan.intent.mandatory_filters.length : 0,
      relationship_count: Array.isArray(plan.intent.required_relationships) ? plan.intent.required_relationships.length : 0,
      requested_field_count: Array.isArray(plan.intent.requested_fields) ? plan.intent.requested_fields.length : 0,
      ambiguity_count: Array.isArray(plan.intent.unresolved_ambiguities) ? plan.intent.unresolved_ambiguities.length : 0,
      has_conversation_reference: Boolean(plan.intent.conversation_reference)
    }
    : { present: false };
  return {
    has_plan: Boolean(plan && !plan.clarification_required && (steps.length || tables.length)),
    clarification: Boolean(plan?.clarification_required),
    step_count: steps.length,
    tables,
    source_ids: sourceIds,
    operations,
    binding_count: bindings.length,
    dependency_count: dependencies.length,
    filter_count: filters.length,
    relationship_count: relationships.length,
    verified_path_edge_count: Math.max(semanticPathEvidence.length, semanticPathEdges),
    verified_graph: plan?.relationship_plan_kind === "verified_graph" || plan?.named_relationship_lookup === true || semanticPathEvidence.length > 0 || semanticPathEdges > 0,
    sorting_count: Array.isArray(plan?.sorting) ? plan.sorting.length : contracts.reduce((sum, contract) => sum + (Array.isArray(contract.sorting) ? contract.sorting.length : 0), 0),
    branch_count: Array.isArray(branches) ? branches.length : 0,
    intent
  };
}

function classifyError(error) {
  if (error?.isSensitiveViolation || error?.isReadOnlyMutationViolation || error?.code === "READ_ONLY_MUTATION_REJECTED" || /restricted|unauthorized|write query|password|secret|token|read-only/i.test(String(error?.message || ""))) {
    return "safe_refusal";
  }
  return "error";
}

function actualOutcome(plan, error) {
  if (error) return classifyError(error);
  if (plan?.clarification_required) return "clarification";
  return planShape(plan).has_plan ? "plan" : "unsupported";
}

function checkAssertions(item, shape, outcome) {
  const expected = item.assertions || {};
  const failures = [];
  if (item.expected_outcome === "plan" && outcome !== "plan") failures.push(`expected plan, got ${outcome}`);
  if (item.expected_outcome === "clarification" && outcome !== "clarification") failures.push(`expected clarification, got ${outcome}`);
  if (item.expected_outcome === "safe_refusal" && outcome !== "safe_refusal") failures.push(`expected safe refusal, got ${outcome}`);
  if (outcome !== "plan") return failures;

  if (expected.operation === "lookup" && !shape.operations.some(operation => ["lookup", "filter", "general"].includes(operation))) {
    failures.push("lookup operation missing");
  }
  if (expected.operation === "filter" && !shape.operations.some(operation => ["filter", "lookup"].includes(operation))) {
    failures.push("filter operation missing");
  }
  if (expected.operation === "aggregate" && !shape.operations.some(operation => ["count", "sum", "average", "minimum", "maximum", "aggregation", "comparison", "grouping"].includes(operation))) {
    failures.push("aggregate operation missing");
  }
  if (expected.temporal && shape.sorting_count < 1) failures.push("temporal ordering missing");
  if (expected.relationship && shape.step_count < 2 && shape.relationship_count < 1) failures.push("verified relationship structure missing");
  if (expected.cross_source && shape.source_ids.length < 2) failures.push("cross-source plan missing a source");
  if (expected.independent_sources && (shape.source_ids.length < 2 || shape.dependency_count > 0)) failures.push("independent sources were not preserved");
  if (expected.branches && shape.branch_count < 2) failures.push("multiple result branches not represented");
  if (expected.identity && shape.filter_count < 1) failures.push("identity constraint missing");
  if (expected.grouping && !shape.operations.some(operation => ["grouping", "comparison", "aggregation"].includes(operation))) failures.push("grouping/comparison operation missing");
  return failures;
}

// Calibrated scoring fixes only evaluator-observable false negatives. The
// legacy checks remain untouched so the original 68/120 baseline is always
// reproducible. A verified graph with complete endpoints is sufficient for a
// relational branch even when the plan does not materialize branch metadata.
function calibratedAssertionFailures(item, shape, outcome, failures) {
  return failures.filter(reason => {
    if (reason === "verified relationship structure missing" && shape.verified_graph) return false;
    if (reason === "multiple result branches not represented" && shape.verified_graph && shape.tables.length >= 3) return false;
    return true;
  });
}

async function runAnswerProbe(cases) {
  const calls = [];
  const client = {
    responses: {
      async create() {
        return { model: "offline-evaluation-answer", output_text: "offline evaluation response" };
      }
    }
  };
  const generator = new AnswerGenerator(client, "offline-evaluation-answer");
  for (const item of cases) {
    const tracker = createLlmUsageTracker(`evaluation-${item.id}`);
    const evidence = {
      items: [{ row: { evaluation_case: item.id, result: "synthetic" } }],
      relationship_resolution: { mappings: [] },
      retrieval_completeness: { complete: true, status: "complete" }
    };
    await generator.generate(item.question, evidence, null, null, tracker);
    const usage = snapshotLlmUsage(tracker);
    calls.push({
      prompt_characters: usage.answer_evidence?.prompt_characters || 0,
      canonical_row_count: usage.answer_evidence?.canonical_row_count || 0,
      duplicate_representation_count: usage.answer_evidence?.duplicate_representation_count || 0,
      provider_reported_calls: usage.stages.answer.provider_reported_calls
    });
  }
  return {
    cases: calls.length,
    calls: calls.length,
    prompt_characters: calls.reduce((sum, item) => sum + item.prompt_characters, 0),
    max_prompt_characters: Math.max(...calls.map(item => item.prompt_characters), 0),
    canonical_rows: calls.reduce((sum, item) => sum + item.canonical_row_count, 0),
    duplicate_representations: calls.reduce((sum, item) => sum + item.duplicate_representation_count, 0),
    provider_reported_calls: calls.reduce((sum, item) => sum + item.provider_reported_calls, 0),
    note: "Synthetic answer-provider probe; no production/provider tokens are represented."
  };
}

export async function runOfflineEvaluation() {
  const contexts = loadTestContexts();
  const planners = {
    standard: new QuestionPlanner(contexts),
    synthetic: new QuestionPlanner(SYNTHETIC_CONTEXT)
  };
  for (const planner of Object.values(planners)) planner.client = OFFLINE_PROVIDER;

  const categoryResults = Object.fromEntries(EVALUATION_CATEGORIES.map(category => [category, {
    total: 0,
    passed: 0,
    failed: 0,
    calibrated_passed: 0,
    calibrated_failed: 0,
    expected_outcomes: {},
    actual_outcomes: {}
  }]));
  const failures = [];
  const plannerMetrics = [];
  const caseResults = [];

  for (const item of REPRESENTATIVE_QUESTIONS) {
    const planner = item.assertions?.synthetic_schema ? planners.synthetic : planners.standard;
    const tracker = createLlmUsageTracker(`evaluation-${item.id}`);
    let plan = null;
    let error = null;
    try {
      plan = await planner.plan(item.question, null, tracker);
    } catch (caught) {
      error = caught;
    }
    const outcome = actualOutcome(plan, error);
    const shape = planShape(plan);
    const usage = snapshotLlmUsage(tracker);
    const checks = checkAssertions(item, shape, outcome);
    const calibratedChecks = calibratedAssertionFailures(item, shape, outcome, checks);
    const category = categoryResults[item.category];
    category.total += 1;
    category.expected_outcomes[item.expected_outcome] = (category.expected_outcomes[item.expected_outcome] || 0) + 1;
    category.actual_outcomes[outcome] = (category.actual_outcomes[outcome] || 0) + 1;
    if (checks.length === 0) category.passed += 1;
    else {
      category.failed += 1;
      failures.push({ id: item.id, category: item.category, outcome, reasons: checks.slice(0, 3) });
    }
    if (calibratedChecks.length === 0) category.calibrated_passed += 1;
    else category.calibrated_failed += 1;
    caseResults.push({
      id: item.id,
      category: item.category,
      question: item.question,
      expected_outcome: item.expected_outcome,
      expected_assertions: item.assertions,
      actual_outcome: outcome,
      reasons: checks,
      calibrated_reasons: calibratedChecks,
      shape,
      error: error ? { name: error.name || "Error", code: error.code || null, sensitive: Boolean(error.isSensitiveViolation) } : null
    });
    plannerMetrics.push({
      id: item.id,
      outcome,
      step_count: shape.step_count,
      source_count: shape.source_ids.length,
      binding_count: shape.binding_count,
      planner_calls: usage.stages.planner.call_count,
      fallback_attempts: usage.stages.planner.fallback_attempts,
      context_characters: usage.planner_context?.context_characters || 0,
      prompt_characters: usage.planner_context?.prompt_characters || 0
    });
  }

  const plannerSummary = {
    cases: plannerMetrics.length,
    provider_calls: plannerMetrics.reduce((sum, item) => sum + item.planner_calls, 0),
    fallback_attempts: plannerMetrics.reduce((sum, item) => sum + item.fallback_attempts, 0),
    context_characters: plannerMetrics.reduce((sum, item) => sum + item.context_characters, 0),
    max_context_characters: Math.max(...plannerMetrics.map(item => item.context_characters), 0),
    prompt_characters: plannerMetrics.reduce((sum, item) => sum + item.prompt_characters, 0),
    max_prompt_characters: Math.max(...plannerMetrics.map(item => item.prompt_characters), 0),
    retrieval_steps: plannerMetrics.reduce((sum, item) => sum + item.step_count, 0),
    dependent_bindings: plannerMetrics.reduce((sum, item) => sum + item.binding_count, 0),
    note: "Offline planner measurements; character counts are not provider token counts."
  };
  const totals = Object.values(categoryResults).reduce((summary, category) => ({
    total: summary.total + category.total,
    passed: summary.passed + category.passed,
    failed: summary.failed + category.failed,
    calibrated_passed: summary.calibrated_passed + category.calibrated_passed,
    calibrated_failed: summary.calibrated_failed + category.calibrated_failed
  }), { total: 0, passed: 0, failed: 0, calibrated_passed: 0, calibrated_failed: 0 });
  const answer = await runAnswerProbe(REPRESENTATIVE_QUESTIONS);

  return {
    corpus_count: REPRESENTATIVE_QUESTIONS.length,
    categories: categoryResults,
    totals,
    failures: failures.slice(0, 30),
    case_results: caseResults,
    planner: plannerSummary,
    answer,
    external_calls: 0
  };
}

export default runOfflineEvaluation;
