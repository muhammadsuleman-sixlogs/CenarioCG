import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextManager } from "../context/context_manager.js";
import { QuestionPlanner } from "../planning/question_planner.js";
import { QuestionPlanValidator } from "../planning/question_plan_validator.js";
import { RAGPipeline } from "../pipeline/rag_pipeline.js";
import { SourceRouter } from "../planning/source_router.js";
import { SQLGenerator } from "../retrieval/sql_generator.js";
import { validateReadOnlyQuery } from "../database/readonly_guard.js";

function fixture() {
  return {
    db1: {
      source_id: "db1",
      tables: {
        review_items: {
          primary_keys: ["review_id"],
          columns: [{ name: "review_id" }, { name: "workflow_state" }, { name: "summary" }]
        }
      },
      relationships: [],
      semantic_catalog: {
        entities: {
          review_items: {
            entity_type: "review_item",
            synonyms: ["review item", "review items"],
            provenance: ["approved fixture"],
            status_semantics: {
              column: "workflow_state",
              mappings: { awaiting: "awaiting_review" },
              validation_status: "validated",
              provenance: ["approved workflow dictionary"]
            }
          }
        },
        verified_paths: []
      }
    }
  };
}

function pipelineFor(contexts) {
  const pipeline = new RAGPipeline(new ContextManager());
  const validator = new QuestionPlanValidator(contexts);
  pipeline.plan_validator = validator;
  pipeline.planValidator = validator;
  pipeline.source_router = new SourceRouter(contexts);
  pipeline.planner = new QuestionPlanner(contexts);
  pipeline.planner.client = null;
  pipeline.sql_generators = { db1: new SQLGenerator(contexts.db1, "db1") };
  return pipeline;
}

function ticketFixture() {
  return {
    db1: {
      source_id: "db1",
      tables: { tickets: { primary_keys: ["id"], columns: [{ name: "id" }, { name: "status" }, { name: "subject" }] } },
      relationships: [],
      semantic_catalog: {
        entities: {
          tickets: {
            entity_type: "ticket",
            synonyms: ["ticket", "tickets"],
            provenance: ["approved fixture"],
            status_semantics: {
              column: "status",
              mappings: { pending: "pending" },
              validation_status: "validated",
              provenance: ["approved status dictionary"]
            }
          }
        },
        verified_paths: []
      }
    }
  };
}

function ticketFixtureWithoutSemanticMapping() {
  const contexts = ticketFixture();
  contexts.db1.semantic_catalog = { entities: {}, verified_paths: [] };
  return contexts;
}

test("verified categorical statuses are case-insensitive without changing identifier equality", async () => {
  const contexts = fixture();
  const planner = new QuestionPlanner(contexts);
  planner.client = null;
  const validator = new QuestionPlanValidator(contexts);
  const generator = new SQLGenerator(contexts.db1, "db1");

  const generated = [];
  for (const question of ["Which review items are awaiting?", "Which review items are Awaiting?"]) {
    const plan = planner._normalize_plan(
      planner._build_metadata_fallback_plan(question),
      question
    );
    const validation = validator.validate(plan);
    assert.equal(validation.valid, true, validation.errors?.join("; "));
    assert.equal(plan.filters[0].operator, "case_insensitive_equals");
    generated.push(generator.generate(plan, "db1"));
  }

  assert.deepEqual(generated[0], generated[1]);
  assert.match(generated[0], /"workflow_state"\s+ILIKE\s+'awaiting_review'/i);

  const identifierPlan = planner._normalize_plan({
    data_sources: ["postgresql"],
    postgresql_sources: ["db1"],
    required_tables: ["review_items"],
    required_columns: ["review_items.review_id"],
    filters: [{ table: "review_items", field: "review_id", operator: "=", value: "RV-Case-17" }],
    relationships: [],
    operations: ["lookup"]
  }, "Show review item RV-Case-17");
  assert.equal(identifierPlan.filters[0].operator, "=");
});

test("status capitalization variants reach mocked execution and one grounded answer", async () => {
  const contexts = ticketFixture();
  for (const question of ["Which tickets are pending?", "Which tickets are Pending?"]) {
    const pipeline = pipelineFor(contexts);
    const calls = [];
    let answerCalls = 0;
    pipeline.executor = {
      async execute(sql, sourceId) {
        validateReadOnlyQuery(sql);
        calls.push({ sql, sourceId });
        return { rows: [{ id: "T-Case-17", status: "PENDING" }], row_count: 1, columns: ["id", "status"] };
      }
    };
    pipeline.answer_generator = {
      async generate() {
        answerCalls += 1;
        return "One pending ticket.";
      }
    };

    const result = await pipeline.ask(question, {
      workspace_id: "offline",
      authorization: { postgresql_sources: ["db1"], security_resources: [] }
    });

    assert.equal(result.retrieval_status, "success_with_data", JSON.stringify(result.error || result.source_status));
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /"status"\s+ILIKE\s+'pending'/i);
    assert.equal(answerCalls, 1);
    assert.equal(result.answer, "One pending ticket.");
  }
});

test("count requests never execute without the mandatory verified status filter", async () => {
  const observedSql = [];
  for (const question of [
    "show me total tickets pending",
    "show me total tickets Pending",
    "show me total tickets PENDING",
    "show me total tickets pending"
  ]) {
    const contexts = ticketFixture();
    const pipeline = pipelineFor(contexts);
    pipeline.planner.client = {
      chat: {
        completions: {
          async create() {
            return { choices: [{ message: { content: JSON.stringify({
              question,
              data_sources: ["postgresql"],
              postgresql_sources: ["db1"],
              required_tables: ["tickets"],
              required_columns: [],
              relationships: [],
              filters: [],
              operations: ["count"],
              limit: null,
              confidence: 0.9
            }) } }] };
          }
        }
      }
    };
    pipeline.executor = {
      async execute(sql, sourceId) {
        validateReadOnlyQuery(sql);
        observedSql.push({ sql, sourceId });
        return { rows: [{ count: "96" }], row_count: 1, columns: ["count"] };
      }
    };
    pipeline.answer_generator = { async generate() { return "Total pending tickets: 96."; } };

    const result = await pipeline.ask(question, {
      workspace_id: "offline",
      authorization: { postgresql_sources: ["db1"], security_resources: [] }
    });
    assert.equal(result.retrieval_status, "success_with_data");
    assert.equal(result.answer, "Total pending tickets: 96.");
  }

  assert.equal(observedSql.length, 4);
  assert.ok(observedSql.every(({ sql }) => /COUNT\(\*\)/i.test(sql)));
  assert.ok(observedSql.every(({ sql }) => /"status"\s+ILIKE\s+'pending'/i.test(sql)), observedSql.map(item => item.sql).join("\n"));
});

test("discovered categorical columns require read-only value verification before counting", async () => {
  const contexts = ticketFixtureWithoutSemanticMapping();
  const pipeline = pipelineFor(contexts);
  const calls = [];
  pipeline.executor = {
    async execute(sql, sourceId, parameters) {
      validateReadOnlyQuery(sql);
      calls.push({ sql, sourceId, parameters });
      if (/SELECT 1 AS "exists"/i.test(sql)) return { rows: [{ exists: 1 }], row_count: 1, columns: ["exists"] };
      return { rows: [{ count: "96" }], row_count: 1, columns: ["count"] };
    }
  };
  pipeline.answer_generator = { async generate() { return "Total pending tickets: 96."; } };

  const result = await pipeline.ask("show me total tickets pending", {
    workspace_id: "offline",
    authorization: { postgresql_sources: ["db1"], security_resources: [] }
  });
  assert.equal(result.retrieval_status, "success_with_data");
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /SELECT 1 AS "exists"/i);
  assert.match(calls[0].sql, /"tickets"\."status"\s+ILIKE\s+\$1/i);
  assert.deepEqual(calls[0].parameters, ["pending"]);
  assert.match(calls[1].sql, /COUNT\(\*\)/i);
  assert.match(calls[1].sql, /"status"\s+ILIKE\s+'pending'/i);
});

test("unsupported categorical values fail closed before an aggregate query", async () => {
  const pipeline = pipelineFor(ticketFixtureWithoutSemanticMapping());
  const calls = [];
  let answerCalled = false;
  pipeline.executor = {
    async execute(sql) {
      validateReadOnlyQuery(sql);
      calls.push(sql);
      return { rows: [], row_count: 0, columns: ["exists"] };
    }
  };
  pipeline.answer_generator = { async generate() { answerCalled = true; return "must not run"; } };

  const result = await pipeline.ask("show me total tickets banana", {
    workspace_id: "offline",
    authorization: { postgresql_sources: ["db1"], security_resources: [] }
  });
  assert.equal(result.retrieval_status, "source_unavailable");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /SELECT 1 AS "exists"/i);
  assert.match(calls[0], /ILIKE \$1/i);
  assert.equal(answerCalled, false);
});

test("categorical verification preserves casing through a parameterized existence check", async () => {
  const generator = new SQLGenerator(ticketFixtureWithoutSemanticMapping().db1, "db1");
  const verification = generator.generateCategoricalExistence("tickets", "status", "PeNdInG", "db1");
  assert.match(verification.query, /^SELECT 1 AS "exists" FROM "tickets" WHERE "tickets"\."status" ILIKE \$1 LIMIT 1$/i);
  assert.deepEqual(verification.parameters, ["PeNdInG"]);
  validateReadOnlyQuery(verification.query);
});

test("categorical verification database failures do not run the aggregate", async () => {
  const pipeline = pipelineFor(ticketFixtureWithoutSemanticMapping());
  const calls = [];
  pipeline.executor = {
    async execute(sql) {
      validateReadOnlyQuery(sql);
      calls.push(sql);
      throw Object.assign(new Error("mock verification database failure"), { code: "ECONNRESET" });
    }
  };
  pipeline.answer_generator = { async generate() { throw new Error("answer must not run"); } };

  const result = await pipeline.ask("show me total tickets Pending", {
    workspace_id: "offline",
    authorization: { postgresql_sources: ["db1"], security_resources: [] }
  });
  assert.equal(result.retrieval_status, "source_unavailable");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /ILIKE \$1/i);
});
