import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import { join } from "path";
import {
  attachSemanticCatalog,
  catalogFingerprint,
  findSemanticCandidates,
  getSemanticCatalogStatus
} from "../context/semantic_catalog.js";
import {
  markActiveGenerationVerified,
  publishContextGeneration
} from "../context/context_store.js";
import {
  refreshContextGeneration,
  startContextRefreshScheduler
} from "../context/context_refresh.js";

function contexts(extraColumn = false) {
  return {
    db1: {
      source_id: "db1",
      tables: {
        project_details: {
          columns: [{ name: "id", type: "uuid" }, { name: "company_id", type: "uuid" }],
          primary_keys: ["id"]
        }
      },
      relationships: []
    },
    db2: {
      source_id: "db2",
      tables: {
        sessions: {
          columns: [
            { name: "id", type: "integer" },
            { name: "session_id", type: "text" },
            { name: "meeting_title", type: "text" },
            { name: "created_at", type: "timestamp" },
            ...(extraColumn ? [{ name: "meeting_platform", type: "text" }] : [])
          ],
          primary_keys: ["id"]
        }
      },
      relationships: []
    }
  };
}

function catalog(generatedAt = "2026-01-01T00:00:00.000Z") {
  return {
    catalog_version: 1,
    generated_at: generatedAt,
    provenance: {
      kind: "application_owned_semantic_overlay",
      business_approval_required_for_new_mappings: true
    },
    sources: {
      db2: {
        entities: {
          sessions: {
            entity_type: "meeting",
            description: "Meeting/session records.",
            synonyms: ["meeting", "meetings"],
            ordering: { column: "created_at", meaning: "session_record_creation_time" },
            provenance: ["approved fixture"]
          }
        }
      }
    },
    verified_paths: []
  };
}

function activeManifest(directory) {
  return JSON.parse(fs.readFileSync(join(directory, "active_generation.json"), "utf8"));
}

test("an expired but compatible catalog is unavailable until live verification succeeds", () => {
  const raw = contexts();
  const expired = { ...catalog(), last_verified_at: "2026-01-01T00:00:00.000Z" };
  const attached = attachSemanticCatalog(raw, expired);
  const status = attached.contexts.db2.semantic_catalog_status;

  assert.equal(status.validation_status, "validated");
  assert.equal(status.fingerprint_status, "unknown");
  assert.equal(status.freshness_status, "stale");
  assert.equal(Boolean(attached.contexts.db2.semantic_catalog), false);
  assert.deepEqual(findSemanticCandidates("show recent meetings", attached.contexts), []);
});

test("a compatible old semantic definition remains usable when the active generation was live-verified recently", () => {
  const raw = contexts();
  const verifiedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const verified = { ...catalog(), last_verified_at: verifiedAt };
  const attached = attachSemanticCatalog(raw, verified);
  const status = getSemanticCatalogStatus(raw, verified, Date.now());
  const candidates = findSemanticCandidates("show recent meetings", attached.contexts);

  assert.equal(status.validation_status, "validated");
  assert.equal(status.freshness_status, "fresh");
  assert.equal(status.freshness_source, "last_verified_at");
  assert.equal(candidates[0].source_id, "db2");
  assert.equal(candidates[0].table, "sessions");
  assert.equal(candidates[0].ordering_column, "created_at");
});

test("successful unchanged-schema refresh advances verification atomically without rewriting the generation", async () => {
  const directory = fs.mkdtempSync(join(os.tmpdir(), "cenariocg-refresh-"));
  try {
    const initial = contexts();
    const first = publishContextGeneration(initial, {
      directory,
      now: new Date("2026-01-01T00:00:00.000Z"),
      requiredSourceIds: ["db1", "db2"],
      semanticCatalog: catalog()
    });
    const refreshed = await refreshContextGeneration({
      directory,
      sourceIds: ["db1", "db2"],
      now: new Date("2026-01-02T00:00:00.000Z"),
      buildContext: async sourceId => structuredClone(initial[sourceId]),
      validateRelationships: async () => ({ error_count: 0 })
    });
    const active = activeManifest(directory);

    assert.equal(refreshed.published, false);
    assert.equal(refreshed.reason, "unchanged");
    assert.equal(refreshed.last_verified_at, "2026-01-02T00:00:00.000Z");
    assert.equal(active.generation, first.generation);
    assert.equal(active.last_verified_at, "2026-01-02T00:00:00.000Z");
    assert.equal(active.verification_status, "verified");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("changed schemas publish a new coherent generation with verified metadata", async () => {
  const directory = fs.mkdtempSync(join(os.tmpdir(), "cenariocg-refresh-publish-"));
  try {
    const initial = contexts();
    const first = publishContextGeneration(initial, {
      directory,
      now: new Date("2026-01-01T00:00:00.000Z"),
      requiredSourceIds: ["db1", "db2"],
      semanticCatalog: catalog()
    });
    const refreshed = await refreshContextGeneration({
      directory,
      sourceIds: ["db1", "db2"],
      now: new Date("2026-01-02T00:00:00.000Z"),
      buildContext: async sourceId => structuredClone(contexts(sourceId === "db2")[sourceId]),
      validateRelationships: async () => ({ error_count: 0 })
    });
    const active = activeManifest(directory);

    assert.equal(refreshed.published, true);
    assert.notEqual(active.generation, first.generation);
    assert.equal(active.last_verified_at, "2026-01-02T00:00:00.000Z");
    assert.equal(active.semantic_catalog.schema_generation, active.generation);
    assert.equal(active.semantic_catalog.technical_fingerprint, catalogFingerprint(contexts(true)));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("failed refresh preserves the last-known-good generation and verification time", async () => {
  const directory = fs.mkdtempSync(join(os.tmpdir(), "cenariocg-refresh-failure-"));
  try {
    const initial = contexts();
    publishContextGeneration(initial, {
      directory,
      now: new Date("2026-01-01T00:00:00.000Z"),
      requiredSourceIds: ["db1", "db2"],
      semanticCatalog: catalog()
    });
    const before = activeManifest(directory);

    await assert.rejects(
      () => refreshContextGeneration({
        directory,
        sourceIds: ["db1", "db2"],
        now: new Date("2026-01-02T00:00:00.000Z"),
        buildContext: async () => { throw new Error("database temporarily unreachable"); }
      }),
      /temporarily unreachable/
    );
    const after = activeManifest(directory);

    assert.equal(after.generation, before.generation);
    assert.equal(after.last_verified_at, before.last_verified_at);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("scheduler coalesces overlapping refreshes and reports failures without provider calls", async () => {
  let calls = 0;
  let resolveRefresh;
  const errors = [];
  const scheduler = startContextRefreshScheduler({
    intervalMs: 60_000,
    refresh: () => {
      calls += 1;
      return new Promise(resolve => { resolveRefresh = resolve; });
    },
    onError: error => errors.push(error.message)
  });
  try {
    const first = scheduler.run();
    const second = scheduler.run();
    assert.equal(calls, 1);
    resolveRefresh();
    await Promise.all([first, second]);
    assert.deepEqual(errors, []);
  } finally {
    scheduler.stop();
  }
});

test("manifest verification updates are atomic and require an existing validated generation", () => {
  const directory = fs.mkdtempSync(join(os.tmpdir(), "cenariocg-verify-"));
  try {
    const first = publishContextGeneration(contexts(), {
      directory,
      now: new Date("2026-01-01T00:00:00.000Z"),
      requiredSourceIds: ["db1", "db2"]
    });
    const updated = markActiveGenerationVerified({ directory, now: new Date("2026-01-02T00:00:00.000Z") });
    const active = activeManifest(directory);
    assert.equal(updated.generation, first.generation);
    assert.equal(active.generation, first.generation);
    assert.equal(active.last_verified_at, "2026-01-02T00:00:00.000Z");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
