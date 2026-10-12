/**
 * PostgreSQL-aware lexical safety checks.  This is deliberately a small
 * lexer rather than a permissive keyword regexp: literals, quoted
 * identifiers and comments must never be interpreted as executable tokens.
 */
export const READ_ONLY_PATTERN = /^\s*(SELECT|WITH)\b/i;
export const BLOCKED_KEYWORDS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|VACUUM|REINDEX|REFRESH|MERGE|CALL|DO|LOCK)\b/i;
export const BLOCKED_COMMENT_PATTERN = /\bCOMMENT\s+ON\b/i;
export const FOR_UPDATE_PATTERN = /\bFOR\s+(UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b/i;
export const TRANSACTION_PATTERN = /\b(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT)\b/i;

function isTagStart(ch) { return /[A-Za-z_]/.test(ch || ""); }
function isTagChar(ch) { return /[A-Za-z0-9_]/.test(ch || ""); }

/** Return executable SQL only; content in literals/comments is replaced by spaces. */
export function executableSql(query, { preserveQuotedIdentifiers = false } = {}) {
  if (typeof query !== "string") return "";
  let result = "";
  let i = 0;
  const space = (text) => { result += text.replace(/[^\n]/g, " "); };
  while (i < query.length) {
    const ch = query[i];
    const next = query[i + 1];
    if (ch === "-" && next === "-") {
      const end = query.indexOf("\n", i + 2);
      const stop = end === -1 ? query.length : end;
      space(query.slice(i, stop)); i = stop; continue;
    }
    if (ch === "/" && next === "*") {
      const end = query.indexOf("*/", i + 2);
      if (end === -1) throw new Error("Blocked: unterminated SQL comment.");
      space(query.slice(i, end + 2)); i = end + 2; continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < query.length) {
        if (query[j] === "\\" && j + 1 < query.length) { j += 2; continue; }
        if (query[j] === "'" && query[j + 1] === "'") { j += 2; continue; }
        if (query[j] === "'") { j++; break; }
        j++;
      }
      if (j > query.length || query[j - 1] !== "'") throw new Error("Blocked: unterminated SQL string literal.");
      space(query.slice(i, j)); i = j; continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < query.length) {
        if (query[j] === '"' && query[j + 1] === '"') { j += 2; continue; }
        if (query[j] === '"') { j++; break; }
        j++;
      }
      if (j > query.length || query[j - 1] !== '"') throw new Error("Blocked: unterminated quoted identifier.");
      if (preserveQuotedIdentifiers) result += query.slice(i, j);
      else space(query.slice(i, j));
      i = j; continue;
    }
    if (ch === "$" && (next === "$" || isTagStart(next))) {
      let tagEnd = i + 1;
      while (tagEnd < query.length && isTagChar(query[tagEnd])) tagEnd++;
      if (query[tagEnd] === "$") {
        const tag = query.slice(i, tagEnd + 1);
        const end = query.indexOf(tag, tagEnd + 1);
        if (end === -1) throw new Error("Blocked: unterminated PostgreSQL dollar-quoted string.");
        space(query.slice(i, end + tag.length)); i = end + tag.length; continue;
      }
    }
    result += ch; i++;
  }
  return result;
}

export function removeComments(query) { return executableSql(query); }

export function hasMultipleStatements(query) {
  const executable = executableSql(query).trim();
  const withoutTrailing = executable.replace(/;+\s*$/, "").trim();
  return withoutTrailing.includes(";");
}

export function validateReadOnlyQuery(query) {
  if (!query || typeof query !== "string" || !query.trim()) throw new Error("Query cannot be empty.");
  const cleaned = executableSql(query).trim();
  if (!READ_ONLY_PATTERN.test(cleaned)) throw new Error("Blocked: only SELECT/WITH queries are allowed.");
  if (hasMultipleStatements(query)) throw new Error("Blocked: multiple SQL statements are not allowed.");
  if (FOR_UPDATE_PATTERN.test(cleaned)) throw new Error("Blocked: row-locking queries are not allowed.");
  if (BLOCKED_COMMENT_PATTERN.test(cleaned) || BLOCKED_KEYWORDS.test(cleaned) || TRANSACTION_PATTERN.test(cleaned)) {
    throw new Error("Blocked: query contains a forbidden database operation.");
  }
  // SELECT can invoke volatile functions. The catalog is unavailable at this layer,
  // so reject only known side-effecting PostgreSQL built-ins; all queries still run
  // in an enforced read-only session with least-privilege credentials.
  if (/\b(?:pg_(?:sleep|terminate_backend|cancel_backend|reload_conf|rotate_logfile)|dblink_connect|lo_import|lo_export)\s*\(/i.test(cleaned)) {
    throw new Error("Blocked: query invokes a potentially side-effecting function.");
  }
}

export default { READ_ONLY_PATTERN, BLOCKED_KEYWORDS, BLOCKED_COMMENT_PATTERN, FOR_UPDATE_PATTERN, TRANSACTION_PATTERN, executableSql, removeComments, hasMultipleStatements, validateReadOnlyQuery };
