import { sanitize_output_text } from "./output_security_policy.js";
import { is_sensitive_field_name } from "./sensitive_data_policy.js";

/**
 * Evidence security layer for the Context Layer.
 *
 * Purpose:
 * - Protect retrieved evidence before it reaches the LLM.
 * - Protect retrieved evidence before it is returned by the API.
 * - Remove sensitive PostgreSQL fields from retrieved rows.
 * - Redact credential-like values inside security-log payloads.
 * - Preserve normal business data and provenance.
 *
 * This module does not access or modify any database.
 */

function deepClone(obj) {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (obj instanceof Date) {
    return new Date(obj.getTime());
  }
  if (Array.isArray(obj)) {
    return obj.map(deepClone);
  }
  const cloned = {};
  for (const [k, v] of Object.entries(obj)) {
    cloned[k] = deepClone(v);
  }
  return cloned;
}

/**
 * Remove sensitive fields from PostgreSQL result rows.
 *
 * The SQL layer already blocks sensitive field references.
 * This is an additional defense in depth in case a protected
 * value reaches the evidence layer unexpectedly.
 */
export function _sanitize_postgresql_rows(rows) {
  if (!Array.isArray(rows)) {
    return [];
  }

  const sanitized_rows = [];

  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }

    const sanitized_row = {};

    for (const [column_name, value] of Object.entries(row)) {
      if (is_sensitive_field_name(column_name)) {
        continue;
      }

      sanitized_row[column_name] = _sanitize_value(value);
    }

    sanitized_rows.push(sanitized_row);
  }

  return sanitized_rows;
}

export const sanitizePostgresqlRows = _sanitize_postgresql_rows;

/**
 * Recursively sanitize arbitrary retrieved values.
 *
 * Strings are passed through the credential-value redaction policy.
 * Dictionaries and lists are recursively sanitized.
 * Other primitive values are preserved unchanged.
 */
export function _sanitize_value(value) {
  if (typeof value === "string") {
    return sanitize_output_text(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => _sanitize_value(item));
  }

  if (value && typeof value === "object" && !(value instanceof Date) && !(value instanceof RegExp)) {
    const sanitizedObj = {};
    for (const [key, item] of Object.entries(value)) {
      sanitizedObj[key] = _sanitize_value(item);
    }
    return sanitizedObj;
  }

  return value;
}

export const sanitizeValue = _sanitize_value;

/**
 * Sanitize a PostgreSQL retrieval result.
 *
 * Sensitive result columns are removed from rows.
 * Provenance and metadata are preserved.
 */
export function sanitize_postgresql_retrieval(retrieval) {
  if (!retrieval || typeof retrieval !== "object" || Array.isArray(retrieval)) {
    return {};
  }

  const sanitized = deepClone(retrieval);

  if ("rows" in sanitized && Array.isArray(sanitized.rows)) {
    sanitized.rows = _sanitize_postgresql_rows(sanitized.rows);
  }

  if ("columns" in sanitized && Array.isArray(sanitized.columns)) {
    sanitized.columns = sanitized.columns.filter(
      (column) => !is_sensitive_field_name(column)
    );
  }

  return _sanitize_value(sanitized);
}

export const sanitizePostgresqlRetrieval = sanitize_postgresql_retrieval;

/**
 * Sanitize security/SIEM retrieval data.
 *
 * Security events may contain credentials or secrets inside
 * arbitrary message fields, so recursive value sanitization
 * is required.
 *
 * The structure and provenance are preserved.
 */
export function sanitize_security_logs_retrieval(retrieval) {
  if (!retrieval || typeof retrieval !== "object" || Array.isArray(retrieval)) {
    return {};
  }

  const sanitized = deepClone(retrieval);

  return _sanitize_value(sanitized);
}

export const sanitizeSecurityLogsRetrieval = sanitize_security_logs_retrieval;

/**
 * Sanitize the complete evidence object before it is supplied
 * to the LLM or returned through the API.
 *
 * PostgreSQL retrievals receive field-level protection.
 * Security-log retrievals receive recursive value-level protection.
 * Unknown evidence structures are recursively sanitized without being discarded.
 */
export function sanitize_evidence(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return {};
  }

  const sanitized = deepClone(evidence);

  const postgresql_retrieval = sanitized.postgresql_retrieval;
  if (postgresql_retrieval && typeof postgresql_retrieval === "object" && !Array.isArray(postgresql_retrieval)) {
    sanitized.postgresql_retrieval = sanitize_postgresql_retrieval(postgresql_retrieval);
  }

  const postgresql_retrievals = sanitized.postgresql_retrievals;
  if (postgresql_retrievals && typeof postgresql_retrievals === "object" && !Array.isArray(postgresql_retrievals)) {
    const updated = {};
    for (const [source_id, retrieval] of Object.entries(postgresql_retrievals)) {
      updated[source_id] = sanitize_postgresql_retrieval(retrieval);
    }
    sanitized.postgresql_retrievals = updated;
  }

  const security_logs_retrieval = sanitized.security_logs_retrieval;
  if (security_logs_retrieval && typeof security_logs_retrieval === "object" && !Array.isArray(security_logs_retrieval)) {
    sanitized.security_logs_retrieval = sanitize_security_logs_retrieval(security_logs_retrieval);
  }

  return _sanitize_value(sanitized);
}

export const sanitizeEvidence = sanitize_evidence;

/**
 * Final security boundary for the API response.
 *
 * This ensures that raw evidence and retrieval payloads
 * cannot bypass the evidence-security layer.
 */
export function sanitize_api_response(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return {};
  }

  const sanitized = deepClone(response);

  if ("evidence" in sanitized && sanitized.evidence && typeof sanitized.evidence === "object") {
    sanitized.evidence = sanitize_evidence(sanitized.evidence);
  }

  if (
    "postgresql_retrieval" in sanitized &&
    sanitized.postgresql_retrieval &&
    typeof sanitized.postgresql_retrieval === "object"
  ) {
    sanitized.postgresql_retrieval = sanitize_postgresql_retrieval(sanitized.postgresql_retrieval);
  }

  if (
    "postgresql_retrievals" in sanitized &&
    sanitized.postgresql_retrievals &&
    typeof sanitized.postgresql_retrievals === "object" &&
    !Array.isArray(sanitized.postgresql_retrievals)
  ) {
    const updated = {};
    for (const [source_id, retrieval] of Object.entries(sanitized.postgresql_retrievals)) {
      updated[source_id] = sanitize_postgresql_retrieval(retrieval);
    }
    sanitized.postgresql_retrievals = updated;
  }

  if (
    "security_logs_retrieval" in sanitized &&
    sanitized.security_logs_retrieval &&
    typeof sanitized.security_logs_retrieval === "object"
  ) {
    sanitized.security_logs_retrieval = sanitize_security_logs_retrieval(sanitized.security_logs_retrieval);
  }

  return _sanitize_value(sanitized);
}

export const sanitizeApiResponse = sanitize_api_response;

export default {
  _sanitize_postgresql_rows,
  sanitizePostgresqlRows,
  _sanitize_value,
  sanitizeValue,
  sanitize_postgresql_retrieval,
  sanitizePostgresqlRetrieval,
  sanitize_security_logs_retrieval,
  sanitizeSecurityLogsRetrieval,
  sanitize_evidence,
  sanitizeEvidence,
  sanitize_api_response,
  sanitizeApiResponse,
};
