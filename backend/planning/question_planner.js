import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getOpenAIClient, OPENAI_MODEL } from "../llm/openai_client.js";
import { recordLlmAttempt, recordPlannerContextMetrics } from "../llm/usage_tracker.js";
import { loadAllContexts } from "../context/context_store.js";
import { isSensitiveQuestionIntent, isMutationQuestionIntent } from "../security/sensitive_data_policy.js";
import { findSemanticCandidates, findVerifiedPaths } from "../context/semantic_catalog.js";
import { isSensitiveFieldName } from "../security/sensitive_data_policy.js";
import { extractEntitySearchText } from "../entity_resolution/entity_search.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

function tokenWords(value) {
  return (String(value || "").toLowerCase().match(/[a-z0-9_]+/g) || [])
    .map(token => token.endsWith("s") && token.length > 3 && !/(?:ss|us|is)$/i.test(token) ? token.slice(0, -1) : token);
}

function isStatusColumnName(value) {
  return /(?:^|_)(?:status|state|workflow_state|lifecycle_state)$/i.test(String(value || "").trim());
}

// Status labels are business metadata, but users routinely omit spaces,
// punctuation, or use a small grammatical variant ("inprogress",
// "in-progress", "in progress").  Compare only normalized forms; the value
// still comes from the approved semantic mapping or bounded runtime
// verification, never from this helper.
function normalizedSemanticPhrase(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .replace(/ies$/g, "y")
    .replace(/s$/g, "");
}

/**
 * Single semantic planner for the Context Layer.
 *
 * The LLM answers:
 *     WHAT does the user want?
 *
 * Deterministic application code answers:
 *     HOW should that intent be executed?
 */
export class QuestionPlanner {
  static CANONICAL_OPERATIONS = new Set([
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

  static OPERATION_ALIASES = {
    "lookup": "lookup",
    "retrieve": "lookup",
    "show": "lookup",
    "list": "lookup",
    "filter": "filter",
    "where": "filter",
    "count": "count",
    "number": "count",
    "how_many": "count",
    "sum": "sum",
    "total": "sum",
    "average": "average",
    "avg": "average",
    "mean": "average",
    "minimum": "minimum",
    "min": "minimum",
    "lowest": "minimum",
    "maximum": "maximum",
    "max": "maximum",
    "highest": "maximum",
    "comparison": "comparison",
    "compare": "comparison",
    "ranking": "ranking",
    "rank": "ranking",
    "top": "ranking",
    "grouping": "grouping",
    "group": "grouping",
    "aggregation": "aggregation",
    "aggregate": "aggregation",
    "general": "general",
  };

  static FILTER_OPERATOR_ALIASES = {
    "equals": "=",
    "eq": "=",
    "==": "=",
    "neq": "!=",
    "not_equals": "!=",
    "gt": ">",
    "gte": ">=",
    "lt": "<",
    "lte": "<=",
  };

  static ALLOWED_DATA_SOURCES = new Set([
    "postgresql",
    "security_logs",
    "external_api",
  ]);

  static SECURITY_RESOURCES = new Set([
    "security_logs",
    "cli_audit_logs",
    "security_logs_summary",
    "workspace_security_logs",
    "workspace_siem_status",
    "security_overview",
  ]);

  static EXECUTION_STEP_TYPES = new Set([
    "source_query",
    "final_query",
    "set_operation",
  ]);

  static SET_OPERATIONS = new Set([
    "intersect",
    "union",
    "union_all",
    "except",
    "distinct",
  ]);

  static BINDING_OPERATORS = new Set([
    "in",
    "not_in",
    "equals",
  ]);

  static MAX_EXECUTION_STEPS = 16;
  static MAX_CONTEXT_TABLES_PER_SOURCE = 200;
  static MAX_CONTEXT_COLUMNS_PER_TABLE = 100;
  static MAX_CONTEXT_RELATIONSHIPS = 500;

  static RECENT_QUESTION_TERMS = new Set([
    "recent",
    "latest",
    "newest",
    "most recent",
    "recently",
    "newly created",
    "new records",
    "recent records",
    "latest records",
    "newest records",
    "most recently",
  ]);

  static TEMPORAL_TYPE_HINTS = new Set([
    "date",
    "time",
    "timestamp",
    "datetime",
    "timestamptz",
    "timestamp without time zone",
    "timestamp with time zone",
  ]);

  static TEMPORAL_NAME_HINTS = new Set([
    "created",
    "updated",
    "modified",
    "changed",
    "timestamp",
    "datetime",
    "date",
    "time",
    "occurred",
    "started",
    "ended",
    "published",
    "completed",
    "submitted",
    "received",
  ]);

  static MAX_RECENT_CANDIDATES = 8;

  constructor(contexts = null) {
    this.CANONICAL_OPERATIONS = QuestionPlanner.CANONICAL_OPERATIONS;
    this.OPERATION_ALIASES = QuestionPlanner.OPERATION_ALIASES;
    this.FILTER_OPERATOR_ALIASES = QuestionPlanner.FILTER_OPERATOR_ALIASES;
    this.ALLOWED_DATA_SOURCES = QuestionPlanner.ALLOWED_DATA_SOURCES;
    this.SECURITY_RESOURCES = QuestionPlanner.SECURITY_RESOURCES;
    this.EXECUTION_STEP_TYPES = QuestionPlanner.EXECUTION_STEP_TYPES;
    this.SET_OPERATIONS = QuestionPlanner.SET_OPERATIONS;
    this.BINDING_OPERATORS = QuestionPlanner.BINDING_OPERATORS;
    this.MAX_EXECUTION_STEPS = QuestionPlanner.MAX_EXECUTION_STEPS;
    this.MAX_CONTEXT_TABLES_PER_SOURCE = QuestionPlanner.MAX_CONTEXT_TABLES_PER_SOURCE;
    this.MAX_CONTEXT_COLUMNS_PER_TABLE = QuestionPlanner.MAX_CONTEXT_COLUMNS_PER_TABLE;
    this.MAX_CONTEXT_RELATIONSHIPS = QuestionPlanner.MAX_CONTEXT_RELATIONSHIPS;
    this.RECENT_QUESTION_TERMS = QuestionPlanner.RECENT_QUESTION_TERMS;
    this.TEMPORAL_TYPE_HINTS = QuestionPlanner.TEMPORAL_TYPE_HINTS;
    this.TEMPORAL_NAME_HINTS = QuestionPlanner.TEMPORAL_NAME_HINTS;
    this.MAX_RECENT_CANDIDATES = QuestionPlanner.MAX_RECENT_CANDIDATES;

    this.contexts = contexts !== null && contexts !== undefined ? contexts : loadAllContexts();

    if (!this.contexts || typeof this.contexts !== "object" || Array.isArray(this.contexts) || Object.keys(this.contexts).length === 0) {
      throw new Error("No Context Layer sources are available.");
    }

    try {
      this.client = getOpenAIClient();
    } catch {
      this.client = null;
    }
  }

  // ------------------------------------------------------------------
  // Public planner API
  // ------------------------------------------------------------------

  async plan(question, conversationContext = null, usageTracker = null) {
    if (typeof question !== "string" || !question.trim()) {
      throw new Error("Question cannot be empty.");
    }

    const trimmedQuestion = question.trim();
    if (conversationContext && typeof conversationContext === "object" && !Array.isArray(conversationContext)) {
      try {
        Object.defineProperty(conversationContext, "_reference_question", {
          value: trimmedQuestion,
          enumerable: false,
          configurable: true,
          writable: true
        });
      } catch {
        // A caller may provide a sealed context object; reference selection
        // remains safely anchored to active_context in that case.
      }
    }
    const normalizePlan = (candidate, recordDeterministicMetrics = true) => {
      if (recordDeterministicMetrics) recordPlannerContextMetrics(usageTracker, {
          mode: "deterministic",
          context_characters: 0,
          prompt_characters: 0,
          focused_table_count: 0,
          focused_relationship_count: 0,
          verified_path_count: 0,
          candidate_count: 0
        });
      return this._normalize_plan(candidate, trimmedQuestion, conversationContext);
    };

    // Sensitive credential security check
    if (typeof isSensitiveQuestionIntent === "function" && isSensitiveQuestionIntent(trimmedQuestion)) {
      const err = new Error("Access to credentials, passwords, tokens, and confidential secrets is strictly restricted.");
      err.isSensitiveViolation = true;
      throw err;
    }

    // Authoritative sources are permanently read-only.  Reject explicit
    // mutation intent before deterministic candidate selection or any
    // provider call so a write request can never become an unrelated SELECT.
    if (typeof isMutationQuestionIntent === "function" && isMutationQuestionIntent(trimmedQuestion)) {
      const err = new Error("Connected authoritative data sources are read-only; I cannot perform data or schema modifications.");
      err.isReadOnlyMutationViolation = true;
      err.code = "READ_ONLY_MUTATION_REJECTED";
      throw err;
    }

    // A specific-record lookup has a smaller, stronger contract than an LLM
    // relationship plan: one authorized semantic entity plus one discovered
    // identifier/display filter.  Prefer it before invoking a provider so a
    // malformed provider plan cannot add unrelated tables to a detail query.
    const deterministicDetail = this._build_metadata_fallback_plan(trimmedQuestion, conversationContext);
    if (this._is_bounded_detail_lookup(trimmedQuestion, deterministicDetail)) {
      return normalizePlan(deterministicDetail);
    }

    // For an explicit ordinary table noun, the existing metadata fallback is
    // already schema-grounded and source-qualified. Do not let a variable
    // provider response replace it with an invalid relationship or projection
    // contract. Generic project wording remains source-ambiguous and is not
    // covered by this early return.
    const deterministicSteps = Array.isArray(deterministicDetail?.execution_plan?.steps)
      ? deterministicDetail.execution_plan.steps
      : [];
    const deterministicHasTarget = Array.isArray(deterministicDetail?.required_tables) && deterministicDetail.required_tables.length > 0;
    const deterministicHasExplicitTable = deterministicHasTarget && deterministicDetail.required_tables.some(table =>
      this._explicit_table_phrase(trimmedQuestion, table)
    );
    const deterministicHasVerifiedFilter =
      (Array.isArray(deterministicDetail?.filters) && deterministicDetail.filters.some(filter => filter?.verification === "runtime_distinct_required")) ||
      deterministicSteps.some(step => Array.isArray(step?.contract?.filters) && step.contract.filters.some(filter => filter?.verification === "runtime_distinct_required"));
    const deterministicIndependentPlan = deterministicDetail?.candidate_resolution?.mode === "independent" &&
      deterministicSteps.length > 0 &&
      deterministicSteps.every(step => Array.isArray(step?.contract?.required_tables) && step.contract.required_tables.length > 0);
    // Named relationship requests are completely schema-grounded when the
    // display-name lookup and every hop use declared same-source FKs.  Return
    // these plans before calling a provider: that avoids both an unbounded
    // fallback and an unnecessary planning-model request.
    const deterministicRelationshipPlan = deterministicDetail?.named_relationship_lookup === true &&
      deterministicSteps.length > 1 &&
      deterministicSteps.every(step => Array.isArray(step?.contract?.required_tables) && step.contract.required_tables.length === 1);
    const deterministicRecentPlan = Array.isArray(deterministicDetail?.operations) &&
      deterministicDetail.operations.includes("ranking") &&
      Array.isArray(deterministicDetail.sorting) &&
      deterministicDetail.sorting.length > 0;
    if (
      deterministicDetail &&
      !deterministicDetail.clarification_required &&
      (deterministicHasExplicitTable || deterministicHasVerifiedFilter || deterministicIndependentPlan || deterministicRelationshipPlan || deterministicRecentPlan)
    ) {
      return normalizePlan(deterministicDetail);
    }

    if (!this.client) {
      try { this.client = getOpenAIClient(); } catch { this.client = null; }
    }

    const context = this._build_context_for_llm(trimmedQuestion, conversationContext);
    const resolvedEntities = this._build_resolved_entity_context(conversationContext);
    const prompt = this._build_prompt(
      trimmedQuestion,
      context,
      conversationContext,
      resolvedEntities
    );
    const contextSources = context && typeof context.sources === "object" ? Object.values(context.sources) : [];
    recordPlannerContextMetrics(usageTracker, {
      mode: "provider",
      context_characters: (() => {
        try { return JSON.stringify(context).length; } catch { return 0; }
      })(),
      prompt_characters: prompt.length,
      focused_table_count: contextSources.reduce((count, source) => count + Object.keys(source?.tables || {}).length, 0),
      focused_relationship_count: contextSources.reduce((count, source) => count + (Array.isArray(source?.relationships) ? source.relationships.length : 0) + (Array.isArray(source?.business_relationships) ? source.business_relationships.length : 0), 0),
      verified_path_count: Array.isArray(context?.verified_paths) ? context.verified_paths.length : 0,
      candidate_count: Array.isArray(context?.candidate_entities) ? context.candidate_entities.length : 0
    });

    let content = "";

    if (this.client?.responses?.create) {
      try {
        const response = await this.client.responses.create({
          model: OPENAI_MODEL,
          input: prompt,
        });
        recordLlmAttempt(usageTracker, {
          stage: "planner",
          transport: "responses",
          model: OPENAI_MODEL,
          response,
          status: (response.output_text ?? response.output) ? "success" : "empty"
        });
        content = (response.output_text ?? response.output ?? "").trim();
      } catch (error) {
        recordLlmAttempt(usageTracker, {
          stage: "planner",
          transport: "responses",
          model: OPENAI_MODEL,
          status: "error",
          error
        });
        content = "";
      }
    }

    if (!content && this.client?.chat?.completions?.create) {
      try {
        const completion = await this.client.chat.completions.create({
          model: OPENAI_MODEL,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          temperature: 0.1,
        });
        content = (completion.choices?.[0]?.message?.content ?? "").trim();
        recordLlmAttempt(usageTracker, {
          stage: "planner",
          transport: "chat_completions",
          model: OPENAI_MODEL,
          response: completion,
          status: completion.choices?.[0]?.message?.content ? "success" : "empty"
        });
      } catch (error) {
        recordLlmAttempt(usageTracker, {
          stage: "planner",
          transport: "chat_completions",
          model: OPENAI_MODEL,
          status: "error",
          error
        });
        content = "";
      }
    }

    if (!content) {
      const fallback = this._build_metadata_fallback_plan(trimmedQuestion, conversationContext);
      if (fallback) return normalizePlan(fallback, false);
      throw new Error("Question planner could not produce a schema-grounded retrieval plan.");
    }

    let rawPlan;
    try { rawPlan = this._parse_json_response(content); } catch {
      const fallback = this._build_metadata_fallback_plan(trimmedQuestion, conversationContext);
      if (fallback) return normalizePlan(fallback, false);
      throw new Error("Question planner returned an invalid retrieval plan.");
    }

    // Repair an otherwise valid JSON response before normalization can infer
    // an unrelated schema anchor from an empty provider target.
    const providerSteps = Array.isArray(rawPlan?.execution_plan?.steps) ? rawPlan.execution_plan.steps : [];
    const executableProviderSteps = providerSteps.filter(step => ["source_query", "final_query", "source", "final", "query"].includes(String(step?.type || step?.step_type || "").toLowerCase()));
    const providerStepsAreGrounded = executableProviderSteps.length === 0 || executableProviderSteps.every(step =>
      Array.isArray(step?.contract?.required_tables) && step.contract.required_tables.length > 0
    );
    const providerHasExecutableTarget = providerStepsAreGrounded && (
      (Array.isArray(rawPlan?.required_tables) && rawPlan.required_tables.length > 0) ||
      executableProviderSteps.length > 0
    );
    if (!providerHasExecutableTarget && !rawPlan?.clarification_required) {
      const incompleteProviderFallback = this._build_metadata_fallback_plan(trimmedQuestion, conversationContext);
      const fallbackSteps = Array.isArray(incompleteProviderFallback?.execution_plan?.steps) ? incompleteProviderFallback.execution_plan.steps : [];
      const fallbackHasTarget =
        (Array.isArray(incompleteProviderFallback?.required_tables) && incompleteProviderFallback.required_tables.length > 0) ||
        fallbackSteps.some(step => Array.isArray(step?.contract?.required_tables) && step.contract.required_tables.length > 0);
      if (fallbackHasTarget) {
        return normalizePlan(incompleteProviderFallback, false);
      }
    }

    let normalizedPlan = this._normalize_plan(
      rawPlan,
      trimmedQuestion,
      conversationContext
    );
    // Provider output may preserve a technical tie between authorized
    // candidates even when this operation can safely retrieve each source
    // independently. Reuse the existing deterministic metadata fallback for
    // count questions only; singular and relationship ambiguity remains strict.
    if (
      this._is_count_question(trimmedQuestion, []) &&
      Array.isArray(normalizedPlan.ambiguous_context_candidates) &&
      normalizedPlan.ambiguous_context_candidates.length > 1
    ) {
      const independentFallback = this._build_metadata_fallback_plan(trimmedQuestion, conversationContext);
      if (independentFallback?.candidate_resolution?.mode === "independent") {
        normalizedPlan = this._normalize_plan(independentFallback, trimmedQuestion, conversationContext);
      }
    }

    normalizedPlan = this._complete_temporal_plan_if_needed(
      normalizedPlan,
      trimmedQuestion
    );

    return normalizedPlan;
  }

  _build_metadata_fallback_plan(question, conversationContext = null) {
    question = String(question).replace(/\s+\[context\s+[^\]]+\]\s*$/i, "").trim();
    const namedRelationshipPlan = this._build_possessive_task_assignment_plan(question) || this._build_named_relationship_plan(question) || this._build_named_company_users_plan(question);
    if (namedRelationshipPlan) return namedRelationshipPlan;
    const verifiedRelationshipPlan = !this._conversation_reference(conversationContext)
      ? this._build_verified_relationship_plan(question)
      : null;
    if (verifiedRelationshipPlan) return verifiedRelationshipPlan;
    const active = this._conversation_reference(conversationContext);
    const refersBack = /\b(?:it|its|that|this|those|these|details?)\b/i.test(question);
    const recordSet = active?.record_set;
    if (recordSet && this._is_record_set_reference(question, active) && !this._has_explicit_new_target(question, active) && active.source_id && active.table && Array.isArray(recordSet.values) && recordSet.values.length > 0) {
      const tableInfo = this.contexts?.[active.source_id]?.tables?.[active.table] || {};
      const safeColumns = (tableInfo.columns || []).map(column => String(column?.name || column || "")).filter(Boolean);
      const identityFilter = this._active_record_set_identity_filter(question, active, tableInfo);
      if (identityFilter?.unsupported) {
        return {
          data_sources: ["postgresql"],
          postgresql_sources: [String(active.source_id).toLowerCase()],
          required_tables: [active.table],
          required_columns: [],
          filters: [],
          operations: [],
          clarification_required: {
            type: "unsupported_identity_qualifier",
            message: "I could not verify that identity qualifier for the referenced records, so I did not broaden the retrieval."
          }
        };
      }
      return {
        data_sources: ["postgresql"],
        postgresql_sources: [String(active.source_id).toLowerCase()],
        required_tables: [active.table],
        required_columns: safeColumns.map(column => `${active.table}.${column}`).slice(0, 20),
        filters: [
          { table: active.table, field: recordSet.key_column, operator: "in", value: recordSet.values },
          ...(identityFilter ? [identityFilter] : [])
        ],
        relationships: [],
        operations: ["lookup"],
        limit: Math.max(recordSet.values.length, 1),
        needs_conversation_context: true,
        entity_target: { source_id: active.source_id, table: active.table },
        confidence: 0.9,
        reasoning: "A plural contextual reference was resolved to the source-qualified identities returned by the preceding retrieval."
      };
    }
    const semanticCandidates = findSemanticCandidates(question, this.contexts);
    const buildCandidate = (candidate, sourceId, table, tableInfo, relevance) => {
      const columns = (Array.isArray(tableInfo?.columns) ? tableInfo.columns : [])
        .map(column => String(column?.name || column || ""))
        .filter(Boolean)
        .filter(column => !isSensitiveFieldName(column));
      const enriched = {
        ...candidate,
        source_id: sourceId || candidate?.source_id,
        table: table || candidate?.table,
        relevance,
        columns,
        primary_keys: Array.isArray(tableInfo?.primary_keys) ? tableInfo.primary_keys : []
      };
      return {
        ...enriched,
        display_filters: this._explicit_display_filters(question, enriched),
        status_columns: columns.filter(isStatusColumnName)
      };
    };
    let candidates = semanticCandidates.map(candidate => {
      const info = this.contexts[candidate.source_id]?.tables?.[candidate.table] || {};
      const relevance = this._explicit_table_phrase(question, candidate.table)
          ? Math.max(candidate.score, this._table_question_relevance(candidate.source_id, candidate.table, question)) + 40
          : candidate.score;
      return buildCandidate(candidate, candidate.source_id, candidate.table, info, relevance);
    });
    // Semantic overlays cover important business entities, but do not need to
    // enumerate every ordinary source table. Keep lexical metadata candidates
    // in the same ranking set so an explicit table noun such as "invoices" or
    // "action items" cannot be displaced merely because "recent" caused a
    // temporal semantic candidate to exist.
    const existingCandidateKeys = new Set(candidates.map(candidate => `${candidate.source_id}:${candidate.table}`));
    for (const [sourceId, context] of Object.entries(this.contexts || {})) {
      for (const [table, info] of Object.entries(context?.tables || {})) {
        if (existingCandidateKeys.has(`${sourceId}:${table}`)) continue;
        const relevance = this._table_question_relevance(sourceId, table, question);
        if (relevance <= 0) continue;
        if (active && refersBack && !this._explicit_table_phrase(question, table)) continue;
        candidates.push(buildCandidate(
          { source_id: sourceId, table },
          sourceId,
          table,
          info,
          relevance + (this._explicit_table_phrase(question, table) ? 40 : 0)
        ));
      }
    }
    // A named-record request must be evaluated against the schema capability
    // needed to satisfy it.  An equally named table that has no discovered
    // display/name or status column cannot displace a candidate that can
    // actually execute the request.  If multiple candidates have the needed
    // capability, retain all of them and let the existing ambiguity safeguards
    // continue to apply.
    const asksForStatus = /\b(?:status|state|workflow|lifecycle)\b/i.test(question);
    const capableCandidates = candidates.filter(candidate =>
      (!candidates.some(item => item.display_filters.length > 0) || candidate.display_filters.length > 0) &&
      (!asksForStatus || candidate.status_columns.length > 0)
    );
    if (capableCandidates.length > 0 && capableCandidates.length < candidates.length) {
      candidates = capableCandidates;
    }
    // An explicit identity qualifier narrows the candidate set before source
    // ambiguity is evaluated.  Never retain unrelated entity tables merely
    // because they share a lexical noun with the question.
    const identityCandidates = candidates.filter(candidate => this._explicit_identity_filter(question, candidate));
    if (identityCandidates.length > 0 && identityCandidates.length < candidates.length) {
      candidates = identityCandidates;
    }
    // If the user is asking about the already established entity itself,
    // preserve that bounded lookup. Requests for a distinct semantic target
    // (transcript, project, etc.) continue to relationship resolution below.
    const explicitNewRecord = candidates.some(candidate => this._explicit_identity_filter(question, candidate) || candidate.display_filters.length > 0);
    if (active && refersBack && !explicitNewRecord && candidates.length && !candidates.some(candidate => candidate.source_id === active.source_id && candidate.table !== active.table)) {
      return { data_sources: ["postgresql"], postgresql_sources: [], required_tables: [], required_columns: [], filters: [], relationships: [], operations: ["lookup"], needs_conversation_context: true, confidence: 0.8 };
    }
    const namedCandidates = candidates.filter(candidate => candidate.display_filters.length > 0);
    if (namedCandidates.length > 1) {
      return {
        data_sources: ["postgresql"],
        postgresql_sources: [],
        required_tables: [],
        required_columns: [],
        operations: [],
        ambiguous_context_candidates: namedCandidates.map(candidate => ({ source_id: candidate.source_id, table: candidate.table }))
      };
    }
    candidates.sort((left, right) => right.relevance - left.relevance || left.source_id.localeCompare(right.source_id) || left.table.localeCompare(right.table));
    if (!candidates.length) return null;
    let best = candidates[0];
    const isCount = this._is_count_question(question, candidates);
    const isRecent = this._is_recent_records_question(question);
    const hasStatusIntent = candidates.some(candidate => this._has_unverified_status_intent(candidate, question));
    const isIndependent = isCount || hasStatusIntent || /\b(?:list|which|compare|comparison|each|all)\b/i.test(question);
    let tied = candidates.filter(candidate => candidate.relevance === best.relevance);
    // A deictic request can be disambiguated by one discovered direct FK from
    // the established source-qualified reference. This is schema-driven and
    // never guesses from matching table names.
    if (active && refersBack && tied.length > 1) {
      const related = tied.filter(candidate => candidate.source_id === active.source_id && (this.contexts?.[active.source_id]?.relationships || []).some(rel =>
        (rel.source_table === active.table && rel.target_table === candidate.table) ||
        (rel.target_table === active.table && rel.source_table === candidate.table)
      ));
      if (related.length === 1) {
        tied = related;
        best = related[0];
      }
    }
    if (tied.length > 1 && isIndependent) {
      return this._build_independent_candidate_plan(question, tied, isCount, semanticCandidates);
    }
    if (tied.length > 1) {
      return { data_sources: ["postgresql"], postgresql_sources: [], required_tables: [], required_columns: [], operations: [], ambiguous_context_candidates: tied.map(candidate => ({ source_id: candidate.source_id, table: candidate.table })) };
    }
    const temporalCompanion = isRecent ? this._find_temporal_companion(best, candidates) : null;
    const timeColumn = best.ordering_column || (best.columns.map(name => ({ name, score: this._recent_column_score({ name, type: "" }) })).filter(item => item.score > 0).sort((left, right) => right.score - left.score)[0] || {}).name;
    const orderingTable = timeColumn ? best.table : temporalCompanion?.table;
    const orderingColumn = timeColumn || temporalCompanion?.ordering_column;
    const statusIntent = this._has_unverified_status_intent(best, question);
    const statusFilter = this._verified_status_filter(best, question) || (statusIntent ? this._discovered_categorical_filter(best, question) : null);
    if (statusIntent && !statusFilter) {
      return {
        data_sources: ["postgresql"],
        postgresql_sources: [best.source_id],
        required_tables: [best.table],
        required_columns: [],
        operations: [],
        clarification_required: {
          type: "business_status_semantics",
          message: "I could not verify the requested status meaning for these records. Please specify the status or workflow definition you want me to use."
        }
      };
    }
    const requiredTables = temporalCompanion ? [best.table, temporalCompanion.table] : [best.table];
    const identifierFilter = this._explicit_identity_filter(question, best);
    const displayFilters = identifierFilter ? [] : (best.display_filters || this._explicit_display_filters(question, best));
    const persistedDisplayFilters = displayFilters.map(filter => {
      const { provenance: _provenance, name_component: _nameComponent, ...plain } = filter;
      return plain;
    });
    const requiredColumns = isCount ? [] : Array.from(new Set([
      ...best.primary_keys.map(column => `${best.table}.${column}`),
      ...best.columns.map(column => `${best.table}.${column}`),
      ...(temporalCompanion ? [`${temporalCompanion.table}.${temporalCompanion.ordering_column}`] : [])
    ])).slice(0, 20);
    for (const column of best.status_columns || []) {
      if (/\b(?:status|state|workflow|lifecycle)\b/i.test(question) && !requiredColumns.includes(`${best.table}.${column}`)) {
        requiredColumns.push(`${best.table}.${column}`);
      }
    }
    return {
      data_sources: ["postgresql"], postgresql_sources: [best.source_id], required_tables: requiredTables, required_columns: requiredColumns,
      relationships: temporalCompanion ? [temporalCompanion.relationship] : [], filters: [...(statusFilter ? [statusFilter] : []), ...(identifierFilter ? [identifierFilter] : []), ...persistedDisplayFilters], operations: [isCount ? "count" : (isRecent ? "ranking" : "lookup")],
      sorting: isRecent && orderingTable && orderingColumn ? [{ field: `${orderingTable}.${orderingColumn}`, direction: "desc" }] : [], limit: isCount ? null : (isRecent ? 10 : 50), confidence: 0.65,
      entity_target: { source_id: best.source_id, table: best.table },
      named_entity_lookup: displayFilters.length > 0,
      semantic_candidates: semanticCandidates.length > 0 ? semanticCandidates.slice(0, 8) : undefined,
      reasoning: "A bounded metadata-only fallback selected one unambiguous authorized semantic catalog candidate after the semantic planner was unavailable."
    };
  }

  _build_verified_relationship_plan(question) {
    const text = String(question || "").trim();
    const relationshipCue = /\b(?:belongs?|associated|related|linked|connect(?:ed)?|with|alongside|their|its)\b/i.test(text) ||
      /\b(?:each|every)\s+[a-z][a-z'-]*['\u2019]s\b/i.test(text);
    if (!text || !relationshipCue) return null;

    const candidates = findSemanticCandidates(text, this.contexts)
      .filter(candidate => Array.isArray(candidate.matched_aliases) && candidate.matched_aliases.length > 0);
    if (candidates.length < 2) return null;
    const roleForNode = new Map(candidates.map(candidate => [`${candidate.source_id}:${candidate.table}`, this._semantic_role_key(candidate)]));
    const roles = new Set(roleForNode.values());
    if (roles.size < 2) return null;

    const firstMention = candidate => Math.min(...candidate.matched_aliases
      .map(alias => text.toLowerCase().indexOf(String(alias).toLowerCase()))
      .filter(index => index >= 0));
    const anchorCandidate = [...candidates]
      .map(candidate => ({ candidate, position: firstMention(candidate) }))
      .filter(item => Number.isFinite(item.position))
      .sort((left, right) => left.position - right.position || right.candidate.score - left.candidate.score)[0]?.candidate;
    if (!anchorCandidate) return null;

    const paths = findVerifiedPaths(text, this.contexts)
      .filter(path => path?.validation_status === "validated" && Array.isArray(path.steps) && path.steps.length > 1);
    if (!paths.length) return null;

    const reverseEvidence = evidence => {
      const [left, right] = String(evidence || "").split(" -> ");
      return left && right ? `${right} -> ${left}` : evidence;
    };
    const endpointMatches = (value, step, strict = false) => {
      const [source, table, column] = String(value || "").split(".");
      return String(source).toLowerCase() === String(step?.source_id || "").toLowerCase() &&
        String(table) === String(step?.table) && (!strict || !column || !step?.column || String(column) === String(step.column));
    };
    const adjacency = new Map();
    const addEdge = (from, to, evidence) => {
      const key = `${from.source_id}:${from.table}`;
      if (!adjacency.has(key)) adjacency.set(key, []);
      const targetKey = `${to.source_id}:${to.table}`;
      if (!adjacency.get(key).some(edge => edge.targetKey === targetKey && edge.evidence === evidence)) {
        adjacency.get(key).push({ node: { ...to }, evidence, targetKey });
      }
    };
    for (const path of paths) {
      for (let index = 0; index < path.steps.length - 1; index++) {
        const left = path.steps[index];
        const right = path.steps[index + 1];
        const exactEvidence = (path.evidence_relationships || []).find(item => {
          const [from, to] = String(item || "").split(" -> ");
          return (endpointMatches(from, left, true) && endpointMatches(to, right, true)) || (endpointMatches(from, right, true) && endpointMatches(to, left, true));
        });
        const evidence = exactEvidence || (path.evidence_relationships || []).find(item => {
          const [from, to] = String(item || "").split(" -> ");
          return (endpointMatches(from, left) && endpointMatches(to, right)) || (endpointMatches(from, right) && endpointMatches(to, left));
        });
        if (!evidence) continue;
        const forward = endpointMatches(String(evidence).split(" -> ")[0], left) ? evidence : reverseEvidence(evidence);
        addEdge(left, right, forward);
        addEdge(right, left, reverseEvidence(forward));
      }
    }

    const anchorRole = this._semantic_role_key(anchorCandidate);
    const targetRoles = new Set([...roles].filter(role => role !== anchorRole));
    const startKey = `${anchorCandidate.source_id}:${anchorCandidate.table}`;
    const queue = [{ nodes: [{ source_id: anchorCandidate.source_id, table: anchorCandidate.table, column: null }], evidence: [] }];
    const completePaths = [];
    while (queue.length && completePaths.length < 16) {
      const state = queue.shift();
      const last = state.nodes.at(-1);
      const covered = new Set(state.nodes.map(node => roleForNode.get(`${node.source_id}:${node.table}`)).filter(Boolean));
      if ([...targetRoles].every(role => covered.has(role))) {
        completePaths.push(state);
        continue;
      }
      if (state.nodes.length >= 5) continue;
      for (const edge of adjacency.get(`${last.source_id}:${last.table}`) || []) {
        if (state.nodes.some(node => `${node.source_id}:${node.table}` === edge.targetKey)) continue;
        queue.push({ nodes: [...state.nodes, edge.node], evidence: [...state.evidence, edge.evidence] });
      }
    }
    if (!completePaths.length) return null;
    completePaths.sort((left, right) => {
      const uuidScore = path => path.nodes.some(node => ["id", "project_id"].includes(String(node.column || "").toLowerCase())) ? 1 : 0;
      return left.nodes.length - right.nodes.length || uuidScore(right) - uuidScore(left);
    });
    const selected = completePaths[0];
    const bindings = selected.nodes.slice(1).map((node, index) => this._path_binding(selected.nodes[index], node, selected.evidence));
    if (bindings.some(binding => !binding)) return null;
    const semanticPath = selected.nodes.map(node => ({ ...node }));
    if (semanticPath[0] && bindings[0]?.from_column) semanticPath[0].column = bindings[0].from_column;

    const safeProjection = (node, incoming, outgoing) => {
      const tableInfo = this.contexts?.[node.source_id]?.tables?.[node.table] || {};
      const names = (tableInfo.columns || []).map(column => String(column?.name || column || ""))
        .filter(column => column && !isSensitiveFieldName(column));
      const preferred = names.filter(column => /(?:^|_)(?:id|name|title|label|display|code|project|meeting)(?:_|$)/i.test(column));
      return Array.from(new Set([
        ...(Array.isArray(tableInfo.primary_keys) ? tableInfo.primary_keys : []),
        node.column,
        incoming?.to_column,
        outgoing?.from_column,
        ...preferred.slice(0, 8)
      ].filter(Boolean))).slice(0, 12);
    };
    const steps = selected.nodes.map((node, index) => {
      const incoming = index > 0 ? bindings[index - 1] : null;
      const outgoing = index < bindings.length ? bindings[index] : null;
      const columns = safeProjection(node, incoming, outgoing);
      return {
        id: `s${index + 1}`,
        type: index === selected.nodes.length - 1 ? "final_query" : "source_query",
        source_id: node.source_id,
        contract: {
          question: text,
          data_sources: ["postgresql"],
          postgresql_sources: [node.source_id],
          required_tables: [node.table],
          required_columns: columns.map(column => `${node.table}.${column}`),
          relationships: [], filters: [], operations: ["lookup"], limit: 50, sorting: [], entities: []
        },
        depends_on: index === 0 ? [] : [`s${index}`], inputs: [],
        input_bindings: index === 0 ? [] : [{ from_step: `s${index}`, from_column: incoming.from_column, to_table: node.table, to_column: incoming.to_column, operator: "in" }],
        output_columns: columns.map(column => `${node.table}.${column}`),
        purpose: `Retrieve the verified relationship graph step for ${node.source_id}.${node.table}.`
      };
    });
    const recent = this._is_recent_records_question(text);
    const recentCandidate = recent
      ? this._build_recent_record_candidates().find(candidate => candidate.source_id === selected.nodes[0].source_id && candidate.table === selected.nodes[0].table)
      : null;
    if (recent && !recentCandidate?.time_column) return null;
    const operations = recent ? ["ranking"] : ["lookup"];
    const sorting = recent ? [{ field: `${selected.nodes[0].table}.${recentCandidate.time_column}`, direction: "desc" }] : [];
    if (recent) {
      steps[0].contract.operations = operations;
      steps[0].contract.sorting = sorting;
      steps[0].contract.limit = 10;
    }
    return {
      question: text, data_sources: ["postgresql"],
      postgresql_sources: [...new Set(selected.nodes.map(node => node.source_id))].sort(),
      required_tables: [], required_columns: [], relationships: [], filters: [], operations, sorting, limit: recent ? 10 : 50,
      execution_plan: { mode: "multi_step", steps, final_step: `s${steps.length}` },
      semantic_path: semanticPath, semantic_path_evidence: selected.evidence,
      named_relationship_lookup: true, relationship_plan_kind: "verified_graph", ambiguous_context_candidates: [],
      confidence: 0.95, reasoning: "A complete authorized relationship graph was composed from validated semantic paths."
    };
  }

  _build_named_relationship_plan(question) {
    // This is deliberately a narrow deterministic grammar.  It covers a
    // common possessive form ("Umar Daraz company ...") only when the schema
    // can prove the complete same-source path.  Other wording still follows
    // the existing semantic/LLM planning flow.
    const originalSubject = String(question || "")
      .replace(/^\s*(?:show|find|list|display|give)(?:\s+me)?\s+/i, "")
      .trim();
    // Without a possessive marker, a single-token "X Company" is a company
    // display name (the established company→users path), not a person's
    // first name.  A multi-token person name remains supported.
    if (/^[a-z][a-z'-]*\s+company\b/i.test(originalSubject) && !/['\u2019]s\b/i.test(originalSubject)) return null;
    const subject = originalSubject
      .replace(/^\s*(?:show|find|list|display|give)(?:\s+me)?\s+/i, "")
      .replace(/['\u2019]s\b/gi, "")
      .trim();
    if (/^(?:which|what|who|where|when|does|do|is|are)\b/i.test(subject)) return null;
    const match = subject.match(/^([a-z][a-z'-]*)(?:\s+([a-z][a-z'-]*))?\s+company\b([\s\S]*)$/i);
    if (!match) return null;

    const [, firstName, lastName, suffix = ""] = match;
    // "Rahim Company users" names a company; do not reinterpret its entity
    // noun as a person's family name.
    if (String(lastName).toLowerCase() === "company") return null;
    const wantsCompanyUsers = /\busers?\b/i.test(suffix);
    const wantsProjectTasks = /\bprojects?\s+tasks?\b|\bproject\s+tasks?\b/i.test(suffix);
    const nodes = wantsProjectTasks
      ? ["users", "companies", "users", "project_tasks"]
      : wantsCompanyUsers
        ? ["users", "companies", "users"]
        : ["users", "companies"];
    const relationshipPairs = wantsProjectTasks
      ? [["users", "companies"], ["companies", "users"], ["users", "project_tasks"]]
      : wantsCompanyUsers
        ? [["users", "companies"], ["companies", "users"]]
        : [["users", "companies"]];

    const sourceIds = Object.keys(this.contexts || {}).filter(sourceId => {
      const context = this.contexts[sourceId] || {};
      const userColumns = new Set((context.tables?.users?.columns || []).map(column => String(column?.name || column).toLowerCase()));
      if (!userColumns.has("first_name") || (lastName && !userColumns.has("last_name"))) return false;
      if (!nodes.every(table => context.tables?.[table])) return false;
      return relationshipPairs.every(([left, right]) => (context.relationships || []).some(relationship =>
        (relationship.source_table === left && relationship.target_table === right) ||
        (relationship.source_table === right && relationship.target_table === left)
      ));
    });
    if (sourceIds.length !== 1) return null;

    const sourceId = sourceIds[0];
    const context = this.contexts[sourceId];
    const preferredRelationship = {
      "companies:users": { source_table: "users", source_column: "company_id", target_table: "companies", target_column: "id" },
      "companies:project_details": { source_table: "project_details", source_column: "company_id", target_table: "companies", target_column: "id" },
      "project_details:project_tasks": { source_table: "project_tasks", source_column: "project_id", target_table: "project_details", target_column: "id" },
      "project_tasks:users": { source_table: "project_tasks", source_column: "assignee_id", target_table: "users", target_column: "id" }
    };
    const findRelationship = (left, right) => {
      const candidates = (context.relationships || []).filter(relationship =>
        (relationship.source_table === left && relationship.target_table === right) ||
        (relationship.source_table === right && relationship.target_table === left)
      );
      const preference = preferredRelationship[[left, right].sort().join(":")];
      return candidates.find(relationship => preference && Object.entries(preference).every(([key, value]) => relationship[key] === value)) || candidates[0];
    };
    const safeColumns = table => (context.tables?.[table]?.columns || [])
      .map(column => String(column?.name || column || ""))
      .filter(column => column && !isSensitiveFieldName(column))
      .slice(0, 20);
    const edgeBindings = relationshipPairs.map(([left, right]) => {
      const relationship = findRelationship(left, right);
      if (!relationship) return null;
      return relationship.source_table === left
        ? { relationship, from_column: relationship.source_column, to_column: relationship.target_column }
        : { relationship, from_column: relationship.target_column, to_column: relationship.source_column };
    });
    if (edgeBindings.some(binding => !binding)) return null;

    const steps = nodes.map((table, index) => {
      const incoming = index > 0 ? edgeBindings[index - 1] : null;
      const outgoing = index < edgeBindings.length ? edgeBindings[index] : null;
      const columns = Array.from(new Set([
        ...(context.tables?.[table]?.primary_keys || []),
        incoming?.to_column,
        outgoing?.from_column,
        ...safeColumns(table)
      ].filter(Boolean)));
      return {
        id: `s${index + 1}`,
        type: index === nodes.length - 1 ? "final_query" : "source_query",
        source_id: sourceId,
        contract: {
          question,
          data_sources: ["postgresql"],
          postgresql_sources: [sourceId],
          required_tables: [table],
          required_columns: columns.map(column => `${table}.${column}`),
          relationships: [],
          filters: index === 0 ? [
            { table: "users", field: "first_name", operator: "case_insensitive_equals", value: firstName },
            ...(lastName ? [{ table: "users", field: "last_name", operator: "case_insensitive_equals", value: lastName }] : [])
          ] : [],
          operations: ["lookup"],
          limit: 50,
          sorting: [],
          entities: []
        },
        depends_on: index === 0 ? [] : [`s${index}`],
        inputs: [],
        input_bindings: index === 0 ? [] : [{ from_step: `s${index}`, from_column: incoming.from_column, to_table: table, to_column: incoming.to_column, operator: "in" }],
        output_columns: columns,
        purpose: index === 0
          ? "Find the named user before traversing declared company relationships."
          : `Traverse the declared relationship to ${sourceId}.${table}.`
      };
    });
    const semanticPath = nodes.map((table, index) => {
      const incoming = index > 0 ? edgeBindings[index - 1] : null;
      const outgoing = index < edgeBindings.length ? edgeBindings[index] : null;
      const primaryKey = (context.tables?.[table]?.primary_keys || [])[0] || null;
      const column = index === 0
        ? (outgoing?.from_column || primaryKey)
        : (incoming?.to_column || primaryKey);
      return { source_id: sourceId, table, column };
    });
    return {
      data_sources: ["postgresql"],
      postgresql_sources: [sourceId],
      required_tables: [],
      required_columns: [],
      relationships: [],
      filters: [],
      operations: ["lookup"],
      limit: 50,
      confidence: 0.9,
      named_relationship_lookup: true,
      execution_plan: { mode: "multi_step", steps, final_step: steps.at(-1).id },
      semantic_path: semanticPath,
      semantic_path_evidence: edgeBindings.map(binding => `${sourceId}.${binding.relationship.source_table}.${binding.relationship.source_column} -> ${sourceId}.${binding.relationship.target_table}.${binding.relationship.target_column}`),
      entity_target: { source_id: sourceId, table: nodes.at(-1) },
      reasoning: "A named user was resolved first, then only declared same-source foreign-key relationships were traversed."
    };
  }

  _build_possessive_task_assignment_plan(question) {
    // Normalize a relationship phrasing into the same bounded, FK-backed
    // plan used for the equivalent imperative form.  This is intentionally
    // structural (task assignment + users + possessive company), not a
    // free-form name guess.
    const text = String(question || "");
    const normalizedText = text.replace(/^\s*(?:show|find|list|display|give)(?:\s+me)?\s+/i, "");
    const match = text.match(/\btasks?\s+(?:assigned\s+to\s+users?\s+belonging\s+to|belong(?:ing)?\s+to\s+employees?\s+at|of\s+employees?\s+at|for\s+users?\s+of|for\s+employees?\s+of)\s+([a-z][a-z'-]*)(?:\s+([a-z][a-z'-]*))?['\u2019]s\s+company\b/i) ||
      normalizedText.match(/\b([a-z][a-z'-]*)(?:\s+([a-z][a-z'-]*))?['\u2019]s\s+company\s+(?:users?|employees?)\b[\s\S]*\btask/i);
    if (!match) return null;
    const [, firstName, lastName] = match;
    return this._build_named_relationship_plan(`Show me ${firstName}${lastName ? ` ${lastName}` : ""}'s company users and their project task`);
  }

  _build_named_company_users_plan(question) {
    const match = String(question || "").match(/^\s*(?:show|find|list|display|give)\s+(?:me\s+)?(.+?\bcompany)\s+users?\b/i);
    if (!match) return null;
    const companyName = match[1].trim();
    if (tokenWords(companyName).length < 2) return null;
    const sourceIds = Object.keys(this.contexts || {}).filter(sourceId => {
      const context = this.contexts[sourceId] || {};
      const columns = new Set((context.tables?.companies?.columns || []).map(column => String(column?.name || column).toLowerCase()));
      return columns.has("name") && context.tables?.users && (context.relationships || []).some(relationship =>
        relationship.source_table === "users" && relationship.source_column === "company_id" &&
        relationship.target_table === "companies" && relationship.target_column === "id"
      );
    });
    if (sourceIds.length !== 1) return null;

    const sourceId = sourceIds[0];
    const context = this.contexts[sourceId];
    const safeColumns = table => (context.tables?.[table]?.columns || [])
      .map(column => String(column?.name || column || ""))
      .filter(column => column && !isSensitiveFieldName(column)).slice(0, 20);
    const companyColumns = Array.from(new Set(["id", ...safeColumns("companies")]));
    const userColumns = Array.from(new Set(["company_id", ...(context.tables?.users?.primary_keys || []), ...safeColumns("users")]));
    const steps = [
      {
        id: "s1", type: "source_query", source_id: sourceId,
        contract: { question, data_sources: ["postgresql"], postgresql_sources: [sourceId], required_tables: ["companies"], required_columns: companyColumns.map(column => `companies.${column}`), relationships: [], filters: [{ table: "companies", field: "name", operator: "contains", value: companyName }], operations: ["lookup"], limit: 50, sorting: [], entities: [] },
        depends_on: [], inputs: [], input_bindings: [], output_columns: companyColumns,
        purpose: "Find the named company before retrieving only its users."
      },
      {
        id: "s2", type: "final_query", source_id: sourceId,
        contract: { question, data_sources: ["postgresql"], postgresql_sources: [sourceId], required_tables: ["users"], required_columns: userColumns.map(column => `users.${column}`), relationships: [], filters: [], operations: ["lookup"], limit: 50, sorting: [], entities: [] },
        depends_on: ["s1"], inputs: [], input_bindings: [{ from_step: "s1", from_column: "id", to_table: "users", to_column: "company_id", operator: "in" }], output_columns: userColumns,
        purpose: "Retrieve only users linked to the matched company."
      }
    ];
    return {
      data_sources: ["postgresql"], postgresql_sources: [sourceId], required_tables: [], required_columns: [], relationships: [], filters: [], operations: ["lookup"], limit: 50, confidence: 0.9,
      named_relationship_lookup: true, execution_plan: { mode: "multi_step", steps, final_step: "s2" },
      semantic_path: [{ source_id: sourceId, table: "companies", column: "id" }, { source_id: sourceId, table: "users", column: "company_id" }],
      semantic_path_evidence: [`${sourceId}.users.company_id -> ${sourceId}.companies.id`], entity_target: { source_id: sourceId, table: "users" },
      reasoning: "A named company was resolved first, then only its declared users relationship was traversed."
    };
  }

  _conversation_reference(conversationContext) {
    const active = conversationContext?.active_context || conversationContext?.pending_reference || null;
    if (!active) return null;
    const question = String(conversationContext?._reference_question || "");
    const pluralReference = /\b(?:those|these|previous|prior|above)\b/i.test(question);
    const related = Array.isArray(active.related_references) ? active.related_references : [];
    if (!pluralReference || related.length === 0) return active;
    const candidates = [active, ...related];
    const match = candidates.find(reference => {
      const sourceId = String(reference?.source_id || "").toLowerCase();
      const table = String(reference?.table || "");
      const entity = this.contexts?.[sourceId]?.semantic_catalog?.entities?.[table] || {};
      const aliases = [table, entity.entity_type, ...(Array.isArray(entity.synonyms) ? entity.synonyms : [])]
        .map(value => String(value || "").replace(/_/g, " ").trim().toLowerCase())
        .filter(Boolean);
      return aliases.some(alias => {
        const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`\\b${escaped}(?:s)?\\b`, "i").test(question);
      });
    });
    return match || active;
  }

  _record_set_reference_mode(question, active = null) {
    const text = String(question || "");
    if (/\b(?:above|those|these|previous|prior)\b|\ball\s+\d+\b/i.test(text)) return "plural";
    if (!active?.record_set) return null;

    const sourceId = String(active.source_id || "").toLowerCase();
    const table = String(active.table || "");
    const entity = this.contexts?.[sourceId]?.semantic_catalog?.entities?.[table] || {};
    const aliases = [table, entity.entity_type, ...(Array.isArray(entity.synonyms) ? entity.synonyms : [])]
      .map(value => String(value || "").replace(/_/g, " ").trim().toLowerCase())
      .filter(Boolean);
    const mentionedActiveEntity = aliases.some(alias => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${escaped}(?:s)?\\b`, "i").test(text);
    });
    if (mentionedActiveEntity && /\b(?:this|that)\b/i.test(text)) return "singular";
    return null;
  }

  _is_record_set_reference(question, active = null) {
    return Boolean(this._record_set_reference_mode(question, active));
  }

  _has_explicit_new_target(question, active) {
    const activeTable = String(active?.table || "").trim().toLowerCase();
    if (!activeTable) return false;

    const candidates = findSemanticCandidates(question, this.contexts);
    return candidates.some(candidate => String(candidate?.table || "").trim().toLowerCase() !== activeTable);
  }

  _explicit_identifier_filter(question, candidate) {
    const value = extractEntitySearchText(question);
    if (!value || !candidate) return null;
    const text = String(question || "").toLowerCase();
    if (!/\b(?:id|identifier|code|reference|number|key)\b/.test(text) && !String(value).includes("-")) return null;
    const beforeIdentifier = text.split(/\b(?:id|identifier|code|reference|number|key)\b/)[0];
    const label = tokenWords(beforeIdentifier).filter(token => !["with", "the", "a", "an", "about", "for", "of"].includes(token)).at(-1);
    const aliases = [candidate.table, candidate.entity_type, ...(candidate.matched_aliases || [])].flatMap(tokenWords);
    const labelMatchesCandidate = !label || aliases.includes(label);
    if (!labelMatchesCandidate) return null;
    const columns = candidate.columns || [];
    const scored = columns.map(column => {
      const normalized = String(column).toLowerCase();
      let score = 0;
      if (label && normalized === `${label}_id`) score = 100;
      else if (label && /(?:code|key|reference|number)$/.test(normalized) && normalized.startsWith(`${label}_`)) score = 90;
      else if (candidate.identity_key && normalized === String(candidate.identity_key).toLowerCase()) score = 80;
      else if ((candidate.primary_keys || []).map(String).map(item => item.toLowerCase()).includes(normalized)) score = 60;
      else if (normalized === "id") score = 20;
      return { column, score };
    }).filter(item => item.score > 0).sort((left, right) => right.score - left.score || left.column.localeCompare(right.column));
    if (!scored.length || (scored[1] && scored[1].score === scored[0].score)) return null;
    return { table: candidate.table, field: scored[0].column, operator: "=", value };
  }

  // Email and other approved identity qualifiers are stronger than display
  // text.  Keep them attached to the schema-grounded identity entity before
  // source selection or relationship traversal.  The column is accepted only
  // when discovered on the candidate and follows the existing identity-field
  // semantics; arbitrary column-name similarity is not enough.
  _explicit_identity_filter(question, candidate) {
    if (!candidate || typeof candidate !== "object") return null;
    const value = extractEntitySearchText(question);
    if (!value) return null;
    const normalized = String(value).trim();
    const columns = Array.isArray(candidate.columns) ? candidate.columns.map(String) : [];
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(normalized)) {
      const identityColumn = columns.find(column => /^(?:email|email_address|login_email|username)$/i.test(column));
      if (!identityColumn) return null;
      return {
        table: candidate.table,
        field: identityColumn,
        operator: "case_insensitive_equals",
        value: normalized,
        provenance: "authorized_discovered_identity_column"
      };
    }
    return this._explicit_identifier_filter(question, candidate);
  }

  _question_has_explicit_identity_constraint(question) {
    const value = extractEntitySearchText(question);
    return Boolean(value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(String(value).trim()));
  }

  _identity_column_for_table(sourceId, table) {
    const columns = (this.contexts?.[sourceId]?.tables?.[table]?.columns || [])
      .map(column => String(column?.name || column || ""))
      .filter(Boolean);
    return columns.find(column => /^(?:email|email_address|login_email|username)$/i.test(column)) || null;
  }

  _is_identity_entity_table(sourceId, table) {
    const info = this.contexts?.[sourceId]?.tables?.[table] || {};
    const entity = this.contexts?.[sourceId]?.semantic_catalog?.entities?.[table] || {};
    const text = [table, entity.entity_type, ...(Array.isArray(entity.synonyms) ? entity.synonyms : [])].join(" ");
    if (/(?:^|\W)(?:user|person|member|account|profile|contact)(?:s|\W|$)/i.test(text)) return true;
    const columns = (info.columns || []).map(column => String(column?.name || column || ""));
    return columns.some(column => /^(?:first_name|last_name|full_name|email|email_address|username)$/i.test(column));
  }

  // Provider plans are still required to preserve an explicit identity
  // predicate.  Add it only to authorized, discovered identity entities in
  // the proposed plan; if none are present, leave the plan unchanged so the
  // existing completeness/clarification path can fail closed.
  _preserve_explicit_identity_filters(plan, question) {
    if (!plan || !this._question_has_explicit_identity_constraint(question)) return;
    const value = String(extractEntitySearchText(question) || "").trim();
    const candidates = [];
    const addCandidate = (container, sourceId, table, root = false) => {
      if (!container || !sourceId || !table || !this._is_identity_entity_table(sourceId, table)) return;
      const field = this._identity_column_for_table(sourceId, table);
      if (!field) return;
      candidates.push({ container, sourceId, table, field, root });
    };
    const steps = Array.isArray(plan.execution_plan?.steps) ? plan.execution_plan.steps : [];
    for (const step of steps) {
      const sourceId = String(step?.source_id || "").toLowerCase();
      for (const table of step?.contract?.required_tables || []) addCandidate(step.contract, sourceId, table, !Array.isArray(step?.depends_on) || step.depends_on.length === 0);
    }
    if (candidates.length === 0) {
      for (const sourceId of plan.postgresql_sources || []) {
        for (const table of plan.required_tables || []) addCandidate(plan, String(sourceId).toLowerCase(), table);
      }
    }
    const rootsBySource = new Set(candidates.filter(item => item.root).map(item => item.sourceId));
    const scopedCandidates = rootsBySource.size > 0
      ? candidates.filter(item => item.root || !rootsBySource.has(item.sourceId))
      : candidates;
    const unique = [...new Map(scopedCandidates.map(item => [`${item.sourceId}:${item.table}`, item])).values()];
    for (const target of unique) {
      const filter = {
        table: target.table,
        field: target.field,
        operator: "case_insensitive_equals",
        value,
        provenance: "authorized_discovered_identity_column"
      };
      const filters = Array.isArray(target.container.filters) ? target.container.filters : [];
      const alreadyBound = filters.some(existing =>
        String(existing?.field || existing?.column || "").split(".").at(-1).toLowerCase() === target.field.toLowerCase() &&
        String(existing?.value || "").toLowerCase() === value.toLowerCase()
      );
      if (!alreadyBound) target.container.filters = [...filters, filter];
      if (target.container !== plan && Array.isArray(plan.required_tables) && plan.required_tables.includes(target.table)) {
        const planFilters = Array.isArray(plan.filters) ? plan.filters : [];
        if (!planFilters.some(existing => String(existing?.table || "").toLowerCase() === target.table.toLowerCase() && String(existing?.field || existing?.column || "").toLowerCase() === target.field.toLowerCase())) {
          plan.filters = [...planFilters, filter];
        }
      }
    }
  }

  // Apply an explicit identity qualifier only inside an already verified,
  // source-qualified conversation record set.  This deliberately uses the
  // discovered schema rather than a business-table name: an email-like
  // qualifier is valid only when the active entity exposes an authorized
  // email/username identity column, and a UUID-like value is valid only when
  // it is one of the bounded record-set identities.
  _active_record_set_identity_filter(question, active, tableInfo) {
    const recordSet = active?.record_set;
    if (!recordSet || !tableInfo) return null;
    const value = extractEntitySearchText(question);
    if (!value) return null;
    const columns = (tableInfo.columns || []).map(column => String(column?.name || column || "")).filter(Boolean);
    const normalizedValue = String(value).trim();
    const isEmail = /\S+@\S+/.test(normalizedValue);
    if (isEmail) {
      const identityColumn = columns.find(column => /^(?:email|email_address|login_email|username)$/i.test(column));
      if (!identityColumn) return { unsupported: true, value: normalizedValue };
      return {
        table: active.table,
        field: identityColumn,
        operator: "case_insensitive_equals",
        value: normalizedValue
      };
    }
    const values = Array.isArray(recordSet.values) ? recordSet.values.map(item => String(item)) : [];
    const keyColumn = String(recordSet.key_column || "").trim();
    const looksLikeStableId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalizedValue);
    if (looksLikeStableId && keyColumn && values.includes(normalizedValue)) {
      return { table: active.table, field: keyColumn, operator: "=", value: normalizedValue };
    }
    return null;
  }

  _named_record_value(question, candidate) {
    const parsingQuestion = this._strip_structural_prefix_for_display_parsing(question);
    const text = String(parsingQuestion || "").toLowerCase();
    if (!/\b(?:show|details?|about|information|find)\b/.test(text) || !candidate) return null;
    if (this._is_record_set_reference(parsingQuestion)) return null;
    const tokens = tokenWords(parsingQuestion);
    const entityAliases = [candidate.table, candidate.entity_type, ...(candidate.matched_aliases || [])]
      .map(value => tokenWords(value))
      .filter(alias => alias.length > 0)
      .sort((left, right) => right.length - left.length);
    let entityStart = -1;
    let entityEnd = -1;
    for (let index = 0; index < tokens.length; index++) {
      const alias = entityAliases.find(value => value.every((token, offset) => tokens[index + offset] === token));
      if (!alias) continue;
      entityStart = index;
      entityEnd = index + alias.length;
      break;
    }
    if (entityStart < 1) return null;
    const quoted = [...String(parsingQuestion).matchAll(/["']([^"']+)["']/g)].map(match => match[1].trim()).filter(Boolean);
    if (quoted[0]) return quoted[0];

    const ignored = new Set([
      "show", "me", "the", "a", "an", "all", "details", "detail", "about", "information", "find",
      "with", "for", "of", "it", "its", "that", "this", "those", "these", "related", "total", "count",
      "number", "how", "many", "record", "records", "whose", "where", "having", "status", "state", "workflow",
      "lifecycle", "is", "are", "active", "inactive", "pending", "open", "closed", "resolved", "unresolved",
      "completed", "cancelled", "canceled", "in", "progress", "inprogress", "on", "hold"
    ]);
    const collect = values => values
      .filter(token => !ignored.has(token) && !this._is_temporal_modifier_token(token));
    const beforeEntityTokens = tokens.slice(0, entityStart);
    if (beforeEntityTokens.some(token => ["for", "about", "related", "of"].includes(token))) return null;
    const beforeEntity = collect(beforeEntityTokens);
    const afterEntity = [];
    for (const token of tokens.slice(entityEnd)) {
      if (new Set(["whose", "where", "with", "having", "status", "state", "workflow", "lifecycle", "related"]).has(token)) break;
      if (!ignored.has(token) && !this._is_temporal_modifier_token(token)) afterEntity.push(token);
    }
    const candidateEntityWords = new Set(entityAliases.flat());
    const discoveredEntityWords = new Set();
    for (const context of Object.values(this.contexts || {})) {
      for (const [table, entity] of Object.entries(context?.semantic_catalog?.entities || {})) {
        for (const token of [table, entity?.entity_type, ...(Array.isArray(entity?.synonyms) ? entity.synonyms : [])].flatMap(tokenWords)) {
          if (!candidateEntityWords.has(token)) discoveredEntityWords.add(token);
        }
      }
      for (const table of Object.keys(context?.tables || {})) {
        for (const token of tokenWords(table)) {
          if (!candidateEntityWords.has(token)) discoveredEntityWords.add(token);
        }
      }
    }
    if (afterEntity.some(token => discoveredEntityWords.has(token))) return null;
    const valueTokens = afterEntity.length > 0 ? afterEntity : beforeEntity;
    if (valueTokens.length === 0 || valueTokens.length > 8) return null;
    return valueTokens.join(" ");
  }

  _explicit_display_filters(question, candidate) {
    const displayValue = this._named_record_value(question, candidate);
    if (!displayValue || !candidate) return [];
    const columns = candidate.columns || [];
    const entityWords = new Set([candidate.table, candidate.entity_type, ...(candidate.matched_aliases || [])].flatMap(tokenWords));
    const firstName = columns.find(column => /^(?:first|given|forename)(?:_?name)?$/i.test(String(column).trim()));
    const lastName = columns.find(column => /^(?:last|family|sur|surname)(?:_?name)?$/i.test(String(column).trim()));
    const nameTokens = tokenWords(displayValue);
    const provenance = "authorized_discovered_display_column";

    if (firstName && lastName && nameTokens.length === 2) {
      return [
        { table: candidate.table, field: firstName, operator: "case_insensitive_equals", value: nameTokens[0], provenance, name_component: "given" },
        { table: candidate.table, field: lastName, operator: "case_insensitive_equals", value: nameTokens.slice(1).join(" "), provenance, name_component: "family" }
      ];
    }

    const displayHints = new Set(["title", "name", "label", "subject", "summary"]);
    const scored = columns.map(column => {
      const words = String(column).toLowerCase().split(/[^a-z0-9]+|_/).filter(Boolean).map(word => word.endsWith("s") && word.length > 3 ? word.slice(0, -1) : word);
      let score = 0;
      if (words.some(word => displayHints.has(word))) score += 50;
      if (words.some(word => entityWords.has(word))) score += 25;
      if (String(column).toLowerCase() === "name" || String(column).toLowerCase() === "title") score += 10;
      return { column, score };
    }).filter(item => item.score >= 50).sort((left, right) => right.score - left.score || left.column.localeCompare(right.column));
    if (!scored.length || (scored[1] && scored[0].score === scored[1].score)) return [];
    return [{ table: candidate.table, field: scored[0].column, operator: "contains", value: displayValue, provenance, name_component: "display" }];
  }

  _explicit_display_filter(question, candidate) {
    const filters = this._explicit_display_filters(question, candidate);
    const stripMetadata = filter => {
      const { provenance: _provenance, name_component: _nameComponent, ...plain } = filter;
      return plain;
    };
    if (filters.length === 1) return stripMetadata(filters[0]);
    if (filters.length > 1) return filters.map(stripMetadata);
    return null;
  }

  _strip_structural_prefix_for_display_parsing(question) {
    const original = String(question || "");
    // Remove only a list marker followed by an imperative question verb. This
    // preserves numeric record values, identifiers, and titles such as
    // "1.23 meeting" or "#3 meeting" when they are actual user content.
    const match = original.match(/^\s*(?:(?:\d+\s*[.)])|(?:#\d+)|[-*•])\s+((?:show|find|list|display|give|what|which|how)\b[\s\S]*)$/i);
    return match ? match[1] : original;
  }

  _is_bounded_detail_lookup(question, plan) {
    if (!plan || !Array.isArray(plan.filters) || plan.filters.length === 0) return false;
    if (!/\b(?:show|details?|about|information|find)\b/i.test(String(question || ""))) return false;
    if (!Array.isArray(plan.required_tables) || plan.required_tables.length !== 1) return false;
    if (!Array.isArray(plan.postgresql_sources) || plan.postgresql_sources.length !== 1) return false;
    const operatorsAreBounded = plan.filters.every(filter => ["=", "contains", "in", "case_insensitive_equals"].includes(String(filter?.operator || "").toLowerCase()));
    if (!operatorsAreBounded) return false;
    if (plan.named_entity_lookup === true) {
      const namedFilters = plan.filters.filter(filter => !this._is_status_filter(filter, plan));
      const otherFilters = plan.filters.filter(filter => this._is_status_filter(filter, plan));
      return namedFilters.length > 0 && otherFilters.every(filter => filter?.verification === "runtime_distinct_required" || this._is_status_filter(filter, plan));
    }
    return plan.filters.length === 1;
  }

  _is_temporal_modifier_token(token) {
    return new Set([
      "recent", "latest", "newest", "recently", "last", "next", "current", "ongoing", "oldest", "earliest",
      "today", "yesterday", "tomorrow", "upcoming", "scheduled", "overdue", "currently", "before", "after", "since", "until",
      "between", "during", "week", "month", "quarter", "year", "hour", "day", "daily", "weekly", "monthly", "trend"
    ]).has(String(token || "").toLowerCase());
  }

  _question_has_quoted_temporal_literal(question) {
    return /["'][^"']*\b(?:recent|latest|newest|oldest|earliest|today|yesterday|tomorrow)\b[^"']*["']/i.test(String(question || ""));
  }

  _remove_temporal_text_filters(filters, question) {
    if (this._question_has_quoted_temporal_literal(question)) return filters;
    const questionTokens = tokenWords(question);
    const hasTemporalIntent = questionTokens.some(token => this._is_temporal_modifier_token(token));
    if (!hasTemporalIntent) return filters;
    return (filters || []).filter(filter => {
      if (!filter || String(filter.operator || "").toLowerCase() !== "contains") return true;
      const valueTokens = tokenWords(filter.value);
      // Only remove a filter when its complete value is temporal language;
      // real names such as "recent planning" remain a user text search.
      return valueTokens.length === 0 || !valueTokens.every(token => this._is_temporal_modifier_token(token));
    });
  }

  // A count request may be phrased as "total <plural entity>".  Treat it as
  // a count only when that final entity token is actually supported by a
  // discovered candidate; this avoids interpreting a metric such as "total
  // budget" as a row count.
  _is_count_question(question, candidates = []) {
    const text = String(question || "").toLowerCase().trim();
    if (/\b(?:count|how\s+many|number\s+of|total\s+number)\b/i.test(text)) return true;
    const match = text.match(/\btotal\s+([a-z0-9_]+s?)\b/i);
    if (!match) return false;
    const requested = tokenWords(match[1])[0];
    if (!requested) return false;
    const remainder = text.slice((match.index || 0) + match[0].length);
    // "total invoice amount" is an aggregate over an amount column, not a
    // request to count invoices. A metric noun after the entity disambiguates
    // the operation without weakening the provider's explicit metric plan.
    if (/\b(?:amount|value|cost|budget|price|revenue|spend|progress|duration)\b/i.test(remainder)) return false;
    return candidates.some(candidate => {
      const entityWords = [candidate.table, candidate.entity_type, ...(candidate.matched_aliases || [])]
        .flatMap(tokenWords);
      return entityWords.includes(requested);
    });
  }

  // If the requested records do not carry a timestamp, a directly related
  // discovered table can provide ordering only when it is also semantically
  // present in the question and the FK is schema-validated.  This keeps
  // "latest related record" plans grounded without assuming naming patterns.
  _find_temporal_companion(candidate, candidates) {
    if (!candidate || candidate.ordering_column) return null;
    const context = this.contexts?.[candidate.source_id];
    const related = (context?.relationships || []).filter(relationship => {
      const source = String(relationship?.source_table || "");
      const target = String(relationship?.target_table || "");
      return source === candidate.table || target === candidate.table;
    });
    for (const other of candidates) {
      if (other.source_id !== candidate.source_id || other.table === candidate.table || !other.ordering_column) continue;
      const relationship = related.find(item =>
        (item.source_table === candidate.table && item.target_table === other.table) ||
        (item.target_table === candidate.table && item.source_table === other.table)
      );
      if (relationship) return { ...other, relationship };
    }
    return null;
  }

  _build_independent_candidate_plan(question, candidates, isCount, semanticCandidates = []) {
    const uniqueCandidates = [...new Map(candidates.map(candidate => [`${candidate.source_id}:${candidate.table}`, candidate])).values()];
    const candidateFilters = uniqueCandidates.map(candidate => {
      const identity = this._explicit_identity_filter(question, candidate);
      const status = this._verified_status_filter(candidate, question) ||
        (this._has_unverified_status_intent(candidate, question) ? this._discovered_categorical_filter(candidate, question) : null);
      return [identity, status].filter(Boolean);
    });
    const statusFilters = candidateFilters.map(filters => filters.find(filter => filter.field && /status|state|workflow|lifecycle/i.test(String(filter.field))) || null);
    const statusIntent = uniqueCandidates.some(candidate => this._has_unverified_status_intent(candidate, question));
    const statusMeanings = new Set(statusFilters.filter(Boolean).map(filter => `${String(filter.operator || "").toLowerCase()}:${normalizedSemanticPhrase(filter.value)}`));
    if (statusIntent && (statusFilters.some(filter => !filter) || statusMeanings.size > 1)) {
      return {
        data_sources: ["postgresql"],
        postgresql_sources: uniqueCandidates.map(candidate => candidate.source_id),
        required_tables: [...new Set(uniqueCandidates.map(candidate => candidate.table))],
        required_columns: [],
        operations: [],
        clarification_required: {
          type: "business_status_semantics",
          message: "I found conflicting or unverified status meanings for these records. Please specify the status or workflow definition you want me to use."
        }
      };
    }
    const identityCandidates = uniqueCandidates.filter(candidate => candidate.identity_key && candidate.identity_group && candidate.identity_mapping_id && candidate.identity_validation_status === "validated" && Array.isArray(candidate.identity_provenance) && candidate.identity_provenance.length > 0);
    const canDeduplicate = isCount && identityCandidates.length === uniqueCandidates.length && new Set(identityCandidates.map(candidate => `${candidate.identity_group}:${candidate.identity_mapping_id}`)).size === 1;
    const steps = uniqueCandidates.map((candidate, index) => {
      const columns = canDeduplicate
        ? [`${candidate.table}.${candidate.identity_key}`]
        : (isCount ? [] : candidate.columns.map(column => `${candidate.table}.${column}`).slice(0, 20));
      const operations = canDeduplicate ? ["lookup"] : [isCount ? "count" : "lookup"];
      return {
        id: `s${index + 1}`,
        type: "source_query",
        source_id: candidate.source_id,
        contract: {
          question,
          data_sources: ["postgresql"],
          postgresql_sources: [candidate.source_id],
          required_tables: [candidate.table],
          required_columns: columns,
          relationships: [],
          filters: candidateFilters[index],
          operations,
          limit: isCount ? (canDeduplicate ? 50000 : null) : 50,
          sorting: [],
          entities: []
        },
        depends_on: [],
        inputs: [],
        input_bindings: [],
        key_columns: [],
        output_columns: columns,
        purpose: `Independent authorized retrieval for ${candidate.source_id}.${candidate.table}.`
      };
    });
    return {
      data_sources: ["postgresql"],
      postgresql_sources: [...new Set(uniqueCandidates.map(candidate => candidate.source_id))],
      required_tables: [...new Set(uniqueCandidates.map(candidate => candidate.table))],
      required_columns: [],
      relationships: [],
      filters: [],
      operations: [isCount ? "count" : "lookup"],
      limit: isCount ? null : 50,
      confidence: 0.65,
      semantic_candidates: semanticCandidates.length > 0 ? semanticCandidates : uniqueCandidates.map(candidate => ({ source_id: candidate.source_id, table: candidate.table })),
      candidate_resolution: {
        mode: "independent",
        overlap_status: canDeduplicate ? "verified" : "unknown",
        deduplication: canDeduplicate ? "verified_identity" : "not_performed",
        targets: uniqueCandidates.map(candidate => ({
          source_id: candidate.source_id,
          table: candidate.table,
          identity_key: canDeduplicate ? candidate.identity_key : null,
          identity_mapping_id: canDeduplicate ? candidate.identity_mapping_id : null
        }))
      },
      execution_plan: {
        mode: "multi_step",
        steps,
        final_step: steps[steps.length - 1]?.id || null,
        reason: canDeduplicate
          ? "Independent source retrieval with application-owned verified identity deduplication."
          : "Independent source retrieval; source results remain separate because overlap is unverified."
      },
      reasoning: "Multiple equally relevant candidates were retained as independent authorized retrieval targets because the requested operation does not require choosing one source."
    };
  }

  _verified_status_filter(candidate, question) {
    const entity = this.contexts?.[candidate.source_id]?.semantic_catalog?.entities?.[candidate.table];
    const semantics = entity?.status_semantics;
    if (!semantics || semantics.validation_status !== "validated" || !Array.isArray(semantics.provenance) || semantics.provenance.length === 0) return null;
    const column = String(semantics.column || "").trim();
    if (!column || !candidate.columns.includes(column)) return null;
    const mappings = semantics.mappings && typeof semantics.mappings === "object" ? semantics.mappings : {};
    const queryTokens = new Set((String(question).toLowerCase().match(/[a-z0-9_]+/g) || []).map(token => token.endsWith("s") && token.length > 3 ? token.slice(0, -1) : token));
    const normalizedQuestion = normalizedSemanticPhrase(question);
    for (const [label, value] of Object.entries(mappings)) {
      const labelTokens = String(label).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const normalizedLabel = normalizedSemanticPhrase(label);
      const tokenMatch = labelTokens.length > 0 && labelTokens.every(token => queryTokens.has(token));
      const compactMatch = normalizedLabel.length > 0 && normalizedQuestion.includes(normalizedLabel);
      if (tokenMatch || compactMatch) {
        return { table: candidate.table, field: column, operator: "case_insensitive_equals", value };
      }
    }
    return null;
  }

  _discovered_categorical_filter(candidate, question) {
    const columns = Array.isArray(candidate?.columns) ? candidate.columns.map(String) : [];
    const categorical = columns.filter(column => /(?:^|_)(?:status|state|category|type|priority|stage|kind|class)(?:$|_)/i.test(column));
    if (!categorical.length) return null;
    const ranked = categorical.sort((left, right) => {
      const score = value => /^(status|state|workflow_state|lifecycle_state)$/i.test(value) ? 2 : 1;
      return score(right) - score(left) || left.localeCompare(right);
    });
    const score = value => /^(status|state|workflow_state|lifecycle_state)$/i.test(value) ? 2 : 1;
    if (ranked.length > 1 && score(ranked[0]) === score(ranked[1])) return null;
    const preferred = ranked[0];
    const questionText = String(question || "");
    const statusTail = questionText.match(/\b(?:status|state|workflow|lifecycle)\b([\s\S]*)/i)?.[1] || "";
    const statusValueTokens = tokenWords(statusTail);
    const statusStopWords = new Set(["for", "with", "whose", "where", "having", "show", "find", "list", "details", "detail"]);
    const explicitValueTokens = [];
    for (const token of statusValueTokens) {
      if (statusStopWords.has(token)) break;
      if (!["is", "are", "=", ":"].includes(token)) explicitValueTokens.push(token);
      if (explicitValueTokens.length >= 3) break;
    }
    const questionTokens = explicitValueTokens.length > 0 ? explicitValueTokens : tokenWords(question);
    const entityTokens = [candidate.table, candidate.entity_type, ...(candidate.matched_aliases || [])].flatMap(tokenWords);
    const ignored = new Set(["show", "me", "the", "a", "an", "all", "only", "total", "count", "number", "of", "how", "many", "which", "ones", "what", "are", "is", "with", "where", "status", "state", "workflow", "lifecycle", "records", "this", "that", "these", "those", "them", "it", "its", "their", "they", "above", "previous", "prior", "related"]);
    const valueTokens = questionTokens.filter(token => !entityTokens.includes(token) && !ignored.has(token) && !this._is_temporal_modifier_token(token));
    if (!valueTokens.length || valueTokens.length > 4) return null;
    return {
      table: candidate.table,
      field: preferred,
      operator: "case_insensitive_equals",
      value: valueTokens.join(" "),
      verification: "runtime_distinct_required",
      provenance: "authorized_discovered_categorical_column"
    };
  }

  _has_unverified_status_intent(candidate, question) {
    const hasStatusColumn = candidate.columns.some(column => isStatusColumnName(column));
    if (!hasStatusColumn) return false;
    const text = String(question || "").toLowerCase();
    // A status column alone is not evidence that every non-table word is a
    // status value.  That broad heuristic turned ordinary aggregation terms
    // such as "total" into a status clarification.  Only an explicit status
    // predicate or a small, domain-neutral lifecycle vocabulary is treated as
    // an unverified status request.
    const explicitStatus = text.match(/\b(?:status|state|workflow|lifecycle)\s*(?:is|are|=|:)??\s*([a-z0-9_]+)\b/i);
    if (explicitStatus && !new Set(["and", "or", "with", "of", "the", "their", "its"]).has(explicitStatus[1])) return true;
    return /\b(?:pending|open|closed|resolved|unresolved|active|inactive|completed|cancelled|canceled|on[-\s]?hold|in[-\s]?progress|inprogress)\b/i.test(text);
  }

  repair_plan(question, invalidPlan, validationErrors = null, conversationContext = null) {
    if (typeof question !== "string" || !question.trim()) {
      throw new Error("Question cannot be empty.");
    }

    if (!invalidPlan || typeof invalidPlan !== "object" || Array.isArray(invalidPlan)) {
      throw new Error("invalid_plan must be a dictionary.");
    }

    return this._normalize_plan(
      deepcopy(invalidPlan),
      question.trim(),
      conversationContext
    );
  }

  repairPlan(...args) {
    return this.repair_plan(...args);
  }

  // ------------------------------------------------------------------
  // Prompt
  // ------------------------------------------------------------------

  _build_prompt(question, context, conversationContext, resolvedEntities) {
    const availableSources = this._get_available_postgresql_sources();
    const exampleSource = availableSources[0] || "source_id";
    const secondaryExampleSource = availableSources[1] || exampleSource;

    return `
You are the SINGLE semantic planner for a production multi-source
Context Layer.

Your responsibility is to determine WHAT the user is asking for.

You must NOT generate SQL.

You must NOT execute any source.

You must NOT invent schema information.

You must NOT invent identifiers.

You must NOT invent relationships.

You must NOT guess a cross-source relationship.

The application will deterministically execute the plan you return.

IMPORTANT INPUT FLEXIBILITY RULE:
The user's question may be informal, abbreviated, fragmentary, typo-heavy,
missing punctuation, or written as keywords rather than a complete sentence.
Treat that as valid user input. Do NOT reject or reinterpret it merely because
it is not grammatically complete. Use the supplied Context Layer to resolve
what the user is referring to.

Examples of valid input forms include:
- "meeting egv-vpte-sdc transcript"
- "id 96 transcript"
- "show meeting transcript for egv-vpte-sdc"
- "vm logs last day"

For short or ambiguous wording:
1. Use exact discovered table/column/entity matches first.
2. Use discovered relationships only when they explicitly support the request.
3. If one schema-grounded interpretation is clear, return that plan.
4. If multiple interpretations remain genuinely ambiguous, do not invent one.
5. Never choose a source/table only because it is vaguely similar.

Input flexibility means flexible wording, NOT flexible evidence.
Semantic correctness and Context Layer grounding remain mandatory.

USER QUESTION:
${question}

CONVERSATION CONTEXT:
${JSON.stringify(conversationContext || {}, null, 2)}

RESOLVED ENTITY REFERENCES:
${JSON.stringify(resolvedEntities, null, 2)}

AVAILABLE POSTGRESQL SOURCE IDS:
${JSON.stringify(availableSources, null, 2)}

DISCOVERED CONTEXT LAYER:
${JSON.stringify(context, null, 2)}

    DYNAMIC RECENT-RECORD CANDIDATES:
${JSON.stringify(this._build_recent_record_candidates(question, this._build_context_focus(question, conversationContext)?.tableKeys || null), null, 2)}

The recent-record candidates above are deterministic hints generated only
from discovered schema metadata. They are NOT database rows and must never
be treated as current business data. For a latest/recent/newest question,
inspect these candidates and the full Context Layer, then select only the
source/table/column combination actually supported by the schema.

============================================================
SOURCE MODEL
============================================================

Logical data_sources may contain only:

- "postgresql"
- "security_logs"
- "external_api"

Physical PostgreSQL source IDs belong ONLY in:

"postgresql_sources"

For example:

CORRECT:
{
  "data_sources": ["postgresql"],
  "postgresql_sources": ["${exampleSource}"]
}

INCORRECT:
{
  "data_sources": ["${exampleSource}"]
}

Never place a PostgreSQL source ID directly into data_sources.

For an external API, use data_sources: ["external_api"], exactly one
registered api_sources entry, and the exact discovered api_operation.
Never invent API paths, methods, headers, parameters, or request bodies.

When the question requires facts from more than one PostgreSQL source, return:

{
  "data_sources": ["postgresql"],
  "postgresql_sources": ["source_a", "source_b"]
}

and also return an explicit execution_plan.

============================================================
SEMANTIC RULES
============================================================

1. Use only schema, relationships, business relationships, and source IDs
   present in the supplied Context Layer.

2. Never invent a table.

3. Never invent a column.

4. Never invent a relationship.

5. Never infer a relationship merely because column names look similar.

6. Never infer a relationship merely because two tables appear related
   conceptually.

7. A PostgreSQL relationship is valid only when it exists in the discovered
   Context Layer.

8. PostgreSQL source IDs identify separate, isolated PostgreSQL sources.

9. Never represent one PostgreSQL source -> another as a SQL JOIN.

10. When one source produces identifiers needed by another source, represent
    that dependency using execution-plan input_bindings.

11. Runtime values must NEVER be included in the plan.

12. The plan may describe that step s2 needs values produced by s1, but it
    must not contain the actual identifiers.

13. Current business data must be retrieved live.

14. Conversation history is reference context only. It is not authoritative
    current business data.

15. Do not use a previous assistant answer as current business truth.

16. Do not assume that an empty previous conversation result means that a
    current record does not exist.

17. Use only the minimum sources needed to answer the actual question.

18. Do not select another source merely because it contains similarly named
    tables or fields.

============================================================
CANONICAL OPERATIONS
============================================================

Allowed operations:

${JSON.stringify(Array.from(this.CANONICAL_OPERATIONS).sort())}

Normalize synonyms into these canonical operation names.

Examples:

"how many" -> "count"
"average" -> "average"
"top" -> "ranking"
"compare" -> "comparison"
"list/show" -> "lookup"

Do not add unsupported operations.

============================================================
FILTERS
============================================================

Canonical filter operators are:

=
!=
<>
>
>=
<
<=
in
not_in
contains
starts_with
ends_with
is_null
is_not_null

Use "=" for semantic equality.

Do not return "eq" or "equals" in the final normalized plan.

============================================================
RELATIONSHIPS
============================================================

Every relationship object must use:

{
  "source_table": "...",
  "source_column": "...",
  "target_table": "...",
  "target_column": "...",
  "relationship_type": "...",
  "source_id": "..."
}

Use the exact discovered relationship metadata whenever present.

Do not remove intermediate tables required for a valid discovered path.

============================================================
REQUESTED METRICS
============================================================

When aggregation is required, use requested_metrics.

Each metric may contain:

{
  "label": "...",
  "operation": "count|sum|average|minimum|maximum",
  "source_id": "...",
  "table": "...",
  "column": "...",
  "distinct": false
}

For COUNT(*) where the metric does not need a source column, the column may
be null.

Do not invent a metric column.

============================================================
ENTITIES & FOLLOW-UP QUERIES
============================================================

When entities are identified, each entity object in "entities" MUST have:
{
  "id": "identifier or name",
  "type": "user|project|meeting|entity",
  "source_id": "${exampleSource}"
}
Never use arbitrary keys without setting "id" and "type".

When the question is a conversational follow-up (e.g. asking about a person, user,
or entity mentioned in prior turns or meeting summaries):
- If asking whether someone is a user or asking about a user/person by name (e.g. "is Rahim Zahid a user?", "who is Rahim Zahid"):
  Query only a discovered user table in an authorized selected source and filter by discovered name fields when available.
  Do NOT produce filters with empty values (such as users.id in []). Always filter by the name components.

============================================================
SIMPLE QUERIES
============================================================

For a simple single-source question, return the normal semantic plan.

Example shape:

{
  "question": "...",
  "data_sources": ["postgresql"],
  "postgresql_sources": ["${exampleSource}"],
  "required_tables": [],
  "required_columns": [],
  "relationships": [],
  "filters": [],
  "operations": ["lookup"],
  "requested_metrics": [],
  "grouping": [],
  "sorting": [],
  "limit": null,
  "entities": [],
  "needs_conversation_context": false,
  "confidence": 0.0,
  "execution_plan": null,
  "security_resource": null
}

============================================================
COMPLEX / MULTI-SOURCE QUERIES
============================================================

When the original question genuinely requires multiple retrieval steps,
return an explicit execution_plan.

The execution_plan must contain the smallest number of steps necessary.

Do not create unnecessary intermediate steps.

Each source_query/final_query step MUST contain:

- id
- type
- source_id
- contract
- depends_on
- inputs
- input_bindings
- key_columns
- output_columns
- purpose

The "contract" is the complete semantic retrieval contract for that source
step.

Example structure:

{
  "id": "s1",
  "type": "source_query",
  "source_id": "${exampleSource}",
  "contract": {
    "question": "...",
    "data_sources": ["postgresql"],
    "postgresql_sources": ["${exampleSource}"],
    "required_tables": [],
    "required_columns": [],
    "relationships": [],
    "filters": [],
    "operations": [],
    "requested_metrics": [],
    "grouping": [],
    "sorting": [],
    "limit": null,
    "entities": []
  },
  "depends_on": [],
  "inputs": [],
  "input_bindings": [],
  "key_columns": ["project_id"],
  "output_columns": ["project_id"],
  "purpose": "Produce project keys required by the next source."
}

A dependent step may contain:

{
  "id": "s2",
  "type": "final_query",
  "source_id": "${secondaryExampleSource}",
  "contract": {
    "...": "..."
  },
  "depends_on": ["s1"],
  "inputs": [],
  "input_bindings": [
    {
      "from_step": "s1",
      "from_column": "project_id",
      "to_table": "...",
      "to_column": "...",
      "operator": "in"
    }
  ],
  "key_columns": [],
  "output_columns": [],
  "purpose": "Retrieve facts constrained by verified keys from the previous source."
}

The binding target table/column must exist in the supplied target Context Layer.

Use:

"operator": "equals"

ONLY when the producing step is guaranteed to return exactly one relevant
value.

Otherwise use:

"operator": "in"

Use:

"operator": "not_in"

for exclusion dependencies.

============================================================
SET OPERATIONS
============================================================

Supported operators:

- intersect
- union
- union_all
- except
- distinct

A set-operation step has:

{
  "id": "s3",
  "type": "set_operation",
  "source_id": null,
  "contract": {},
  "depends_on": ["s1", "s2"],
  "inputs": ["s1", "s2"],
  "input_bindings": [],
  "operator": "intersect",
  "key_columns": [],
  "output_columns": [],
  "purpose": "..."
}

Use set operations only when the original question requires them.

Never use a set operation merely to make the plan appear complex.

============================================================
FINAL STEP
============================================================

The final_step must identify the step whose output answers the original
question.

Do not choose an intermediate key-producing step as final when another step
is required to answer the question.

============================================================
STEP COUNT
============================================================

Maximum execution steps:

${this.MAX_EXECUTION_STEPS}

Use the smallest valid execution graph.

============================================================
SECURITY LOGS
============================================================

Logical source:

"security_logs"

Allowed resources:

${JSON.stringify(Array.from(this.SECURITY_RESOURCES).sort())}

Choose a security resource only when the question actually requires it.

Do not generate API URLs, authentication values, workspace credentials,
tokens, or runtime configuration.

============================================================
IMPORTANT SINGLE-AUTHORITY RULE
============================================================

You are the ONLY semantic planner.

Do not return alternative plans.

Do not return possible source choices.

Do not return candidate relationships.

Do not return "maybe use DB1 or DB2".

Return the single plan that is supported by the supplied Context Layer.

============================================================
OUTPUT
============================================================

Return ONLY valid JSON.

No markdown.

No explanations.

No code fences.

Use this exact top-level structure:

{
  "question": "${question}",
  "data_sources": [],
  "postgresql_sources": [],
  "required_tables": [],
  "required_columns": [],
  "relationships": [],
  "filters": [],
  "operations": [],
  "requested_metrics": [],
  "grouping": [],
  "sorting": [],
  "limit": null,
  "entities": [],
  "needs_conversation_context": false,
  "confidence": 0.0,
  "security_resource": null,
  "execution_plan": null
}

For a complex query, execution_plan must be an object:

{
  "mode": "single" | "multi_step",
  "steps": [],
  "final_step": "s1",
  "reason": ""
}

The final execution plan step objects must use:

{
  "id": "s1",
  "type": "source_query" | "final_query" | "set_operation",
  "source_id": "${exampleSource}",
  "contract": {},
  "depends_on": [],
  "inputs": [],
  "input_bindings": [],
  "operator": null,
  "key_columns": [],
  "output_columns": [],
  "purpose": ""
}
`.trim();
  }

  _buildPrompt(...args) {
    return this._build_prompt(...args);
  }

  // ------------------------------------------------------------------
  // Context
  // ------------------------------------------------------------------

  _build_context_focus(question, conversationContext = null) {
    const text = String(question || "").trim();
    if (!text) return null;

    const queryTokens = new Set(tokenWords(text));
    const active = this._conversation_reference(conversationContext);
    const semanticCandidates = findSemanticCandidates(text, this.contexts);
    const directEntityContext = this._is_direct_entity_lookup_context(text, semanticCandidates);
    const selected = new Map();

    const addTable = (sourceId, table, reason = "query") => {
      const source = String(sourceId || "").trim().toLowerCase();
      const name = String(table || "").trim();
      if (!source || !name || !this.contexts?.[source]?.tables?.[name]) return;
      const key = `${source}:${name}`;
      const current = selected.get(key) || { source_id: source, table: name, reasons: new Set() };
      current.reasons.add(reason);
      selected.set(key, current);
    };

    const bestSemanticScore = semanticCandidates.reduce((best, candidate) => Math.max(best, Number(candidate.score) || 0), 0);
    const semanticThreshold = bestSemanticScore > 0 ? Math.max(1, bestSemanticScore * 0.75) : 0;
    for (const candidate of semanticCandidates) {
      const explicit = this._explicit_table_phrase(text, candidate.table);
      if (explicit || (Number(candidate.score) || 0) >= semanticThreshold) {
        addTable(candidate.source_id, candidate.table, "semantic_candidate");
      }
    }

    // Technical metadata remains a valid fallback when the approved semantic
    // overlay is unavailable or when a newly discovered table has no semantic
    // definition yet. Keep every positively matching table in that case so
    // ambiguity remains visible to the existing planner and validator.
    const lexical = [];
    for (const [sourceId, context] of Object.entries(this.contexts || {})) {
      for (const [table, info] of Object.entries(context?.tables || {})) {
        const relevance = this._table_question_relevance(sourceId, table, text);
        if (relevance <= 0) continue;
        const tableWords = tokenWords(table);
        const tableNameMatch = tableWords.some(word => queryTokens.has(word));
        const explicit = this._explicit_table_phrase(text, table);
        lexical.push({ source_id: sourceId, table, relevance, tableNameMatch, explicit });
      }
    }
    const lexicalBest = lexical.reduce((best, candidate) => Math.max(best, candidate.relevance), 0);
    for (const candidate of lexical) {
      const semanticAlreadySelected = selected.has(`${candidate.source_id}:${candidate.table}`);
      const keep = candidate.explicit ||
        (!semanticCandidates.length && candidate.relevance >= 2) ||
        (candidate.tableNameMatch && candidate.relevance >= Math.max(10, lexicalBest * 0.75));
      if (keep || semanticAlreadySelected) addTable(candidate.source_id, candidate.table, "technical_match");
    }

    if (active?.source_id && active?.table) addTable(active.source_id, active.table, "active_context");
    for (const entity of Array.isArray(conversationContext?.entities) ? conversationContext.entities : []) {
      if (entity?.source_id && entity?.entity_table) addTable(entity.source_id, entity.entity_table, "conversation_entity");
    }

    // API operation metadata has no table namespace. Select only operations
    // whose discovered operation IDs or response fields match the question.
    const selectedApi = new Map();
    for (const [sourceId, context] of Object.entries(this.contexts || {})) {
      for (const [operationId, operation] of Object.entries(context?.api_operations || {})) {
        const words = new Set([
          ...tokenWords(operationId),
          ...((operation?.response_fields || []).flatMap(tokenWords))
        ]);
        if ([...words].some(word => queryTokens.has(word))) {
          if (!selectedApi.has(sourceId)) selectedApi.set(sourceId, new Set());
          selectedApi.get(sourceId).add(operationId);
        }
      }
    }

    if (selected.size === 0 && selectedApi.size === 0) return null;

    const selectedKeys = new Set(selected.keys());
    const activeOption = active?.source_id && active?.table ? { active } : {};
    let paths = [];
    try {
      paths = findVerifiedPaths(text, this.contexts, null, activeOption);
    } catch {
      paths = [];
    }
    paths = paths.filter(path =>
      path?.validation_status === "validated" &&
      Array.isArray(path.steps) &&
      path.steps.some(step => selectedKeys.has(`${step?.source_id}:${step?.table}`))
    );

    const focusedKeys = new Set(selectedKeys);
    const relationshipKeys = new Set();
    for (const path of paths) {
      for (const step of path.steps || []) {
        if (step?.source_id && step?.table) focusedKeys.add(`${step.source_id}:${step.table}`);
      }
    }

    // Preserve directly declared relationship edges around selected entities,
    // including technical FK paths needed by unfamiliar tables. This is a
    // bounded neighborhood, not a replacement graph or inferred relationship.
    const seedKeys = new Set(selectedKeys);
    const coreTableKeys = new Set(selectedKeys);
    for (const path of paths) {
      for (const step of path.steps || []) {
        if (step?.source_id && step?.table) coreTableKeys.add(`${step.source_id}:${step.table}`);
      }
    }
    for (const [sourceId, context] of Object.entries(this.contexts || {})) {
      if (directEntityContext) continue;
      for (const relationship of Array.isArray(context?.relationships) ? context.relationships : []) {
        const left = `${sourceId}:${relationship?.source_table || ""}`;
        const right = `${sourceId}:${relationship?.target_table || ""}`;
        if (seedKeys.has(left) || seedKeys.has(right)) {
          relationshipKeys.add(`${left}:${relationship?.source_column || ""}->${right}:${relationship?.target_column || ""}`);
          if (relationship?.source_table) focusedKeys.add(left);
          if (relationship?.target_table) focusedKeys.add(right);
        }
      }
    }

    // A verified path may contain an ordinary same-source FK edge that was
    // not incident to the original candidate (for example, an intermediate
    // bridge table). Retain only those exact path edges, never every edge
    // between the expanded neighborhood.
    for (const path of paths) {
      const steps = Array.isArray(path.steps) ? path.steps : [];
      for (let index = 0; index < steps.length - 1; index++) {
        const leftStep = steps[index];
        const rightStep = steps[index + 1];
        if (!leftStep?.source_id || !rightStep?.source_id || leftStep.source_id !== rightStep.source_id) continue;
        for (const relationship of this.contexts?.[leftStep.source_id]?.relationships || []) {
          const matches = (relationship?.source_table === leftStep.table && relationship?.target_table === rightStep.table) ||
            (relationship?.source_table === rightStep.table && relationship?.target_table === leftStep.table);
          if (!matches) continue;
          const source = `${leftStep.source_id}:${relationship.source_table}`;
          const target = `${leftStep.source_id}:${relationship.target_table}`;
          relationshipKeys.add(`${source}:${relationship.source_column || ""}->${target}:${relationship.target_column || ""}`);
        }
      }
    }

    return {
      candidates: semanticCandidates.filter(candidate => selectedKeys.has(`${candidate.source_id}:${candidate.table}`)),
      tableKeys: focusedKeys,
      coreTableKeys,
      relationshipKeys,
      apiOperations: selectedApi,
      paths
    };
  }

  _is_direct_entity_lookup_context(question, semanticCandidates = []) {
    const text = String(question || "");
    if (!/\b(?:show|details?|about|information|find)\b/i.test(text)) return false;
    if (/\b(?:recent|latest|newest|count|how many|total|list|which|compare|comparison|ranking|top)\b/i.test(text)) return false;
    if (/\b(?:and|with|related|associated|whose|owner|owns|belongs|relationship|connect|linked)\b/i.test(text)) return false;
    const tables = new Set((semanticCandidates || []).map(candidate => String(candidate?.table || "").trim().toLowerCase()).filter(Boolean));
    return tables.size === 1 && semanticCandidates.length > 0;
  }

  _build_context_for_llm(question = null, conversationContext = null) {
    const focus = this._build_context_focus(question, conversationContext);
    const sources = {};

    for (const [sourceId, context] of Object.entries(this.contexts)) {
      if (!context || typeof context !== "object" || Array.isArray(context)) continue;
      const normalizedSourceId = String(sourceId).trim().toLowerCase();
      const sourceTableKeys = focus
        ? new Set([...focus.tableKeys].filter(key => key.startsWith(`${normalizedSourceId}:`)).map(key => key.slice(normalizedSourceId.length + 1)))
        : null;
      const apiSelection = focus?.apiOperations?.get(sourceId) || focus?.apiOperations?.get(normalizedSourceId) || null;
      if (focus && sourceTableKeys?.size === 0 && !apiSelection) continue;

      const tables = context.tables && typeof context.tables === "object" && !Array.isArray(context.tables) ? context.tables : {};
      const boundedTables = {};
      const tableEntries = Object.entries(tables).filter(([tableName]) => !focus || sourceTableKeys.has(tableName));

      for (let tableIndex = 0; tableIndex < tableEntries.length && tableIndex < this.MAX_CONTEXT_TABLES_PER_SOURCE; tableIndex++) {
        const [tableName, tableInfo] = tableEntries[tableIndex];
        if (!tableInfo || typeof tableInfo !== "object" || Array.isArray(tableInfo)) continue;
        const boundedColumns = [];
        const columns = Array.isArray(tableInfo.columns) ? tableInfo.columns : [];
        const tableKey = `${normalizedSourceId}:${tableName}`;
        const coreTable = !focus || focus.coreTableKeys.has(tableKey);
        const requiredNeighborhoodColumns = new Set(Array.isArray(tableInfo.primary_keys) ? tableInfo.primary_keys.map(String) : []);
        if (focus && !coreTable) {
          for (const relationship of Array.isArray(context.relationships) ? context.relationships : []) {
            const relationshipKey = `${normalizedSourceId}:${relationship?.source_table || ""}:${relationship?.source_column || ""}->${normalizedSourceId}:${relationship?.target_table || ""}:${relationship?.target_column || ""}`;
            if (!focus.relationshipKeys.has(relationshipKey)) continue;
            if (relationship?.source_table === tableName && relationship?.source_column) requiredNeighborhoodColumns.add(String(relationship.source_column));
            if (relationship?.target_table === tableName && relationship?.target_column) requiredNeighborhoodColumns.add(String(relationship.target_column));
          }
        }
        for (let columnIndex = 0; columnIndex < columns.length && columnIndex < this.MAX_CONTEXT_COLUMNS_PER_TABLE; columnIndex++) {
          const column = columns[columnIndex];
          if (!column || typeof column !== "object" || Array.isArray(column)) continue;
          const columnName = column.name;
          if (!columnName || isSensitiveFieldName(columnName)) continue;
          if (!coreTable && !requiredNeighborhoodColumns.has(String(columnName))) continue;
          boundedColumns.push({
            name: String(columnName),
            data_type: column.data_type !== undefined ? column.data_type : column.type,
          });
        }
        boundedTables[String(tableName)] = {
          columns: boundedColumns,
          primary_keys: Array.isArray(tableInfo.primary_keys) ? [...tableInfo.primary_keys] : [],
        };
      }

      const relationshipMatches = relationship => {
        if (!focus) return true;
        const left = `${normalizedSourceId}:${relationship?.source_table || ""}`;
        const right = `${normalizedSourceId}:${relationship?.target_table || ""}`;
        const relationshipKey = `${left}:${relationship?.source_column || ""}->${right}:${relationship?.target_column || ""}`;
        return focus.relationshipKeys.has(relationshipKey);
      };
      const boundedRelationships = (Array.isArray(context.relationships) ? context.relationships : [])
        .filter(rel => rel && typeof rel === "object" && !Array.isArray(rel) && relationshipMatches(rel))
        .slice(0, this.MAX_CONTEXT_RELATIONSHIPS);
      const businessRelationshipMatches = relationship => {
        if (!focus) return true;
        const leftSource = String(relationship?.source_id || relationship?.source_source_id || normalizedSourceId).toLowerCase();
        const rightSource = String(relationship?.target_id || relationship?.target_source_id || normalizedSourceId).toLowerCase();
        return focus.tableKeys.has(`${leftSource}:${relationship?.source_table || ""}`) &&
          focus.tableKeys.has(`${rightSource}:${relationship?.target_table || ""}`);
      };
      const boundedBusinessRelationships = (Array.isArray(context.business_relationships) ? context.business_relationships : [])
        .filter(rel => rel && typeof rel === "object" && !Array.isArray(rel) && businessRelationshipMatches(rel))
        .slice(0, this.MAX_CONTEXT_RELATIONSHIPS);

      const allApiOperations = context.api_operations && typeof context.api_operations === "object" && !Array.isArray(context.api_operations) ? context.api_operations : {};
      const apiEntries = focus && apiSelection
        ? Object.entries(allApiOperations).filter(([operationId]) => apiSelection.has(operationId))
        : (focus ? [] : Object.entries(allApiOperations));
      const apiOperations = Object.fromEntries(apiEntries.slice(0, this.MAX_CONTEXT_TABLES_PER_SOURCE).map(([operationId, operation]) => [operationId, {
        operation_id: operation?.operation_id,
        response_fields: Array.isArray(operation?.response_fields) ? operation.response_fields.slice(0, this.MAX_CONTEXT_COLUMNS_PER_TABLE) : []
      }]));

      const semanticEntities = Object.fromEntries(Object.entries(context.semantic_catalog?.entities || {})
        .filter(([table]) => !focus || sourceTableKeys.has(table))
        .slice(0, this.MAX_CONTEXT_TABLES_PER_SOURCE)
        .map(([table, entity]) => [table, {
          entity_type: entity.entity_type,
          description: entity.description,
          synonyms: entity.synonyms,
          source_qualified_meaning: entity.source_qualified_meaning,
          ordering: entity.ordering,
          provenance: entity.provenance,
          trust_level: entity.trust_level || "approved_semantic",
          technical_entity: Boolean(entity.technical_entity)
        }]));

      sources[normalizedSourceId] = {
        source_type: context.source_type || "postgresql",
        catalog_status: context.semantic_catalog_status || { validation_status: "unknown", freshness_status: "unknown" },
        tables: boundedTables,
        relationships: boundedRelationships,
        business_relationships: boundedBusinessRelationships,
        api_operations: apiOperations,
        semantic_entities: semanticEntities
      };
    }

    return {
      sources,
      candidate_entities: focus ? focus.candidates.map(candidate => ({
        source_id: candidate.source_id,
        table: candidate.table,
        entity_type: candidate.entity_type,
        matched_aliases: candidate.matched_aliases,
        score: candidate.score,
        ordering_column: candidate.ordering_column,
        provenance: candidate.provenance
      })) : undefined,
      verified_paths: focus
        ? focus.paths
        : Object.values(this.contexts).flatMap(context => context.semantic_catalog?.verified_paths || []).slice(0, this.MAX_CONTEXT_RELATIONSHIPS)
    };
  }

  _buildContextForLlm() {
    return this._build_context_for_llm();
  }

  _semantic_role_key(candidate) {
    const aliases = Array.isArray(candidate?.matched_aliases) ? candidate.matched_aliases : [];
    const entityType = String(candidate?.entity_type || "").replace(/^technical:/i, "");
    const roleText = aliases[0] || entityType || candidate?.table || "entity";
    const tokens = tokenWords(roleText).filter(token => !["technical"].includes(token));
    return tokens.join("_") || "entity";
  }

  semantic_intent(question) {
    const text = String(question || "");
    const candidates = findSemanticCandidates(text, this.contexts);
    const lexicalCandidates = Object.entries(this.contexts || {}).flatMap(([source_id, context]) => Object.keys(context?.tables || {})
      .filter(table => text.toLowerCase().includes(String(table).replace(/_/g, " ").toLowerCase()))
      .map(table => ({ source_id, table, entity_type: context.semantic_catalog?.entities?.[table]?.entity_type || `technical:${table}`, matched_aliases: [table] })));
    const requested = [...candidates.filter(candidate => (candidate.matched_aliases || []).length > 0), ...lexicalCandidates]
      .map(candidate => ({ source_id: candidate.source_id, table: candidate.table, entity_type: candidate.entity_type, matched_aliases: candidate.matched_aliases || [] }));
    const assignment = /\b(?:assigned|assignee|assignment|belong|belonging|belongs|associated)\b/i.test(text);
    const taskRequested = /\b(?:task|tasks)\b/i.test(text);
    // A clear anchor plus relational pronouns/conjunctions expresses a
    // related-entity request even when the user does not use a formal
    // "belongs to" verb (for example, "meetings with their projects").
    const relationshipCue = /\b(?:with|alongside|their|its)\b/i.test(text) ||
      /\b(?:each|every)\s+[a-z][a-z'-]*['\u2019]s\b/i.test(text);
    const taskTargets = Object.entries(this.contexts || {}).flatMap(([source_id, context]) => Object.entries(context?.tables || {})
      .filter(([table, info]) => {
        const entity = context?.semantic_catalog?.entities?.[table] || {};
        const semanticTask = [entity.entity_type, ...(entity.synonyms || [])].some(value => /\btask\b/i.test(String(value || "")));
        const taskTable = /(?:^|_)tasks?(?:_|$)/i.test(table);
        const assignmentColumn = (info?.columns || []).some(column => /(?:^|_)(?:assignee|assigned(?:_to)?|assigned_user)(?:_|$)/i.test(String(column?.name || column)));
        const userAssignmentEdge = (context.relationships || []).some(relationship => {
          const tables = [relationship?.source_table, relationship?.target_table].map(value => String(value || "").toLowerCase());
          const columns = [relationship?.source_column, relationship?.target_column].map(value => String(value || "").toLowerCase());
          const hasUserEndpoint = tables.some(value => /(?:^|_)users?(?:_|$)/i.test(value));
          const hasTaskEndpoint = tables.includes(String(table).toLowerCase());
          const assignmentKey = columns.some(value => /(?:assignee|assigned|user|owner)/i.test(value));
          return hasTaskEndpoint && hasUserEndpoint && assignmentKey;
        });
        return (semanticTask && (assignmentColumn || userAssignmentEdge)) || (taskTable && assignmentColumn);
      })
      .map(([table]) => ({ source_id, table })));
    // Select the last relationship marker so nested wording such as
    // "assigned to users belonging to Alex Smith" resolves the named
    // identity after the final marker, not the intermediate noun phrase.
    const identityMatches = [...text.matchAll(/\b(?:belonging\s+to|associated\s+with|assigned\s+to|to|for|of)\s+([A-Za-z][A-Za-z'-]*)\s+([A-Za-z][A-Za-z'-]*)(?:['\u2019]s)?\b/gi)];
    const identityMatch = identityMatches.at(-1) || text.match(/\b([A-Za-z][A-Za-z'-]*)\s+([A-Za-z][A-Za-z'-]*)['\u2019]s\s+company\b/i);
    const genericIdentityWords = new Set(["which", "what", "who", "where", "when", "that", "this", "these", "those"]);
    const namedAnchor = identityMatch && !genericIdentityWords.has(String(identityMatch[1]).toLowerCase()) && !genericIdentityWords.has(String(identityMatch[2]).toLowerCase())
      ? { kind: "named_identity", value: `${identityMatch[1]} ${String(identityMatch[2]).replace(/['\u2019]s$/i, "")}` }
      : null;
    const operations = [];
    if (this._is_count_question(text, candidates)) operations.push("count");
    if (this._is_recent_records_question(text)) operations.push("ranking");
    if (/\b(?:exists?|any|whether|are there)\b/i.test(text)) operations.push("existence");
    const negated = /\b(?:not|without|never|no)\b/i.test(text);
    const branchEntities = [...new Map(requested.map(item => [`${item.source_id}:${item.table}`, item])).values()];
    const relationshipIntent = assignment ||
      (relationshipCue && new Set(branchEntities.map(item => this._semantic_role_key(item))).size > 1);
    const branchGroups = new Map();
    for (const item of branchEntities) {
      const role = this._semantic_role_key(item);
      if (!branchGroups.has(role)) branchGroups.set(role, []);
      branchGroups.get(role).push({ source_id: item.source_id, table: item.table });
    }
    const requestedAttributes = [];
    if (/\bnames?\b/i.test(text)) requestedAttributes.push("name");
    if (/\btitles?\b/i.test(text)) requestedAttributes.push("title");
    const requestedBranches = relationshipIntent && branchGroups.size > 1
      ? [...branchGroups.entries()].map(([role, entities]) => ({ id: `branch_${role}`, required_entities: entities }))
      : branchEntities.length > 1 && /\band\b/i.test(text)
        ? branchEntities.map((item, index) => ({ id: `branch_${index + 1}`, required_entities: [{ source_id: item.source_id, table: item.table }] }))
      : (taskRequested ? [{ id: "task_assignment", required_entities: [] }] : []);
    const anchorCandidate = relationshipIntent
      ? branchEntities
        .map(candidate => ({ candidate, position: Math.min(...(candidate.matched_aliases || []).map(alias => text.toLowerCase().indexOf(String(alias).toLowerCase())).filter(position => position >= 0)) }))
        .filter(item => Number.isFinite(item.position))
        .sort((left, right) => left.position - right.position)[0]?.candidate
      : null;
    const anchorEntities = namedAnchor
      ? [namedAnchor]
      : (anchorCandidate ? [{ kind: "entity_anchor", source_id: anchorCandidate.source_id, table: anchorCandidate.table, role: this._semantic_role_key(anchorCandidate) }] : []);
    const explicitIdentityValue = extractEntitySearchText(text);
    const identityConstraints = explicitIdentityValue && /^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(String(explicitIdentityValue).trim())
      ? [{ kind: "email", value: String(explicitIdentityValue).trim() }]
      : [];
    return {
      version: 1,
      anchor_entities: anchorEntities,
      requested_entities: requested,
      requested_branches: requestedBranches,
      requested_attributes: requestedAttributes,
      filters: identityConstraints,
      identity_constraints: identityConstraints,
      operations,
      relationship_intent: relationshipIntent,
      task_assignment: taskRequested && assignment,
      required_final_candidates: taskRequested && assignment ? taskTargets : [],
      aggregate: operations.includes("count"),
      temporal: operations.includes("ranking"),
      negation: negated,
      source_constraints: []
    };
  }

  assess_semantic_completeness(plan, question) {
    const intent = this.semantic_intent(question);
    const steps = Array.isArray(plan?.execution_plan?.steps) ? plan.execution_plan.steps : [];
    const targets = steps.flatMap(step => (step?.contract?.required_tables || []).map(table => ({ source_id: step.source_id, table: String(table) })));
    const tables = new Set([...(plan?.required_tables || []), ...targets.map(target => target.table)]);
    const planOperations = new Set((Array.isArray(plan?.operations) ? plan.operations : [])
      .map(operation => String(operation || "").trim().toLowerCase())
      .filter(Boolean));
    if (Array.isArray(intent.identity_constraints) && intent.identity_constraints.length > 0) {
      const plannedFilters = [
        ...(Array.isArray(plan?.filters) ? plan.filters : []),
        ...steps.flatMap(step => Array.isArray(step?.contract?.filters) ? step.contract.filters : [])
      ];
      const identityPreserved = intent.identity_constraints.every(constraint => plannedFilters.some(filter =>
        /email|username|login/i.test(String(filter?.field || filter?.column || "")) &&
        String(filter?.value || "").toLowerCase() === String(constraint.value || "").toLowerCase()
      ));
      if (!identityPreserved) return { complete: false, intent, reason: "missing_explicit_identity_predicate" };
    }
    const missingOperations = intent.operations.filter(operation => {
      const normalized = String(operation || "").trim().toLowerCase();
      if (normalized === "existence") return !(planOperations.has("existence") || planOperations.has("exists"));
      return !planOperations.has(normalized);
    });
    if (missingOperations.length > 0) {
      return { complete: false, intent, reason: `missing_requested_operation:${missingOperations[0]}` };
    }
    if (intent.aggregate && plan?.candidate_resolution?.mode === "independent") return { complete: true, intent, reason: null };
    if (intent.relationship_intent && !intent.task_assignment) {
      const bindings = steps.flatMap(step => Array.isArray(step?.input_bindings) ? step.input_bindings : []);
      const independentMode = plan?.candidate_resolution?.mode === "independent";
      const independentSteps = steps.length > 1 && steps.every(step =>
        (!Array.isArray(step?.depends_on) || step.depends_on.length === 0) &&
        (!Array.isArray(step?.input_bindings) || step.input_bindings.length === 0)
      );
      const independent = independentSteps || (independentMode && !steps.some(step =>
        (Array.isArray(step?.depends_on) && step.depends_on.length > 0) ||
        (Array.isArray(step?.input_bindings) && step.input_bindings.length > 0)
      ));
      const path = Array.isArray(plan?.semantic_path) ? plan.semantic_path : [];
      const pathSources = path.map(step => `${step?.source_id || ""}:${step?.table || ""}`);
      const stepSources = steps.flatMap(step => (step?.contract?.required_tables || []).map(table => `${step?.source_id || ""}:${table}`));
      const pathMatchesSteps = path.length > 1 && pathSources.every(key => stepSources.includes(key));
      const declaredVerifiedEdges = (Array.isArray(plan?.relationships) && plan.relationships.length > 0) ||
        (Array.isArray(plan?.semantic_path_evidence) && plan.semantic_path_evidence.length > 0);
      const completeDependencyChain = steps.length > 1 && bindings.length >= steps.length - 1 && steps.slice(1).every((step, index) =>
        (Array.isArray(step.depends_on) && step.depends_on.includes(steps[index].id)) ||
        bindings.some(binding => binding.from_step === steps[index].id)
      );
      const contextualDependencyChain = Boolean(plan?.needs_conversation_context) && completeDependencyChain;
      const directVerifiedRelationshipFilter = declaredVerifiedEdges &&
        Array.isArray(plan?.filters) &&
        plan.filters.some(filter => {
          const filterTable = String(filter?.table || "").toLowerCase();
          const filterColumn = String(filter?.field || filter?.column || "").split(".").at(-1).toLowerCase();
          return Array.isArray(plan?.relationships) && plan.relationships.some(relationship => {
            const sourceTable = String(relationship?.source_table || "").toLowerCase();
            const targetTable = String(relationship?.target_table || "").toLowerCase();
            const sourceColumn = String(relationship?.source_column || "").toLowerCase();
            const targetColumn = String(relationship?.target_column || "").toLowerCase();
            return ((filterTable === sourceTable && filterColumn === sourceColumn) ||
              (filterTable === targetTable && filterColumn === targetColumn)) &&
              tables.has(relationship.source_table) && tables.has(relationship.target_table);
          });
        });
      if (independent || ((!pathMatchesSteps && !declaredVerifiedEdges) && !contextualDependencyChain) || (!completeDependencyChain && !directVerifiedRelationshipFilter)) {
        return { complete: false, intent, reason: "incomplete_verified_relationship_path" };
      }
    }
    if (intent.task_assignment) {
      const finalTask = intent.required_final_candidates.some(target => targets.some(actual => actual.source_id === target.source_id && actual.table === target.table));
      const finalStep = steps.at(-1);
      const finalIsTask = finalStep && intent.required_final_candidates.some(target => target.source_id === finalStep.source_id && target.table === finalStep.contract?.required_tables?.[0]);
      const hasAssignmentBinding = steps.some(step => (step.input_bindings || []).some(binding => /assignee|assigned|user/i.test(`${binding.from_column} ${binding.to_column}`)));
      const hasNamedIdentity = !intent.anchor_entities.length || steps.some(step => (step.contract?.filters || []).some(filter => /first_name|last_name|name|email/i.test(String(filter.field || ""))));
      if (!finalTask || !finalIsTask || !hasAssignmentBinding || !hasNamedIdentity) return { complete: false, intent, reason: "incomplete_task_assignment_path" };
    }
    const executableBranches = intent.requested_branches.filter(branch => branch.required_entities.length > 0);
    const missingBranch = executableBranches.find(branch => !branch.required_entities.some(required =>
      [...targets, ...(plan?.required_tables || []).map(table => ({ source_id: null, table: String(table) }))].some(actual =>
        actual.table === required.table && (!required.source_id || !actual.source_id || actual.source_id === required.source_id)
      )
    ));
    if (missingBranch) return { complete: false, intent, reason: `missing_requested_branch:${missingBranch.id}` };
    return { complete: true, intent, reason: null };
  }

  _build_resolved_entity_context(conversationContext) {
    if (!conversationContext || typeof conversationContext !== "object" || Array.isArray(conversationContext)) {
      return [];
    }

    const entities = conversationContext.entities;
    if (!Array.isArray(entities)) {
      return [];
    }

    const result = [];
    for (const entity of entities) {
      if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
        continue;
      }

      result.push({
        type: entity.type,
        id: entity.id,
        source_id: entity.source_id,
        entity_table: entity.entity_table,
        entity_column: entity.entity_column,
        confidence: entity.confidence,
        match_type: entity.match_type,
      });
    }

    return result;
  }

  _is_recent_records_question(question) {
    const text = String(question || "").replace(/["'][^"']*["']/g, " ").toLowerCase().split(/\s+/).join(" ");
    return Array.from(this.RECENT_QUESTION_TERMS).some(term => text.includes(term));
  }

  _is_temporal_column(column) {
    if (!column || typeof column !== "object" || Array.isArray(column)) {
      return false;
    }
    const name = String(column.name || "").toLowerCase();
    const dataType = String(column.data_type !== undefined ? column.data_type : column.type || "").toLowerCase();

    for (const hint of this.TEMPORAL_TYPE_HINTS) {
      if (dataType.includes(hint)) {
        return true;
      }
    }

    const tokens = new Set(name.replace(/-/g, "_").split("_"));
    for (const hint of this.TEMPORAL_NAME_HINTS) {
      if (tokens.has(hint)) {
        return true;
      }
    }

    return false;
  }

  _recent_column_score(column) {
    if (!this._is_temporal_column(column)) {
      return 0;
    }
    const name = String(column.name || "").toLowerCase();
    const dataType = String(column.data_type !== undefined ? column.data_type : column.type || "").toLowerCase();
    const tokens = new Set(name.replace(/-/g, "_").split("_"));

    let hasTypeHint = false;
    for (const hint of this.TEMPORAL_TYPE_HINTS) {
      if (dataType.includes(hint)) {
        hasTypeHint = true;
        break;
      }
    }

    let score = 1 + (hasTypeHint ? 5 : 0);
    if (tokens.has("created")) {
      score += 5;
    } else if (tokens.has("updated") || tokens.has("modified")) {
      score += 3;
    } else if (tokens.has("timestamp") || tokens.has("occurred")) {
      score += 3;
    } else {
      for (const hint of this.TEMPORAL_NAME_HINTS) {
        if (tokens.has(hint)) {
          score += 2;
          break;
        }
      }
    }

    return score;
  }

  _build_recent_record_candidates(question = null, tableKeys = null) {
    const candidates = [];
    const focusedKeys = tableKeys instanceof Set ? tableKeys : null;
    if (question && !this._is_recent_records_question(question)) return candidates;

    for (const [sourceId, context] of Object.entries(this.contexts)) {
      const tables = context && typeof context === "object" && !Array.isArray(context) ? (context.tables || {}) : {};
      if (!tables || typeof tables !== "object" || Array.isArray(tables)) {
        continue;
      }

      for (const [tableName, tableInfo] of Object.entries(tables)) {
        if (focusedKeys && !focusedKeys.has(`${sourceId}:${tableName}`)) continue;
        if (!tableInfo || typeof tableInfo !== "object" || Array.isArray(tableInfo)) {
          continue;
        }

        const columns = tableInfo.columns;
        if (!Array.isArray(columns)) {
          continue;
        }

        const temporal = columns.filter(c => c && typeof c === "object" && !Array.isArray(c) && this._is_temporal_column(c));
        if (temporal.length === 0) {
          continue;
        }

        let best = temporal[0];
        let bestScore = this._recent_column_score(best);
        for (let i = 1; i < temporal.length; i++) {
          const s = this._recent_column_score(temporal[i]);
          if (s > bestScore) {
            best = temporal[i];
            bestScore = s;
          }
        }

        const keys = Array.isArray(tableInfo.primary_keys) ? tableInfo.primary_keys : [];
        let useful = 0;
        for (const c of columns) {
          if (c && typeof c === "object" && !keys.includes(c.name)) {
            useful++;
          }
        }

        const score = bestScore + (keys.length > 0 ? 3 : 0) + Math.min(useful, 6);
        candidates.push({
          source_id: String(sourceId),
          table: String(tableName),
          time_column: best.name,
          score,
        });
      }
    }

    candidates.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (a.source_id !== b.source_id) {
        return a.source_id.localeCompare(b.source_id);
      }
      return a.table.localeCompare(b.table);
    });

    // Do not truncate before the caller can narrow by authorized source and
    // semantic entity. A global top-N list made a valid DB2 temporal table
    // disappear behind unrelated DB1 tables with the same timestamp score.
    return candidates;
  }

  _complete_temporal_plan_if_needed(plan, question) {
    if (
      !this._is_recent_records_question(question) ||
      !plan ||
      typeof plan !== "object" ||
      Array.isArray(plan) ||
      JSON.stringify(plan.data_sources) !== JSON.stringify(["postgresql"]) ||
      (Array.isArray(plan.sorting) && plan.sorting.length > 0)
    ) {
      return plan;
    }

    let candidates = this._build_recent_record_candidates();
    const semantic = findSemanticCandidates(question, this.contexts);
    if (semantic.length > 0) {
      const semanticKeys = new Set(semantic.map(candidate => `${candidate.source_id}:${candidate.table}`));
      const focused = candidates.filter(candidate => semanticKeys.has(`${candidate.source_id}:${candidate.table}`));
      if (focused.length > 0) candidates = focused;
    }
    const allowed = new Set(Array.isArray(plan.postgresql_sources) ? plan.postgresql_sources : []);
    if (allowed.size > 0) {
      candidates = candidates.filter(c => allowed.has(c.source_id));
    }
    const requestedTables = new Set((plan.required_tables || []).map(item => String(item).toLowerCase()));
    if (requestedTables.size > 0) candidates = candidates.filter(candidate => requestedTables.has(candidate.table.toLowerCase()));
    if (candidates.length === 0) {
      return plan;
    }

    // Table/column relevance is metadata-derived. It selects a target only
    // when the question distinguishes it; ties are retained as ambiguity for
    // the caller instead of querying arbitrary sources.
    const scored = candidates.map(candidate => ({
      ...candidate,
      relevance: this._table_question_relevance(candidate.source_id, candidate.table, question)
    })).sort((a, b) => b.relevance - a.relevance || b.score - a.score || a.source_id.localeCompare(b.source_id) || a.table.localeCompare(b.table));
    const best = scored[0];
    if (!best || (requestedTables.size === 0 && best.relevance <= 0)) return plan;
    const tied = scored.filter(candidate => candidate.relevance === best.relevance && candidate.score === best.score);
    if (requestedTables.size === 0 && tied.length > 1) {
      return { ...plan, ambiguous_context_candidates: tied.map(({ source_id, table, time_column }) => ({ source_id, table, time_column })) };
    }
    const selected = [best];

    const columns = selected
      .filter(c => c.time_column)
      .map(c => `${c.table}.${c.time_column}`);

    if (columns.length === 0) {
      return plan;
    }

    const result = deepcopy(plan);
    result.postgresql_sources = selected.map(c => c.source_id);
    result.required_tables = selected.map(c => c.table);
    result.required_columns = columns;
    result.sorting = columns.map(c => ({ field: c, direction: "desc" }));
    result.operations = ["ranking"];
    result.limit = result.limit || 10;
    result.reasoning =
      "Recent-record retrieval was completed from discovered temporal columns because the initial plan did not identify a retrieval field.";
    result.confidence = Math.max(Number(result.confidence || 0), 0.70);
    return result;
  }

  _table_question_relevance(sourceId, tableName, question) {
    const tokens = new Set((String(question).toLowerCase().match(/[a-z0-9_]+/g) || [])
      .map(token => token.endsWith("s") && token.length > 3 ? token.slice(0, -1) : token)
      .filter(token => token.length > 2 && !this.RECENT_QUESTION_TERMS.has(token)));
    const words = String(tableName).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(word => word.endsWith("s") && word.length > 3 ? word.slice(0, -1) : word);
    const matchedTableWords = words.filter(word => tokens.has(word));
    let score = matchedTableWords.length * 10;
    // Prefer a table whose complete normalized name is represented by the
    // question. Related child/log/attachment tables retain a lower score and
    // do not displace the requested entity merely because they share a prefix.
    if (words.length > 0 && matchedTableWords.length === words.length) score += 8;
    const columns = this.contexts?.[sourceId]?.tables?.[tableName]?.columns || [];
    for (const column of columns) {
      const columnWords = String(column?.name || "").toLowerCase().split(/[^a-z0-9]+/);
      if (columnWords.some(word => tokens.has(word))) score++;
    }
    return score;
  }

  _explicit_table_phrase(question, tableName) {
    const phrase = String(tableName || "").replace(/_/g, " ").trim();
    if (!phrase) return false;
    // Generic project wording is intentionally left source-ambiguous; DB1
    // project_details and DB2 projects are separate business definitions and
    // are retained as independent candidates unless the user qualifies one.
    if (["projects", "project details"].includes(phrase.toLowerCase())) return false;
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}(?:s)?\\b`, "i").test(String(question || ""));
  }

  _infer_postgresql_sources(plan, question) {
    const available = this._get_available_postgresql_sources();
    if (available.length === 0) {
      return [];
    }

    const requested = (Array.isArray(plan.postgresql_sources) ? plan.postgresql_sources : [])
      .filter(v => typeof v === "string" && v.trim())
      .map(v => v.trim().toLowerCase());

    const requestedDeduped = Array.from(new Set(requested)).filter(x => available.includes(x));
    if (requestedDeduped.length > 0) {
      return requestedDeduped;
    }

    const tables = (Array.isArray(plan.required_tables) ? plan.required_tables : [])
      .filter(x => typeof x === "string" && x.trim())
      .map(x => x.trim().toLowerCase());

    if (tables.length > 0) {
      const matches = [];
      for (const sourceId of available) {
        const context = this.contexts[sourceId] || {};
        const known = context && typeof context === "object" && !Array.isArray(context) ? (context.tables || {}) : {};
        const names = new Set(Object.keys(known).map(n => String(n).trim().toLowerCase()));
        if (tables.some(table => names.has(table))) {
          matches.push(sourceId);
        }
      }
      if (matches.length > 0) {
        return matches;
      }
    }

    const tokens = new Set(
      (question.toLowerCase().match(/[a-z0-9_]+/g) || []).filter(token => token.length >= 2)
    );

    const scores = {};
    for (const sourceId of available) {
      const context = this.contexts[sourceId] || {};
      let sourceScore = 0;
      const sourceTables = context && typeof context === "object" && !Array.isArray(context) ? (context.tables || {}) : {};

      if (sourceTables && typeof sourceTables === "object" && !Array.isArray(sourceTables)) {
        for (const [tableName, tableInfo] of Object.entries(sourceTables)) {
          const tableText = String(tableName).toLowerCase();
          for (const token of tokens) {
            if (tableText.includes(token) || token.includes(tableText)) {
              sourceScore += 4;
              break;
            }
          }

          const columns = tableInfo && typeof tableInfo === "object" && Array.isArray(tableInfo.columns) ? tableInfo.columns : [];
          for (const column of columns) {
            if (!column || typeof column !== "object" || Array.isArray(column)) {
              continue;
            }
            const name = String(column.name || "").toLowerCase();
            if (name) {
              for (const token of tokens) {
                if (name.includes(token) || token.includes(name)) {
                  sourceScore += 1;
                  break;
                }
              }
            }
          }
        }
      }

      scores[sourceId] = sourceScore;
    }

    const bestScore = Math.max(...Object.values(scores), 0);
    if (bestScore > 0) {
      return available.filter(sourceId => scores[sourceId] === bestScore);
    }

    return available;
  }

  _get_available_postgresql_sources() {
    return Object.keys(this.contexts)
      .filter(sourceId => typeof sourceId === "string" && sourceId.trim() && (this.contexts[sourceId]?.source_type || "postgresql") === "postgresql")
      .map(sourceId => sourceId.trim().toLowerCase());
  }

  _get_available_external_api_sources() {
    return Object.keys(this.contexts).filter(sourceId => this.contexts[sourceId]?.source_type === "external_api").map(sourceId => sourceId.trim().toLowerCase());
  }

  _parse_json_response(content) {
    let candidate = content.trim();

    if (candidate.startsWith("```")) {
      let lines = candidate.split(/\r?\n/);
      if (lines.length > 0 && lines[0].trim().startsWith("```")) {
        lines = lines.slice(1);
      }
      if (lines.length > 0 && lines[lines.length - 1].trim() === "```") {
        lines = lines.slice(0, -1);
      }
      candidate = lines.join("\n").trim();
    }

    let raw;
    try {
      raw = JSON.parse(candidate);
    } catch (exc) {
      throw new Error(`Question planner returned invalid JSON: ${exc.message}`);
    }

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Question planner response must be a JSON object.");
    }

    return raw;
  }

  _normalize_plan(plan, question, conversationContext = null) {
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
      throw new Error("Question plan must be a dictionary.");
    }

    // RAGPipeline may append a bounded source-qualified context anchor for
    // provider interpretation. It is not user intent and must not participate
    // in entity/status lexical checks (for example, a UUID must not turn a
    // detail follow-up into an explicit status or new-entity request).
    question = String(question).replace(/\s+\[context\s+[^\]]+\]\s*$/i, "").trim();

    const normalized = deepcopy(plan);

    normalized.question = question;
    normalized.data_sources = this._normalize_data_sources(normalized);
    normalized.postgresql_sources = this._normalize_postgresql_sources(normalized);
    normalized.api_sources = this._normalize_string_list(normalized.api_sources ?? []).map(source => source.toLowerCase());
    normalized.api_operation = normalized.api_operation === null || normalized.api_operation === undefined ? null : String(normalized.api_operation).trim();

    // An unresolved business/source ambiguity is a terminal planning state.
    // Do not let the generic schema-anchor fallback attach an unrelated table
    // (for example a table that merely shares a column token) while retaining
    // the ambiguity marker.  The pipeline will turn this into a precise
    // clarification before validation or SQL generation.
    if (
      Array.isArray(normalized.ambiguous_context_candidates) &&
      normalized.ambiguous_context_candidates.length > 1 &&
      normalized.candidate_resolution?.mode !== "independent" &&
      !this._conversation_reference(conversationContext) &&
      !this._question_has_explicit_identity_constraint(question)
    ) {
      return normalized;
    }

    if (normalized.data_sources.includes("postgresql")) {
      normalized.postgresql_sources = this._infer_postgresql_sources(
        normalized,
        question
      );
    }

    normalized.required_tables = this._normalize_string_list(
      normalized.required_tables ?? []
    );

    normalized.required_columns = this._normalize_required_columns(
      normalized.required_columns ?? []
    );

    normalized.required_columns = this._resolve_required_columns(
      normalized.required_columns,
      normalized.required_tables ?? [],
      normalized.postgresql_sources ?? []
    );

    // An explicit, non-deictic entity request starts a new target.  Provider
    // plans sometimes mark every later turn as context-dependent; allowing
    // that flag through here would reattach the previous record's stable IDs
    // to an unrelated table (for example, users or meeting_summaries after a
    // meeting-detail lookup).  Preserve context only for genuine references
    // or when the user supplied an explicit identifier.
    const activeReference = this._conversation_reference(conversationContext);
    const hasDeicticReference = /\b(?:it|its|that|this|those|these|above|previous|prior|related)\b/i.test(question);
    const hasExplicitIdentifier = /\b(?:id|identifier|code|reference|number|key)\b/i.test(question) ||
      /\b[A-Za-z0-9]+-[A-Za-z0-9-]+\b/.test(question);
    const planTargetsNewTable = activeReference && Array.isArray(normalized.required_tables) &&
      normalized.required_tables.some(table => String(table).toLowerCase() !== String(activeReference.table || "").toLowerCase());
    const technicalSemanticTarget = [...(Array.isArray(normalized.semantic_candidates) ? normalized.semantic_candidates : []), ...findSemanticCandidates(question, this.contexts)].some(candidate => {
      const sourceId = String(candidate?.source_id || "").toLowerCase();
      const table = String(candidate?.table || "");
      return Boolean(this.contexts?.[sourceId]?.semantic_catalog?.entities?.[table]?.technical_entity);
    });
    const activeHasDeclaredTarget = technicalSemanticTarget && Boolean(activeReference && Array.isArray(normalized.required_tables) && normalized.required_tables.some(table =>
      (this.contexts?.[activeReference.source_id]?.relationships || []).some(relationship =>
        (String(relationship?.source_table || "").toLowerCase() === String(activeReference.table || "").toLowerCase() && String(relationship?.target_table || "").toLowerCase() === String(table).toLowerCase()) ||
        (String(relationship?.target_table || "").toLowerCase() === String(activeReference.table || "").toLowerCase() && String(relationship?.source_table || "").toLowerCase() === String(table).toLowerCase())
      )
    ));
    const isExplicitEntityChange = activeReference && !hasDeicticReference && !hasExplicitIdentifier &&
      !activeHasDeclaredTarget && (this._has_explicit_new_target(question, activeReference) || planTargetsNewTable);
    if (isExplicitEntityChange) {
      normalized.needs_conversation_context = false;
      const activeValues = new Set(Object.values(activeReference.stable_keys || {}).map(value => String(value)));
      if (activeValues.size > 0 && Array.isArray(normalized.filters)) {
        normalized.filters = normalized.filters.filter(filter => !activeValues.has(String(filter?.value)));
      }
    }
    if (normalized.data_sources.includes("external_api")) {
      const available = new Set(this._get_available_external_api_sources());
      if (normalized.api_sources.length === 1 && !available.has(normalized.api_sources[0])) throw new Error("Question planner selected unavailable external API source.");
    }

    // Conversation-qualified plans must be completed before the generic
    // schema-anchor fallback.  Otherwise a follow-up such as "that meeting"
    // can be anchored to an unrelated table that happens to share a token and
    // never receives the established source-qualified entity filter.
    const crossSourceCompleted = this._complete_verified_cross_source_followup(normalized, question, conversationContext);
    const activeCompleted = this._complete_active_context_plan(crossSourceCompleted, question, conversationContext);
    const recordSetCompleted = this._apply_active_record_set_context(activeCompleted, question, conversationContext);
    const completed = this._complete_schema_anchor_plan(recordSetCompleted, question);

    completed.relationships = this._normalize_relationships(
      completed.relationships ?? []
    );

    completed.filters = this._normalize_filters(
      completed.filters ?? []
    );
    completed.filters = this._complete_filter_references(completed);
    this._preserve_explicit_identity_filters(completed, question);
    completed.filters = this._normalize_verified_status_filters(
      completed.filters,
      completed.postgresql_sources ?? [],
      completed.required_tables ?? []
    );
    completed.filters = this._remove_temporal_text_filters(completed.filters, question);
    const active = this._conversation_reference(conversationContext);
    if (active && completed.needs_conversation_context !== false && Array.isArray(completed.required_tables)) {
      const sourceId = active.source_id;
      const contexts = this.contexts || {};
      const sourceContext = contexts[sourceId] || {};
      const references = Object.entries(active).filter(([key, value]) => /(?:^|_)id$/.test(key) && value !== null && value !== undefined);
      for (const [column, value] of references) {
          const applies = completed.required_tables.some(table => (sourceContext.tables?.[table]?.columns || []).some(col => String(col?.name || col).toLowerCase() === column.toLowerCase()));
        if (applies && !completed.filters.some(filter => String(filter.field || filter.column || "").toLowerCase() === column.toLowerCase())) {
          const table = completed.required_tables.find(candidate => (sourceContext.tables?.[candidate]?.columns || []).some(col => String(col?.name || col).toLowerCase() === column.toLowerCase()));
          if (String(table || "").toLowerCase() !== String(active.table || "").toLowerCase() && String(column).toLowerCase() === "id") continue;
          completed.filters.push({ table, column, operator: "=", value });
        }
      }
    }
    this._apply_active_relationship_context(completed, conversationContext, question);
    this._apply_active_context_to_execution_plan(completed, conversationContext);
    const statusSafePlan = this._ensure_verified_status_filter(completed, question);
    if (statusSafePlan !== completed) {
      for (const key of Object.keys(completed)) {
        if (!(key in statusSafePlan)) delete completed[key];
      }
      Object.assign(completed, statusSafePlan);
    }

    completed.operations = this._normalize_operations(
      completed.operations ?? []
    );

    completed.requested_metrics = this._normalize_requested_metrics(
      completed.requested_metrics ?? []
    );

    this._normalize_obvious_metric_intent(completed, question);

    completed.grouping = this._normalize_string_list(
      completed.grouping ?? []
    );

    completed.sorting = this._normalize_sorting(
      completed.sorting ?? []
    );

    completed.sorting = this._resolve_sorting_fields(
      completed.sorting,
      completed.required_tables ?? [],
      completed.postgresql_sources ?? []
    );

    this._normalize_record_ranking_intent(completed, question);

    completed.sorting = this._resolve_sorting_fields(
      completed.sorting,
      completed.required_tables ?? [],
      completed.postgresql_sources ?? []
    );

    completed.entities = this._normalize_entities(
      completed.entities ?? []
    );

    if (!Array.isArray(completed.identity_constraints)) completed.identity_constraints = [];
    const explicitIdentityValue = extractEntitySearchText(question);
    if (explicitIdentityValue && /^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(String(explicitIdentityValue).trim()) &&
      !completed.identity_constraints.some(item => String(item?.value || "").toLowerCase() === String(explicitIdentityValue).trim().toLowerCase())) {
      completed.identity_constraints.push({ kind: "email", value: String(explicitIdentityValue).trim() });
    }

    completed.needs_conversation_context = Boolean(
      completed.needs_conversation_context ?? false
    );

    // A stable, provider-independent intent contract for downstream stages.
    // Keep the legacy top-level fields for compatibility, but give validators,
    // tracing, and tests one canonical representation of what was understood.
    completed.intent = this._build_intent_contract(completed, question, conversationContext);

    let confidence = completed.confidence;
    try {
      confidence = Number(confidence);
      if (Number.isNaN(confidence)) confidence = 0.0;
    } catch {
      confidence = 0.0;
    }

    completed.confidence = Math.max(0.0, Math.min(1.0, confidence));

    if (completed.data_sources.includes("security_logs")) {
      completed.security_resource = this._normalize_security_resource(
        completed.security_resource
      );
    } else {
      completed.security_resource = null;
    }

    const executionPlan = completed.execution_plan;
    if (executionPlan !== null && executionPlan !== undefined) {
      completed.execution_plan = this._normalize_execution_plan(
        executionPlan
      );
    }

    return completed;
  }

  _normalize_obvious_metric_intent(plan, question) {
    if (!plan || typeof plan !== "object" || !Array.isArray(plan.required_tables) || plan.required_tables.length !== 1) return;
    if (Array.isArray(plan.requested_metrics) && plan.requested_metrics.length > 0) return;

    const text = String(question || "").toLowerCase();
    const metricMatch = text.match(/\b(?:total|sum|amount|value|cost|budget|price|revenue|spend)\b[\s\s\S]{0,80}\b(amount|value|cost|budget|price|revenue|spend)\b/i);
    if (!metricMatch || this._is_count_question(question, [{ table: plan.required_tables[0] }])) return;

    const table = plan.required_tables[0];
    const sourceId = String(plan.postgresql_sources?.[0] || "").toLowerCase();
    const columns = this.contexts?.[sourceId]?.tables?.[table]?.columns || [];
    const metricWord = String(metricMatch[1]).toLowerCase();
    const numericTypes = new Set(["integer", "bigint", "smallint", "numeric", "decimal", "real", "double precision", "money"]);
    const candidates = columns.map(column => {
      const name = String(column?.name || column || "");
      const type = String(column?.type || column?.data_type || "").toLowerCase();
      const normalizedName = name.toLowerCase().replace(/_/g, " ");
      const score = numericTypes.has(type) && normalizedName.includes(metricWord) ? 2 : (numericTypes.has(type) && metricWord === "amount" && /total|amount|value|cost|price/.test(normalizedName) ? 1 : 0);
      return { name, score };
    }).filter(candidate => candidate.score > 0).sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
    if (candidates.length === 0 || (candidates[1] && candidates[1].score === candidates[0].score)) return;

    const column = candidates[0].name;
    plan.operations = [...new Set([...(plan.operations || []).filter(operation => operation !== "count"), "sum"])];
    plan.requested_metrics = [{ operation: "sum", table, column, source_id: sourceId, label: `total_${metricWord}`, distinct: false }];
    plan.required_columns = [...new Set([...(plan.required_columns || []), `${table}.${column}`])];

    const candidate = { source_id: sourceId, table, columns: columns.map(item => String(item?.name || item || "")), entity_type: null, matched_aliases: [table] };
    if (!this._has_unverified_status_intent(candidate, question)) {
      plan.filters = (plan.filters || []).filter(filter => !this._is_status_filter(filter, plan));
    }
  }

  _normalize_record_ranking_intent(plan, question) {
    if (!plan || typeof plan !== "object") return;

    const text = String(question || "").toLowerCase();
    const direction = /\b(?:lowest|smallest|cheapest|least)\b/i.test(text)
      ? "asc"
      : /\b(?:highest|largest|most expensive|greatest)\b/i.test(text)
      ? "desc"
      : null;
    if (!direction || !Array.isArray(plan.required_tables) || plan.required_tables.length !== 1) return;

    // A scalar metric question must remain an aggregate.  Record wording such
    // as "which one" or a detail/list request means the user wants the row.
    const scalarAggregate = /\b(?:what|tell|give)\b[\s\S]{0,40}\b(?:maximum|max|minimum|min|highest|lowest|largest|smallest|cheapest|most expensive)\b[\s\S]{0,60}\b(?:amount|value|total|cost|price|revenue|spend)\b/i.test(text);
    const recordRequest = /\bwhich\s+(?:one|invoice|record|item)\b/i.test(text) ||
      /\b(?:show|list|display|details?|information)\b/i.test(text) ||
      /\b(?:invoice|record|item)\b/i.test(text);
    if (scalarAggregate || !recordRequest) return;

    const table = String(plan.required_tables[0] || "").trim();
    const metrics = Array.isArray(plan.requested_metrics) ? plan.requested_metrics : [];
    const rankingMetric = metrics.find(metric => {
      const operation = String(metric?.operation || "").trim().toLowerCase();
      return ["maximum", "max", "minimum", "min"].includes(operation) &&
        typeof metric?.column === "string" && metric.column.trim();
    });

    let field = rankingMetric
      ? `${rankingMetric.table || table}.${rankingMetric.column}`
      : null;

    if (!field && Array.isArray(plan.sorting) && plan.sorting.length > 0) {
      const first = plan.sorting[0];
      field = typeof first === "string" ? first.replace(/\s+(?:asc|desc)$/i, "").trim() : first?.field || first?.column;
    }

    if (!field) {
      const candidates = (plan.required_columns || [])
        .filter(value => typeof value === "string" && value.includes("."))
        .filter(value => value.split(".")[0].trim().toLowerCase() === table.toLowerCase())
        .filter(value => /(?:total|amount|value|cost|price|revenue|spend)/i.test(value.split(".").slice(1).join(".")));
      if (candidates.length === 1) field = candidates[0];
    }

    if (!field) return;

    plan.operations = ["ranking"];
    plan.requested_metrics = [];
    plan.grouping = [];
    plan.sorting = [{ field: String(field).trim(), direction }];
    plan.limit = 1;
  }

  _build_intent_contract(plan, question, conversationContext = null) {
    const active = this._conversation_reference(conversationContext);
    const filters = Array.isArray(plan.filters) ? deepcopy(plan.filters) : [];
    const explicitEntities = Array.isArray(plan.entities) ? deepcopy(plan.entities) : [];
    return {
      version: 1,
      question: String(question || ""),
      entities: explicitEntities,
      entity_target: plan.entity_target ? deepcopy(plan.entity_target) : null,
      operations: Array.isArray(plan.operations) ? [...plan.operations] : [],
      mandatory_filters: filters.filter(filter => filter && filter.mandatory !== false),
      time_constraints: filters.filter(filter => filter && /(?:created|updated|date|time|at|before|after|since|until)/i.test(String(filter.field || filter.column || ""))),
      sorting: Array.isArray(plan.sorting) ? deepcopy(plan.sorting) : [],
      limit: plan.limit ?? null,
      required_relationships: Array.isArray(plan.relationships) ? deepcopy(plan.relationships) : [],
      requested_fields: Array.isArray(plan.required_columns) ? [...plan.required_columns] : [],
      identity_constraints: Array.isArray(plan.identity_constraints) ? deepcopy(plan.identity_constraints) : [],
      conversation_reference: plan.needs_conversation_context ? (active ? deepcopy(active) : null) : null,
      unresolved_ambiguities: Array.isArray(plan.ambiguous_context_candidates) ? deepcopy(plan.ambiguous_context_candidates) : [],
      source_ids: Array.isArray(plan.postgresql_sources) ? [...plan.postgresql_sources] : []
    };
  }

  _ensure_verified_status_filter(plan, question) {
    if (!plan || typeof plan !== "object") return plan;
    const statusCandidate = { columns: [] };
    for (const table of Array.isArray(plan.required_tables) ? plan.required_tables : []) {
      for (const context of Object.values(this.contexts || {})) {
        statusCandidate.columns.push(...(context?.tables?.[table]?.columns || []).map(column => String(column?.name || column || "")));
      }
    }
    const countIntent = this._is_count_question(
      question,
      (Array.isArray(plan.required_tables) ? plan.required_tables : []).map(table => ({
        table,
        entity_type: this.contexts?.[plan.postgresql_sources?.[0]]?.semantic_catalog?.entities?.[table]?.entity_type,
        matched_aliases: [table]
      }))
    );
    const derivedStatusFilters = [];
    for (const sourceId of Array.isArray(plan.postgresql_sources) ? plan.postgresql_sources : []) {
      for (const table of Array.isArray(plan.required_tables) ? plan.required_tables : []) {
        const columns = (this.contexts?.[sourceId]?.tables?.[table]?.columns || [])
          .map(column => String(column?.name || column || "")).filter(Boolean);
        const entity = this.contexts?.[sourceId]?.semantic_catalog?.entities?.[table] || {};
        const candidate = {
          source_id: sourceId,
          table,
          columns,
          entity_type: entity.entity_type,
          matched_aliases: [table, ...(Array.isArray(entity.synonyms) ? entity.synonyms : [])]
        };
        const verified = this._verified_status_filter(candidate, question) ||
          (countIntent || this._has_unverified_status_intent(candidate, question) ? this._discovered_categorical_filter(candidate, question) : null);
        if (verified) derivedStatusFilters.push(verified);
      }
    }
    const statusIntent = this._has_unverified_status_intent(statusCandidate, question) || derivedStatusFilters.length > 0;
    if (!statusIntent) {
      const filters = Array.isArray(plan.filters) ? plan.filters : [];
      const userFilters = filters.filter(filter => !this._is_status_filter(filter, plan));
      const providerStatusClarification = plan.clarification_required?.type === "business_status_semantics";
      if (userFilters.length === filters.length && !providerStatusClarification) return plan;
      const sanitized = { ...plan, filters: userFilters };
      if (providerStatusClarification) delete sanitized.clarification_required;
      return sanitized;
    }

    let updated = plan;
    for (const sourceId of Array.isArray(plan.postgresql_sources) ? plan.postgresql_sources : []) {
      for (const table of Array.isArray(plan.required_tables) ? plan.required_tables : []) {
        const tableInfo = this.contexts?.[sourceId]?.tables?.[table] || {};
        const columns = (tableInfo.columns || []).map(column => String(column?.name || column || "")).filter(Boolean);
        const entity = this.contexts?.[sourceId]?.semantic_catalog?.entities?.[table] || {};
        const candidate = {
          source_id: sourceId,
          table,
          columns,
          entity_type: entity.entity_type,
          matched_aliases: [table, ...(Array.isArray(entity.synonyms) ? entity.synonyms : [])]
        };
        const verified = this._verified_status_filter(candidate, question) ||
          (countIntent || this._has_unverified_status_intent(candidate, question) ? this._discovered_categorical_filter(candidate, question) : null);
        const statusColumn = this.contexts?.[sourceId]?.semantic_catalog?.entities?.[table]?.status_semantics?.column || verified?.field;
        const hasStatusFilter = statusColumn && (updated.filters || []).some(filter => {
          const field = String(filter?.field || filter?.column || filter?.column_name || "").split(".").at(-1);
          return field.toLowerCase() === String(statusColumn).toLowerCase() && String(filter?.table || table).split(".").at(-1).toLowerCase() === table.toLowerCase();
        });
        if (verified && !hasStatusFilter) {
          updated.filters = [...(updated.filters || []), verified];
        } else if (verified && hasStatusFilter && verified.verification === "runtime_distinct_required") {
          updated.filters = (updated.filters || []).map(filter => {
            const field = String(filter?.field || filter?.column || filter?.column_name || "").split(".").at(-1);
            return field.toLowerCase() === String(verified.field).toLowerCase() && String(filter?.table || table).split(".").at(-1).toLowerCase() === table.toLowerCase()
              ? { ...filter, operator: "case_insensitive_equals", verification: verified.verification, provenance: verified.provenance }
              : filter;
          });
        } else if (statusIntent && !verified && !hasStatusFilter && columns.some(column => isStatusColumnName(column))) {
          return { ...updated, clarification_required: { type: "business_status_semantics", message: "I could not verify the requested status meaning, so I did not run an unfiltered retrieval." } };
        }
      }
    }
    return updated;
  }

  _is_status_filter(filter, plan) {
    if (!filter || typeof filter !== "object" || Array.isArray(filter)) return false;
    const parts = String(filter.field || filter.column || filter.column_name || "").split(".");
    const table = String(filter.table || (parts.length === 2 ? parts[0] : "")).trim().toLowerCase();
    const column = String(parts.at(-1) || "").trim().toLowerCase();
    if (!column) return false;
    if (/^(status|state|workflow_state|lifecycle_state)$/.test(column)) return true;
    return (Array.isArray(plan.postgresql_sources) ? plan.postgresql_sources : []).some(sourceId => {
      const semantics = this.contexts?.[sourceId]?.semantic_catalog?.entities?.[table]?.status_semantics;
      return semantics?.validation_status === "validated" &&
        String(semantics.column || "").trim().toLowerCase() === column;
    });
  }

  _normalize_verified_status_filters(filters, sourceIds = [], requiredTables = []) {
    if (!Array.isArray(filters)) return [];

    const allowedSources = new Set((Array.isArray(sourceIds) ? sourceIds : [])
      .map(sourceId => String(sourceId || "").trim().toLowerCase())
      .filter(Boolean));

    return filters.map(filter => {
      if (!filter || typeof filter !== "object" || Array.isArray(filter)) return filter;
      if (filter.quoted === true || filter.literal === true) return filter;

      const operator = String(filter.operator || filter.op || "=").trim().toLowerCase();
      if (operator !== "=") return filter;

      const reference = String(filter.field || filter.column || filter.column_name || "").trim();
      const parts = reference.split(".");
      const table = String(filter.table || (parts.length === 2 ? parts[0] : "")).trim();
      const column = String(parts.length === 2 ? parts[1] : reference).trim();
      if (!table || !column || (requiredTables.length > 0 && !requiredTables.includes(table))) return filter;

      const sourceCandidates = allowedSources.size > 0 ? [...allowedSources] : Object.keys(this.contexts || {});
      const isVerifiedStatusValue = sourceCandidates.some(sourceId => {
        const entity = this.contexts?.[sourceId]?.semantic_catalog?.entities?.[table];
        const semantics = entity?.status_semantics;
        if (!semantics || semantics.validation_status !== "validated" || !Array.isArray(semantics.provenance) || semantics.provenance.length === 0) return false;
        if (String(semantics.column || "").trim().toLowerCase() !== column.toLowerCase()) return false;
        return Object.values(semantics.mappings || {}).some(value =>
          normalizedSemanticPhrase(value) === normalizedSemanticPhrase(filter.value)
        );
      });

      return isVerifiedStatusValue
        ? { ...filter, operator: "case_insensitive_equals" }
        : filter;
    });
  }

  _complete_active_context_plan(plan, question, conversationContext) {
    const active = this._conversation_reference(conversationContext);
    const refersBack = /\b(?:it|its|that|this|those|these|details?)\b/i.test(question);
    if (!active || !refersBack || (plan.required_tables || []).length || plan.execution_plan) return plan;
    const sourceId = String(active.source_id || "").trim().toLowerCase();
    const table = String(active.table || "").trim();
    const tableInfo = this.contexts?.[sourceId]?.tables?.[table];
    if (!sourceId || !table || !tableInfo) return plan;
    const stableKeys = active.stable_keys && typeof active.stable_keys === "object"
      ? active.stable_keys
      : Object.fromEntries(Object.entries(active).filter(([column, value]) => /(?:^|_)id$/.test(column) && value !== null && value !== undefined));
    if (!Object.keys(stableKeys).length) return plan;
    const safeColumns = (tableInfo.columns || []).map(column => String(column?.name || column || "")).filter(column => column && !isSensitiveFieldName(column)).slice(0, 20);
    if (!safeColumns.length) return plan;
    return { ...plan, data_sources: ["postgresql"], postgresql_sources: [sourceId], required_tables: [table], required_columns: safeColumns.map(column => `${table}.${column}`), filters: Object.entries(stableKeys).map(([column, value]) => ({ table, field: column, operator: "=", value })), operations: ["lookup"], needs_conversation_context: true, confidence: Math.max(Number(plan.confidence || 0), 0.8), reasoning: "A uniquely established conversation entity was used for a bounded, source-qualified detail lookup." };
  }

  _apply_active_record_set_context(plan, question, conversationContext) {
    const active = this._conversation_reference(conversationContext);
    const recordSet = active?.record_set;
    if (!active || !recordSet || !this._is_record_set_reference(question, active)) return plan;

    const sourceId = String(active.source_id || "").trim().toLowerCase();
    const table = String(active.table || "").trim();
    const keyColumn = String(recordSet.key_column || "").trim();
    const values = Array.isArray(recordSet.values)
      ? [...new Set(recordSet.values.filter(value => value !== null && value !== undefined).map(String))]
      : [];
    const tableInfo = this.contexts?.[sourceId]?.tables?.[table];
    const discoveredColumns = new Set((tableInfo?.columns || []).map(column => String(column?.name || column).toLowerCase()));
    const questionText = String(question || "");
    const mentionsEntityPhrase = phrase => {
      const words = String(phrase || "").replace(/_/g, " ").trim().split(/\s+/).filter(Boolean);
      return words.length > 0 && words.every(word => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}(?:s)?\\b`, "i").test(questionText));
    };
    const hasExplicitTarget = findSemanticCandidates(question, this.contexts, [sourceId]).some(candidate => {
      if (String(candidate?.table || "").toLowerCase() === table.toLowerCase()) return false;
      const aliases = [candidate.table, candidate.entity_type, ...(candidate.matched_aliases || [])];
      return aliases.some(mentionsEntityPhrase);
    });
    const asksAcrossSources = /\b(?:both|combine|across|sources?)\b/i.test(questionText);
    if (hasExplicitTarget || asksAcrossSources) {
      // A relationship follow-up may name the target explicitly ("which
      // company") while still depending on the bounded prior record set.
      // Preserve the final dependency endpoint as the new conversation
      // target; do not leave the parent user table as the active referent.
      if (hasExplicitTarget && plan.execution_plan && !asksAcrossSources) {
        const finalStep = Array.isArray(plan.execution_plan.steps)
          ? plan.execution_plan.steps.find(step => step.id === plan.execution_plan.final_step) || plan.execution_plan.steps.at(-1)
          : null;
        const finalTable = finalStep?.contract?.required_tables?.[0];
        if (finalTable && String(finalTable).toLowerCase() !== table.toLowerCase()) {
          plan.needs_conversation_context = true;
          plan.entity_target = { source_id: sourceId, table: finalTable };
        }
      }
      return plan;
    }

    // A plural conversational reference is executable only when its
    // source-qualified key and bounded values still match the active schema.
    // Otherwise fail closed rather than allowing the provider's broad plan to
    // become an unfiltered retrieval.
    if (!sourceId || !table || !keyColumn || !values.length || !tableInfo || !discoveredColumns.has(keyColumn.toLowerCase())) {
      return {
        ...plan,
        clarification_required: {
          type: "missing_context_binding",
          message: "I could not verify the referenced records, so I did not run an unfiltered retrieval."
        }
      };
    }

    const executionPlan = plan.execution_plan;
    if (executionPlan) {
      plan.needs_conversation_context = true;
      const finalStep = Array.isArray(executionPlan.steps)
        ? executionPlan.steps.find(step => step.id === executionPlan.final_step) || executionPlan.steps.at(-1)
        : null;
      const finalTable = finalStep?.contract?.required_tables?.[0];
      if (finalTable) plan.entity_target = { source_id: sourceId, table: finalTable };
      return plan;
    }

    const requiredTables = Array.isArray(plan.required_tables) ? [...plan.required_tables] : [];
    const targetsActiveTable = requiredTables.some(candidate => String(candidate).toLowerCase() === table.toLowerCase());
    if (!targetsActiveTable) return plan;

    plan.filters = Array.isArray(plan.filters) ? plan.filters : [];
    const existing = plan.filters.find(filter =>
      String(filter?.table || "").toLowerCase() === table.toLowerCase() &&
      String(filter?.field || filter?.column || "").split(".").at(-1).toLowerCase() === keyColumn.toLowerCase()
    );
    const sameValues = existing && Array.isArray(existing.value)
      ? existing.value.map(String).sort().join("\u0000") === values.slice().sort().join("\u0000")
      : false;

    if (existing && !sameValues) {
      plan.clarification_required = {
        type: "conflicting_context_binding",
        message: "I found a conflicting record reference in the conversation, so I did not broaden the retrieval."
      };
      return plan;
    }

    if (!existing) {
      plan.filters.push({ table, field: keyColumn, operator: "in", value: values });
    }
    plan.data_sources = ["postgresql"];
    plan.postgresql_sources = [sourceId];
    plan.needs_conversation_context = true;
    plan.entity_target = { ...(plan.entity_target || {}), source_id: sourceId, table };
    return plan;
  }

  _complete_verified_cross_source_followup(plan, question, conversationContext) {
    const active = this._conversation_reference(conversationContext);
    const refersBack = /\b(?:it|its|that|this|those|these|related)\b/i.test(question);
    if (!active || !refersBack) return plan;

    const sourceId = String(active.source_id || "").trim().toLowerCase();
    const activeTable = String(active.table || "").trim();
    const stableKeys = active.stable_keys && typeof active.stable_keys === "object"
      ? active.stable_keys
      : Object.fromEntries(Object.entries(active).filter(([column, value]) => /(?:^|_)id$/.test(column) && value !== null && value !== undefined));
    const recordSet = active.record_set && typeof active.record_set === "object" ? active.record_set : null;
    const recordSetValues = Array.isArray(recordSet?.values)
      ? [...new Set(recordSet.values.filter(value => value !== null && value !== undefined).map(String))]
      : [];
    const activeTableInfo = this.contexts?.[sourceId]?.tables?.[activeTable] || null;
    const activeIdentityFilter = this._active_record_set_identity_filter(question, active, activeTableInfo);
    if (activeIdentityFilter?.unsupported) {
      return {
        ...plan,
        clarification_required: {
          type: "unsupported_identity_qualifier",
          message: "I could not verify that identity qualifier for the referenced records, so I did not broaden the retrieval."
        }
      };
    }
    const recordSetMode = this._record_set_reference_mode(question, active);
    const sourceMentionPattern = Object.keys(this.contexts || {}).map(source => source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).filter(Boolean).join("|");
    const explicitMultiSource = /\b(?:both|combine|across|sources?)\b/i.test(question) || (sourceMentionPattern ? new RegExp(`\\b(?:${sourceMentionPattern})\\b`, "i").test(question) : false);
    const hasDirectSameSourceTarget = findSemanticCandidates(question, this.contexts, [sourceId]).some(candidate =>
      candidate.table !== activeTable && (this.contexts?.[sourceId]?.relationships || []).some(rel =>
        (rel.source_table === activeTable && rel.target_table === candidate.table) ||
        (rel.target_table === activeTable && rel.source_table === candidate.table)
      )
    );
    const sourceCandidates = findSemanticCandidates(question, this.contexts, [sourceId]);
    const strongestRequestedCandidate = sourceCandidates
      .filter(candidate => Array.isArray(candidate.matched_aliases) && candidate.matched_aliases.length > 0)
      .sort((left, right) => right.score - left.score)[0];
    const requestedNonActiveCandidates = sourceCandidates.filter(candidate =>
      candidate.table !== activeTable &&
      Array.isArray(candidate.matched_aliases) &&
      candidate.matched_aliases.length > 0
    );
    const vagueRelationshipRole = /\b(?:associated|related|linked|with)\b/i.test(question) &&
      !/\b(?:belongs?|owns?|created|assigned|member|managed|reported|stakeholder|client|consultant)\b/i.test(question);
    if (vagueRelationshipRole) {
      const candidateTables = new Set(requestedNonActiveCandidates.map(candidate => String(candidate.table)));
      const roleEdges = (this.contexts?.[sourceId]?.relationships || []).filter(relationship => {
        const sourceTable = String(relationship?.source_table || "");
        const targetTable = String(relationship?.target_table || "");
        return (sourceTable === activeTable && candidateTables.has(targetTable)) ||
          (targetTable === activeTable && candidateTables.has(sourceTable));
      });
      const edgeSignatures = new Set(roleEdges.map(relationship => `${relationship.source_table}.${relationship.source_column}->${relationship.target_table}.${relationship.target_column}`));
      if (edgeSignatures.size > 1) {
        return {
          ...plan,
          clarification_required: {
            type: "relationship_role_ambiguous",
            message: "I found multiple verified relationship roles for that request. Please specify whether you mean ownership, creation, assignment, membership, or another role."
          }
        };
      }
    }
    // Prefer the shortest verified same-source relationship unless the user
    // explicitly asks to combine sources. If provider/fallback candidate
    // selection chose another entity, repair only the target table and bind
    // it to the active record's verified relationship key. This preserves the
    // user's relationship request without broadening retrieval.
    if (!explicitMultiSource && hasDirectSameSourceTarget) {
      const directTarget = findSemanticCandidates(question, this.contexts, [sourceId])
        .filter(candidate => candidate.table !== activeTable && (this.contexts?.[sourceId]?.relationships || []).some(rel =>
          (rel.source_table === activeTable && rel.target_table === candidate.table) ||
          (rel.target_table === activeTable && rel.source_table === candidate.table)
        ))
        .sort((left, right) => right.score - left.score)[0];
      // When the question names exactly one non-anchor entity, that entity is
      // the requested endpoint even if the anchor noun receives the same
      // lexical score (for example, "users belonging to that company").
      // Keep the normal score-based choice only when several non-anchor
      // candidates remain genuinely viable.
      const directTargetWasRequested = directTarget && (
        (requestedNonActiveCandidates.length === 1 &&
          String(requestedNonActiveCandidates[0].table).toLowerCase() === String(directTarget.table).toLowerCase()) ||
        (requestedNonActiveCandidates.length !== 1 && strongestRequestedCandidate &&
          String(strongestRequestedCandidate.table).toLowerCase() === String(directTarget.table).toLowerCase())
      );
      const directTargetIsDefaultProjectTarget = !strongestRequestedCandidate || strongestRequestedCandidate.entity_type === "project";
      if (!directTargetWasRequested && !directTargetIsDefaultProjectTarget) {
        // A different explicit target (for example company) must continue
        // through its approved relationship path rather than stopping at the
        // nearest same-source project table.
      } else if (directTarget) {
      const alreadyTargetsDirectEntity = (plan.required_tables || []).length === 1 &&
        String(plan.required_tables[0]).toLowerCase() === String(directTarget.table).toLowerCase() &&
        (plan.postgresql_sources || []).length === 1 && String(plan.postgresql_sources[0]).toLowerCase() === sourceId;
      if (alreadyTargetsDirectEntity) return plan;
        const relationship = (this.contexts?.[sourceId]?.relationships || []).find(rel => {
          const connects = (rel.source_table === activeTable && rel.target_table === directTarget.table) ||
            (rel.target_table === activeTable && rel.source_table === directTarget.table);
          if (!connects) return false;
          const activeColumn = rel.source_table === activeTable ? rel.source_column : rel.target_column;
          return stableKeys[activeColumn] !== undefined && stableKeys[activeColumn] !== null;
        });
        const activeColumn = relationship?.source_table === activeTable ? relationship.source_column : relationship?.target_column;
        const targetColumn = relationship?.source_table === activeTable ? relationship.target_column : relationship?.source_column;
        const boundValue = activeColumn ? stableKeys[activeColumn] : undefined;
        if (relationship && boundValue !== undefined && boundValue !== null) {
          const targetInfo = this.contexts[sourceId]?.tables?.[directTarget.table] || {};
          const safeColumns = (targetInfo.columns || []).map(column => String(column?.name || column || ""))
            .filter(column => column && !isSensitiveFieldName(column)).slice(0, 20);
          const { execution_plan: _executionPlan, clarification_required: _clarification, ...basePlan } = plan;
          return {
            ...basePlan,
            data_sources: ["postgresql"],
            postgresql_sources: [sourceId],
            required_tables: [directTarget.table],
            required_columns: safeColumns.map(column => `${directTarget.table}.${column}`),
            relationships: [relationship],
            filters: [{ table: directTarget.table, field: targetColumn, operator: "=", value: boundValue }],
            operations: ["lookup"],
            entity_target: { source_id: sourceId, table: directTarget.table },
            needs_conversation_context: true,
            ambiguous_context_candidates: []
          };
        }
      }
    }
    const paths = findVerifiedPaths(question, this.contexts, null, { active });
    const requestedCandidates = findSemanticCandidates(question, this.contexts)
      .filter(candidate => Array.isArray(candidate.matched_aliases) && candidate.matched_aliases.length > 0)
      .sort((left, right) => {
        const lastMention = candidate => Math.max(...candidate.matched_aliases.map(alias => String(question).toLowerCase().lastIndexOf(String(alias).toLowerCase())));
        return lastMention(right) - lastMention(left) || right.score - left.score;
      });
    const requestedTables = new Set(requestedCandidates.map(candidate => String(candidate.table).toLowerCase()));
    const pathCandidates = paths.filter(candidate =>
      candidate.steps[0]?.source_id === sourceId &&
      candidate.steps[0]?.table === activeTable &&
      (!requestedTables.size || requestedTables.has(String(candidate.steps.at(-1)?.table || "").toLowerCase()))
    );
    const path = [...(pathCandidates.length ? pathCandidates : paths.filter(candidate => candidate.steps[0]?.source_id === sourceId && candidate.steps[0]?.table === activeTable))]
      .sort((left, right) => {
        const forwardEdge = candidate => (candidate.evidence_relationships || []).some(edge =>
          String(edge).toLowerCase().startsWith(`${sourceId}.${activeTable.toLowerCase()}.`)
        ) ? 1 : 0;
        const leftSameSource = left.steps.at(-1)?.source_id === sourceId ? 1 : 0;
        const rightSameSource = right.steps.at(-1)?.source_id === sourceId ? 1 : 0;
        return forwardEdge(right) - forwardEdge(left) || rightSameSource - leftSameSource || left.steps.length - right.steps.length;
      })[0];
    if (!path || (!Object.keys(stableKeys).length && !recordSetValues.length)) return plan;

    const distinctSources = new Set(path.steps.map(step => step.source_id));
    if (distinctSources.size < 2 && !recordSetValues.length) return plan;
    const first = path.steps[0];
    const activeColumns = (this.contexts[sourceId]?.tables?.[activeTable]?.columns || [])
      .map(item => String(item?.name || item));
    const stableColumn = Object.keys(stableKeys).find(column => activeColumns.includes(column));
    const bindingColumn = stableColumn || (recordSetValues.length && activeColumns.includes(String(recordSet.key_column || "")) ? String(recordSet.key_column) : null);
    if (!bindingColumn) return plan;
    const bindingValue = stableColumn ? stableKeys[stableColumn] : recordSetValues;
    const bindingOperator = Array.isArray(bindingValue) ? "in" : "=";
    const semanticPath = path.steps.map((node, index) => index === 0
      ? { ...node, column: bindingColumn }
      : { ...node });
    const bindings = path.steps.slice(1).map((node, index) => this._path_binding(path.steps[index], node, path.evidence_relationships));
    if (bindings.some(binding => !binding)) {
      return {
        ...plan,
        clarification_required: {
          type: "relationship_path_unavailable",
          message: "I could not verify an executable relationship path for that follow-up request. Please identify the record more specifically."
        }
      };
    }
    const base = (source, table, columns, filters = [], limit = 50) => ({
      question,
      data_sources: ["postgresql"],
      postgresql_sources: [source],
      required_tables: [table],
      required_columns: columns,
      relationships: [], filters, operations: ["lookup"], requested_metrics: [], grouping: [], sorting: [], limit,
      entities: [], confidence: 0.9
    });
    const steps = path.steps.map((node, index) => {
      const tableInfo = this.contexts[node.source_id]?.tables?.[node.table] || {};
      const safeColumns = (tableInfo.columns || []).map(column => String(column?.name || column || "")).filter(column => column && !isSensitiveFieldName(column)).slice(0, 20);
      const incomingBinding = index === 0 ? null : bindings[index - 1];
      const outgoingBinding = index === path.steps.length - 1 ? null : bindings[index];
      const outputColumns = Array.from(new Set([
        node.column,
        incomingBinding?.to_column,
        outgoingBinding?.from_column,
        ...(tableInfo.primary_keys || []),
        ...safeColumns
      ])).filter(Boolean);
       const filters = index === 0
         ? [
           { table: node.table, field: bindingColumn, operator: bindingOperator, value: bindingValue },
           ...(activeIdentityFilter && String(node.table).toLowerCase() === activeTable.toLowerCase()
             ? [activeIdentityFilter]
             : [])
         ]
         : [];
      return {
        id: `s${index + 1}`,
        type: index === path.steps.length - 1 ? "final_query" : "source_query",
        source_id: node.source_id,
        contract: base(node.source_id, node.table, outputColumns.map(column => `${node.table}.${column}`), filters),
        depends_on: index === 0 ? [] : [`s${index}`],
        inputs: [],
        input_bindings: index === 0 ? [] : [{ from_step: `s${index}`, from_column: incomingBinding.from_column, to_table: node.table, to_column: incomingBinding.to_column, operator: "in" }],
        output_columns: outputColumns,
        purpose: `Retrieve the verified relationship-graph step for ${node.source_id}.${node.table}.`
      };
    });
    return {
      ...plan,
      data_sources: ["postgresql"],
      postgresql_sources: [...distinctSources].sort(),
      required_tables: [], required_columns: [], relationships: [], filters: [], operations: ["lookup"],
      execution_plan: { mode: "multi_step", steps, final_step: `s${steps.length}` },
      semantic_path: semanticPath,
      semantic_path_evidence: Array.isArray(path.evidence_relationships) ? [...path.evidence_relationships] : [],
      ambiguous_context_candidates: [],
      needs_conversation_context: true,
      followup_identity_scope: recordSetValues.length
        ? (recordSetMode === "singular" ? "singular_record_set" : "plural_record_set")
        : "single_identity",
      followup_record_count: recordSetValues.length || 1,
      confidence: 0.9,
      reasoning: "A verified authorized cross-source relationship path was selected from a uniquely established conversation entity."
    };
  }

  // Resolve every runtime binding from an actual FK or validated cross-source
  // evidence record.  A path node column is an entry point, not necessarily
  // the value that must be passed to the next table (for example a bridge
  // table may receive one key and emit another).
  _path_binding(previous, current, evidenceRelationships = []) {
    if (!previous || !current) return null;
    const previousSource = String(previous.source_id || "").toLowerCase();
    const currentSource = String(current.source_id || "").toLowerCase();
    if (!previousSource || !currentSource) return null;
    if (previousSource === currentSource) {
      const relationships = (this.contexts?.[previousSource]?.relationships || []).filter(item =>
        (item.source_table === previous.table && item.target_table === current.table) ||
        (item.target_table === previous.table && item.source_table === current.table)
      );
      const relationship = relationships.find(item =>
        item.source_table === previous.table && item.target_table === current.table
      ) || relationships[0];
      if (!relationship) return null;
      return relationship.source_table === previous.table
        ? { from_column: relationship.source_column, to_column: relationship.target_column }
        : { from_column: relationship.target_column, to_column: relationship.source_column };
    }
    for (const evidence of evidenceRelationships || []) {
      const [left, right] = String(evidence || "").split(" -> ");
      const parse = value => {
        const [source_id, table, column] = String(value || "").split(".");
        return { source_id: String(source_id || "").toLowerCase(), table, column };
      };
      const source = parse(left);
      const target = parse(right);
      if (source.source_id === previousSource && source.table === previous.table && target.source_id === currentSource && target.table === current.table) {
        return { from_column: source.column, to_column: target.column };
      }
      if (target.source_id === previousSource && target.table === previous.table && source.source_id === currentSource && source.table === current.table) {
        return { from_column: target.column, to_column: source.column };
      }
    }
    return null;
  }

  _apply_active_relationship_context(plan, conversationContext, question = "") {
    const active = this._conversation_reference(conversationContext);
    const sourceId = String(active?.source_id || "").trim().toLowerCase();
    const activeTable = String(active?.table || "").trim();
    const requiresContext = plan.needs_conversation_context === true || /\b(?:it|its|that|this|those|these|related)\b/i.test(question);
    if (!requiresContext || !sourceId || !activeTable || !this.contexts?.[sourceId] || !Array.isArray(plan.required_tables) || !plan.required_tables.length) return plan;
    const context = this.contexts[sourceId];
    const relationships = Array.isArray(context.relationships) ? context.relationships : [];
    const targetTables = plan.required_tables.filter(table => String(table).toLowerCase() !== activeTable.toLowerCase());
    const stableKeys = active.stable_keys && typeof active.stable_keys === "object"
      ? active.stable_keys
      : Object.fromEntries(Object.entries(active).filter(([column, value]) => /(?:^|_)id$/.test(column) && value !== null && value !== undefined));
    const directKeyBindings = [];
    for (const target of targetTables) {
      const targetColumns = new Set((context.tables?.[target]?.columns || []).map(column => String(column?.name || column).toLowerCase()));
      for (const [column, value] of Object.entries(stableKeys)) {
        if (String(column).toLowerCase() === "id" || value === null || value === undefined) continue;
        if (targetColumns.has(String(column).toLowerCase())) directKeyBindings.push({ target, column, value });
      }
    }
    if (directKeyBindings.length === 1) {
      const { target, column, value } = directKeyBindings[0];
      if (!(plan.filters || []).some(filter => String(filter.table || "").toLowerCase() === String(target).toLowerCase() && String(filter.field || filter.column || "").toLowerCase() === String(column).toLowerCase())) {
        plan.filters.push({ table: target, field: column, operator: "=", value });
      }
      plan.needs_conversation_context = true;
      return plan;
    }
    // Bind the target through the discovered relationship edge. Matching a
    // column name alone is unsafe when both records expose a generic `id`
    // (for example invoices.id and companies.id).
    const directBindings = [];
    for (const target of targetTables) {
      for (const relationship of relationships) {
        const leftTable = String(relationship?.source_table || "").toLowerCase();
        const rightTable = String(relationship?.target_table || "").toLowerCase();
        const activeName = activeTable.toLowerCase();
        const targetName = String(target).toLowerCase();
        let sourceColumn;
        let targetColumn;
        if (leftTable === activeName && rightTable === targetName) {
          sourceColumn = relationship.source_column;
          targetColumn = relationship.target_column;
        } else if (rightTable === activeName && leftTable === targetName) {
          sourceColumn = relationship.target_column;
          targetColumn = relationship.source_column;
        } else {
          continue;
        }
        if (sourceColumn && targetColumn && stableKeys[sourceColumn] !== undefined && stableKeys[sourceColumn] !== null) {
          directBindings.push({ target, sourceColumn, targetColumn, value: stableKeys[sourceColumn] });
        }
      }
    }
    if (directBindings.length === 1 && (plan.needs_conversation_context !== true || directBindings[0].sourceColumn === directBindings[0].targetColumn)) {
      const { target, targetColumn, value } = directBindings[0];
      if (!(plan.filters || []).some(filter => String(filter.table || "").toLowerCase() === String(target).toLowerCase() && String(filter.field || filter.column || "").toLowerCase() === String(targetColumn).toLowerCase())) {
        plan.filters.push({ table: target, field: targetColumn, operator: "=", value });
      }
      plan.needs_conversation_context = true;
      return plan;
    }
    const supported = relationships.filter(relationship => {
      const left = String(relationship?.source_table || "").toLowerCase();
      const right = String(relationship?.target_table || "").toLowerCase();
      return targetTables.some(target => (left === activeTable.toLowerCase() && right === String(target).toLowerCase()) || (right === activeTable.toLowerCase() && left === String(target).toLowerCase()));
    });
    if (!supported.length) return plan;
    if (!Object.keys(stableKeys).length && !Array.isArray(active.record_set?.values)) {
      plan.clarification_required = {
        type: "missing_context_binding",
        message: "I could not verify the referenced record identifier, so I did not run an unfiltered related-entity retrieval."
      };
      return plan;
    }
    // A validated direct edge is sufficient to anchor a same-source follow-up;
    // multi-hop and cross-source paths remain the dependency planner's job.
    plan.postgresql_sources = [sourceId];
    plan.needs_conversation_context = true;
    plan.required_tables = Array.from(new Set([activeTable, ...plan.required_tables]));
    plan.relationships = Array.from(new Map([...((plan.relationships || []).map(rel => [JSON.stringify(rel), rel])), ...supported.map(rel => [JSON.stringify(rel), rel])]).values());
    for (const [column, value] of Object.entries(stableKeys)) {
      const exists = (context.tables?.[activeTable]?.columns || []).some(col => String(col?.name || col).toLowerCase() === String(column).toLowerCase());
      if (exists && !(plan.filters || []).some(filter => String(filter.table || "").toLowerCase() === activeTable.toLowerCase() && String(filter.field || filter.column || "").toLowerCase() === String(column).toLowerCase())) {
        plan.filters.push({ table: activeTable, field: column, operator: "=", value });
      }
    }
    return plan;
  }

  _apply_active_context_to_execution_plan(plan, conversationContext) {
    const active = this._conversation_reference(conversationContext);
    const executionPlan = plan?.execution_plan;
    if (!active || !executionPlan || !Array.isArray(executionPlan.steps)) return plan;

    const sourceId = String(active.source_id || "").trim().toLowerCase();
    const activeTable = String(active.table || "").trim();
    const stableKeys = active.stable_keys && typeof active.stable_keys === "object" ? active.stable_keys : {};
    const recordSet = active.record_set && typeof active.record_set === "object" ? active.record_set : null;
    if (!sourceId || !activeTable || (!Object.keys(stableKeys).length && !Array.isArray(recordSet?.values))) return plan;

    const targetStep = executionPlan.steps.find(step => {
      const type = String(step?.type || "").toLowerCase();
      const tables = step?.contract?.required_tables || [];
      return ["source_query", "final_query"].includes(type) &&
        String(step?.source_id || "").toLowerCase() === sourceId &&
        tables.some(table => String(table).toLowerCase() === activeTable.toLowerCase());
    });
    if (!targetStep?.contract || !Array.isArray(targetStep.contract.filters)) return plan;

    const tableInfo = this.contexts?.[sourceId]?.tables?.[activeTable] || {};
    const columns = new Set((tableInfo.columns || []).map(column => String(column?.name || column).toLowerCase()));
    const addFilter = (field, operator, value) => {
      const normalizedField = String(field || "").split(".").at(-1);
      if (!normalizedField || !columns.has(normalizedField.toLowerCase())) return;
      const exists = targetStep.contract.filters.some(filter =>
        String(filter?.table || "").toLowerCase() === activeTable.toLowerCase() &&
        String(filter?.field || filter?.column || "").split(".").at(-1).toLowerCase() === normalizedField.toLowerCase()
      );
      if (!exists) targetStep.contract.filters.push({ table: activeTable, field: normalizedField, operator, value });
    };

    if (recordSet && Array.isArray(recordSet.values) && recordSet.values.length > 0) {
      addFilter(recordSet.key_column, "in", recordSet.values);
    } else {
      for (const [field, value] of Object.entries(stableKeys)) addFilter(field, "=", value);
    }
    plan.needs_conversation_context = true;
    return plan;
  }

  _normalizePlan(...args) {
    return this._normalize_plan(...args);
  }

  _normalize_data_sources(plan) {
    const rawSources = plan.data_sources ?? ["postgresql"];

    if (!Array.isArray(rawSources)) {
      throw new Error("data_sources must be a list.");
    }

    const availablePostgres = new Set(
      this._get_available_postgresql_sources().map(s => s.toLowerCase())
    );

    const normalized = [];

    for (const value of rawSources) {
      if (typeof value !== "string") {
        throw new Error("data_sources must contain strings.");
      }

      const source = value.trim().toLowerCase();
      if (!source) {
        continue;
      }

      if (availablePostgres.has(source)) {
        if (!normalized.includes("postgresql")) {
          normalized.push("postgresql");
        }
        continue;
      }

      if (!this.ALLOWED_DATA_SOURCES.has(source)) {
        throw new Error(`Unsupported data source: '${source}'`);
      }

      if (!normalized.includes(source)) {
        normalized.push(source);
      }
    }

    if (normalized.length === 0) {
      return ["postgresql"];
    }

    return normalized;
  }

  _normalize_postgresql_sources(plan) {
    let rawSources = plan.postgresql_sources ?? [];

    if (!Array.isArray(rawSources)) {
      throw new Error("postgresql_sources must be a list.");
    }

    const available = new Set(
      this._get_available_postgresql_sources().map(s => s.toLowerCase())
    );

    const normalized = [];

    for (const value of rawSources) {
      if (typeof value !== "string") {
        throw new Error("postgresql_sources must contain strings.");
      }

      const source = value.trim().toLowerCase();
      if (!source) {
        continue;
      }

      if (available.size > 0 && !available.has(source)) {
        throw new Error(`Question planner selected unavailable PostgreSQL source: '${source}'`);
      }

      if (!normalized.includes(source)) {
        normalized.push(source);
      }
    }

    return normalized;
  }

  _normalize_operations(operations) {
    if (operations === null || operations === undefined) {
      return [];
    }

    if (!Array.isArray(operations)) {
      throw new Error("operations must be a list.");
    }

    const normalized = [];

    for (const operation of operations) {
      if (typeof operation !== "string") {
        throw new Error("operations must contain strings.");
      }

      let value = operation.trim().toLowerCase();
      if (!value) {
        continue;
      }

      value = this.OPERATION_ALIASES[value] || value;

      if (!this.CANONICAL_OPERATIONS.has(value)) {
        throw new Error(`Unsupported operation: '${value}'`);
      }

      if (!normalized.includes(value)) {
        normalized.push(value);
      }
    }

    return normalized;
  }

  _normalize_filters(filters) {
    if (filters === null || filters === undefined) {
      return [];
    }
    if (filters && typeof filters === "object" && !Array.isArray(filters)) {
      filters = [filters];
    }
    if (!Array.isArray(filters)) {
      return [];
    }

    const normalized = [];

    for (const item of filters) {
      if (typeof item === "string") {
        const text = item.trim();
        if (!text) {
          continue;
        }

        const match = text.match(
          /^([^\s=<>!]+)\s*(=|!=|<>|>=|<=|>|<|contains|starts_with|ends_with)\s*(.+)$/i
        );

        if (match) {
          const field = match[1].trim();
          const operator = match[2].trim().toLowerCase();
          let value = match[3].trim();

          if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === "'" || value[0] === '"')) {
            value = value.slice(1, -1);
          }

          normalized.push({
            field,
            operator: this.FILTER_OPERATOR_ALIASES[operator] || operator,
            value,
          });
        }
        continue;
      }

      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }

      const current = deepcopy(item);
      const field = current.field || current.column || current.column_name;
      if (typeof field === "string") {
        current.field = field.trim();
      }

      const operator = current.operator || current.op || "=";
      if (typeof operator === "string") {
        const val = operator.trim().toLowerCase();
        current.operator = this.FILTER_OPERATOR_ALIASES[val] || val;
      }

      normalized.push(current);
    }

    return normalized;
  }

  _complete_filter_references(plan) {
    if (!plan || typeof plan !== "object" || !Array.isArray(plan.filters)) return plan?.filters || [];
    const tables = Array.isArray(plan.required_tables) ? plan.required_tables : [];
    const sources = Array.isArray(plan.postgresql_sources) ? plan.postgresql_sources : Object.keys(this.contexts || {});
    return plan.filters.map(filter => {
      if (!filter || typeof filter !== "object" || Array.isArray(filter)) return filter;
      const current = deepcopy(filter);
      const rawField = String(current.field || current.column || current.column_name || "").trim();
      const parts = rawField.split(".");
      const field = parts.at(-1);
      if (!field) return current;
      if (!current.field) current.field = field;
      if (current.table) return current;

      const matches = [];
      for (const sourceId of sources) {
        for (const table of tables) {
          const columns = this.contexts?.[sourceId]?.tables?.[table]?.columns || [];
          if (columns.some(column => String(column?.name || column || "").toLowerCase() === field.toLowerCase())) {
            matches.push({ sourceId, table });
          }
        }
      }
      const uniqueTables = [...new Set(matches.map(match => match.table))];
      if (uniqueTables.length === 1) current.table = uniqueTables[0];
      return current;
    });
  }

  _normalize_required_columns(columns) {
    if (columns === null || columns === undefined) {
      return [];
    }

    if (!Array.isArray(columns)) {
      throw new Error("required_columns must be a list.");
    }

    const normalized = [];

    for (const column of columns) {
      if (typeof column === "string") {
        if (column.trim()) {
          normalized.push(column.trim());
        }
        continue;
      }

      if (column && typeof column === "object" && !Array.isArray(column)) {
        normalized.push(deepcopy(column));
        continue;
      }

      throw new Error("required_columns must contain strings or objects.");
    }

    return normalized;
  }

  _complete_schema_anchor_plan(plan, question) {
    if (
      !plan.data_sources ||
      JSON.stringify(plan.data_sources) !== JSON.stringify(["postgresql"]) ||
      (Array.isArray(plan.required_tables) && plan.required_tables.length > 0) ||
      (plan.execution_plan && typeof plan.execution_plan === "object")
    ) {
      return plan;
    }

    const tokens = (question.toLowerCase().match(/[a-z0-9_]+/g) || []).filter(t => t.length >= 2);
    if (tokens.length === 0) {
      return plan;
    }

    const candidates = [];
    const postgresqlSources = Array.isArray(plan.postgresql_sources) ? plan.postgresql_sources : [];

    for (const sourceId of postgresqlSources) {
      const context = this.contexts[sourceId] || {};
      const tables = context && typeof context === "object" && !Array.isArray(context) ? (context.tables || {}) : {};

      if (!tables || typeof tables !== "object" || Array.isArray(tables)) {
        continue;
      }

      for (const [tableName, tableInfo] of Object.entries(tables)) {
        const tableText = String(tableName).toLowerCase();
        let score = tokens.some(t => tableText.includes(t) || t.includes(tableText)) ? 4 : 0;

        const columns = tableInfo && typeof tableInfo === "object" && Array.isArray(tableInfo.columns) ? tableInfo.columns : [];
        const matchedColumns = [];

        for (const column of columns) {
          if (!column || typeof column !== "object" || Array.isArray(column) || !column.name) {
            continue;
          }
          const name = String(column.name).toLowerCase();
          if (tokens.some(t => name.includes(t) || t.includes(name))) {
            score += 1;
            matchedColumns.push(String(column.name));
          }
        }

        if (score > 0) {
          const allColumns = columns
            .filter(c => c && typeof c === "object" && c.name)
            .map(c => String(c.name));
          const selectedColumns = matchedColumns.length > 0 ? matchedColumns : allColumns.slice(0, 8);
          candidates.push([score, sourceId, String(tableName), selectedColumns]);
        }
      }
    }

    if (candidates.length === 0) {
      return plan;
    }

    candidates.sort((a, b) => {
      if (b[0] !== a[0]) return b[0] - a[0];
      if (a[1] !== b[1]) return a[1].localeCompare(b[1]);
      return a[2].localeCompare(b[2]);
    });

    const bestScore = candidates[0][0];
    const best = candidates.filter(item => item[0] === bestScore);
    if (best.length > 1) {
      return { ...plan, ambiguous_context_candidates: best.map(item => ({ source_id: item[1], table: item[2] })) };
    }
    const selected = best.slice(0, 1);

    const result = deepcopy(plan);
    result.postgresql_sources = Array.from(new Set(selected.map(item => item[1])));
    result.required_tables = selected.map(item => item[2]);

    const reqCols = [];
    for (const item of selected) {
      for (const column of item[3]) {
        reqCols.push(`${item[2]}.${column}`);
      }
    }
    result.required_columns = reqCols;

    if (!Array.isArray(result.operations) || result.operations.length === 0) {
      result.operations = ["lookup"];
    }

    result.confidence = Math.max(Number(result.confidence || 0), 0.55);
    result.reasoning =
      "A schema anchor was selected from dynamically discovered table/column names because the initial plan did not identify a concrete target.";

    return result;
  }

  _resolve_required_columns(columns, requiredTables, sourceIds) {
    const known = {};
    for (const sourceId of sourceIds) {
      const context = this.contexts[sourceId] || {};
      const tables = context && typeof context === "object" && !Array.isArray(context) ? (context.tables || {}) : {};
      if (!tables || typeof tables !== "object" || Array.isArray(tables)) {
        continue;
      }
      for (const [tableName, info] of Object.entries(tables)) {
        const cols = info && typeof info === "object" && Array.isArray(info.columns) ? info.columns : [];
        if (!known[String(tableName)]) {
          known[String(tableName)] = new Set();
        }
        for (const c of cols) {
          if (c && typeof c === "object" && c.name) {
            known[String(tableName)].add(String(c.name));
          }
        }
      }
    }

    const result = [];
    for (const item of columns) {
      let value;
      if (item && typeof item === "object" && !Array.isArray(item)) {
        value = item.field || item.column || item.name;
      } else {
        value = item;
      }

      if (typeof value !== "string" || !value.trim()) {
        continue;
      }

      value = value.trim();
      if ((value.match(/\./g) || []).length === 1) {
        result.push(value);
        continue;
      }

      const matches = [];
      for (const table of requiredTables) {
        if (known[table] && known[table].has(value)) {
          matches.push(`${table}.${value}`);
        }
      }

      if (matches.length > 0) {
        result.push(matches[0]);
      }
    }

    return Array.from(new Set(result));
  }

  _normalize_relationships(relationships) {
    if (relationships === null || relationships === undefined) {
      return [];
    }

    if (!Array.isArray(relationships)) {
      throw new Error("relationships must be a list.");
    }

    const result = [];
    for (const relationship of relationships) {
      if (!relationship || typeof relationship !== "object" || Array.isArray(relationship)) {
        throw new Error("Each relationship must be an object.");
      }
      result.push(deepcopy(relationship));
    }

    return result;
  }

  _normalize_requested_metrics(metrics) {
    if (metrics === null || metrics === undefined) {
      return [];
    }

    if (!Array.isArray(metrics)) {
      throw new Error("requested_metrics must be a list.");
    }

    const normalized = [];

    for (const metric of metrics) {
      if (!metric || typeof metric !== "object" || Array.isArray(metric)) {
        throw new Error("Each requested metric must be an object.");
      }

      const current = deepcopy(metric);
      const operation = current.operation;
      if (typeof operation === "string") {
        const val = operation.trim().toLowerCase();
        current.operation = this.OPERATION_ALIASES[val] || val;
      }

      const sourceId = current.source_id;
      if (typeof sourceId === "string") {
        current.source_id = sourceId.trim().toLowerCase();
      }

      current.distinct = Boolean(current.distinct || false);
      normalized.push(current);
    }

    return normalized;
  }

  _normalize_sorting(sorting) {
    if (sorting === null || sorting === undefined) {
      return [];
    }

    if (typeof sorting === "string" || (sorting && typeof sorting === "object" && !Array.isArray(sorting))) {
      sorting = [sorting];
    }

    if (!Array.isArray(sorting)) {
      return [];
    }

    const result = [];

    for (const item of sorting) {
      if (typeof item === "string") {
        const field = item.trim();
        if (field) {
          result.push({ field, direction: "desc" });
        }
        continue;
      }

      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }

      const current = deepcopy(item);
      const field = current.field || current.column || current.column_name || current.sort_field;

      if (typeof field !== "string" || !field.trim()) {
        continue;
      }

      let direction = String(current.direction || current.order || "desc").trim().toLowerCase();
      if (direction === "descending" || direction === "down") {
        direction = "desc";
      } else if (direction === "ascending" || direction === "up") {
        direction = "asc";
      }

      if (direction !== "asc" && direction !== "desc") {
        direction = "desc";
      }

      result.push({ field: field.trim(), direction });
    }

    return result;
  }

  _resolve_sorting_fields(sorting, requiredTables, sourceIds) {
    if (!sorting || !Array.isArray(sorting) || sorting.length === 0) {
      return [];
    }

    const known = {};
    for (const sourceId of sourceIds) {
      const context = this.contexts[sourceId] || {};
      const tables = context && typeof context === "object" && !Array.isArray(context) ? (context.tables || {}) : {};
      if (!tables || typeof tables !== "object" || Array.isArray(tables)) {
        continue;
      }
      for (const [tableName, info] of Object.entries(tables)) {
        const cols = info && typeof info === "object" && Array.isArray(info.columns) ? info.columns : [];
        if (!known[String(tableName)]) {
          known[String(tableName)] = new Set();
        }
        for (const c of cols) {
          if (c && typeof c === "object" && c.name) {
            known[String(tableName)].add(String(c.name).trim());
          }
        }
      }
    }

    const resolved = [];
    for (const item of sorting) {
      const field = item ? item.field : null;
      if (typeof field !== "string") {
        continue;
      }

      const trimmedField = field.trim();
      if ((trimmedField.match(/\./g) || []).length === 1) {
        resolved.push(item);
        continue;
      }

      const matches = [];
      for (const table of requiredTables) {
        if (known[table] && known[table].has(trimmedField)) {
          matches.push(`${table}.${trimmedField}`);
        }
      }

      if (matches.length > 0) {
        const current = deepcopy(item);
        current.field = matches[0];
        resolved.push(current);
      }
    }

    return resolved;
  }

  _normalize_entities(entities) {
    if (entities === null || entities === undefined) {
      return [];
    }

    if (typeof entities === "string" || (entities && typeof entities === "object" && !Array.isArray(entities))) {
      entities = [entities];
    }

    if (!Array.isArray(entities)) {
      return [];
    }

    const availableSources = new Set(this._get_available_postgresql_sources());
    const normalized = [];

    for (const item of entities) {
      if (typeof item === "string" && item.trim()) {
        normalized.push({
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
        normalized.push(current);
      }
    }

    return normalized;
  }

  _normalize_security_resource(resource) {
    if (resource === null || resource === undefined || typeof resource !== "string" || !resource.trim()) {
      return "security_logs";
    }

    const normalized = resource.trim().toLowerCase();
    if (this.SECURITY_RESOURCES.has(normalized)) {
      return normalized;
    }

    return "security_logs";
  }

  // ------------------------------------------------------------------
  // Execution-plan normalization
  // ------------------------------------------------------------------

  _normalize_execution_plan(executionPlan) {
    if (!executionPlan || typeof executionPlan !== "object" || Array.isArray(executionPlan)) {
      throw new Error("execution_plan must be an object.");
    }

    let rawSteps = executionPlan.steps;

    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
      rawSteps = [
        {
          id: "s1",
          type: "source_query",
          source_id: this._get_available_postgresql_sources()[0] || "",
          contract: {},
          depends_on: [],
          inputs: [],
          input_bindings: [],
          key_columns: [],
          output_columns: [],
          purpose: "Single step query execution",
        },
      ];
      executionPlan.steps = rawSteps;
      executionPlan.mode = "single";
      executionPlan.final_step = "s1";
    }

    if (rawSteps.length > this.MAX_EXECUTION_STEPS) {
      throw new Error("execution_plan exceeds the maximum step count.");
    }

    let mode = executionPlan.mode || "multi_step";

    if (mode !== "single" && mode !== "multi_step") {
      throw new Error("execution_plan mode must be single or multi_step.");
    }

    const normalizedSteps = [];
    for (const rawStep of rawSteps) {
      normalizedSteps.push(this._normalize_execution_step(rawStep));
    }

    const boundSteps = this._normalize_cross_source_bindings(normalizedSteps);

    const finalStep = executionPlan.final_step;
    if (typeof finalStep !== "string" || !finalStep.trim()) {
      throw new Error("execution_plan final_step must be a non-empty string.");
    }

    if (mode === "single" && boundSteps.length !== 1) {
      mode = "multi_step";
    }

    return {
      mode,
      steps: boundSteps,
      final_step: finalStep.trim(),
      reason: String(executionPlan.reason || ""),
    };
  }

  _load_cross_source_relationships() {
    const artifactPath = path.resolve(__dirname, "..", "context", "cross_source_relationships.json");

    try {
      if (fs.existsSync(artifactPath)) {
        const raw = fs.readFileSync(artifactPath, "utf-8");
        const payload = JSON.parse(raw);

        let relationships;
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          relationships = payload.validated_relationships || [];
        } else {
          relationships = payload;
        }

        if (Array.isArray(relationships)) {
          return relationships.filter(
            item => item && typeof item === "object" && item.valid === true
          );
        }
      }
    } catch {
      return [];
    }

    return [];
  }

  _normalize_cross_source_bindings(steps) {
    const relationships = this._load_cross_source_relationships();

    if (!relationships || relationships.length === 0) {
      return steps;
    }

    const stepById = {};
    for (const step of steps) {
      if (step && typeof step === "object" && typeof step.id === "string") {
        stepById[step.id] = step;
      }
    }

    const normalizedSteps = deepcopy(steps);

    for (const step of normalizedSteps) {
      const targetSource = step.source_id;
      if (typeof targetSource !== "string") {
        continue;
      }

      const bindings = step.input_bindings;
      if (!Array.isArray(bindings) || bindings.length === 0) {
        continue;
      }

      for (const binding of bindings) {
        if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
          continue;
        }

        const fromStepId = binding.from_step;
        const fromColumn = binding.from_column;
        const toTable = binding.to_table;

        const producer = stepById[fromStepId];
        if (!producer || typeof producer !== "object") {
          continue;
        }

        const sourceSource = producer.source_id;
        if (typeof sourceSource !== "string") {
          continue;
        }

        if (typeof fromColumn !== "string" || !fromColumn.trim()) {
          continue;
        }
        if (typeof toTable !== "string" || !toTable.trim()) {
          continue;
        }

        let sourceTables = new Set();
        const producerContract = producer.contract || {};
        if (producerContract && typeof producerContract === "object" && !Array.isArray(producerContract)) {
          const requiredTables = producerContract.required_tables;
          if (Array.isArray(requiredTables)) {
            sourceTables = new Set(
              requiredTables
                .filter(v => typeof v === "string" && v.trim())
                .map(v => v.trim())
            );
          }
        }

        let candidates = [];

        for (const relationship of relationships) {
          const relSrc = relationship.source_system || relationship.source_id || "";
          if (String(relSrc).trim().toLowerCase() !== sourceSource.trim().toLowerCase()) {
            continue;
          }

          const relTgt = relationship.target_system || relationship.target_source_id || "";
          if (String(relTgt).trim().toLowerCase() !== targetSource.trim().toLowerCase()) {
            continue;
          }

          const sourceTable = relationship.source_table;
          if (sourceTables.size > 0 && !sourceTables.has(sourceTable)) {
            continue;
          }

          const targetTable = relationship.target_table;
          if (typeof targetTable !== "string" || !targetTable.trim()) {
            continue;
          }

          const targetContract = step.contract || {};
          let targetTables = new Set();
          if (targetContract && typeof targetContract === "object" && !Array.isArray(targetContract)) {
            const reqTables = targetContract.required_tables;
            if (Array.isArray(reqTables)) {
              targetTables = new Set(
                reqTables
                  .filter(v => typeof v === "string" && v.trim())
                  .map(v => v.trim())
              );
            }
          }

          if (targetTables.size > 0 && !targetTables.has(targetTable)) {
            continue;
          }

          candidates.push(relationship);
        }

        if (candidates.length === 0) {
          continue;
        }

        const exactTargetTable = candidates.filter(item => item.target_table === toTable.trim());
        if (exactTargetTable.length > 0) {
          candidates = exactTargetTable;
        }

        candidates.sort((a, b) => {
          const confA = Number(a.confidence || 0.0);
          const confB = Number(b.confidence || 0.0);
          return confB - confA;
        });

        const topConfidence = Number(candidates[0].confidence || 0.0);
        const top = candidates.filter(item => Number(item.confidence || 0.0) === topConfidence);

        const targetPairs = new Set(
          top
            .filter(item => typeof item.target_table === "string" && typeof item.target_column === "string")
            .map(item => `${item.target_table}|${item.target_column}`)
        );

        if (targetPairs.size !== 1) {
          throw new Error(
            `Ambiguous validated cross-source mapping for ${sourceSource}.${fromColumn} -> ${targetSource}.${toTable}.`
          );
        }

        const authoritative = top[0];
        const srcCol = authoritative.source_column;
        const tgtCol = authoritative.target_column;
        const tgtTbl = authoritative.target_table;

        if (srcCol) {
          binding.from_column = srcCol;
          const producerStepId = producer.id;
          for (const normStep of normalizedSteps) {
            if (normStep.id === producerStepId) {
              const outputs = normStep.output_columns;
              if (Array.isArray(outputs) && !outputs.includes(srcCol)) {
                outputs.push(srcCol);
              }
              const prodContract = normStep.contract;
              if (prodContract && typeof prodContract === "object") {
                const reqCols = prodContract.required_columns;
                if (Array.isArray(reqCols)) {
                  const srcTbl = authoritative.source_table || "";
                  const fullCol = srcTbl ? `${srcTbl}.${srcCol}` : srcCol;
                  if (!reqCols.includes(fullCol) && !reqCols.includes(srcCol)) {
                    reqCols.push(fullCol);
                  }
                }
              }
            }
          }
        }

        if (tgtCol && tgtTbl) {
          binding.to_table = tgtTbl;
          binding.to_column = tgtCol;
        }
      }
    }

    return normalizedSteps;
  }

  _normalize_execution_step(rawStep) {
    if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) {
      throw new Error("Each execution-plan step must be an object.");
    }

    const stepId = rawStep.id;

    if (typeof stepId !== "string" || !stepId.trim()) {
      throw new Error("Each execution-plan step requires a non-empty id.");
    }

    let stepType = rawStep.type;
    const aliases = {
      "source": "source_query",
      "query": "source_query",
      "final": "final_query",
      "set": "set_operation",
    };

    if (typeof stepType === "string") {
      stepType = aliases[stepType.trim().toLowerCase()] || stepType.trim().toLowerCase();
    }

    if (!this.EXECUTION_STEP_TYPES.has(stepType)) {
      throw new Error(`Unsupported execution step type: '${stepType}'`);
    }

    let sourceId = rawStep.source_id;

    if (stepType === "source_query" || stepType === "final_query") {
      if (typeof sourceId !== "string" || !sourceId.trim()) {
        throw new Error(`Execution step '${stepId}' requires source_id.`);
      }
      sourceId = sourceId.trim().toLowerCase();
    } else {
      sourceId = null;
    }

    let contract = rawStep.contract || {};
    if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
      throw new Error(`Execution step '${stepId}' contract must be an object.`);
    }

    if (stepType === "source_query" || stepType === "final_query") {
      contract = this._normalize_step_contract(contract, sourceId);
    } else {
      contract = {};
    }

    const dependsOn = this._normalize_string_list(rawStep.depends_on ?? []);
    const inputs = this._normalize_string_list(rawStep.inputs ?? []);
    const inputBindings = this._normalize_input_bindings(
      rawStep.input_bindings ?? [],
      stepId.trim()
    );

    let operator = rawStep.operator;
    if (operator !== null && operator !== undefined) {
      if (typeof operator !== "string") {
        throw new Error(`Execution step '${stepId}' operator must be a string.`);
      }
      operator = operator.trim().toLowerCase();
    } else {
      operator = null;
    }

    if (stepType === "set_operation") {
      if (!this.SET_OPERATIONS.has(operator)) {
        throw new Error(`Unsupported set operation in step '${stepId}': '${operator}'`);
      }
    }

    const keyColumns = this._normalize_string_list(rawStep.key_columns ?? []);
    const outputColumns = this._normalize_string_list(rawStep.output_columns ?? []);
    const purpose = String(rawStep.purpose || "");

    return {
      id: stepId.trim(),
      type: stepType,
      source_id: sourceId,
      contract,
      depends_on: dependsOn,
      inputs,
      input_bindings: inputBindings,
      operator,
      key_columns: keyColumns,
      output_columns: outputColumns,
      purpose,
    };
  }

  _normalize_step_contract(contract, sourceId) {
    const current = deepcopy(contract);

    current.data_sources = ["postgresql"];
    current.postgresql_sources = [sourceId];
    current.source_id = sourceId;
    current.required_tables = this._normalize_string_list(current.required_tables ?? []);
    current.required_columns = this._normalize_required_columns(current.required_columns ?? []);
    current.required_columns = this._resolve_required_columns(
      current.required_columns,
      current.required_tables ?? [],
      current.postgresql_sources ?? [sourceId]
    );
    current.relationships = this._normalize_relationships(current.relationships ?? []);
    current.filters = this._normalize_filters(current.filters ?? []);
    current.filters = this._complete_filter_references(current);
    current.operations = this._normalize_operations(current.operations ?? []);
    current.requested_metrics = this._normalize_requested_metrics(current.requested_metrics ?? []);
    current.grouping = this._normalize_string_list(current.grouping ?? []);
    current.sorting = this._normalize_sorting(current.sorting ?? []);
    current.entities = this._normalize_entities(current.entities ?? []);

    return current;
  }

  _normalize_input_bindings(bindings, stepId) {
    if (bindings === null || bindings === undefined) {
      return [];
    }

    if (!Array.isArray(bindings)) {
      throw new Error(`Execution step '${stepId}' input_bindings must be a list.`);
    }

    const normalized = [];

    for (const binding of bindings) {
      if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
        throw new Error(`Execution step '${stepId}' contains an invalid input binding.`);
      }

      const values = {};

      for (const name of ["from_step", "from_column", "to_table", "to_column"]) {
        const value = binding[name];
        if (typeof value !== "string" || !value.trim()) {
          throw new Error(`Execution step '${stepId}' binding ${name} must be a non-empty string.`);
        }
        values[name] = value.trim();
      }

      let operator = binding.operator !== undefined ? binding.operator : "in";
      if (typeof operator !== "string") {
        throw new Error(`Execution step '${stepId}' binding operator must be a string.`);
      }

      operator = operator.trim().toLowerCase();
      if (["=", "==", "eq", "equals"].includes(operator)) {
        operator = "equals";
      }

      if (!this.BINDING_OPERATORS.has(operator)) {
        throw new Error(`Unsupported input binding operator: '${operator}'`);
      }

      values.operator = operator;
      normalized.push(values);
    }

    return normalized;
  }

  _normalize_string_list(value) {
    if (value === null || value === undefined) {
      return [];
    }

    if (typeof value === "string") {
      value = [value];
    }

    if (!Array.isArray(value)) {
      return [];
    }

    const result = [];

    for (const item of value) {
      let itemStr = "";
      if (typeof item === "string") {
        itemStr = item.trim();
      } else if (typeof item === "number") {
        itemStr = String(item).trim();
      } else {
        continue;
      }

      if (itemStr && !result.includes(itemStr)) {
        result.push(itemStr);
      }
    }

    return result;
  }
}

export default {
  QuestionPlanner,
};
