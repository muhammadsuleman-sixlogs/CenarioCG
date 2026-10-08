import { test } from "node:test";
import assert from "node:assert";
import { validateSqlSyntax } from "../retrieval/sql_validator.js";

test("SQLValidator allows safe parameterized read-only queries", () => {
  assert.doesNotThrow(() => {
    validateSqlSyntax("SELECT id, title FROM project_details WHERE status = 'active';");
  });

  assert.doesNotThrow(() => {
    validateSqlSyntax("SELECT COUNT(*) AS count FROM project_tasks;");
  });
});

test("SQLValidator blocks wildcard SELECT projections", () => {
  assert.throws(() => {
    validateSqlSyntax("SELECT * FROM users;");
  }, /Wildcard/);

  assert.throws(() => {
    validateSqlSyntax("SELECT users.* FROM users;");
  }, /Wildcard/);
});

test("SQLValidator blocks references to sensitive password columns", () => {
  assert.throws(() => {
    validateSqlSyntax("SELECT users.password FROM users;");
  }, /sensitive or credential/);

  assert.throws(() => {
    validateSqlSyntax("SELECT users.api_key FROM users;");
  }, /sensitive or credential/);
});
