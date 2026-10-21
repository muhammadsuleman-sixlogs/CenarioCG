import { test } from "node:test";
import assert from "node:assert/strict";
import { enrichRetrievedRows } from "../retrieval/label_enricher.js";
import { SQLGenerator } from "../retrieval/sql_generator.js";
import { EvidenceManager } from "../llm/evidence_manager.js";
import { sanitizeEvidence, projectPublicResponse } from "../security/output_security_policy.js";

function context() {
  return {
    source_id: "db1",
    tables: {
      projects: { columns: [{ name: "id" }, { name: "title" }, { name: "owner_consultant_id" }] },
      users: { columns: [{ name: "id" }, { name: "first_name" }, { name: "last_name" }, { name: "password" }] }
    },
    semantic_catalog: {
      entities: {
        projects: {
          display_template: { columns: ["title"] },
          column_roles: {
            owner_consultant_id: {
              role: "foreign_key",
              target_table: "users",
              target_column: "id",
              relationship_role: "owner consultant"
            }
          }
        },
        users: {
          display_template: { columns: ["first_name", "last_name"] },
          secondary_label: "password",
          column_roles: {
            id: { role: "internal_id" },
            first_name: { role: "display" },
            last_name: { role: "display" },
            password: { role: "other" }
          }
        }
      }
    },
    relationships: []
  };
}

test("same-source enrichment resolves safe labels for shown rows and hides internal ids from answer evidence", async () => {
  const calls = [];
  const rows = [
    { id: "project-1", title: "AI integration", owner_consultant_id: "user-1" },
    { id: "project-2", title: "Second project", owner_consultant_id: null }
  ];
  const enriched = await enrichRetrievedRows({
    rows,
    sourceId: "db1",
    table: "projects",
    context: context(),
    maxRows: 1,
    execute: async (query, sourceId, bindings) => {
      calls.push({ query, sourceId, bindings });
      return { rows: [{ id: "user-1", first_name: "Umar", last_name: "Daraz" }] };
    }
  });

  assert.equal(enriched[0].consultant_label, "Umar Daraz");
  assert.equal(enriched[1].consultant_label, undefined);
  assert.equal(enriched[0]._internal.foreign_keys.owner_consultant_id, "user-1");
  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /ANY\(\$1\)/);
  assert.doesNotMatch(calls[0].query, /password/i);
  assert.deepEqual(calls[0].bindings.parameters, [["user-1"]]);

  const evidence = sanitizeEvidence({ items: [{ row: enriched[0] }] });
  assert.equal(evidence.items[0].row._internal, undefined);
  const answerEvidence = new EvidenceManager().prepareAnswerEvidence(evidence);
  assert.equal(answerEvidence.items[0].row._internal, undefined);
  assert.equal(projectPublicResponse({ row: enriched[0] }).row._internal, undefined);
});

test("enrichment caps each lookup at 500 ids", async () => {
  const rows = Array.from({ length: 501 }, (_, index) => ({
    owner_consultant_id: `user-${index}`
  }));
  const chunks = [];
  await enrichRetrievedRows({
    rows,
    sourceId: "db1",
    table: "projects",
    context: context(),
    maxRows: 501,
    execute: async (_query, _sourceId, bindings) => {
      chunks.push(bindings.parameters[0]);
      return { rows: [] };
    }
  });
  assert.deepEqual(chunks.map(chunk => chunk.length), [500, 1]);
});

test("SQL projection auto-includes safe relationship-role foreign keys", () => {
  const generator = new SQLGenerator(context(), "db1");
  const prepared = generator.generatePrepared({
    source_id: "db1",
    required_tables: ["projects"],
    required_columns: ["projects.title"],
    filters: [],
    operations: []
  }, "db1");
  assert.match(prepared.query, /"projects"\."title"/);
  assert.match(prepared.query, /"projects"\."owner_consultant_id"/);
  assert.doesNotMatch(prepared.query, /password/i);
});
