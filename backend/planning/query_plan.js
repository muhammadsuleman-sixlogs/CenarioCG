export const ALLOWED_STEP_TYPES = new Set([
  "source_query",
  "set_operation",
  "final_query",
]);

export const ALLOWED_SET_OPERATIONS = new Set([
  "intersect",
  "union",
  "union_all",
  "except",
  "distinct",
]);

export const ALLOWED_BINDING_OPERATORS = new Set([
  "in",
  "not_in",
  "equals",
]);

export const BINDING_OPERATOR_ALIASES = {
  "eq": "equals",
  "=": "equals",
  "==": "equals",
};

export function _normalize_binding_operator(operator) {
  if (typeof operator !== "string") {
    throw new Error("Input binding operator must be a string.");
  }

  let normalized = operator.trim().toLowerCase();
  normalized = BINDING_OPERATOR_ALIASES[normalized] || normalized;

  if (!ALLOWED_BINDING_OPERATORS.has(normalized)) {
    throw new Error(`Unsupported input binding operator: '${operator}'`);
  }

  return normalized;
}

export function _normalize_string_list(values, field_name) {
  if (values === null || values === undefined) {
    return [];
  }

  if (typeof values === "string") {
    values = [values];
  }

  if (!Array.isArray(values)) {
    return [];
  }

  const normalized = [];

  for (const value of values) {
    let item_str = "";
    if (typeof value === "string") {
      item_str = value.trim();
    } else if (typeof value === "number") {
      item_str = String(value).trim();
    } else {
      continue;
    }

    if (item_str) {
      normalized.push(item_str);
    }
  }

  return Array.from(new Set(normalized));
}

/**
 * Runtime dependency between two query steps.
 *
 * earlier_step.output_column -> current_step.to_table.to_column
 */
export class InputBinding {
  constructor(from_step_or_opts, from_column, to_table, to_column, operator = "in") {
    if (typeof from_step_or_opts === "object" && from_step_or_opts !== null) {
      const opts = from_step_or_opts;
      this.from_step = String(opts.from_step ?? "").trim();
      this.from_column = String(opts.from_column ?? "").trim();
      this.to_table = String(opts.to_table ?? "").trim();
      this.to_column = String(opts.to_column ?? "").trim();
      this.operator = _normalize_binding_operator(opts.operator ?? "in");
    } else {
      this.from_step = String(from_step_or_opts ?? "").trim();
      this.from_column = String(from_column ?? "").trim();
      this.to_table = String(to_table ?? "").trim();
      this.to_column = String(to_column ?? "").trim();
      this.operator = _normalize_binding_operator(operator ?? "in");
    }

    const fields = [
      ["from_step", this.from_step],
      ["from_column", this.from_column],
      ["to_table", this.to_table],
      ["to_column", this.to_column],
    ];

    for (const [name, value] of fields) {
      if (!value) {
        throw new Error(`Input binding ${name} must be a non-empty string.`);
      }
    }
  }

  to_dict() {
    return {
      from_step: this.from_step,
      from_column: this.from_column,
      to_table: this.to_table,
      to_column: this.to_column,
      operator: this.operator,
    };
  }

  toDict() {
    return this.to_dict();
  }

  static from_dict(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Input binding must be an object.");
    }

    const fields = {
      from_step: value.from_step,
      from_column: value.from_column,
      to_table: value.to_table,
      to_column: value.to_column,
    };

    for (const [fieldName, fieldValue] of Object.entries(fields)) {
      if (typeof fieldValue !== "string" || !fieldValue.trim()) {
        throw new Error(`Input binding ${fieldName} must be a non-empty string.`);
      }
    }

    const operator = value.operator !== undefined ? value.operator : "in";
    if (typeof operator !== "string" || !operator.trim()) {
      throw new Error("Input binding operator must be a non-empty string.");
    }

    return new InputBinding(
      fields.from_step.trim(),
      fields.from_column.trim(),
      fields.to_table.trim(),
      fields.to_column.trim(),
      operator.trim().toLowerCase()
    );
  }

  static fromDict(value) {
    return InputBinding.from_dict(value);
  }
}

/**
 * One node in the dependency-aware execution DAG.
 */
export class QueryStep {
  constructor(
    step_id_or_opts,
    step_type,
    source_id = null,
    contract = {},
    depends_on = [],
    inputs = [],
    input_bindings = [],
    operator = null,
    key_columns = [],
    output_columns = [],
    purpose = ""
  ) {
    let opts;
    if (typeof step_id_or_opts === "object" && step_id_or_opts !== null && !Array.isArray(step_id_or_opts)) {
      opts = step_id_or_opts;
      this.step_id = String(opts.step_id ?? opts.id ?? "").trim();
      this.step_type = String(opts.step_type ?? opts.type ?? "").trim();
      this.source_id = opts.source_id ?? null;
      this.contract = opts.contract ?? {};
      this.depends_on = opts.depends_on ?? [];
      this.inputs = opts.inputs ?? [];
      this.input_bindings = opts.input_bindings ?? [];
      this.operator = opts.operator ?? null;
      this.key_columns = opts.key_columns ?? [];
      this.output_columns = opts.output_columns ?? [];
      this.purpose = opts.purpose ?? "";
    } else {
      this.step_id = String(step_id_or_opts ?? "").trim();
      this.step_type = String(step_type ?? "").trim();
      this.source_id = source_id;
      this.contract = contract ?? {};
      this.depends_on = depends_on ?? [];
      this.inputs = inputs ?? [];
      this.input_bindings = input_bindings ?? [];
      this.operator = operator;
      this.key_columns = key_columns ?? [];
      this.output_columns = output_columns ?? [];
      this.purpose = purpose ?? "";
    }

    if (!this.step_id) {
      throw new Error("Query step id must be a non-empty string.");
    }

    if (!ALLOWED_STEP_TYPES.has(this.step_type)) {
      throw new Error(`Unsupported query step type: '${this.step_type}'`);
    }

    if (this.source_id !== null && this.source_id !== undefined) {
      if (typeof this.source_id !== "string" || !this.source_id.trim()) {
        throw new Error("source_id must be a non-empty string.");
      }
      this.source_id = this.source_id.trim().toLowerCase();
    } else {
      this.source_id = null;
    }

    if (!this.contract || typeof this.contract !== "object" || Array.isArray(this.contract)) {
      throw new Error("Query step contract must be an object.");
    }

    this.depends_on = _normalize_string_list(this.depends_on, "depends_on");
    this.inputs = _normalize_string_list(this.inputs, "inputs");
    this.key_columns = _normalize_string_list(this.key_columns, "key_columns");
    this.output_columns = _normalize_string_list(this.output_columns, "output_columns");

    const normalizedBindings = [];
    const rawBindings = Array.isArray(this.input_bindings) ? this.input_bindings : [];
    for (const binding of rawBindings) {
      if (binding instanceof InputBinding) {
        normalizedBindings.push(binding);
      } else if (binding && typeof binding === "object" && !Array.isArray(binding)) {
        normalizedBindings.push(InputBinding.from_dict(binding));
      } else {
        throw new Error("Query step input_bindings must contain InputBinding objects or objects.");
      }
    }
    this.input_bindings = normalizedBindings;

    if (this.operator !== null && this.operator !== undefined) {
      if (typeof this.operator !== "string" || !this.operator.trim()) {
        throw new Error("Query step operator must be a non-empty string.");
      }
      this.operator = this.operator.trim().toLowerCase();
    } else {
      this.operator = null;
    }

    this.purpose = String(this.purpose || "");
  }

  to_dict() {
    return {
      id: this.step_id,
      type: this.step_type,
      source_id: this.source_id,
      contract: this.contract,
      depends_on: [...this.depends_on],
      inputs: [...this.inputs],
      input_bindings: this.input_bindings.map(binding => binding.to_dict()),
      operator: this.operator,
      key_columns: [...this.key_columns],
      output_columns: [...this.output_columns],
      purpose: this.purpose,
    };
  }

  toDict() {
    return this.to_dict();
  }

  static from_dict(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Query step must be an object.");
    }

    const stepId = value.id;
    const stepType = value.type;

    if (typeof stepId !== "string" || !stepId.trim()) {
      throw new Error("Query step id must be a non-empty string.");
    }

    if (!ALLOWED_STEP_TYPES.has(stepType)) {
      throw new Error(`Unsupported query step type: '${stepType}'`);
    }

    let sourceId = value.source_id;
    if (sourceId !== null && sourceId !== undefined) {
      if (typeof sourceId !== "string" || !sourceId.trim()) {
        throw new Error("source_id must be a non-empty string.");
      }
      sourceId = sourceId.trim().toLowerCase();
    } else {
      sourceId = null;
    }

    const dependsOn = value.depends_on ?? [];
    const inputs = value.inputs ?? [];
    const rawBindings = value.input_bindings ?? [];
    const keyColumns = value.key_columns ?? [];
    const outputColumns = value.output_columns ?? [];

    for (const [fieldName, fieldValue] of [
      ["depends_on", dependsOn],
      ["inputs", inputs],
      ["key_columns", keyColumns],
      ["output_columns", outputColumns],
    ]) {
      if (!Array.isArray(fieldValue) || !fieldValue.every(item => typeof item === "string" && item.trim())) {
        throw new Error(`Query step ${fieldName} must be a list of strings.`);
      }
    }

    if (!Array.isArray(rawBindings)) {
      throw new Error("Query step input_bindings must be a list.");
    }

    const inputBindings = rawBindings.map(item => InputBinding.from_dict(item));

    let operator = value.operator;
    if (operator !== null && operator !== undefined) {
      if (typeof operator !== "string" || !operator.trim()) {
        throw new Error("Query step operator must be a non-empty string.");
      }
      operator = operator.trim().toLowerCase();
    } else {
      operator = null;
    }

    const contract = value.contract ?? {};
    if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
      throw new Error("Query step contract must be an object.");
    }

    return new QueryStep(
      stepId.trim(),
      stepType,
      sourceId,
      contract,
      dependsOn.map(item => item.trim()),
      inputs.map(item => item.trim()),
      inputBindings,
      operator,
      keyColumns.map(item => item.trim()),
      outputColumns.map(item => item.trim()),
      String(value.purpose || "")
    );
  }

  static fromDict(value) {
    return QueryStep.from_dict(value);
  }
}

/**
 * Dependency-aware execution plan.
 */
export class QueryPlan {
  constructor(mode_or_opts, steps, final_step, reason = "") {
    if (typeof mode_or_opts === "object" && mode_or_opts !== null && !Array.isArray(mode_or_opts)) {
      const opts = mode_or_opts;
      this.mode = opts.mode;
      this.steps = opts.steps;
      this.final_step = opts.final_step;
      this.reason = opts.reason ?? "";
    } else {
      this.mode = mode_or_opts;
      this.steps = steps;
      this.final_step = final_step;
      this.reason = reason ?? "";
    }
  }

  to_dict() {
    return {
      mode: this.mode,
      steps: this.steps.map(step => step.to_dict()),
      final_step: this.final_step,
      reason: this.reason,
    };
  }

  toDict() {
    return this.to_dict();
  }

  static from_dict(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Query plan must be an object.");
    }

    const mode = value.mode !== undefined ? value.mode : "single";
    if (mode !== "single" && mode !== "multi_step") {
      throw new Error(`Unsupported query plan mode: '${mode}'`);
    }

    const rawSteps = value.steps ?? [];
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
      throw new Error("Query plan must contain at least one step.");
    }

    const steps = rawSteps.map(item => QueryStep.from_dict(item));

    const finalStep = value.final_step;
    if (typeof finalStep !== "string" || !finalStep.trim()) {
      throw new Error("Query plan final_step must be a non-empty string.");
    }

    const plan = new QueryPlan(
      mode,
      steps,
      finalStep.trim(),
      String(value.reason || "")
    );

    validate_query_plan(plan);
    return plan;
  }

  static fromDict(value) {
    return QueryPlan.from_dict(value);
  }

  static from_legacy_plan(plan, sourceId) {
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
      throw new Error("Legacy retrieval plan must be an object.");
    }

    if (typeof sourceId !== "string" || !sourceId.trim()) {
      throw new Error("source_id must be a non-empty string.");
    }

    const normalizedSource = sourceId.trim().toLowerCase();

    const step = new QueryStep(
      "s1",
      "final_query",
      normalizedSource,
      plan,
      [],
      [],
      [],
      null,
      [],
      Array.isArray(plan.required_columns) ? [...plan.required_columns] : [],
      "Execute the validated retrieval contract."
    );

    const result = new QueryPlan(
      "single",
      [step],
      "s1",
      "Legacy single-source retrieval plan."
    );

    validate_query_plan(result);
    return result;
  }

  static fromLegacyPlan(plan, sourceId) {
    return QueryPlan.from_legacy_plan(plan, sourceId);
  }
}

/**
 * Validate execution-plan structure only.
 */
export function validate_query_plan(plan) {
  if (!(plan instanceof QueryPlan)) {
    throw new Error("plan must be a QueryPlan instance.");
  }

  if (plan.mode !== "single" && plan.mode !== "multi_step") {
    throw new Error(`Unsupported query plan mode: '${plan.mode}'`);
  }

  if (!plan.steps || plan.steps.length === 0) {
    throw new Error("Query plan must contain at least one step.");
  }

  const stepIds = plan.steps.map(step => step.step_id);

  if (stepIds.some(stepId => !stepId.trim())) {
    throw new Error("Query plan contains an empty step ID.");
  }

  if (stepIds.length !== new Set(stepIds).size) {
    throw new Error("Query plan contains duplicate step IDs.");
  }

  const stepMap = {};
  for (const step of plan.steps) {
    stepMap[step.step_id] = step;
  }

  if (!(plan.final_step in stepMap)) {
    throw new Error(`Final step '${plan.final_step}' does not exist.`);
  }

  for (const step of plan.steps) {
    _validate_step_dependencies(step, stepMap);
    _validate_step_bindings(step, stepMap);
    _validate_step_type_constraints(step);
  }

  _assert_acyclic(stepMap);
}

export function validateQueryPlan(plan) {
  return validate_query_plan(plan);
}

export function _validate_step_dependencies(step, stepMap) {
  if (step.depends_on.includes(step.step_id)) {
    throw new Error(`Step '${step.step_id}' cannot depend on itself.`);
  }

  if (step.inputs.includes(step.step_id)) {
    throw new Error(`Step '${step.step_id}' cannot reference itself as an input.`);
  }

  const unknownDependencies = step.depends_on.filter(dep => !(dep in stepMap));
  if (unknownDependencies.length > 0) {
    unknownDependencies.sort();
    throw new Error(
      `Step '${step.step_id}' references unknown dependency(ies): [${unknownDependencies.map(d => `'${d}'`).join(", ")}]`
    );
  }

  const unknownInputs = step.inputs.filter(inp => !(inp in stepMap));
  if (unknownInputs.length > 0) {
    unknownInputs.sort();
    throw new Error(
      `Step '${step.step_id}' references unknown input(s): [${unknownInputs.map(i => `'${i}'`).join(", ")}]`
    );
  }
}

export function _validate_step_bindings(step, stepMap) {
  if (step.step_type !== "source_query" && step.step_type !== "final_query") {
    if (step.input_bindings.length > 0) {
      throw new Error(`Step '${step.step_id}' of type '${step.step_type}' cannot contain input_bindings.`);
    }
    return;
  }

  for (const binding of step.input_bindings) {
    if (binding.from_step === step.step_id) {
      throw new Error(`Step '${step.step_id}' cannot bind from itself.`);
    }

    if (!(binding.from_step in stepMap)) {
      throw new Error(`Step '${step.step_id}' binding references unknown from_step '${binding.from_step}'.`);
    }

    if (!step.depends_on.includes(binding.from_step)) {
      throw new Error(`Step '${step.step_id}' binding source '${binding.from_step}' must also appear in depends_on.`);
    }

    const sourceStep = stepMap[binding.from_step];
    _validate_binding_output_reference(step, binding, sourceStep);
  }
}

export function _validate_binding_output_reference(step, binding, sourceStep) {
  const declaredOutputs = new Set(sourceStep.output_columns);
  const declaredKeys = new Set(sourceStep.key_columns);

  if (declaredOutputs.size === 0 && declaredKeys.size === 0) {
    return;
  }

  if (!declaredOutputs.has(binding.from_column) && !declaredKeys.has(binding.from_column)) {
    throw new Error(
      `Step '${step.step_id}' binding expects column '${binding.from_column}' from step '${sourceStep.step_id}', but that column is not declared in the source step output_columns or key_columns.`
    );
  }
}

export function _validate_step_type_constraints(step) {
  if (step.step_type === "source_query" || step.step_type === "final_query") {
    if (!step.source_id) {
      throw new Error(`Source query step '${step.step_id}' requires source_id.`);
    }
  }

  if (step.step_type === "set_operation") {
    if (step.source_id !== null && step.source_id !== undefined) {
      throw new Error(`Set operation step '${step.step_id}' must not declare source_id.`);
    }

    if (!ALLOWED_SET_OPERATIONS.has(step.operator)) {
      throw new Error(`Unsupported set operator on step '${step.step_id}': '${step.operator}'`);
    }

    if (["intersect", "union", "union_all", "except"].includes(step.operator)) {
      if (step.inputs.length < 2) {
        throw new Error(`Set operation '${step.step_id}' requires at least two inputs.`);
      }
    } else if (step.operator === "distinct") {
      if (step.inputs.length !== 1) {
        throw new Error(`Distinct operation '${step.step_id}' requires exactly one input.`);
      }
    }

    if (step.depends_on.length > 0) {
      const missingInputs = step.inputs.filter(inp => !step.depends_on.includes(inp));
      if (missingInputs.length > 0) {
        missingInputs.sort();
        throw new Error(
          `Set operation step '${step.step_id}' has inputs not represented in depends_on: [${missingInputs.map(i => `'${i}'`).join(", ")}]`
        );
      }
    }
  }
}

export function _assert_acyclic(stepMap) {
  const visiting = new Set();
  const visited = new Set();

  function visit(stepId) {
    if (visiting.has(stepId)) {
      throw new Error("Query plan contains a dependency cycle.");
    }

    if (visited.has(stepId)) {
      return;
    }

    visiting.add(stepId);

    const step = stepMap[stepId];
    const dependencies = [...step.depends_on, ...step.inputs];

    for (const dependency of dependencies) {
      visit(dependency);
    }

    visiting.delete(stepId);
    visited.add(stepId);
  }

  for (const stepId of Object.keys(stepMap)) {
    visit(stepId);
  }
}

export function execution_order(plan) {
  validate_query_plan(plan);

  const stepMap = {};
  for (const step of plan.steps) {
    stepMap[step.step_id] = step;
  }

  const pending = new Set(Object.keys(stepMap));
  const result = [];

  while (pending.size > 0) {
    const ready = Array.from(pending)
      .sort()
      .map(stepId => stepMap[stepId])
      .filter(step => {
        const deps = _all_step_dependencies(step);
        return deps.every(dep => !pending.has(dep));
      });

    if (ready.length === 0) {
      throw new Error("Unable to resolve query-plan execution order.");
    }

    for (const step of ready) {
      result.push(step);
      pending.delete(step.step_id);
    }
  }

  return result;
}

export function executionOrder(plan) {
  return execution_order(plan);
}

export function execution_layers(plan) {
  validate_query_plan(plan);

  const stepMap = {};
  for (const step of plan.steps) {
    stepMap[step.step_id] = step;
  }

  const remaining = new Set(Object.keys(stepMap));
  const completed = new Set();
  const layers = [];

  while (remaining.size > 0) {
    const ready = Array.from(remaining)
      .sort()
      .map(stepId => stepMap[stepId])
      .filter(step => {
        const deps = _all_step_dependencies(step);
        return deps.every(dep => completed.has(dep));
      });

    if (ready.length === 0) {
      throw new Error("Unable to resolve query-plan execution layers.");
    }

    layers.push(ready);

    for (const step of ready) {
      completed.add(step.step_id);
      remaining.delete(step.step_id);
    }
  }

  return layers;
}

export function executionLayers(plan) {
  return execution_layers(plan);
}

export function binding_dependencies(plan) {
  validate_query_plan(plan);

  const result = [];
  for (const step of plan.steps) {
    for (const binding of step.input_bindings) {
      result.push([binding.from_step, step.step_id]);
    }
  }

  return result;
}

export function bindingDependencies(plan) {
  return binding_dependencies(plan);
}

export function get_step(plan, stepId) {
  validate_query_plan(plan);

  if (typeof stepId !== "string" || !stepId.trim()) {
    throw new Error("step_id must be a non-empty string.");
  }

  const targetId = stepId.trim();
  for (const step of plan.steps) {
    if (step.step_id === targetId) {
      return step;
    }
  }

  throw new Error(`Query plan step '${stepId}' does not exist.`);
}

export function getStep(plan, stepId) {
  return get_step(plan, stepId);
}

export function _all_step_dependencies(step) {
  return Array.from(new Set([...step.depends_on, ...step.inputs]));
}

export default {
  ALLOWED_STEP_TYPES,
  ALLOWED_SET_OPERATIONS,
  ALLOWED_BINDING_OPERATORS,
  BINDING_OPERATOR_ALIASES,
  InputBinding,
  QueryStep,
  QueryPlan,
  validate_query_plan,
  validateQueryPlan,
  execution_order,
  executionOrder,
  execution_layers,
  executionLayers,
  binding_dependencies,
  bindingDependencies,
  get_step,
  getStep,
};
