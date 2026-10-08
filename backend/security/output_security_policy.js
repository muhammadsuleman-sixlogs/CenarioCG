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

  const sanitized = sanitize_sensitive_values(evidence);

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
