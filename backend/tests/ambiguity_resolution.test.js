import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextManager } from "../context/context_manager.js";
import { loadAllContexts } from "../context/context_store.js";
import { QuestionPlanner } from "../planning/question_planner.js";
import { QuestionPlanValidator } from "../planning/question_plan_validator.js";
import { SourceRouter } from "../planning/source_router.js";
import { RAGPipeline } from "../pipeline/rag_pipeline.js";
import { validateReadOnlyQuery } from "../database/readonly_guard.js";

const contexts = loadAllContexts();

function pipelineFor(contextSet = contexts) {
  const pipeline = new RAGPipeline(new ContextManager());
  const validator = new QuestionPlanValidator(contextSet);
  pipeline.plan_validator = validator;
  pipeline.planValidator = validator;
  pipeline.source_router = new SourceRouter(contextSet);
  pipeline.planner = new QuestionPlanner(contextSet);
  pipeline.planner.client = null;
  pipeline.entity_resolver = { async resolve() { return []; } };
  return pipeline;
}

test("provider technical ambiguity is repaired to independent count retrieval", async () => {
  const pipeline = pipelineFor();
  pipeline.planner.client = {
    chat: {
      completions: {
        async create() {
          return { choices: [{ message: { content: JSON.stringify({
            data_sources: ["postgresql"],
            postgresql_sources: [],
            required_tables: [],
            required_columns: [],
            operations: [],
            filters: [],
            relationships: [],
            ambiguous_context_candidates: [
              { source_id: "db1", table: "companies" },
              { source_id: "db2", table: "companies" }
            ]
          }) } }] };
        }
      }
    }
  };
  const calls = [];
  pipeline.executor = { async execute(sql, sourceId) { validateReadOnlyQuery(sql); calls.push(sourceId); return { rows: [{ count: "1" }], row_count: 1, columns: ["count"] }; } };
  pipeline.answer_generator = { async generate() { return "Independent company counts retrieved."; } };

  const result = await pipeline.ask("What is the total number of companies?", {
    workspace_id: "w",
    authorization: { postgresql_sources: ["db1", "db2"], security_resources: [] }
  });
  assert.equal(result.retrieval_status, "success_with_data");
  assert.deepEqual(calls, ["db1", "db2"]);
});

test("company count retrieves independently from DB1 and DB2 without summing unknown overlap", async () => {
  const pipeline = pipelineFor();
  const calls = [];
  let evidenceSeen;
  pipeline.executor = {
    async execute(sql, sourceId) {
      validateReadOnlyQuery(sql);
      calls.push({ sourceId, sql });
      return { rows: [{ count: sourceId === "db1" ? "4" : "7" }], row_count: 1, columns: ["count"] };
    }
  };
  pipeline.answer_generator = { async generate(question, evidence) { evidenceSeen = evidence; return "DB1: 4 companies; DB2: 7 companies. The records were not combined because overlap is unverified."; } };
  const result = await pipeline.ask("What is the total number of companies?", {
    workspace_id: "w",
    authorization: { postgresql_sources: ["db1", "db2"], security_resources: [] }
  });
  assert.equal(result.retrieval_status, "success_with_data");
  assert.deepEqual(calls.map(call => call.sourceId), ["db1", "db2"]);
  assert.ok(calls.every(call => /^SELECT COUNT\(\*\)/i.test(call.sql)));
  assert.equal(result.candidate_resolution_result.combined_total, null);
  assert.deepEqual(result.candidate_resolution_result.per_source.map(item => item.count), [4, 7]);
  assert.equal(evidenceSeen.candidate_resolution.overlap_status, "unknown");
  assert.equal(evidenceSeen.candidate_resolution_result.combined_total, null);
  assert.equal(result.sources.length, 2);
});

test("company count respects DB1-only and DB2-only authorization", async () => {
  for (const sourceId of ["db1", "db2"]) {
    const pipeline = pipelineFor();
    const calls = [];
    pipeline.executor = { async execute(sql, source) { validateReadOnlyQuery(sql); calls.push({ sql, source }); return { rows: [{ count: "3" }], row_count: 1, columns: ["count"] }; } };
    pipeline.answer_generator = { async generate() { return "count retrieved"; } };
    const result = await pipeline.ask("What is the total number of companies?", {
      workspace_id: "w",
      authorization: { postgresql_sources: [sourceId], security_resources: [] }
    });
    assert.equal(result.retrieval_status, "success_with_data");
    assert.deepEqual(calls.map(call => call.source), [sourceId]);
    assert.deepEqual(result.postgresql_source_ids, [sourceId]);
  }
});

test("verified identity mappings deduplicate company rows in application memory", async () => {
  const fixture = {
    db1: {
      source_id: "db1",
      tables: { companies: { primary_keys: ["id"], columns: [{ name: "id" }, { name: "name" }] } },
      relationships: [],
      semantic_catalog: { entities: { companies: { entity_type: "company", synonyms: ["company", "companies"], provenance: ["approved fixture"], identity: { column: "id", group: "company", mapping_id: "canonical-company-v1", validation_status: "validated", provenance: ["approved identity mapping"] } } }, verified_paths: [] }
    },
    db2: {
      source_id: "db2",
      tables: { companies: { primary_keys: ["id"], columns: [{ name: "id" }, { name: "name" }] } },
      relationships: [],
      semantic_catalog: { entities: { companies: { entity_type: "company", synonyms: ["company", "companies"], provenance: ["approved fixture"], identity: { column: "id", group: "company", mapping_id: "canonical-company-v1", validation_status: "validated", provenance: ["approved identity mapping"] } } }, verified_paths: [] }
    }
  };
  const pipeline = pipelineFor(fixture);
  pipeline.executor = { async execute(sql, sourceId) { validateReadOnlyQuery(sql); return { rows: sourceId === "db1" ? [{ id: "A" }, { id: "B" }] : [{ id: "b" }, { id: "C" }], row_count: 2, columns: ["id"] }; } };
  pipeline.answer_generator = { async generate() { return "3 unique companies"; } };
  const result = await pipeline.ask("What is the total number of companies?", { workspace_id: "w", authorization: { postgresql_sources: ["db1", "db2"], security_resources: [] } });
  assert.equal(result.retrieval_status, "success_with_data");
  assert.equal(result.candidate_resolution_result.deduplication, "verified_identity");
  assert.equal(result.candidate_resolution_result.combined_total, 3);
});

test("pending tickets use verified status semantics and remain source-qualified", async () => {
  const fixture = {
    db1: {
      source_id: "db1",
      tables: { tickets: { primary_keys: ["id"], columns: [{ name: "id" }, { name: "status" }, { name: "subject" }] } },
      relationships: [],
      semantic_catalog: { entities: { tickets: { entity_type: "ticket", synonyms: ["ticket", "tickets"], provenance: ["approved fixture"], status_semantics: { column: "status", mappings: { pending: "pending" }, validation_status: "validated", provenance: ["approved status dictionary"] } } }, verified_paths: [] }
    }
  };
  const pipeline = pipelineFor(fixture);
  let sql;
  pipeline.executor = { async execute(query, sourceId) { sql = query; validateReadOnlyQuery(query); return { rows: [{ id: "t1", status: "pending", subject: "Open item" }], row_count: 1, columns: ["id", "status", "subject"] }; } };
  pipeline.answer_generator = { async generate() { return "One pending ticket"; } };
  const result = await pipeline.ask("Which tickets are pending?", { workspace_id: "w", authorization: { postgresql_sources: ["db1"], security_resources: [] } });
  assert.equal(result.retrieval_status, "success_with_data");
  assert.match(sql, /"status"\s+ILIKE\s+'pending'/i);
  assert.equal(result.sources[0].source_id, "db1");
});

test("unknown and conflicting status semantics require business clarification", async () => {
  const unknown = pipelineFor();
  const unknownResult = await unknown.ask("Which tickets are pending?", { workspace_id: "w", authorization: { postgresql_sources: ["db1"], security_resources: [] } });
  assert.equal(unknownResult.error.type, "BUSINESS_CLARIFICATION");
  assert.match(unknownResult.answer, /status|workflow/i);

  const conflicting = {
    db1: { source_id: "db1", tables: { tickets: { columns: [{ name: "id" }, { name: "status" }] } }, relationships: [], semantic_catalog: { entities: { tickets: { synonyms: ["tickets"], provenance: ["fixture"], status_semantics: { column: "status", mappings: { pending: "pending" }, validation_status: "validated", provenance: ["fixture"] } } } } },
    db2: { source_id: "db2", tables: { tickets: { columns: [{ name: "id" }, { name: "status" }] } }, relationships: [], semantic_catalog: { entities: { tickets: { synonyms: ["tickets"], provenance: ["fixture"], status_semantics: { column: "status", mappings: { pending: "awaiting_review" }, validation_status: "validated", provenance: ["fixture"] } } } } }
  };
  const conflictingPipeline = pipelineFor(conflicting);
  const conflictingResult = await conflictingPipeline.ask("Which tickets are pending?", { workspace_id: "w", authorization: { postgresql_sources: ["db1", "db2"], security_resources: [] } });
  assert.equal(conflictingResult.error.type, "BUSINESS_CLARIFICATION");
  assert.match(conflictingResult.answer, /conflicting|status|workflow/i);
});

test("singular project ambiguity remains protected", async () => {
  const pipeline = pipelineFor();
  const result = await pipeline.ask("Show me most recent project", { workspace_id: "w", authorization: { postgresql_sources: ["db1", "db2"], security_resources: [] } });
  assert.equal(result.error.type, "SOURCE_AMBIGUOUS");
  assert.equal(result.sources.length, 0);
});

test("partial independent source failure preserves successful evidence and provenance", async () => {
  const pipeline = pipelineFor();
  const calls = [];
  pipeline.executor = { async execute(sql, sourceId) { validateReadOnlyQuery(sql); calls.push(sourceId); if (sourceId === "db2") throw new Error("mock DB2 unavailable"); return { rows: [{ count: "4" }], row_count: 1, columns: ["count"] }; } };
  pipeline.answer_generator = { async generate() { return "DB1 returned 4; DB2 was unavailable."; } };
  const result = await pipeline.ask("What is the total number of companies?", { workspace_id: "w", authorization: { postgresql_sources: ["db1", "db2"], security_resources: [] } });
  assert.equal(result.retrieval_status, "partial_source_failure");
  assert.deepEqual(calls, ["db1", "db2"]);
  assert.equal(result.candidate_resolution_result.per_source.find(item => item.source_id === "db2").retrieval_status, "retrieval_failed");
  assert.ok(result.sources.some(source => source.source_id === "db1"));
});
