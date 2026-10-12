import { test } from "node:test";
import assert from "node:assert";
import { loadWorkspaceAuthorization, resolveAuthorizedWorkspace, assertAuthorizedSources } from "../auth/authorization.js";
import { ConversationStore } from "../context/conversation_store.js";
import { SourceRouter } from "../planning/source_router.js";

const policyJson = JSON.stringify({ alice: { "workspace-a": { postgresql_sources: ["db1"], security_resources: [] } } });

test("workspace authorization is server-owned and fails closed", () => {
  const policy = loadWorkspaceAuthorization(policyJson);
  const authorization = resolveAuthorizedWorkspace("alice", "workspace-a", policy);
  assert.deepStrictEqual(authorization.postgresql_sources, ["db1"]);
  assert.throws(() => resolveAuthorizedWorkspace("mallory", "workspace-a", policy), { statusCode: 403 });
  assert.throws(() => assertAuthorizedSources(authorization, ["db2"]), { statusCode: 403 });
});

test("conversation state is isolated by principal and workspace", () => {
  const store = new ConversationStore();
  const first = store.getOrCreate({ principal: "alice", workspaceId: "workspace-a" });
  first.conversation.context_manager.setActiveContext({ entity_id: "one" });
  const same = store.getOrCreate({ conversationId: first.conversation.id, principal: "alice", workspaceId: "workspace-a" });
  assert.strictEqual(same.conversation.context_manager.getActiveContext().entity_id, "one");
  assert.throws(() => store.getOrCreate({ conversationId: first.conversation.id, principal: "bob", workspaceId: "workspace-a" }), { statusCode: 404 });
  const second = store.getOrCreate({ principal: "alice", workspaceId: "workspace-a" });
  assert.strictEqual(second.conversation.context_manager.getActiveContext(), null);
});

test("source router reads execution_plan source IDs instead of query_plan only", () => {
  const router = new SourceRouter({ db1: { tables: { alpha: { columns: [] } } }, db2: { tables: { beta: { columns: [] } } } });
  const result = router.route({ data_sources: ["postgresql"], postgresql_sources: [], execution_plan: { steps: [{ source_id: "db2" }] } });
  assert.deepStrictEqual(result.postgresql_sources, ["db2"]);
});
