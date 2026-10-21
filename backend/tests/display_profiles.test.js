import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveTechnicalEntities, attachSemanticCatalog, validateSemanticCatalog } from "../context/semantic_catalog.js";

function fixture() {
  return {
    source_id: "db1",
    tables: {
      users: {
        primary_keys: ["id"],
        columns: [
          { name: "id", type: "uuid" },
          { name: "first_name", type: "text" },
          { name: "last_name", type: "text" },
          { name: "password_hash", type: "text" },
          { name: "created_at", type: "timestamp" }
        ]
      },
      projects: {
        primary_keys: ["id"],
        columns: [
          { name: "id", type: "uuid" },
          { name: "project_name", type: "text" },
          { name: "project_code", type: "text" },
          { name: "owner_consultant_id", type: "uuid" },
          { name: "status", type: "text" },
          { name: "updated_at", type: "timestamp" }
        ]
      }
    },
    relationships: [{
      source_table: "projects",
      source_column: "owner_consultant_id",
      target_table: "users",
      target_column: "id",
      relationship_type: "FOREIGN_KEY"
    }]
  };
}

test("derived catalog profiles identify display, internal, status, timestamp, metric, and same-source FK roles", () => {
  const entities = deriveTechnicalEntities(fixture());
  assert.deepEqual(entities.users.display_template.columns, ["first_name", "last_name"]);
  assert.equal(entities.users.column_roles.id.role, "internal_id");
  assert.equal(entities.users.column_roles.password_hash.role, "other");
  assert.equal(entities.users.column_roles.created_at.role, "timestamp");
  assert.deepEqual(entities.projects.display_template.columns, ["project_name"]);
  assert.equal(entities.projects.secondary_label, "project_code");
  assert.equal(entities.projects.column_roles.owner_consultant_id.role, "foreign_key");
  assert.equal(entities.projects.column_roles.owner_consultant_id.target_table, "users");
  assert.equal(entities.projects.column_roles.owner_consultant_id.relationship_role, "owner consultant");
  assert.equal(entities.projects.column_roles.status.role, "status");
});

test("approved catalog profiles override display choices while retaining safe derived roles", () => {
  const contexts = { db1: fixture() };
  const catalog = {
    provenance: { kind: "application_owned_semantic_overlay", business_approval_required_for_new_mappings: true },
    sources: {
      db1: {
        entities: {
          projects: {
            entity_type: "project",
            synonyms: ["project"],
            provenance: ["approved fixture"],
            display_template: { columns: ["project_code"], separator: "" }
          }
        }
      }
    },
    verified_paths: []
  };
  const attached = attachSemanticCatalog(contexts, catalog);
  const project = attached.contexts.db1.semantic_catalog.entities.projects;
  assert.deepEqual(project.display_template.columns, ["project_code"]);
  assert.equal(project.column_roles.owner_consultant_id.role, "foreign_key");
  assert.deepEqual(validateSemanticCatalog(contexts, catalog, new Set()), []);
});
