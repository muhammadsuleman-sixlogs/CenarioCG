import pkg from "pg";
const { Pool } = pkg;
import { settings } from "../config/settings.js";

let poolDb1 = null;
let poolDb2 = null;

function createPoolConfig(host, port, database, user, password) {
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
    ssl: { rejectUnauthorized: false }
  };
}

export function getDb1Pool() {
  if (!poolDb1) {
    poolDb1 = new Pool(
      createPoolConfig(
        settings.postgresHost,
        settings.postgresPort,
        settings.postgresDatabase,
        settings.postgresUser,
        settings.postgresPassword
      )
    );

    poolDb1.on("error", (err) => {
      console.warn("PostgreSQL DB1 pool client idle error:", err.message);
    });
  }
  return poolDb1;
}

export function getDb2Pool() {
  if (!poolDb2) {
    poolDb2 = new Pool(
      createPoolConfig(
        settings.dbHost,
        settings.dbPort,
        settings.dbName,
        settings.dbUser,
        settings.dbPassword
      )
    );

    poolDb2.on("error", (err) => {
      console.warn("PostgreSQL DB2 pool client idle error:", err.message);
    });
  }
  return poolDb2;
}

export function getPool(sourceId) {
  const normalized = typeof sourceId === "string" ? sourceId.trim().toLowerCase() : "";
  if (normalized === "db1") return getDb1Pool();
  if (normalized === "db2") return getDb2Pool();
  throw new Error(`Unsupported PostgreSQL source: '${sourceId ?? ""}'.`);
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
  if (poolDb1) {
    await poolDb1.end().catch(() => {});
    poolDb1 = null;
  }
  if (poolDb2) {
    await poolDb2.end().catch(() => {});
    poolDb2 = null;
  }
}

export const get_connection = getConnection;
export const get_db2_connection = getDb2Connection;
export const close_all_pools = closeAllPools;
export const checkout_readonly_client = checkoutReadOnlyClient;

export default {
  getDb1Pool,
  getDb2Pool,
  getPool,
  getConnection,
  getDb2Connection,
  checkoutReadOnlyClient,
  closeAllPools,
  get_connection,
  get_db2_connection,
  close_all_pools
};

