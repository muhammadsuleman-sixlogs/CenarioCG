import { test } from "node:test";
import assert from "node:assert/strict";
import { QuestionPlanner } from "../planning/question_planner.js";
import { loadTestContexts } from "./test_context.js";

const contexts = loadTestContexts();

function tablesBySource(context) {
  return Object.fromEntries(Object.entries(context.sources).map(([sourceId, source]) => [
    sourceId,
    new Set(Object.keys(source.tables))
  ]));
}

test("recent-meetings planner context is query-focused without losing its verified path", () => {
  const planner = new QuestionPlanner(contexts);
  const question = "Show me recent meetings";
  const full = planner._build_context_for_llm();
  const focused = planner._build_context_for_llm(question);
  const fullPrompt = planner._build_prompt(question, full, null, []);
  const focusedPrompt = planner._build_prompt(question, focused, null, []);

  assert.ok(JSON.stringify(focused).length < JSON.stringify(full).length * 0.5);
  assert.ok(focusedPrompt.length < fullPrompt.length * 0.5);
  const selected = tablesBySource(focused);
  assert.equal(selected.db2.has("sessions"), true);
  assert.equal(focused.candidate_entities.some(item => item.source_id === "db2" && item.table === "sessions"), true);
  assert.equal(focused.verified_paths.some(path => path.steps.at(-1)?.table === "sessions"), true);
  assert.ok(Object.values(focused.sources).some(source => source.relationships.length > 0));
});

test("ambiguous entities retain competing authorized candidates", () => {
  const planner = new QuestionPlanner(contexts);
  const focused = planner._build_context_for_llm("Show me project");
  const selected = tablesBySource(focused);

  assert.equal(selected.db1.has("project_details"), true);
  assert.equal(selected.db2.has("projects"), true);
  assert.ok(focused.candidate_entities.some(item => item.source_id === "db1" && item.table === "project_details"));
  assert.ok(focused.candidate_entities.some(item => item.source_id === "db2" && item.table === "projects"));
});

test("cross-source questions retain the approved meeting-project-company path", () => {
  const planner = new QuestionPlanner(contexts);
  const focused = planner._build_context_for_llm("Show me Meta Briefing meeting, its project, and associated company");
  const selected = tablesBySource(focused);
  const pathStrings = focused.verified_paths.map(path => path.steps.map(step => `${step.source_id}.${step.table}`).join(" -> "));

  assert.equal(selected.db2.has("sessions"), true);
  assert.equal(selected.db2.has("projects"), true);
  assert.equal(selected.db1.has("project_details"), true);
  assert.equal(selected.db1.has("companies"), true);
  assert.ok(pathStrings.some(path => path.includes("db2.projects") && path.includes("db1.companies")));
});

test("unfamiliar technical entities retain their discovered neighborhood without a semantic overlay", () => {
  const unfamiliar = {
    alpha: {
      source_id: "alpha",
      tables: {
        ledger_items: {
          primary_keys: ["ledger_key"],
          columns: [{ name: "ledger_key", type: "uuid" }, { name: "created_on", type: "timestamp" }]
        }
      },
      relationships: [{ source_table: "ledger_items", source_column: "ledger_key", target_table: "signal_events", target_column: "ledger_key" }]
    },
    beta: {
      source_id: "beta",
      tables: {
        signal_events: {
          primary_keys: ["event_key"],
          columns: [{ name: "event_key", type: "uuid" }, { name: "ledger_key", type: "uuid" }, { name: "occurred_on", type: "timestamp" }]
        }
      },
      relationships: []
    }
  };
  const planner = new QuestionPlanner(unfamiliar);
  const focused = planner._build_context_for_llm("Show recent signal events");
  const selected = tablesBySource(focused);

  assert.equal(selected.beta.has("signal_events"), true);
  assert.equal(selected.alpha, undefined);
  assert.equal(focused.verified_paths.length, 0);
  assert.equal(Object.values(focused.sources).every(source => Object.keys(source.tables).length <= 1), true);
});

test("active conversation references remain in the focused planner context", () => {
  const planner = new QuestionPlanner(contexts);
  const conversation = {
    active_context: {
      source_id: "db2",
      table: "projects",
      stable_keys: { project_id: "project-1" }
    },
    entities: [{ source_id: "db2", entity_table: "projects", type: "project", id: "project-1" }]
  };
  const focused = planner._build_context_for_llm("Which company owns it?", conversation);
  const selected = tablesBySource(focused);

  assert.equal(selected.db2.has("projects"), true);
  assert.equal(selected.db1.has("companies"), true);
  assert.ok(focused.verified_paths.some(path => path.steps[0]?.source_id === "db2" && path.steps.at(-1)?.table === "companies"));
});
