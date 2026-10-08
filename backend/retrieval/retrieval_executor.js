import { getConnection, getDb2Connection } from "../database/connection.js";
import { validateReadOnlyQuery } from "../database/readonly_guard.js";
import { validateSqlSyntax } from "./sql_validator.js";

/**
 * Final PostgreSQL execution boundary.
 *
 * Responsibilities:
 *   - validate source selection
 *   - validate read-only SQL
 *   - execute parameterized SQL
 *   - protect the PostgreSQL session as read-only
 *   - return source-preserved retrieval results
 *
 * This class does NOT:
 *   - generate SQL
 *   - call an LLM
 *   - modify database data/schema
 *   - convert execution failures into empty results
 *
 * PostgreSQL remains strictly READ-ONLY.
 */
export class RetrievalExecutor {
  static CONNECTIONS = {
    db1: getConnection,
    db2: getDb2Connection,
  };

  static MAX_ROWS_RETURNED = 50000;
  static FETCH_BATCH_SIZE = 1000;

  constructor() {
    this.MAX_ROWS_RETURNED = RetrievalExecutor.MAX_ROWS_RETURNED;
    this.FETCH_BATCH_SIZE = RetrievalExecutor.FETCH_BATCH_SIZE;
  }

  async execute(query, sourceId = "db1", parameters = null) {
    const source_id = this._validate_source(sourceId);
    const validQuery = this._validate_query(query);
    const normalized_parameters = this._normalize_parameters(parameters);

    const connectionFactory = RetrievalExecutor.CONNECTIONS[source_id];
    const connection = await connectionFactory();

    try {
      // Enforce read-only session
      if (typeof connection.query === "function") {
        await connection.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;");
        await connection.query("SET default_transaction_read_only = on;");
      }

      // Convert %s placeholders to $1, $2, ... for node-postgres if needed
      let pgQuery = validQuery;
      let finalParams = normalized_parameters;

      if (pgQuery.includes("%s")) {
        let paramIndex = 1;
        pgQuery = pgQuery.replace(/%s/g, () => `$${paramIndex++}`);
      }

      const result = await connection.query(pgQuery, finalParams);
      const rows = result.rows || [];

      if (rows.length > this.MAX_ROWS_RETURNED) {
        throw new Error(
          `Retrieval exceeded the maximum allowed result size of ${this.MAX_ROWS_RETURNED} rows.`
        );
      }

      const column_names = (result.fields || []).map((field) => field.name);
      const row_count = rows.length;
      const retrieval_status = row_count > 0 ? "success_with_data" : "success_empty";

      return {
        retrieval_status,
        rows,
        row_count,
        columns: column_names,
        provenance: {
          query: validQuery,
          source_type: "postgresql",
          source_id,
          source: source_id,
        },
      };
    } finally {
      if (typeof connection.release === "function") {
        connection.release();
      } else if (typeof connection.close === "function") {
        connection.close();
      } else if (typeof connection.end === "function") {
        connection.end();
      }
    }
  }

  _validate_source(sourceId) {
    if (!sourceId || typeof sourceId !== "string" || !sourceId.trim()) {
      throw new Error("source_id must be a non-empty string.");
    }
    const normalized = sourceId.trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(RetrievalExecutor.CONNECTIONS, normalized)) {
      throw new Error(`Unsupported PostgreSQL source: ${normalized}`);
    }
    return normalized;
  }

  _validate_query(query) {
    if (!query || typeof query !== "string" || !query.trim()) {
      throw new Error("query must be a non-empty string.");
    }
    const normalized = query.trim();
    validateReadOnlyQuery(normalized);
    validateSqlSyntax(normalized);
    return normalized;
  }

  _normalize_parameters(parameters) {
    if (parameters === null || parameters === undefined) {
      return [];
    }
    if (!Array.isArray(parameters)) {
      throw new Error("PostgreSQL parameters must be a list or tuple.");
    }
    return [...parameters];
  }

  // CamelCase aliases
  validateSource(sourceId) {
    return this._validate_source(sourceId);
  }

  validateQuery(query) {
    return this._validate_query(query);
  }

  normalizeParameters(parameters) {
    return this._normalize_parameters(parameters);
  }
}

/**
 * Convenience wrapper for read-only PostgreSQL retrieval.
 */
export async function execute_retrieval(query, source_id = "db1", parameters = null) {
  const executor = new RetrievalExecutor();
  return executor.execute(query, source_id, parameters);
}

export const executeRetrieval = execute_retrieval;

export default {
  RetrievalExecutor,
  execute_retrieval,
  executeRetrieval,
};
