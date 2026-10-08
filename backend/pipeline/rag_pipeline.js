import { ContextManager } from "../context/context_manager.js";
import { loadAllContexts, loadContext } from "../context/context_store.js";
import { extractEntitySearchText } from "../entity_resolution/entity_search.js";
import { EntityResolver } from "../entity_resolution/entity_resolver.js";
import { normalizeEntityCandidates } from "../entity_resolution/entity_normalizer.js";
import { selectEntity } from "../entity_resolution/entity_selector.js";
import { QuestionPlanner } from "../planning/question_planner.js";
import { QuestionPlanValidator } from "../planning/question_plan_validator.js";
import { createRetrievalContract } from "../retrieval/retrieval_contract.js";
import { RetrievalExecutor } from "../retrieval/retrieval_executor.js";
import { SQLGenerator } from "../retrieval/sql_generator.js";
import { SourceTracker } from "../tracing/source_tracker.js";
import { SecurityLogRetriever } from "../security_logs/retriever.js";
import { EvidenceManager } from "../llm/evidence_manager.js";
import { AnswerGenerator } from "../llm/answer_generator.js";
import { sanitizeApiResponse, sanitizeEvidence } from "../security/output_security_policy.js";
import { isSensitiveQuestionIntent } from "../security/sensitive_data_policy.js";
import { validateReadOnlyQuery } from "../database/readonly_guard.js";
import { validateSqlSyntax } from "../retrieval/sql_validator.js";
import { getConnection, getDb2Connection } from "../database/connection.js";

// Optional dynamic loaders for planning/retrieval components that may be migrated later
let ComplexQueryPlanner = class {
  should_decompose() { return false; }
  shouldDecompose() { return false; }
  build() { return null; }
};

try {
  const mod = await import("../planning/complex_query_planner.js");
  if (mod.ComplexQueryPlanner) {
    ComplexQueryPlanner = mod.ComplexQueryPlanner;
  }
} catch {
  // Not yet migrated in planning folder
}

let QueryPlanExecutor = class {
  execute() { return { status: "failed", steps: {} }; }
};

try {
  const mod = await import("../retrieval/query_plan_executor.js");
  if (mod.QueryPlanExecutor) {
    QueryPlanExecutor = mod.QueryPlanExecutor;
  }
} catch {
  // Not yet migrated in retrieval folder
}

/**
 * Check whether a PostgreSQL execution error indicates a repairable SQL issue.
 */
function isSqlRepairableError(err) {
  if (!err) return false;
  const code = String(err.code || "");
  const repairCodes = new Set(["42803", "42804", "42703", "42P01", "22P02", "42883"]);
  if (repairCodes.has(code)) return true;

  const msg = String(err.message || "").toLowerCase();
  return (
    msg.includes("does not exist") ||
    msg.includes("group by") ||
    msg.includes("invalid input syntax") ||
    msg.includes("type mismatch") ||
    msg.includes("cannot be matched") ||
    msg.includes("undefined column") ||
    msg.includes("undefined table") ||
    msg.includes("undefined function") ||
    msg.includes("datatype mismatch")
  );
}

export class RAGPipeline {
  static ALLOWED_DATA_SOURCES = new Set(["postgresql", "security_logs"]);

  static ALLOWED_SECURITY_RESOURCES = new Set([
    "security_logs",
    "cli_audit_logs",
    "security_logs_summary",
    "workspace_security_logs",
    "workspace_siem_status",
    "security_overview"
  ]);

  static DEFAULT_SECURITY_RESOURCE = "security_logs";

  constructor(contextManager = null, options = {}) {
    this.ALLOWED_DATA_SOURCES = RAGPipeline.ALLOWED_DATA_SOURCES;
    this.ALLOWED_SECURITY_RESOURCES = RAGPipeline.ALLOWED_SECURITY_RESOURCES;
    this.DEFAULT_SECURITY_RESOURCE = RAGPipeline.DEFAULT_SECURITY_RESOURCE;

    this.context_manager = contextManager || new ContextManager();
    this.contextManager = this.context_manager;

    this.entity_resolver = new EntityResolver();
    this.entityResolver = this.entity_resolver;

    this.planner = new QuestionPlanner();
    this.plan_validator = new QuestionPlanValidator();
    this.planValidator = this.plan_validator;

    this.complex_query_planner = options.complex_query_planner || new ComplexQueryPlanner();
    this.complexQueryPlanner = this.complex_query_planner;

    this.query_plan_executor = options.query_plan_executor || new QueryPlanExecutor();
    this.queryPlanExecutor = this.query_plan_executor;

    this.sql_generators = {};
    this.sqlGenerators = this.sql_generators;

    this.executor = new RetrievalExecutor();
    this.source_tracker = new SourceTracker();
    this.sourceTracker = this.source_tracker;

    this.security_log_retriever = new SecurityLogRetriever();
    this.securityLogRetriever = this.security_log_retriever;

    this.evidence_manager = new EvidenceManager();
    this.evidenceManager = this.evidence_manager;

    this.answer_generator = new AnswerGenerator();
    this.answerGenerator = this.answer_generator;
  }

  _validateQuestion(question) {
    if (typeof question !== "string") {
      throw new Error("Question must be a string.");
    }

    const trimmed = question.trim();

    if (!trimmed) {
      throw new Error("Question cannot be empty.");
    }

    if (trimmed.length > 4000) {
      throw new Error("Question is too long. Please keep it under 4000 characters.");
    }

    return trimmed;
  }

  _getConversationContext() {
    const history = typeof this.context_manager.get_history === "function"
      ? this.context_manager.get_history()
      : this.context_manager.getHistory();

    const entities = typeof this.context_manager.get_entities === "function"
      ? this.context_manager.get_entities()
      : this.context_manager.getEntities();

    return {
      history,
      entities
    };
  }

  async _resolveEntity(question, conversationContext) {
    const searchText = extractEntitySearchText(question);
    if (!searchText) {
      return;
    }

    const candidates = await this.entity_resolver.resolve(searchText);
    const normalizedCandidates = normalizeEntityCandidates(candidates);
    const resolvedEntity = selectEntity(normalizedCandidates);

    if (resolvedEntity) {
      conversationContext.entities = [
        ...(conversationContext.entities || []),
        resolvedEntity
      ];
    }
  }

  _getDataSources(plan) {
    const dataSources = plan.data_sources || ["postgresql"];

    if (!Array.isArray(dataSources)) {
      throw new Error("Question plan data_sources must be a list.");
    }

    if (dataSources.length === 0) {
      throw new Error("Question plan did not select a data source.");
    }

    const invalidSources = dataSources.filter(
      source => !this.ALLOWED_DATA_SOURCES.has(source)
    );

    if (invalidSources.length > 0) {
      throw new Error(
        `Question plan selected unsupported data source(s): ${JSON.stringify(invalidSources)}`
      );
    }

    return [...new Set(dataSources)];
  }

  _getSecurityResource(plan, dataSources) {
    if (!dataSources.includes("security_logs")) {
      return null;
    }

    let resource = plan.security_resource;
    if (resource === null || resource === undefined) {
      resource = this.DEFAULT_SECURITY_RESOURCE;
    }

    if (typeof resource !== "string") {
      throw new Error("Question plan security_resource must be a string.");
    }

    resource = resource.trim();

    if (!resource) {
      resource = this.DEFAULT_SECURITY_RESOURCE;
    }

    if (!this.ALLOWED_SECURITY_RESOURCES.has(resource)) {
      throw new Error(`Question plan selected unsupported security resource: '${resource}'`);
    }

    return resource;
  }

  _getPostgresqlSources(plan) {
    let sources = plan.postgresql_sources || [];

    if (!Array.isArray(sources)) {
      throw new Error("Question plan postgresql_sources must be a list.");
    }

    sources = sources
      .filter(s => typeof s === "string" && s.trim())
      .map(s => s.trim().toLowerCase());

    const executionPlan = plan.execution_plan;
    if (executionPlan && typeof executionPlan === "object") {
      const stepSources = [];
      const steps = Array.isArray(executionPlan.steps) ? executionPlan.steps : [];
      for (const step of steps) {
        if (!step || typeof step !== "object") continue;
        const sourceId = step.source_id;
        if (typeof sourceId === "string" && sourceId.trim()) {
          stepSources.push(sourceId.trim().toLowerCase());
          continue;
        }
        const contract = step.contract;
        if (contract && typeof contract === "object") {
          const pgSources = Array.isArray(contract.postgresql_sources) ? contract.postgresql_sources : [];
          for (const val of pgSources) {
            if (typeof val === "string" && val.trim()) {
              stepSources.push(val.trim().toLowerCase());
            }
          }
        }
      }
      if (stepSources.length > 0) {
        sources = stepSources;
      }
    }

    sources = [...new Set(sources)];

    const dataSources = Array.isArray(plan.data_sources) ? plan.data_sources : [];
    if (!dataSources.includes("postgresql")) {
      return [];
    }

    if (sources.length === 0) {
      throw new Error("PostgreSQL was selected but no PostgreSQL source was specified.");
    }

    let availableSources;
    try {
      availableSources = new Set(Object.keys(loadAllContexts()));
    } catch {
      availableSources = new Set(["db1", "db2"]);
    }

    const invalidSources = sources.filter(s => !availableSources.has(s));
    if (invalidSources.length > 0) {
      throw new Error(
        `Question plan selected unavailable PostgreSQL source(s): ${JSON.stringify(invalidSources)}`
      );
    }

    return sources;
  }

  _getSqlGenerator(sourceId) {
    const normalized = String(sourceId || "db1").trim().toLowerCase();
    if (!this.sql_generators[normalized]) {
      let context = null;
      try {
        context = loadContext(normalized);
      } catch {
        const contexts = loadAllContexts();
        context = contexts[normalized];
      }
      this.sql_generators[normalized] = new SQLGenerator(context, normalized);
    }
    return this.sql_generators[normalized];
  }

  _buildSourceValidation(plan, sourceId) {
    if (typeof sourceId !== "string" || !sourceId.trim()) {
      return null;
    }

    const normSourceId = sourceId.trim().toLowerCase();

    let contexts;
    try {
      contexts = loadAllContexts();
    } catch {
      return null;
    }

    const context = contexts[normSourceId];
    if (!context || typeof context !== "object") {
      return null;
    }

    const tables = context.tables || {};
    if (!tables || typeof tables !== "object") {
      return null;
    }

    const sourceTables = new Set(Object.keys(tables).map(t => String(t)));
    const requiredTables = Array.isArray(plan.required_tables) ? plan.required_tables : [];
    const normalizedRequiredTables = requiredTables
      .filter(t => typeof t === "string" && t.trim())
      .map(t => t.trim());

    const missingTables = normalizedRequiredTables.filter(t => !sourceTables.has(t));
    if (missingTables.length > 0) {
      return null;
    }

    const requiredColumns = Array.isArray(plan.required_columns) ? plan.required_columns : [];
    const sourceColumns = {};

    for (const [tableName, tableInfo] of Object.entries(tables)) {
      if (!tableInfo || typeof tableInfo !== "object") continue;
      const columns = Array.isArray(tableInfo.columns) ? tableInfo.columns : [];
      const usableColumns = new Set();
      for (const col of columns) {
        if (!col || typeof col !== "object") continue;
        if (col.name) usableColumns.add(String(col.name));
      }
      sourceColumns[String(tableName)] = usableColumns;
    }

    const missingColumns = [];
    for (const field of requiredColumns) {
      let tableName = null;
      let columnName = null;

      if (typeof field === "string") {
        if (field.includes(".")) {
          const parts = field.split(".");
          tableName = parts[0].trim();
          columnName = parts[1].trim();
        }
      } else if (field && typeof field === "object") {
        tableName = field.table ? String(field.table).trim() : null;
        columnName = field.column ? String(field.column).trim() : null;
      }

      if (!tableName || !columnName) continue;

      const availableCols = sourceColumns[tableName] || new Set();
      if (!availableCols.has(columnName)) {
        missingColumns.push({ table: tableName, column: columnName });
      }
    }

    if (missingColumns.length > 0) {
      return null;
    }

    const relationships = Array.isArray(plan.relationships) ? plan.relationships : [];
    const contextRelationships = Array.isArray(context.relationships) ? context.relationships : [];
    const normalizedContextRelationships = [];

    for (const rel of contextRelationships) {
      if (!rel || typeof rel !== "object") continue;
      if (rel.source_table && rel.target_table) {
        normalizedContextRelationships.push({
          source_table: String(rel.source_table),
          target_table: String(rel.target_table)
        });
      }
    }

    for (const rel of relationships) {
      if (!rel || typeof rel !== "object") continue;
      if (!rel.source_table || !rel.target_table) continue;

      const srcTable = String(rel.source_table);
      const tgtTable = String(rel.target_table);

      const relationshipExists = normalizedContextRelationships.some(
        item => item.source_table === srcTable && item.target_table === tgtTable
      );

      if (!relationshipExists) {
        return null;
      }
    }

    const sourcePlan = JSON.parse(JSON.stringify(plan));
    sourcePlan.data_sources = ["postgresql"];
    sourcePlan.postgresql_sources = [normSourceId];

    return {
      valid: true,
      source_id: normSourceId,
      plan: sourcePlan,
      missing_tables: [],
      missing_columns: [],
      missing_relationships: []
    };
  }

  async _retrievePostgresql(contractDict, sourceId, runtimeBindings = null) {
    try {
      if (!sourceId) {
        throw new Error("PostgreSQL source_id cannot be empty.");
      }

      const sqlGenerator = this._getSqlGenerator(sourceId);

      let sql = sqlGenerator.generate(contractDict, sourceId, runtimeBindings);
      let repaired = false;
      let retrieval;

      try {
        retrieval = await this._executePostgresqlLive(sql, sourceId, runtimeBindings);
      } catch (exc) {
        if (isSqlRepairableError(exc) && typeof sqlGenerator.repair === "function") {
          try {
            const repairedSql = sqlGenerator.repair(
              sql,
              String(exc.message || exc),
              contractDict,
              sourceId,
              runtimeBindings
            );
            sql = repairedSql;
            repaired = true;
            retrieval = await this._executePostgresqlLive(sql, sourceId, runtimeBindings);
          } catch {
            throw exc;
          }
        } else {
          throw exc;
        }
      }

      const sourceTracker = this.source_tracker;
      const buildFn = typeof sourceTracker.buildSources === "function"
        ? sourceTracker.buildSources.bind(sourceTracker)
        : sourceTracker.build_sources.bind(sourceTracker);

      const source = buildFn(sql, retrieval, contractDict, sourceId);

      const rowCount = Number(retrieval?.row_count ?? retrieval?.rows?.length ?? 0);
      const retrievalStatus = retrieval?.retrieval_status || (rowCount > 0 ? "success_with_data" : "success_empty");

      return {
        source_type: "postgresql",
        source_id: sourceId,
        retrieval_status: retrievalStatus,
        retrieval,
        sql,
        repaired,
        sources: Array.isArray(source) ? source : [source]
      };
    } catch (exc) {
      console.warn("POSTGRESQL RETRIEVAL FAILED:", sourceId, exc.name || "Error", exc.message);

      return {
        source_type: "postgresql",
        source_id: sourceId,
        retrieval_status: "retrieval_failed",
        retrieval: {
          rows: [],
          row_count: 0,
          columns: []
        },
        sql: null,
        repaired: false,
        sources: [],
        error: {
          type: exc.name || "Error",
          message: String(exc.message || exc)
        }
      };
    }
  }

  async _executePostgresqlLive(query, sourceId, runtimeBindings = null) {
    const bindings = runtimeBindings || {};
    const parameters = bindings.parameters || [];

    if (!parameters || parameters.length === 0) {
      return await this.executor.execute(query, sourceId);
    }

    try {
      return await this.executor.execute(query, sourceId, parameters);
    } catch {
      // Fallback direct execution
      validateReadOnlyQuery(query);
      validateSqlSyntax(query);

      const client = sourceId === "db2" ? await getDb2Connection() : await getConnection("db1");
      try {
        await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;").catch(() => {});
        const res = await client.query(query, parameters);
        const rows = res.rows || [];
        const columns = (res.fields || []).map(f => f.name);
        return {
          rows,
          row_count: rows.length,
          columns,
          retrieval_status: rows.length > 0 ? "success_with_data" : "success_empty"
        };
      } finally {
        if (typeof client.release === "function") {
          client.release();
        } else if (typeof client.close === "function") {
          client.close();
        }
      }
    }
  }

  async _retrieveSecurityLogs(plan, workspaceId = null) {
    let resource = plan.security_resource || this.DEFAULT_SECURITY_RESOURCE;
    if (typeof resource !== "string") {
      throw new Error("security_resource must be a string.");
    }
    resource = resource.trim() || this.DEFAULT_SECURITY_RESOURCE;

    if (!this.ALLOWED_SECURITY_RESOURCES.has(resource)) {
      throw new Error(`Unsupported security resource: '${resource}'`);
    }

    let limit = plan.limit;
    if (typeof limit !== "number" || limit <= 0) {
      limit = 100;
    }

    try {
      let securityRetrieval;

      if (resource === "security_logs") {
        securityRetrieval = await this.security_log_retriever.retrieve({ limit });
      } else if (resource === "cli_audit_logs") {
        const fn = this.security_log_retriever.retrieve_cli_audit_logs || this.security_log_retriever.retrieveCliAuditLogs;
        if (!fn) throw new Error("SecurityLogRetriever does not expose retrieve_cli_audit_logs().");
        securityRetrieval = await fn.call(this.security_log_retriever, { limit });
      } else if (resource === "security_logs_summary") {
        const fn = this.security_log_retriever.retrieve_security_logs_summary ||
          this.security_log_retriever.retrieveSecurityLogsSummary ||
          this.security_log_retriever.retrieveSummary;
        if (!fn) throw new Error("SecurityLogRetriever does not expose retrieve_security_logs_summary().");
        securityRetrieval = await fn.call(this.security_log_retriever);
      } else if (resource === "workspace_security_logs") {
        if (!workspaceId) throw new Error("workspace_id is required for workspace_security_logs.");
        const fn = this.security_log_retriever.retrieve_workspace_security_logs || this.security_log_retriever.retrieveWorkspaceLogs;
        if (!fn) throw new Error("SecurityLogRetriever does not expose retrieve_workspace_security_logs().");
        securityRetrieval = await fn.call(this.security_log_retriever, workspaceId, { limit });
      } else if (resource === "workspace_siem_status") {
        if (!workspaceId) throw new Error("workspace_id is required for workspace_siem_status.");
        const fn = this.security_log_retriever.retrieve_workspace_siem_status || this.security_log_retriever.retrieveWorkspaceSiemStatus;
        if (!fn) throw new Error("SecurityLogRetriever does not expose retrieve_workspace_siem_status().");
        securityRetrieval = await fn.call(this.security_log_retriever, workspaceId);
      } else if (resource === "security_overview") {
        const fn = this.security_log_retriever.retrieve_security_overview || this.security_log_retriever.retrieveSecurityOverview;
        if (!fn) throw new Error("SecurityLogRetriever does not expose retrieve_security_overview().");
        securityRetrieval = await fn.call(this.security_log_retriever);
      } else {
        throw new Error(`Unsupported security resource: '${resource}'`);
      }

      if (!securityRetrieval || typeof securityRetrieval !== "object") {
        throw new Error("SecurityLogRetriever must return a dictionary.");
      }

      const events = Array.isArray(securityRetrieval.events) ? securityRetrieval.events : [];
      const data = securityRetrieval.data;

      const meaningfulKeys = Object.keys(securityRetrieval).filter(
        key =>
          !["source", "source_id", "resource", "retrieved_at", "workspace_id"].includes(key) &&
          securityRetrieval[key] !== null &&
          securityRetrieval[key] !== undefined &&
          securityRetrieval[key] !== ""
      );

      const meaningfulData = Boolean(
        events.length > 0 ||
        (data !== null && data !== undefined && data !== "" && (!Array.isArray(data) || data.length > 0)) ||
        meaningfulKeys.length > 0
      );

      const retrievalStatus = meaningfulData ? "success_with_data" : "success_empty";

      const source = {
        source_type: "security_logs_api",
        source_id: securityRetrieval.source_id || "security_logs",
        source: securityRetrieval.source || "security_logs_api",
        resource: securityRetrieval.resource || resource,
        entities: [],
        tables: [],
        columns: []
      };

      if (securityRetrieval.workspace_id) source.workspace_id = securityRetrieval.workspace_id;
      if (securityRetrieval.retrieved_at) source.retrieved_at = securityRetrieval.retrieved_at;
      if (Array.isArray(events)) source.event_count = events.length;

      return {
        source_type: "security_logs_api",
        source_id: "security_logs",
        resource,
        retrieval_status: retrievalStatus,
        retrieval: securityRetrieval,
        sources: [source]
      };
    } catch (exc) {
      console.warn("SECURITY LOG RETRIEVAL FAILED:", resource, exc.name || "Error", exc.message);
      return {
        source_type: "security_logs_api",
        source_id: "security_logs",
        resource,
        retrieval_status: "retrieval_failed",
        retrieval: {},
        sources: [],
        error: {
          type: exc.name || "Error",
          message: String(exc.message || exc)
        }
      };
    }
  }

  _prepareEvidence(postgresResults, securityResult, complexExecution = null) {
    const evidence = { sources: [] };

    if (complexExecution !== null && complexExecution !== undefined) {
      const stepEvidence = [];
      for (const postgresResult of postgresResults) {
        const retrieval = postgresResult.retrieval || {};
        const sources = postgresResult.sources || [];
        const prepared = this.evidence_manager.prepare(retrieval, sources);
        stepEvidence.push({
          step_id: postgresResult.execution_step_id,
          purpose: postgresResult.execution_purpose || "",
          source_id: postgresResult.source_id,
          evidence: prepared,
          retrieval_status: postgresResult.retrieval_status
        });
        evidence.sources.push(...sources);
      }

      evidence.complex_execution = {
        final_step: complexExecution.final_step,
        steps: stepEvidence,
        plan: complexExecution.plan
      };

      const finalResult = complexExecution.final_result || {};
      const finalRetrieval = finalResult.retrieval || {};
      const finalSources = finalResult.sources || [];
      if (finalRetrieval && Object.keys(finalRetrieval).length > 0) {
        evidence.final_result = this.evidence_manager.prepare(
          finalRetrieval,
          finalSources
        );
      }
    } else if (postgresResults && postgresResults.length > 0) {
      const combinedRows = [];
      const combinedColumns = [];
      const combinedProvenance = [];

      for (const postgresResult of postgresResults) {
        const retrieval = postgresResult.retrieval || {};
        const rows = Array.isArray(retrieval.rows) ? retrieval.rows : [];
        combinedRows.push(...rows);

        const columns = Array.isArray(retrieval.columns) ? retrieval.columns : [];
        for (const col of columns) {
          if (!combinedColumns.includes(col)) {
            combinedColumns.push(col);
          }
        }

        if (retrieval.provenance && typeof retrieval.provenance === "object") {
          combinedProvenance.push(retrieval.provenance);
        }

        if (Array.isArray(postgresResult.sources)) {
          evidence.sources.push(...postgresResult.sources);
        }
      }

      const combinedRetrieval = {
        rows: combinedRows,
        row_count: combinedRows.length,
        columns: combinedColumns,
        provenance: {
          source_type: "postgresql",
          sources: combinedProvenance
        }
      };

      const combinedSources = [];
      for (const postgresResult of postgresResults) {
        if (Array.isArray(postgresResult.sources)) {
          combinedSources.push(...postgresResult.sources);
        }
      }

      const postgresEvidence = this.evidence_manager.prepare(
        combinedRetrieval,
        combinedSources
      );

      evidence.postgresql = postgresEvidence;

      if (postgresEvidence.rows) {
        evidence.rows = postgresEvidence.rows;
        evidence.row_count = postgresEvidence.row_count;
        evidence.columns = postgresEvidence.columns;
        evidence.total_retrieved = postgresEvidence.total_retrieved;
        evidence.truncated = postgresEvidence.truncated;
      }
    }

    if (securityResult !== null && securityResult !== undefined) {
      const securityRetrieval = securityResult.retrieval || {};
      const securitySources = Array.isArray(securityResult.sources) ? securityResult.sources : [];

      evidence.security_logs = {
        source_type: "security_logs_api",
        resource: securityResult.resource,
        retrieval: securityRetrieval
      };

      evidence.sources.push(...securitySources);
    }

    return evidence;
  }

  _hasRetrievedData(postgresResults, securityResult) {
    for (const postgresResult of postgresResults) {
      const retrieval = postgresResult.retrieval || {};
      const rows = retrieval.rows || [];
      if (Array.isArray(rows) && rows.length > 0) {
        return true;
      }
    }

    if (securityResult !== null && securityResult !== undefined) {
      const retrieval = securityResult.retrieval || {};
      const events = retrieval.events;
      if (Array.isArray(events) && events.length > 0) {
        return true;
      }

      const data = retrieval.data;
      if (data !== null && data !== undefined && data !== "" && (!Array.isArray(data) || data.length > 0)) {
        return true;
      }

      const meaningfulKeys = Object.keys(retrieval).filter(key =>
        !["source", "source_id", "resource", "retrieved_at", "workspace_id"].includes(key) &&
        retrieval[key] !== null &&
        retrieval[key] !== undefined &&
        retrieval[key] !== ""
      );

      if (meaningfulKeys.length > 0) {
        return true;
      }
    }

    return false;
  }

  _validateWorkspaceId(workspaceId) {
    if (workspaceId === null || workspaceId === undefined) {
      return null;
    }

    if (typeof workspaceId !== "string") {
      throw new Error("workspace_id must be a string or null.");
    }

    const trimmed = workspaceId.trim();
    if (!trimmed) {
      return null;
    }

    if (trimmed.length > 256) {
      throw new Error("workspace_id is too long.");
    }

    return trimmed;
  }

  _buildSourceStatus(postgresResults, securityResult) {
    const sourceStatus = {};

    for (const postgresResult of postgresResults) {
      const sourceId = postgresResult.source_id;
      if (!sourceId) continue;

      const retrieval = postgresResult.retrieval || {};
      const rows = Array.isArray(retrieval.rows) ? retrieval.rows : [];

      sourceStatus[sourceId] = {
        source_type: "postgresql",
        source_id: sourceId,
        metadata_available: true,
        retrieval_status: postgresResult.retrieval_status || "retrieval_failed",
        data_available: rows.length > 0,
        error: postgresResult.error || null
      };
    }

    if (securityResult !== null && securityResult !== undefined) {
      const retrieval = securityResult.retrieval || {};
      const events = retrieval.events;
      let dataAvailable = false;

      if (Array.isArray(events) && events.length > 0) {
        dataAvailable = true;
      }

      const data = retrieval.data;
      if (data !== null && data !== undefined && data !== "" && (!Array.isArray(data) || data.length > 0)) {
        dataAvailable = true;
      }

      const meaningfulKeys = Object.keys(retrieval).filter(key =>
        !["source", "source_id", "retrieved_at", "workspace_id"].includes(key) &&
        retrieval[key] !== null &&
        retrieval[key] !== undefined &&
        retrieval[key] !== ""
      );

      if (meaningfulKeys.length > 0) {
        dataAvailable = true;
      }

      sourceStatus.security_logs = {
        source_type: "security_logs_api",
        source_id: "security_logs",
        retrieval_status: securityResult.retrieval_status || "retrieval_failed",
        data_available: dataAvailable,
        error: securityResult.error || null
      };
    }

    return sourceStatus;
  }

  async _executeComplexPostgresql(question, validatedPlan) {
    const complexPlan = await this.complex_query_planner.build(question, validatedPlan);

    const retrievalContracts = {};

    const executeStep = async (step, stepContext) => {
      const sourceId = step.source_id;
      const sourcePlan = JSON.parse(JSON.stringify(step.contract));

      const sourceValidation = this._buildSourceValidation(sourcePlan, sourceId);
      if (!sourceValidation) {
        throw new Error(`Source context unavailable for complex step '${step.step_id}'.`);
      }

      const contract = createRetrievalContract(sourceValidation.plan);
      const contractDict = typeof contract.to_dict === "function" ? contract.to_dict() : contract.toDict();
      retrievalContracts[step.step_id] = contractDict;

      return await this._retrievePostgresql(
        contractDict,
        sourceId,
        stepContext?.runtime_bindings || null
      );
    };

    const execution = await this.query_plan_executor.execute(complexPlan, executeStep);

    const stepResults = execution.steps || {};
    const postgresResults = [];

    for (const step of complexPlan.steps || []) {
      const result = stepResults[step.step_id];
      if (!result || typeof result !== "object") continue;
      if (result.source_type !== "postgresql") continue;

      const resCopy = { ...result };
      resCopy.execution_step_id = step.step_id;
      resCopy.execution_purpose = step.purpose;
      postgresResults.push(resCopy);
    }

    const complexExecution = {
      status: execution.status,
      final_step: execution.final_step,
      plan: execution.plan,
      steps: stepResults,
      final_result: execution.result
    };

    return [postgresResults, retrievalContracts, complexExecution];
  }

  async ask(question, workspaceIdOrContext = null) {
    const cleanQuestion = this._validateQuestion(question);

    let workspaceId = null;
    let explicitConversationContext = null;

    if (
      workspaceIdOrContext &&
      typeof workspaceIdOrContext === "object" &&
      (workspaceIdOrContext.history || workspaceIdOrContext.entities)
    ) {
      explicitConversationContext = workspaceIdOrContext;
    } else {
      workspaceId = this._validateWorkspaceId(workspaceIdOrContext);
    }

    // Security Rule 4: Fail closed immediately if requesting confidential credentials or passwords
    if (isSensitiveQuestionIntent(cleanQuestion)) {
      return sanitizeApiResponse({
        question: cleanQuestion,
        plan: null,
        plan_repaired: false,
        data_sources: [],
        postgresql_source_ids: [],
        retrieval_status: "sensitive_question_blocked",
        source_status: {},
        evidence: {},
        sources: [],
        answer: "I cannot provide passwords, tokens, API keys, credentials, or confidential security secrets. These are protected resources.",
        error: {
          type: "sensitive_question_blocked",
          message: "The question requests confidential credentials or secrets."
        }
      });
    }

    const conversationContext = explicitConversationContext || this._getConversationContext();

    await this._resolveEntity(cleanQuestion, conversationContext);

    const rawPlan = await this.planner.plan(cleanQuestion, conversationContext);
    let validation = this.plan_validator.validate(rawPlan);

    let planRepaired = false;

    if (!validation.valid) {
      const validationErrors = validation.errors || [];
      const repairFn = typeof this.planner.repair_plan === "function"
        ? this.planner.repair_plan.bind(this.planner)
        : (typeof this.planner.repairPlan === "function" ? this.planner.repairPlan.bind(this.planner) : null);

      if (repairFn) {
        const repairedPlan = await repairFn(cleanQuestion, rawPlan, validationErrors, conversationContext);
        const repairedValidation = this.plan_validator.validate(repairedPlan);

        if (!repairedValidation.valid) {
          return sanitizeApiResponse({
            question: cleanQuestion,
            plan: rawPlan,
            plan_repaired: false,
            data_sources: [],
            postgresql_source_ids: [],
            retrieval_status: "planning_failed",
            source_status: {},
            evidence: {},
            sources: [],
            answer: "I could not create a valid retrieval plan for this question.",
            error: {
              type: "planning_failed",
              details: repairedValidation.errors || []
            }
          });
        }

        validation = repairedValidation;
        planRepaired = true;
      } else {
        return sanitizeApiResponse({
          question: cleanQuestion,
          plan: rawPlan,
          plan_repaired: false,
          data_sources: [],
          postgresql_source_ids: [],
          retrieval_status: "planning_failed",
          source_status: {},
          evidence: {},
          sources: [],
          answer: "I could not create a valid retrieval plan for this question.",
          error: {
            type: "planning_failed",
            details: validation.errors || []
          }
        });
      }
    }

    const validatedPlan = validation.plan;

    const dataSources = this._getDataSources(validatedPlan);
    const securityResource = this._getSecurityResource(validatedPlan, dataSources);
    validatedPlan.security_resource = securityResource;

    const postgresqlSources = this._getPostgresqlSources(validatedPlan);

    let postgresResults = [];
    const retrievalContracts = {};
    let complexExecution = null;

    if (postgresqlSources.length > 0) {
      const shouldDecomposeFn = this.complex_query_planner.should_decompose || this.complex_query_planner.shouldDecompose;
      const shouldDecompose = typeof shouldDecomposeFn === "function" && shouldDecomposeFn.call(this.complex_query_planner, cleanQuestion, validatedPlan);

      if (shouldDecompose) {
        try {
          const complexRes = await this._executeComplexPostgresql(cleanQuestion, validatedPlan);
          postgresResults = complexRes[0];
          Object.assign(retrievalContracts, complexRes[1]);
          complexExecution = complexRes[2];
        } catch (exc) {
          postgresResults = postgresqlSources.map(sourceId => ({
            source_type: "postgresql",
            source_id: sourceId,
            retrieval_status: "retrieval_failed",
            retrieval: { rows: [], row_count: 0, columns: [] },
            sql: null,
            repaired: false,
            sources: [],
            error: { type: exc.name || "Error", message: String(exc.message || exc) }
          }));
        }
      } else {
        for (const sourceId of postgresqlSources) {
          try {
            const sourceValidation = this._buildSourceValidation(validatedPlan, sourceId);
            if (!sourceValidation) {
              postgresResults.push({
                source_type: "postgresql",
                source_id: sourceId,
                retrieval_status: "retrieval_failed",
                retrieval: { rows: [], row_count: 0, columns: [] },
                sql: null,
                repaired: false,
                sources: [],
                error: {
                  type: "source_context_unavailable",
                  message: "The selected PostgreSQL source did not contain the required retrieval context."
                }
              });
              continue;
            }

            const sourcePlan = sourceValidation.plan;
            const contract = createRetrievalContract(sourcePlan);
            const sourceContractDict = typeof contract.to_dict === "function" ? contract.to_dict() : contract.toDict();
            retrievalContracts[sourceId] = sourceContractDict;

            const res = await this._retrievePostgresql(sourceContractDict, sourceId);
            postgresResults.push(res);
          } catch (exc) {
            postgresResults.push({
              source_type: "postgresql",
              source_id: sourceId,
              retrieval_status: "retrieval_failed",
              retrieval: { rows: [], row_count: 0, columns: [] },
              sql: null,
              repaired: false,
              sources: [],
              error: { type: exc.name || "Error", message: String(exc.message || exc) }
            });
          }
        }
      }
    }

    let securityResult = null;
    if (dataSources.includes("security_logs")) {
      securityResult = await this._retrieveSecurityLogs(validatedPlan, workspaceId);
    }

    const sourceStatus = this._buildSourceStatus(postgresResults, securityResult);
    const retrievalStates = Object.values(sourceStatus).map(item => item.retrieval_status);

    const successfulSources = retrievalStates.filter(state =>
      ["success_with_data", "success_empty"].includes(state)
    );
    const failedSources = retrievalStates.filter(state => state === "retrieval_failed");

    const hasData = this._hasRetrievedData(postgresResults, securityResult);

    let overallRetrievalStatus;
    if (hasData) {
      overallRetrievalStatus = failedSources.length > 0 ? "partial_source_failure" : "success_with_data";
    } else if (successfulSources.length > 0) {
      overallRetrievalStatus = failedSources.length > 0 ? "partial_source_failure" : "success_empty";
    } else if (failedSources.length > 0) {
      overallRetrievalStatus = "source_unavailable";
    } else {
      overallRetrievalStatus = "success_empty";
    }

    if (overallRetrievalStatus === "source_unavailable") {
      const result = {
        question: cleanQuestion,
        plan: validatedPlan,
        plan_repaired: planRepaired,
        data_sources: dataSources,
        security_resource: securityResource,
        postgresql_source_ids: postgresqlSources,
        retrieval_contract: retrievalContracts,
        evidence: {},
        answer: "I could not retrieve live data from the selected data source(s), so I cannot provide an authoritative answer.",
        sources: [],
        source_status: sourceStatus,
        retrieval_status: overallRetrievalStatus
      };
      return sanitizeApiResponse(result);
    }

    const rawEvidence = this._prepareEvidence(postgresResults, securityResult, complexExecution);
    const evidence = sanitizeEvidence(rawEvidence);

    // Generate answer
    let answer;
    let answerGenerationStatus = "success";
    let answerGenerationError = null;

    try {
      answer = await this.answer_generator.generate(cleanQuestion, evidence);
    } catch (exc) {
      answer = "I retrieved live evidence successfully, but I could not generate the final answer from that evidence.";
      answerGenerationStatus = "failed";
      answerGenerationError = {
        type: exc.name || "Error",
        message: String(exc.message || exc)
      };
    }

    if (answerGenerationStatus === "success") {
      const addTurnFn = typeof this.context_manager.add_turn === "function"
        ? this.context_manager.add_turn.bind(this.context_manager)
        : this.context_manager.addTurn.bind(this.context_manager);

      addTurnFn(cleanQuestion, answer, validatedPlan.entities || []);
    }

    const allSources = [];
    for (const pr of postgresResults) {
      if (Array.isArray(pr.sources)) allSources.push(...pr.sources);
    }
    if (securityResult && Array.isArray(securityResult.sources)) {
      allSources.push(...securityResult.sources);
    }

    const retrievalContractKeys = Object.keys(retrievalContracts);
    const retrievalContractOutput = retrievalContractKeys.length === 1
      ? retrievalContracts[retrievalContractKeys[0]]
      : retrievalContracts;

    const result = {
      question: cleanQuestion,
      plan: validatedPlan,
      plan_repaired: planRepaired,
      data_sources: dataSources,
      security_resource: securityResource,
      postgresql_source_ids: postgresqlSources,
      workspace_scoped: Boolean(
        workspaceId &&
        ["workspace_security_logs", "workspace_siem_status"].includes(securityResource)
      ),
      retrieval_contract: retrievalContractOutput,
      evidence,
      complex_execution: complexExecution,
      answer,
      sources: allSources,
      source_status: sourceStatus,
      retrieval_status: overallRetrievalStatus,
      answer_generation_status: answerGenerationStatus,
      answer_generation_error: answerGenerationError
    };

    if (postgresResults.length === 1) {
      const pr = postgresResults[0];
      result.sql = pr.sql;
      result.postgresql_retrieval = pr.retrieval || {};
      result.retrieval = pr.retrieval || {};
      result.postgresql_sources = pr.sources || [];
      result.sql_repaired = pr.repaired || false;
    } else if (postgresResults.length > 1) {
      result.sql_by_source = {};
      result.postgresql_retrievals = {};
      result.postgresql_sources = [];
      result.sql_repaired = {};

      for (const pr of postgresResults) {
        result.sql_by_source[pr.source_id] = pr.sql;
        result.postgresql_retrievals[pr.source_id] = pr.retrieval || {};
        if (Array.isArray(pr.sources)) {
          result.postgresql_sources.push(...pr.sources);
        }
        result.sql_repaired[pr.source_id] = pr.repaired || false;
      }
    }

    if (securityResult !== null && securityResult !== undefined) {
      result.security_logs_retrieval = securityResult.retrieval || {};
      result.security_logs_sources = securityResult.sources || [];
      result.security_logs_retrieval_status = securityResult.retrieval_status;
      result.security_logs_error = securityResult.error || null;
    }

    return sanitizeApiResponse(result);
  }
}

// Attach snake_case aliases for full Python parity
RAGPipeline.prototype._validate_question = RAGPipeline.prototype._validateQuestion;
RAGPipeline.prototype._get_conversation_context = RAGPipeline.prototype._getConversationContext;
RAGPipeline.prototype._resolve_entity = RAGPipeline.prototype._resolveEntity;
RAGPipeline.prototype._get_data_sources = RAGPipeline.prototype._getDataSources;
RAGPipeline.prototype._get_security_resource = RAGPipeline.prototype._getSecurityResource;
RAGPipeline.prototype._get_postgresql_sources = RAGPipeline.prototype._getPostgresqlSources;
RAGPipeline.prototype._get_sql_generator = RAGPipeline.prototype._getSqlGenerator;
RAGPipeline.prototype._build_source_validation = RAGPipeline.prototype._buildSourceValidation;
RAGPipeline.prototype._retrieve_postgresql = RAGPipeline.prototype._retrievePostgresql;
RAGPipeline.prototype._execute_postgresql_live = RAGPipeline.prototype._executePostgresqlLive;
RAGPipeline.prototype._retrieve_security_logs = RAGPipeline.prototype._retrieveSecurityLogs;
RAGPipeline.prototype._prepare_evidence = RAGPipeline.prototype._prepareEvidence;
RAGPipeline.prototype._has_retrieved_data = RAGPipeline.prototype._hasRetrievedData;
RAGPipeline.prototype._validate_workspace_id = RAGPipeline.prototype._validateWorkspaceId;
RAGPipeline.prototype._build_source_status = RAGPipeline.prototype._buildSourceStatus;
RAGPipeline.prototype._execute_complex_postgresql = RAGPipeline.prototype._executeComplexPostgresql;

export default {
  RAGPipeline
};
