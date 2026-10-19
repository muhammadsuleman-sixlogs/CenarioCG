import { test } from "node:test";
import assert from "node:assert/strict";
import { QuestionPlanner } from "../planning/question_planner.js";
import { QuestionPlanValidator } from "../planning/question_plan_validator.js";
import { ComplexQueryPlanner } from "../planning/complex_query_planner.js";
import { QueryPlanExecutor } from "../retrieval/query_plan_executor.js";
import { SQLGenerator } from "../retrieval/sql_generator.js";
import { findSemanticCandidates } from "../context/semantic_catalog.js";
import { loadTestContexts, OFFLINE_PROVIDER } from "./test_context.js";

test("direct named user intent keeps discovered users and takes the deterministic path", async () => {
  const contexts = loadTestContexts();
  const planner = new QuestionPlanner(contexts);
  let providerCalls = 0;
  planner.client = {
    responses: {
      async create() {
        providerCalls += 1;
        return { output_text: "{}" };
      }
    }
  };

  const candidates = findSemanticCandidates("show me user umar daraz status", contexts);
  assert.deepEqual(candidates.map(candidate => `${candidate.source_id}.${candidate.table}`), ["db1.users", "db2.users"]);

  for (const question of ["show me user umar daraz status", "show me umar daraz user status"]) {
    const plan = await planner.plan(question);
    assert.equal(plan.postgresql_sources[0], "db1");
    assert.deepEqual(plan.required_tables, ["users"]);
    assert.deepEqual(plan.filters.map(filter => filter.field), ["first_name", "last_name"]);
    assert.ok(plan.required_columns.includes("users.consultant_status"));
    assert.equal(plan.required_columns.some(column => /password|token|secret|hash/i.test(column)), false);
    assert.equal(plan.named_entity_lookup, true);
  }

  assert.equal(providerCalls, 0);
});

test("named user company and task requests use declared FK hops without a provider call", async () => {
  const planner = new QuestionPlanner(loadTestContexts());
  let providerCalls = 0;
  planner.client = {
    responses: {
      async create() {
        providerCalls += 1;
        return { output_text: "{}" };
      }
    }
  };

  for (const question of [
    "Show me Umar Daraz company users and their project task",
    "Show me umar daraz company users and their project task",
    "Show me tasks assigned to users belonging to Umar Daraz's company.",
    "Show the tasks of employees at Umar Daraz's company.",
    "Show Umar Daraz's company users and their tasks."
  ]) {
    const plan = await planner.plan(question);
    assert.deepEqual(plan.postgresql_sources, ["db1"]);
    assert.equal(plan.named_relationship_lookup, true);
    assert.deepEqual(plan.execution_plan.steps.map(step => step.contract.required_tables[0]), [
      "users", "companies", "users", "project_tasks"
    ]);
    assert.deepEqual(plan.execution_plan.steps[0].contract.filters.map(filter => ({ ...filter, value: String(filter.value).toLowerCase() })), [
      { table: "users", field: "first_name", operator: "case_insensitive_equals", value: "umar" },
      { table: "users", field: "last_name", operator: "case_insensitive_equals", value: "daraz" }
    ]);
    assert.deepEqual(plan.execution_plan.steps[1].input_bindings, [{
      from_step: "s1", from_column: "company_id", to_table: "companies", to_column: "id", operator: "in"
    }]);
    assert.deepEqual(plan.execution_plan.steps[3].input_bindings, [{
      from_step: "s3", from_column: "id", to_table: "project_tasks", to_column: "assignee_id", operator: "in"
    }]);
  }

  assert.equal(providerCalls, 0);
});

test("named user company task plan exposes validated semantic-path columns", async () => {
  const contexts = loadTestContexts();
  const planner = new QuestionPlanner(contexts);
  const plan = await planner.plan("show me umar daraz company users and project task");
  const validation = new QuestionPlanValidator(contexts).validate(plan);

  assert.equal(validation.valid, true, validation.errors.join("; "));
  assert.deepEqual(plan.semantic_path.map(step => step.column), [
    "company_id", "id", "company_id", "assignee_id"
  ]);
});

test("named company users request binds users to the matched company", async () => {
  const contexts = loadTestContexts();
  const planner = new QuestionPlanner({ db1: contexts.db1 });
  planner.client = OFFLINE_PROVIDER;
  const plan = await planner.plan("show me rahim company users details");

  assert.equal(plan.named_relationship_lookup, true);
  assert.deepEqual(plan.execution_plan.steps.map(step => step.contract.required_tables[0]), ["companies", "users"]);
  assert.deepEqual(plan.execution_plan.steps[0].contract.filters, [{
    table: "companies", field: "name", operator: "contains", value: "rahim company"
  }]);
  assert.deepEqual(plan.execution_plan.steps[1].input_bindings, [{
    from_step: "s1", from_column: "id", to_table: "users", to_column: "company_id", operator: "in"
  }]);
});

test("semantic completeness rejects users-only task plans and accepts the verified assignment path", () => {
  const planner = new QuestionPlanner(loadTestContexts());
  const question = "Show me tasks assigned to users belonging to a named person's company";
  const incomplete = planner.assess_semantic_completeness({ required_tables: ["users"] }, question);
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.reason, "incomplete_task_assignment_path");

  const complete = planner._build_metadata_fallback_plan("Show me tasks assigned to users belonging to Umar Daraz's company.");
  const verified = planner.assess_semantic_completeness(complete, "Show me tasks assigned to users belonging to Umar Daraz's company.");
  assert.equal(verified.complete, true);
});

test("multi-branch completeness rejects an omitted requested branch", () => {
  const planner = new QuestionPlanner({
    alpha: {
      tables: {
        users: { columns: [{ name: "id" }] },
        work_items: { columns: [{ name: "id" }, { name: "assignee_id" }] }
      },
      relationships: [{ source_table: "work_items", source_column: "assignee_id", target_table: "users", target_column: "id" }]
    }
  });
  const question = "Show users and work items";
  const result = planner.assess_semantic_completeness({ required_tables: ["users"] }, question);
  assert.equal(result.complete, false);
  assert.match(result.reason, /^missing_requested_branch:/);
});

test("completeness rejects plans that omit requested count or temporal operations", () => {
  const planner = new QuestionPlanner(loadTestContexts());
  const count = planner.assess_semantic_completeness({
    candidate_resolution: { mode: "independent" },
    operations: ["lookup"],
    required_tables: ["companies"]
  }, "What is the total number of companies?");
  assert.equal(count.complete, false);
  assert.equal(count.reason, "missing_requested_operation:count");

  const recent = planner.assess_semantic_completeness({
    operations: ["lookup"],
    required_tables: ["sessions"]
  }, "Show the latest meetings.");
  assert.equal(recent.complete, false);
  assert.equal(recent.reason, "missing_requested_operation:ranking");
});

test("generic meeting-project-company wording composes the approved federated path", async () => {
  const planner = new QuestionPlanner(loadTestContexts());
  planner.client = OFFLINE_PROVIDER;
  const question = "Which meeting belongs to which project and company?";
  const plan = await planner.plan(question);
  const completeness = planner.assess_semantic_completeness(plan, question);

  assert.equal(plan.relationship_plan_kind, "verified_graph");
  assert.deepEqual(plan.execution_plan.steps.map(step => `${step.source_id}.${step.contract.required_tables[0]}`), [
    "db2.sessions",
    "db2.projects",
    "db1.project_details",
    "db1.companies"
  ]);
  assert.deepEqual(plan.execution_plan.steps.slice(1).map(step => step.input_bindings[0].to_column), [
    "project_id",
    "id",
    "id"
  ]);
  assert.equal(completeness.complete, true);
});

test("equivalent meeting relationship wording reuses the same verified graph", async () => {
  const contexts = loadTestContexts();
  const planner = new QuestionPlanner(contexts);
  planner.client = OFFLINE_PROVIDER;
  const questions = [
    "Which meeting belongs to which project and company?",
    "Show meetings with their project and company names.",
    "List meetings alongside project and company names.",
    "Show each meeting's project and its company.",
    "Show recent meetings with their project and company names."
  ];
  const plans = await Promise.all(questions.map(question => planner.plan(question)));
  const graphSignature = plan => ({
    sources: plan.postgresql_sources,
    steps: plan.execution_plan.steps.map(step => ({
      source_id: step.source_id,
      table: step.contract.required_tables[0],
      depends_on: step.depends_on,
      bindings: step.input_bindings.map(binding => ({
        from_step: binding.from_step,
        from_column: binding.from_column,
        to_table: binding.to_table,
        to_column: binding.to_column
      }))
    }))
  });
  const expected = graphSignature(plans[0]);
  for (const [index, plan] of plans.entries()) {
    const validation = new QuestionPlanValidator(contexts).validate(plan);
    assert.equal(validation.valid, true, `${questions[index]}: ${validation.errors.join("; ")}`);
    assert.equal(planner.assess_semantic_completeness(plan, questions[index]).complete, true);
    assert.deepEqual(graphSignature(plan), expected);
    assert.ok(plan.execution_plan.steps.some(step => step.output_columns.some(column => /(?:meeting_title|project_title|project_name|companies?\.name|\.name$)/i.test(column))));
  }
  for (const question of [questions[1], questions[2], questions[4]]) {
    assert.ok(planner.semantic_intent(question).requested_attributes.includes("name"));
  }
  const recent = plans.at(-1);
  assert.deepEqual(recent.operations, ["ranking"]);
  assert.deepEqual(recent.sorting, [{ field: "sessions.created_at", direction: "desc" }]);
  assert.deepEqual(recent.execution_plan.steps[0].contract.sorting, recent.sorting);
});

test("relationship pronouns are recognized on unfamiliar semantic entities", () => {
  const planner = new QuestionPlanner({
    archive: {
      tables: {
        conversation_logs: { columns: [{ name: "log_key" }] },
        initiatives: { columns: [{ name: "initiative_key" }] },
        organizations: { columns: [{ name: "organization_key" }] }
      },
      relationships: [],
      semantic_catalog: {
        entities: {
          conversation_logs: { entity_type: "meeting", synonyms: ["meeting", "meetings"] },
          initiatives: { entity_type: "project", synonyms: ["initiative", "initiatives"] },
          organizations: { entity_type: "company", synonyms: ["organization", "organizations"] }
        }
      }
    }
  });
  const intent = planner.semantic_intent("Show meetings with their initiatives and organizations");
  assert.equal(intent.relationship_intent, true);
  assert.deepEqual(intent.anchor_entities, [{ kind: "entity_anchor", source_id: "archive", table: "conversation_logs", role: "meeting" }]);
  assert.deepEqual(intent.requested_attributes, []);
  assert.deepEqual(intent.requested_branches.map(branch => branch.required_entities[0]), [
    { source_id: "archive", table: "conversation_logs" },
    { source_id: "archive", table: "initiatives" },
    { source_id: "archive", table: "organizations" }
  ]);
});

test("approved federated relationship compiles to parameterized dependent SQL", async () => {
  const contexts = loadTestContexts();
  const planner = new QuestionPlanner(contexts);
  const question = "Which meeting belongs to which project and company?";
  const plan = await planner.plan(question);
  assert.equal(new QuestionPlanValidator(contexts).validate(plan).valid, true);

  const queryPlan = new ComplexQueryPlanner().build(question, plan);
  const generators = { db1: new SQLGenerator(contexts.db1, "db1"), db2: new SQLGenerator(contexts.db2, "db2") };
  const calls = [];
  await new QueryPlanExecutor().execute(queryPlan, async (step, runtime) => {
    const sql = generators[step.source_id].generate(step.contract, step.source_id, runtime.runtime_bindings);
    calls.push({ step: step.step_id, source: step.source_id, sql });
    if (step.step_id === "s1") return { rows: [{ project_id: "p1" }] };
    if (step.step_id === "s2") return { rows: [{ project_id: "p1" }] };
    if (step.step_id === "s3") return { rows: [{ id: "p1", company_id: "c1" }] };
    return { rows: [{ id: "c1", name: "Acme" }] };
  });

  assert.deepEqual(calls.map(call => `${call.step}:${call.source}`), ["s1:db2", "s2:db2", "s3:db1", "s4:db1"]);
  assert.match(calls[1].sql, /FROM "projects"/i);
  assert.match(calls[1].sql, /WHERE[\s\S]*"projects"\."project_id"/i);
  assert.match(calls[2].sql, /WHERE[\s\S]*"project_details"\."id"/i);
  assert.match(calls[3].sql, /WHERE[\s\S]*"companies"\."id"/i);
});

test("independent broad samples are incomplete for an explicit relationship question", () => {
  const planner = new QuestionPlanner(loadTestContexts());
  const question = "Which meeting belongs to which project and company?";
  const plan = planner._normalize_plan({
    data_sources: ["postgresql"], postgresql_sources: ["db1", "db2"],
    required_tables: ["companies", "project_details", "projects", "sessions"], required_columns: [],
    filters: [], relationships: [], operations: ["lookup"], candidate_resolution: { mode: "independent" },
    execution_plan: { mode: "multi_step", steps: [
      { id: "a", type: "source_query", source_id: "db1", contract: { required_tables: ["companies"] }, depends_on: [], input_bindings: [] },
      { id: "b", type: "source_query", source_id: "db2", contract: { required_tables: ["projects"] }, depends_on: [], input_bindings: [] },
      { id: "c", type: "final_query", source_id: "db2", contract: { required_tables: ["sessions"] }, depends_on: [], input_bindings: [] }
    ], final_step: "c" }
  }, question);
  const result = planner.assess_semantic_completeness(plan, question);
  assert.equal(result.complete, false);
  assert.equal(result.reason, "incomplete_verified_relationship_path");
});

test("named status predicates remain separate from requested status attributes", () => {
  const planner = new QuestionPlanner(loadTestContexts());
  planner.client = OFFLINE_PROVIDER;

  const attribute = planner._build_metadata_fallback_plan("show me user umar daraz status");
  assert.equal(attribute.filters.some(filter => filter.field === "consultant_status"), false);
  assert.ok(attribute.required_columns.includes("users.consultant_status"));

  const predicate = planner._build_metadata_fallback_plan("show users whose status is active");
  assert.deepEqual(predicate.filters, [{
    table: "users",
    field: "consultant_status",
    operator: "case_insensitive_equals",
    value: "active",
    verification: "runtime_distinct_required",
    provenance: "authorized_discovered_categorical_column"
  }]);

  const combined = planner._build_metadata_fallback_plan("show user umar daraz whose status is active");
  assert.equal(combined.filters.length, 3);
  assert.ok(combined.filters.some(filter => filter.field === "consultant_status" && filter.verification === "runtime_distinct_required"));
  assert.equal(planner._is_bounded_detail_lookup("show user umar daraz whose status is active", combined), true);
});

test("display-name and title schemas use only discovered fields", () => {
  const planner = new QuestionPlanner({
    alpha: {
      tables: {
        records: {
          primary_keys: ["id"],
          columns: [{ name: "id" }, { name: "display_name" }, { name: "status" }]
        },
        documents: {
          primary_keys: ["id"],
          columns: [{ name: "id" }, { name: "title" }]
        }
      }
    }
  });

  const display = planner._build_metadata_fallback_plan("show me record Cenario");
  assert.equal(display.postgresql_sources[0], "alpha");
  assert.deepEqual(display.filters, [{
    table: "records",
    field: "display_name",
    operator: "contains",
    value: "cenario"
  }]);

  const title = planner._build_metadata_fallback_plan("show launch brief documents");
  assert.deepEqual(title.filters, [{
    table: "documents",
    field: "title",
    operator: "contains",
    value: "launch brief"
  }]);
});

test("competing capable source-qualified named entities remain ambiguous", () => {
  const planner = new QuestionPlanner({
    db1: {
      tables: { users: { columns: [{ name: "id" }, { name: "first_name" }, { name: "last_name" }, { name: "status" }] } },
      semantic_catalog: { entities: { users: { entity_type: "user", synonyms: ["user", "users"], technical_entity: true } } }
    },
    db2: {
      tables: { users: { columns: [{ name: "id" }, { name: "first_name" }, { name: "last_name" }, { name: "status" }] } },
      semantic_catalog: { entities: { users: { entity_type: "user", synonyms: ["user", "users"], technical_entity: true } } }
    }
  });

  const fallback = planner._build_metadata_fallback_plan("show user Jane Doe status");
  assert.deepEqual(fallback.ambiguous_context_candidates, [
    { source_id: "db1", table: "users" },
    { source_id: "db2", table: "users" }
  ]);
  assert.deepEqual(fallback.postgresql_sources, []);
});

test("ambiguous direct user status context excludes unrelated graph neighborhoods", () => {
  const planner = new QuestionPlanner(loadTestContexts());
  const focused = planner._build_context_for_llm("show user status");
  const tables = Object.fromEntries(Object.entries(focused.sources).map(([sourceId, source]) => [sourceId, Object.keys(source.tables)]));

  assert.deepEqual(tables, { db1: ["users"], db2: ["users"] });
  assert.deepEqual(focused.verified_paths, []);
  assert.ok(JSON.stringify(focused).length < 12000);
});

test("named filters remain parameterized and can return multiple matching records", () => {
  const context = {
    tables: {
      users: {
        columns: [{ name: "id" }, { name: "first_name" }, { name: "last_name" }]
      }
    }
  };
  const planner = new QuestionPlanner({ alpha: context });
  const plan = planner._build_metadata_fallback_plan("show user Jane Doe");
  assert.equal(plan.limit, 50);
  const generator = new SQLGenerator(context, "alpha");
  const prepared = generator.generatePrepared(plan, "alpha");
  assert.match(prepared.query, /"users"\."first_name"\s+ILIKE/i);
  assert.match(prepared.query, /"users"\."last_name"\s+ILIKE/i);
  assert.deepEqual(prepared.parameters, ["jane", "doe"]);
  assert.doesNotMatch(prepared.query, /jane|doe/i);
});
