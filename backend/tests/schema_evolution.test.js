import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import { join } from "path";
import { attachSemanticCatalog, catalogFingerprint, deriveTechnicalEntities, findSemanticCandidates, getSemanticCatalogStatus, reconcileSemanticCatalog } from "../context/semantic_catalog.js";
import { contextFingerprint, publishContextGeneration, rollbackContextGeneration } from "../context/context_store.js";
import { findCrossSourceCandidates } from "../context/cross_source_inference.js";
import { QuestionPlanner } from "../planning/question_planner.js";

function context(source_id, tables, relationships = []) {
  return { source_id, tables, relationships };
}

function fixtureContexts() {
  return {
    db1: context("db1", {
      project_details: { columns: [{ name: "id", type: "uuid" }, { name: "project_id_display", type: "text" }], primary_keys: ["id"] },
      field_assets: { columns: [{ name: "id", type: "uuid" }, { name: "label", type: "text" }], primary_keys: ["id"] }
    }),
    db2: context("db2", {
      projects: { columns: [{ name: "project_id", type: "character varying" }, { name: "project_code", type: "text" }], primary_keys: [] },
      risk_signals: { columns: [{ name: "id", type: "uuid" }, { name: "asset_id", type: "uuid" }, { name: "observed_at", type: "timestamp" }, { name: "api_token", type: "text" }], primary_keys: ["id"] }
    }, [{ source_table: "risk_signals", source_column: "asset_id", target_table: "projects", target_column: "project_id", relationship_type: "FOREIGN_KEY" }])
  };
}

function approvedCatalog() {
  return {
    catalog_version: 1,
    provenance: { kind: "application_owned_semantic_overlay", business_approval_required_for_new_mappings: true },
    sources: {
      db1: { entities: { project_details: { entity_type: "project", synonyms: ["project", "projects"], provenance: ["approved fixture"] } } },
      db2: { entities: { projects: { entity_type: "project", synonyms: ["project", "projects"], provenance: ["approved fixture"] } } }
    },
    verified_paths: [{
      id: "project-uuid",
      steps: [{ source_id: "db1", table: "project_details", column: "id" }, { source_id: "db2", table: "projects", column: "project_id" }],
      evidence_relationships: [],
      validation_status: "validated",
      provenance: ["approved fixture"]
    }]
  };
}

test("new technical tables are planner-visible without an approved semantic mapping", async () => {
  const raw = fixtureContexts();
  const catalog = { provenance: { kind: "application_owned_semantic_overlay", business_approval_required_for_new_mappings: true }, sources: {}, verified_paths: [] };
  const contexts = attachSemanticCatalog(raw, catalog).contexts;
  const candidates = findSemanticCandidates("show risk signals", contexts, ["db2"]);
  assert.equal(candidates[0].table, "risk_signals");
  assert.equal(contexts.db2.semantic_catalog.entities.risk_signals.technical_entity, true);
  const planner = new QuestionPlanner(contexts);
  planner.client = null;
  const plan = await planner.plan("show risk signals");
  assert.deepEqual(plan.postgresql_sources, ["db2"]);
  assert.deepEqual(plan.required_tables, ["risk_signals"]);
});

test("new FK is carried in technical metadata while sensitive columns stay out of the planner prompt", () => {
  const raw = fixtureContexts();
  const contexts = attachSemanticCatalog(raw, { provenance: { kind: "application_owned_semantic_overlay", business_approval_required_for_new_mappings: true }, sources: {}, verified_paths: [] }).contexts;
  const planner = new QuestionPlanner(contexts);
  const promptContext = planner._build_context_for_llm();
  assert.equal(promptContext.sources.db2.relationships[0].source_table, "risk_signals");
  assert.ok(!promptContext.sources.db2.tables.risk_signals.columns.some(column => column.name === "api_token"));
});

test("UUID primary key to varchar reference is only a candidate, never an automatic identity", () => {
  const raw = fixtureContexts();
  const candidates = findCrossSourceCandidates(raw.db1, raw.db2);
  const candidate = candidates.find(item => item.source_table === "project_details" && item.source_column === "id" && item.target_table === "projects" && item.target_column === "project_id");
  assert.ok(candidate);
  assert.equal(candidate.source_column_type, "uuid");
  assert.equal(candidate.target_column_type, "character varying");
  assert.equal(candidate.relationship_type, "CROSS_SOURCE_SEMANTIC");
  assert.equal(Object.hasOwn(candidate, "identity"), false);
});

test("generation publication is fingerprinted, skips unchanged schemas, retains rollback targets, and never needs a database", () => {
  const directory = fs.mkdtempSync(join(os.tmpdir(), "cenariocg-context-"));
  try {
    const firstContexts = fixtureContexts();
    const first = publishContextGeneration(firstContexts, { directory, now: new Date("2026-01-01T00:00:00.000Z"), retention: 3 });
    assert.equal(first.published, true);
    assert.ok(fs.existsSync(join(directory, "active_generation.json")));
    const unchanged = publishContextGeneration(firstContexts, { directory, now: new Date("2026-01-01T00:01:00.000Z"), retention: 3 });
    assert.equal(unchanged.published, false);
    const changedContexts = fixtureContexts();
    changedContexts.db1.tables.field_assets.columns.push({ name: "serial_code", type: "text" });
    const second = publishContextGeneration(changedContexts, { directory, now: new Date("2026-01-01T00:02:00.000Z"), retention: 3 });
    assert.equal(second.published, true);
    assert.notEqual(first.fingerprint, second.fingerprint);
    const rollback = rollbackContextGeneration(first.generation, { directory });
    assert.equal(rollback.generation, first.generation);
    assert.notEqual(contextFingerprint(firstContexts.db1), contextFingerprint(changedContexts.db1));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("schema generation automatically reconciles compatible approved semantics and rollback restores the matching snapshot", () => {
  const directory = fs.mkdtempSync(join(os.tmpdir(), "cenariocg-semantic-generation-"));
  try {
    const catalog = approvedCatalog();
    const firstContexts = fixtureContexts();
    const first = publishContextGeneration(firstContexts, { directory, now: new Date("2026-01-01T00:00:00.000Z"), retention: 3, semanticCatalog: catalog });
    const unchanged = publishContextGeneration(firstContexts, { directory, now: new Date("2026-01-01T00:01:00.000Z"), retention: 3, semanticCatalog: catalog });
    assert.equal(unchanged.published, false);

    const changedContexts = fixtureContexts();
    changedContexts.db1.tables.field_assets.columns.push({ name: "serial_code", type: "text" });
    const second = publishContextGeneration(changedContexts, { directory, now: new Date("2026-01-01T00:02:00.000Z"), retention: 3, semanticCatalog: catalog });
    const secondCatalog = JSON.parse(fs.readFileSync(join(directory, "generations", second.generation, "semantic_catalog.json"), "utf8"));
    assert.equal(secondCatalog.technical_fingerprint, catalogFingerprint(changedContexts));
    assert.equal(secondCatalog.provenance.reconciliation.schema_generation, second.generation);
    assert.deepEqual(secondCatalog.provenance.reconciliation.invalidated_references, []);
    const secondStatus = getSemanticCatalogStatus(changedContexts, secondCatalog, Date.parse(secondCatalog.generated_at) + 1);
    assert.equal(secondStatus.freshness_status, "fresh");
    assert.equal(secondStatus.fingerprint_status, "verified");

    const rollback = rollbackContextGeneration(first.generation, { directory });
    assert.equal(rollback.generation, first.generation);
    const rollbackCatalog = JSON.parse(fs.readFileSync(join(directory, "generations", first.generation, "semantic_catalog.json"), "utf8"));
    assert.equal(rollbackCatalog.provenance.reconciliation.schema_generation, first.generation);
    assert.equal(rollbackCatalog.technical_fingerprint, catalogFingerprint(firstContexts));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("incompatible approved relationship paths are invalidated without approving replacements", () => {
  const broken = fixtureContexts();
  broken.db2.tables.projects.columns = [{ name: "project_code", type: "text" }];
  const reconciled = reconcileSemanticCatalog(broken, approvedCatalog(), { generation: "fixture-generation", validatedAt: new Date("2026-01-01T00:00:00.000Z") });
  assert.equal(reconciled.verified_paths.length, 0);
  assert.ok(reconciled.provenance.reconciliation.invalidated_references.some(item => item.kind === "relationship_path" && item.reason === "step_unavailable"));
  assert.equal(reconciled.sources.db2.entities.projects.entity_type, "project");
});

test("semantic incompatibility prevents publication and retains the active generation", () => {
  const directory = fs.mkdtempSync(join(os.tmpdir(), "cenariocg-semantic-failure-"));
  try {
    const contexts = fixtureContexts();
    const first = publishContextGeneration(contexts, { directory, now: new Date("2026-01-01T00:00:00.000Z"), retention: 3, semanticCatalog: approvedCatalog() });
    assert.throws(() => publishContextGeneration(contexts, {
      directory,
      now: new Date("2026-01-01T00:01:00.000Z"),
      retention: 3,
      semanticCatalog: { sources: {}, verified_paths: [] }
    }), /provenance|incompatible/i);
    const active = JSON.parse(fs.readFileSync(join(directory, "active_generation.json"), "utf8"));
    assert.equal(active.generation, first.generation);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
