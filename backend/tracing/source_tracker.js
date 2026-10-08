export const TABLE_PATTERN = /\b(?:FROM|JOIN|UPDATE|INTO)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi;
export const COLUMN_PATTERN = /\bSELECT\s+([\s\S]*?)\s+\bFROM\b/i;

/**
 * Track dynamic provenance for retrieved data.
 *
 * The tracker derives table/entity and column information
 * from the retrieval contract and generated SQL.
 *
 * It does not access or modify PostgreSQL.
 * It does not make any LLM/API calls.
 *
 * source_id identifies which PostgreSQL source produced
 * the retrieved data, for example:
 *     db1
 *     db2
 */
export class SourceTracker {
  _extract_tables_from_sql(query) {
    if (!query || typeof query !== "string") {
      return [];
    }

    const tables = [];
    let match;
    const regex = new RegExp(TABLE_PATTERN.source, TABLE_PATTERN.flags);

    while ((match = regex.exec(query)) !== null) {
      const table = match[1];
      if (table && !tables.includes(table)) {
        tables.push(table);
      }
    }

    return tables;
  }

  extractTablesFromSql(query) {
    return this._extract_tables_from_sql(query);
  }

  _extract_columns_from_sql(query) {
    if (!query || typeof query !== "string") {
      return [];
    }

    const match = COLUMN_PATTERN.exec(query);
    if (!match) {
      return [];
    }

    const selectSection = match[1];
    const parts = selectSection.split(",");
    const columns = [];

    for (const part of parts) {
      let expression = part.trim();
      if (!expression) {
        continue;
      }

      // Remove aliases
      expression = expression.replace(/\s+AS\s+[\w"]+$/i, "").trim();

      // Ignore SELECT *
      if (expression === "*") {
        continue;
      }

      if (!columns.includes(expression)) {
        columns.push(expression);
      }
    }

    return columns;
  }

  extractColumnsFromSql(query) {
    return this._extract_columns_from_sql(query);
  }

  build_source(query, retrieval, contract = null, source_id = "db1") {
    if (!query || typeof query !== "string" || !query.trim()) {
      throw new Error("Query cannot be empty.");
    }

    if (!retrieval || typeof retrieval !== "object" || Array.isArray(retrieval)) {
      throw new Error("Retrieval result must be a dictionary.");
    }

    if (!source_id || typeof source_id !== "string" || !source_id.trim()) {
      throw new Error("source_id must be a non-empty string.");
    }

    const rows = Array.isArray(retrieval.rows) ? retrieval.rows : [];
    const columns = Array.isArray(retrieval.columns) ? retrieval.columns : [];

    const tables = this._extract_tables_from_sql(query);
    const sql_columns = this._extract_columns_from_sql(query);

    // Prefer validated contract information when available.
    let contract_tables = [];
    if (contract && Array.isArray(contract.required_tables)) {
      contract_tables = contract.required_tables;
    }

    const entities = Array.from(new Set([...contract_tables, ...tables]));

    return {
      source_type: "postgresql",
      source_id: source_id.trim(),
      source: source_id.trim(),
      entities,
      tables,
      columns,
      sql_columns,
      query,
      row_count: rows.length,
      rows,
    };
  }

  buildSource(query, retrieval, contract = null, sourceId = "db1") {
    return this.build_source(query, retrieval, contract, sourceId);
  }

  build_sources(query, retrieval, contract = null, source_id = "db1") {
    const source = this.build_source(query, retrieval, contract, source_id);
    return [source];
  }

  buildSources(query, retrieval, contract = null, sourceId = "db1") {
    return this.build_sources(query, retrieval, contract, sourceId);
  }
}

export default {
  TABLE_PATTERN,
  COLUMN_PATTERN,
  SourceTracker,
};
