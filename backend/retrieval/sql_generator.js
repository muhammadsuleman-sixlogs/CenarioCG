import { loadContext } from "../context/context_store.js";
import { validateReadOnlyQuery } from "../database/readonly_guard.js";
import { validateSqlSyntax } from "./sql_validator.js";
import { sanitizeSchemaContext } from "../security/sensitive_data_policy.js";

/**
 * Deterministic PostgreSQL SQL compiler.
 *
 * The semantic interpretation of the user's question has already happened
 * in QuestionPlanner.
 *
 * This class decides HOW to execute that validated intent:
 *
 *     RetrievalContract
 *         ->
 *     schema-grounded SQL
 *         ->
 *     read-only validation
 *
 * It does not:
 *     - call an LLM
 *     - reinterpret the question
 *     - invent tables
 *     - invent columns
 *     - invent relationships
 *     - join different PostgreSQL sources
 *     - store runtime values
 *     - modify PostgreSQL
 *
 * PostgreSQL remains strictly READ-ONLY.
 */
export class SQLGenerator {
  static ALLOWED_OPERATORS = new Set([
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

  static OPERATOR_ALIASES = {
    eq: "=",
    equals: "=",
    "==": "=",
    neq: "!=",
    not_equals: "!=",
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
  };

  static AGGREGATE_OPERATIONS = new Set([
    "count",
    "sum",
    "average",
    "avg",
    "mean",
    "minimum",
    "min",
    "maximum",
    "max",
  ]);

  static AGGREGATE_ALIASES = {
    avg: "average",
    mean: "average",
    min: "minimum",
    max: "maximum",
  };

  static SORT_DIRECTIONS = new Set(["asc", "desc"]);

  constructor(context = null, source_id = "db1") {
    if (!source_id || typeof source_id !== "string" || !source_id.trim()) {
      throw new Error("source_id must be a non-empty string.");
    }

    this.source_id = source_id.trim().toLowerCase();
    this.sourceId = this.source_id;

    this.context =
      context !== null && context !== undefined
        ? context
        : loadContext(this.source_id);

    if (!this.context || typeof this.context !== "object" || Array.isArray(this.context)) {
      throw new Error(`No Context Layer is available for PostgreSQL source '${this.source_id}'.`);
    }
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  generate(contract, source_id = null, runtime_bindings = null) {
    this._validate_contract(contract);

    const active_source_id = this._resolve_source_id(source_id, contract);

    if (active_source_id !== this.source_id) {
      throw new Error(
        `SQLGenerator source mismatch: generator is bound to '${this.source_id}', ` +
          `but execution requested '${active_source_id}'.`
      );
    }

    this._validate_contract_source(contract, active_source_id);

    const bindings = this._normalize_runtime_bindings(runtime_bindings);
    const schema_context = this._build_schema_context();

    let sql = this._compile_query(contract, schema_context, bindings);
    sql = this._normalize_sql(sql);

    validateReadOnlyQuery(sql);
    validateSqlSyntax(sql);

    return sql;
  }

  repair(query, database_error, contract, source_id = null, runtime_bindings = null) {
    if (!query || typeof query !== "string" || !query.trim()) {
      throw new Error("SQL query cannot be empty.");
    }

    if (!database_error || typeof database_error !== "string" || !database_error.trim()) {
      throw new Error("Database error cannot be empty.");
    }

    this._validate_contract(contract);

    return this.generate(contract, source_id, runtime_bindings);
  }

  // ------------------------------------------------------------------
  // Contract validation
  // ------------------------------------------------------------------

  _validate_contract(contract) {
    if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
      throw new Error("Retrieval contract must be a dictionary.");
    }

    const question = contract.question;
    if (question !== undefined && question !== null) {
      if (typeof question !== "string" || !question.trim()) {
        throw new Error("Retrieval contract question must be a non-empty string.");
      }
    }

    for (const field_name of [
      "required_tables",
      "required_columns",
      "relationships",
      "filters",
      "operations",
      "grouping",
      "sorting",
      "entities",
      "requested_metrics",
    ]) {
      const value = contract[field_name];
      if (value === undefined || value === null) {
        continue;
      }
      if (!Array.isArray(value)) {
        throw new Error(`Retrieval contract ${field_name} must be a list.`);
      }
    }

    const limit = contract.limit;
    if (limit !== undefined && limit !== null) {
      if (typeof limit !== "number" || !Number.isInteger(limit) || typeof limit === "boolean") {
        throw new Error("Retrieval contract limit must be an integer.");
      }
      if (limit < 1) {
        throw new Error("Retrieval contract limit must be greater than 0.");
      }
    }

    const data_sources = contract.data_sources !== undefined ? contract.data_sources : ["postgresql"];
    if (!Array.isArray(data_sources)) {
      throw new Error("Retrieval contract data_sources must be a list.");
    }

    const validSources = new Set(["postgresql", "security_logs"]);
    const invalid = data_sources.filter((v) => !validSources.has(v));
    if (invalid.length > 0) {
      throw new Error(`Unsupported data source(s): ${JSON.stringify(invalid)}`);
    }

    const postgresql_sources = contract.postgresql_sources !== undefined ? contract.postgresql_sources : [];
    if (!Array.isArray(postgresql_sources)) {
      throw new Error("Retrieval contract postgresql_sources must be a list.");
    }

    const query_shape = contract.query_shape !== undefined ? contract.query_shape : "auto";
    if (typeof query_shape !== "string") {
      throw new Error("contract query_shape must be a string.");
    }

    const validShapes = new Set(["auto", "direct", "cte", "subquery"]);
    if (!validShapes.has(query_shape.trim().toLowerCase())) {
      throw new Error(`Unsupported deterministic query_shape: '${query_shape}'`);
    }
  }

  _resolve_source_id(source_id, contract) {
    if (source_id !== null && source_id !== undefined) {
      if (typeof source_id !== "string" || !source_id.trim()) {
        throw new Error("source_id must be a non-empty string.");
      }
      return source_id.trim().toLowerCase();
    }

    const contract_source = contract.source_id;
    if (typeof contract_source === "string" && contract_source.trim()) {
      return contract_source.trim().toLowerCase();
    }

    const sources = contract.postgresql_sources || [];
    const normalized = sources
      .filter((v) => typeof v === "string" && v.trim())
      .map((v) => v.trim().toLowerCase());

    if (normalized.length === 1) {
      return normalized[0];
    }

    return this.source_id;
  }

  _validate_contract_source(contract, active_source_id) {
    const contract_sources = contract.postgresql_sources || [];
    const normalized = new Set(
      contract_sources
        .filter((v) => typeof v === "string" && v.trim())
        .map((v) => v.trim().toLowerCase())
    );

    if (normalized.size > 0 && !normalized.has(active_source_id)) {
      throw new Error(
        `Retrieval contract does not authorize PostgreSQL source '${active_source_id}'.`
      );
    }

    const declared_source = contract.source_id;
    if (
      typeof declared_source === "string" &&
      declared_source.trim() &&
      declared_source.trim().toLowerCase() !== active_source_id
    ) {
      throw new Error(
        `Retrieval contract source mismatch: contract specifies '${declared_source.trim().toLowerCase()}', ` +
          `but execution requested '${active_source_id}'.`
      );
    }
  }

  // ------------------------------------------------------------------
  // Schema
  // ------------------------------------------------------------------

  _build_schema_context() {
    const tables = {};
    const raw_tables = this.context.tables || {};

    if (!raw_tables || typeof raw_tables !== "object" || Array.isArray(raw_tables)) {
      throw new Error("Context Layer tables must be a dictionary.");
    }

    for (const [table_name, table_info] of Object.entries(raw_tables)) {
      if (!table_info || typeof table_info !== "object" || Array.isArray(table_info)) {
        continue;
      }

      const raw_columns = table_info.columns || [];
      const columns = [];

      if (Array.isArray(raw_columns)) {
        for (const column of raw_columns) {
          if (!column || typeof column !== "object" || Array.isArray(column)) {
            continue;
          }
          const name = column.name;
          if (!name) continue;

          columns.push({
            name: String(name),
            data_type: column.data_type !== undefined ? column.data_type : column.type,
          });
        }
      }

      tables[String(table_name)] = {
        columns,
        primary_keys: Array.isArray(table_info.primary_keys) ? [...table_info.primary_keys] : [],
      };
    }

    const schema_context = {
      source_id: this.source_id,
      tables,
      relationships: Array.isArray(this.context.relationships) ? this.context.relationships : [],
      business_relationships: Array.isArray(this.context.business_relationships)
        ? this.context.business_relationships
        : [],
    };

    return sanitizeSchemaContext(schema_context);
  }

  _tables() {
    const context = this._build_schema_context();
    const tables = context.tables || {};
    if (!tables || typeof tables !== "object" || Array.isArray(tables)) {
      throw new Error("Context Layer tables must be a dictionary.");
    }
    return tables;
  }

  _table_lookup() {
    const lookup = {};
    for (const table_name of Object.keys(this._tables())) {
      lookup[table_name.toLowerCase()] = table_name;
    }
    return lookup;
  }

  _resolve_table(table_name) {
    if (!table_name || typeof table_name !== "string" || !table_name.trim()) {
      throw new Error("Table name must be a non-empty string.");
    }

    const requested = table_name.trim();
    const lookup = this._table_lookup();
    const actual = lookup[requested.toLowerCase()];

    if (!actual) {
      throw new Error(`Table is not present in the discovered Context Layer: '${requested}'`);
    }

    return actual;
  }

  _columns(table_name) {
    const table = this._resolve_table(table_name);
    const table_info = this._tables()[table] || {};
    const result = {};

    for (const column of table_info.columns || []) {
      if (!column || typeof column !== "object" || Array.isArray(column)) {
        continue;
      }
      const name = column.name;
      if (!name) continue;
      result[String(name).toLowerCase()] = column;
    }

    return result;
  }

  _resolve_column(table_name, column_name) {
    const actual_table = this._resolve_table(table_name);

    if (!column_name || typeof column_name !== "string" || !column_name.trim()) {
      throw new Error("Column name must be a non-empty string.");
    }

    let requested = column_name.trim();
    if (requested.includes(".")) {
      const parts = requested.split(".").map((p) => p.trim());
      if (parts.length === 2 && parts[1]) {
        requested = parts[1];
      }
    }

    const columns = this._columns(actual_table);
    const column = columns[requested.toLowerCase()];

    if (!column) {
      throw new Error(
        `Column is not present in the discovered Context Layer: ${actual_table}.${requested}`
      );
    }

    return String(column.name !== undefined ? column.name : requested);
  }

  _column_metadata(table_name, column_name) {
    const actual_column = this._resolve_column(table_name, column_name);
    return this._columns(table_name)[actual_column.toLowerCase()];
  }

  // ------------------------------------------------------------------
  // Contract compilation
  // ------------------------------------------------------------------

  _compile_query(contract, schema_context, runtime_bindings) {
    const required_tables = this._normalize_required_tables(contract);
    if (!required_tables.length) {
      throw new Error("Retrieval contract requires at least one table.");
    }

    const contract_rels = contract.relationships || [];
    const context_rels = this.context.relationships || [];
    const combined_relationships = Array.isArray(contract_rels) ? [...contract_rels] : [];
    if (Array.isArray(context_rels)) {
      combined_relationships.push(
        ...context_rels.filter((rel) => rel && typeof rel === "object" && !Array.isArray(rel))
      );
    }

    const selected_tables = this._build_joined_table_set(
      required_tables,
      combined_relationships
    );

    const where_clauses = this._compile_filters(
      contract.filters || [],
      selected_tables,
      runtime_bindings
    );

    where_clauses.push(
      ...this._compile_runtime_bindings(runtime_bindings, selected_tables)
    );

    const grouping = this._compile_grouping(
      contract.grouping || [],
      selected_tables
    );

    const sorting = this._compile_sorting(
      contract.sorting || [],
      selected_tables
    );

    const requested_metrics = contract.requested_metrics || [];
    const operations = (contract.operations || [])
      .filter((v) => typeof v === "string" && v.trim())
      .map((v) => String(v).trim().toLowerCase());

    const has_metrics =
      (Array.isArray(requested_metrics) && requested_metrics.length > 0) ||
      operations.some((op) => SQLGenerator.AGGREGATE_OPERATIONS.has(op));

    let select_sql = "";
    let aggregate_query = false;

    if (has_metrics) {
      const [agg_select, is_agg] = this._compile_aggregate_select(
        contract,
        selected_tables,
        grouping,
        requested_metrics,
        operations
      );
      select_sql = agg_select;
      aggregate_query = is_agg;
    } else {
      select_sql = this._compile_projection(contract, selected_tables);
      aggregate_query = false;
    }

    const from_sql = this._compile_from_and_joins(
      required_tables,
      combined_relationships
    );

    const distinct = this._uses_distinct(contract);

    // Ranking with grouping means "latest/top row per group", not SQL
    // aggregation. Use DISTINCT ON so non-grouped selected columns
    // remain valid under PostgreSQL.
    const is_ranking_query =
      operations.includes("ranking") && !has_metrics && grouping.length > 0;

    let select_keyword = "SELECT";
    if (is_ranking_query) {
      select_keyword = `SELECT DISTINCT ON (${grouping.join(", ")})`;
    } else if (distinct) {
      select_keyword = "SELECT DISTINCT";
    }

    const query_parts = [
      `${select_keyword} ${select_sql}`,
      `FROM ${from_sql}`,
    ];

    if (where_clauses.length > 0) {
      query_parts.push(
        "WHERE " + where_clauses.map((v) => `(${v})`).join(" AND ")
      );
    }

    if (grouping.length > 0 && (aggregate_query || has_metrics)) {
      query_parts.push(`GROUP BY ${grouping.join(", ")}`);
    }

    const order_by = this._compile_order_by(sorting, grouping, is_ranking_query);
    if (order_by.length > 0) {
      query_parts.push(`ORDER BY ${order_by.join(", ")}`);
    }

    const limit = contract.limit;
    if (limit !== undefined && limit !== null) {
      query_parts.push(`LIMIT ${parseInt(limit, 10)}`);
    }

    let query = query_parts.join("\n");

    const query_shape = String(contract.query_shape || "auto").trim().toLowerCase();
    if (query_shape === "cte") {
      query =
        "WITH retrieval_result AS (\n" +
        this._indent_sql(query) +
        "\n)\nSELECT *\nFROM retrieval_result";
    } else if (query_shape === "subquery") {
      query =
        "SELECT *\nFROM (\n" +
        this._indent_sql(query) +
        "\n) AS retrieval_result";
    }

    return query;
  }

  _normalize_required_tables(contract) {
    const raw = contract.required_tables || [];
    const normalized = [];

    for (const value of raw) {
      if (!value || typeof value !== "string" || !value.trim()) {
        throw new Error("required_tables must contain non-empty strings.");
      }
      normalized.push(this._resolve_table(value));
    }

    // Preserve insertion order and unique values
    return Array.from(new Set(normalized));
  }

  // ------------------------------------------------------------------
  // Relationship / JOIN compilation
  // ------------------------------------------------------------------

  _normalize_relationship(relationship) {
    if (!relationship || typeof relationship !== "object" || Array.isArray(relationship)) {
      return null;
    }

    const source_table = relationship.source_table;
    const source_column = relationship.source_column;
    const target_table = relationship.target_table;
    const target_column = relationship.target_column;

    if (
      ![source_table, source_column, target_table, target_column].every(
        (v) => typeof v === "string" && v.trim()
      )
    ) {
      return null;
    }

    const result = {
      source_table: this._resolve_table(source_table),
      source_column: this._resolve_column(source_table, source_column),
      target_table: this._resolve_table(target_table),
      target_column: this._resolve_column(target_table, target_column),
    };

    const relationship_source = relationship.source_id;
    if (typeof relationship_source === "string" && relationship_source.trim()) {
      result.source_id = relationship_source.trim().toLowerCase();
    }

    return result;
  }

  _normalized_relationships(relationships) {
    if (!Array.isArray(relationships)) {
      throw new Error("relationships must be a list.");
    }

    const result = [];
    for (const rel of relationships) {
      const normalized = this._normalize_relationship(rel);
      if (normalized !== null) {
        result.push(normalized);
      }
    }
    return result;
  }

  _relationship_graph(relationships) {
    const graph = {};

    for (const rel of relationships) {
      const source_table = rel.source_table;
      const target_table = rel.target_table;

      if (!graph[source_table]) graph[source_table] = [];
      graph[source_table].push([target_table, rel]);

      const reverse = {
        source_table: target_table,
        source_column: rel.target_column,
        target_table: source_table,
        target_column: rel.source_column,
      };

      if (rel.source_id) {
        reverse.source_id = rel.source_id;
      }

      if (!graph[target_table]) graph[target_table] = [];
      graph[target_table].push([source_table, reverse]);
    }

    return graph;
  }

  _build_joined_table_set(required_tables, relationships) {
    if (required_tables.length <= 1) {
      return [...required_tables];
    }

    const normalized_relationships = this._normalized_relationships(relationships);
    const graph = this._relationship_graph(normalized_relationships);

    const connected = new Set([required_tables[0]]);
    const joined_order = [required_tables[0]];
    const remaining = new Set(required_tables.slice(1));

    while (remaining.size > 0) {
      const path = this._find_path_from_connected_to_targets(
        connected,
        remaining,
        graph
      );

      if (!path) {
        const missing = Array.from(remaining).sort();
        throw new Error(
          `No complete discovered relationship path exists for required tables: ${JSON.stringify(missing)}`
        );
      }

      const [path_nodes] = path;

      for (const node of path_nodes) {
        if (!joined_order.includes(node)) {
          joined_order.push(node);
        }
        connected.add(node);
        remaining.delete(node);
      }
    }

    return joined_order;
  }

  _find_path_from_connected_to_targets(connected, targets, graph) {
    const queue = [];
    const parent = {};

    for (const start of Array.from(connected).sort()) {
      queue.push(start);
      parent[start] = [null, null];
    }

    let target = null;

    while (queue.length > 0) {
      const current = queue.shift();

      if (targets.has(current) && !connected.has(current)) {
        target = current;
        break;
      }

      const neighbors = [...(graph[current] || [])].sort((a, b) =>
        a[0].localeCompare(b[0])
      );

      for (const [neighbor, relationship] of neighbors) {
        if (parent[neighbor] !== undefined) {
          continue;
        }

        parent[neighbor] = [current, relationship];
        queue.push(neighbor);
      }
    }

    if (target === null) {
      return null;
    }

    const nodes = [];
    const edges = [];
    let current = target;

    while (current !== null) {
      nodes.push(current);
      const [previous, relationship] = parent[current];
      if (relationship !== null) {
        edges.push(relationship);
      }
      current = previous;
    }

    nodes.reverse();
    edges.reverse();

    return [nodes, edges];
  }

  _compile_from_and_joins(required_tables, relationships) {
    if (!required_tables.length) {
      throw new Error("At least one required table is necessary.");
    }

    const normalized_relationships = this._normalized_relationships(relationships);
    const graph = this._relationship_graph(normalized_relationships);

    const base_table = required_tables[0];
    const joined = new Set([base_table]);
    const pieces = [this._quote_identifier(base_table)];
    const pending = new Set(required_tables.slice(1));

    while (pending.size > 0) {
      const path = this._find_path_from_connected_to_targets(
        joined,
        pending,
        graph
      );

      if (!path) {
        throw new Error(
          "Required PostgreSQL tables cannot be connected using discovered relationships."
        );
      }

      const [path_nodes, path_edges] = path;

      for (let index = 0; index < path_edges.length; index++) {
        const relationship = path_edges[index];
        const left_table = relationship.source_table;
        const left_column = relationship.source_column;
        const right_table = relationship.target_table;
        const right_column = relationship.target_column;

        let new_table;
        let new_column;
        let existing_table;
        let existing_column;

        if (joined.has(left_table)) {
          new_table = right_table;
          new_column = right_column;
          existing_table = left_table;
          existing_column = left_column;
        } else if (joined.has(right_table)) {
          new_table = left_table;
          new_column = left_column;
          existing_table = right_table;
          existing_column = right_column;
        } else {
          // For intermediate path nodes, the path itself must still determine
          // which side is already reachable.
          if (index > 0) {
            const previous_table = path_nodes[index];
            if (previous_table === left_table) {
              new_table = right_table;
              new_column = right_column;
              existing_table = left_table;
              existing_column = left_column;
            } else {
              new_table = left_table;
              new_column = left_column;
              existing_table = right_table;
              existing_column = right_column;
            }
          } else {
            throw new Error("Unable to compile discovered JOIN path.");
          }
        }

        pieces.push(
          `JOIN ${this._quote_identifier(new_table)} ON ` +
            `${this._qualified_identifier(existing_table, existing_column)} = ` +
            `${this._qualified_identifier(new_table, new_column)}`
        );

        joined.add(new_table);
        pending.delete(new_table);
      }
    }

    return pieces.join("\n");
  }

  // ------------------------------------------------------------------
  // Projection
  // ------------------------------------------------------------------

  _compile_projection(contract, selected_tables) {
    const required_columns = contract.required_columns || [];
    const expressions = [];

    for (const reference of required_columns) {
      const [table_name, column_name] = this._parse_field_reference(
        reference,
        selected_tables
      );
      expressions.push(
        this._qualified_identifier(table_name, column_name)
      );
    }

    if (expressions.length > 0) {
      return expressions.join(", ");
    }

    // Never fall back to SELECT * for an unconstrained retrieval.
    // Use discovered primary keys as the smallest meaningful result.
    for (const table_name of selected_tables) {
      const table_info = this._tables()[table_name] || {};
      const primary_keys = table_info.primary_keys || [];

      for (const primary_key of primary_keys) {
        if (!primary_key || typeof primary_key !== "string") {
          continue;
        }
        const column_name = this._resolve_column(table_name, primary_key);
        expressions.push(
          this._qualified_identifier(table_name, column_name)
        );
      }
    }

    if (!expressions.length) {
      throw new Error(
        "Retrieval contract did not provide any required output columns, " +
          "and no discovered primary key is available for a safe projection."
      );
    }

    return Array.from(new Set(expressions)).join(", ");
  }

  // ------------------------------------------------------------------
  // Aggregation / metrics
  // ------------------------------------------------------------------

  _compile_aggregate_select(contract, selected_tables, grouping, requested_metrics, operations) {
    const expressions = [];

    for (const field of grouping) {
      expressions.push(this._resolve_field_expression(field, selected_tables));
    }

    const metrics = Array.isArray(requested_metrics) ? requested_metrics : [];

    if (metrics.length > 0) {
      for (const metric of metrics) {
        expressions.push(this._compile_metric(metric, selected_tables));
      }
    } else {
      const aggregate_operations = operations
        .filter((op) => SQLGenerator.AGGREGATE_OPERATIONS.has(op))
        .map((op) => SQLGenerator.AGGREGATE_ALIASES[op] || op);

      for (const operation of aggregate_operations) {
        expressions.push(
          this._compile_implicit_metric(operation, contract, selected_tables)
        );
      }
    }

    if (!expressions.length) {
      throw new Error(
        "An aggregate retrieval requires at least one grouping field or requested metric."
      );
    }

    return [expressions.join(", "), true];
  }

  _compile_metric(metric, selected_tables) {
    if (!metric || typeof metric !== "object" || Array.isArray(metric)) {
      throw new Error("Each requested metric must be an object.");
    }

    let operation = String(metric.operation || "").trim().toLowerCase();
    operation = SQLGenerator.AGGREGATE_ALIASES[operation] || operation;

    if (!new Set(["count", "sum", "average", "minimum", "maximum"]).has(operation)) {
      throw new Error(`Unsupported requested metric operation: '${operation}'`);
    }

    const source_id = metric.source_id;
    if (
      source_id !== null &&
      source_id !== undefined &&
      String(source_id).trim().toLowerCase() !== this.source_id
    ) {
      throw new Error(
        `Requested metric source_id does not match SQLGenerator source '${this.source_id}'.`
      );
    }

    let table_name = metric.table;
    const column_name = metric.column;

    if (!table_name || typeof table_name !== "string" || !table_name.trim()) {
      throw new Error("Requested metric table is required.");
    }

    table_name = this._resolve_table(table_name);

    if (!selected_tables.includes(table_name)) {
      throw new Error(
        `Requested metric table '${table_name}' is not part of the selected query scope.`
      );
    }

    let expression = "";

    if (!column_name || typeof column_name !== "string" || !column_name.trim()) {
      if (operation === "count") {
        expression = "COUNT(*)";
      } else {
        throw new Error(`Metric operation '${operation}' requires a column.`);
      }
    } else {
      const resolved_col = this._resolve_column(table_name, column_name);
      const qualified = this._qualified_identifier(table_name, resolved_col);
      const distinct = Boolean(metric.distinct);

      if (operation === "count") {
        expression = distinct ? `COUNT(DISTINCT ${qualified})` : `COUNT(${qualified})`;
      } else if (operation === "sum") {
        expression = `SUM(${qualified})`;
      } else if (operation === "average") {
        expression = `AVG(${qualified})`;
      } else if (operation === "minimum") {
        expression = `MIN(${qualified})`;
      } else {
        expression = `MAX(${qualified})`;
      }
    }

    const label = metric.label;
    if (typeof label === "string" && label.trim()) {
      expression += ` AS ${this._quote_identifier(label.trim())}`;
    }

    return expression;
  }

  _compile_implicit_metric(operation, contract, selected_tables) {
    const required_columns = (contract.required_columns || []).filter(
      (v) => typeof v === "string"
    );

    if (operation === "count") {
      return `COUNT(*) AS ${this._quote_identifier("count")}`;
    }

    if (!required_columns.length) {
      throw new Error(
        `Operation '${operation}' requires a numeric/value column or requested_metrics.`
      );
    }

    const candidates = [];

    for (const reference of required_columns) {
      const [table_name, column_name] = this._parse_field_reference(
        reference,
        selected_tables
      );
      const metadata = this._column_metadata(table_name, column_name);
      const data_type = String(metadata.data_type || metadata.type || "").toLowerCase();
      candidates.push([reference, data_type]);
    }

    const numericTokens = [
      "integer",
      "bigint",
      "smallint",
      "numeric",
      "decimal",
      "real",
      "double",
      "money",
    ];

    const numeric_candidates = candidates
      .filter(([, data_type]) => numericTokens.some((tok) => data_type.includes(tok)))
      .map(([reference]) => reference);

    if (numeric_candidates.length !== 1) {
      throw new Error(
        `Operation '${operation}' requires an unambiguous metric column in the Retrieval Contract.`
      );
    }

    const [table_name, column_name] = this._parse_field_reference(
      numeric_candidates[0],
      selected_tables
    );
    const qualified = this._qualified_identifier(table_name, column_name);

    const functions = {
      sum: "SUM",
      average: "AVG",
      minimum: "MIN",
      maximum: "MAX",
    };

    return `${functions[operation]}(${qualified}) AS ${this._quote_identifier(operation)}`;
  }

  // ------------------------------------------------------------------
  // Filters
  // ------------------------------------------------------------------

  _compile_filters(filters, selected_tables, runtime_bindings = null) {
    if (!Array.isArray(filters)) {
      throw new Error("filters must be a list.");
    }

    const bound_targets = new Set();
    for (const binding of runtime_bindings || []) {
      if (binding && typeof binding === "object") {
        const t = String(binding.to_table || "").trim().toLowerCase();
        const c = String(binding.to_column || "").trim().toLowerCase();
        bound_targets.add(`${t}.${c}`);
      }
    }

    const result = [];

    for (const filter_value of filters) {
      if (!filter_value || typeof filter_value !== "object" || Array.isArray(filter_value)) {
        throw new Error("Each filter must be an object.");
      }

      let reference = filter_value.field || filter_value.column;
      let table_name = filter_value.table;

      if (typeof reference === "string" && reference.includes(".") && !table_name) {
        const parts = reference.split(".");
        table_name = parts[0];
        reference = parts.slice(1).join(".");
      }

      if (!table_name || typeof table_name !== "string" || !table_name.trim()) {
        throw new Error("Filter table is required.");
      }

      if (!reference || typeof reference !== "string" || !reference.trim()) {
        throw new Error("Filter column is required.");
      }

      table_name = this._resolve_table(table_name);

      if (!selected_tables.includes(table_name)) {
        throw new Error(
          `Filter references table '${table_name}' outside the selected query scope.`
        );
      }

      const column_name = this._resolve_column(table_name, reference);

      // Skip contract filters that are dynamically supplied by runtime_bindings.
      if (bound_targets.has(`${table_name.toLowerCase()}.${column_name.toLowerCase()}`)) {
        continue;
      }

      let operator = filter_value.operator !== undefined ? filter_value.operator : "=";
      if (typeof operator !== "string") {
        throw new Error("Filter operator must be a string.");
      }

      operator = SQLGenerator.OPERATOR_ALIASES[operator.trim().toLowerCase()] || operator.trim().toLowerCase();

      if (!SQLGenerator.ALLOWED_OPERATORS.has(operator)) {
        throw new Error(`Unsupported filter operator: '${operator}'`);
      }

      const raw_val = filter_value.value;

      // Skip step placeholder values or null values for operators that require values
      if (!new Set(["is_null", "is_not_null"]).has(operator)) {
        if (raw_val === null || raw_val === undefined) {
          continue;
        }
        if (typeof raw_val === "string") {
          if (
            raw_val.startsWith("$") ||
            raw_val.startsWith("s1.") ||
            raw_val.startsWith("s2.") ||
            raw_val.startsWith("s3.") ||
            new Set(["s1", "s2", "s3"]).has(raw_val)
          ) {
            continue;
          }
        }
      }

      const qualified = this._qualified_identifier(table_name, column_name);
      result.push(
        this._compile_filter_expression(qualified, operator, raw_val)
      );
    }

    return result;
  }

  _compile_filter_expression(qualified, operator, value) {
    if (operator === "is_null") {
      return `${qualified} IS NULL`;
    }

    if (operator === "is_not_null") {
      return `${qualified} IS NOT NULL`;
    }

    if (operator === "in") {
      if (value === null || value === undefined) {
        return "FALSE";
      }

      let listVal = value;
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        listVal = [value];
      } else if (value instanceof Set) {
        listVal = Array.from(value);
      } else if (!Array.isArray(value)) {
        throw new Error("IN filter value must be a list.");
      }

      if (!listVal.length) {
        return "FALSE";
      }

      return `${qualified} IN (${listVal.map((item) => this._sql_literal(item)).join(", ")})`;
    }

    if (operator === "not_in") {
      if (value === null || value === undefined) {
        return "TRUE";
      }

      let listVal = value;
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        listVal = [value];
      } else if (value instanceof Set) {
        listVal = Array.from(value);
      } else if (!Array.isArray(value)) {
        throw new Error("NOT_IN filter value must be a list.");
      }

      if (!listVal.length) {
        return "TRUE";
      }

      return `${qualified} NOT IN (${listVal.map((item) => this._sql_literal(item)).join(", ")})`;
    }

    if (operator === "contains") {
      return `${qualified} ILIKE ${this._sql_literal("%" + String(value) + "%")}`;
    }

    if (operator === "starts_with") {
      return `${qualified} ILIKE ${this._sql_literal(String(value) + "%")}`;
    }

    if (operator === "ends_with") {
      return `${qualified} ILIKE ${this._sql_literal("%" + String(value))}`;
    }

    return `${qualified} ${operator} ${this._sql_literal(value)}`;
  }

  // ------------------------------------------------------------------
  // Runtime bindings
  // ------------------------------------------------------------------

  _normalize_runtime_bindings(runtime_bindings) {
    if (runtime_bindings === null || runtime_bindings === undefined) {
      return [];
    }

    if (!runtime_bindings || typeof runtime_bindings !== "object" || Array.isArray(runtime_bindings)) {
      throw new Error("runtime_bindings must be a dictionary.");
    }

    const bindings = runtime_bindings.bindings || [];
    if (!Array.isArray(bindings)) {
      throw new Error("runtime_bindings bindings must be a list.");
    }

    const normalized = [];
    const seen_indexes = new Set();

    for (const binding of bindings) {
      if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
        throw new Error("Each runtime binding must be an object.");
      }

      const index = binding.index;
      if (
        typeof index !== "number" ||
        !Number.isInteger(index) ||
        typeof index === "boolean" ||
        index < 0
      ) {
        throw new Error("Runtime binding index must be a non-negative integer.");
      }

      if (seen_indexes.has(index)) {
        throw new Error(`Duplicate runtime binding index: ${index}`);
      }

      seen_indexes.add(index);

      const to_table = binding.to_table;
      const to_column = binding.to_column;

      if (!to_table || typeof to_table !== "string" || !to_table.trim()) {
        throw new Error("Runtime binding to_table must be non-empty.");
      }

      if (!to_column || typeof to_column !== "string" || !to_column.trim()) {
        throw new Error("Runtime binding to_column must be non-empty.");
      }

      let operator = String(binding.operator !== undefined ? binding.operator : "in")
        .trim()
        .toLowerCase();

      if (operator === "eq" || operator === "=" || operator === "==") {
        operator = "equals";
      }

      if (!new Set(["in", "not_in", "equals"]).has(operator)) {
        throw new Error(`Unsupported runtime binding operator: '${operator}'`);
      }

      normalized.push({
        index,
        to_table: this._resolve_table(to_table),
        to_column: this._resolve_column(to_table, to_column),
        operator,
      });
    }

    return normalized.sort((a, b) => a.index - b.index);
  }

  _compile_runtime_bindings(bindings, selected_tables) {
    const result = [];

    for (const binding of bindings) {
      const table_name = binding.to_table;
      const column_name = binding.to_column;

      if (!selected_tables.includes(table_name)) {
        throw new Error(
          `Runtime binding target table '${table_name}' is not in the selected query scope.`
        );
      }

      const qualified = this._qualified_identifier(table_name, column_name);
      const operator = binding.operator;
      const placeholder = "%s";

      if (operator === "in") {
        result.push(`CAST(${qualified} AS text) = ANY(${placeholder})`);
      } else if (operator === "not_in") {
        result.push(`CAST(${qualified} AS text) <> ALL(${placeholder})`);
      } else {
        result.push(`CAST(${qualified} AS text) = ${placeholder}`);
      }
    }

    return result;
  }

  // ------------------------------------------------------------------
  // GROUP BY / ORDER BY
  // ------------------------------------------------------------------

  _compile_grouping(grouping, selected_tables) {
    if (!grouping || !grouping.length) {
      return [];
    }

    const result = [];
    for (const field of grouping) {
      result.push(this._resolve_field_expression(field, selected_tables));
    }

    return Array.from(new Set(result));
  }

  _compile_order_by(sorting, grouping, ranking_query) {
    if (ranking_query && grouping.length > 0) {
      const order_by = grouping.map((field) => `${field} ASC`);
      const seen = new Set(grouping.map((field) => field.toLowerCase()));

      for (const item of sorting) {
        const expression = item.replace(/\s+(asc|desc)$/i, "").trim();
        if (seen.has(expression.toLowerCase())) {
          continue;
        }
        order_by.push(item);
        seen.add(expression.toLowerCase());
      }

      return order_by;
    }

    return [...sorting];
  }

  _compile_sorting(sorting, selected_tables) {
    if (!sorting || !sorting.length) {
      return [];
    }

    const result = [];

    for (const item of sorting) {
      if (typeof item === "string") {
        let expression = item.trim();
        let direction = "asc";

        const parts = expression.split(/\s+/);
        if (
          parts.length >= 2 &&
          SQLGenerator.SORT_DIRECTIONS.has(parts[parts.length - 1].toLowerCase())
        ) {
          direction = parts[parts.length - 1].toLowerCase();
          expression = parts.slice(0, parts.length - 1).join(" ");
        }

        result.push(
          `${this._resolve_field_expression(expression, selected_tables)} ${direction.toUpperCase()}`
        );
        continue;
      }

      if (item && typeof item === "object" && !Array.isArray(item)) {
        const field = item.field || item.column;

        if (!field || typeof field !== "string") {
          throw new Error("Sorting field must be a string.");
        }

        const direction = String(item.direction !== undefined ? item.direction : "asc")
          .trim()
          .toLowerCase();

        if (!SQLGenerator.SORT_DIRECTIONS.has(direction)) {
          throw new Error(`Unsupported sort direction: '${direction}'`);
        }

        result.push(
          `${this._resolve_field_expression(field, selected_tables)} ${direction.toUpperCase()}`
        );
        continue;
      }

      throw new Error("Each sorting item must be a string or object.");
    }

    return result;
  }

  // ------------------------------------------------------------------
  // Field resolution
  // ------------------------------------------------------------------

  _parse_field_reference(reference, selected_tables) {
    if (!reference || typeof reference !== "string" || !reference.trim()) {
      throw new Error("Field reference must be a non-empty string.");
    }

    const value = reference.trim();

    if (value.includes(".")) {
      const parts = value.split(".");
      let table_name = parts[0];
      const column_name = parts.slice(1).join(".");

      table_name = this._resolve_table(table_name);

      if (!selected_tables.includes(table_name)) {
        throw new Error(
          `Field references table '${table_name}' outside the selected query scope.`
        );
      }

      const resolved_column = this._resolve_column(table_name, column_name);
      return [table_name, resolved_column];
    }

    const matches = [];

    for (const table_name of selected_tables) {
      try {
        const resolved_column = this._resolve_column(table_name, value);
        matches.push([table_name, resolved_column]);
      } catch {
        // Table does not have this column
      }
    }

    if (!matches.length) {
      throw new Error(
        `Field is not present in the selected Context Layer scope: '${value}'`
      );
    }

    if (matches.length > 1) {
      throw new Error(
        `Ambiguous unqualified field reference: '${value}'. Use an explicit table.column reference.`
      );
    }

    return matches[0];
  }

  _resolve_field_expression(reference, selected_tables) {
    const [table_name, column_name] = this._parse_field_reference(
      reference,
      selected_tables
    );
    return this._qualified_identifier(table_name, column_name);
  }

  // ------------------------------------------------------------------
  // DISTINCT
  // ------------------------------------------------------------------

  _uses_distinct(contract) {
    const operations = new Set(
      (contract.operations || [])
        .filter((v) => typeof v === "string")
        .map((v) => v.trim().toLowerCase())
    );

    return operations.has("distinct") || Boolean(contract.distinct);
  }

  // ------------------------------------------------------------------
  // SQL safety / serialization
  // ------------------------------------------------------------------

  _quote_identifier(identifier) {
    if (!identifier || typeof identifier !== "string" || !identifier.trim()) {
      throw new Error("SQL identifier must be a non-empty string.");
    }
    return `"${identifier.trim().replace(/"/g, '""')}"`;
  }

  _qualified_identifier(table_name, column_name) {
    return `${this._quote_identifier(table_name)}.${this._quote_identifier(column_name)}`;
  }

  _sql_literal(value) {
    if (value === null || value === undefined) {
      return "NULL";
    }

    if (typeof value === "boolean") {
      return value ? "TRUE" : "FALSE";
    }

    if (typeof value === "number") {
      return String(value);
    }

    if (value instanceof Date) {
      return `'${value.toISOString().replace(/'/g, "''")}'`;
    }

    const text_value = String(value);
    return `'${text_value.replace(/'/g, "''")}'`;
  }

  _normalize_sql(query) {
    if (!query || typeof query !== "string" || !query.trim()) {
      throw new Error("Generated SQL cannot be empty.");
    }
    return query.trim();
  }

  _indent_sql(query) {
    return query
      .split("\n")
      .map((line) => "    " + line)
      .join("\n");
  }

  // ------------------------------------------------------------------
  // Backward-compatible camelCase aliases
  // ------------------------------------------------------------------
  resolveTable(tableName) {
    return this._resolve_table(tableName);
  }

  resolveColumn(tableName, columnName) {
    return this._resolve_column(tableName, columnName);
  }
}

/**
 * Backward-compatible helper.
 */
export function generate_sql(contract, source_id = "db1") {
  const generator = new SQLGenerator(null, source_id);
  return generator.generate(contract, source_id);
}

export const generateSql = generate_sql;

export default {
  SQLGenerator,
  generate_sql,
  generateSql,
};
