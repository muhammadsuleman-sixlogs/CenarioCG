export const READ_ONLY_PATTERN = /^\s*(SELECT|WITH)\b/i;

export const BLOCKED_KEYWORDS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|VACUUM|REINDEX|REFRESH|MERGE|CALL|DO|LOCK)\b/i;

export const BLOCKED_COMMENT_PATTERN = /\bCOMMENT\s+ON\b/i;

export const FOR_UPDATE_PATTERN = /\bFOR\s+(UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b/i;

export const TRANSACTION_PATTERN = /\b(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT)\b/i;

export function removeComments(query) {
  if (!query || typeof query !== "string") return "";
  // Remove multi-line comments
  let cleaned = query.replace(/\/\*[\s\S]*?\*\//g, " ");
  // Remove single-line comments
  cleaned = cleaned.replace(/--[^\n]*/g, " ");
  return cleaned;
}

export function hasMultipleStatements(query) {
  if (!query || typeof query !== "string") return false;
  const stripped = query.trim();
  if (!stripped.includes(";")) {
    return false;
  }
  const withoutTrailingSemicolon = stripped.replace(/;+$/, "").trim();
  return withoutTrailingSemicolon.includes(";");
}

/**
 * Allow only read-only SELECT/WITH SQL.
 *
 * Application-level safety guard. PostgreSQL also enforces read-only session characteristics.
 * Throws an Error for anything that could perform a write, schema change, locking, or transaction-control operation.
 */
export function validateReadOnlyQuery(query) {
  if (!query || typeof query !== "string" || !query.trim()) {
    throw new Error("Query cannot be empty.");
  }

  const cleanedQuery = removeComments(query).trim();

  if (!READ_ONLY_PATTERN.test(cleanedQuery)) {
    throw new Error("Blocked: only SELECT/WITH queries are allowed.");
  }

  if (hasMultipleStatements(cleanedQuery)) {
    throw new Error("Blocked: multiple SQL statements are not allowed.");
  }

  if (BLOCKED_COMMENT_PATTERN.test(cleanedQuery)) {
    throw new Error("Blocked: COMMENT ON statements are not allowed.");
  }

  if (FOR_UPDATE_PATTERN.test(cleanedQuery)) {
    throw new Error("Blocked: row-locking queries are not allowed.");
  }

  if (BLOCKED_KEYWORDS.test(cleanedQuery)) {
    throw new Error("Blocked: query contains a forbidden database operation.");
  }

  if (TRANSACTION_PATTERN.test(cleanedQuery)) {
    throw new Error("Blocked: transaction-control statements are not allowed.");
  }

}

export default {
  READ_ONLY_PATTERN,
  BLOCKED_KEYWORDS,
  BLOCKED_COMMENT_PATTERN,
  FOR_UPDATE_PATTERN,
  TRANSACTION_PATTERN,
  removeComments,
  hasMultipleStatements,
  validateReadOnlyQuery
};

