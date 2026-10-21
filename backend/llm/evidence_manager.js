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
import { isSensitiveFieldName } from "../security/sensitive_data_policy.js";
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
      sampled: Boolean(retrieval.sampled || retrieval.is_sampled),
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
      sampled: Boolean(retrieval.sampled || retrieval.is_sampled),
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

    if (sourceType === "external_api") {
      return { ...this._preparePostgresqlEvidence(retrieval, sources), source_type: "external_api", resource: retrieval.resource || null };
    }

    return this._preparePostgresqlEvidence(retrieval, sources);
  }

  /**
   * Build the answer-facing view of already-sanitized evidence.
   *
   * The pipeline's top-level sources are also used for API graph/source
   * tracing and therefore retain their original provenance objects internally.
   * SourceTracker provenance and retrieval wrappers include complete row
   * arrays, while the same rows are already available in the authoritative
   * lineage items.  Build a compact answer copy and remove only those
   * redundant wrapper payloads; never mutate the internal evidence object.
   */
  prepareAnswerEvidence(evidence, options = {}) {
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
      return {};
    }

    // `items[*].row` is the canonical answer-facing record representation.
    // The retrieval and provenance wrappers below may contain the same rows,
    // but those copies remain available on the internal evidence object used
    // for API responses, source tracing, fallback answers, and conversation
    // continuity.  Strip only duplicate row arrays from this answer copy.
    const shouldKeepBusinessDate = question => /\b(?:date|time|timestamp|when|created|creation|updated|meeting)\b/i.test(String(question || ""));
    const projectRow = (row, sourceId, table) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return row;
      const context = options?.contexts?.[sourceId];
      if (!context) {
        const copy = { ...row };
        delete copy._internal;
        return copy;
      }
      const roles = context?.semantic_catalog?.entities?.[table]?.column_roles || {};
      const keepDates = shouldKeepBusinessDate(options?.question);
      const result = {};
      for (const [key, value] of Object.entries(row)) {
        if (key === "_internal" || isSensitiveFieldName(key)) continue;
        const role = roles[key]?.role;
        if (role === "internal_id" || role === "foreign_key") continue;
        if (/(?:^|_)(?:id|uuid|key)$|(?:^|_)(?:id|uuid|key)_/i.test(key) && !key.endsWith("_label")) continue;
        if (/^(?:created_at|updated_at|deleted_at)$/i.test(key) && !keepDates) continue;
        result[key] = value;
      }
      return result;
    };

    const stripRows = value => {
      if (Array.isArray(value)) return value.map(stripRows);
      if (!value || typeof value !== "object") return value;

      const result = {};
      for (const [key, item] of Object.entries(value)) {
        if (key === "rows" || key === "_internal") continue;
        result[key] = stripRows(item);
      }
      return result;
    };

    const answerEvidence = { ...evidence };

    // The pipeline normally supplies lineage items.  Preserve compatibility
    // for callers that pass the older EvidenceManager.prepare() shape directly
    // by deriving the same canonical items before removing wrapper arrays.
    if (!Array.isArray(evidence.items)) {
      const canonicalItems = [];
      const sources = Array.isArray(evidence.sources) ? evidence.sources : [];
      let evidenceSequence = 0;
      const appendRows = (rows, sourceId = null, source = {}) => {
        if (!Array.isArray(rows)) return;
        for (const row of rows) {
          canonicalItems.push({
            evidence_id: `answer-row-${++evidenceSequence}`,
            source_id: sourceId || source.source_id || null,
            execution_step_id: null,
            table: source.tables?.[0] || null,
            retrieval_status: "unknown",
            retrieved_at: null,
            truncated: false,
            row: projectRow(stripRows(row), sourceId || source.source_id || null, source.tables?.[0] || null)
          });
        }
      };

      const postgresqlSource = sources.find(source => source?.source_type === "postgresql") || sources[0] || {};
      if (Array.isArray(evidence.postgresql?.rows)) {
        appendRows(evidence.postgresql.rows, evidence.postgresql.source_id, postgresqlSource);
      } else if (Array.isArray(evidence.rows)) {
        appendRows(evidence.rows, evidence.postgresql?.source_id, postgresqlSource);
      } else if (evidence.postgresql_multi && typeof evidence.postgresql_multi === "object") {
        for (const [sourceId, retrieval] of Object.entries(evidence.postgresql_multi)) {
          const source = sources.find(item => item?.source_id === sourceId) || {};
          appendRows(retrieval?.rows, sourceId, source);
        }
      }

      const securityEvents = Array.isArray(evidence.security_logs?.events)
        ? evidence.security_logs.events
        : (Array.isArray(evidence.security_logs?.retrieval?.events)
          ? evidence.security_logs.retrieval.events
          : []);
      for (const [index, row] of securityEvents.entries()) {
        canonicalItems.push({
          evidence_id: `answer-event-${index + 1}`,
          source_id: "security_logs",
          execution_step_id: null,
          table: null,
          retrieval_status: "unknown",
          retrieved_at: null,
          truncated: false,
          row
        });
      }
      answerEvidence.items = canonicalItems;
    } else if (Array.isArray(answerEvidence.items)) {
      answerEvidence.items = answerEvidence.items.map(item => ({
        ...item,
        row: projectRow(stripRows(item?.row), item?.source_id || null, item?.table || null)
      }));
    }

    if (Array.isArray(evidence.sources)) {
      answerEvidence.sources = evidence.sources.map(stripRows);
    }

    if (Array.isArray(evidence.rows)) {
      delete answerEvidence.rows;
    }

    if (evidence.postgresql && typeof evidence.postgresql === "object" && !Array.isArray(evidence.postgresql)) {
      answerEvidence.postgresql = stripRows(evidence.postgresql);
    }

    if (evidence.postgresql_multi && typeof evidence.postgresql_multi === "object" && !Array.isArray(evidence.postgresql_multi)) {
      answerEvidence.postgresql_multi = stripRows(evidence.postgresql_multi);
    }

    if (evidence.complex_execution && typeof evidence.complex_execution === "object" && !Array.isArray(evidence.complex_execution)) {
      const complex = { ...evidence.complex_execution };
      if (Array.isArray(complex.steps)) {
        complex.steps = complex.steps.map(step => {
          if (!step || typeof step !== "object" || Array.isArray(step)) return step;
          const compactStep = { ...step };
          if (step.evidence && typeof step.evidence === "object") {
            compactStep.evidence = stripRows(step.evidence);
          }
          return compactStep;
        });
      }
      if (complex.final_result && typeof complex.final_result === "object") {
        complex.final_result = stripRows(complex.final_result);
      }
      answerEvidence.complex_execution = complex;
    }

    if (evidence.final_result && typeof evidence.final_result === "object" && !Array.isArray(evidence.final_result)) {
      answerEvidence.final_result = stripRows(evidence.final_result);
    }

    if (evidence.security_logs && typeof evidence.security_logs === "object" && !Array.isArray(evidence.security_logs)) {
      const security = { ...evidence.security_logs };
      // Security events are also represented once in items[*].row. Keep
      // structured security data intact because it has no item-row mirror.
      if (security.retrieval && typeof security.retrieval === "object" && !Array.isArray(security.retrieval)) {
        const retrieval = { ...security.retrieval };
        delete retrieval.events;
        security.retrieval = retrieval;
      }
      answerEvidence.security_logs = security;
    }

    if (options && options.relationship && typeof options.relationship === "object") {
      return this._prepareRelationshipAnswerEvidence(answerEvidence, options.relationship);
    }

    return answerEvidence;
  }

  /**
   * Build a relationship-focused answer view without changing the internal
   * evidence object.  Intermediate rows remain available to tracing, API
   * responses, fallbacks, and conversation state; only the final relationship
   * rows and source-qualified identity mappings are sent to the answer model.
   */
  _prepareRelationshipAnswerEvidence(answerEvidence, relationship = {}) {
    const allItems = Array.isArray(answerEvidence?.items) ? answerEvidence.items : [];
    const finalStepId = relationship.final_step_id || null;
    const requestedStepIds = new Set(Array.isArray(relationship.step_ids) ? relationship.step_ids.map(String) : []);
    const finalItems = requestedStepIds.size > 0
      ? allItems.filter(item => requestedStepIds.has(String(item?.execution_step_id || "")))
      : finalStepId
      ? allItems.filter(item => String(item?.execution_step_id || "") === String(finalStepId))
      : allItems;

    const requestedSourceIds = new Set([
      ...finalItems.map(item => item?.source_id).filter(Boolean),
      ...(Array.isArray(relationship.source_ids) ? relationship.source_ids : []),
      ...((relationship.resolution?.mappings || []).flatMap(mapping => [mapping.from_source_id, mapping.to_source_id]).filter(Boolean))
    ].map(value => String(value).toLowerCase()));

    const compactSources = (Array.isArray(answerEvidence?.sources) ? answerEvidence.sources : [])
      .filter(source => !requestedSourceIds.size || requestedSourceIds.has(String(source?.source_id || "").toLowerCase()))
      .map(source => ({
        source_type: source?.source_type || null,
        source_id: source?.source_id || null,
        source: source?.source || source?.source_id || null,
        entities: Array.isArray(source?.entities) ? [...source.entities] : [],
        tables: Array.isArray(source?.tables) ? [...source.tables] : [],
        columns: Array.isArray(source?.columns) ? [...source.columns] : [],
        sql_columns: Array.isArray(source?.sql_columns) ? [...source.sql_columns] : [],
        row_count: Number.isFinite(Number(source?.row_count)) ? Number(source.row_count) : null
      }));

    const compactItems = finalItems.map(item => ({
      evidence_id: item?.evidence_id || null,
      source_id: item?.source_id || null,
      execution_step_id: item?.execution_step_id || null,
      table: item?.table || null,
      retrieval_status: item?.retrieval_status || "unknown",
      retrieved_at: item?.retrieved_at || null,
      truncated: Boolean(item?.truncated),
      row: item?.row && typeof item.row === "object" ? { ...item.row } : item?.row
    }));

    const resolution = relationship.resolution && typeof relationship.resolution === "object"
      ? relationship.resolution
      : {};
    const compactResolution = {
      mode: resolution.mode || null,
      scope: resolution.scope || null,
      status: resolution.status || null,
      requested_count: Number.isFinite(Number(resolution.requested_count)) ? Number(resolution.requested_count) : null,
      matched_identity_count: Number.isFinite(Number(resolution.matched_identity_count)) ? Number(resolution.matched_identity_count) : null,
      association_count: Number.isFinite(Number(resolution.association_count)) ? Number(resolution.association_count) : null,
      missing_count: Number.isFinite(Number(resolution.missing_count)) ? Number(resolution.missing_count) : null,
      conflict_count: Number.isFinite(Number(resolution.conflict_count)) ? Number(resolution.conflict_count) : null,
      mappings: Array.isArray(resolution.mappings) ? resolution.mappings.map(mapping => ({ ...mapping })) : [],
      missing_identities: Array.isArray(resolution.missing_identities) ? [...resolution.missing_identities] : [],
      conflict_identities: Array.isArray(resolution.conflict_identities) ? [...resolution.conflict_identities] : []
    };

    return {
      source_type: "postgresql",
      evidence_scope: "verified_relationship",
      items: compactItems,
      sources: compactSources,
      relationship_path: Array.isArray(relationship.path)
        ? relationship.path.map(step => ({
          source_id: step?.source_id || null,
          table: step?.table || null,
          column: step?.column || null
        }))
        : [],
      relationship_evidence: Array.isArray(relationship.evidence_relationships)
        ? [...relationship.evidence_relationships]
        : [],
      relationship_resolution: compactResolution,
      row_count: compactItems.length,
      truncated: compactItems.some(item => item.truncated)
    };
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
EvidenceManager.prototype.prepare_answer_evidence = EvidenceManager.prototype.prepareAnswerEvidence;

export default {
  EvidenceManager
};
