import { test } from "node:test";
import assert from "node:assert/strict";
import { EVALUATION_CATEGORIES, REPRESENTATIVE_QUESTIONS } from "../evaluation/representative_questions.js";
import { runOfflineEvaluation } from "../evaluation/baseline_runner.js";

test("offline representative evaluation corpus has the required breadth", () => {
  assert.equal(REPRESENTATIVE_QUESTIONS.length, 120);
  assert.ok(EVALUATION_CATEGORIES.length >= 15);
  assert.ok(EVALUATION_CATEGORIES.includes("cross_source"));
  assert.ok(EVALUATION_CATEGORIES.includes("follow_up"));
  assert.ok(EVALUATION_CATEGORIES.includes("synthetic_schema"));
  assert.ok(REPRESENTATIVE_QUESTIONS.every(item => item.id && item.question && item.category && item.expected_outcome));
});

test("offline representative evaluation records a privacy-safe category scorecard without external calls", async () => {
  const report = await runOfflineEvaluation();
  assert.equal(report.corpus_count, 120);
  assert.equal(report.external_calls, 0);
  assert.equal(report.totals.total, 120);
  assert.equal(Object.keys(report.categories).length, EVALUATION_CATEGORIES.length);
  assert.ok(report.planner.cases === 120);
  assert.equal(report.answer.cases, 120);
  assert.equal(report.answer.provider_reported_calls, 0);
  assert.ok(report.planner.context_characters >= 0);
  assert.ok(report.answer.prompt_characters > 0);

  // The score is intentionally reported rather than used as a gate: this is
  // a baseline for known ~90% behavior, so failures are evidence for the next
  // engineering task and must not mutate planner behavior or fixture data.
  console.log(`EVALUATION SCORECARD ${JSON.stringify({
    totals: report.totals,
    categories: report.categories,
    planner: report.planner,
    answer: report.answer,
    failure_sample: report.failures
  })}`);
});
