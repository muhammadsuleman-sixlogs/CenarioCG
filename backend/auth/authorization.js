import { settings } from "../config/settings.js";

function forbidden(detail = "Workspace authorization required.") {
  const error = new Error(detail);
  error.statusCode = 403;
  error.status = 403;
  error.detail = detail;
  return error;
}

function normaliseStringList(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list.`);
  const values = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) throw new Error(`${label} must contain non-empty strings.`);
    const normalised = item.trim().toLowerCase();
    if (!values.includes(normalised)) values.push(normalised);
  }
  return values;
}

/**
 * Parse server-owned authorization configuration. A configured source is not
 * automatically authorized: each principal/workspace mapping is allow-list only.
 */
export function loadWorkspaceAuthorization(raw = settings.workspaceAuthorizationJson) {
  if (!raw) return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("WORKSPACE_AUTHORIZATION_JSON is not valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("WORKSPACE_AUTHORIZATION_JSON must be an object.");

  const output = {};
  for (const [principalRaw, entry] of Object.entries(parsed)) {
    const principal = String(principalRaw || "").trim();
    if (!principal || !entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid workspace authorization entry.");
    const workspaces = entry.workspaces && typeof entry.workspaces === "object" ? entry.workspaces : entry;
    output[principal] = {};
    for (const [workspaceRaw, permissions] of Object.entries(workspaces)) {
      const workspaceId = String(workspaceRaw || "").trim();
      if (!workspaceId || !permissions || typeof permissions !== "object" || Array.isArray(permissions)) throw new Error("Invalid workspace permission entry.");
      output[principal][workspaceId] = {
        postgresql_sources: normaliseStringList(permissions.postgresql_sources || [], "postgresql_sources"),
        security_resources: normaliseStringList(permissions.security_resources || [], "security_resources")
      };
    }
  }
  return output;
}

export function resolveAuthorizedWorkspace(principal, requestedWorkspaceId = null, policy = loadWorkspaceAuthorization()) {
  if (typeof principal !== "string" || !principal.trim()) throw forbidden();
  const workspaces = policy[principal];
  if (!workspaces || typeof workspaces !== "object") throw forbidden();
  if (requestedWorkspaceId !== null && requestedWorkspaceId !== undefined) {
    if (typeof requestedWorkspaceId !== "string" || !requestedWorkspaceId.trim() || requestedWorkspaceId.length > 128) {
      const error = new Error("Invalid workspace identifier."); error.statusCode = 400; error.status = 400; error.detail = "Invalid workspace identifier."; throw error;
    }
    const permitted = workspaces[requestedWorkspaceId.trim()];
    if (!permitted) throw forbidden();
    return { workspace_id: requestedWorkspaceId.trim(), ...permitted };
  }
  const configuredDefault = settings.defaultWorkspaceId;
  if (configuredDefault && workspaces[configuredDefault]) return { workspace_id: configuredDefault, ...workspaces[configuredDefault] };
  const workspaceIds = Object.keys(workspaces);
  if (workspaceIds.length === 1) return { workspace_id: workspaceIds[0], ...workspaces[workspaceIds[0]] };
  throw forbidden();
}

export function assertAuthorizedSources(authorization, sourceIds) {
  const allowed = new Set(authorization?.postgresql_sources || []);
  for (const sourceId of sourceIds || []) {
    if (!allowed.has(String(sourceId).toLowerCase())) throw forbidden("Requested source is not authorized.");
  }
}

export function assertAuthorizedSecurityResource(authorization, resource) {
  if (!resource) return;
  if (!(authorization?.security_resources || []).includes(String(resource).toLowerCase())) {
    throw forbidden("Requested security resource is not authorized.");
  }
}

export default { loadWorkspaceAuthorization, resolveAuthorizedWorkspace, assertAuthorizedSources, assertAuthorizedSecurityResource };
