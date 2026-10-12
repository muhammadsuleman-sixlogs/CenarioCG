import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getOpenAIClient, OPENAI_MODEL } from "../llm/openai_client.js";
import { loadAllContexts } from "../context/context_store.js";
import { isSensitiveQuestionIntent } from "../security/sensitive_data_policy.js";
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
    .map(token => token.endsWith("s") && token.length > 3 ? token.slice(0, -1) : token);
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

  async plan(question, conversationContext = null) {
    if (typeof question !== "string" || !question.trim()) {
      throw new Error("Question cannot be empty.");
    }

    const trimmedQuestion = question.trim();

    // Sensitive credential security check
    if (typeof isSensitiveQuestionIntent === "function" && isSensitiveQuestionIntent(trimmedQuestion)) {
      const err = new Error("Access to credentials, passwords, tokens, and confidential secrets is strictly restricted.");
      err.isSensitiveViolation = true;
      throw err;
    }

    // A specific-record lookup has a smaller, stronger contract than an LLM
    // relationship plan: one authorized semantic entity plus one discovered
    // identifier/display filter.  Prefer it before invoking a provider so a
    // malformed provider plan cannot add unrelated tables to a detail query.
    const deterministicDetail = this._build_metadata_fallback_plan(trimmedQuestion, conversationContext);
    if (this._is_bounded_detail_lookup(trimmedQuestion, deterministicDetail)) {
      return this._normalize_plan(deterministicDetail, trimmedQuestion, conversationContext);
    }

    if (!this.client) {
      try { this.client = getOpenAIClient(); } catch { this.client = null; }
    }

    const context = this._build_context_for_llm();
    const resolvedEntities = this._build_resolved_entity_context(conversationContext);
    const prompt = this._build_prompt(
      trimmedQuestion,
      context,
      conversationContext,
      resolvedEntities
    );

    let content = "";

    if (this.client?.responses?.create) {
      try {
        const response = await this.client.responses.create({
          model: OPENAI_MODEL,
          input: prompt,
        });
        content = (response.output_text ?? response.output ?? "").trim();
      } catch {
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
      } catch {
        content = "";
      }
    }

    if (!content) {
      const fallback = this._build_metadata_fallback_plan(trimmedQuestion, conversationContext);
      if (fallback) return this._normalize_plan(fallback, trimmedQuestion, conversationContext);
      throw new Error("Question planner could not produce a schema-grounded retrieval plan.");
    }

    let rawPlan;
    try { rawPlan = this._parse_json_response(content); } catch {
      const fallback = this._build_metadata_fallback_plan(trimmedQuestion, conversationContext);
      if (fallback) return this._normalize_plan(fallback, trimmedQuestion, conversationContext);
      throw new Error("Question planner returned an invalid retrieval plan.");
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
    const active = this._conversation_reference(conversationContext);
    const refersBack = /\b(?:it|its|that|this|those|these|details?)\b/i.test(question);
    const recordSet = active?.record_set;
    if (recordSet && this._is_record_set_reference(question) && active.source_id && active.table && Array.isArray(recordSet.values) && recordSet.values.length > 0) {
      const tableInfo = this.contexts?.[active.source_id]?.tables?.[active.table] || {};
      const safeColumns = (tableInfo.columns || []).map(column => String(column?.name || column || "")).filter(Boolean);
      return {
        data_sources: ["postgresql"],
        postgresql_sources: [String(active.source_id).toLowerCase()],
        required_tables: [active.table],
        required_columns: safeColumns.map(column => `${active.table}.${column}`).slice(0, 20),
        filters: [{ table: active.table, field: recordSet.key_column, operator: "in", value: recordSet.values }],
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
    const candidates = semanticCandidates.length > 0 ? semanticCandidates.map(candidate => {
      const info = this.contexts[candidate.source_id]?.tables?.[candidate.table] || {};
      const columns = Array.isArray(info.columns) ? info.columns : [];
      return {
        ...candidate,
        relevance: candidate.score,
        columns: columns.map(column => String(column?.name || column || "")).filter(Boolean),
        primary_keys: Array.isArray(info.primary_keys) ? info.primary_keys : []
      };
    }) : [];
    if (candidates.length === 0) {
      for (const [sourceId, context] of Object.entries(this.contexts || {})) {
        for (const [table, info] of Object.entries(context?.tables || {})) {
          const relevance = this._table_question_relevance(sourceId, table, question);
          if (relevance <= 0) continue;
          const columns = Array.isArray(info?.columns) ? info.columns : [];
          candidates.push({ source_id: sourceId, table, relevance, columns: columns.map(column => String(column?.name || column || "")).filter(Boolean), primary_keys: Array.isArray(info?.primary_keys) ? info.primary_keys : [] });
        }
      }
    }
    for (const candidate of candidates) candidate.columns = candidate.columns.filter(column => column && !isSensitiveFieldName(column));
    // If the user is asking about the already established entity itself,
    // preserve that bounded lookup. Requests for a distinct semantic target
    // (transcript, project, etc.) continue to relationship resolution below.
    const explicitNewRecord = candidates.some(candidate => this._explicit_identifier_filter(question, candidate) || this._explicit_display_filter(question, candidate));
    if (active && refersBack && !explicitNewRecord && candidates.length && !candidates.some(candidate => candidate.source_id === active.source_id && candidate.table !== active.table)) {
      return { data_sources: ["postgresql"], postgresql_sources: [], required_tables: [], required_columns: [], filters: [], relationships: [], operations: ["lookup"], needs_conversation_context: true, confidence: 0.8 };
    }
    candidates.sort((left, right) => right.relevance - left.relevance || left.source_id.localeCompare(right.source_id) || left.table.localeCompare(right.table));
    if (!candidates.length) return null;
    let best = candidates[0];
    const isCount = this._is_count_question(question, candidates);
    const isRecent = this._is_recent_records_question(question);
    const isIndependent = isCount || /\b(?:list|which|compare|comparison|each|all)\b/i.test(question);
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
    const statusFilter = this._verified_status_filter(best, question) || (isCount ? this._discovered_categorical_filter(best, question) : null);
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
    const identifierFilter = this._explicit_identifier_filter(question, best);
    const displayFilter = identifierFilter ? null : this._explicit_display_filter(question, best);
    const requiredColumns = isCount ? [] : Array.from(new Set([
      ...best.primary_keys.map(column => `${best.table}.${column}`),
      ...best.columns.map(column => `${best.table}.${column}`),
      ...(temporalCompanion ? [`${temporalCompanion.table}.${temporalCompanion.ordering_column}`] : [])
    ])).slice(0, 20);
    return {
      data_sources: ["postgresql"], postgresql_sources: [best.source_id], required_tables: requiredTables, required_columns: requiredColumns,
      relationships: temporalCompanion ? [temporalCompanion.relationship] : [], filters: [statusFilter, identifierFilter, displayFilter].filter(Boolean), operations: [isCount ? "count" : (isRecent ? "ranking" : "lookup")],
      sorting: isRecent && orderingTable && orderingColumn ? [{ field: `${orderingTable}.${orderingColumn}`, direction: "desc" }] : [], limit: isCount ? null : (isRecent ? 10 : 50), confidence: 0.65,
      entity_target: { source_id: best.source_id, table: best.table },
      semantic_candidates: semanticCandidates.length > 0 ? semanticCandidates.slice(0, 8) : undefined,
      reasoning: "A bounded metadata-only fallback selected one unambiguous authorized semantic catalog candidate after the semantic planner was unavailable."
    };
  }

  _conversation_reference(conversationContext) {
    return conversationContext?.active_context || conversationContext?.pending_reference || null;
  }

  _is_record_set_reference(question) {
    return /\b(?:above|those|these|previous|prior)\b|\ball\s+\d+\b/i.test(String(question || ""));
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

  _explicit_display_filter(question, candidate) {
    const parsingQuestion = this._strip_structural_prefix_for_display_parsing(question);
    const text = String(parsingQuestion || "").toLowerCase();
    if (!/\b(?:show|details?|about|information|find)\b/.test(text) || !candidate) return null;
    if (this._is_record_set_reference(parsingQuestion)) return null;
    const tokens = tokenWords(parsingQuestion);
    const entityWords = new Set([candidate.table, candidate.entity_type, ...(candidate.matched_aliases || [])].flatMap(tokenWords));
    const entityIndex = tokens.findIndex(token => entityWords.has(token));
    if (entityIndex < 1) return null;
    const quoted = [...String(parsingQuestion).matchAll(/["']([^"']+)["']/g)].map(match => match[1].trim()).filter(Boolean);
    const ignored = new Set(["show", "me", "the", "a", "an", "all", "details", "detail", "about", "information", "find", "with", "for", "of", "it", "its", "that", "this", "those", "these", "related", "total", "count", "number", "how", "many"]);
    const valueTokens = tokens.slice(0, entityIndex).filter(token => !ignored.has(token) && !this._is_temporal_modifier_token(token));
    const displayValue = quoted[0] || valueTokens.join(" ");
    if (!displayValue || valueTokens.length > 8) return null;
    const columns = candidate.columns || [];
    const displayHints = new Set(["title", "name", "label", "subject", "summary"]);
    const scored = columns.map(column => {
      const words = String(column).toLowerCase().split(/[^a-z0-9]+|_/).filter(Boolean).map(word => word.endsWith("s") && word.length > 3 ? word.slice(0, -1) : word);
      let score = 0;
      if (words.some(word => displayHints.has(word))) score += 50;
      if (words.some(word => entityWords.has(word))) score += 25;
      if (String(column).toLowerCase() === "name" || String(column).toLowerCase() === "title") score += 10;
      return { column, score };
    }).filter(item => item.score >= 50).sort((left, right) => right.score - left.score || left.column.localeCompare(right.column));
    if (!scored.length || (scored[1] && scored[0].score === scored[1].score)) return null;
    return { table: candidate.table, field: scored[0].column, operator: "contains", value: displayValue };
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
    if (!plan || !Array.isArray(plan.filters) || plan.filters.length !== 1) return false;
    if (!/\b(?:show|details?|about|information|find)\b/i.test(String(question || ""))) return false;
    if (!Array.isArray(plan.required_tables) || plan.required_tables.length !== 1) return false;
    if (!Array.isArray(plan.postgresql_sources) || plan.postgresql_sources.length !== 1) return false;
    return ["=", "contains", "in"].includes(String(plan.filters[0]?.operator || "").toLowerCase());
  }

  _is_temporal_modifier_token(token) {
    return new Set([
      "recent", "latest", "newest", "recently", "last", "next", "current", "ongoing", "oldest", "earliest",
      "today", "yesterday", "tomorrow", "upcoming", "scheduled", "overdue", "before", "after", "since", "until",
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
    const statusFilters = uniqueCandidates.map(candidate => this._verified_status_filter(candidate, question));
    const statusIntent = uniqueCandidates.some(candidate => this._has_unverified_status_intent(candidate, question));
    if (statusIntent && (statusFilters.some(filter => !filter) || new Set(statusFilters.filter(Boolean).map(filter => JSON.stringify(filter))).size > 1)) {
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
          filters: statusFilters[index] ? [statusFilters[index]] : [],
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
    for (const [label, value] of Object.entries(mappings)) {
      const labelTokens = String(label).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      if (labelTokens.length > 0 && labelTokens.every(token => queryTokens.has(token))) {
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
    const questionTokens = tokenWords(question);
    const entityTokens = [candidate.table, candidate.entity_type, ...(candidate.matched_aliases || [])].flatMap(tokenWords);
    const ignored = new Set(["show", "me", "the", "a", "an", "all", "total", "count", "number", "of", "how", "many", "which", "what", "are", "is", "with", "where", "status", "state", "workflow", "lifecycle", "records"]);
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
    const hasStatusColumn = candidate.columns.some(column => /^(status|state|workflow_state|lifecycle_state)$/i.test(String(column).trim()));
    if (!hasStatusColumn) return false;
    const text = String(question || "").toLowerCase();
    // A status column alone is not evidence that every non-table word is a
    // status value.  That broad heuristic turned ordinary aggregation terms
    // such as "total" into a status clarification.  Only an explicit status
    // predicate or a small, domain-neutral lifecycle vocabulary is treated as
    // an unverified status request.
    if (/\b(?:status|state|workflow|lifecycle)\s*(?:is|are|=|:)?\s*[a-z0-9_]+\b/i.test(text)) return true;
    return /\b(?:pending|open|closed|resolved|unresolved|active|inactive|completed|cancelled|canceled|on[-\s]?hold|in[-\s]?progress)\b/i.test(text);
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
${JSON.stringify(this._build_recent_record_candidates(), null, 2)}

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

Physical PostgreSQL source IDs belong ONLY in:

"postgresql_sources"

For example:

CORRECT:
{
  "data_sources": ["postgresql"],
  "postgresql_sources": ["db1"]
}

INCORRECT:
{
  "data_sources": ["db1"]
}

Never place a PostgreSQL source ID directly into data_sources.

When the question requires facts from DB1 and DB2, return:

{
  "data_sources": ["postgresql"],
  "postgresql_sources": ["db1", "db2"]
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

8. DB1 and DB2 are separate PostgreSQL sources.

9. Never represent DB1 -> DB2 as a SQL JOIN.

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
  "source_id": "db1"
}
Never use arbitrary keys without setting "id" and "type".

When the question is a conversational follow-up (e.g. asking about a person, user,
or entity mentioned in prior turns or meeting summaries):
- If asking whether someone is a user or asking about a user/person by name (e.g. "is Rahim Zahid a user?", "who is Rahim Zahid"):
  Query db1.users and filter by name fields (e.g. users.first_name contains 'Rahim', users.last_name contains 'Zahid').
  Do NOT produce filters with empty values (such as users.id in []). Always filter by the name components.

============================================================
SIMPLE QUERIES
============================================================

For a simple single-source question, return the normal semantic plan.

Example shape:

{
  "question": "...",
  "data_sources": ["postgresql"],
  "postgresql_sources": ["db1"],
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
  "source_id": "db1",
  "contract": {
    "question": "...",
    "data_sources": ["postgresql"],
    "postgresql_sources": ["db1"],
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
  "source_id": "db2",
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
  "purpose": "Retrieve DB2 facts constrained by project keys from DB1."
}

The binding target table/column must exist in the supplied DB2 Context Layer.

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
  "source_id": "db1",
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

  _build_context_for_llm() {
    const sources = {};

    for (const [sourceId, context] of Object.entries(this.contexts)) {
      if (!context || typeof context !== "object" || Array.isArray(context)) {
        continue;
      }

      const tables = context.tables && typeof context.tables === "object" && !Array.isArray(context.tables)
        ? context.tables
        : {};

      const boundedTables = {};
      const tableEntries = Object.entries(tables);

      for (let tableIndex = 0; tableIndex < tableEntries.length; tableIndex++) {
        if (tableIndex >= this.MAX_CONTEXT_TABLES_PER_SOURCE) {
          break;
        }

        const [tableName, tableInfo] = tableEntries[tableIndex];
        if (!tableInfo || typeof tableInfo !== "object" || Array.isArray(tableInfo)) {
          continue;
        }

        const columns = tableInfo.columns || [];
        const boundedColumns = [];

        if (Array.isArray(columns)) {
          for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
            if (columnIndex >= this.MAX_CONTEXT_COLUMNS_PER_TABLE) {
              break;
            }

            const column = columns[columnIndex];
            if (!column || typeof column !== "object" || Array.isArray(column)) {
              continue;
            }

            const columnName = column.name;
            if (!columnName) {
              continue;
            }

            boundedColumns.push({
              name: String(columnName),
              data_type: column.data_type !== undefined ? column.data_type : column.type,
            });
          }
        }

        boundedTables[String(tableName)] = {
          columns: boundedColumns,
          primary_keys: Array.isArray(tableInfo.primary_keys) ? [...tableInfo.primary_keys] : [],
        };
      }

      const relationships = Array.isArray(context.relationships) ? context.relationships : [];
      const boundedRelationships = relationships
        .slice(0, this.MAX_CONTEXT_RELATIONSHIPS)
        .filter(rel => rel && typeof rel === "object" && !Array.isArray(rel));

      const businessRelationships = Array.isArray(context.business_relationships) ? context.business_relationships : [];
      const boundedBusinessRelationships = businessRelationships
        .slice(0, this.MAX_CONTEXT_RELATIONSHIPS)
        .filter(rel => rel && typeof rel === "object" && !Array.isArray(rel));

      sources[String(sourceId).trim().toLowerCase()] = {
        source_type: context.source_type || "postgresql",
        catalog_status: context.semantic_catalog_status || { validation_status: "unknown", freshness_status: "unknown" },
        tables: boundedTables,
        relationships: boundedRelationships,
        business_relationships: boundedBusinessRelationships,
        semantic_entities: Object.fromEntries(Object.entries(context.semantic_catalog?.entities || {}).slice(0, this.MAX_CONTEXT_TABLES_PER_SOURCE).map(([table, entity]) => [table, {
          entity_type: entity.entity_type,
          description: entity.description,
          synonyms: entity.synonyms,
          source_qualified_meaning: entity.source_qualified_meaning,
          ordering: entity.ordering,
          provenance: entity.provenance
        }]))
      };
    }

    return {
      sources,
      verified_paths: Object.values(this.contexts).flatMap(context => context.semantic_catalog?.verified_paths || []).slice(0, this.MAX_CONTEXT_RELATIONSHIPS)
    };
  }

  _buildContextForLlm() {
    return this._build_context_for_llm();
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

  _build_recent_record_candidates() {
    const candidates = [];

    for (const [sourceId, context] of Object.entries(this.contexts)) {
      const tables = context && typeof context === "object" && !Array.isArray(context) ? (context.tables || {}) : {};
      if (!tables || typeof tables !== "object" || Array.isArray(tables)) {
        continue;
      }

      for (const [tableName, tableInfo] of Object.entries(tables)) {
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
      .filter(sourceId => typeof sourceId === "string" && sourceId.trim())
      .map(sourceId => sourceId.trim().toLowerCase());
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

    const normalized = deepcopy(plan);

    normalized.question = question;
    normalized.data_sources = this._normalize_data_sources(normalized);
    normalized.postgresql_sources = this._normalize_postgresql_sources(normalized);

    // An unresolved business/source ambiguity is a terminal planning state.
    // Do not let the generic schema-anchor fallback attach an unrelated table
    // (for example a table that merely shares a column token) while retaining
    // the ambiguity marker.  The pipeline will turn this into a precise
    // clarification before validation or SQL generation.
    if (
      Array.isArray(normalized.ambiguous_context_candidates) &&
      normalized.ambiguous_context_candidates.length > 1 &&
      normalized.candidate_resolution?.mode !== "independent" &&
      !this._conversation_reference(conversationContext)
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

    // Conversation-qualified plans must be completed before the generic
    // schema-anchor fallback.  Otherwise a follow-up such as "that meeting"
    // can be anchored to an unrelated table that happens to share a token and
    // never receives the established source-qualified entity filter.
    const crossSourceCompleted = this._complete_verified_cross_source_followup(normalized, question, conversationContext);
    const activeCompleted = this._complete_active_context_plan(crossSourceCompleted, question, conversationContext);
    const completed = this._complete_schema_anchor_plan(activeCompleted, question);

    completed.relationships = this._normalize_relationships(
      completed.relationships ?? []
    );

    completed.filters = this._normalize_filters(
      completed.filters ?? []
    );
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
          completed.filters.push({ table, column, operator: "=", value });
        }
      }
    }
    this._apply_active_relationship_context(completed, conversationContext, question);
    this._apply_active_context_to_execution_plan(completed, conversationContext);
    const statusSafePlan = this._ensure_verified_status_filter(completed, question);
    if (statusSafePlan !== completed) return statusSafePlan;

    completed.operations = this._normalize_operations(
      completed.operations ?? []
    );

    completed.requested_metrics = this._normalize_requested_metrics(
      completed.requested_metrics ?? []
    );

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

    completed.entities = this._normalize_entities(
      completed.entities ?? []
    );

    completed.needs_conversation_context = Boolean(
      completed.needs_conversation_context ?? false
    );

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

  _ensure_verified_status_filter(plan, question) {
    if (!plan || typeof plan !== "object") return plan;
    const statusCandidate = { columns: [] };
    for (const table of Array.isArray(plan.required_tables) ? plan.required_tables : []) {
      for (const context of Object.values(this.contexts || {})) {
        statusCandidate.columns.push(...(context?.tables?.[table]?.columns || []).map(column => String(column?.name || column || "")));
      }
    }
    const countIntent = /\b(?:count|how\s+many|number\s+of|total)\b/i.test(String(question || ""));
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
          (countIntent ? this._discovered_categorical_filter(candidate, question) : null);
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
          (countIntent ? this._discovered_categorical_filter(candidate, question) : null);
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
        } else if (statusIntent && !verified && !hasStatusFilter && columns.some(column => /^(status|state|workflow_state|lifecycle_state)$/i.test(column))) {
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
          String(value).trim().toLowerCase() === String(filter.value ?? "").trim().toLowerCase()
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
    const stableKeys = active.stable_keys && typeof active.stable_keys === "object" ? active.stable_keys : {};
    if (!Object.keys(stableKeys).length) return plan;
    const safeColumns = (tableInfo.columns || []).map(column => String(column?.name || column || "")).filter(column => column && !isSensitiveFieldName(column)).slice(0, 20);
    if (!safeColumns.length) return plan;
    return { ...plan, data_sources: ["postgresql"], postgresql_sources: [sourceId], required_tables: [table], required_columns: safeColumns.map(column => `${table}.${column}`), filters: Object.entries(stableKeys).map(([column, value]) => ({ table, field: column, operator: "=", value })), operations: ["lookup"], needs_conversation_context: true, confidence: Math.max(Number(plan.confidence || 0), 0.8), reasoning: "A uniquely established conversation entity was used for a bounded, source-qualified detail lookup." };
  }

  _complete_verified_cross_source_followup(plan, question, conversationContext) {
    const active = this._conversation_reference(conversationContext);
    const refersBack = /\b(?:it|its|that|this|those|these|related)\b/i.test(question);
    if (!active || !refersBack) return plan;

    const sourceId = String(active.source_id || "").trim().toLowerCase();
    const activeTable = String(active.table || "").trim();
    const stableKeys = active.stable_keys && typeof active.stable_keys === "object" ? active.stable_keys : {};
    const explicitMultiSource = /\b(?:both|combine|across|db1|db2|sources?)\b/i.test(question);
    const hasDirectSameSourceTarget = findSemanticCandidates(question, this.contexts, [sourceId]).some(candidate =>
      candidate.table !== activeTable && (this.contexts?.[sourceId]?.relationships || []).some(rel =>
        (rel.source_table === activeTable && rel.target_table === candidate.table) ||
        (rel.target_table === activeTable && rel.source_table === candidate.table)
      )
    );
    // Prefer the shortest verified same-source relationship unless the user
    // explicitly asks to combine sources. This avoids expanding a simple
    // meeting-to-project question into an unnecessary DB1 dependency chain.
    if (!explicitMultiSource && hasDirectSameSourceTarget) return plan;
    const paths = findVerifiedPaths(question, this.contexts, null, { active });
    const path = paths.find(candidate => candidate.steps[0]?.source_id === sourceId && candidate.steps[0]?.table === activeTable);
    if (!path || !Object.keys(stableKeys).length) return plan;

    const distinctSources = new Set(path.steps.map(step => step.source_id));
    if (distinctSources.size < 2) return plan;
    const first = path.steps[0];
    const stableColumn = Object.keys(stableKeys).find(column => (this.contexts[sourceId]?.tables?.[activeTable]?.columns || []).some(item => String(item?.name || item) === column));
    if (!stableColumn) return plan;
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
      const filters = index === 0 ? [{ table: node.table, field: stableColumn, operator: "=", value: stableKeys[stableColumn] }] : [];
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
      postgresql_sources: ["db1", "db2"],
      required_tables: [], required_columns: [], relationships: [], filters: [], operations: ["lookup"],
      execution_plan: { mode: "multi_step", steps, final_step: `s${steps.length}` },
      semantic_path: path.steps,
      ambiguous_context_candidates: [],
      needs_conversation_context: true,
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
      const relationship = (this.contexts?.[previousSource]?.relationships || []).find(item =>
        (item.source_table === previous.table && item.target_table === current.table) ||
        (item.target_table === previous.table && item.source_table === current.table)
      );
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
    const stableKeys = active.stable_keys && typeof active.stable_keys === "object" ? active.stable_keys : {};
    // If the target carries the same discovered key, bind that key directly.
    // Returning unchanged here used to drop the meeting constraint entirely
    // for transcript follow-ups.
    const directTarget = targetTables.find(table => Object.keys(stableKeys).some(column => (context.tables?.[table]?.columns || []).some(col => String(col?.name || col).toLowerCase() === String(column).toLowerCase())));
    if (directTarget) {
      for (const [column, value] of Object.entries(stableKeys)) {
        const exists = (context.tables?.[directTarget]?.columns || []).some(col => String(col?.name || col).toLowerCase() === String(column).toLowerCase());
        if (exists && !(plan.filters || []).some(filter => String(filter.table || "").toLowerCase() === String(directTarget).toLowerCase() && String(filter.field || filter.column || "").toLowerCase() === String(column).toLowerCase())) {
          plan.filters.push({ table: directTarget, field: column, operator: "=", value });
        }
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
          source_id: "db1",
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
            item => item && typeof item === "object" && item.valid !== false
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
