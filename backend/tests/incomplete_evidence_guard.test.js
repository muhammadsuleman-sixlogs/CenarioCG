import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextManager } from "../context/context_manager.js";
import { QuestionPlanValidator } from "../planning/question_plan_validator.js";
import { RAGPipeline, questionRequiresCompleteEvidence } from "../pipeline/rag_pipeline.js";
import { SourceRouter } from "../planning/source_router.js";
import { loadTestContexts, OFFLINE_PROVIDER } from "./test_context.js";
import { validateReadOnlyQuery } from "../database/readonly_guard.js";

test("complete-evidence classification covers relationships and aggregates", () => {
  assert.equal(questionRequiresCompleteEvidence("Which consultant is assigned to this project?"), true);
  assert.equal(questionRequiresCompleteEvidence("What is the total ticket count?"), true);
  assert.equal(questionRequiresCompleteEvidence("Show project titles"), false);
});

test("truncated relationship evidence skips AnswerGenerator and asks for a narrower request", async () => {
  const contexts = loadTestContexts();
  const pipeline = new RAGPipeline(new ContextManager());
  pipeline.plan_validator = new QuestionPlanValidator(contexts);
  pipeline.planValidator = pipeline.plan_validator;
  pipeline.source_router = new SourceRouter(contexts);
  pipeline.planner = {
    client: OFFLINE_PROVIDER,
    async plan() {
      return {
        question: "Which companies are related to these projects?",
        data_sources: ["postgresql"],
        postgresql_sources: ["db1"],
        required_tables: ["project_details"],
        required_columns: ["project_details.project_name"],
        relationships: [],
        filters: [],
        operations: ["lookup"],
        limit: 100,
        confidence: 0.9
      };
    }
  };
  pipeline.entity_resolver = { async resolve() { return []; } };
  pipeline.executor = {
    async execute(sql) {
      validateReadOnlyQuery(sql);
      const rows = Array.from({ length: 51 }, (_, index) => ({ project_name: `Project ${index + 1}` }));
      return { rows, row_count: rows.length, columns: ["project_name"] };
    }
  };
  let answerCalled = false;
  pipeline.answer_generator = { async generate() { answerCalled = true; return "must not run"; } };

  const result = await pipeline.ask("Which companies are related to these projects?", {
    workspace_id: "offline",
    authorization: { postgresql_sources: ["db1"], security_resources: [] }
  });
  assert.equal(answerCalled, false);
  assert.equal(result.answer_generation_status, "skipped_incomplete_evidence");
  assert.equal(result.answer_generation_error.type, "EVIDENCE_INCOMPLETE");
  assert.match(result.answer, /incomplete|narrow|filter/i);
});
