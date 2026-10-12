import { test } from "node:test";
import assert from "node:assert";
import { QuestionPlanValidator } from "../planning/question_plan_validator.js";
import { SecurityLogClient } from "../security_logs/client.js";
import { getContextFreshness } from "../context/context_store.js";

test("plan validation rejects undiscovered relationships instead of silently dropping them", () => {
  const validator = new QuestionPlanValidator({ db1: { tables: { a: { columns: [{ name: "id" }] }, b: { columns: [{ name: "id" }] } }, relationships: [] } });
  const result = validator.validate({ question: "test", data_sources: ["postgresql"], postgresql_sources: ["db1"], required_tables: ["a", "b"], required_columns: [], relationships: [{ source_table: "a", source_column: "id", target_table: "b", target_column: "id" }], operations: ["lookup"] });
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(error => error.includes("undiscovered relationship")));
});

test("security cache returns explicit cache age metadata", () => {
  const client = new SecurityLogClient();
  client.cache_enabled = true;
  client._cache_set("fixture", { data: { events: [] } }, 30);
  const cached = client._cache_get("fixture");
  assert.strictEqual(cached.value.data.events.length, 0);
  assert.strictEqual(typeof cached.cache_age_ms, "number");
});

test("context freshness never claims a snapshot without a timestamp is fresh", () => {
  assert.strictEqual(getContextFreshness({}).freshness_status, "unknown");
  assert.strictEqual(getContextFreshness({ snapshot: { generated_at: new Date(0).toISOString() } }, 1, 2).freshness_status, "stale");
});
