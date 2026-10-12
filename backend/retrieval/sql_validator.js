import { isSensitiveFieldName } from "../security/sensitive_data_policy.js";
import { executableSql, hasMultipleStatements } from "../database/readonly_guard.js";

/**
 * Remove SQL comments while preserving structure.
 */
function removeComments(query) {
  return executableSql(query, { preserveQuotedIdentifiers: true });
}

/**
 * Mask string literals to prevent values inside quotes from triggering column checks.
 */
function maskStringLiterals(query) {
  // executableSql already masks single/dollar quoted text, quoted identifiers,
  // and comments without losing executable identifier tokens.
  return executableSql(query, { preserveQuotedIdentifiers: true });
}

export function _validate_no_sensitive_fields(query) {
  const unquoted = maskStringLiterals(removeComments(query));

  // Inspect column references: e.g. "table"."col", table.col, or standalone col
  const qualifiedPattern = /(?:["`]?([a-zA-Z0-9_]+)["`]?\.)?["`]?([a-zA-Z0-9_]+)["`]?/g;
  let match;
  while ((match = qualifiedPattern.exec(unquoted)) !== null) {
    const tableName = match[1];
    const colName = match[2];
    if (colName && isSensitiveFieldName(colName)) {
      const fieldRef = tableName ? `${tableName}.${colName}` : colName;
      throw new Error(`Access to sensitive or credential fields is not permitted: ${fieldRef}`);
    }
  }

  // Reject wildcard projections such as SELECT *, SELECT table.* (COUNT(*) is safe)
  const countSafe = unquoted.replace(/\bCOUNT\s*\(\s*\*\s*\)/gi, "COUNT_STAR_SAFE");
  if (
    /\bSELECT\s+(?:DISTINCT\s+)?(?:\w+\.)?\*/i.test(countSafe) ||
    /,\s*(?:\w+\.)?\*/i.test(countSafe)
  ) {
    throw new Error(
      "Wildcard SELECT projections are not permitted because they may retrieve sensitive fields."
    );
  }
}

export function validate_sql_syntax(query) {
  if (!query || typeof query !== "string" || !query.trim()) {
    throw new Error("SQL query cannot be empty.");
  }

  const cleaned = removeComments(query).trim();

  if (hasMultipleStatements(cleaned)) {
    throw new Error("SQL must contain exactly one statement.");
  }

  if (!/^\s*(SELECT|WITH|UNION)\b/i.test(cleaned)) {
    throw new Error("Only SELECT/WITH queries are allowed.");
  }

  _validate_no_sensitive_fields(cleaned);
}

export function validateSqlSyntax(query) {
  return validate_sql_syntax(query);
}

export default {
  validate_sql_syntax,
  validateSqlSyntax,
  _validate_no_sensitive_fields,
};
