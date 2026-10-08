import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

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

  // Context Layer limits
  contextMaxTurns: parseInt(cleanEnvStr(process.env.CONTEXT_MAX_TURNS, "5"), 10),
  contextMaxItems: parseInt(cleanEnvStr(process.env.CONTEXT_MAX_ITEMS, "20"), 10),

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
  authSecret: cleanEnvStr(process.env.AUTH_SECRET, "default-secret"),
  cookieSecure: cleanEnvStr(process.env.COOKIE_SECURE, "false").toLowerCase() === "true",

  // Server
  allowOrigins: allowOriginsList,
  port: parseInt(cleanEnvStr(process.env.PORT, "8000"), 10)
};

export default settings;

