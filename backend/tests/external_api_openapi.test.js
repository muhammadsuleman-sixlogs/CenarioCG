import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverOpenApiContext, parseExternalApiSources } from "../external_api/openapi.js";
import { ExternalApiClient } from "../external_api/client.js";
import { assertAuthorizedExternalApiOperation, loadWorkspaceAuthorization, resolveAuthorizedWorkspace } from "../auth/authorization.js";
import { QuestionPlanValidator } from "../planning/question_plan_validator.js";
import { refreshContextGeneration } from "../context/context_refresh.js";

const rawRegistration = JSON.stringify({
  inventory_api: {
    type: "openapi",
    baseUrl: "https://api.example.test",
    specUrl: "https://api.example.test/openapi.json",
    auth: { type: "bearer_env", secretEnv: "INVENTORY_API_TOKEN" },
    allowedOperations: ["listInventory"],
    timeoutMs: 1000,
    maxResults: 10,
    maxPages: 1,
    maxRetries: 1
  }
});

const safeSpec = {
  openapi: "3.0.3",
  servers: [{ url: "https://api.example.test" }],
  paths: {
    "/inventory": {
      get: {
        operationId: "listInventory",
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      name: { type: "string" },
                      password: { type: "string" }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/danger": { post: { operationId: "deleteEverything" } }
  }
};

function configuration() {
  return parseExternalApiSources(rawRegistration).inventory_api;
}

test("OpenAPI discovery only admits explicitly approved safe GET operations and safe fields", () => {
  const context = discoverOpenApiContext(configuration(), safeSpec);
  assert.deepEqual(Object.keys(context.api_operations), ["listInventory"]);
  assert.deepEqual(context.tables.listInventory.columns.map(column => column.name), ["id", "name"]);
  assert.equal(context.source_type, "external_api");
  assert.equal(JSON.stringify(context).includes("INVENTORY_API_TOKEN"), false);
});

test("OpenAPI discovery fails closed for untrusted origins and no approved operation", () => {
  assert.throws(() => discoverOpenApiContext(configuration(), { ...safeSpec, servers: [{ url: "https://other.example.test" }] }), /origin/i);
  assert.throws(() => discoverOpenApiContext({ ...configuration(), allowedOperations: [] }, safeSpec), /no explicitly approved/i);
  assert.throws(() => parseExternalApiSources(JSON.stringify({ bad: { type: "openapi", baseUrl: "http://example.test", specUrl: "https://example.test/openapi.json", allowedOperations: ["x"] } })), /HTTPS/i);
});

test("external API authorization is source and operation allow-list only", () => {
  const policy = loadWorkspaceAuthorization(JSON.stringify({ alice: { main: { postgresql_sources: [], security_resources: [], external_api_sources: ["inventory_api"], external_api_operations: { inventory_api: ["listInventory"] } } } }));
  const authorization = resolveAuthorizedWorkspace("alice", "main", policy);
  assert.doesNotThrow(() => assertAuthorizedExternalApiOperation(authorization, "inventory_api", "listInventory"));
  assert.throws(() => assertAuthorizedExternalApiOperation(authorization, "inventory_api", "otherOperation"), { statusCode: 403 });
});

test("validator admits only a discovered, explicitly approved external API operation", () => {
  const context = discoverOpenApiContext(configuration(), safeSpec);
  const validator = new QuestionPlanValidator({ inventory_api: context });
  const validation = validator.validate({ question: "show inventory", data_sources: ["external_api"], api_sources: ["inventory_api"], api_operation: "listInventory", postgresql_sources: [], required_tables: [], required_columns: [], relationships: [], filters: [], operations: ["lookup"], grouping: [], sorting: [], entities: [], limit: 10, confidence: 0.8 });
  assert.equal(validation.valid, true, validation.errors.join("; "));
  const denied = validator.validate({ question: "show inventory", data_sources: ["external_api"], api_sources: ["inventory_api"], api_operation: "notApproved", postgresql_sources: [], required_tables: [], required_columns: [], relationships: [], filters: [], operations: ["lookup"], grouping: [], sorting: [], entities: [], limit: 10, confidence: 0.8 });
  assert.equal(denied.valid, false);
});

test("API client never follows another origin and only performs the discovered GET", async () => {
  const context = discoverOpenApiContext(configuration(), safeSpec);
  const seen = [];
  const client = new ExternalApiClient({ ...configuration(), auth: { type: "none", secretEnv: null }, maxRetries: 1 }, context, async (url, request) => {
    seen.push({ url: String(url), method: request.method, redirect: request.redirect });
    return new Response(JSON.stringify([{ id: "one", name: "one", password: "never-exposed" }]), { status: 200, headers: { "content-type": "application/json" } });
  });
  const result = await client.retrieve("listInventory");
  assert.equal(result.row_count, 1);
  assert.deepEqual(result.rows, [{ id: "one", name: "one" }]);
  assert.deepEqual(seen, [{ url: "https://api.example.test/inventory", method: "GET", redirect: "error" }]);
  await assert.rejects(() => client.retrieve("listInventory", { arbitrary: "value" }), /unapproved parameter/i);
});

test("a failed API discovery cannot publish a partial metadata generation", async () => {
  await assert.rejects(
    () => refreshContextGeneration({
      sourceIds: ["inventory_api"],
      apiSourceConfigs: { inventory_api: configuration() },
      buildExternalApiContext: async () => { throw new Error("offline discovery failed"); }
    }),
    /offline discovery failed/
  );
});
