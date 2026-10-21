/**
 * Output security policy for the Context Layer.
 *
 * Purpose:
 * - Prevent credential-like values from being returned to users.
 * - Provide a final defense before an LLM answer is returned.
 * - Keep the policy generic and independent of company schema.
 *
 * This module does not access or modify any database.
 */

import crypto from "node:crypto";

// Generic patterns for values that should never be exposed.
// These patterns intentionally target credential-like structures
// rather than ordinary business values.
export const SENSITIVE_VALUE_PATTERNS = [
  // Bearer tokens
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  // Common secret/token assignments
  /\b(?:password|passwd|passcode|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token|client[_-]?secret|credential)\s*[:=]\s*[^\s,;]+/i,
  // Private key blocks
  /-----BEGIN\s+(?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END\s+(?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
];

const GLOBAL_REPLACE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:password|passwd|passcode|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token|client[_-]?secret|credential)\s*[:=]\s*[^\s,;]+/gi,
  /-----BEGIN\s+(?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END\s+(?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi,
];

const PUBLIC_INTERNAL_KEYS = /(?:^|_)(?:sql|query|source_id|source_ids|table|tables|column|columns|sql_columns|primary_key|primary_keys|evidence|plan|retrieval_contract|parameters|raw_rows?|_internal)$/i;

function public_hash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 20);
}

export function opaque_public_ref(kind, value) {
  return `${String(kind || "ref").replace(/[^a-z0-9]+/gi, "_").toLowerCase()}_${public_hash(value)}`;
}

export const opaquePublicRef = opaque_public_ref;

export function public_source_descriptor(sourceId, sourceType = "postgresql", details = {}) {
  const normalized = String(sourceId || "").trim().toLowerCase();
  const type = String(sourceType || "postgresql").trim().toLowerCase();
  const known = {
    db1: { key: "base", label: "Base DB" },
    db2: { key: "companion", label: "Companion DB" },
    security_logs: { key: "security_logs", label: "Security Logs" },
    security_logs_api: { key: "security_logs", label: "Security Logs" }
  };
  const fallback = type === "postgresql"
    ? { key: "database", label: "Database" }
    : { key: "external", label: "External source" };
  const selected = known[normalized] || fallback;

  return {
    source_ref: opaque_public_ref("source", `${type}:${normalized || selected.key}`),
    source_key: selected.key,
    source_label: selected.label,
    source_type: type,
    ...(Number.isFinite(Number(details.row_count)) ? { row_count: Number(details.row_count) } : {}),
    ...(Number.isFinite(Number(details.event_count)) ? { event_count: Number(details.event_count) } : {}),
    ...(details.retrieval_status ? { retrieval_status: String(details.retrieval_status) } : {}),
    ...(details.truncated !== undefined ? { truncated: Boolean(details.truncated) } : {})
  };
}

export const publicSourceDescriptor = public_source_descriptor;

export function project_public_response(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return {};
  }

  const project = (value, key = "") => {
    if (Array.isArray(value)) return value.map(item => project(item, key)).filter(item => item !== undefined);
    if (value && typeof value === "object" && !(value instanceof Date) && !(value instanceof RegExp)) {
      const output = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        if (PUBLIC_INTERNAL_KEYS.test(childKey)) continue;
        const projected = project(childValue, childKey);
        if (projected !== undefined) output[childKey] = projected;
      }
      return output;
    }
    if (typeof value === "string" && PUBLIC_INTERNAL_KEYS.test(key)) return undefined;
    return value;
  };

  return sanitize_sensitive_values(project(response));
}

export const projectPublicResponse = project_public_response;

/**
 * Return true if a value contains a credential-like pattern.
 */
export function contains_sensitive_value(value) {
  if (typeof value !== "string") {
    return false;
  }

  return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

export const containsSensitiveValue = contains_sensitive_value;

/**
 * Remove credential-like values from text before it is returned
 * to the user.
 *
 * This is a final output safety layer.
 *
 * It does not attempt to determine whether ordinary business
 * data is sensitive.
 */
export function sanitize_output_text(text) {
  if (text === null || text === undefined) {
    return "";
  }

  let sanitized = typeof text === "string" ? text : String(text);

  for (const pattern of GLOBAL_REPLACE_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  }

  return sanitized;
}

export const sanitizeOutputText = sanitize_output_text;

/**
 * Reject output containing credential-like values.
 *
 * This function is intentionally stricter than sanitization and
 * should be used when the application wants to fail closed.
 */
export function validate_output_text(text) {
  if (contains_sensitive_value(text)) {
    throw new Error(
      "The generated response contains sensitive or " +
        "credential-like information and cannot be returned."
    );
  }
}

export const validateOutputText = validate_output_text;

/**
 * Recursively sanitize credential-like values inside nested
 * dictionaries, lists, tuples, and strings.
 *
 * Normal business data is preserved.
 *
 * This function does not access or modify any database.
 */
export function sanitize_sensitive_values(value) {
  if (typeof value === "string") {
    return sanitize_output_text(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitize_sensitive_values(item));
  }

  if (value && typeof value === "object" && !(value instanceof Date) && !(value instanceof RegExp)) {
    const sanitizedObj = {};
    for (const [key, item] of Object.entries(value)) {
      sanitizedObj[key] = sanitize_sensitive_values(item);
    }
    return sanitizedObj;
  }

  return value;
}

export const sanitizeSensitiveValues = sanitize_sensitive_values;

/**
 * Sanitize retrieved evidence before it is supplied to the LLM.
 *
 * This is especially important for security/SIEM data because
 * sensitive values may appear inside arbitrary log fields or
 * message text.
 */
export function sanitize_evidence(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return {};
  }

  const stripInternal = value => {
    if (Array.isArray(value)) return value.map(stripInternal);
    if (!value || typeof value !== "object") return value;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "_internal") continue;
      result[key] = stripInternal(item);
    }
    return result;
  };
  const sanitized = stripInternal(sanitize_sensitive_values(evidence));

  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    return {};
  }

  return sanitized;
}

export const sanitizeEvidence = sanitize_evidence;

/**
 * Sanitize the final API response before it is returned to the
 * frontend or another API consumer.
 *
 * This prevents raw retrieval payloads from bypassing the
 * LLM output-security layer.
 */
export function sanitize_api_response(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return {};
  }

  // Keep this compatibility sanitizer focused on credential values. The
  // public chat projection is applied explicitly at the API boundary so
  // internal pipeline callers and tracing retain their established shape.
  const sanitized = sanitize_sensitive_values(response);

  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    return {};
  }

  return sanitized;
}

export const sanitizeApiResponse = sanitize_api_response;

export default {
  SENSITIVE_VALUE_PATTERNS,
  contains_sensitive_value,
  containsSensitiveValue,
  sanitize_output_text,
  sanitizeOutputText,
  validate_output_text,
  validateOutputText,
  sanitize_sensitive_values,
  sanitizeSensitiveValues,
  sanitize_evidence,
  sanitizeEvidence,
  sanitize_api_response,
  sanitizeApiResponse,
};
