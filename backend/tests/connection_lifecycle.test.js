import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { checkoutReadOnlyClient } from "../database/connection.js";

function fakeClient({ failOnQuery = null } = {}) {
  const client = new EventEmitter();
  client.calls = [];
  client.releases = [];
  let active = 0;
  client.maxActive = 0;
  client.query = async (sql) => {
    active += 1;
    client.maxActive = Math.max(client.maxActive, active);
    client.calls.push(sql);
    await Promise.resolve();
    active -= 1;
    if (failOnQuery && sql.includes(failOnQuery)) throw new Error("initialization failed");
    return { rows: [] };
  };
  client.release = (error) => client.releases.push(error || null);
  return client;
}

test("read-only checkout initializes session serially before a caller can query", async () => {
  const client = fakeClient();
  const checkedOut = await checkoutReadOnlyClient({ async connect() { return client; } });
  assert.equal(checkedOut, client);
  assert.equal(client.maxActive, 1);
  assert.deepEqual(client.calls, [
    "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;",
    "SET default_transaction_read_only = on;"
  ]);
  checkedOut.release();
  checkedOut.release();
  assert.deepEqual(client.releases, [null]);
});

test("failed read-only initialization discards the checked-out client", async () => {
  const client = fakeClient({ failOnQuery: "default_transaction_read_only" });
  await assert.rejects(() => checkoutReadOnlyClient({ async connect() { return client; } }), /initialization failed/);
  assert.equal(client.releases.length, 1);
  assert.match(client.releases[0].message, /initialization failed/);
});

test("checked-out ECONNRESET is handled and discards the client without a double release", async () => {
  const client = fakeClient();
  const checkedOut = await checkoutReadOnlyClient({ async connect() { return client; } });
  const reset = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
  checkedOut.emit("error", reset);
  checkedOut.release();
  assert.equal(client.releases.length, 1);
  assert.equal(client.releases[0], reset);
});
