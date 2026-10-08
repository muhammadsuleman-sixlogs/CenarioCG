import { test } from "node:test";
import assert from "node:assert";
import { validateReadOnlyQuery } from "../database/readonly_guard.js";

test("ReadOnlyGuard allows safe SELECT and WITH queries", () => {
  assert.doesNotThrow(() => {
    validateReadOnlyQuery("SELECT id, title FROM project_details;");
  });

  assert.doesNotThrow(() => {
    validateReadOnlyQuery("WITH latest_tasks AS (SELECT id FROM project_tasks) SELECT * FROM latest_tasks;");
  });
});

test("ReadOnlyGuard blocks mutating operations", () => {
  assert.throws(() => {
    validateReadOnlyQuery("INSERT INTO project_details (title) VALUES ('test');");
  }, /Blocked/);

  assert.throws(() => {
    validateReadOnlyQuery("UPDATE project_details SET title = 'hacked';");
  }, /Blocked/);

  assert.throws(() => {
    validateReadOnlyQuery("DELETE FROM project_details WHERE id = 1;");
  }, /Blocked/);

  assert.throws(() => {
    validateReadOnlyQuery("DROP TABLE project_details;");
  }, /Blocked/);

  assert.throws(() => {
    validateReadOnlyQuery("ALTER TABLE project_details ADD COLUMN hacked text;");
  }, /Blocked/);

  assert.throws(() => {
    validateReadOnlyQuery("TRUNCATE TABLE project_details;");
  }, /Blocked/);
});

test("ReadOnlyGuard blocks multiple statements", () => {
  assert.throws(() => {
    validateReadOnlyQuery("SELECT id FROM project_details; DROP TABLE users;");
  }, /multiple SQL statements/);
});

test("ReadOnlyGuard blocks row-locking FOR UPDATE queries", () => {
  assert.throws(() => {
    validateReadOnlyQuery("SELECT id FROM project_details FOR UPDATE;");
  }, /row-locking/);
});
