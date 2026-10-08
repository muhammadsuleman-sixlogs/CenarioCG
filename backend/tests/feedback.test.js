import test from "node:test";
import assert from "node:assert";
import {
  saveFeedback,
  getAllFeedback,
  getFeedbackStats,
  deleteFeedback
} from "../feedback/feedback_store.js";

test("Feedback store records positive and negative feedback", () => {
  const initialStats = getFeedbackStats();

  const savedPositive = saveFeedback({
    feedback_type: "positive",
    question: "Test question positive",
    answer: "Test answer positive",
    comment: "Good job"
  });

  assert.ok(savedPositive.id.startsWith("fb_"));
  assert.strictEqual(savedPositive.feedback_type, "positive");
  assert.strictEqual(savedPositive.question, "Test question positive");

  const savedNegative = saveFeedback({
    feedback_type: "negative",
    question: "Test question negative",
    answer: "Test answer negative",
    comment: "Needs improvement"
  });

  assert.strictEqual(savedNegative.feedback_type, "negative");

  const all = getAllFeedback();
  assert.ok(all.some((item) => item.id === savedPositive.id));
  assert.ok(all.some((item) => item.id === savedNegative.id));

  const stats = getFeedbackStats();
  assert.strictEqual(stats.total, initialStats.total + 2);
  assert.strictEqual(stats.positive, initialStats.positive + 1);
  assert.strictEqual(stats.negative, initialStats.negative + 1);

  // Clean up
  deleteFeedback(savedPositive.id);
  deleteFeedback(savedNegative.id);

  const finalStats = getFeedbackStats();
  assert.strictEqual(finalStats.total, initialStats.total);
});
