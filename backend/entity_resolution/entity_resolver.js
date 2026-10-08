import { loadAllContexts } from "../context/context_store.js";
import { getConnection, getDb2Connection } from "../database/connection.js";
import { validateReadOnlyQuery } from "../database/readonly_guard.js";

/**
 * Resolve explicit natural-language entity references against the
 * automatically discovered PostgreSQL Context Layer.
 *
 * PostgreSQL access is strictly READ-ONLY.
 *
 * This component performs deterministic candidate lookup only.
 * It does not perform semantic interpretation or decide the final
 * meaning of the user's question.
 */
export class EntityResolver {
  static IDENTIFIER_HINTS = [
    "id",
    "code",
    "reference",
    "number",
    "key",
    "name",
    "title",
    "label",
    "email",
    "username"
  ];

  static MAX_SOURCES = 8;
  static MAX_CANDIDATE_COLUMNS_PER_SOURCE = 24;
  static MAX_QUERY_BRANCH_RESULTS = 3;
  static MAX_TOTAL_RESULTS = 100;
  static MAX_WORKERS = 4;

  constructor(context = null, contexts = null) {
    this.IDENTIFIER_HINTS = EntityResolver.IDENTIFIER_HINTS;
    this.MAX_SOURCES = EntityResolver.MAX_SOURCES;
    this.MAX_CANDIDATE_COLUMNS_PER_SOURCE = EntityResolver.MAX_CANDIDATE_COLUMNS_PER_SOURCE;
    this.MAX_QUERY_BRANCH_RESULTS = EntityResolver.MAX_QUERY_BRANCH_RESULTS;
    this.MAX_TOTAL_RESULTS = EntityResolver.MAX_TOTAL_RESULTS;
    this.MAX_WORKERS = EntityResolver.MAX_WORKERS;

    if (contexts !== null && contexts !== undefined) {
      this.contexts = contexts;
    } else if (context !== null && context !== undefined) {
      if (typeof context === "object" && context.contexts && !context.tables && !context.source_id) {
        this.contexts = context.contexts;
      } else {
        const sourceId = context.source_id || "db1";
        if (typeof sourceId !== "string") {
          throw new Error("Entity context source_id must be a string.");
        }
        this.contexts = {
          [sourceId.trim().toLowerCase()]: context
        };
      }
    } else {
      this.contexts = loadAllContexts();
    }

    if (!this.contexts || typeof this.contexts !== "object" || Array.isArray(this.contexts)) {
      throw new Error("EntityResolver requires a valid Context Layer mapping.");
    }
  }

  // ------------------------------------------------------------------
  // Candidate schema discovery
  // ------------------------------------------------------------------

  /**
   * Discover a bounded set of identifier/display columns from one
   * PostgreSQL source.
   *
   * Primary keys are prioritized. Generic identifier hints are allowed
   * only because they come from schema metadata, not company schema.
   */
  _getCandidateColumns(sourceId, context) {
    const tables = (context && context.tables) || {};
    if (!tables || typeof tables !== "object") {
      return [];
    }

    const candidates = [];

    for (const [tableName, tableInfo] of Object.entries(tables)) {
      if (!tableInfo || typeof tableInfo !== "object") {
        continue;
      }

      const primaryKeys = new Set(
        (tableInfo.primary_keys || [])
          .filter(Boolean)
          .map(v => String(v).toLowerCase())
      );

      const columns = tableInfo.columns || [];
      if (!Array.isArray(columns)) {
        continue;
      }

      for (const column of columns) {
        if (!column || typeof column !== "object") {
          continue;
        }

        const rawColName = column.name;
        if (!rawColName) {
          continue;
        }

        const columnName = String(rawColName);
        const columnLower = columnName.toLowerCase();
        const isPrimaryKey = primaryKeys.has(columnLower);
        const hintScore = this._identifierHintScore(columnLower);

        if (!isPrimaryKey && hintScore <= 0) {
          continue;
        }

        const priority = isPrimaryKey ? 100 : hintScore;

        candidates.push({
          source_id: sourceId,
          table: String(tableName),
          column: columnName,
          priority
        });
      }
    }

    candidates.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      const tableCmp = a.table.toLowerCase().localeCompare(b.table.toLowerCase());
      if (tableCmp !== 0) return tableCmp;
      return a.column.toLowerCase().localeCompare(b.column.toLowerCase());
    });

    return candidates.slice(0, this.MAX_CANDIDATE_COLUMNS_PER_SOURCE);
  }

  _identifierHintScore(columnName) {
    let score = 0;
    for (const hint of this.IDENTIFIER_HINTS) {
      if (columnName === hint) {
        score = Math.max(score, 80);
      } else if (columnName.endsWith(`_${hint}`)) {
        score = Math.max(score, 70);
      } else if (columnName.includes(hint)) {
        score = Math.max(score, 40);
      }
    }
    return score;
  }

  // ------------------------------------------------------------------
  // Matching
  // ------------------------------------------------------------------

  static _matchValue(value, searchText) {
    if (value === null || value === undefined) {
      return null;
    }

    const valueText = String(value).trim();
    if (!valueText) {
      return null;
    }

    const valueLower = valueText.toLowerCase();
    const searchLower = searchText.toLowerCase();

    if (valueLower === searchLower) {
      return [1.0, "exact"];
    }

    if (valueLower.startsWith(searchLower)) {
      return [0.90, "prefix"];
    }

    if (valueLower.includes(searchLower)) {
      return [0.70, "partial"];
    }

    return null;
  }

  // ------------------------------------------------------------------
  // PostgreSQL connections
  // ------------------------------------------------------------------

  static async _getConnection(sourceId) {
    const normalized = String(sourceId).trim().toLowerCase();
    if (normalized === "db1") {
      return await getConnection("db1");
    }
    if (normalized === "db2") {
      return await getDb2Connection();
    }
    throw new Error(`Unsupported PostgreSQL entity-resolution source: '${sourceId}'`);
  }

  // ------------------------------------------------------------------
  // One-source search
  // ------------------------------------------------------------------

  /**
   * Search one PostgreSQL source with one parameterized UNION query.
   *
   * All identifiers are taken from discovered schema metadata and quoted.
   * Runtime search text is always parameterized.
   *
   * This method never modifies PostgreSQL.
   */
  async _searchSource(sourceId, context, searchText, limit) {
    const candidateColumns = this._getCandidateColumns(sourceId, context);
    if (!candidateColumns || candidateColumns.length === 0) {
      return [];
    }

    const connection = await EntityResolver._getConnection(sourceId);

    try {
      await connection.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;").catch(() => {});

      const branches = [];
      const parameters = [];
      const pattern = `%${searchText.toLowerCase()}%`;

      for (const candidate of candidateColumns) {
        const tableName = candidate.table;
        const columnName = candidate.column;

        const quotedTable = EntityResolver._quoteIdentifier(tableName);
        const quotedColumn = EntityResolver._quoteIdentifier(columnName);

        const p1 = `$${parameters.length + 1}`;
        const p2 = `$${parameters.length + 2}`;
        const p3 = `$${parameters.length + 3}`;
        const p4 = `$${parameters.length + 4}`;

        branches.push(
          `SELECT ` +
          `${p1} AS entity_table, ` +
          `${p2} AS entity_column, ` +
          `${quotedColumn} AS value ` +
          `FROM ${quotedTable} ` +
          `WHERE LOWER(CAST(${quotedColumn} AS TEXT)) ` +
          `LIKE ${p3} ` +
          `LIMIT ${p4}`
        );

        parameters.push(
          tableName,
          columnName,
          pattern,
          this.MAX_QUERY_BRANCH_RESULTS
        );
      }

      const query = branches.join("\nUNION ALL\n");

      validateReadOnlyQuery(query);

      let result;
      try {
        result = await connection.query({
          text: query,
          values: parameters,
          rowMode: "array"
        });
      } catch {
        result = await connection.query(query, parameters);
      }

      const rows = (result && result.rows) ? result.rows.slice(0, this.MAX_TOTAL_RESULTS) : [];

      const candidates = [];

      for (const row of rows) {
        let tableName, columnName, value;

        if (Array.isArray(row)) {
          if (row.length !== 3) continue;
          tableName = String(row[0]);
          columnName = String(row[1]);
          value = row[2];
        } else if (row && typeof row === "object") {
          tableName = String(row.entity_table ?? row[0] ?? "");
          columnName = String(row.entity_column ?? row[1] ?? "");
          value = row.value ?? row[2];
        } else {
          continue;
        }

        const match = EntityResolver._matchValue(value, searchText);
        if (!match) {
          continue;
        }

        const [confidence, matchType] = match;

        candidates.push({
          source_id: sourceId,
          entity_type: tableName,
          entity_table: tableName,
          entity_column: columnName,
          value: String(value),
          confidence,
          match_type: matchType,
          evidence: `${tableName}.${columnName}`
        });
      }

      return candidates;
    } finally {
      if (typeof connection.release === "function") {
        connection.release();
      } else if (typeof connection.close === "function") {
        connection.close();
      } else if (typeof connection.end === "function") {
        await connection.end().catch(() => {});
      }
    }
  }

  async _safeSearchSource(sourceId, context, searchText, limit) {
    try {
      return await this._searchSource(sourceId, context, searchText, limit);
    } catch {
      return [];
    }
  }

  // ------------------------------------------------------------------
  // Multi-source resolution
  // ------------------------------------------------------------------

  /**
   * Resolve an explicit entity reference.
   *
   * Searches selected PostgreSQL sources independently.
   *
   * Independent sources are queried concurrently, but their results are
   * never merged into a database-level relationship.
   */
  async resolve(searchText, limit = 5, sourceIds = null) {
    if (typeof searchText !== "string" || !searchText.trim()) {
      return [];
    }

    let queryText = searchText.trim();
    if (queryText.length > 256) {
      queryText = queryText.slice(0, 256);
    }

    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit <= 0
    ) {
      return [];
    }

    const selectedSources = this._resolveSourceIds(sourceIds);
    if (!selectedSources || selectedSources.length === 0) {
      return [];
    }

    const searchPromises = [];

    for (const sourceId of selectedSources) {
      const context = this.contexts[sourceId];
      if (!context || typeof context !== "object") {
        continue;
      }

      const sourceType = context.source_type;
      if (sourceType && sourceType !== "postgresql") {
        continue;
      }

      searchPromises.push(
        this._safeSearchSource(sourceId, context, queryText, limit)
      );
    }

    const settled = await Promise.allSettled(searchPromises);
    const results = [];

    for (const item of settled) {
      if (item.status === "fulfilled" && Array.isArray(item.value)) {
        results.push(...item.value);
      }
    }

    results.sort((a, b) => {
      const confDiff = (Number(b.confidence) || 0) - (Number(a.confidence) || 0);
      if (confDiff !== 0) return confDiff;

      const srcCmp = String(a.source_id || "").localeCompare(String(b.source_id || ""));
      if (srcCmp !== 0) return srcCmp;

      const tblCmp = String(a.entity_table || "").localeCompare(String(b.entity_table || ""));
      if (tblCmp !== 0) return tblCmp;

      return String(a.entity_column || "").localeCompare(String(b.entity_column || ""));
    });

    return results.slice(0, Math.min(limit, this.MAX_TOTAL_RESULTS));
  }

  _resolveSourceIds(sourceIds = null) {
    const rawKeys = Object.keys(this.contexts || {});
    const available = [];
    const seen = new Set();
    for (const key of rawKeys) {
      if (typeof key === "string" && key.trim()) {
        const norm = key.trim().toLowerCase();
        if (!seen.has(norm)) {
          seen.add(norm);
          available.push(norm);
        }
      }
    }

    let selected = [];
    if (sourceIds === null || sourceIds === undefined) {
      selected = available;
    } else {
      if (!Array.isArray(sourceIds)) {
        throw new Error("source_ids must be a list or null.");
      }
      const rawSelected = [];
      const seenSelected = new Set();
      for (const s of sourceIds) {
        if (typeof s === "string" && s.trim()) {
          const norm = s.trim().toLowerCase();
          if (!seenSelected.has(norm)) {
            seenSelected.add(norm);
            rawSelected.push(norm);
          }
        }
      }
      const availableSet = new Set(available);
      selected = rawSelected.filter(s => availableSet.has(s));
    }

    return selected.slice(0, this.MAX_SOURCES);
  }

  static _quoteIdentifier(identifier) {
    if (typeof identifier !== "string" || !identifier.trim()) {
      throw new Error("SQL identifier must be a non-empty string.");
    }
    return `"${identifier.trim().replace(/"/g, '""')}"`;
  }
}

// Attach snake_case aliases for compatibility
EntityResolver.prototype._get_candidate_columns = EntityResolver.prototype._getCandidateColumns;
EntityResolver.prototype._identifier_hint_score = EntityResolver.prototype._identifierHintScore;
EntityResolver._match_value = EntityResolver._matchValue;
EntityResolver._get_connection = EntityResolver._getConnection;
EntityResolver.prototype._search_source = EntityResolver.prototype._searchSource;
EntityResolver.prototype._safe_search_source = EntityResolver.prototype._safeSearchSource;
EntityResolver.prototype._resolve_source_ids = EntityResolver.prototype._resolveSourceIds;
EntityResolver._quote_identifier = EntityResolver._quoteIdentifier;

export default {
  EntityResolver
};
