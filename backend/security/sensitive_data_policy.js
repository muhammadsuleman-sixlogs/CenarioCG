/**
 * Centralized sensitive-data policy for the Context Layer.
 *
 * Purpose:
 * - Prevent credential/sensitive fields from being exposed to LLM prompts.
 * - Prevent retrieval plans from referencing protected fields.
 * - Provide reusable checks for downstream SQL validation.
 *
 * This policy is generic and does not contain company-specific
 * table names, column names, entities, or business relationships.
 */

// Generic sensitive/credential field patterns.
// These patterns intentionally focus on credential-like fields.
// They are matched against the complete column name.
export const SENSITIVE_FIELD_PATTERNS = [
  "^password.*",
  ".*password.*",
  "^passwd.*",
  "^passcode$",
  "^secret$",
  ".*_secret$",
  "^api[_-]?key$",
  ".*_api[_-]?key$",
  "^access[_-]?token$",
  ".*_access[_-]?token$",
  "^refresh[_-]?token$",
  ".*_refresh[_-]?token$",
  "^auth[_-]?token$",
  ".*_auth[_-]?token$",
  "^bearer[_-]?token$",
  ".*_bearer[_-]?token$",
  "^private[_-]?key$",
  ".*_private[_-]?key$",
  "^client[_-]?secret$",
  ".*_client[_-]?secret$",
  ".*credential.*",
];

const _COMPILED_PATTERNS = SENSITIVE_FIELD_PATTERNS.map(
  (pattern) => new RegExp(pattern, "i")
);

// Patterns for questions requesting sensitive/confidential data directly
export const SENSITIVE_INTENT_PATTERNS = [
  /\b(what|give|show|tell|retrieve|find|get|list|display)\b.*\b(password|passwords|passwd|secret|secrets|token|tokens|api[_-]?key|api[_-]?keys|private[_-]?key|credential|credentials|auth[_-]?token)\b/i,
  /\b(user|admin|account|db|database|system)\s+(password|passwords|token|tokens|secret|secrets)\b/i,
];

/**
 * Return true when a field/column name matches a generic
 * sensitive-data or credential pattern.
 *
 * Examples:
 *     password       -> true
 *     api_key        -> true
 *     access_token   -> true
 *     client_secret  -> true
 *     username       -> false
 *     email          -> false
 */
export function is_sensitive_field_name(fieldName) {
  if (typeof fieldName !== "string") {
    return false;
  }

  const normalized = fieldName.trim();
  if (!normalized) {
    return false;
  }

  return _COMPILED_PATTERNS.some((pattern) => pattern.test(normalized));
}

export const isSensitiveFieldName = is_sensitive_field_name;

/**
 * Return true when a table.column reference points to a
 * sensitive field.
 *
 * Expected format:
 *     table.column
 *
 * Examples:
 *     users.password       -> true
 *     accounts.api_key     -> true
 *     users.email          -> false
 */
export function is_sensitive_field_reference(fieldReference) {
  if (typeof fieldReference !== "string") {
    return false;
  }

  const normalized = fieldReference.trim();
  if (!normalized) {
    return false;
  }

  const parts = normalized.split(".");
  if (parts.length !== 2) {
    return false;
  }

  const [tableName, columnName] = parts;
  if (!tableName.trim() || !columnName.trim()) {
    return false;
  }

  return is_sensitive_field_name(columnName.trim());
}

export const isSensitiveFieldReference = is_sensitive_field_reference;

/**
 * Raise Error when a table.column reference points to
 * a protected sensitive field.
 *
 * This is intended for retrieval-plan validation and other
 * pre-retrieval checks.
 */
export function validate_not_sensitive_field(fieldReference) {
  if (is_sensitive_field_reference(fieldReference)) {
    throw new Error(
      "Access to sensitive or credential fields is not permitted."
    );
  }
}

export const validateNotSensitiveField = validate_not_sensitive_field;

/**
 * Remove sensitive columns from a discovered column collection.
 *
 * This is intended for LLM-facing schema/context construction.
 *
 * The original Context Layer is not modified. A new array is returned.
 */
export function filter_sensitive_columns(columns) {
  if (!Array.isArray(columns)) {
    return [];
  }

  const filteredColumns = [];

  for (const column of columns) {
    if (!column || typeof column !== "object" || Array.isArray(column)) {
      continue;
    }

    const columnName = column.name;
    if (is_sensitive_field_name(columnName)) {
      continue;
    }

    filteredColumns.push(column);
  }

  return filteredColumns;
}

export const filterSensitiveColumns = filter_sensitive_columns;

/**
 * Return a copy of schema context with sensitive column definitions
 * removed before the context is supplied to an LLM.
 *
 * This function does not modify the original context.
 *
 * Expected structure:
 *     {
 *         "tables": {
 *             "table_name": {
 *                 "columns": [...],
 *                 ...
 *             }
 *         },
 *         ...
 *     }
 */
export function sanitize_schema_context(schemaContext) {
  if (!schemaContext || typeof schemaContext !== "object" || Array.isArray(schemaContext)) {
    return {};
  }

  const sanitized = { ...schemaContext };
  const tables = schemaContext.tables;

  if (!tables || typeof tables !== "object" || Array.isArray(tables)) {
    return sanitized;
  }

  const sanitizedTables = {};

  for (const [tableName, tableInfo] of Object.entries(tables)) {
    if (!tableInfo || typeof tableInfo !== "object" || Array.isArray(tableInfo)) {
      continue;
    }

    const sanitizedTable = { ...tableInfo };
    const columns = tableInfo.columns || [];

    sanitizedTable.columns = filter_sensitive_columns(columns);
    sanitizedTables[tableName] = sanitizedTable;
  }

  sanitized.tables = sanitizedTables;
  return sanitized;
}

export const sanitizeSchemaContext = sanitize_schema_context;

/**
 * Direct check for user questions seeking private/confidential credentials.
 * Fails closed immediately to protect security and confidentiality.
 */
export function is_sensitive_question_intent(question) {
  if (!question || typeof question !== "string") {
    return false;
  }
  const trimmed = question.trim();
  return SENSITIVE_INTENT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export const isSensitiveQuestionIntent = is_sensitive_question_intent;

export default {
  SENSITIVE_FIELD_PATTERNS,
  SENSITIVE_INTENT_PATTERNS,
  is_sensitive_field_name,
  isSensitiveFieldName,
  is_sensitive_field_reference,
  isSensitiveFieldReference,
  validate_not_sensitive_field,
  validateNotSensitiveField,
  filter_sensitive_columns,
  filterSensitiveColumns,
  sanitize_schema_context,
  sanitizeSchemaContext,
  is_sensitive_question_intent,
  isSensitiveQuestionIntent,
};
