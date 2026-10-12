import { test } from "node:test";
import assert from "node:assert";
import { SQLGenerator } from "../retrieval/sql_generator.js";
import { loadContext } from "../context/context_store.js";

test("SQLGenerator generates valid read-only SELECT query for db1", () => {
  const context = loadContext("db1");
  const tables = Object.keys(context.tables || {});
  assert.ok(tables.length > 0, "db1 should have discovered tables");

  const table = tables[0];
  const columns = (context.tables[table].columns || []).map(c => c.name);
  assert.ok(columns.length > 0, "table should have columns");

  const generator = new SQLGenerator(context, "db1");

  const contract = {
    question: "List first 5 records",
    required_tables: [table],
    required_columns: [`${table}.${columns[0]}`],
    relationships: [],
    filters: [],
    operations: ["lookup"],
    grouping: [],
    sorting: [],
    limit: 5
  };

  const sql = generator.generate(contract, "db1");
  assert.ok(sql.startsWith("SELECT"), "Query must start with SELECT");
  assert.ok(sql.includes(`FROM "${table}"`), "Query must include FROM clause");
  assert.ok(sql.includes("LIMIT 5"), "Query must include LIMIT clause");
});

test("SQLGenerator compiles aggregate COUNT queries", () => {
  const context = loadContext("db1");
  const table = Object.keys(context.tables || {})[0];
  const generator = new SQLGenerator(context, "db1");

  const contract = {
    question: "Count records",
    required_tables: [table],
    required_columns: [],
    relationships: [],
    filters: [],
    operations: ["count"],
    grouping: [],
    sorting: [],
    limit: null
  };

  const sql = generator.generate(contract, "db1");
  assert.ok(/COUNT\(\*\)\s+AS\s+["']?count["']?/i.test(sql), "Query must include COUNT aggregate");
});

test("SQLGenerator omits protected projection columns but keeps permitted user fields", () => {
  const context = loadContext("db1");
  const generator = new SQLGenerator(context, "db1");

  const sql = generator.generate({
    question: "List users",
    required_tables: ["users"],
    required_columns: ["users.id", "users.email", "users.password_hash"],
    relationships: [],
    filters: [],
    operations: ["lookup"],
    grouping: [],
    sorting: [],
    limit: 10,
  }, "db1");

  assert.match(sql, /"users"\."id"/i);
  assert.match(sql, /"users"\."email"/i);
  assert.doesNotMatch(sql, /password_hash/i);
});

test("SQLGenerator omits protected DB2 token projections without rejecting permitted fields", () => {
  const context = loadContext("db2");
  const generator = new SQLGenerator(context, "db2");

  const sql = generator.generate({
    question: "List connected calendar accounts",
    required_tables: ["google_oauth_tokens"],
    required_columns: [
      "google_oauth_tokens.id",
      "google_oauth_tokens.user_email",
      "google_oauth_tokens.access_token",
      "google_oauth_tokens.refresh_token",
    ],
    relationships: [],
    filters: [],
    operations: ["lookup"],
    grouping: [],
    sorting: [],
    limit: 10,
  }, "db2");

  assert.match(sql, /"google_oauth_tokens"\."id"/i);
  assert.match(sql, /"google_oauth_tokens"\."user_email"/i);
  assert.doesNotMatch(sql, /access_token|refresh_token/i);
});

test("SQLGenerator keeps invoice projections safe when a provider includes share tokens", () => {
  const context = loadContext("db1");
  const generator = new SQLGenerator(context, "db1");

  const sql = generator.generate({
    question: "List invoices",
    required_tables: ["invoices"],
    required_columns: [
      "invoices.id",
      "invoices.invoice_number",
      "invoices.public_share_token",
      "invoices.share_password_hash",
    ],
    relationships: [],
    filters: [],
    operations: ["lookup"],
    grouping: [],
    sorting: [],
    limit: 10,
  }, "db1");

  assert.match(sql, /"invoices"\."id"/i);
  assert.match(sql, /"invoices"\."invoice_number"/i);
  assert.doesNotMatch(sql, /public_share_token|share_password_hash/i);
});
