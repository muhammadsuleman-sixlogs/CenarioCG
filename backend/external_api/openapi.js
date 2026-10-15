const SOURCE_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const SAFE_QUERY_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SAFE_TYPES = new Set(["string", "integer", "number", "boolean"]);

function object(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value;
}

function httpsUrl(value, label) {
  let url;
  try { url = new URL(String(value || "")); } catch { throw new Error(`${label} must be a valid HTTPS URL.`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(`${label} must be an origin-safe HTTPS URL.`);
  return url;
}

function validatedBaseUrl(value, label) {
  const url = httpsUrl(value, label);
  // OpenAPI paths are absolute. Restrict the configured base to an origin so
  // a specification path cannot be combined with a surprising prefix.
  if (url.pathname !== "/" || url.search) throw new Error(`${label} must contain only an HTTPS origin.`);
  return url;
}

function sourceId(value) {
  const id = String(value || "").trim().toLowerCase();
  if (!SOURCE_ID.test(id)) throw new Error("External API source IDs must be lowercase letters, numbers, underscores, or hyphens.");
  return id;
}

function positiveInteger(value, label, fallback, maximum) {
  const parsed = value === undefined ? fallback : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${label} must be an integer between 1 and ${maximum}.`);
  return parsed;
}

export function parseExternalApiSources(raw) {
  if (!raw) return Object.freeze({});
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("EXTERNAL_API_SOURCES_JSON is not valid JSON."); }
  object(parsed, "EXTERNAL_API_SOURCES_JSON must be an object.");
  const result = {};
  for (const [rawId, value] of Object.entries(parsed)) {
    const id = sourceId(rawId);
    const entry = object(value, `External API source '${id}' must be an object.`);
    if (entry.type !== "openapi") throw new Error(`External API source '${id}' must use supported type 'openapi'.`);
    const baseUrl = validatedBaseUrl(entry.baseUrl, `External API source '${id}' baseUrl`);
    const specUrl = httpsUrl(entry.specUrl, `External API source '${id}' specUrl`);
    const allowedOperations = Array.isArray(entry.allowedOperations) ? [...new Set(entry.allowedOperations.map(v => String(v || "").trim()).filter(Boolean))] : [];
    if (!allowedOperations.length) throw new Error(`External API source '${id}' requires explicit allowedOperations.`);
    const auth = entry.auth === undefined ? { type: "none" } : object(entry.auth, `External API source '${id}' auth must be an object.`);
    if (!["none", "bearer_env"].includes(auth.type)) throw new Error(`External API source '${id}' has an unsupported authentication type.`);
    if (auth.type === "bearer_env" && !ENV_NAME.test(String(auth.secretEnv || ""))) throw new Error(`External API source '${id}' bearer_env requires an environment-variable secret reference.`);
    result[id] = Object.freeze({
      id, type: "openapi", baseUrl: baseUrl.toString().replace(/\/$/, ""), specUrl: specUrl.toString(),
      auth: Object.freeze({ type: auth.type, secretEnv: auth.type === "bearer_env" ? String(auth.secretEnv) : null }),
      allowedOperations: Object.freeze(allowedOperations),
      timeoutMs: positiveInteger(entry.timeoutMs, `External API source '${id}' timeoutMs`, 10000, 60000),
      maxResults: positiveInteger(entry.maxResults, `External API source '${id}' maxResults`, 100, 1000),
      // Pagination is intentionally not inferred. Only a single bounded
      // response is supported until an explicit pagination mapping exists.
      maxPages: positiveInteger(entry.maxPages, `External API source '${id}' maxPages`, 1, 1),
      maxRetries: positiveInteger(entry.maxRetries, `External API source '${id}' maxRetries`, 1, 3)
    });
  }
  return Object.freeze(result);
}

function operationResponseSchema(spec, operation) {
  const responses = operation.responses || {};
  const success = responses["200"] || responses["201"];
  const content = success?.content?.["application/json"];
  const schema = content?.schema;
  if (!schema || typeof schema !== "object" || schema.$ref) throw new Error("Approved operation requires an inline JSON success response schema.");
  if (schema.type === "array") return schema.items;
  return schema;
}

function fields(schema) {
  if (!schema || typeof schema !== "object" || schema.type !== "object" || !schema.properties || typeof schema.properties !== "object") throw new Error("Approved operation response schema must be an object or array of objects.");
  const output = [];
  for (const [name, detail] of Object.entries(schema.properties)) {
    if (!SAFE_QUERY_NAME.test(name) || !detail || typeof detail !== "object" || !SAFE_TYPES.has(detail.type)) continue;
    if (/(?:password|secret|token|credential|authorization|cookie|private[_-]?key)/i.test(name)) continue;
    output.push({ name, type: detail.type });
  }
  if (!output.length) throw new Error("Approved operation has no safe response fields.");
  return output;
}

function queryParameters(pathItem, operation) {
  const params = [...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])];
  const output = [];
  for (const parameter of params) {
    if (!parameter || parameter.in !== "query" || !SAFE_QUERY_NAME.test(parameter.name || "") || parameter.required === true || parameter.schema?.$ref || !SAFE_TYPES.has(parameter.schema?.type)) continue;
    if (/(?:token|secret|password|credential|authorization)/i.test(parameter.name)) continue;
    output.push({ name: parameter.name, type: parameter.schema.type });
  }
  return output;
}

function serverOrigin(spec, config) {
  const configured = new URL(config.baseUrl).origin;
  if (String(spec.openapi || "").startsWith("3.")) {
    const server = Array.isArray(spec.servers) ? spec.servers[0]?.url : null;
    if (!server || new URL(server, config.baseUrl).origin !== configured) throw new Error("OpenAPI server origin must exactly match the configured baseUrl origin.");
  } else if (spec.swagger === "2.0") {
    const scheme = Array.isArray(spec.schemes) && spec.schemes.length === 1 ? spec.schemes[0] : "";
    if (scheme !== "https" || !spec.host || new URL(`https://${spec.host}`).origin !== configured) throw new Error("Swagger host and HTTPS scheme must exactly match the configured baseUrl origin.");
  } else throw new Error("Only OpenAPI 3.x and Swagger 2.0 specifications are supported.");
}

/** Parse an already trusted specification. Network fetching is deliberately separate. */
export function discoverOpenApiContext(config, specification) {
  object(config, "External API configuration is required.");
  const spec = object(specification, "OpenAPI specification must be an object.");
  serverOrigin(spec, config);
  const tables = {};
  const operations = {};
  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    if (!path.startsWith("/") || path.includes("{") || !pathItem || typeof pathItem !== "object") continue;
    const operation = pathItem.get;
    if (!operation || typeof operation !== "object" || !config.allowedOperations.includes(operation.operationId)) continue;
    if (operation.deprecated || operation.requestBody || operation.security?.some(item => item && Object.keys(item).some(key => /oauth|mutat/i.test(key)))) continue;
    const operationId = operation.operationId;
    const columns = fields(operationResponseSchema(spec, operation));
    operations[operationId] = { operation_id: operationId, path, parameters: queryParameters(pathItem, operation), response_fields: columns };
    tables[operationId] = { columns, primary_keys: columns.filter(column => /(?:^|_)(?:id|uuid|key|code)$/i.test(column.name)).map(column => column.name) };
  }
  if (!Object.keys(operations).length) throw new Error("Specification contains no explicitly approved, safe GET operations.");
  return { source_id: config.id, source_type: "external_api", api_type: "openapi", tables, relationships: [], api_operations: operations, discovery: { validation_status: "validated", specification_origin: new URL(config.specUrl).origin, operation_count: Object.keys(operations).length } };
}

export async function fetchAndDiscoverOpenApiContext(config, fetchImpl = fetch) {
  const specUrl = httpsUrl(config.specUrl, "External API specification URL");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(specUrl, { method: "GET", headers: { Accept: "application/json" }, redirect: "error", signal: controller.signal });
    if (!response.ok) throw new Error(`OpenAPI specification request failed with HTTP ${response.status}.`);
    const specification = await response.json();
    return discoverOpenApiContext(config, specification);
  } finally { clearTimeout(timer); }
}

export function getApprovedOperation(context, operationId) {
  const operation = context?.api_operations?.[String(operationId || "")];
  if (!operation) throw new Error("External API operation is not discovered and approved.");
  return operation;
}
