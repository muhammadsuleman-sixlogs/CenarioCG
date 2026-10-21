import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { parseExternalApiSources } from "../external_api/openapi.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from backend root
dotenv.config({ path: resolve(__dirname, "../.env") });
dotenv.config();

function cleanEnvStr(val, fallback = "") {
  if (val === undefined || val === null) return fallback;
  const str = String(val).trim();
  // Strip enclosing single or double quotes
  return str.replace(/^["']|["']$/g, "").trim();
}

const SOURCE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

function normalisePostgresSourceId(value) {
  const sourceId = String(value || "").trim().toLowerCase();
  if (!SOURCE_ID_PATTERN.test(sourceId)) throw new Error("PostgreSQL source IDs must be lowercase letters, numbers, underscores, or hyphens.");
  return sourceId;
}

function sourceConfig(value, sourceId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`PostgreSQL source '${sourceId}' must be an object.`);
  const port = Number.parseInt(String(value.port ?? ""), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PostgreSQL source '${sourceId}' has an invalid port.`);
  const config = {
    host: cleanEnvStr(value.host), port, database: cleanEnvStr(value.database), user: cleanEnvStr(value.user), password: cleanEnvStr(value.password),
    sslRejectUnauthorized: value.sslRejectUnauthorized === true || String(value.sslRejectUnauthorized || "").toLowerCase() === "true"
  };
  if (!config.host || !config.database || !config.user) throw new Error(`PostgreSQL source '${sourceId}' requires host, database, and user.`);
  return Object.freeze(config);
}

function loadPostgresqlSources(raw, legacySources) {
  const sources = { ...legacySources };
  if (!raw) return Object.freeze(sources);
  let configured;
  try { configured = JSON.parse(raw); } catch { throw new Error("POSTGRES_SOURCES_JSON is not valid JSON."); }
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) throw new Error("POSTGRES_SOURCES_JSON must be an object.");
  for (const [rawId, rawConfig] of Object.entries(configured)) {
    const sourceId = normalisePostgresSourceId(rawId);
    sources[sourceId] = sourceConfig(rawConfig, sourceId);
  }
  return Object.freeze(sources);
}

const rawOrigins = cleanEnvStr(
  process.env.ALLOW_ORIGINS,
  "http://localhost:5173,http://127.0.0.1:5173,https://cenario-cg-xmvw.vercel.app"
);

const allowOriginsList = rawOrigins
  .split(",")
  .map(o => o.trim())
  .filter(Boolean);

// Python main.py parity: ensure 127.0.0.1 is present if localhost is present
if (allowOriginsList.includes("http://localhost:5173") && !allowOriginsList.includes("http://127.0.0.1:5173")) {
  allowOriginsList.push("http://127.0.0.1:5173");
}

const legacyPostgresqlSources = {
  db1: sourceConfig({ host: cleanEnvStr(process.env.POSTGRES_HOST, "localhost"), port: cleanEnvStr(process.env.POSTGRES_PORT, "11351"), database: cleanEnvStr(process.env.POSTGRES_DATABASE, "defaultdb"), user: cleanEnvStr(process.env.POSTGRES_USER, "avnadmin"), password: cleanEnvStr(process.env.POSTGRES_PASSWORD, "") }, "db1"),
  // Preserve historical startup behavior where DB2 is configured later in a
  // deployment, while making explicit registry entries the normal path.
  db2: { host: cleanEnvStr(process.env.DB_HOST, "localhost"), port: parseInt(cleanEnvStr(process.env.DB_PORT, "5432"), 10), database: cleanEnvStr(process.env.DB_NAME, ""), user: cleanEnvStr(process.env.DB_USER, ""), password: cleanEnvStr(process.env.DB_PASSWORD, ""), sslRejectUnauthorized: false }
};

export const settings = {
  // LLM Configuration
  openaiApiKey: cleanEnvStr(process.env.OPENAI_API_KEY, ""),
  openaiModel: cleanEnvStr(process.env.OPENAI_MODEL, "gpt-5.4-nano-2026-03-17"),

  // DB 01 (PostgreSQL Aiven Cloud)
  postgresHost: cleanEnvStr(process.env.POSTGRES_HOST, "localhost"),
  postgresPort: parseInt(cleanEnvStr(process.env.POSTGRES_PORT, "11351"), 10),
  postgresDatabase: cleanEnvStr(process.env.POSTGRES_DATABASE, "defaultdb"),
  postgresUser: cleanEnvStr(process.env.POSTGRES_USER, "avnadmin"),
  postgresPassword: cleanEnvStr(process.env.POSTGRES_PASSWORD, ""),

  // DB 02 (AWS RDS PostgreSQL)
  dbHost: cleanEnvStr(process.env.DB_HOST, "localhost"),
  dbPort: parseInt(cleanEnvStr(process.env.DB_PORT, "5432"), 10),
  dbName: cleanEnvStr(process.env.DB_NAME, ""),
  dbUser: cleanEnvStr(process.env.DB_USER, ""),
  dbPassword: cleanEnvStr(process.env.DB_PASSWORD, ""),
  // Private application configuration. Registration is not authorization:
  // workspace access remains exclusively controlled by
  // WORKSPACE_AUTHORIZATION_JSON.
  postgresqlSources: loadPostgresqlSources(cleanEnvStr(process.env.POSTGRES_SOURCES_JSON, ""), legacyPostgresqlSources),
  // Private external API registrations. A registration carries no workspace
  // authorization and secrets remain environment references, never metadata.
  externalApiSources: parseExternalApiSources(cleanEnvStr(process.env.EXTERNAL_API_SOURCES_JSON, "")),

  // Context Layer limits
  contextMaxTurns: parseInt(cleanEnvStr(process.env.CONTEXT_MAX_TURNS, "5"), 10),
  contextMaxItems: parseInt(cleanEnvStr(process.env.CONTEXT_MAX_ITEMS, "20"), 10),
  // A controlled restart automatically validates registered sources. Failed
  // discovery retains the current generation, so it cannot disrupt requests.
  contextRefreshEnabled: cleanEnvStr(process.env.CONTEXT_REFRESH_ENABLED, "true").toLowerCase() === "true",
  contextRefreshOnStartup: cleanEnvStr(process.env.CONTEXT_REFRESH_ON_STARTUP, "true").toLowerCase() === "true",
  contextRefreshIntervalMs: parseInt(cleanEnvStr(process.env.CONTEXT_REFRESH_INTERVAL_MS, "900000"), 10),
  contextSnapshotRetention: parseInt(cleanEnvStr(process.env.CONTEXT_SNAPSHOT_RETENTION, "5"), 10),
  categoricalValueCacheTtlMs: parseInt(cleanEnvStr(process.env.CATEGORICAL_VALUE_CACHE_TTL_MS, "30000"), 10),

  // Security SIEM API
  securityApiBaseUrl: cleanEnvStr(process.env.SECURITY_API_BASE_URL, ""),
  securityApiPrefix: cleanEnvStr(process.env.SECURITY_API_PREFIX, "api"),
  securityApiToken: cleanEnvStr(process.env.SECURITY_API_TOKEN, ""),
  securityWorkspaceId: cleanEnvStr(process.env.SECURITY_WORKSPACE_ID, ""),
  securityApiTimeout: parseInt(cleanEnvStr(process.env.SECURITY_API_TIMEOUT, "30"), 10),
  securityApiMaxLimit: parseInt(cleanEnvStr(process.env.SECURITY_API_MAX_LIMIT, "1000"), 10),
  securityApiCacheEnabled: cleanEnvStr(process.env.SECURITY_API_CACHE_ENABLED, "true").toLowerCase() === "true",
  securityApiCacheMaxEntries: parseInt(cleanEnvStr(process.env.SECURITY_API_CACHE_MAX_ENTRIES, "128"), 10),

  // Cache TTLs
  securityLogsCacheTtl: parseInt(cleanEnvStr(process.env.SECURITY_LOGS_CACHE_TTL, "30"), 10),
  securityLogsSummaryCacheTtl: parseInt(cleanEnvStr(process.env.SECURITY_LOGS_SUMMARY_CACHE_TTL, "60"), 10),
  workspaceSecurityLogsCacheTtl: parseInt(cleanEnvStr(process.env.WORKSPACE_SECURITY_LOGS_CACHE_TTL, "30"), 10),
  workspaceSiemStatusCacheTtl: parseInt(cleanEnvStr(process.env.WORKSPACE_SIEM_STATUS_CACHE_TTL, "15"), 10),
  securityOverviewCacheTtl: parseInt(cleanEnvStr(process.env.SECURITY_OVERVIEW_CACHE_TTL, "60"), 10),

  // Authentication
  adminUsername: cleanEnvStr(process.env.ADMIN_USERNAME, "admin"),
  adminPassword: cleanEnvStr(process.env.ADMIN_PASSWORD, ""),
  authSecret: cleanEnvStr(process.env.AUTH_SECRET, ""),
  cookieSecure: cleanEnvStr(process.env.COOKIE_SECURE, "false").toLowerCase() === "true",
  workspaceAuthorizationJson: cleanEnvStr(process.env.WORKSPACE_AUTHORIZATION_JSON, ""),
  defaultWorkspaceId: cleanEnvStr(process.env.DEFAULT_WORKSPACE_ID, ""),

  // Server
  allowOrigins: allowOriginsList,
  port: parseInt(cleanEnvStr(process.env.PORT, "8000"), 10)
};

export default settings;

