/**
 * Prepare and bound retrieved evidence before it is sent to the LLM.
 *
 * Supports:
 * - PostgreSQL rows
 * - Security/SIEM event resources
 * - Security/SIEM structured resources
 * - Source/provenance metadata
 *
 * This class does not access or modify any data source.
 */
export class EvidenceManager {
  static EVENT_RESOURCES = new Set([
    "security_logs",
    "cli_audit_logs",
    "workspace_security_logs"
  ]);

  static STRUCTURED_RESOURCES = new Set([
    "security_logs_summary",
    "workspace_siem_status",
    "security_overview"
  ]);

  constructor(maxRows = 50, maxEvents = 50, maxStructuredItems = 50) {
    if (typeof maxRows !== "number" || !Number.isInteger(maxRows) || maxRows < 1) {
      throw new Error("max_rows must be a positive integer.");
    }

    if (typeof maxEvents !== "number" || !Number.isInteger(maxEvents) || maxEvents < 1) {
      throw new Error("max_events must be a positive integer.");
    }

    if (
      typeof maxStructuredItems !== "number" ||
      !Number.isInteger(maxStructuredItems) ||
      maxStructuredItems < 1
    ) {
      throw new Error("max_structured_items must be a positive integer.");
    }

    this.maxRows = maxRows;
    this.maxEvents = maxEvents;
    this.maxStructuredItems = maxStructuredItems;

    this.max_rows = maxRows;
    this.max_events = maxEvents;
    this.max_structured_items = maxStructuredItems;

    this.EVENT_RESOURCES = EvidenceManager.EVENT_RESOURCES;
    this.STRUCTURED_RESOURCES = EvidenceManager.STRUCTURED_RESOURCES;
  }

  // --------------------------------------------------
  // PostgreSQL
  // --------------------------------------------------

  _preparePostgresqlEvidence(retrieval, sources) {
    const rows = Array.isArray(retrieval?.rows) ? retrieval.rows : [];
    const columns = Array.isArray(retrieval?.columns) ? retrieval.columns : [];

    const limitedRows = rows.slice(0, this.maxRows);
    const limitedSources = [];

    for (const source of sources) {
      if (!source || typeof source !== "object" || Array.isArray(source)) {
        continue;
      }

      const sourceCopy = { ...source };
      const sourceRows = sourceCopy.rows;

      if (Array.isArray(sourceRows)) {
        sourceCopy.rows = sourceRows.slice(0, this.maxRows);
      }

      limitedSources.push(sourceCopy);
    }

    return {
      source_type: "postgresql",
      rows: limitedRows,
      columns: columns,
      row_count: limitedRows.length,
      total_retrieved: rows.length,
      truncated: rows.length > this.maxRows,
      sources: limitedSources
    };
  }

  // --------------------------------------------------
  // Security event resources
  // --------------------------------------------------

  _prepareSecurityEventEvidence(retrieval, sources, resource) {
    const events = Array.isArray(retrieval?.events) ? retrieval.events : [];
    const limitedEvents = events.slice(0, this.maxEvents);
    const limitedSources = [];

    for (const source of sources) {
      if (!source || typeof source !== "object" || Array.isArray(source)) {
        continue;
      }

      const sourceCopy = { ...source };
      const sourceEvents = sourceCopy.events;

      if (Array.isArray(sourceEvents)) {
        sourceCopy.events = sourceEvents.slice(0, this.maxEvents);
      }

      limitedSources.push(sourceCopy);
    }

    return {
      source_type: "security_logs_api",
      resource: resource,
      events: limitedEvents,
      event_count: limitedEvents.length,
      total_retrieved: events.length,
      truncated: events.length > this.maxEvents,
      sources: limitedSources
    };
  }

  // --------------------------------------------------
  // Security structured resources
  // --------------------------------------------------

  _boundStructuredData(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const items = Object.entries(value).slice(0, this.maxStructuredItems);
      const res = {};
      for (const [key, item] of items) {
        res[String(key)] = this._boundStructuredData(item);
      }
      return res;
    }

    if (Array.isArray(value)) {
      return value
        .slice(0, this.maxStructuredItems)
        .map(item => this._boundStructuredData(item));
    }

    return value;
  }

  _prepareSecurityStructuredEvidence(retrieval, sources, resource) {
    const data = retrieval?.data;
    const boundedData = this._boundStructuredData(data);
    const limitedSources = [];

    for (const source of sources) {
      if (!source || typeof source !== "object" || Array.isArray(source)) {
        continue;
      }

      const sourceCopy = { ...source };
      if ("data" in sourceCopy) {
        sourceCopy.data = this._boundStructuredData(sourceCopy.data);
      }

      limitedSources.push(sourceCopy);
    }

    return {
      source_type: "security_logs_api",
      resource: resource,
      data: boundedData,
      sources: limitedSources
    };
  }

  // --------------------------------------------------
  // Main entry point (Python parity: prepare(retrieval, sources))
  // --------------------------------------------------

  prepare(retrieval, sources) {
    if (!retrieval || typeof retrieval !== "object" || Array.isArray(retrieval)) {
      throw new Error("Retrieval result must be a dictionary.");
    }

    if (!Array.isArray(sources)) {
      throw new Error("Sources must be a list.");
    }

    const sourceType = retrieval.source_type;

    if (sourceType === "security_logs_api") {
      const resource = retrieval.resource || "security_logs";

      if (this.EVENT_RESOURCES.has(resource)) {
        return this._prepareSecurityEventEvidence(retrieval, sources, resource);
      }

      if (this.STRUCTURED_RESOURCES.has(resource)) {
        return this._prepareSecurityStructuredEvidence(retrieval, sources, resource);
      }

      throw new Error(`Unsupported security resource: '${resource}'`);
    }

    return this._preparePostgresqlEvidence(retrieval, sources);
  }

  // Backward-compatible method for JS callers passing options object
  prepareEvidence(options = {}) {
    const {
      retrieval = null,
      postgresqlRetrieval = null,
      postgresqlRetrievals = null,
      securityLogsRetrieval = null,
      sources = []
    } = options;

    if (retrieval && typeof retrieval === "object") {
      return this.prepare(retrieval, Array.isArray(sources) ? sources : []);
    }

    const evidence = {};

    if (postgresqlRetrieval && typeof postgresqlRetrieval === "object") {
      const rows = Array.isArray(postgresqlRetrieval.rows) ? postgresqlRetrieval.rows : [];
      evidence.postgresql = {
        rows: rows.slice(0, this.maxRows),
        row_count: rows.length,
        columns: postgresqlRetrieval.columns || [],
        source_id: postgresqlRetrieval.source_id || "db1"
      };
    }

    if (postgresqlRetrievals && typeof postgresqlRetrievals === "object") {
      evidence.postgresql_multi = {};
      for (const [srcId, ret] of Object.entries(postgresqlRetrievals)) {
        if (!ret) continue;
        const rows = Array.isArray(ret.rows) ? ret.rows : [];
        evidence.postgresql_multi[srcId] = {
          rows: rows.slice(0, this.maxRows),
          row_count: rows.length,
          columns: ret.columns || [],
          source_id: srcId
        };
      }
    }

    if (securityLogsRetrieval && typeof securityLogsRetrieval === "object") {
      const events = Array.isArray(securityLogsRetrieval.events) ? securityLogsRetrieval.events : [];
      evidence.security_logs = {
        events: events.slice(0, this.maxEvents),
        event_count: events.length,
        resource: securityLogsRetrieval.resource || "security_logs",
        truncated: Boolean(securityLogsRetrieval.truncated)
      };
    }

    evidence.provenance = (sources || []).map(s => ({
      source_id: s.source_id,
      source_type: s.source_type,
      tables: s.tables,
      entities: s.entities,
      row_count: s.row_count
    }));

    return evidence;
  }
}

// Attach snake_case aliases
EvidenceManager.prototype._prepare_postgresql_evidence = EvidenceManager.prototype._preparePostgresqlEvidence;
EvidenceManager.prototype._prepare_security_event_evidence = EvidenceManager.prototype._prepareSecurityEventEvidence;
EvidenceManager.prototype._bound_structured_data = EvidenceManager.prototype._boundStructuredData;
EvidenceManager.prototype._prepare_security_structured_evidence = EvidenceManager.prototype._prepareSecurityStructuredEvidence;

export default {
  EvidenceManager
};
