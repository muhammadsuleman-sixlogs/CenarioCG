import {
  InputBinding,
  QueryPlan,
  QueryStep,
} from "./query_plan.js";

/**
 * Deterministic adapter for the canonical execution plan.
 *
 * Important architecture rule:
 *     QuestionPlanner = WHAT?
 *     ComplexQueryPlanner = HOW TO REPRESENT THE ALREADY-DECIDED PLAN?
 *
 * This class MUST NOT:
 * - call an LLM
 * - create another QuestionPlanner
 * - reinterpret user intent
 * - invent tables, columns, relationships, sources, or joins
 * - perform database access
 * - repair semantic meaning
 */
export class ComplexQueryPlanner {
  constructor(...args) {
    this.max_steps = 16;
    this.maxSteps = 16;
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  should_decompose(question = null, validated_plan = null, ...args) {
    const plan = validated_plan || {};
    const executionPlan = plan.execution_plan;

    if (!executionPlan || typeof executionPlan !== "object" || Array.isArray(executionPlan)) {
      return false;
    }

    const steps = executionPlan.steps;
    if (!Array.isArray(steps)) {
      return false;
    }

    const mode = String(executionPlan.mode || "").trim().toLowerCase();

    // One-step plan = normal retrieval.
    if (steps.length <= 1) {
      return false;
    }

    // Multiple steps represent coordinated execution.
    return mode === "multi_step" || steps.length > 1;
  }

  shouldDecompose(...args) {
    return this.should_decompose(...args);
  }

  build(question_or_plan = null, validated_plan = null, ...args) {
    const plan = this._resolve_plan_input(question_or_plan, validated_plan);

    const executionPlan = plan.execution_plan;
    if (!executionPlan || typeof executionPlan !== "object" || Array.isArray(executionPlan)) {
      throw new Error(
        "missing_execution_plan: complex execution requires the canonical execution_plan produced by QuestionPlanner"
      );
    }

    const queryPlan = this._compile_execution_plan(executionPlan);
    return queryPlan;
  }

  // ------------------------------------------------------------------
  // Input handling
  // ------------------------------------------------------------------

  _resolve_plan_input(question_or_plan, validated_plan) {
    if (validated_plan && typeof validated_plan === "object" && !Array.isArray(validated_plan)) {
      return validated_plan;
    }

    if (question_or_plan && typeof question_or_plan === "object" && !Array.isArray(question_or_plan)) {
      return question_or_plan;
    }

    throw new Error(
      "validated_plan must be supplied when building an execution plan"
    );
  }

  // ------------------------------------------------------------------
  // Compilation
  // ------------------------------------------------------------------

  _compile_execution_plan(executionPlan) {
    const mode = String(executionPlan.mode || "multi_step").trim().toLowerCase();

    if (mode !== "single" && mode !== "multi_step") {
      throw new Error(`invalid execution_plan mode: '${mode}'`);
    }

    const rawSteps = executionPlan.steps;
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
      throw new Error("execution_plan.steps must contain at least one step");
    }

    if (rawSteps.length > this.max_steps) {
      throw new Error(
        `execution_plan exceeds maximum of ${this.max_steps} steps`
      );
    }

    const steps = [];
    for (const rawStep of rawSteps) {
      steps.push(this._compile_step(rawStep));
    }

    // Runtime bindings reference the producer's actual emitted row key.
    // Planner metadata may declare a qualified field such as table.id,
    // while query results expose the SELECT alias as id. Normalize that
    // representation deterministically after all steps are known.
    this._normalize_runtime_binding_columns(steps);

    const finalStep = this._resolve_final_step(executionPlan, steps);
    const reason = String(executionPlan.reason || "").trim();

    return new QueryPlan(
      mode,
      steps,
      finalStep,
      reason
    );
  }

  _compile_step(rawStep) {
    if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) {
      throw new Error("each execution_plan step must be an object");
    }

    const stepId = String(rawStep.id || "").trim();
    if (!stepId) {
      throw new Error("execution_plan step is missing id");
    }

    const stepType = String(rawStep.type || "").trim().toLowerCase();
    if (!["source_query", "set_operation", "final_query"].includes(stepType)) {
      throw new Error(`unsupported execution step type: '${stepType}'`);
    }

    let sourceId = rawStep.source_id;
    if (sourceId !== null && sourceId !== undefined) {
      sourceId = String(sourceId).trim() || null;
    } else {
      sourceId = null;
    }

    let contract = rawStep.contract;
    if (contract === null || contract === undefined) {
      contract = {};
    }

    if (typeof contract !== "object" || Array.isArray(contract)) {
      throw new Error(`step '${stepId}' contract must be an object`);
    }

    const dependsOn = this._string_list(
      rawStep.depends_on,
      `${stepId}.depends_on`
    );

    let inputs = this._string_list(
      rawStep.inputs,
      `${stepId}.inputs`
    );

    // For source_query/final_query steps, `inputs` are logical input
    // names, not execution-step references. Runtime data flow is carried
    // by `input_bindings` and `depends_on`. Keep logical inputs in the
    // canonical plan, but do not copy them into QueryStep.inputs because
    // QueryPlan validation treats that field as step references.
    if (stepType === "source_query" || stepType === "final_query") {
      inputs = [];
    }

    const inputBindings = this._compile_bindings(
      rawStep.input_bindings,
      stepId
    );

    let operator = rawStep.operator;
    if (operator !== null && operator !== undefined) {
      operator = String(operator).trim().toLowerCase() || null;
    } else {
      operator = null;
    }

    const keyColumns = this._string_list(
      rawStep.key_columns,
      `${stepId}.key_columns`
    );

    const outputColumns = this._string_list(
      rawStep.output_columns,
      `${stepId}.output_columns`
    );

    const purpose = String(rawStep.purpose || "").trim();

    return new QueryStep(
      stepId,
      stepType,
      sourceId,
      contract,
      dependsOn,
      inputs,
      inputBindings,
      operator,
      keyColumns,
      outputColumns,
      purpose
    );
  }

  _normalize_runtime_binding_columns(steps) {
    const stepMap = {};
    for (const step of steps) {
      stepMap[step.step_id] = step;
    }

    for (const consumer of steps) {
      if (!consumer.input_bindings || consumer.input_bindings.length === 0) {
        continue;
      }

      const normalized = [];

      for (const binding of consumer.input_bindings) {
        const producer = stepMap[binding.from_step];
        if (!producer) {
          normalized.push(binding);
          continue;
        }

        const declared = [
          ...producer.output_columns,
          ...producer.key_columns,
        ];
        const producerContract = producer.contract;
        if (producerContract && typeof producerContract === "object" && !Array.isArray(producerContract)) {
          const required = producerContract.required_columns;
          if (Array.isArray(required)) {
            for (const value of required) {
              if (typeof value === "string" && value.trim()) {
                declared.push(value.trim());
              }
            }
          }
        }

        const match = declared.find(value => {
          const strVal = String(value).trim();
          if (strVal.toLowerCase() === binding.from_column.toLowerCase()) {
            return true;
          }
          if (strVal.includes(".") && strVal.split(".").pop().toLowerCase() === binding.from_column.toLowerCase()) {
            return true;
          }
          return false;
        });

        if (match && String(match).includes(".")) {
          const fromColumn = String(match).split(".").pop();
          normalized.push(
            new InputBinding(
              binding.from_step,
              fromColumn,
              binding.to_table,
              binding.to_column,
              binding.operator
            )
          );
        } else {
          normalized.push(binding);
        }
      }

      consumer.input_bindings = normalized;
    }
  }

  _compile_bindings(rawBindings, stepId) {
    if (rawBindings === null || rawBindings === undefined) {
      return [];
    }

    if (!Array.isArray(rawBindings)) {
      throw new Error(`${stepId}.input_bindings must be a list`);
    }

    const bindings = [];

    for (let index = 0; index < rawBindings.length; index++) {
      const rawBinding = rawBindings[index];
      if (!rawBinding || typeof rawBinding !== "object" || Array.isArray(rawBinding)) {
        throw new Error(
          `${stepId}.input_bindings[${index}] must be an object`
        );
      }

      const fromStep = String(rawBinding.from_step || "").trim();
      const fromColumn = String(rawBinding.from_column || "").trim();
      const toTable = String(rawBinding.to_table || "").trim();
      const toColumn = String(rawBinding.to_column || "").trim();
      const operator = String(rawBinding.operator || "in").trim().toLowerCase();

      if (!fromStep) {
        throw new Error(`${stepId}.input_bindings[${index}] is missing from_step`);
      }
      if (!fromColumn) {
        throw new Error(`${stepId}.input_bindings[${index}] is missing from_column`);
      }
      if (!toTable) {
        throw new Error(`${stepId}.input_bindings[${index}] is missing to_table`);
      }
      if (!toColumn) {
        throw new Error(`${stepId}.input_bindings[${index}] is missing to_column`);
      }

      if (!["in", "not_in", "equals"].includes(operator)) {
        throw new Error(
          `${stepId}.input_bindings[${index}] has unsupported operator '${operator}'`
        );
      }

      bindings.push(
        new InputBinding(
          fromStep,
          fromColumn,
          toTable,
          toColumn,
          operator
        )
      );
    }

    return bindings;
  }

  // ------------------------------------------------------------------
  // Validation helpers
  // ------------------------------------------------------------------

  _string_list(value, fieldName) {
    if (value === null || value === undefined) {
      return [];
    }

    if (!Array.isArray(value)) {
      throw new Error(`${fieldName} must be a list`);
    }

    const result = [];
    for (const item of value) {
      const text = String(item ?? "").trim();
      if (!text) {
        throw new Error(`${fieldName} contains an empty value`);
      }
      result.push(text);
    }

    return result;
  }

  _resolve_final_step(executionPlan, steps) {
    const requestedFinal = String(executionPlan.final_step || "").trim();
    const stepIds = new Set(steps.map(step => step.step_id));

    if (requestedFinal) {
      if (!stepIds.has(requestedFinal)) {
        throw new Error(
          `execution_plan.final_step '${requestedFinal}' does not reference an existing step`
        );
      }
      return requestedFinal;
    }

    // Deterministic fallback only.
    // Prefer the explicit final_query step, otherwise use the last declared step.
    const finalCandidates = steps
      .filter(step => step.step_type === "final_query")
      .map(step => step.step_id);

    if (finalCandidates.length === 1) {
      return finalCandidates[0];
    }

    if (finalCandidates.length > 1) {
      throw new Error(
        "execution_plan contains multiple final_query steps without an explicit final_step"
      );
    }

    return steps[steps.length - 1].step_id;
  }
}

export default {
  ComplexQueryPlanner,
};
