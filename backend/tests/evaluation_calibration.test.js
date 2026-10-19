import { test } from "node:test";
import assert from "node:assert/strict";
import { runOfflineEvaluation } from "../evaluation/baseline_runner.js";
import { calibrateEvaluation, TRIAGE_CLASSIFICATIONS } from "../evaluation/calibration.js";

test("evaluation calibration reports the post-P0 score and separates evaluator false negatives", async () => {
  const report = await runOfflineEvaluation();
  const calibration = calibrateEvaluation(report);

  assert.deepEqual(calibration.original, {
    total: 120,
    passed: 74,
    failed: 46,
    calibrated_passed: 75,
    calibrated_failed: 45
  });
  assert.equal(calibration.flagged_count, 46);
  assert.equal(calibration.cases.length, 46);
  assert.equal(Object.keys(TRIAGE_CLASSIFICATIONS).length, 53);
  assert.equal(calibration.counts.evaluator_false_negative, 4);
  assert.equal(calibration.counts.confirmed_implementation_defect, 20);
  assert.equal(calibration.counts.expected_safe_clarification_or_refusal, 14);
  assert.equal(calibration.counts.unsupported_capability, 5);
  assert.equal(calibration.counts.missing_or_insufficient_fixture_metadata, 2);
  assert.equal(calibration.counts.provider_dependent_unverified, 1);

  console.log(`EVALUATION TRIAGE ${JSON.stringify({
    original: calibration.original,
    flagged_count: calibration.flagged_count,
    counts: calibration.counts,
    severities: calibration.severities,
    cases: calibration.cases
  })}`);
});
