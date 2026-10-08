import {
  InputBinding,
  QueryPlan,
  QueryStep,
} from "../planning/query_plan.js";

/**
 * Dependency-aware execution engine for QueryPlan.
 *
 * Architecture:
 *
 *     QueryPlan
 *         |
 *         v
 *     dependency layers
 *         |
 *         +----------------------+
 *         |                      |
 *         v                      v
 *     independent             dependent
 *     branches                 branches
 *         |                      |
 *         +----------+-----------+
 *                    |
 *                    v
 *              runtime bindings
 *                    |
 *                    v
 *             source executor
 *                    |
 *                    v
 *              final result
 *
 * Responsibilities:
 *     - execute dependency-aware plans
 *     - execute independent source steps concurrently
 *     - resolve runtime key bindings
 *     - perform local relational/set operations
 *     - preserve source boundaries
 *     - preserve failure states
 *
 * This class never:
 *     - calls an LLM
 *     - generates SQL
 *     - changes PostgreSQL
 *     - invents relationships
 *     - embeds runtime values into SQL
 *     - converts upstream failures into empty results
 */
export class QueryPlanExecutor {
  static MAX_STEPS = 16;
  static MAX_BINDING_VALUES = 500;
  static MAX_TOTAL_BINDING_VALUES = 2000;
  static MAX_PARAMETER_BINDINGS = 64;
  static MAX_PARALLEL_BRANCHES = 4;
  static MAX_DEPENDENCY_DEPTH = 16;

  static FAILURE_STATUSES = new Set([
    "retrieval_failed",
    "retryable_failure",
    "permanent_failure",
    "timeout",
  ]);

  static SUCCESS_STATUSES = new Set([
    "success_with_data",
    "success_empty",
    "success",
  ]);

  constructor() {
    this.MAX_STEPS = QueryPlanExecutor.MAX_STEPS;
    this.MAX_BINDING_VALUES = QueryPlanExecutor.MAX_BINDING_VALUES;
    this.MAX_TOTAL_BINDING_VALUES = QueryPlanExecutor.MAX_TOTAL_BINDING_VALUES;
    this.MAX_PARAMETER_BINDINGS = QueryPlanExecutor.MAX_PARAMETER_BINDINGS;
    this.MAX_PARALLEL_BRANCHES = QueryPlanExecutor.MAX_PARALLEL_BRANCHES;
    this.MAX_DEPENDENCY_DEPTH = QueryPlanExecutor.MAX_DEPENDENCY_DEPTH;
    this.FAILURE_STATUSES = QueryPlanExecutor.FAILURE_STATUSES;
    this.SUCCESS_STATUSES = QueryPlanExecutor.SUCCESS_STATUSES;
  }

  /**
   * Execute a validated QueryPlan.
   *
   * Independent steps in the same dependency layer can run concurrently.
   *
   * Results are inserted into the returned dictionary in deterministic
   * step-id order even when execution completes in a different order.
   */
  async execute(plan, step_executor) {
    if (!plan || !(plan instanceof QueryPlan) && (!Array.isArray(plan.steps) || !plan.final_step)) {
      throw new Error("plan must be a QueryPlan instance.");
    }

    if (typeof step_executor !== "function") {
      throw new Error("step_executor must be callable.");
    }

    const steps = Array.from(plan.steps);

    if (steps.length > this.MAX_STEPS) {
      throw new Error(`Query plan exceeds the maximum of ${this.MAX_STEPS} steps.`);
    }

    const layers = this._build_execution_layers(plan);
    const results = {};

    for (const layer of layers) {
      const layer_results = await this._execute_layer(layer, results, step_executor);

      for (const step of [...layer].sort((a, b) => a.step_id.localeCompare(b.step_id))) {
        results[step.step_id] = layer_results[step.step_id];
      }
    }

    const final_result = results[plan.final_step];

    if (final_result === undefined) {
      throw new Error(`Final step '${plan.final_step}' did not produce a result.`);
    }

    this._raise_if_failed_result(plan.final_step, final_result);

    const planDict =
      typeof plan.to_dict === "function"
        ? plan.to_dict()
        : typeof plan.toDict === "function"
        ? plan.toDict()
        : plan;

    return {
      status: "success",
      final_step: plan.final_step,
      steps: results,
      result: final_result,
      plan: planDict,
    };
  }

  // ------------------------------------------------------------------
  // Dependency graph
  // ------------------------------------------------------------------

  _build_execution_layers(plan) {
    const step_map = {};
    for (const step of plan.steps) {
      step_map[step.step_id] = step;
    }

    const pending = new Set(Object.keys(step_map));
    const completed = new Set();
    const layers = [];

    while (pending.size > 0) {
      const ready = [];

      for (const step_id of Array.from(pending).sort()) {
        const step = step_map[step_id];
        const dependencies = new Set(step.depends_on || []);

        if (step.step_type === "set_operation") {
          for (const inp of step.inputs || []) {
            dependencies.add(inp);
          }
        }

        const allDepsCompleted = Array.from(dependencies).every((dep) =>
          completed.has(dep)
        );

        if (allDepsCompleted) {
          ready.push(step);
        }
      }

      if (!ready.length) {
        throw new Error(
          "Unable to build query-plan execution layers. The plan contains unresolved dependencies."
        );
      }

      layers.push(ready);

      for (const step of ready) {
        pending.delete(step.step_id);
        completed.add(step.step_id);
      }
    }

    return layers;
  }

  // ------------------------------------------------------------------
  // Layer execution
  // ------------------------------------------------------------------

  async _execute_layer(layer, results, step_executor) {
    if (!layer || !layer.length) {
      return {};
    }

    if (layer.length === 1) {
      const step = layer[0];
      return {
        [step.step_id]: await this._execute_step(step, results, step_executor),
      };
    }

    // Execute concurrent branches
    const entries = await Promise.all(
      layer.map(async (step) => {
        const res = await this._execute_step(step, results, step_executor);
        return [step.step_id, res];
      })
    );

    const completed = Object.fromEntries(entries);
    const ordered = {};

    for (const step of [...layer].sort((a, b) => a.step_id.localeCompare(b.step_id))) {
      ordered[step.step_id] = completed[step.step_id];
    }

    return ordered;
  }

  // ------------------------------------------------------------------
  // Step execution
  // ------------------------------------------------------------------

  async _execute_step(step, results, step_executor) {
    const inputs =
      step.step_type === "set_operation"
        ? Object.fromEntries(
            (step.inputs || []).map((input_id) => [input_id, results[input_id]])
          )
        : {};

    const dependencies = Object.fromEntries(
      (step.depends_on || []).map((dep_id) => [dep_id, results[dep_id]])
    );

    this._reject_failed_dependencies(step, dependencies);

    const runtime_bindings = this._resolve_input_bindings(step, results);

    const context = {
      inputs,
      dependencies,
      results,
      runtime_bindings,
    };

    if (step.step_type === "source_query" || step.step_type === "final_query") {
      let result;
      if (runtime_bindings.skip) {
        result = this._empty_source_result(step, runtime_bindings.reason);
      } else {
        result = await step_executor(step, context);
      }

      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new Error(`Step '${step.step_id}' executor must return a dictionary.`);
      }

      this._validate_result_status(step, result);

      return this._attach_provenance(result, step, runtime_bindings);
    }

    if (step.step_type === "set_operation") {
      const result = this._execute_set_operation(step, inputs);
      this._validate_result_status(step, result);
      return result;
    }

    throw new Error(`Unsupported query step type: '${step.step_type}'`);
  }

  // ------------------------------------------------------------------
  // Dependency failures
  // ------------------------------------------------------------------

  _reject_failed_dependencies(step, dependencies) {
    for (const [dependency_id, result] of Object.entries(dependencies)) {
      const status = this._result_status(result);

      if (status && this.FAILURE_STATUSES.has(status)) {
        const message = this._error_message(result);
        throw new Error(
          `Step '${step.step_id}' cannot execute because dependency '${dependency_id}' failed: ${message}`
        );
      }
    }
  }

  _error_message(result) {
    if (!result || typeof result !== "object") {
      return "upstream retrieval failed";
    }

    const error = result.error;
    if (error && typeof error === "object") {
      const message = error.message;
      if (message) {
        return String(message);
      }
    } else if (typeof error === "string") {
      return error;
    }

    return "upstream retrieval failed";
  }

  // ------------------------------------------------------------------
  // Runtime binding resolution
  // ------------------------------------------------------------------

  _resolve_input_bindings(step, results) {
    if (!step.input_bindings || !step.input_bindings.length) {
      return {
        bindings: [],
        parameters: [],
        skip: false,
        reason: "",
      };
    }

    if (step.input_bindings.length > this.MAX_PARAMETER_BINDINGS) {
      throw new Error(
        `Step '${step.step_id}' exceeds the maximum of ${this.MAX_PARAMETER_BINDINGS} runtime bindings.`
      );
    }

    const resolved = [];
    const parameters = [];
    let total_values = 0;

    for (const binding of step.input_bindings) {
      const source_result = results[binding.from_step];

      if (source_result === undefined) {
        throw new Error(
          `Input binding source step '${binding.from_step}' has not produced a result for step '${step.step_id}'.`
        );
      }

      const status = this._result_status(source_result);
      if (status && this.FAILURE_STATUSES.has(status)) {
        throw new Error(
          `Cannot resolve runtime binding for step '${step.step_id}': dependency '${binding.from_step}' failed: ${this._error_message(source_result)}`
        );
      }

      const rows = this._extract_rows(source_result);
      const values = this._extract_binding_values(rows, binding);

      if (values.length > this.MAX_BINDING_VALUES) {
        throw new Error(
          `Runtime binding from '${binding.from_step}' produced more than ${this.MAX_BINDING_VALUES} values.`
        );
      }

      total_values += values.length;

      if (total_values > this.MAX_TOTAL_BINDING_VALUES) {
        throw new Error(
          `Step '${step.step_id}' exceeded the maximum runtime binding value count of ${this.MAX_TOTAL_BINDING_VALUES}.`
        );
      }

      let resolved_operator;
      let parameter_value;

      if (binding.operator === "in") {
        if (!values.length) {
          return {
            bindings: [],
            parameters: [],
            skip: true,
            reason: `Dependency step '${binding.from_step}' produced no values for an IN binding.`,
          };
        }

        resolved_operator = "in";
        parameter_value = [...values];
      } else if (binding.operator === "equals") {
        if (!values.length) {
          return {
            bindings: [],
            parameters: [],
            skip: true,
            reason: `Dependency step '${binding.from_step}' produced no value for an equality binding.`,
          };
        }

        if (values.length === 1) {
          resolved_operator = "equals";
          parameter_value = values[0];
        } else {
          resolved_operator = "in";
          parameter_value = [...values];
        }
      } else if (binding.operator === "not_in") {
        if (!values.length) {
          continue;
        }

        resolved_operator = "not_in";
        parameter_value = [...values];
      } else {
        throw new Error(`Unsupported input binding operator: '${binding.operator}'`);
      }

      const runtime_index = resolved.length;

      resolved.push({
        index: runtime_index,
        from_step: binding.from_step,
        from_column: binding.from_column,
        to_table: binding.to_table,
        to_column: binding.to_column,
        operator: resolved_operator,
        values,
      });

      parameters.push(parameter_value);
    }

    return {
      bindings: resolved,
      parameters,
      skip: false,
      reason: "",
    };
  }

  _extract_binding_values(rows, binding) {
    const values = [];

    for (const row of rows) {
      if (!Object.prototype.hasOwnProperty.call(row, binding.from_column)) {
        throw new Error(
          `Input binding source column '${binding.from_column}' is missing from step '${binding.from_step}' output.`
        );
      }

      const value = row[binding.from_column];

      if (value === null || value === undefined) {
        continue;
      }

      if (!values.some((existing) => this._values_equal(value, existing))) {
        values.push(value);
      }
    }

    return values;
  }

  // ------------------------------------------------------------------
  // Result helpers
  // ------------------------------------------------------------------

  _result_status(result) {
    if (!result || typeof result !== "object") {
      return null;
    }

    for (const key of ["execution_status", "retrieval_status", "status"]) {
      const val = result[key];
      if (typeof val === "string") {
        return val.trim().toLowerCase();
      }
    }

    return null;
  }

  _validate_result_status(step, result) {
    const status = this._result_status(result);

    if (status === null) {
      return;
    }

    if (!this.SUCCESS_STATUSES.has(status) && !this.FAILURE_STATUSES.has(status)) {
      throw new Error(
        `Step '${step.step_id}' returned unsupported execution status: '${status}'`
      );
    }
  }

  _raise_if_failed_result(step_id, result) {
    const status = this._result_status(result);

    if (status && this.FAILURE_STATUSES.has(status)) {
      throw new Error(
        `Final step '${step_id}' failed: ${this._error_message(result)}`
      );
    }
  }

  _extract_rows(result) {
    if (!result || typeof result !== "object") {
      throw new Error("Retrieval result rows must be a list.");
    }

    let rows;
    if (result.retrieval && typeof result.retrieval === "object") {
      rows = result.retrieval.rows !== undefined ? result.retrieval.rows : [];
    } else {
      rows = result.rows !== undefined ? result.rows : [];
    }

    if (!Array.isArray(rows)) {
      throw new Error("Retrieval result rows must be a list.");
    }

    return rows.filter((row) => row && typeof row === "object" && !Array.isArray(row));
  }

  _values_equal(left, right) {
    if (left === right) {
      return true;
    }

    if (left instanceof Date && right instanceof Date) {
      return left.getTime() === right.getTime();
    }

    try {
      return JSON.stringify(left) === JSON.stringify(right);
    } catch {
      return String(left) === String(right);
    }
  }

  // ------------------------------------------------------------------
  // Empty dependent result
  // ------------------------------------------------------------------

  _empty_source_result(step, reason) {
    return {
      source_type: "postgresql",
      source_id: step.source_id,
      retrieval_status: "success_empty",
      execution_status: "success_empty",
      retrieval: {
        rows: [],
        row_count: 0,
        columns: [],
      },
      sql: null,
      repaired: false,
      sources: [],
      runtime_binding_skip: reason,
    };
  }

  // ------------------------------------------------------------------
  // Local relational/set operations
  // ------------------------------------------------------------------

  _execute_set_operation(step, inputs) {
    const ordered_inputs = (step.inputs || []).map((input_id) => inputs[input_id]);

    if (!ordered_inputs.length) {
      throw new Error(`Set operation '${step.step_id}' has no input results.`);
    }

    // Set operations cannot consume failed inputs.
    for (let i = 0; i < step.inputs.length; i++) {
      const input_id = step.inputs[i];
      const result = ordered_inputs[i];
      const status = this._result_status(result);

      if (status && this.FAILURE_STATUSES.has(status)) {
        throw new Error(
          `Set operation '${step.step_id}' cannot execute because input '${input_id}' failed: ${this._error_message(result)}`
        );
      }
    }

    const rows_by_input = ordered_inputs.map((result) => this._extract_rows(result));
    let rows;

    if (step.operator === "distinct") {
      rows = this._distinct_rows(rows_by_input[0], step.key_columns);
    } else if (step.operator === "intersect") {
      rows = this._intersect_rows(rows_by_input, step.key_columns);
    } else if (step.operator === "union") {
      const all_rows = rows_by_input.flat();
      rows = this._distinct_rows(all_rows, step.key_columns);
    } else if (step.operator === "union_all") {
      rows = rows_by_input.flat();
    } else if (step.operator === "except") {
      rows = this._except_rows(
        rows_by_input[0],
        rows_by_input.slice(1),
        step.key_columns
      );
    } else {
      throw new Error(`Unsupported set operator: '${step.operator}'`);
    }

    const status = rows.length > 0 ? "success_with_data" : "success_empty";

    const provenance = {
      operation: step.operator,
      inputs: Array.isArray(step.inputs) ? [...step.inputs] : [],
      key_columns: Array.isArray(step.key_columns) ? [...step.key_columns] : [],
    };

    return {
      source_type: "relational_operation",
      source_id: null,
      retrieval_status: status,
      execution_status: status,
      retrieval: {
        rows,
        row_count: rows.length,
        columns: this._columns(rows),
        provenance,
      },
      provenance,
    };
  }

  // ------------------------------------------------------------------
  // Set-operation helpers
  // ------------------------------------------------------------------

  _key(row, key_columns) {
    if (!key_columns || !key_columns.length) {
      throw new Error("Set operations require explicit key_columns.");
    }

    const missing = key_columns.filter((column) => !Object.prototype.hasOwnProperty.call(row, column));

    if (missing.length > 0) {
      throw new Error(`Set-operation key column(s) missing from row: ${JSON.stringify(missing)}`);
    }

    return key_columns.map((column) => row[column]);
  }

  _distinct_rows(rows, key_columns) {
    const seen = [];
    const output = [];

    for (const row of rows || []) {
      const key = this._key(row, key_columns);

      if (seen.some((existing) => this._keys_equal(key, existing))) {
        continue;
      }

      seen.push(key);
      output.push(row);
    }

    return output;
  }

  _intersect_rows(row_sets, key_columns) {
    if (!row_sets || !row_sets.length) {
      return [];
    }

    const key_sets = [];

    for (const rows of row_sets) {
      const keys = [];

      for (const row of rows || []) {
        const key = this._key(row, key_columns);

        if (!keys.some((existing) => this._keys_equal(key, existing))) {
          keys.push(key);
        }
      }

      key_sets.push(keys);
    }

    const firstKeys = key_sets[0] || [];
    const otherKeySets = key_sets.slice(1);

    const common = firstKeys.filter((key) =>
      otherKeySets.every((keys) =>
        keys.some((candidate) => this._keys_equal(key, candidate))
      )
    );

    const output = [];
    const seen = [];

    for (const row of row_sets[0] || []) {
      const key = this._key(row, key_columns);

      if (!common.some((candidate) => this._keys_equal(key, candidate))) {
        continue;
      }

      if (seen.some((existing) => this._keys_equal(key, existing))) {
        continue;
      }

      output.push(row);
      seen.push(key);
    }

    return output;
  }

  _except_rows(first_rows, excluded_sets, key_columns) {
    const excluded = [];

    for (const rows of excluded_sets) {
      for (const row of rows || []) {
        const key = this._key(row, key_columns);

        if (!excluded.some((existing) => this._keys_equal(key, existing))) {
          excluded.push(key);
        }
      }
    }

    const output = [];
    const seen = [];

    for (const row of first_rows || []) {
      const key = this._key(row, key_columns);

      if (excluded.some((candidate) => this._keys_equal(key, candidate))) {
        continue;
      }

      if (seen.some((existing) => this._keys_equal(key, existing))) {
        continue;
      }

      output.push(row);
      seen.push(key);
    }

    return output;
  }

  _keys_equal(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }

    return left.every((left_value, i) =>
      this._values_equal(left_value, right[i])
    );
  }

  _columns(rows) {
    const columns = [];

    for (const row of rows || []) {
      for (const column of Object.keys(row)) {
        if (!columns.includes(column)) {
          columns.push(column);
        }
      }
    }

    return columns;
  }

  // ------------------------------------------------------------------
  // Provenance
  // ------------------------------------------------------------------

  _attach_provenance(result, step, runtime_bindings) {
    const output = { ...result };

    output.step_id = step.step_id;
    output.source_id = step.source_id;
    output.query_step_type = step.step_type;
    output.inputs = Array.isArray(step.inputs) ? [...step.inputs] : [];
    output.dependencies = Array.isArray(step.depends_on) ? [...step.depends_on] : [];

    const bindings = runtime_bindings.bindings || [];

    output.runtime_bindings = {
      count: bindings.length,
      from_steps: bindings.map((b) => b.from_step),
      target_columns: bindings.map((b) => ({
        table: b.to_table,
        column: b.to_column,
        operator: b.operator,
      })),
    };

    return output;
  }
}

export default {
  QueryPlanExecutor,
};
