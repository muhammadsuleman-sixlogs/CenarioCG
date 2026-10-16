import { test } from "node:test";
import assert from "node:assert/strict";
import { AnswerGenerator } from "../llm/answer_generator.js";
import { QuestionPlanner } from "../planning/question_planner.js";
import {
  createLlmUsageTracker,
  extractProviderUsage,
  snapshotLlmUsage
} from "../llm/usage_tracker.js";
import { loadTestContexts } from "./test_context.js";

test("provider usage extraction keeps reported and unavailable metrics distinct", () => {
  assert.deepEqual(extractProviderUsage({
    usage: {
      input_tokens: 19,
      output_tokens: 7,
      input_tokens_details: { cached_tokens: 5 }
    }
  }), {
    values: { input_tokens: 19, output_tokens: 7, cached_input_tokens: 5 },
    source: "provider_reported"
  });

  assert.deepEqual(extractProviderUsage({}), {
    values: { input_tokens: null, output_tokens: null, cached_input_tokens: null },
    source: "unavailable"
  });
});

test("answer generation records response usage without retaining prompt or evidence", async () => {
  let request = null;
  const client = {
    responses: {
      async create(options) {
        request = options;
        return {
          model: "mock-answer-model",
          output_text: "Grounded answer",
          usage: {
            input_tokens: 31,
            output_tokens: 6,
            input_tokens_details: { cached_tokens: 9 }
          }
        };
      }
    }
  };
  const tracker = createLlmUsageTracker("request-answer");
  const answer = await new AnswerGenerator(client, "mock-answer-model").generate(
    "Which project is active?",
    { rows: [{ project_id: "p1" }] },
    null,
    null,
    tracker
  );

  assert.equal(answer, "Grounded answer");
  assert.equal(request.model, "mock-answer-model");
  const usage = snapshotLlmUsage(tracker);
  assert.equal(usage.call_count, 1);
  assert.equal(usage.stages.answer.call_count, 1);
  assert.deepEqual(usage.stages.answer.totals.input_tokens, { value: 31, status: "provider_reported" });
  assert.deepEqual(usage.stages.answer.totals.cached_input_tokens, { value: 9, status: "provider_reported" });
  assert.equal(Object.prototype.hasOwnProperty.call(usage, "prompt"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(usage, "evidence"), false);
});

test("answer transport fallback records both attempts and provider usage", async () => {
  const tracker = createLlmUsageTracker("request-fallback");
  const client = {
    responses: {
      async create() {
        const error = new Error("unsupported transport");
        error.code = "NOT_SUPPORTED";
        throw error;
      }
    },
    chat: {
      completions: {
        async create() {
          return {
            model: "mock-chat-model",
            choices: [{ message: { content: "Fallback answer" } }],
            usage: {
              prompt_tokens: 23,
              completion_tokens: 4,
              prompt_tokens_details: { cached_tokens: 3 }
            }
          };
        }
      }
    }
  };

  const answer = await new AnswerGenerator(client, "mock-chat-model").generate(
    "What is pending?",
    { rows: [] },
    null,
    null,
    tracker
  );
  const usage = snapshotLlmUsage(tracker);

  assert.equal(answer, "Fallback answer");
  assert.equal(usage.stages.answer.call_count, 2);
  assert.equal(usage.stages.answer.fallback_attempts, 1);
  assert.equal(usage.stages.answer.calls[0].usage_source, "unavailable");
  assert.equal(usage.stages.answer.calls[1].usage_source, "provider_reported");
  assert.deepEqual(usage.stages.answer.totals.input_tokens, { value: null, status: "partial" });
  assert.deepEqual(usage.stages.answer.totals.output_tokens, { value: null, status: "partial" });
});

test("planner records provider usage at its existing model boundary", async () => {
  const planner = new QuestionPlanner(loadTestContexts());
  planner.client = {
    responses: {
      async create() {
        return {
          model: "mock-planner-model",
          output_text: JSON.stringify({
            data_sources: ["postgresql"],
            postgresql_sources: ["db1"],
            required_tables: ["projects"],
            required_columns: ["projects.project_id"],
            filters: [],
            relationships: [],
            operations: ["lookup"],
            confidence: 0.9
          }),
          usage: {
            input_tokens: 41,
            output_tokens: 12,
            input_tokens_details: { cached_tokens: 11 }
          }
        };
      }
    }
  };
  const tracker = createLlmUsageTracker("request-planner");
  const plan = await planner.plan("Explain the available data model.", null, tracker);
  const usage = snapshotLlmUsage(tracker);

  assert.deepEqual(plan.postgresql_sources, ["db1"]);
  assert.equal(usage.stages.planner.call_count, 1);
  assert.equal(usage.stages.planner.calls[0].model, "mock-planner-model");
  assert.deepEqual(usage.stages.planner.totals.input_tokens, { value: 41, status: "provider_reported" });
  assert.deepEqual(usage.stages.planner.totals.output_tokens, { value: 12, status: "provider_reported" });
});
