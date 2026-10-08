import { loadAllContexts } from "../context/context_store.js";

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

export class QuestionPlanValidator {
  /**
   * Deterministically validate and canonicalize a QuestionPlanner plan
   * against the dynamically discovered Context Layer.
   */

  static ALLOWED_DATA_SOURCES = new Set([
    "postgresql",
    "security_logs",
  ]);

  static ALLOWED_OPERATIONS = new Set([
    "lookup",
    "filter",
    "count",
    "sum",
    "average",
    "minimum",
    "maximum",
    "comparison",
    "ranking",
    "grouping",
    "aggregation",
    "general",
  ]);

  static ALLOWED_FILTER_OPERATORS = new Set([
    "=",
    "!=",
    "<>",
    ">",
    ">=",
    "<",
    "<=",
    "in",
    "not_in",
    "contains",
    "starts_with",
    "ends_with",
    "is_null",
    "is_not_null",
  ]);

  static ALLOWED_SORT_DIRECTIONS = new Set([
    "asc",
    "desc",
  ]);

  static ALLOWED_SECURITY_RESOURCES = new Set([
    "security_logs",
    "cli_audit_logs",
    "security_logs_summary",
    "workspace_security_logs",
    "workspace_siem_status",
    "security_overview",
  ]);

  static ALLOWED_EXECUTION_STEP_TYPES = new Set([
    "source_query",
    "final_query",
    "set_operation",
  ]);

  static ALLOWED_SET_OPERATIONS = new Set([
    "intersect",
    "union",
    "union_all",
    "except",
    "distinct",
  ]);

  static ALLOWED_BINDING_OPERATORS = new Set([
    "in",
    "not_in",
    "equals",
  ]);

  static MAX_EXECUTION_STEPS = 16;
  static MAX_DEPENDENCY_DEPTH = 16;
  static MAX_RUNTIME_BINDINGS = 64;

  constructor(context = null) {
    this.ALLOWED_DATA_SOURCES = QuestionPlanValidator.ALLOWED_DATA_SOURCES;
    this.ALLOWED_OPERATIONS = QuestionPlanValidator.ALLOWED_OPERATIONS;
    this.ALLOWED_FILTER_OPERATORS = QuestionPlanValidator.ALLOWED_FILTER_OPERATORS;
    this.ALLOWED_SORT_DIRECTIONS = QuestionPlanValidator.ALLOWED_SORT_DIRECTIONS;
    this.ALLOWED_SECURITY_RESOURCES = QuestionPlanValidator.ALLOWED_SECURITY_RESOURCES;
    this.ALLOWED_EXECUTION_STEP_TYPES = QuestionPlanValidator.ALLOWED_EXECUTION_STEP_TYPES;
    this.ALLOWED_SET_OPERATIONS = QuestionPlanValidator.ALLOWED_SET_OPERATIONS;
    this.ALLOWED_BINDING_OPERATORS = QuestionPlanValidator.ALLOWED_BINDING_OPERATORS;
    this.MAX_EXECUTION_STEPS = QuestionPlanValidator.MAX_EXECUTION_STEPS;
    this.MAX_DEPENDENCY_DEPTH = QuestionPlanValidator.MAX_DEPENDENCY_DEPTH;
    this.MAX_RUNTIME_BINDINGS = QuestionPlanValidator.MAX_RUNTIME_BINDINGS;

    if (context !== null && context !== undefined) {
      if (context.tables !== undefined) {
        const sourceId = String(context.source_id || "db1").trim().toLowerCase() || "db1";
        this.contexts = {
          [sourceId]: context,
        };
      } else {
        this.contexts = context;
      }
    } else {
      this.contexts = loadAllContexts();
    }

    if (!this.contexts || typeof this.contexts !== "object" || Array.isArray(this.contexts)) {
      throw new Error("Context Layer sources must be a dictionary.");
    }

    if (Object.keys(this.contexts).length === 0) {
      throw new Error("No PostgreSQL Context Layer sources are available.");
    }
  }

  // ------------------------------------------------------------------
  // Context helpers
  // ------------------------------------------------------------------

  _available_postgresql_sources() {
    return Object.keys(this.contexts).map(sourceId => String(sourceId).trim().toLowerCase());
  }

  _availablePostgresqlSources() {
    return this._available_postgresql_sources();
  }

  _get_source_context(sourceId) {
    const context = this.contexts[sourceId] || {};
    return typeof context === "object" && !Array.isArray(context) ? context : {};
  }

  _getSourceContext(sourceId) {
    return this._get_source_context(sourceId);
  }

  static _find_key_ci(mapping, requested) {
    const target = String(requested).trim().toLowerCase();
    for (const key of Object.keys(mapping)) {
      if (String(key).trim().toLowerCase() === target) {
        return String(key);
      }
    }
    return null;
  }

  _find_key_ci(mapping, requested) {
    return QuestionPlanValidator._find_key_ci(mapping, requested);
  }

  _findKeyCi(mapping, requested) {
    return QuestionPlanValidator._find_key_ci(mapping, requested);
  }

  _known_tables(sourceIds = null) {
    const sourceList = sourceIds || this._available_postgresql_sources();
    const result = new Set();

    for (const sourceId of sourceList) {
      const tables = this._get_source_context(sourceId).tables || {};
      if (typeof tables === "object" && !Array.isArray(tables)) {
        for (const name of Object.keys(tables)) {
          result.add(String(name));
        }
      }
    }

    return result;
  }

  _knownTables(sourceIds = null) {
    return this._known_tables(sourceIds);
  }

  _known_columns(sourceIds = null) {
    const sourceList = sourceIds || this._available_postgresql_sources();
    const result = {};

    for (const sourceId of sourceList) {
      const tables = this._get_source_context(sourceId).tables || {};
      if (!tables || typeof tables !== "object" || Array.isArray(tables)) {
        continue;
      }

      for (const [tableNameRaw, tableInfo] of Object.entries(tables)) {
        if (!tableInfo || typeof tableInfo !== "object" || Array.isArray(tableInfo)) {
          continue;
        }

        const tableName = String(tableNameRaw);
        if (!result[tableName]) {
          result[tableName] = new Set();
        }

        const columns = tableInfo.columns || [];

        if (typeof columns === "object" && !Array.isArray(columns)) {
          for (const name of Object.keys(columns)) {
            result[tableName].add(String(name));
          }
          continue;
        }

        if (!Array.isArray(columns)) {
          continue;
        }

        for (const column of columns) {
          if (typeof column === "string") {
            result[tableName].add(column);
          } else if (column && typeof column === "object") {
            const name = column.name || column.column || column.column_name;
            if (name) {
              result[tableName].add(String(name));
            }
          }
        }
      }
    }

    return result;
  }

  _knownColumns(sourceIds = null) {
    return this._known_columns(sourceIds);
  }

  _known_relationships(sourceIds = null) {
    const sourceList = sourceIds || this._available_postgresql_sources();
    const result = [];

    for (const sourceId of sourceList) {
      const context = this._get_source_context(sourceId);

      for (const fieldName of ["relationships", "business_relationships"]) {
        const relationships = context[fieldName] || [];
        if (!Array.isArray(relationships)) {
          continue;
        }

        for (const relationship of relationships) {
          if (!relationship || typeof relationship !== "object" || Array.isArray(relationship)) {
            continue;
          }

          const item = { ...relationship };
          if (item.source_id === undefined) {
            item.source_id = sourceId;
          }
          result.push(item);
        }
      }
    }

    return result;
  }

  _knownRelationships(sourceIds = null) {
    return this._known_relationships(sourceIds);
  }

  // ------------------------------------------------------------------
  // Canonical normalization
  // ------------------------------------------------------------------

  static _canonical_required_column(value) {
    if (typeof value === "string") {
      return value.trim();
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }

    const table = String(value.table || value.table_name || "").trim();
    const column = String(value.column || value.column_name || "").trim();

    if (table && column) {
      return `${table}.${column}`;
    }

    return value;
  }

  _canonical_required_column(value) {
    return QuestionPlanValidator._canonical_required_column(value);
  }

  _canonicalRequiredColumn(value) {
    return QuestionPlanValidator._canonical_required_column(value);
  }

  _canonicalize_plan(plan) {
    const normalized = deepcopy(plan);

    normalized.data_sources = this._canonical_string_list(
      normalized.data_sources ?? ["postgresql"]
    );
    normalized.postgresql_sources = this._canonical_string_list(
      normalized.postgresql_sources ?? []
    );
    normalized.required_tables = this._canonical_string_list(
      normalized.required_tables ?? []
    );
    normalized.required_columns = this._canonical_columns(
      normalized.required_columns ?? [],
      normalized.postgresql_sources,
      normalized.required_tables
    );
    normalized.relationships = this._canonical_relationships(
      normalized.relationships ?? [],
      normalized.postgresql_sources
    );
    normalized.filters = this._canonical_filters(
      normalized.filters ?? [],
      normalized.postgresql_sources,
      normalized.required_tables
    );
    normalized.operations = this._canonical_string_list(
      normalized.operations ?? []
    );
    normalized.grouping = this._canonical_grouping(
      normalized.grouping ?? [],
      normalized.postgresql_sources,
      normalized.required_tables
    );
    normalized.sorting = this._canonical_sorting(
      normalized.sorting ?? [],
      normalized.postgresql_sources,
      normalized.required_tables
    );
    normalized.entities = this._canonical_entities(
      normalized.entities ?? []
    );

    const executionPlan = normalized.execution_plan;
    if (executionPlan && typeof executionPlan === "object" && !Array.isArray(executionPlan)) {
      normalized.execution_plan = this._canonicalize_execution_plan(
        executionPlan,
        normalized
      );
    } else if (executionPlan === null || executionPlan === undefined) {
      if (Array.isArray(normalized.postgresql_sources) && normalized.postgresql_sources.length > 0) {
        const sourceId = String(normalized.postgresql_sources[0]).trim().toLowerCase() || "db1";
        normalized.execution_plan = {
          mode: "single",
          steps: [
            {
              id: "s1",
              type: "source_query",
              source_id: sourceId,
              contract: deepcopy(normalized),
              depends_on: [],
              inputs: [],
              input_bindings: [],
              key_columns: [],
              output_columns: deepcopy(normalized.required_columns ?? []),
              purpose: normalized.question || "Single step query execution",
            },
          ],
          final_step: "s1",
        };
      }
    }

    return normalized;
  }

  _canonicalizePlan(plan) {
    return this._canonicalize_plan(plan);
  }

  _canonicalize_execution_plan(executionPlan, topLevelPlan = null) {
    const normalized = deepcopy(executionPlan);

    let rawSteps = normalized.steps;
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
      const mode = String(normalized.mode || "single").trim().toLowerCase();
      if (mode === "single" && topLevelPlan) {
        let sourceId = "db1";
        const pgSources = topLevelPlan.postgresql_sources ?? [];
        if (Array.isArray(pgSources) && pgSources.length > 0) {
          sourceId = String(pgSources[0]).trim().toLowerCase();
        }

        rawSteps = [
          {
            id: "s1",
            type: "source_query",
            source_id: sourceId,
            contract: deepcopy(topLevelPlan),
            depends_on: [],
            inputs: [],
            input_bindings: [],
            key_columns: [],
            output_columns: deepcopy(topLevelPlan.required_columns ?? []),
            purpose: topLevelPlan.question || "Single step query execution",
          },
        ];
        normalized.steps = rawSteps;
        normalized.final_step = "s1";
      } else {
        return normalized;
      }
    }

    const canonicalSteps = [];

    const retrievalFields = [
      "question",
      "data_sources",
      "postgresql_sources",
      "required_tables",
      "required_columns",
      "relationships",
      "filters",
      "operations",
      "grouping",
      "sorting",
      "limit",
      "entities",
      "needs_conversation_context",
    ];

    for (const rawStep of rawSteps) {
      if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) {
        canonicalSteps.push(rawStep);
        continue;
      }

      const originalStep = deepcopy(rawStep);
      const step = deepcopy(rawStep);

      step.depends_on = this._canonical_string_list(originalStep.depends_on ?? []);
      step.inputs = this._canonical_string_list(originalStep.inputs ?? []);
      step.key_columns = this._canonical_string_list(originalStep.key_columns ?? []);
      step.output_columns = this._canonical_string_list(originalStep.output_columns ?? []);

      const stepSourceId = originalStep.source_id;
      let stepSourceIds;
      if (typeof stepSourceId === "string" && stepSourceId.trim()) {
        stepSourceIds = [stepSourceId.trim().toLowerCase()];
      } else {
        stepSourceIds = this._canonical_string_list(originalStep.postgresql_sources ?? []);
      }

      const preferredTables = this._preferred_tables_from_step(originalStep);

      const rawContract = originalStep.contract;
      const contract = rawContract && typeof rawContract === "object" && !Array.isArray(rawContract)
        ? deepcopy(rawContract)
        : {};

      for (const fieldName of retrievalFields) {
        if (!(fieldName in originalStep)) {
          continue;
        }

        const directValue = originalStep[fieldName];
        const existingValue = contract[fieldName];

        // A populated nested list always wins.
        if (Array.isArray(existingValue) && existingValue.length > 0) {
          continue;
        }

        // If both representations are empty, keep the nested value.
        if (Array.isArray(existingValue) && existingValue.length === 0) {
          if (Array.isArray(directValue) && directValue.length === 0) {
            continue;
          }
        }

        let value = directValue;

        if (fieldName === "postgresql_sources") {
          value = this._canonical_string_list(value);
          if (value.length > 0) {
            stepSourceIds = value;
          }
        } else if (fieldName === "required_tables") {
          value = this._canonical_string_list(value);
        } else if (fieldName === "required_columns") {
          const candidateTables = this._canonical_string_list(
            (contract.required_tables && contract.required_tables.length > 0)
              ? contract.required_tables
              : originalStep.required_tables ?? []
          );
          value = this._canonical_columns(
            value,
            stepSourceIds,
            candidateTables,
            preferredTables
          );
        } else if (fieldName === "relationships") {
          value = this._canonical_list(value);
        } else if (fieldName === "filters") {
          const candidateTables = this._canonical_string_list(
            (contract.required_tables && contract.required_tables.length > 0)
              ? contract.required_tables
              : originalStep.required_tables ?? []
          );
          value = this._canonical_filters(
            value,
            stepSourceIds,
            candidateTables
          );
        } else if (fieldName === "operations") {
          value = this._canonical_string_list(value);
        } else if (fieldName === "grouping") {
          const candidateTables = this._canonical_string_list(
            (contract.required_tables && contract.required_tables.length > 0)
              ? contract.required_tables
              : originalStep.required_tables ?? []
          );
          value = this._canonical_grouping(
            value,
            stepSourceIds,
            candidateTables
          );
        } else if (fieldName === "sorting") {
          const candidateTables = this._canonical_string_list(
            (contract.required_tables && contract.required_tables.length > 0)
              ? contract.required_tables
              : originalStep.required_tables ?? []
          );
          value = this._canonical_sorting(
            value,
            stepSourceIds,
            candidateTables
          );
        }

        contract[fieldName] = value;
      }

      const contractSourceIds = this._canonical_string_list(
        contract.postgresql_sources !== undefined ? contract.postgresql_sources : stepSourceIds
      );
      const rawContractTables = this._canonical_string_list(
        contract.required_tables ?? []
      );

      let contractTables;
      if (contractSourceIds.length > 0) {
        const knownForStep = this._known_tables(contractSourceIds);
        contractTables = rawContractTables.filter(t => knownForStep.has(t));
      } else {
        contractTables = rawContractTables;
      }

      contract.data_sources = this._canonical_string_list(
        contract.data_sources ?? ["postgresql"]
      );
      contract.postgresql_sources = contractSourceIds;
      contract.required_tables = contractTables;
      contract.required_columns = this._canonical_columns(
        contract.required_columns ?? [],
        contractSourceIds,
        contractTables,
        preferredTables
      );
      contract.relationships = this._canonical_relationships(
        contract.relationships ?? [],
        contractSourceIds
      );
      contract.filters = this._canonical_filters(
        contract.filters ?? [],
        contractSourceIds,
        contractTables
      );
      contract.operations = this._canonical_string_list(
        contract.operations ?? []
      );
      contract.grouping = this._canonical_grouping(
        contract.grouping ?? [],
        contractSourceIds,
        contractTables
      );
      contract.sorting = this._canonical_sorting(
        contract.sorting ?? [],
        contractSourceIds,
        contractTables
      );
      contract.entities = this._canonical_entities(
        contract.entities ?? []
      );

      for (const fieldName of retrievalFields) {
        if (fieldName in contract) {
          step[fieldName] = deepcopy(contract[fieldName]);
        }
      }

      step.contract = contract;
      canonicalSteps.push(step);
    }

    normalized.steps = canonicalSteps;
    return normalized;
  }

  _canonicalizeExecutionPlan(executionPlan, topLevelPlan = null) {
    return this._canonicalize_execution_plan(executionPlan, topLevelPlan);
  }

  _preferred_tables_from_step(step) {
    const preferred = [];

    const bindings = step.input_bindings ?? [];
    if (Array.isArray(bindings)) {
      for (const binding of bindings) {
        if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
          continue;
        }
        const toTable = binding.to_table;
        if (typeof toTable === "string" && toTable.trim()) {
          preferred.push(toTable.trim());
        }
      }
    }

    for (const fieldName of ["output_columns", "grouping", "key_columns"]) {
      const values = step[fieldName] ?? [];
      if (!Array.isArray(values)) {
        continue;
      }
      for (const value of values) {
        if (typeof value !== "string" || (value.match(/\./g) || []).length !== 1) {
          continue;
        }
        const tableName = value.split(".", 1)[0].trim();
        if (tableName) {
          preferred.push(tableName);
        }
      }
    }

    const contract = step.contract;
    if (contract && typeof contract === "object" && !Array.isArray(contract)) {
      for (const fieldName of ["grouping", "sorting", "required_columns"]) {
        const values = contract[fieldName] ?? [];
        if (!Array.isArray(values)) {
          continue;
        }
        for (const value of values) {
          if (value && typeof value === "object" && !Array.isArray(value)) {
            const tableName = String(value.table || value.table_name || "").trim();
            if (tableName) {
              preferred.push(tableName);
            }
            const field = value.field;
            if (typeof field === "string" && (field.match(/\./g) || []).length === 1) {
              preferred.push(field.split(".", 1)[0].trim());
            }
            continue;
          }
          if (typeof value !== "string" || (value.match(/\./g) || []).length !== 1) {
            continue;
          }
          preferred.push(value.split(".", 1)[0].trim());
        }
      }
    }

    return Array.from(new Set(preferred.filter(Boolean)));
  }

  _preferredTablesFromStep(step) {
    return this._preferred_tables_from_step(step);
  }

  static _canonical_list(value) {
    if (value === null || value === undefined) {
      return [];
    }
    return Array.isArray(value) ? [...value] : [value];
  }

  _canonical_list(value) {
    return QuestionPlanValidator._canonical_list(value);
  }

  _canonicalList(value) {
    return QuestionPlanValidator._canonical_list(value);
  }

  static _canonical_string_list(value) {
    if (value === null || value === undefined) {
      return [];
    }
    if (!Array.isArray(value)) {
      value = [value];
    }
    const result = [];
    for (const item of value) {
      if (typeof item === "string" || typeof item === "number") {
        let cleaned = String(item).trim();
        if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
          cleaned = cleaned.slice(1, -1);
        }
        if (cleaned.startsWith("'") && cleaned.endsWith("'")) {
          cleaned = cleaned.slice(1, -1);
        }
        if (cleaned) {
          result.push(cleaned);
        }
      }
    }
    return result;
  }

  _canonical_string_list(value) {
    return QuestionPlanValidator._canonical_string_list(value);
  }

  _canonicalStringList(value) {
    return QuestionPlanValidator._canonical_string_list(value);
  }

  _resolve_bare_column(columnName, sourceIds = null, candidateTables = null, preferredTables = null) {
    if (typeof columnName !== "string" || !columnName.trim()) {
      return null;
    }

    const target = columnName.trim().toLowerCase();

    let normalizedSources = (sourceIds || [])
      .filter(s => typeof s === "string" && s.trim())
      .map(s => String(s).trim().toLowerCase());

    if (!normalizedSources.length) {
      normalizedSources = this._available_postgresql_sources();
    }

    const tableOrder = (candidateTables || [])
      .filter(t => typeof t === "string" && t.trim())
      .map(t => String(t).trim());

    const normalizedTables = new Set(tableOrder.map(t => t.toLowerCase()));

    const preferredOrder = (preferredTables || [])
      .filter(t => typeof t === "string" && t.trim())
      .map(t => String(t).trim());

    const matches = [];

    for (const sourceId of normalizedSources) {
      const context = this._get_source_context(sourceId);
      const tables = context.tables || {};

      if (!tables || typeof tables !== "object" || Array.isArray(tables)) {
        continue;
      }

      for (const [tableNameRaw, tableInfo] of Object.entries(tables)) {
        const actualTable = String(tableNameRaw);

        if (normalizedTables.size > 0 && !normalizedTables.has(actualTable.toLowerCase())) {
          continue;
        }

        if (!tableInfo || typeof tableInfo !== "object" || Array.isArray(tableInfo)) {
          continue;
        }

        const columns = tableInfo.columns || [];
        let columnNames = [];

        if (typeof columns === "object" && !Array.isArray(columns)) {
          columnNames = Object.keys(columns).map(String);
        } else if (Array.isArray(columns)) {
          for (const column of columns) {
            if (typeof column === "string") {
              columnNames.push(column);
            } else if (column && typeof column === "object") {
              const name = column.name || column.column || column.column_name;
              if (name) {
                columnNames.push(String(name));
              }
            }
          }
        }

        for (const actualColumn of columnNames) {
          if (actualColumn.trim().toLowerCase() === target) {
            matches.push([sourceId, actualTable, actualColumn]);
          }
        }
      }
    }

    if (matches.length === 0 && normalizedTables.size > 0) {
      for (const sourceId of normalizedSources) {
        const context = this._get_source_context(sourceId);
        const tables = context.tables || {};
        if (!tables || typeof tables !== "object" || Array.isArray(tables)) {
          continue;
        }

        for (const [tableNameRaw, tableInfo] of Object.entries(tables)) {
          const actualTable = String(tableNameRaw);
          if (!tableInfo || typeof tableInfo !== "object" || Array.isArray(tableInfo)) {
            continue;
          }

          const columns = tableInfo.columns || [];
          let columnNames = [];

          if (typeof columns === "object" && !Array.isArray(columns)) {
            columnNames = Object.keys(columns).map(String);
          } else if (Array.isArray(columns)) {
            for (const column of columns) {
              if (typeof column === "string") {
                columnNames.push(column);
              } else if (column && typeof column === "object") {
                const name = column.name || column.column || column.column_name;
                if (name) {
                  columnNames.push(String(name));
                }
              }
            }
          }

          for (const actualColumn of columnNames) {
            if (actualColumn.trim().toLowerCase() === target) {
              matches.push([sourceId, actualTable, actualColumn]);
            }
          }
        }
      }
    }

    // Deduplicate matches
    const seenMatches = new Set();
    const uniqueMatches = [];
    for (const match of matches) {
      const key = `${match[0]}|${match[1]}|${match[2]}`;
      if (!seenMatches.has(key)) {
        seenMatches.add(key);
        uniqueMatches.push(match);
      }
    }

    if (uniqueMatches.length === 0) {
      return null;
    }

    if (uniqueMatches.length === 1) {
      const [, tableName, resolvedColumn] = uniqueMatches[0];
      return `${tableName}.${resolvedColumn}`;
    }

    const matchByTable = {};
    for (const [, actualTable, actualColumn] of uniqueMatches) {
      matchByTable[actualTable.toLowerCase()] = [actualTable, actualColumn];
    }

    for (const table of preferredOrder) {
      const resolved = matchByTable[table.toLowerCase()];
      if (resolved) {
        return `${resolved[0]}.${resolved[1]}`;
      }
    }

    if (tableOrder.length > 0) {
      for (const table of tableOrder) {
        const resolved = matchByTable[table.toLowerCase()];
        if (resolved) {
          return `${resolved[0]}.${resolved[1]}`;
        }
      }
    }

    return null;
  }

  _resolveBareColumn(columnName, sourceIds = null, candidateTables = null, preferredTables = null) {
    return this._resolve_bare_column(columnName, sourceIds, candidateTables, preferredTables);
  }

  _canonical_field_reference(value, sourceIds = null, candidateTables = null, preferredTables = null) {
    if (typeof value === "string") {
      let cleaned = value.trim();
      if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
        cleaned = cleaned.slice(1, -1);
      }
      if (cleaned.startsWith("'") && cleaned.endsWith("'")) {
        cleaned = cleaned.slice(1, -1);
      }

      if (!cleaned) {
        return cleaned;
      }

      if ((cleaned.match(/\./g) || []).length === 1) {
        const parts = cleaned.split(".", 2);
        let tableName = parts[0].trim();
        let columnName = parts[1].trim();
        if (tableName.startsWith('"') && tableName.endsWith('"')) tableName = tableName.slice(1, -1);
        if (columnName.startsWith('"') && columnName.endsWith('"')) columnName = columnName.slice(1, -1);

        const known = this._known_columns(sourceIds);
        const tableKey = QuestionPlanValidator._find_key_ci(known, tableName);
        if (tableKey) {
          const tableCols = known[tableKey];
          for (const c of tableCols) {
            if (c.toLowerCase() === columnName.toLowerCase()) {
              return `${tableKey}.${c}`;
            }
          }
        }

        const resolved = this._resolve_bare_column(
          columnName,
          sourceIds,
          candidateTables,
          preferredTables
        );
        if (resolved !== null) {
          return resolved;
        }
        return `${tableName}.${columnName}`;
      }

      const resolved = this._resolve_bare_column(
        cleaned,
        sourceIds,
        candidateTables,
        preferredTables
      );

      return resolved !== null ? resolved : cleaned;
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      const field = value.field;
      if (typeof field === "string" || (field && typeof field === "object")) {
        const normalizedField = this._canonical_field_reference(
          field,
          sourceIds,
          candidateTables,
          preferredTables
        );
        if (typeof normalizedField === "string") {
          return normalizedField;
        }
      }

      const table = value.table || value.table_name;
      const column = value.column || value.column_name;

      if (table && column) {
        const fullRef = `${String(table).trim()}.${String(column).trim()}`;
        return this._canonical_field_reference(
          fullRef,
          sourceIds,
          candidateTables,
          preferredTables
        );
      }

      if (column) {
        const resolved = this._resolve_bare_column(
          String(column),
          sourceIds,
          candidateTables,
          preferredTables
        );
        return resolved;
      }
    }

    return value;
  }

  _canonicalFieldReference(value, sourceIds = null, candidateTables = null, preferredTables = null) {
    return this._canonical_field_reference(value, sourceIds, candidateTables, preferredTables);
  }

  _canonical_columns(value, sourceIds = null, candidateTables = null, preferredTables = null) {
    if (value === null || value === undefined) {
      return [];
    }
    if (!Array.isArray(value)) {
      value = [value];
    }

    const result = [];
    const seen = new Set();
    const known = this._known_columns(sourceIds);

    for (const item of value) {
      const resolved = this._canonical_field_reference(
        item,
        sourceIds,
        candidateTables,
        preferredTables
      );

      if (!resolved || typeof resolved !== "string") {
        continue;
      }

      if ((resolved.match(/\./g) || []).length !== 1) {
        continue;
      }

      const [tableName, colName] = resolved.split(".", 2);
      const tableKey = QuestionPlanValidator._find_key_ci(known, tableName);
      if (!tableKey) {
        result.push(resolved);
        continue;
      }

      const cols = known[tableKey];
      let matchingCol = null;
      for (const c of cols) {
        if (c.toLowerCase() === colName.toLowerCase()) {
          matchingCol = c;
          break;
        }
      }

      if (!matchingCol) {
        result.push(resolved);
        continue;
      }

      const canonicalRef = `${tableKey}.${matchingCol}`;
      if (seen.has(canonicalRef)) {
        continue;
      }
      seen.add(canonicalRef);
      result.push(canonicalRef);
    }

    return result;
  }

  _canonicalColumns(value, sourceIds = null, candidateTables = null, preferredTables = null) {
    return this._canonical_columns(value, sourceIds, candidateTables, preferredTables);
  }

  _canonical_relationships(value, sourceIds = null) {
    if (value === null || value === undefined) {
      return [];
    }
    if (!Array.isArray(value)) {
      value = [value];
    }

    const known = this._known_relationships(sourceIds);

    function endpoints(item) {
      if (!item || typeof item !== "object") return null;
      const sourceTable = String(item.source_table || item.from_table || "").trim();
      const sourceColumn = String(item.source_column || item.from_column || "").trim();
      const targetTable = String(item.target_table || item.to_table || "").trim();
      const targetColumn = String(item.target_column || item.to_column || "").trim();

      if (!sourceTable || !sourceColumn || !targetTable || !targetColumn) {
        return null;
      }
      return [sourceTable, sourceColumn, targetTable, targetColumn];
    }

    function matches(left, right) {
      return (
        left[0].toLowerCase() === right[0].toLowerCase() &&
        left[1].toLowerCase() === right[1].toLowerCase() &&
        left[2].toLowerCase() === right[2].toLowerCase() &&
        left[3].toLowerCase() === right[3].toLowerCase()
      ) || (
        left[0].toLowerCase() === right[2].toLowerCase() &&
        left[1].toLowerCase() === right[3].toLowerCase() &&
        left[2].toLowerCase() === right[0].toLowerCase() &&
        left[3].toLowerCase() === right[1].toLowerCase()
      );
    }

    const result = [];
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const desired = endpoints(item);
      if (desired === null) {
        continue;
      }
      if (known.some(k => {
        const ep = endpoints(k);
        return ep !== null && matches(desired, ep);
      })) {
        result.push(item);
      }
    }

    return result;
  }

  _canonicalRelationships(value, sourceIds = null) {
    return this._canonical_relationships(value, sourceIds);
  }

  _canonical_filters(value, sourceIds = null, candidateTables = null) {
    if (value === null || value === undefined) {
      return [];
    }
    if (!Array.isArray(value)) {
      value = [value];
    }

    const validOperators = new Set([
      ...this.ALLOWED_FILTER_OPERATORS,
      "eq", "equals", "ne", "not_equals", "gt", "gte", "lt", "lte", "not_in",
    ]);

    const result = [];

    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        result.push(item);
        continue;
      }

      const operator = String(item.operator || item.op || "=").trim().toLowerCase();
      if (!validOperators.has(operator)) {
        continue;
      }

      const filterValue = item.value;
      if (typeof filterValue === "string") {
        const placeholderValues = new Set([
          "project_id",
          "user_id",
          "target_project",
          "some_project",
          "project_name",
          "id",
          "none",
          "null",
        ]);
        if (placeholderValues.has(filterValue.trim().toLowerCase())) {
          continue;
        }
      }

      const current = deepcopy(item);

      if ("field" in current) {
        current.field = this._canonical_field_reference(
          current.field,
          sourceIds,
          candidateTables
        );
      } else if ("column" in current) {
        current.column = this._canonical_field_reference(
          current.column,
          sourceIds,
          candidateTables
        );
      } else if ("column_name" in current) {
        current.column_name = this._canonical_field_reference(
          current.column_name,
          sourceIds,
          candidateTables
        );
      }

      result.push(current);
    }

    return result;
  }

  _canonicalFilters(value, sourceIds = null, candidateTables = null) {
    return this._canonical_filters(value, sourceIds, candidateTables);
  }

  _canonical_grouping(value, sourceIds = null, candidateTables = null) {
    if (value === null || value === undefined) {
      return [];
    }
    if (!Array.isArray(value)) {
      value = [value];
    }

    return value.map(item => this._canonical_field_reference(
      item,
      sourceIds,
      candidateTables
    ));
  }

  _canonicalGrouping(value, sourceIds = null, candidateTables = null) {
    return this._canonical_grouping(value, sourceIds, candidateTables);
  }

  _canonical_sorting(value, sourceIds = null, candidateTables = null) {
    if (value === null || value === undefined) {
      return [];
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      value = [value];
    }
    if (!Array.isArray(value)) {
      return [];
    }

    const result = [];

    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }

      const current = deepcopy(item);

      if ("field" in current) {
        const fieldVal = this._canonical_field_reference(
          current.field,
          sourceIds,
          candidateTables
        );
        if (typeof fieldVal === "string" && (fieldVal.match(/\./g) || []).length === 1) {
          current.field = fieldVal;
        } else {
          continue;
        }
      }

      const direction = current.direction;
      if (typeof direction === "string") {
        current.direction = direction.trim().toLowerCase();
      }

      result.push(current);
    }

    return result;
  }

  _canonicalSorting(value, sourceIds = null, candidateTables = null) {
    return this._canonical_sorting(value, sourceIds, candidateTables);
  }

  _canonical_entities(entities) {
    if (entities === null || entities === undefined) {
      return [];
    }
    if (typeof entities === "string" || (entities && typeof entities === "object" && !Array.isArray(entities))) {
      entities = [entities];
    }
    if (!Array.isArray(entities)) {
      return [];
    }

    const availableSources = new Set(this._available_postgresql_sources());
    const canonical = [];

    for (const item of entities) {
      if (typeof item === "string" && item.trim()) {
        canonical.push({
          id: item.trim(),
          type: "entity",
        });
        continue;
      }

      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }

      const current = deepcopy(item);

      const entityId =
        current.id ??
        current.identifier ??
        current.entity_id ??
        current.entity_name ??
        current.name ??
        current.value ??
        current.entity_value;

      if (entityId !== null && entityId !== undefined && String(entityId).trim()) {
        current.id = String(entityId).trim();
      }

      const entityType =
        current.type ??
        current.entity_type ??
        current.matched_table ??
        current.table ??
        current.category;

      if (entityType !== null && entityType !== undefined && String(entityType).trim()) {
        current.type = String(entityType).trim();
      } else if (current.id) {
        current.type = "entity";
      }

      const sourceId = current.source_id;
      if (typeof sourceId === "string" && sourceId.trim()) {
        const sid = sourceId.trim().toLowerCase();
        if (availableSources.has(sid)) {
          current.source_id = sid;
        } else {
          delete current.source_id;
        }
      } else if (sourceId !== null && sourceId !== undefined) {
        delete current.source_id;
      }

      if (
        typeof current.id === "string" && current.id.trim() &&
        typeof current.type === "string" && current.type.trim()
      ) {
        canonical.push(current);
      }
    }

    return canonical;
  }

  _canonicalEntities(entities) {
    return this._canonical_entities(entities);
  }

  // ------------------------------------------------------------------
  // Basic validation
  // ------------------------------------------------------------------

  _validate_question(question) {
    if (typeof question !== "string") {
      return ["question must be a string."];
    }
    if (!question.trim()) {
      return ["question cannot be empty."];
    }
    return [];
  }

  _validate_data_sources(dataSources) {
    if (!Array.isArray(dataSources)) {
      return ["data_sources must be a list."];
    }
    if (dataSources.length === 0) {
      return ["data_sources must contain at least one source."];
    }

    const errors = [];
    const seen = new Set();

    for (const source of dataSources) {
      if (typeof source !== "string") {
        errors.push(`Invalid data source: '${source}'`);
        continue;
      }

      const normalizedSource = source.trim().toLowerCase();
      if (!this.ALLOWED_DATA_SOURCES.has(normalizedSource)) {
        errors.push(`Unsupported data source: ${normalizedSource}`);
      }
      if (seen.has(normalizedSource)) {
        errors.push(`Duplicate data source: ${normalizedSource}`);
      }
      seen.add(normalizedSource);
    }

    return errors;
  }

  _validate_postgresql_sources(postgresqlSources, dataSources) {
    const errors = [];

    if (!Array.isArray(postgresqlSources)) {
      return ["postgresql_sources must be a list."];
    }

    const seen = new Set();
    for (const sourceId of postgresqlSources) {
      if (typeof sourceId !== "string") {
        errors.push(`PostgreSQL source ID must be a string: '${sourceId}'`);
        continue;
      }

      const normalizedSource = sourceId.trim().toLowerCase();
      if (!(normalizedSource in this.contexts)) {
        errors.push(`Unknown PostgreSQL source: ${normalizedSource}`);
      }
      if (seen.has(normalizedSource)) {
        errors.push(`Duplicate PostgreSQL source: ${normalizedSource}`);
      }
      seen.add(normalizedSource);
    }

    if (dataSources.includes("postgresql") && postgresqlSources.length === 0) {
      errors.push("postgresql_sources must contain at least one source when postgresql is selected.");
    }

    if (!dataSources.includes("postgresql") && postgresqlSources.length > 0) {
      errors.push("postgresql_sources must be empty when postgresql is not selected.");
    }

    return errors;
  }

  _validate_entities(entities) {
    if (!Array.isArray(entities)) {
      return ["entities must be a list."];
    }

    const errors = [];
    const availableSources = new Set(this._available_postgresql_sources());

    for (const entity of entities) {
      if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
        errors.push(`Invalid entity format: ${JSON.stringify(entity)}`);
        continue;
      }

      const entityType =
        entity.type ??
        entity.entity_type ??
        entity.matched_table ??
        entity.table;

      const entityId =
        entity.id ??
        entity.identifier ??
        entity.entity_id ??
        entity.entity_name ??
        entity.name ??
        entity.value ??
        entity.entity_value;

      if (typeof entityType !== "string" || !String(entityType).trim()) {
        errors.push(`Entity type must be a non-empty string: ${JSON.stringify(entity)}`);
      }

      if (typeof entityId !== "string" || !String(entityId).trim()) {
        errors.push(`Entity id must be a non-empty string: ${JSON.stringify(entity)}`);
      }

      const sourceId = entity.source_id;
      if (sourceId !== null && sourceId !== undefined) {
        if (typeof sourceId !== "string") {
          errors.push(`Entity source_id must be a string: ${JSON.stringify(entity)}`);
        } else if (!availableSources.has(sourceId.trim().toLowerCase())) {
          errors.push(`Unknown entity PostgreSQL source: ${sourceId}`);
        }
      }
    }

    return errors;
  }

  _validate_limit(limit) {
    if (limit === null || limit === undefined) {
      return [];
    }
    if (typeof limit === "boolean" || typeof limit !== "number" || !Number.isInteger(limit)) {
      return ["limit must be a positive integer or null."];
    }
    if (limit <= 0) {
      return ["limit must be greater than 0."];
    }
    return [];
  }

  _validate_confidence(confidence) {
    if (confidence === null || confidence === undefined) {
      return [];
    }
    if (typeof confidence === "boolean" || typeof confidence !== "number") {
      return ["confidence must be a number between 0 and 1."];
    }
    if (confidence < 0 || confidence > 1) {
      return ["confidence must be between 0 and 1."];
    }
    return [];
  }

  _validate_operations(operations) {
    if (!Array.isArray(operations)) {
      return ["operations must be a list."];
    }

    const errors = [];
    for (const operation of operations) {
      if (typeof operation !== "string") {
        errors.push(`Invalid operation: '${operation}'`);
        continue;
      }

      const operationText = operation.trim();
      if (!operationText) {
        errors.push("Operation cannot be empty.");
        continue;
      }

      const operationName = operationText.split("(", 1)[0].trim().toLowerCase();
      if (!this.ALLOWED_OPERATIONS.has(operationName)) {
        errors.push(`Unsupported operation: ${operation}`);
      }
    }

    return errors;
  }

  _validate_security_resource(plan, dataSources) {
    const resource = plan.security_resource;

    if (!dataSources.includes("security_logs")) {
      if (resource !== null && resource !== undefined && resource !== "") {
        return ["security_resource must be null when security_logs is not selected."];
      }
      return [];
    }

    if (typeof resource !== "string" || !resource.trim()) {
      return ["security_resource must be a non-empty string when security_logs is selected."];
    }

    if (!this.ALLOWED_SECURITY_RESOURCES.has(resource.trim())) {
      return [`Unsupported security resource: ${resource}`];
    }

    return [];
  }

  // ------------------------------------------------------------------
  // Schema validation
  // ------------------------------------------------------------------

  _validate_tables(requiredTables, sourceIds, prefix = "required_tables") {
    const errors = [];
    const knownTables = this._known_tables(sourceIds);
    const knownLower = {};
    for (const table of knownTables) {
      knownLower[table.toLowerCase()] = table;
    }

    for (let index = 0; index < requiredTables.length; index++) {
      const table = requiredTables[index];
      if (typeof table !== "string" || !table.trim()) {
        errors.push(`${prefix}[${index}] must be a non-empty table name.`);
        continue;
      }

      if (!(table.trim().toLowerCase() in knownLower)) {
        errors.push(`${prefix}[${index}] references unknown table: ${table}`);
      }
    }

    return errors;
  }

  _validate_columns(requiredColumns, sourceIds, prefix = "required_columns") {
    const errors = [];
    const knownColumns = this._known_columns(sourceIds);
    const tableLookup = {};
    for (const table of Object.keys(knownColumns)) {
      tableLookup[table.toLowerCase()] = table;
    }

    for (let index = 0; index < requiredColumns.length; index++) {
      let reference = requiredColumns[index];
      if (typeof reference !== "string") {
        errors.push(`${prefix}[${index}] must use table.column format.`);
        continue;
      }

      reference = reference.trim();
      if ((reference.match(/\./g) || []).length !== 1) {
        errors.push(`${prefix}[${index}] must use table.column format.`);
        continue;
      }

      const parts = reference.split(".", 2);
      const tableName = parts[0].trim();
      const columnName = parts[1].trim();

      if (!tableName || !columnName) {
        errors.push(`${prefix}[${index}] must use table.column format.`);
        continue;
      }

      const canonicalTable = tableLookup[tableName.toLowerCase()];
      if (!canonicalTable) {
        errors.push(`${prefix}[${index}] references unknown table: ${tableName}`);
        continue;
      }

      const columns = knownColumns[canonicalTable] || new Set();
      let hasColumn = false;
      for (const col of columns) {
        if (col.toLowerCase() === columnName.toLowerCase()) {
          hasColumn = true;
          break;
        }
      }

      if (!hasColumn) {
        errors.push(`${prefix}[${index}] references unknown column: ${reference}`);
      }
    }

    return errors;
  }

  _validate_relationships(requestedRelationships, sourceIds, prefix = "relationships") {
    const errors = [];
    const known = this._known_relationships(sourceIds);

    function endpoints(item) {
      if (!item || typeof item !== "object") return null;
      const sourceTable = String(item.source_table || item.from_table || "").trim();
      const sourceColumn = String(item.source_column || item.from_column || "").trim();
      const targetTable = String(item.target_table || item.to_table || "").trim();
      const targetColumn = String(item.target_column || item.to_column || "").trim();

      if (!sourceTable || !sourceColumn || !targetTable || !targetColumn) {
        return null;
      }
      return [sourceTable, sourceColumn, targetTable, targetColumn];
    }

    function matches(left, right) {
      return (
        left[0].toLowerCase() === right[0].toLowerCase() &&
        left[1].toLowerCase() === right[1].toLowerCase() &&
        left[2].toLowerCase() === right[2].toLowerCase() &&
        left[3].toLowerCase() === right[3].toLowerCase()
      ) || (
        left[0].toLowerCase() === right[2].toLowerCase() &&
        left[1].toLowerCase() === right[3].toLowerCase() &&
        left[2].toLowerCase() === right[0].toLowerCase() &&
        left[3].toLowerCase() === right[1].toLowerCase()
      );
    }

    for (let index = 0; index < requestedRelationships.length; index++) {
      const requested = requestedRelationships[index];
      if (!requested || typeof requested !== "object" || Array.isArray(requested)) {
        errors.push(`${prefix}[${index}] has invalid relationship format.`);
        continue;
      }

      const desired = endpoints(requested);
      if (desired === null) {
        errors.push(`${prefix}[${index}] must contain source/target table and column information.`);
        continue;
      }

      let found = false;
      for (const knownRelationship of known) {
        const actual = endpoints(knownRelationship);
        if (actual !== null && matches(desired, actual)) {
          found = true;
          break;
        }
      }

      if (!found) {
        errors.push(
          `${prefix}[${index}] references an undiscovered relationship: ${desired[0]}.${desired[1]} -> ${desired[2]}.${desired[3]}`
        );
      }
    }

    return errors;
  }

  _validate_table_column_consistency(requiredTables, requiredColumns, prefix = "required_columns") {
    const errors = [];
    const selectedTables = new Set(
      requiredTables
        .filter(t => typeof t === "string")
        .map(t => t.toLowerCase())
    );

    if (selectedTables.size === 0) {
      return errors;
    }

    for (let index = 0; index < requiredColumns.length; index++) {
      const reference = requiredColumns[index];
      if (typeof reference !== "string" || !reference.includes(".")) {
        continue;
      }

      const tableName = reference.split(".", 1)[0].trim().toLowerCase();
      if (!selectedTables.has(tableName)) {
        errors.push(
          `${prefix}[${index}] references table ${reference.split(".", 1)[0]} that is not included in required_tables.`
        );
      }
    }

    return errors;
  }

  _validate_field_reference(reference, sourceIds, fieldLabel) {
    if (reference && typeof reference === "object" && !Array.isArray(reference)) {
      reference = QuestionPlanValidator._canonical_required_column(reference);
    }

    if (typeof reference !== "string") {
      return [`${fieldLabel} must use table.column format.`];
    }

    const trimmed = reference.trim();
    if ((trimmed.match(/\./g) || []).length !== 1) {
      return [`${fieldLabel} must use table.column format.`];
    }

    return this._validate_columns(
      [trimmed],
      sourceIds,
      fieldLabel
    );
  }

  static _filter_runtime_bound(item, runtimeBindings) {
    if (!Array.isArray(runtimeBindings)) {
      return false;
    }

    const field = item.field || item.column || item.column_name;
    if (typeof field !== "string") {
      return false;
    }

    const fieldTrimmed = field.trim().toLowerCase();
    if ((fieldTrimmed.match(/\./g) || []).length !== 1) {
      return false;
    }

    const parts = fieldTrimmed.split(".", 2);
    const tableName = parts[0].trim();
    const columnName = parts[1].trim();

    if (!tableName || !columnName) {
      return false;
    }

    for (const binding of runtimeBindings) {
      if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
        continue;
      }
      const toTable = String(binding.to_table || "").trim().toLowerCase();
      const toColumn = String(binding.to_column || "").trim().toLowerCase();
      if (toTable === tableName && toColumn === columnName) {
        return true;
      }
    }

    return false;
  }

  _validate_filters(filters, sourceIds, prefix = "filters", runtimeBindings = null) {
    if (filters === null || filters === undefined) {
      return [];
    }
    if (!Array.isArray(filters)) {
      return [`${prefix} must be a list.`];
    }

    const errors = [];
    for (let index = 0; index < filters.length; index++) {
      const item = filters[index];
      const currentPrefix = `${prefix}[${index}]`;

      if (!item || typeof item !== "object" || Array.isArray(item)) {
        errors.push(`${currentPrefix} must be an object.`);
        continue;
      }

      const field = item.field || item.column || item.column_name;
      errors.push(...this._validate_field_reference(
        field,
        sourceIds,
        `${currentPrefix}.field`
      ));

      let operator = String(item.operator || item.op || "=").trim().toLowerCase();
      const operatorAliases = {
        "eq": "=",
        "equals": "=",
        "ne": "!=",
        "not_equals": "!=",
        "gt": ">",
        "gte": ">=",
        "lt": "<",
        "lte": "<=",
        "not_in": "not_in",
      };
      operator = operatorAliases[operator] || operator;

      if (!this.ALLOWED_FILTER_OPERATORS.has(operator)) {
        errors.push(`${currentPrefix}.operator is unsupported: ${operator}`);
      }

      if (operator !== "is_null" && operator !== "is_not_null") {
        if (!("value" in item) && !QuestionPlanValidator._filter_runtime_bound(item, runtimeBindings)) {
          errors.push(
            `${currentPrefix} must contain value for operator ${operator}, or have an explicit runtime binding.`
          );
        }
      }
    }

    return errors;
  }

  _validate_grouping(grouping, sourceIds, prefix = "grouping") {
    if (grouping === null || grouping === undefined) {
      return [];
    }
    if (!Array.isArray(grouping)) {
      grouping = [grouping];
    }

    const errors = [];
    for (let index = 0; index < grouping.length; index++) {
      errors.push(...this._validate_field_reference(
        grouping[index],
        sourceIds,
        `${prefix}[${index}]`
      ));
    }
    return errors;
  }

  _validate_sorting(sorting, sourceIds, prefix = "sorting") {
    if (sorting === null || sorting === undefined) {
      return [];
    }
    if (sorting && typeof sorting === "object" && !Array.isArray(sorting)) {
      sorting = [sorting];
    }
    if (!Array.isArray(sorting)) {
      return [`${prefix} must be a list, object, or null.`];
    }

    const errors = [];
    for (let index = 0; index < sorting.length; index++) {
      const item = sorting[index];
      const currentPrefix = `${prefix}[${index}]`;

      if (!item || typeof item !== "object" || Array.isArray(item)) {
        errors.push(`${currentPrefix} must be an object.`);
        continue;
      }

      const field = item.field;
      errors.push(...this._validate_field_reference(
        field,
        sourceIds,
        `${currentPrefix}.field`
      ));

      const direction = String(item.direction ?? "desc").trim().toLowerCase();
      if (!this.ALLOWED_SORT_DIRECTIONS.has(direction)) {
        errors.push(`${currentPrefix}.direction must be asc or desc.`);
      }
    }

    return errors;
  }

  // ------------------------------------------------------------------
  // Execution plan validation
  // ------------------------------------------------------------------

  static _execution_dependencies(step) {
    const values = step.depends_on ?? [];
    if (!Array.isArray(values)) {
      return [];
    }
    return values.map(v => String(v).trim()).filter(Boolean);
  }

  _execution_depths(steps) {
    const errors = [];
    const depths = {};
    const visiting = new Set();
    const visited = new Set();

    function visit(stepId) {
      if (visiting.has(stepId)) {
        throw new Error("execution_plan contains a dependency cycle.");
      }
      if (stepId in depths) {
        return depths[stepId];
      }

      visiting.add(stepId);
      const step = steps[stepId];
      const dependencies = QuestionPlanValidator._execution_dependencies(step);

      let depth = 0;
      if (!dependencies.length) {
        depth = 0;
      } else {
        for (const dependency of dependencies) {
          if (!(dependency in steps)) {
            errors.push(
              `execution step '${stepId}' references unknown dependency/input '${dependency}'.`
            );
            continue;
          }
          depth = Math.max(depth, visit(dependency) + 1);
        }
      }

      visiting.delete(stepId);
      visited.add(stepId);
      depths[stepId] = depth;
      return depth;
    }

    try {
      for (const stepId of Object.keys(steps)) {
        visit(stepId);
      }
    } catch (exc) {
      errors.push(exc.message);
    }

    return [depths, errors];
  }

  _validate_binding(binding, index, consumerStep, steps, selectedPostgresqlSources) {
    const prefix = `execution_plan.steps[${this._step_index(steps, consumerStep)}].input_bindings[${index}]`;
    const errors = [];

    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
      return [`${prefix} must be an object.`];
    }

    const fromStep = String(binding.from_step || "").trim();
    const fromColumn = String(binding.from_column || "").trim();
    const toTable = String(binding.to_table || "").trim();
    const toColumn = String(binding.to_column || "").trim();
    const operator = String(binding.operator || "in").trim().toLowerCase();

    if (!fromStep) {
      errors.push(`${prefix}.from_step is required.`);
    } else if (!(fromStep in steps)) {
      errors.push(`${prefix}.from_step references unknown step '${fromStep}'.`);
    }

    if (!fromColumn) {
      errors.push(`${prefix}.from_column is required.`);
    }

    if (!toTable) {
      errors.push(`${prefix}.to_table is required.`);
    }

    if (!toColumn) {
      errors.push(`${prefix}.to_column is required.`);
    }

    if (!this.ALLOWED_BINDING_OPERATORS.has(operator)) {
      errors.push(`${prefix}.operator is unsupported: '${operator}'`);
    }

    const consumerSource = String(consumerStep.source_id || "").trim().toLowerCase();

    if (consumerSource && (consumerSource in this.contexts)) {
      if (toTable && toColumn) {
        errors.push(...this._validate_columns(
          [`${toTable}.${toColumn}`],
          [consumerSource],
          `${prefix}.destination`
        ));
      }
    }

    if (fromStep in steps && fromColumn) {
      const producer = steps[fromStep];
      const declared = [];

      for (const fieldName of ["output_columns", "key_columns"]) {
        const values = producer[fieldName];
        if (Array.isArray(values)) {
          for (const v of values) {
            if (String(v).trim()) {
              declared.push(String(v).trim());
            }
          }
        }
      }

      const producerContract = producer.contract;
      if (producerContract && typeof producerContract === "object" && !Array.isArray(producerContract)) {
        const required = producerContract.required_columns;
        if (Array.isArray(required)) {
          for (const v of required) {
            if (typeof v === "string" && v.trim()) {
              declared.push(v.trim());
            }
          }
        }
      }

      if (declared.length > 0) {
        const normalizedFrom = fromColumn.toLowerCase();
        let matches = false;
        for (const value of declared) {
          const lowered = value.toLowerCase();
          if (lowered === normalizedFrom) {
            matches = true;
            break;
          }
          if (value.includes(".") && value.split(".").pop().toLowerCase() === normalizedFrom) {
            matches = true;
            break;
          }
        }

        if (!matches) {
          errors.push(
            `${prefix}.from_column '${fromColumn}' is not declared by the producer step output_columns, key_columns, or required_columns.`
          );
        }
      }
    }

    return errors;
  }

  _step_index(steps, target) {
    const values = Object.values(steps);
    for (let index = 0; index < values.length; index++) {
      if (values[index] === target) {
        return index;
      }
    }
    return 0;
  }

  static _collect_execution_bindings(executionPlan) {
    if (!executionPlan || typeof executionPlan !== "object" || Array.isArray(executionPlan)) {
      return [];
    }

    const steps = executionPlan.steps;
    if (!Array.isArray(steps)) {
      return [];
    }

    const bindings = [];
    for (const step of steps) {
      if (!step || typeof step !== "object" || Array.isArray(step)) {
        continue;
      }
      const stepBindings = step.input_bindings;
      if (Array.isArray(stepBindings)) {
        bindings.push(...stepBindings);
      }
    }
    return bindings;
  }

  _validate_execution_plan(executionPlan, topLevelPlan) {
    if (executionPlan === null || executionPlan === undefined) {
      return [];
    }

    if (typeof executionPlan !== "object" || Array.isArray(executionPlan)) {
      return ["execution_plan must be an object."];
    }

    const errors = [];

    const mode = String(executionPlan.mode || "single").trim().toLowerCase();
    if (mode !== "single" && mode !== "multi_step") {
      errors.push(`execution_plan.mode is unsupported: '${mode}'`);
    }

    const rawSteps = executionPlan.steps;
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
      return [...errors, "execution_plan.steps must contain at least one step."];
    }

    if (rawSteps.length > this.MAX_EXECUTION_STEPS) {
      errors.push(`execution_plan.steps cannot exceed ${this.MAX_EXECUTION_STEPS} steps.`);
    }

    if (mode === "single" && rawSteps.length !== 1) {
      errors.push("execution_plan.mode='single' requires exactly one step.");
    }

    if (mode === "multi_step" && rawSteps.length < 2) {
      errors.push("execution_plan.mode='multi_step' requires at least two steps.");
    }

    const stepsById = {};

    for (let index = 0; index < rawSteps.length; index++) {
      const rawStep = rawSteps[index];
      const prefix = `execution_plan.steps[${index}]`;

      if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) {
        errors.push(`${prefix} must be an object.`);
        continue;
      }

      const stepId = String(rawStep.id || "").trim();
      const stepType = String(rawStep.type || "").trim().toLowerCase();

      if (!stepId) {
        errors.push(`${prefix}.id is required.`);
        continue;
      }

      if (stepId in stepsById) {
        errors.push(`${prefix}.id duplicates step '${stepId}'.`);
        continue;
      }

      stepsById[stepId] = rawStep;

      if (!this.ALLOWED_EXECUTION_STEP_TYPES.has(stepType)) {
        errors.push(`${prefix}.type is unsupported: '${stepType}'`);
      }

      const dependsOn = rawStep.depends_on ?? [];
      const inputs = rawStep.inputs ?? [];

      if (!Array.isArray(dependsOn)) {
        errors.push(`${prefix}.depends_on must be a list.`);
      }
      if (!Array.isArray(inputs)) {
        errors.push(`${prefix}.inputs must be a list.`);
      }

      const sourceId = rawStep.source_id;

      if (stepType === "source_query" || stepType === "final_query") {
        if (typeof sourceId !== "string" || !sourceId.trim()) {
          errors.push(`${prefix}.source_id is required for ${stepType}.`);
        } else if (!(sourceId.trim().toLowerCase() in this.contexts)) {
          errors.push(`${prefix}.source_id references unknown PostgreSQL source: ${sourceId}`);
        }
      }

      if (stepType === "set_operation") {
        const operator = String(rawStep.operator || "").trim().toLowerCase();
        if (!this.ALLOWED_SET_OPERATIONS.has(operator)) {
          errors.push(`${prefix}.operator is unsupported: '${operator}'`);
        }

        const inputCount = Array.isArray(inputs) ? inputs.length : 0;
        if (["intersect", "union", "union_all", "except"].includes(operator) && inputCount < 2) {
          errors.push(`${prefix}.operator '${operator}' requires at least two inputs.`);
        } else if (operator === "distinct" && inputCount < 1) {
          errors.push(`${prefix}.operator 'distinct' requires an input.`);
        }

        if (Array.isArray(inputs)) {
          for (let inputIndex = 0; inputIndex < inputs.length; inputIndex++) {
            const inputId = String(inputs[inputIndex]).trim();
            if (!inputId) {
              errors.push(`${prefix}.inputs[${inputIndex}] must be a non-empty execution step ID.`);
              continue;
            }
            if (!(inputId in stepsById)) {
              errors.push(`${prefix}.inputs[${inputIndex}] references unknown execution step '${inputId}'.`);
            }
          }
        }
      }

      const requiredTables = rawStep.required_tables ?? [];
      const requiredColumns = rawStep.required_columns ?? [];
      const relationships = rawStep.relationships ?? [];
      const filters = rawStep.filters ?? [];
      const grouping = rawStep.grouping ?? [];
      const sorting = rawStep.sorting ?? [];

      if (typeof sourceId === "string" && (sourceId.trim().toLowerCase() in this.contexts)) {
        const source = [sourceId.trim().toLowerCase()];

        errors.push(...this._validate_tables(
          requiredTables,
          source,
          `${prefix}.required_tables`
        ));
        errors.push(...this._validate_columns(
          requiredColumns,
          source,
          `${prefix}.required_columns`
        ));
        errors.push(...this._validate_relationships(
          relationships,
          source,
          `${prefix}.relationships`
        ));
        errors.push(...this._validate_filters(
          filters,
          source,
          `${prefix}.filters`,
          rawStep.input_bindings ?? []
        ));
        errors.push(...this._validate_grouping(
          grouping,
          source,
          `${prefix}.grouping`
        ));
        errors.push(...this._validate_sorting(
          sorting,
          source,
          `${prefix}.sorting`
        ));

        const contract = rawStep.contract;
        if (contract && typeof contract === "object" && !Array.isArray(contract)) {
          errors.push(...this._validate_tables(
            contract.required_tables ?? [],
            source,
            `${prefix}.contract.required_tables`
          ));
          errors.push(...this._validate_columns(
            contract.required_columns ?? [],
            source,
            `${prefix}.contract.required_columns`
          ));
          errors.push(...this._validate_relationships(
            contract.relationships ?? [],
            source,
            `${prefix}.contract.relationships`
          ));
          errors.push(...this._validate_filters(
            contract.filters ?? [],
            source,
            `${prefix}.contract.filters`,
            rawStep.input_bindings ?? []
          ));
          errors.push(...this._validate_grouping(
            contract.grouping ?? [],
            source,
            `${prefix}.contract.grouping`
          ));
          errors.push(...this._validate_sorting(
            contract.sorting ?? [],
            source,
            `${prefix}.contract.sorting`
          ));
        }
      }

      const bindings = rawStep.input_bindings;
      if (bindings !== null && bindings !== undefined && !Array.isArray(bindings)) {
        errors.push(`${prefix}.input_bindings must be a list.`);
      } else if (Array.isArray(bindings)) {
        if (bindings.length > this.MAX_RUNTIME_BINDINGS) {
          errors.push(`${prefix}.input_bindings cannot exceed ${this.MAX_RUNTIME_BINDINGS}.`);
        }

        for (let bindingIndex = 0; bindingIndex < bindings.length; bindingIndex++) {
          errors.push(...this._validate_binding(
            bindings[bindingIndex],
            bindingIndex,
            rawStep,
            stepsById,
            topLevelPlan.postgresql_sources ?? []
          ));
        }
      }
    }

    const [depths, depthErrors] = this._execution_depths(stepsById);
    errors.push(...depthErrors);

    for (const [stepId, depth] of Object.entries(depths)) {
      if (depth >= this.MAX_DEPENDENCY_DEPTH) {
        errors.push(
          `execution step '${stepId}' exceeds maximum dependency depth of ${this.MAX_DEPENDENCY_DEPTH}.`
        );
      }
    }

    const finalStep = String(executionPlan.final_step || "").trim();
    if (!finalStep) {
      errors.push("execution_plan.final_step must be a non-empty step ID.");
    } else if (!(finalStep in stepsById)) {
      errors.push(`execution_plan.final_step references unknown step: ${finalStep}`);
    }

    return errors;
  }

  // ------------------------------------------------------------------
  // Main validation
  // ------------------------------------------------------------------

  validate(plan) {
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
      return {
        valid: false,
        errors: ["Question plan must be a dictionary."],
        plan: plan,
        missing_tables: [],
        missing_columns: [],
        missing_relationships: [],
      };
    }

    const normalizedPlan = this._canonicalize_plan(plan);
    const errors = [];

    const question = normalizedPlan.question;
    const dataSources = normalizedPlan.data_sources ?? ["postgresql"];
    const postgresqlSources = normalizedPlan.postgresql_sources ?? [];
    const requiredTables = normalizedPlan.required_tables ?? [];
    const requiredColumns = normalizedPlan.required_columns ?? [];
    const relationships = normalizedPlan.relationships ?? [];
    const operations = normalizedPlan.operations ?? [];
    const entities = normalizedPlan.entities ?? [];
    const filters = normalizedPlan.filters ?? [];
    const grouping = normalizedPlan.grouping ?? [];
    const sorting = normalizedPlan.sorting ?? [];

    errors.push(...this._validate_question(question));
    errors.push(...this._validate_data_sources(dataSources));

    const normalizedSources = Array.isArray(postgresqlSources)
      ? postgresqlSources.filter(s => typeof s === "string").map(s => s.trim().toLowerCase())
      : postgresqlSources;

    if (Array.isArray(dataSources)) {
      errors.push(...this._validate_postgresql_sources(
        normalizedSources,
        dataSources.filter(s => typeof s === "string").map(s => s.trim().toLowerCase())
      ));
    }

    errors.push(...this._validate_security_resource(
      normalizedPlan,
      Array.isArray(dataSources) ? dataSources.filter(s => typeof s === "string").map(s => s.trim().toLowerCase()) : []
    ));

    errors.push(...this._validate_entities(entities));
    errors.push(...this._validate_operations(operations));
    errors.push(...this._validate_limit(normalizedPlan.limit));
    errors.push(...this._validate_confidence(normalizedPlan.confidence));

    const normalizedDataSources = Array.isArray(dataSources)
      ? dataSources.filter(s => typeof s === "string").map(s => s.trim().toLowerCase())
      : [];

    const hasExecutionPlan = normalizedPlan.execution_plan &&
      typeof normalizedPlan.execution_plan === "object" &&
      !Array.isArray(normalizedPlan.execution_plan);

    if (normalizedDataSources.includes("postgresql")) {
      if (Array.isArray(normalizedSources) && normalizedSources.length > 0) {
        if (!hasExecutionPlan || normalizedSources.length === 1) {
          errors.push(...this._validate_tables(requiredTables, normalizedSources));
          errors.push(...this._validate_columns(requiredColumns, normalizedSources));
          errors.push(...this._validate_relationships(relationships, normalizedSources));
          errors.push(...this._validate_filters(
            filters,
            normalizedSources,
            "filters",
            QuestionPlanValidator._collect_execution_bindings(normalizedPlan.execution_plan)
          ));
          errors.push(...this._validate_grouping(grouping, normalizedSources));
          errors.push(...this._validate_sorting(sorting, normalizedSources));
          errors.push(...this._validate_table_column_consistency(requiredTables, requiredColumns));
        }
      }
    }

    if (normalizedDataSources.length === 1 && normalizedDataSources[0] === "security_logs") {
      if (Array.isArray(requiredTables) && requiredTables.length > 0) {
        errors.push("security_logs-only plans must have empty required_tables.");
      }
      if (Array.isArray(requiredColumns) && requiredColumns.length > 0) {
        errors.push("security_logs-only plans must have empty required_columns.");
      }
      if (Array.isArray(relationships) && relationships.length > 0) {
        errors.push("security_logs-only plans must have empty relationships.");
      }
      if (Array.isArray(sorting) && sorting.length > 0) {
        errors.push("security_logs-only plans must have empty sorting.");
      }
    }

    errors.push(...this._validate_execution_plan(
      normalizedPlan.execution_plan,
      normalizedPlan
    ));

    // Calculate missing tables/columns/relationships for backward compatibility
    const missingTables = [];
    const missingColumns = [];
    const missingRelationships = [];
    for (const err of errors) {
      if (err.includes("references unknown table:")) {
        const match = err.split("references unknown table:")[1]?.trim();
        if (match) missingTables.push(match);
      }
      if (err.includes("references unknown column:")) {
        const match = err.split("references unknown column:")[1]?.trim();
        if (match) missingColumns.push(match);
      }
      if (err.includes("undiscovered relationship:")) {
        const match = err.split("undiscovered relationship:")[1]?.trim();
        if (match) missingRelationships.push(match);
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors,
      plan: normalizedPlan,
      missing_tables: missingTables,
      missing_columns: missingColumns,
      missing_relationships: missingRelationships,
    };
  }
}

export function validate_question_plan(plan) {
  const validator = new QuestionPlanValidator();
  return validator.validate(plan);
}

export function validateQuestionPlan(plan) {
  return validate_question_plan(plan);
}

export default {
  QuestionPlanValidator,
  validate_question_plan,
  validateQuestionPlan,
};
