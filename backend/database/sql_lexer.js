/**
 * Minimal PostgreSQL lexer used by the SQL safety guards.
 *
 * Why it exists: the guards must look at SQL *structure* (keywords, statement
 * separators, comments) and must never react to the *data* inside a string
 * literal. Generated SQL inlines user text as quoted literals, for example
 * ILIKE '%update the milestone%', so scanning the raw string produces false
 * positives (and comment stripping before literal masking can even hide real
 * code). This lexer splits the SQL into code / literal / identifier / comment
 * segments first, so every check can run on the right segments only.
 *
 * Handles: '...' with '' escapes, E'...' with backslash escapes, $tag$...$tag$,
 * "quoted identifiers" with "" escapes, -- line comments, nested block comments.
 * Unterminated constructs throw (fail closed).
 */

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

function unterminated(what) {
  return new Error(`Blocked: unterminated ${what} in SQL.`);
}

/**
 * Split SQL into ordered segments: { type: "code"|"literal"|"identifier"|"comment", text }.
 * Joining every segment's text reproduces the input exactly.
 */
export function tokenizeSql(sql) {
  if (typeof sql !== "string") {
    throw new Error("SQL must be a string.");
  }

  const segments = [];
  const n = sql.length;
  let i = 0;
  let codeStart = 0;

  const pushCode = (end) => {
    if (end > codeStart) {
      segments.push({ type: "code", text: sql.slice(codeStart, end) });
    }
  };
  const pushSpecial = (type, start, end) => {
    pushCode(start);
    segments.push({ type, text: sql.slice(start, end) });
    i = end;
    codeStart = end;
  };

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    // -- line comment
    if (ch === "-" && next === "-") {
      let j = i + 2;
      while (j < n && sql[j] !== "\n") j++;
      pushSpecial("comment", i, j);
      continue;
    }

    // /* block comment */ (PostgreSQL allows nesting)
    if (ch === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      if (depth > 0) throw unterminated("block comment");
      pushSpecial("comment", i, j);
      continue;
    }

    // 'string literal' (and E'...' with backslash escapes)
    if (ch === "'") {
      const prev = i > 0 ? sql[i - 1] : "";
      const beforePrev = i > 1 ? sql[i - 2] : "";
      const isEscapeString = (prev === "E" || prev === "e") && !(beforePrev && IDENT_CHAR.test(beforePrev));
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const c = sql[j];
        if (isEscapeString && c === "\\") {
          j += 2;
          continue;
        }
        if (c === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        j++;
      }
      if (!closed) throw unterminated("string literal");
      pushSpecial("literal", i, j);
      continue;
    }

    // "quoted identifier"
    if (ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        j++;
      }
      if (!closed) throw unterminated("quoted identifier");
      pushSpecial("identifier", i, j);
      continue;
    }

    // $tag$ ... $tag$ dollar-quoted string ($1 style parameters do not match)
    if (ch === "$" && !(i > 0 && IDENT_CHAR.test(sql[i - 1]))) {
      const m = DOLLAR_TAG.exec(sql.slice(i, i + 130));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        if (close === -1) throw unterminated("dollar-quoted string");
        pushSpecial("literal", i, close + tag.length);
        continue;
      }
    }

    i++;
  }

  pushCode(n);
  return segments;
}

/**
 * Return SQL with only its structure left: comments become a space, string
 * literals become '', and (unless keepQuotedIdentifiers) "quoted identifiers"
 * become "". Use this for keyword / statement-separator scans.
 */
export function maskSql(sql, { keepQuotedIdentifiers = false } = {}) {
  return tokenizeSql(sql)
    .map((segment) => {
      switch (segment.type) {
        case "comment":
          return " ";
        case "literal":
          return "''";
        case "identifier":
          return keepQuotedIdentifiers ? segment.text : '""';
        default:
          return segment.text;
      }
    })
    .join("");
}

/** Remove comments only; literals and identifiers are left untouched. */
export function stripComments(sql) {
  return tokenizeSql(sql)
    .map((segment) => (segment.type === "comment" ? " " : segment.text))
    .join("");
}

/** Apply fn to code segments only, leaving literals/identifiers/comments untouched. */
export function mapSqlCode(sql, fn) {
  return tokenizeSql(sql)
    .map((segment) => (segment.type === "code" ? fn(segment.text) : segment.text))
    .join("");
}

export default {
  tokenizeSql,
  maskSql,
  stripComments,
  mapSqlCode
};
