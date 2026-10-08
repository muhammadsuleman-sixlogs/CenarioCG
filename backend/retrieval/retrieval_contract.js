function deepcopy(obj) {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => deepcopy(item));
  }
  const copy = {};
  for (const key of Object.keys(obj)) {
    copy[key] = deepcopy(obj[key]);
  }
  return copy;
}

export const ALLOWED_DATA_SOURCES = new Set([
  "postgresql",
  "security_logs",
]);

export const OPERATION_ALIASES = {
  lookup: "lookup",
  count: "count",
  sum: "sum",
  average: "average",
  avg: "average",
  mean: "average",
  minimum: "minimum",
  min: "minimum",
  maximum: "maximum",
  max: "maximum",
  comparison: "comparison",
  ranking: "ranking",
  grouping: "grouping",
  aggregation: "aggregation",
  general: "general",
};

export const FILTER_OPERATOR_ALIASES = {
  eq: "=",
  equals: "=",
  "==": "=",
};

export class RetrievalContract {
  static ALLOWED_DATA_SOURCES = ALLOWED_DATA_SOURCES;
  static OPERATION_ALIASES = OPERATION_ALIASES;
  static FILTER_OPERATOR_ALIASES = FILTER_OPERATOR_ALIASES;

  constructor(
    questionOrParams,
    required_tables,
    postgresql_sources = null,
    required_columns = null,
    relationships = null,
    filters = null,
    operations = null,
    grouping = null,
    sorting = null,
    limit = null,
    entities = null,
    needs_conversation_context = false,
    data_sources = null,
    requested_metrics = null,
    source_id = null
  ) {
    let question;

    if (
      typeof questionOrParams === "object" &&
      questionOrParams !== null &&
      !Array.isArray(questionOrParams) &&
      required_tables === undefined
    ) {
      // Called with options object
      const p = questionOrParams;
      question = p.question;
      required_tables = p.required_tables;
      postgresql_sources = p.postgresql_sources !== undefined ? p.postgresql_sources : null;
      required_columns = p.required_columns !== undefined ? p.required_columns : null;
      relationships = p.relationships !== undefined ? p.relationships : null;
      filters = p.filters !== undefined ? p.filters : null;
      operations = p.operations !== undefined ? p.operations : null;
      grouping = p.grouping !== undefined ? p.grouping : null;
      sorting = p.sorting !== undefined ? p.sorting : null;
      limit = p.limit !== undefined ? p.limit : null;
      entities = p.entities !== undefined ? p.entities : null;
      needs_conversation_context = p.needs_conversation_context !== undefined ? p.needs_conversation_context : false;
      data_sources = p.data_sources !== undefined ? p.data_sources : null;
      requested_metrics = p.requested_metrics !== undefined ? p.requested_metrics : null;
      source_id = p.source_id !== undefined ? p.source_id : null;
    } else {
      question = questionOrParams;
    }

    if (typeof question !== "string" || !question.trim()) {
      throw new Error("Question cannot be empty.");
    }

    if (!Array.isArray(required_tables)) {
      throw new Error("required_tables must be a list.");
    }

    if (!required_tables.every(item => typeof item === "string" && item.trim())) {
      throw new Error("required_tables must contain non-empty strings.");
    }

    if (required_columns === null || required_columns === undefined) {
      required_columns = [];
    }

    if (!Array.isArray(required_columns)) {
      throw new Error("required_columns must be a list.");
    }

    if (!required_columns.every(item => typeof item === "string" && item.trim())) {
      throw new Error("required_columns must contain non-empty strings.");
    }

    if (relationships === null || relationships === undefined) {
      relationships = [];
    }

    if (!Array.isArray(relationships)) {
      throw new Error("relationships must be a list.");
    }

    if (filters === null || filters === undefined) {
      filters = [];
    }

    if (!Array.isArray(filters)) {
      throw new Error("filters must be a list.");
    }

    if (operations === null || operations === undefined) {
      operations = [];
    }

    if (!Array.isArray(operations)) {
      throw new Error("operations must be a list.");
    }

    if (!operations.every(item => typeof item === "string" && item.trim())) {
      throw new Error("operations must contain non-empty strings.");
    }

    if (grouping === null || grouping === undefined) {
      grouping = [];
    }

    if (!Array.isArray(grouping)) {
      throw new Error("grouping must be a list.");
    }

    if (!grouping.every(item => typeof item === "string" && item.trim())) {
      throw new Error("grouping must contain non-empty strings.");
    }

    if (sorting === null || sorting === undefined) {
      sorting = [];
    }

    if (!Array.isArray(sorting)) {
      throw new Error("sorting must be a list.");
    }

    if (limit !== null && limit !== undefined) {
      if (typeof limit === "boolean" || typeof limit !== "number" || !Number.isInteger(limit)) {
        throw new Error("limit must be an integer.");
      }
      if (limit < 1) {
        throw new Error("limit must be greater than 0.");
      }
    } else {
      limit = null;
    }

    if (entities === null || entities === undefined) {
      entities = [];
    }

    if (!Array.isArray(entities)) {
      throw new Error("entities must be a list.");
    }

    if (requested_metrics === null || requested_metrics === undefined) {
      requested_metrics = [];
    }

    if (!Array.isArray(requested_metrics)) {
      throw new Error("requested_metrics must be a list.");
    }

    if (data_sources === null || data_sources === undefined) {
      data_sources = ["postgresql"];
    }

    if (!Array.isArray(data_sources)) {
      throw new Error("data_sources must be a list.");
    }

    const normalizedDataSources = RetrievalContract._normalize_data_sources(data_sources);
    if (!normalizedDataSources.length) {
      throw new Error("At least one data source is required.");
    }

    if (postgresql_sources === null || postgresql_sources === undefined) {
      postgresql_sources = [];
    }

    if (!Array.isArray(postgresql_sources)) {
      throw new Error("postgresql_sources must be a list.");
    }

    let normalizedPostgresqlSources = RetrievalContract._normalize_source_ids(postgresql_sources);
    let normalizedSourceId = null;

    if (source_id !== null && source_id !== undefined) {
      if (typeof source_id !== "string" || !source_id.trim()) {
        throw new Error("source_id must be a non-empty string.");
      }
      normalizedSourceId = source_id.trim().toLowerCase();

      if (normalizedDataSources.length === 1 && normalizedDataSources[0] === "postgresql") {
        if (
          normalizedPostgresqlSources.length > 0 &&
          !normalizedPostgresqlSources.includes(normalizedSourceId)
        ) {
          throw new Error(
            "source_id must be one of postgresql_sources for a PostgreSQL retrieval contract."
          );
        }

        if (!normalizedPostgresqlSources.length) {
          normalizedPostgresqlSources = [normalizedSourceId];
        }
      }
    }

    this.question = question.trim();
    this.source_id = normalizedSourceId;
    this.data_sources = normalizedDataSources;
    this.postgresql_sources = normalizedPostgresqlSources;
    this.required_tables = RetrievalContract._unique_strings(required_tables);
    this.required_columns = RetrievalContract._unique_strings(required_columns);
    this.relationships = deepcopy(relationships);
    this.filters = deepcopy(filters);
    this.operations = RetrievalContract._normalize_operations(operations);
    this.grouping = RetrievalContract._unique_strings(grouping);
    this.sorting = deepcopy(sorting);
    this.limit = limit;
    this.entities = deepcopy(entities);
    this.needs_conversation_context = Boolean(needs_conversation_context);
    this.requested_metrics = RetrievalContract._normalize_requested_metrics(requested_metrics);
  }

  static _normalize_data_sources(dataSources) {
    const normalized = [];

    for (const source of dataSources) {
      if (typeof source !== "string") {
        throw new Error("data_sources must contain strings.");
      }

      const value = source.trim().toLowerCase();
      if (!value) {
        throw new Error("data_sources must contain non-empty strings.");
      }

      if (!ALLOWED_DATA_SOURCES.has(value)) {
        const sortedAllowed = Array.from(ALLOWED_DATA_SOURCES).sort();
        throw new Error(
          `Unsupported data source: '${value}'. Allowed sources: [${sortedAllowed.map(s => `'${s}'`).join(", ")}]`
        );
      }

      if (!normalized.includes(value)) {
        normalized.push(value);
      }
    }

    return normalized;
  }

  _normalizeDataSources(dataSources) {
    return RetrievalContract._normalize_data_sources(dataSources);
  }

  static _normalize_source_ids(sourceIds) {
    const normalized = [];

    for (const sourceId of sourceIds) {
      if (typeof sourceId !== "string" || !sourceId.trim()) {
        throw new Error("postgresql_sources must contain non-empty strings.");
      }
      const val = sourceId.trim().toLowerCase();
      if (!normalized.includes(val)) {
        normalized.push(val);
      }
    }

    return normalized;
  }

  _normalizeSourceIds(sourceIds) {
    return RetrievalContract._normalize_source_ids(sourceIds);
  }

  static _normalize_operations(operations) {
    const normalized = [];

    for (const operation of operations) {
      let value = operation.trim().toLowerCase();
      value = OPERATION_ALIASES[value] || value;
      if (!normalized.includes(value)) {
        normalized.push(value);
      }
    }

    return normalized;
  }

  _normalizeOperations(operations) {
    return RetrievalContract._normalize_operations(operations);
  }

  static _normalize_filter(filterValue) {
    if (!filterValue || typeof filterValue !== "object" || Array.isArray(filterValue)) {
      return deepcopy(filterValue);
    }

    const normalized = deepcopy(filterValue);
    const operator = normalized.operator;

    if (typeof operator === "string") {
      const op = operator.trim().toLowerCase();
      normalized.operator = FILTER_OPERATOR_ALIASES[op] || op;
    }

    return normalized;
  }

  _normalizeFilter(filterValue) {
    return RetrievalContract._normalize_filter(filterValue);
  }

  static _normalize_requested_metrics(metrics) {
    const normalized = [];

    for (const metric of metrics) {
      if (!metric || typeof metric !== "object" || Array.isArray(metric)) {
        throw new Error("Each requested metric must be an object.");
      }

      const item = deepcopy(metric);
      const operation = item.operation;

      if (typeof operation === "string") {
        const op = operation.trim().toLowerCase();
        item.operation = OPERATION_ALIASES[op] || op;
      }

      const sourceId = item.source_id;
      if (sourceId !== null && sourceId !== undefined) {
        if (typeof sourceId !== "string" || !sourceId.trim()) {
          throw new Error("requested_metrics source_id must be a non-empty string.");
        }
        item.source_id = sourceId.trim().toLowerCase();
      }

      normalized.push(item);
    }

    return normalized;
  }

  _normalizeRequestedMetrics(metrics) {
    return RetrievalContract._normalize_requested_metrics(metrics);
  }

  static _unique_strings(values) {
    const result = [];
    for (const item of values) {
      const str = String(item).trim();
      if (!result.includes(str)) {
        result.push(str);
      }
    }
    return result;
  }

  _uniqueStrings(values) {
    return RetrievalContract._unique_strings(values);
  }

  normalized_filters() {
    return this.filters.map(value => RetrievalContract._normalize_filter(value));
  }

  normalizedFilters() {
    return this.normalized_filters();
  }

  to_dict() {
    return {
      question: this.question,
      source_id: this.source_id,
      data_sources: [...this.data_sources],
      postgresql_sources: [...this.postgresql_sources],
      required_tables: [...this.required_tables],
      required_columns: [...this.required_columns],
      relationships: deepcopy(this.relationships),
      filters: this.normalized_filters(),
      operations: [...this.operations],
      grouping: [...this.grouping],
      sorting: deepcopy(this.sorting),
      limit: this.limit,
      entities: deepcopy(this.entities),
      needs_conversation_context: this.needs_conversation_context,
      requested_metrics: deepcopy(this.requested_metrics),
    };
  }

  toDict() {
    return this.to_dict();
  }

  static from_plan(plan, sourceId = null) {
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
      throw new Error("Question plan must be a dictionary.");
    }

    let resolvedSourceId = sourceId;
    if (resolvedSourceId === null || resolvedSourceId === undefined) {
      const candidate = plan.source_id;
      if (typeof candidate === "string") {
        resolvedSourceId = candidate;
      }
    }

    return new RetrievalContract({
      question: plan.question || "",
      source_id: resolvedSourceId,
      postgresql_sources: plan.postgresql_sources || [],
      data_sources: plan.data_sources || ["postgresql"],
      required_tables: plan.required_tables || [],
      required_columns: plan.required_columns || [],
      relationships: plan.relationships || [],
      filters: plan.filters || [],
      operations: plan.operations || [],
      grouping: plan.grouping || [],
      sorting: plan.sorting || [],
      limit: plan.limit !== undefined ? plan.limit : null,
      entities: plan.entities || [],
      needs_conversation_context: Boolean(plan.needs_conversation_context),
      requested_metrics: plan.requested_metrics || [],
    });
  }

  static fromPlan(plan, sourceId = null) {
    return RetrievalContract.from_plan(plan, sourceId);
  }
}

export function create_retrieval_contract(validatedPlan, sourceId = null) {
  if (!validatedPlan || typeof validatedPlan !== "object" || Array.isArray(validatedPlan)) {
    throw new Error("Validated question plan must be a dictionary.");
  }
  return RetrievalContract.from_plan(validatedPlan, sourceId);
}

export function createRetrievalContract(validatedPlan, sourceId = null) {
  return create_retrieval_contract(validatedPlan, sourceId);
}

export default {
  RetrievalContract,
  create_retrieval_contract,
  createRetrievalContract,
  ALLOWED_DATA_SOURCES,
  OPERATION_ALIASES,
  FILTER_OPERATOR_ALIASES,
};
