import pkg from "pg";
const { Pool } = pkg;
import { settings } from "../config/settings.js";

const pools = new Map();

function createPoolConfig(host, port, database, user, password, sslRejectUnauthorized = false) {
  return {
    host,
    port,
    database,
    user,
    password,
    max: 10,
    min: 1,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
    query_timeout: 30000,
    ssl: { rejectUnauthorized: sslRejectUnauthorized }
  };
}

function normaliseSourceId(sourceId) {
  const normalized = typeof sourceId === "string" ? sourceId.trim().toLowerCase() : "";
  if (!normalized) throw new Error("PostgreSQL source_id must be a non-empty string.");
  return normalized;
}

export function getRegisteredPostgresqlSourceIds() {
  return Object.keys(settings.postgresqlSources || {}).sort();
}

export function getPostgresqlSourceConfig(sourceId) {
  const normalized = normaliseSourceId(sourceId);
  const config = settings.postgresqlSources?.[normalized];
  if (!config) throw new Error(`Unsupported PostgreSQL source: '${sourceId ?? ""}'.`);
  if (!config.host || !Number.isInteger(config.port) || !config.database || !config.user) {
    throw new Error(`PostgreSQL source '${normalized}' is incompletely configured.`);
  }
  return config;
}

export function getPostgresqlPool(sourceId) {
  const normalized = normaliseSourceId(sourceId);
  if (!pools.has(normalized)) {
    const config = getPostgresqlSourceConfig(normalized);
    const pool = new Pool(createPoolConfig(config.host, config.port, config.database, config.user, config.password, config.sslRejectUnauthorized));
    pool.on("error", err => console.warn(`PostgreSQL ${normalized} pool client idle error:`, err.message));
    pools.set(normalized, pool);
  }
  return pools.get(normalized);
}

export function getDb1Pool() {
  return getPostgresqlPool("db1");
}

export function getDb2Pool() {
  return getPostgresqlPool("db2");
}

export function getPool(sourceId) {
  return getPostgresqlPool(sourceId);
}

/**
 * Check out one client, protect it from an unhandled socket error while it is
 * checked out, and initialize its session serially.  `pool.on("connect")`
 * cannot await initialization, which previously allowed these SET commands
 * to overlap with the caller's first query.
 */
export async function checkoutReadOnlyClient(pool) {
  const client = await pool.connect();
  const originalRelease = typeof client.release === "function" ? client.release.bind(client) : null;
  let released = false;
  const releaseOnce = (error = undefined) => {
    if (released) return;
    released = true;
    if (typeof client.removeListener === "function") client.removeListener("error", onClientError);
    if (originalRelease) originalRelease(error);
  };
  const onClientError = (error) => {
    // Checked-out pg clients do not use the pool's idle-client listener. A
    // listener here prevents ECONNRESET from becoming an unhandled EventEmitter
    // error and releases the broken connection with an error so pg discards it.
    console.warn("PostgreSQL checked-out client error:", String(error?.message || error || "unknown error"));
    releaseOnce(error instanceof Error ? error : new Error("PostgreSQL client error"));
  };
  if (typeof client.once === "function") client.once("error", onClientError);
  if (originalRelease) client.release = releaseOnce;

  try {
    await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;");
    await client.query("SET default_transaction_read_only = on;");
    return client;
  } catch (error) {
    releaseOnce(error);
    throw error;
  }
}

/** Acquire a source-explicit read-only PostgreSQL client connection. */
export async function getConnection(sourceId) {
  const pool = getPool(sourceId);
  return checkoutReadOnlyClient(pool);
}

export async function getDb2Connection() {
  return getConnection("db2");
}

/**
 * Cleanly close all active PostgreSQL connection pools.
 */
export async function closeAllPools() {
  await Promise.all([...pools.values()].map(pool => pool.end().catch(() => {})));
  pools.clear();
}

export const get_connection = getConnection;
export const get_db2_connection = getDb2Connection;
export const close_all_pools = closeAllPools;
export const checkout_readonly_client = checkoutReadOnlyClient;

export default {
  getDb1Pool,
  getDb2Pool,
  getRegisteredPostgresqlSourceIds,
  getPostgresqlSourceConfig,
  getPostgresqlPool,
  getPool,
  getConnection,
  getDb2Connection,
  checkoutReadOnlyClient,
  closeAllPools,
  get_connection,
  get_db2_connection,
  close_all_pools
};

