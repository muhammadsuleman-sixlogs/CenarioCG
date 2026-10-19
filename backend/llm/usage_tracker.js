/**
 * Privacy-safe accounting for provider attempts made during one chatbot
 * request.  This module deliberately stores no prompts, evidence, response
 * text, credentials, or provider error messages.
 */

const USAGE_METRICS = ["input_tokens", "output_tokens", "cached_input_tokens"];

function finiteTokenCount(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function firstTokenCount(...values) {
  for (const value of values) {
    const count = finiteTokenCount(value);
    if (count !== null) return count;
  }
  return null;
}

/**
 * Normalize the usage shapes returned by the Responses and Chat Completions
 * APIs.  Missing fields remain null rather than being estimated.
 */
export function extractProviderUsage(response) {
  const usage = response && typeof response === "object" && response.usage && typeof response.usage === "object"
    ? response.usage
    : null;
  const inputDetails = usage?.input_tokens_details || usage?.prompt_tokens_details || {};

  const values = {
    input_tokens: firstTokenCount(usage?.input_tokens, usage?.prompt_tokens),
    output_tokens: firstTokenCount(usage?.output_tokens, usage?.completion_tokens),
    cached_input_tokens: firstTokenCount(
      usage?.cached_input_tokens,
      inputDetails?.cached_tokens,
      inputDetails?.cached_input_tokens
    )
  };

  const reported = usage !== null && USAGE_METRICS.some(metric => values[metric] !== null);
  return {
    values,
    source: reported ? "provider_reported" : "unavailable"
  };
}

function emptyStage() {
  return {
    call_count: 0,
    fallback_attempts: 0,
    provider_reported_calls: 0,
    calls: []
  };
}

export function createLlmUsageTracker(requestId = null) {
  return {
    request_id: requestId || null,
    answer_evidence: null,
    stages: {
      planner: emptyStage(),
      answer: emptyStage()
    }
  };
}

function safeJsonLength(value) {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized.length : 0;
  } catch {
    return 0;
  }
}

function collectRowRepresentations(value, path = [], output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectRowRepresentations(item, path, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;

  for (const [key, item] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (key === "rows" && Array.isArray(item)) {
      for (const row of item) output.push({ row, canonical: false });
      continue;
    }
    if (key === "row" && path.at(-1) === "items") {
      output.push({ row: item, canonical: true });
      continue;
    }
    collectRowRepresentations(item, nextPath, output);
  }
  return output;
}

/**
 * Return privacy-safe structural measurements for answer evidence.  This
 * function stores only counts and character lengths; it never returns row
 * values or prompt text.
 */
export function measureAnswerEvidenceStructure(evidence) {
  const source = evidence && typeof evidence === "object" ? evidence : {};
  const sections = {};
  for (const [key, value] of Object.entries(source)) sections[key] = safeJsonLength(value);

  const representations = collectRowRepresentations(source);
  const seen = new Map();
  for (const item of representations) {
    const fingerprint = safeJsonLength(item.row) + ":" + (() => {
      try { return JSON.stringify(item.row); } catch { return ""; }
    })();
    seen.set(fingerprint, (seen.get(fingerprint) || 0) + 1);
  }

  let duplicateRepresentationCount = 0;
  for (const count of seen.values()) duplicateRepresentationCount += Math.max(0, count - 1);

  const mappings = source.relationship_resolution?.mappings;
  return {
    section_characters: sections,
    evidence_characters: safeJsonLength(source),
    canonical_row_count: Array.isArray(source.items)
      ? source.items.filter(item => item && typeof item === "object" && item.row !== undefined).length
      : 0,
    relationship_mapping_count: Array.isArray(mappings) ? mappings.length : 0,
    duplicate_representation_count: duplicateRepresentationCount,
    row_representation_count: representations.length
  };
}

/**
 * Attach privacy-safe answer-evidence metrics to the request tracker.
 */
export function recordAnswerEvidenceMetrics(tracker, metrics = {}) {
  if (!tracker || typeof tracker !== "object") return;
  const previous = tracker.answer_evidence && typeof tracker.answer_evidence === "object"
    ? tracker.answer_evidence
    : {};
  tracker.answer_evidence = { ...previous, ...metrics };
}

/**
 * Record one actual transport attempt.  The response object itself is never
 * retained; only numeric usage and non-sensitive labels are copied.
 */
export function recordLlmAttempt(tracker, {
  stage,
  transport,
  model,
  response = null,
  status = "success",
  error = null
} = {}) {
  if (!tracker || !tracker.stages || !tracker.stages[stage]) return;

  const stageUsage = tracker.stages[stage];
  const fallback = stageUsage.call_count > 0;
  const providerUsage = extractProviderUsage(response);
  const call = {
    transport: transport || "unknown",
    model: String(response?.model || model || "unknown"),
    status: status || "success",
    fallback,
    usage_source: providerUsage.source,
    input_tokens: providerUsage.values.input_tokens,
    output_tokens: providerUsage.values.output_tokens,
    cached_input_tokens: providerUsage.values.cached_input_tokens
  };

  // Keep only an error class/code, never a provider message that could echo
  // request content or other sensitive details.
  if (error) {
    call.error_name = String(error.name || "Error");
    if (error.code) call.error_code = String(error.code);
  }

  stageUsage.calls.push(call);
  stageUsage.call_count += 1;
  if (fallback) stageUsage.fallback_attempts += 1;
  if (providerUsage.source === "provider_reported") stageUsage.provider_reported_calls += 1;
}

function aggregateMetric(calls, metric) {
  if (calls.length === 0) return { value: 0, status: "no_calls" };
  const known = calls.filter(call => typeof call[metric] === "number");
  if (known.length === calls.length) {
    return { value: known.reduce((sum, call) => sum + call[metric], 0), status: "provider_reported" };
  }
  if (known.length > 0) {
    return { value: null, status: "partial" };
  }
  return { value: null, status: "unavailable" };
}

function stageSnapshot(stageUsage) {
  const calls = stageUsage.calls.map(call => ({ ...call }));
  return {
    call_count: stageUsage.call_count,
    fallback_attempts: stageUsage.fallback_attempts,
    provider_reported_calls: stageUsage.provider_reported_calls,
    calls,
    totals: {
      input_tokens: aggregateMetric(calls, "input_tokens"),
      output_tokens: aggregateMetric(calls, "output_tokens"),
      cached_input_tokens: aggregateMetric(calls, "cached_input_tokens")
    }
  };
}

export function snapshotLlmUsage(tracker) {
  const planner = stageSnapshot(tracker?.stages?.planner || emptyStage());
  const answer = stageSnapshot(tracker?.stages?.answer || emptyStage());
  const allCalls = [...planner.calls, ...answer.calls];
  return {
    request_id: tracker?.request_id || null,
    call_count: allCalls.length,
    fallback_attempts: planner.fallback_attempts + answer.fallback_attempts,
    answer_evidence: tracker?.answer_evidence || null,
    stages: { planner, answer },
    totals: {
      input_tokens: aggregateMetric(allCalls, "input_tokens"),
      output_tokens: aggregateMetric(allCalls, "output_tokens"),
      cached_input_tokens: aggregateMetric(allCalls, "cached_input_tokens")
    },
    estimates: {
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null
    }
  };
}

/**
 * Emit one structured, privacy-safe usage record for a request.  Callers may
 * provide a logger in tests or hosting integrations; no prompt/evidence data
 * is ever included in the record.
 */
export function logLlmUsage(tracker, logger = console.info) {
  const snapshot = snapshotLlmUsage(tracker);
  if (snapshot.call_count > 0 && typeof logger === "function") {
    try {
      logger(`LLM USAGE ${JSON.stringify(snapshot)}`);
    } catch {
      // Usage accounting must never change the chatbot result if logging is
      // unavailable or a host-provided sink fails.
    }
  }
  return snapshot;
}

export default {
  createLlmUsageTracker,
  extractProviderUsage,
  logLlmUsage,
  recordLlmAttempt,
  measureAnswerEvidenceStructure,
  recordAnswerEvidenceMetrics,
  snapshotLlmUsage
};
