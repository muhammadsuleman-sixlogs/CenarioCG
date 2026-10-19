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
import { ExternalApiClient } from "../external_api/client.js";
import { settings } from "../config/settings.js";
import { EvidenceManager } from "../llm/evidence_manager.js";
import { AnswerGenerator } from "../llm/answer_generator.js";
import { sanitizeApiResponse, sanitizeEvidence } from "../security/output_security_policy.js";
import { isSensitiveQuestionIntent } from "../security/sensitive_data_policy.js";
import { getRegisteredPostgresqlSourceIds } from "../database/connection.js";
import { SourceRouter } from "../planning/source_router.js";
import { assertAuthorizedSecurityResource, assertAuthorizedSources, assertAuthorizedExternalApiOperation } from "../auth/authorization.js";
import { logRuntimeDiagnostic } from "../diagnostics/runtime_diagnostics.js";
import {
  createLlmUsageTracker,
  logLlmUsage,
  measureAnswerEvidenceStructure,
  recordAnswerEvidenceMetrics,
  snapshotLlmUsage
} from "../llm/usage_tracker.js";

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
  static ALLOWED_DATA_SOURCES = new Set(["postgresql", "security_logs", "external_api"]);

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
    this.source_router = options.source_router || new SourceRouter(this.plan_validator.contexts);

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
    this.llm_usage_logger = options.llm_usage_logger || console.info;
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
      entities,
      active_context: typeof this.context_manager.getActiveContext === "function" ? this.context_manager.getActiveContext() : null,
      pending_reference: typeof this.context_manager.getPendingReference === "function" ? this.context_manager.getPendingReference() : null
    };
  }

  _revalidateConversationReferences(conversationContext) {
    const contexts = this.plan_validator.contexts || {};
    const validReference = reference => {
      const sourceId = String(reference?.source_id || "").toLowerCase();
      const table = String(reference?.table || reference?.entity_table || "");
      const tableInfo = contexts?.[sourceId]?.tables?.[table];
      if (!tableInfo) return false;
      const columns = new Set((tableInfo.columns || []).map(column => String(column?.name || column)));
      const keys = reference?.stable_keys && typeof reference.stable_keys === "object" ? Object.keys(reference.stable_keys) : [];
      return keys.every(key => columns.has(key));
    };
    const active = conversationContext?.active_context;
    if (active && !validReference(active)) {
      if (typeof this.context_manager.clearActiveContext === "function") this.context_manager.clearActiveContext();
      conversationContext.active_context = null;
    }
    const pending = conversationContext?.pending_reference;
    if (pending && !validReference(pending)) {
      if (typeof this.context_manager.clearPendingReference === "function") this.context_manager.clearPendingReference();
      conversationContext.pending_reference = null;
    }
    conversationContext.entities = (conversationContext?.entities || []).filter(entity => {
      if (!entity?.source_id || !entity?.entity_table) return true;
      return validReference({ ...entity, table: entity.entity_table, stable_keys: entity.entity_column ? { [entity.entity_column]: entity.id } : {} });
    });
    return conversationContext;
  }

  _restrictToAuthorizedSources(authorization) {
    if (!authorization) return;
    const allowedPostgresql = new Set((authorization.postgresql_sources || []).map(source => String(source).toLowerCase()));
    const allowedApiSources = new Set((authorization.external_api_sources || []).map(source => String(source).toLowerCase()));
    const filter = contexts => Object.fromEntries(Object.entries(contexts || {}).filter(([sourceId, context]) => {
      const source = String(sourceId).toLowerCase();
      if (context?.source_type === "external_api") {
        return allowedApiSources.has(source) && (authorization.external_api_operations?.[source] || []).length > 0;
      }
      return allowedPostgresql.has(source);
    }));
    // A pipeline can be reused by a conversation or test harness.  Always
    // filter the original local metadata snapshot for this request, never the
    // subset left by a prior DB1-only/DB2-only request.
    if (!this._unrestricted_contexts) {
      this._unrestricted_contexts = this.plan_validator.contexts;
    }
    const contexts = filter(this._unrestricted_contexts);
    if (Object.keys(contexts).length === 0) {
      const error = new Error("No authorized Context Layer sources are available.");
      error.code = "SOURCE_NOT_AUTHORIZED";
      throw error;
    }
    this.plan_validator.contexts = contexts;
    this.planner.contexts = contexts;
    this.entity_resolver.contexts = contexts;
    this.source_router.contexts = contexts;
  }

  _planningFailure(question, type, answer, details = []) {
    return this._attachLlmUsage(sanitizeApiResponse({
      question, plan: null, plan_repaired: false, data_sources: [], postgresql_source_ids: [],
      retrieval_status: "planning_failed", source_status: {}, evidence: {}, sources: [], answer,
      error: { type, details }
    }));
  }

  _attachLlmUsage(result) {
    if (!result || !this.llm_usage_tracker) return result;
    if (!this.llm_usage_logged) {
      logLlmUsage(this.llm_usage_tracker, this.llm_usage_logger);
      this.llm_usage_logged = true;
    }
    result.llm_usage = snapshotLlmUsage(this.llm_usage_tracker);
    return result;
  }

  _rewriteFollowupQuestion(question, conversationContext) {
    const active = conversationContext?.active_context;
    const deicticFollowup = /\b(?:it|its|that|this|those|these|above|previous|prior|related)\b|\ball\s+\d+\b/i.test(question);
    const namedDetailRequest = /\b(?:details?|about|information)\b/i.test(question);
    if (!active || (namedDetailRequest && !deicticFollowup) || /\b(?:[A-Za-z0-9]+-[A-Za-z0-9]+|[\w.+-]+@[\w.-]+)\b/.test(question)) return question;
    const stableEntries = active.stable_keys && typeof active.stable_keys === "object"
      ? Object.entries(active.stable_keys)
      : Object.entries(active);
    const escapePattern = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const requestedStable = stableEntries.find(([key, value]) => {
      if (key === "source_id" || key === "workspace_id" || value === null || value === undefined || /^(?:id|key)$/i.test(key)) return false;
      const stem = String(key).replace(/(?:_id|_key)$/i, "").replace(/_/g, " ").trim();
      return stem && new RegExp(`\\b${stem.split(/\s+/).map(escapePattern).join("\\s+")}s?\\b`, "i").test(question);
    });
    const activeEntityToken = String(active.table || "").split("_")[0].replace(/s$/i, "").toLowerCase();
    const requestedEntityToken = requestedStable
      ? String(requestedStable[0]).replace(/(?:_id|_key)$/i, "").split("_")[0].replace(/s$/i, "").toLowerCase()
      : "";
    // A relationship key is already represented in source-qualified context.
    // Appending its UUID to the question can make semantic candidate ranking
    // select an unrelated table; keep the natural wording for that case.
    if (requestedStable && requestedEntityToken && requestedEntityToken !== activeEntityToken) return question;
    const stable = requestedStable || stableEntries.find(([key, value]) =>
      key !== "source_id" && key !== "workspace_id" && /(?:^|_)id$/.test(key) && value !== null && value !== undefined
    );
    return stable ? `${question} [context ${stable[0]}: ${stable[1]}]` : question;
  }

  _updateActiveEntityFromExecution(question, plan, results) {
    const allRows = (results || []).flatMap(item => Array.isArray(item?.retrieval?.rows) ? item.retrieval.rows.map(row => ({ row, source_id: item.source_id, result: item })) : []);
    const finalStep = plan?.execution_plan?.final_step;
    // For a dependency plan, only the final retrieval is the answer entity.
    // Earlier rows are bindings/provenance and must not prevent the final
    // source-qualified record from becoming the next-turn anchor.
    const taggedRows = finalStep
      ? allRows.filter(item => item.result?.execution_step_id === finalStep)
      : allRows;
    const rows = finalStep && taggedRows.length > 0
      ? taggedRows
      : allRows;
    const table = plan?.entity_target?.table || plan?.required_tables?.[0];
    const sourceIds = [...new Set(rows.map(item => String(item.source_id || "").toLowerCase()).filter(Boolean))];
    const isBoundedSingleRecord = rows.length === 1 && (
      Number(plan?.limit) === 1 ||
      /\b(?:first|latest|newest|most recent|single|one)\b/i.test(question)
    );
    const isPluralReference = /\b(?:recent|latest|newest|most recent|all|list|which)\b/i.test(question);
    const isNamedRecordSet = plan?.named_entity_lookup === true;
    if (rows.length > 1 && (isPluralReference || isNamedRecordSet) && sourceIds.length === 1 && table) {
      const candidateKeys = Object.keys(rows[0].row).filter(key => /(?:^|_)id$/i.test(key) && rows.every(item => Object.prototype.hasOwnProperty.call(item.row, key) && item.row[key] !== null && item.row[key] !== undefined));
      const keyColumn = candidateKeys[0];
      const values = keyColumn ? [...new Set(rows.map(item => item.row[keyColumn]).filter(value => value !== null && value !== undefined).map(String))] : [];
      if (keyColumn && values.length === rows.length) {
        const relationshipKeys = Object.fromEntries(candidateKeys.map(column => [
          column,
          [...new Set(rows.map(item => item.row[column]).filter(value => value !== null && value !== undefined).map(String))]
        ]));
        const priorActive = typeof this.context_manager.getActiveContext === "function" ? this.context_manager.getActiveContext() : null;
        const inherited = priorActive?.source_id === sourceIds[0] && priorActive?.table === table ? priorActive : {};
        this.context_manager.setActiveContext({
          ...inherited,
          source_id: sourceIds[0],
          table,
          record_set: { key_column: keyColumn, values, count: values.length },
          relationship_keys: relationshipKeys,
          validation_status: "retrieval_evidence_confirmed",
          provenance: "successful_source_retrieval"
        });
        if (typeof this.context_manager.clearPendingReference === "function") this.context_manager.clearPendingReference();
        return;
      }
    }
    // A list never becomes active context. Only one real record and an explicit
    // entity-reference question can safely establish a follow-up anchor.
    const hasBoundReference = Boolean(plan?.needs_conversation_context) || (plan?.filters || []).some(filter => ["=", "contains"].includes(String(filter?.operator || "").toLowerCase()) && filter?.value !== undefined && filter?.value !== null);
    const ungroundedCatalogFallback = Array.isArray(plan?.semantic_candidates) && plan.semantic_candidates.length > 0 && !hasBoundReference;
    const isBroadRetrieval = /\b(?:all|list)\b/i.test(question) ||
      (/\b(?:recent)\b/i.test(question) && !isBoundedSingleRecord);
    if ((ungroundedCatalogFallback && !isBoundedSingleRecord) || !rows.length || !/\b(?:details?|about|show|meeting|project|company|ticket|document|transcript|invoice)\b/i.test(question) || isBroadRetrieval) return;
    const { row, source_id, result } = rows[0];
    const sharedIdentifiers = Object.entries(row).filter(([key, value]) => {
      if (!/(?:^|_)id$/.test(key) || value === null || value === undefined) return false;
      return rows.every(candidate => Object.prototype.hasOwnProperty.call(candidate.row, key) && String(candidate.row[key]) === String(value));
    });
    // Multiple output rows can still represent one entity (for example
    // transcript segments). Only invariant identifier values are retained.
    const stableEntries = sharedIdentifiers.length > 0 ? sharedIdentifiers : (rows.length === 1
      ? Object.entries(row).filter(([key, value]) => /(?:^|_)id$/.test(key) && value !== null && value !== undefined)
      : []);
    if (!stableEntries.length) return;
    const invariantFields = Object.entries(row).filter(([key, value]) => rows.every(candidate => Object.prototype.hasOwnProperty.call(candidate.row, key) && String(candidate.row[key]) === String(value)));
    const finalContract = (plan?.execution_plan?.steps || []).find(step => step.id === finalStep)?.contract;
    const target = plan?.entity_target;
    const resolvedTable = target?.source_id === source_id && target?.table
      ? target.table
      : (result?.sources?.[0]?.tables?.[0] || finalContract?.required_tables?.[0] || (Array.isArray(plan?.required_tables) ? plan.required_tables[0] : undefined));
    const prior = (typeof this.context_manager.getActiveContext === "function" ? this.context_manager.getActiveContext() : null) || (typeof this.context_manager.getPendingReference === "function" ? this.context_manager.getPendingReference() : null);
    const priorKeys = prior?.stable_keys && typeof prior.stable_keys === "object" ? Object.entries(prior.stable_keys) : [];
    // A related child record (for example a transcript) must not replace the
    // meeting/project that the user established. Keep the parent anchor when
    // every parent key is present in the returned related evidence.
    if (plan?.needs_conversation_context && prior?.source_id === source_id && prior?.table !== resolvedTable && priorKeys.length && priorKeys.every(([key, value]) => String(row[key]) === String(value))) {
      this.context_manager.setActiveContext({ ...prior, validation_status: "retrieval_evidence_confirmed" });
      if (typeof this.context_manager.clearPendingReference === "function") this.context_manager.clearPendingReference();
      return;
    }
    this.context_manager.setActiveContext({ ...Object.fromEntries(invariantFields), source_id, table: resolvedTable, stable_keys: Object.fromEntries(stableEntries) });
    if (typeof this.context_manager.clearPendingReference === "function") this.context_manager.clearPendingReference();
  }

  _recordSetReferenceMode(question, active) {
    const text = String(question || "");
    if (/\b(?:above|those|these|previous|prior)\b|\ball\s+\d+\b/i.test(text)) return "plural";
    if (!active?.record_set || !active?.source_id || !active?.table) return null;
    const context = this.plan_validator.contexts?.[active.source_id] || {};
    const entity = context.semantic_catalog?.entities?.[active.table] || {};
    const aliases = [active.table, entity.entity_type, ...(Array.isArray(entity.synonyms) ? entity.synonyms : [])]
      .map(value => String(value || "").replace(/_/g, " ").trim())
      .filter(Boolean);
    const mentionsActiveEntity = aliases.some(alias => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${escaped}(?:s)?\\b`, "i").test(text);
    });
    return mentionsActiveEntity && /\b(?:this|that)\b/i.test(text) ? "singular" : null;
  }

  _resolveFollowupIdentityResolution(question, conversationContext, plan, postgresResults) {
    const active = conversationContext?.active_context || conversationContext?.pending_reference || null;
    const recordSet = active?.record_set;
    const mode = this._recordSetReferenceMode(question, active);
    const values = Array.isArray(recordSet?.values)
      ? [...new Set(recordSet.values.filter(value => value !== null && value !== undefined).map(String))]
      : [];
    if (!active || !recordSet || !mode || !values.length) return null;

    const executionPlan = plan?.execution_plan;
    const definitions = Array.isArray(executionPlan?.steps) ? executionPlan.steps : [];
    const stepId = step => step?.id || step?.step_id || null;
    const resultByStep = new Map((postgresResults || [])
      .filter(result => result?.execution_step_id)
      .map(result => [String(result.execution_step_id), result]));
    const firstDefinition = definitions[0] || null;
    const finalDefinition = definitions.at(-1) || null;
    const firstStepId = stepId(firstDefinition);
    const finalStepId = stepId(finalDefinition);
    const firstResult = (firstStepId && resultByStep.get(String(firstStepId))) || postgresResults?.[0] || null;
    const firstRows = Array.isArray(firstResult?.retrieval?.rows) ? firstResult.retrieval.rows : [];
    const keyColumn = String(recordSet.key_column || "").split(".").at(-1);
    const firstRowsByIdentity = new Map();
    for (const row of firstRows) {
      const identity = row?.[keyColumn];
      if (identity === null || identity === undefined) continue;
      const normalized = String(identity);
      if (!firstRowsByIdentity.has(normalized)) firstRowsByIdentity.set(normalized, []);
      firstRowsByIdentity.get(normalized).push(row);
    }

    const states = new Map(values.map(value => [value, firstRowsByIdentity.get(value) || []]));
    let relationshipComplete = definitions.length > 1;
    for (let index = 1; index < definitions.length; index += 1) {
      const definition = definitions[index];
      const previousDefinition = definitions[index - 1];
      const binding = Array.isArray(definition?.input_bindings) ? definition.input_bindings[0] : null;
      const currentResult = resultByStep.get(String(stepId(definition)));
      const currentRows = Array.isArray(currentResult?.retrieval?.rows) ? currentResult.retrieval.rows : [];
      const fromColumn = String(binding?.from_column || "").split(".").at(-1);
      const toColumn = String(binding?.to_column || "").split(".").at(-1);
      if (!binding || !fromColumn || !toColumn) {
        relationshipComplete = false;
        break;
      }

      for (const [identity, parentRows] of states.entries()) {
        const joinedRows = [];
        for (const parent of parentRows) {
          const value = parent?.[fromColumn];
          if (value === null || value === undefined) continue;
          joinedRows.push(...currentRows.filter(row => row?.[toColumn] !== null && row?.[toColumn] !== undefined && String(row[toColumn]) === String(value)));
        }
        states.set(identity, joinedRows);
      }
      if (!previousDefinition) relationshipComplete = false;
    }

    const finalTable = finalDefinition?.contract?.required_tables?.[0] || finalDefinition?.required_tables?.[0] || null;
    const finalSourceId = finalDefinition?.source_id || null;
    const finalContext = finalSourceId && finalTable
      ? this.plan_validator.contexts?.[finalSourceId]?.tables?.[finalTable] || {}
      : {};
    const finalKeyColumn = String(
      plan?.semantic_path?.at(-1)?.column || finalContext.primary_keys?.[0] || "id"
    ).split(".").at(-1);

    const mappings = [];
    const missingIdentities = [];
    const conflictIdentities = [];
    const targetValues = new Set();
    for (const identity of values) {
      const rows = states.get(identity) || [];
      const targets = [...new Set(rows
        .map(row => row?.[finalKeyColumn])
        .filter(value => value !== null && value !== undefined)
        .map(String))];
      for (const target of targets) targetValues.add(target);
      if (!rows.length || !targets.length) missingIdentities.push(identity);
      if (targets.length > 1) conflictIdentities.push(identity);
      mappings.push({
        from_source_id: active.source_id,
        from_table: active.table,
        from_key: keyColumn,
        from_value: identity,
        to_source_id: finalSourceId,
        to_table: finalTable,
        to_key: finalKeyColumn,
        to_values: targets,
        status: targets.length ? (targets.length > 1 ? "conflict" : "verified") : "missing"
      });
    }

    const matchedIdentityCount = mappings.filter(mapping => mapping.to_values.length > 0).length;
    const associationCount = mappings.reduce((total, mapping) => total + mapping.to_values.length, 0);
    const complete = relationshipComplete && missingIdentities.length === 0 && matchedIdentityCount === values.length;
    const identicalTarget = complete && conflictIdentities.length === 0 && targetValues.size === 1;
    let status = "incomplete";
    if (identicalTarget) status = "complete";
    else if (complete && (targetValues.size > 1 || conflictIdentities.length > 0)) status = "conflict";

    const resolution = {
      mode,
      scope: mode === "singular" && values.length > 1 && identicalTarget
        ? "common_across_matching_records"
        : (values.length > 1 ? "record_set" : "single_identity"),
      status,
      requested_count: values.length,
      matched_identity_count: matchedIdentityCount,
      association_count: associationCount,
      missing_count: missingIdentities.length,
      conflict_count: conflictIdentities.length,
      missing_identities: missingIdentities,
      conflict_identities: conflictIdentities,
      mappings,
      path: Array.isArray(plan?.semantic_path) ? plan.semantic_path : [],
      evidence_relationships: Array.isArray(plan?.semantic_path_evidence) ? plan.semantic_path_evidence : []
    };

    if (mode === "singular" && values.length > 1 && !identicalTarget) {
      resolution.requires_clarification = true;
      resolution.message = status === "conflict"
        ? "I found multiple matching records with different related results. Please identify which record you mean."
        : "I found multiple matching records, so I could not safely identify one record for this follow-up. Please specify the record you mean.";
    }

    return {
      ...resolution,
      final_step_id: finalStepId,
      source_ids: [...new Set(mappings.flatMap(mapping => [mapping.from_source_id, mapping.to_source_id]).filter(Boolean))]
    };
  }

  _rememberPendingReference(question, plan, authorizedSources) {
    const value = extractEntitySearchText(question);
    if (!value || !this.context_manager?.setPendingReference) return;
    const steps = Array.isArray(plan?.execution_plan?.steps) ? plan.execution_plan.steps : [];
    const candidates = steps.length
      ? steps.map(step => ({ source_id: step.source_id, contract: step.contract }))
      : (plan?.postgresql_sources || []).map(source_id => ({ source_id, contract: plan }));
    const allowed = new Set((authorizedSources || []).map(source => String(source).toLowerCase()));
    for (const candidate of candidates) {
      const sourceId = String(candidate.source_id || "").toLowerCase();
      const contract = candidate.contract || {};
      const filter = (contract.filters || []).find(item => String(item?.value) === String(value) && item?.operator === "=");
      const table = String(filter?.table || contract.required_tables?.[0] || "");
      const column = String(filter?.field || filter?.column || "").split(".").at(-1);
      if (!sourceId || !table || !column || !allowed.has(sourceId)) continue;
      this.context_manager.setPendingReference({ source_id: sourceId, table, stable_keys: { [column]: value }, validation_status: "schema_validated_unretrieved", provenance: "explicit_user_identifier" });
      return;
    }
  }

  async _resolveEntity(question, conversationContext, authorizedSources = null) {
    const searchText = extractEntitySearchText(question);
    if (!searchText) {
      return;
    }

    const candidates = await this.entity_resolver.resolve(searchText, 5, authorizedSources);
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

  _getExternalApiSource(plan, dataSources, authorization) {
    if (!dataSources.includes("external_api")) return null;
    const sources = Array.isArray(plan.api_sources) ? plan.api_sources : [];
    if (sources.length !== 1 || typeof plan.api_operation !== "string") throw new Error("External API plans require one source and one approved operation.");
    const sourceId = String(sources[0]).trim().toLowerCase();
    if (!settings.externalApiSources?.[sourceId]) throw new Error("External API source is not registered.");
    if (authorization) assertAuthorizedExternalApiOperation(authorization, sourceId, plan.api_operation);
    return sourceId;
  }

  _getPostgresqlSources(plan, conversationContext = null, authorization = null) {
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
      const missingStepSources = [];
      const steps = Array.isArray(executionPlan.steps) ? executionPlan.steps : [];
      for (const step of steps) {
        if (!step || typeof step !== "object") continue;
        const sourceId = step.source_id;
        const stepType = String(step.type || step.step_type || "").trim().toLowerCase();
        if ((stepType === "source_query" || stepType === "final_query") &&
            (typeof sourceId !== "string" || !sourceId.trim())) {
          missingStepSources.push(String(step.id || step.step_id || "unknown"));
        }
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
      if (missingStepSources.length > 0) {
        const error = new Error(`Execution plan contains executable steps without source_id: ${missingStepSources.join(", ")}`);
        error.code = "MISSING_SOURCE_ID";
        throw error;
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
      // The router may safely resolve a source from source-qualified schema
      // requirements; it never supplies an implicit DB1 default.
      const routed = this.source_router.route(plan, conversationContext);
      sources = routed.postgresql_sources || [];
    }
    if (sources.length === 0) throw new Error("PostgreSQL was selected but no PostgreSQL source was specified.");

    let availableSources;
    try {
      availableSources = new Set(Object.keys(loadAllContexts()));
    } catch {
      availableSources = new Set(getRegisteredPostgresqlSourceIds());
    }

    const invalidSources = sources.filter(s => !availableSources.has(s));
    if (invalidSources.length > 0) {
      throw new Error(
        `Question plan selected unavailable PostgreSQL source(s): ${JSON.stringify(invalidSources)}`
      );
    }
    if (authorization) assertAuthorizedSources(authorization, sources);

    return sources;
  }

  _getSqlGenerator(sourceId) {
    const normalized = String(sourceId || "").trim().toLowerCase();
    if (!normalized) throw new Error("A PostgreSQL source_id is required for SQL generation.");
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

      const runtimeCategoricalFilters = (contractDict.filters || []).filter(filter => filter?.verification === "runtime_distinct_required");
      for (const filter of runtimeCategoricalFilters) {
        const table = String(filter.table || "").trim();
        const field = String(filter.field || filter.column || filter.column_name || "").split(".").at(-1);
        if (!table || !field) throw Object.assign(new Error("Categorical filter metadata is incomplete."), { code: "CATEGORICAL_FILTER_INVALID" });
        const requested = String(filter.value ?? "");
        const evidenceQuery = sqlGenerator.generateCategoricalExistence(table, field, requested, sourceId);
        const evidence = await this._executePostgresqlLive(evidenceQuery.query, sourceId, { parameters: evidenceQuery.parameters });
        if (!Array.isArray(evidence?.rows) || evidence.rows.length === 0) {
          throw Object.assign(new Error(`Requested categorical value was not verified for ${sourceId}.${table}.${field}.`), { code: "CATEGORICAL_VALUE_UNVERIFIED" });
        }
      }

      const generated = sqlGenerator.generatePrepared(contractDict, sourceId, runtimeBindings);
      let sql = generated.query;
      let executionBindings = {
        ...(runtimeBindings || {}),
        parameters: generated.parameters
      };
      let repaired = false;
      let retrieval;

      try {
        retrieval = await this._executePostgresqlLive(sql, sourceId, executionBindings);
      } catch (exc) {
        if (isSqlRepairableError(exc) && typeof sqlGenerator.repairPrepared === "function") {
          try {
            const repairedResult = sqlGenerator.repairPrepared(
              sql,
              String(exc.message || exc),
              contractDict,
              sourceId,
              runtimeBindings
            );
            sql = repairedResult.query;
            executionBindings = {
              ...(runtimeBindings || {}),
              parameters: repairedResult.parameters
            };
            repaired = true;
            retrieval = await this._executePostgresqlLive(sql, sourceId, executionBindings);
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
      logRuntimeDiagnostic(exc, { requestId: this.request_id, sourceId, phase: "postgresql_retrieval" });

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
    return await this.executor.execute(query, sourceId, parameters);
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

  async _retrieveExternalApi(plan, sourceId) {
    const context = this.plan_validator.contexts?.[sourceId];
    const config = settings.externalApiSources?.[sourceId];
    if (!context || context.source_type !== "external_api" || !config) throw new Error("External API metadata is unavailable.");
    const client = new ExternalApiClient(config, context);
    try {
      const retrieval = await client.retrieve(plan.api_operation);
      const source = { source_type: "external_api", source_id: sourceId, source: sourceId, resource: plan.api_operation, entities: [plan.api_operation], tables: [plan.api_operation], columns: retrieval.columns || [] };
      return { source_type: "external_api", source_id: sourceId, retrieval_status: retrieval.row_count ? "success_with_data" : "success_empty", retrieval: { ...retrieval, source_type: "external_api", resource: plan.api_operation }, sources: [source] };
    } catch (error) {
      return { source_type: "external_api", source_id: sourceId, retrieval_status: "retrieval_failed", retrieval: { rows: [], row_count: 0, columns: [], source_type: "external_api", resource: plan.api_operation }, sources: [], error: { type: error.name || "Error", message: String(error.message || error) } };
    }
  }

  _prepareEvidence(postgresResults, securityResult, complexExecution = null) {
    const evidence = { sources: [], items: [] };
    let evidenceSequence = 0;
    const appendLineage = (result) => {
      const rows = Array.isArray(result?.retrieval?.rows) ? result.retrieval.rows : [];
      const maxRows = Number.isInteger(this.evidence_manager?.maxRows)
        ? this.evidence_manager.maxRows
        : 50;
      const sources = Array.isArray(result?.sources) ? result.sources : [];
      const table = sources[0]?.tables?.[0] || null;
      for (const row of rows.slice(0, maxRows)) {
        evidence.items.push({
          evidence_id: `e${++evidenceSequence}`,
          source_id: result.source_id || null,
          execution_step_id: result.execution_step_id || result.step_id || null,
          table,
          retrieval_status: result.retrieval_status || "unknown",
          retrieved_at: result.retrieved_at || null,
          truncated: Boolean(result.retrieval?.truncated) || rows.length > maxRows,
          row
        });
      }
    };

    if (complexExecution !== null && complexExecution !== undefined) {
      const stepEvidence = [];
      for (const postgresResult of postgresResults) {
        appendLineage(postgresResult);
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
        appendLineage(postgresResult);
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
      const securityRows = Array.isArray(securityRetrieval.events) ? securityRetrieval.events : [];
      for (const row of securityRows) {
        evidence.items.push({ evidence_id: `e${++evidenceSequence}`, source_id: "security_logs", execution_step_id: null, table: null, retrieval_status: securityResult.retrieval_status || "unknown", retrieved_at: securityRetrieval.retrieved_at || null, freshness_status: securityRetrieval.freshness_status || "unknown", truncated: Boolean(securityRetrieval.truncated), row });
      }

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
        source_type: postgresResult.source_type || "postgresql",
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

  async _executeIndependentPostgresql(validatedPlan) {
    const postgresResults = [];
    const retrievalContracts = {};
    const steps = Array.isArray(validatedPlan?.execution_plan?.steps) ? validatedPlan.execution_plan.steps : [];
    for (const step of steps) {
      const sourceId = String(step?.source_id || "").trim().toLowerCase();
      if (!sourceId) {
        const error = new Error(`Independent execution step '${step?.id || "unknown"}' requires source_id.`);
        error.code = "MISSING_SOURCE_ID";
        throw error;
      }
      const sourcePlan = step.contract && typeof step.contract === "object" ? JSON.parse(JSON.stringify(step.contract)) : JSON.parse(JSON.stringify(validatedPlan));
      try {
        const sourceValidation = this._buildSourceValidation(sourcePlan, sourceId);
        if (!sourceValidation) throw new Error(`Source context unavailable for independent step '${step.id}'.`);
        const contract = createRetrievalContract(sourceValidation.plan);
        const contractDict = typeof contract.to_dict === "function" ? contract.to_dict() : contract.toDict();
        retrievalContracts[step.id] = contractDict;
        const result = await this._retrievePostgresql(contractDict, sourceId);
        result.execution_step_id = step.id;
        result.execution_purpose = step.purpose || "Independent source retrieval.";
        postgresResults.push(result);
      } catch (error) {
        logRuntimeDiagnostic(error, { requestId: this.request_id, sourceId, stepId: step.id, phase: "independent_postgresql_retrieval" });
        postgresResults.push({
          source_type: "postgresql",
          source_id: sourceId,
          execution_step_id: step.id,
          execution_purpose: step.purpose || "Independent source retrieval.",
          retrieval_status: "retrieval_failed",
          retrieval: { rows: [], row_count: 0, columns: [] },
          sql: null,
          repaired: false,
          sources: [],
          error: { type: error.name || "Error", message: String(error.message || error) }
        });
      }
    }
    return [postgresResults, retrievalContracts, null];
  }

  async ask(question, workspaceIdOrContext = null) {
    const cleanQuestion = this._validateQuestion(question);

    let workspaceId = null;
    let explicitConversationContext = null;

    let authorization = null;
    this.request_id = null;
    if (
      workspaceIdOrContext &&
      typeof workspaceIdOrContext === "object" &&
      (workspaceIdOrContext.history || workspaceIdOrContext.entities)
    ) {
      explicitConversationContext = workspaceIdOrContext;
    } else if (workspaceIdOrContext && typeof workspaceIdOrContext === "object") {
      workspaceId = this._validateWorkspaceId(workspaceIdOrContext.workspace_id);
      authorization = workspaceIdOrContext.authorization || null;
      this.request_id = workspaceIdOrContext.request_id || null;
    } else {
      workspaceId = this._validateWorkspaceId(workspaceIdOrContext);
    }

    this.llm_usage_tracker = createLlmUsageTracker(this.request_id);

    // Security Rule 4: Fail closed immediately if requesting confidential credentials or passwords
    if (isSensitiveQuestionIntent(cleanQuestion)) {
      return this._attachLlmUsage(sanitizeApiResponse({
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
      }));
    }

    const conversationContext = explicitConversationContext || this._getConversationContext();

    const authorizedPostgresqlSources = authorization?.postgresql_sources || null;
    this._restrictToAuthorizedSources(authorization);
    this._revalidateConversationReferences(conversationContext);
    await this._resolveEntity(cleanQuestion, conversationContext, authorizedPostgresqlSources);

    const planningQuestion = this._rewriteFollowupQuestion(cleanQuestion, conversationContext);
    let rawPlan;
    try {
      rawPlan = await this.planner.plan(planningQuestion, conversationContext, this.llm_usage_tracker);
    } catch (error) {
      return this._planningFailure(cleanQuestion, "PLAN_SCHEMA_INVALID", "I could not identify one verified, authorized data path for that request. Please specify the record or data area you want to inspect.");
    }
    if (rawPlan.clarification_required && typeof rawPlan.clarification_required.message === "string") {
      return this._planningFailure(cleanQuestion, "BUSINESS_CLARIFICATION", rawPlan.clarification_required.message);
    }
    if (
      Array.isArray(rawPlan.ambiguous_context_candidates) &&
      rawPlan.ambiguous_context_candidates.length > 1 &&
      rawPlan.candidate_resolution?.mode !== "independent"
    ) {
      return this._planningFailure(cleanQuestion, "SOURCE_AMBIGUOUS", "I found multiple schema-supported places that could answer this. Please specify which record or data area you mean.");
    }
    let validation = this.plan_validator.validate(rawPlan);

    let planRepaired = false;

    if (!validation.valid) {
      const validationErrors = validation.errors || [];
      const repairFn = typeof this.planner.repair_plan === "function"
        ? this.planner.repair_plan.bind(this.planner)
        : (typeof this.planner.repairPlan === "function" ? this.planner.repairPlan.bind(this.planner) : null);

      if (repairFn) {
        const repairedPlan = await repairFn(cleanQuestion, rawPlan, validationErrors, conversationContext);
        if (repairedPlan.clarification_required && typeof repairedPlan.clarification_required.message === "string") {
          return this._planningFailure(cleanQuestion, "BUSINESS_CLARIFICATION", repairedPlan.clarification_required.message);
        }
        if (
          Array.isArray(repairedPlan.ambiguous_context_candidates) &&
          repairedPlan.ambiguous_context_candidates.length > 1 &&
          repairedPlan.candidate_resolution?.mode !== "independent"
        ) {
          return this._planningFailure(cleanQuestion, "SOURCE_AMBIGUOUS", "I found multiple schema-supported places that could answer this. Please specify which record or data area you mean.");
        }
        const repairedValidation = this.plan_validator.validate(repairedPlan);

        if (!repairedValidation.valid) {
          return this._attachLlmUsage(sanitizeApiResponse({
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
          }));
        }

        validation = repairedValidation;
        planRepaired = true;
      } else {
        return this._attachLlmUsage(sanitizeApiResponse({
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
        }));
      }
    }

    const validatedPlan = validation.plan;

    const dataSources = this._getDataSources(validatedPlan);
    const securityResource = this._getSecurityResource(validatedPlan, dataSources);
    if (authorization) assertAuthorizedSecurityResource(authorization, securityResource);
    validatedPlan.security_resource = securityResource;
    let externalApiSource;
    try { externalApiSource = this._getExternalApiSource(validatedPlan, dataSources, authorization); }
    catch { return this._planningFailure(cleanQuestion, "SOURCE_NOT_AUTHORIZED", "The required authorized external API operation is unavailable for this question."); }

    let postgresqlSources;
    try {
      postgresqlSources = this._getPostgresqlSources(validatedPlan, conversationContext, authorization);
    } catch (error) {
      logRuntimeDiagnostic(error, { requestId: this.request_id, phase: "source_resolution" });
      const message = String(error?.message || "");
      const ambiguous = /ambiguous|deterministically identify/i.test(message);
      return this._planningFailure(cleanQuestion, ambiguous ? "SOURCE_AMBIGUOUS" : "SOURCE_NOT_AUTHORIZED", ambiguous
        ? "I could not safely determine which authorized data source should answer this. Please provide a more specific record or context."
        : "The required authorized data source is unavailable for this question.");
    }

    this._rememberPendingReference(cleanQuestion, validatedPlan, postgresqlSources);

    let postgresResults = [];
    const retrievalContracts = {};
    let complexExecution = null;

    if (postgresqlSources.length > 0) {
      const shouldDecomposeFn = this.complex_query_planner.should_decompose || this.complex_query_planner.shouldDecompose;
      const shouldDecompose = typeof shouldDecomposeFn === "function" && shouldDecomposeFn.call(this.complex_query_planner, cleanQuestion, validatedPlan);
      const independentPlan = validatedPlan.candidate_resolution?.mode === "independent" &&
        Array.isArray(validatedPlan.execution_plan?.steps) &&
        validatedPlan.execution_plan.steps.every(step => Array.isArray(step?.depends_on) && step.depends_on.length === 0 && Array.isArray(step?.input_bindings) && step.input_bindings.length === 0);

      if (independentPlan) {
        const independentRes = await this._executeIndependentPostgresql(validatedPlan);
        postgresResults = independentRes[0];
        Object.assign(retrievalContracts, independentRes[1]);
        complexExecution = independentRes[2];
      } else if (shouldDecompose) {
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
    if (externalApiSource) {
      postgresResults.push(await this._retrieveExternalApi(validatedPlan, externalApiSource));
    }

    const sourceStatus = this._buildSourceStatus(postgresResults, securityResult);
    this._updateActiveEntityFromExecution(cleanQuestion, validatedPlan, postgresResults.filter(result => result.source_type === "postgresql"));
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
      return this._attachLlmUsage(sanitizeApiResponse(result));
    }

    const candidateResolutionResult = this._resolveIndependentCandidateEvidence(validatedPlan, postgresResults);
    const followupIdentityResolution = this._resolveFollowupIdentityResolution(
      cleanQuestion,
      conversationContext,
      validatedPlan,
      postgresResults.filter(result => result.source_type === "postgresql")
    );
    const rawEvidence = this._prepareEvidence(postgresResults, securityResult, complexExecution);
    if (validatedPlan.candidate_resolution) rawEvidence.candidate_resolution = validatedPlan.candidate_resolution;
    if (candidateResolutionResult) rawEvidence.candidate_resolution_result = candidateResolutionResult;
    if (followupIdentityResolution) rawEvidence.relationship_resolution = followupIdentityResolution;
    const evidence = sanitizeEvidence(rawEvidence);
    const internalEvidenceMetrics = measureAnswerEvidenceStructure(evidence);
    const relationshipAnswerOptions = followupIdentityResolution
      ? {
        relationship: {
          final_step_id: followupIdentityResolution.final_step_id,
          source_ids: followupIdentityResolution.source_ids,
          resolution: followupIdentityResolution,
          path: followupIdentityResolution.path,
          evidence_relationships: followupIdentityResolution.evidence_relationships
        }
      }
      : {};
    const answerEvidence = typeof this.evidence_manager.prepareAnswerEvidence === "function"
      ? this.evidence_manager.prepareAnswerEvidence(evidence, relationshipAnswerOptions)
      : evidence;
    const answerEvidenceMetrics = measureAnswerEvidenceStructure(answerEvidence);
    recordAnswerEvidenceMetrics(this.llm_usage_tracker, {
      before: internalEvidenceMetrics,
      after: answerEvidenceMetrics
    });

    // Generate answer
    let answer;
    let answerGenerationStatus = "success";
    let answerGenerationError = null;

    if (followupIdentityResolution?.requires_clarification) {
      answer = followupIdentityResolution.message;
      answerGenerationStatus = "skipped_identity_ambiguity";
    } else try {
      answer = await this.answer_generator.generate(cleanQuestion, answerEvidence, null, null, this.llm_usage_tracker);
    } catch (exc) {
      logRuntimeDiagnostic(exc, { requestId: this.request_id, phase: "answer_generation" });
      const fallbackFn = typeof this.answer_generator.buildFallbackAnswer === "function"
        ? this.answer_generator.buildFallbackAnswer.bind(this.answer_generator)
        : (typeof this.answer_generator.build_fallback_answer === "function"
          ? this.answer_generator.build_fallback_answer.bind(this.answer_generator)
          : null);
      try {
        answer = fallbackFn
          ? fallbackFn(cleanQuestion, evidence)
          : "I retrieved live evidence successfully, but I could not generate the final answer from that evidence.";
      } catch {
        answer = "I retrieved live evidence successfully, but I could not generate the final answer from that evidence.";
      }
      answerGenerationStatus = "failed";
      answerGenerationError = {
        type: exc.name || "Error",
        message: String(exc.message || exc)
      };
    }

    // Retrieval evidence is authoritative for context even when the optional
    // answer provider is unavailable. Keep the verified record/set anchor so
    // the next turn can bind safely instead of losing conversation continuity.
    if (answerGenerationStatus === "success" || hasData) {
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

    if (candidateResolutionResult) result.candidate_resolution_result = candidateResolutionResult;

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

    return this._attachLlmUsage(sanitizeApiResponse(result));
  }

  _resolveIndependentCandidateEvidence(plan, postgresResults) {
    const resolution = plan?.candidate_resolution;
    if (!resolution || resolution.mode !== "independent") return null;
    const targets = Array.isArray(resolution.targets) ? resolution.targets : [];
    const perSource = postgresResults.map(result => {
      const rows = Array.isArray(result?.retrieval?.rows) ? result.retrieval.rows : [];
      const first = rows[0] || {};
      const rawCount = first.count ?? first.total_count ?? first["COUNT(*)"];
      const count = rawCount !== undefined && rawCount !== null && rawCount !== "" ? Number(rawCount) : rows.length;
      return {
        source_id: result.source_id || null,
        table: targets.find(target => target.source_id === result.source_id)?.table || null,
        retrieval_status: result.retrieval_status || "unknown",
        count: Number.isFinite(count) ? count : null
      };
    });

    const output = {
      overlap_status: resolution.overlap_status || "unknown",
      deduplication: resolution.deduplication || "not_performed",
      per_source: perSource,
      combined_total: null
    };

    if (resolution.deduplication !== "verified_identity") return output;

    const identityValues = [];
    for (const result of postgresResults) {
      const target = targets.find(item => item.source_id === result.source_id);
      const identityColumn = target?.identity_key;
      if (!identityColumn) return output;
      for (const row of Array.isArray(result?.retrieval?.rows) ? result.retrieval.rows : []) {
        const value = row[identityColumn] ?? row[String(identityColumn).split(".").pop()];
        if (value !== undefined && value !== null && String(value).trim()) identityValues.push(String(value).trim().toLowerCase());
      }
    }

    output.combined_total = new Set(identityValues).size;
    return output;
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
