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

    poolDb1.on("connect", (client) => {
      // Enforce read-only at the PostgreSQL session level
      client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;").catch(() => {});
      client.query("SET default_transaction_read_only = on;").catch(() => {});
    });

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

    poolDb2.on("connect", (client) => {
      // Enforce read-only at the PostgreSQL session level
      client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;").catch(() => {});
      client.query("SET default_transaction_read_only = on;").catch(() => {});
    });

    poolDb2.on("error", (err) => {
      console.warn("PostgreSQL DB2 pool client idle error:", err.message);
    });
  }
  return poolDb2;
}

export function getPool(sourceId = "db1") {
  if (sourceId === "db2") {
    return getDb2Pool();
  }
  return getDb1Pool();
}

/**
 * Acquire a read-only PostgreSQL client connection.
 *
 * Provides compatibility for callers expecting either a pool or a client:
 * client.connect() resolves to the client itself.
 */
export async function getConnection(sourceId = "db1") {
  const pool = getPool(sourceId);
  const client = await pool.connect();

  // Enforce read-only transaction mode immediately on checkout
  await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;");

  // Dual-compatibility: allow calling .connect() on the acquired client
  if (!client.connect) {
    client.connect = () => Promise.resolve(client);
  }

  return client;
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

export default {
  getDb1Pool,
  getDb2Pool,
  getPool,
  getConnection,
  getDb2Connection,
  closeAllPools,
  get_connection,
  get_db2_connection,
  close_all_pools
};

