import test from "node:test";
import assert from "node:assert/strict";

import { validateReadOnlyQuery } from "../database/readonly_guard.js";
import { validate_sql_syntax } from "../retrieval/sql_validator.js";
import { maskSql, mapSqlCode } from "../database/sql_lexer.js";

function passesBoth(sql) {
  validateReadOnlyQuery(sql);
  validate_sql_syntax(sql);
}

function blockedByEither(sql) {
  let blocked = false;
  try {
    validateReadOnlyQuery(sql);
  } catch {
    blocked = true;
  }
  try {
    validate_sql_syntax(sql);
  } catch {
    blocked = true;
  }
  return blocked;
}

// ---- Text inside literals is data, never commands --------------------------

const SAFE_TEXT_QUERIES = [
  "SELECT id, title FROM project_milestones WHERE title ILIKE '%update the milestone%'",
  "SELECT id FROM tickets WHERE title ILIKE '%to do%'",
  "SELECT id FROM meeting_summaries WHERE summary ILIKE '%call%' OR summary ILIKE '%release%'",
  "SELECT id FROM tickets WHERE description ILIKE '%delete old files%'",
  "SELECT id FROM tickets WHERE title ILIKE '%drop table%'",
  "SELECT id FROM tickets WHERE title ILIKE '%commit and begin and rollback%'",
  "SELECT id FROM tickets WHERE title ILIKE '%for update%'",
  "SELECT id FROM tickets WHERE title ILIKE '%a; b%'",
  "SELECT id FROM tickets WHERE title ILIKE '%fix -- later%' AND status = 'open'",
  "SELECT id FROM tickets WHERE title ILIKE '%/* not a comment%'",
  "SELECT id FROM tickets WHERE title = 'it''s time to update; delete; create'",
  "SELECT id FROM tickets WHERE title = E'line\\' update the plan'",
  "SELECT id FROM tickets WHERE title = $$update; delete$$",
  "SELECT id FROM tickets WHERE title = $tag$drop 'x' ; update$tag$",
  'SELECT "id" FROM "tickets" WHERE "title" ILIKE \'%update%\''
];

for (const sql of SAFE_TEXT_QUERIES) {
  test(`allows keyword-like text inside a literal: ${sql.slice(0, 70)}`, () => {
    assert.doesNotThrow(() => passesBoth(sql));
  });
}

// ---- Real writes and tricks are still blocked ------------------------------

const MUST_BLOCK = [
  "UPDATE tickets SET status = 'x'",
  "DELETE FROM tickets",
  "WITH x AS (DELETE FROM tickets RETURNING id) SELECT id FROM x",
  "WITH x AS (UPDATE tickets SET status = 'x' RETURNING id) SELECT id FROM x",
  "SELECT id FROM tickets FOR UPDATE",
  "SELECT id FROM tickets; DROP TABLE tickets",
  "SELECT id FROM tickets WHERE title = 'a'; DELETE FROM tickets",
  "SELECT id FROM tickets WHERE title = 'a' /* hidden */ ; DROP TABLE tickets",
  "SELECT id FROM tickets WHERE title = 'unterminated",
  "SELECT id FROM tickets /* unterminated comment",
  "SELECT pg_sleep(1); COMMIT",
  "SELECT id FROM tickets WHERE title = 'a' -- c\n; DROP TABLE tickets"
];

for (const sql of MUST_BLOCK) {
  test(`still blocks: ${sql.replace(/\n/g, " ").slice(0, 70)}`, () => {
    assert.equal(blockedByEither(sql), true);
  });
}

test("a '--' inside a literal can no longer hide a real statement after it", () => {
  // The old comment stripper removed everything after the '--' inside the
  // literal, so the trailing DROP was invisible to the checks.
  const sql = "SELECT id FROM tickets WHERE title = 'a--' ; DROP TABLE tickets --'";
  assert.equal(blockedByEither(sql), true);
});

test("sensitive columns are still blocked, but searching for the word as text is allowed", () => {
  assert.throws(() => validate_sql_syntax("SELECT password_hash FROM users"), /sensitive/i);
  assert.throws(() => validate_sql_syntax('SELECT "password_hash" FROM "users"'), /sensitive/i);
  assert.doesNotThrow(() =>
    validate_sql_syntax("SELECT id FROM tickets WHERE title ILIKE '%password reset%'")
  );
});

test("wildcard projections are still rejected", () => {
  assert.throws(() => validate_sql_syntax("SELECT * FROM tickets"), /Wildcard/);
  assert.doesNotThrow(() => validate_sql_syntax("SELECT COUNT(*) AS \"count\" FROM tickets"));
});

// ---- Lexer / placeholder behaviour -----------------------------------------

test("maskSql keeps structure and hides literal contents", () => {
  assert.equal(
    maskSql("SELECT a FROM t WHERE b = 'update; x' -- note\n AND c = 1").replace(/\s+/g, " "),
    "SELECT a FROM t WHERE b = '' AND c = 1"
  );
});

test("%s placeholders are rewritten only outside string literals", () => {
  const sql = "SELECT id FROM t WHERE a ILIKE '%sprint review%' AND CAST(b AS text) = ANY(%s) AND c = ANY(%s)";
  let i = 1;
  const out = mapSqlCode(sql, (code) => code.replace(/%s/g, () => `$${i++}`));
  assert.equal(
    out,
    "SELECT id FROM t WHERE a ILIKE '%sprint review%' AND CAST(b AS text) = ANY($1) AND c = ANY($2)"
  );
});

test("$1-style parameters are not mistaken for dollar-quoted strings", () => {
  assert.doesNotThrow(() => passesBoth("SELECT id FROM t WHERE a = $1 AND b = $2"));
});
