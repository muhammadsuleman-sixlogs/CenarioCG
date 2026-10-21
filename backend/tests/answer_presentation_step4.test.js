import { test } from "node:test";
import assert from "node:assert/strict";
import { AnswerGenerator } from "../llm/answer_generator.js";
import { EvidenceManager } from "../llm/evidence_manager.js";
import { scalarCountAnswer } from "../pipeline/rag_pipeline.js";
import { sanitizePublicAnswerText } from "../security/output_security_policy.js";

test("answer prompt uses compact evidence and clear-English label guidance", () => {
  const generator = new AnswerGenerator({});
  const prompt = generator.buildPrompt("Show project details", { items: [{ row: { title: "AI integration", code: "AVID-4207" } }] });
  assert.match(prompt, /ASD-STE100-inspired English/i);
  assert.match(prompt, /Keep sentences short and clear/i);
  assert.match(prompt, /human-readable labels/i);
  assert.doesNotMatch(prompt, /\n\s+"title"/);
  assert.match(prompt, /AVID-4207/);
});

test("answer evidence keeps labels and business dates but removes internal fields", () => {
  const contexts = {
    db1: {
      semantic_catalog: { entities: { projects: { column_roles: {
        id: { role: "internal_id" },
        title: { role: "display" },
        owner_consultant_id: { role: "foreign_key", target_table: "users", target_column: "id" },
        status: { role: "status" },
        created_at: { role: "timestamp" }
      } } } }
    }
  };
  const evidence = {
    items: [{ source_id: "db1", table: "projects", row: {
      id: "internal-project-id",
      title: "AI integration",
      owner_consultant_id: "internal-user-id",
      consultant_label: "Umar Daraz",
      status: "In Progress",
      created_at: "2026-10-20T10:00:00Z",
      updated_at: "2026-10-20T11:00:00Z"
    } }]
  };
  const ordinary = new EvidenceManager().prepareAnswerEvidence(evidence, { contexts, question: "Show project status" });
  assert.deepEqual(ordinary.items[0].row, { title: "AI integration", consultant_label: "Umar Daraz", status: "In Progress" });
  const dateAnswer = new EvidenceManager().prepareAnswerEvidence(evidence, { contexts, question: "Show the project creation date" });
  assert.equal(dateAnswer.items[0].row.created_at, "2026-10-20T10:00:00Z");
  assert.equal(dateAnswer.items[0].row.updated_at, "2026-10-20T11:00:00Z");
});

test("final answer scrubber removes UUIDs but preserves business codes", () => {
  const text = sanitizePublicAnswerText("Project AVID-4207 has id 550e8400-e29b-41d4-a716-446655440000.");
  assert.equal(text, "Project AVID-4207 has id [REDACTED ID].");
});

test("scalar count template excludes grouped results", () => {
  const plan = { required_tables: ["tickets"], operations: ["count"], grouping: [] };
  assert.equal(scalarCountAnswer("How many tickets?", plan, { items: [{ row: { count: "0" } }] }), "There are 0 tickets.");
  assert.equal(scalarCountAnswer("How many tickets by status?", { ...plan, grouping: ["tickets.status"] }, { items: [{ row: { status: "pending", count: "2" } }] }), null);
});
