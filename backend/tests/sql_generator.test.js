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
  assert.ok(sql.includes("COUNT(*) AS count"), "Query must include COUNT aggregate");
});
