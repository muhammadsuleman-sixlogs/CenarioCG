import { test } from "node:test";
import assert from "node:assert/strict";
import { QuestionPlanner } from "../planning/question_planner.js";
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
