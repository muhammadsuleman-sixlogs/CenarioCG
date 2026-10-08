import { getConnection, getDb2Connection } from "./connection.js";

/**
 * Read PostgreSQL metadata without modifying the database.
 *
 * Discovers:
 *  - tables and columns
 *  - primary keys
 *  - foreign keys
 *
 * The connectionFactory determines which database is inspected (db1 vs db2).
 */
export async function discoverSchema(connectionFactory = getConnection) {
  let client;

  // Support passing a connection factory function or a pool/client directly
  if (typeof connectionFactory === "function") {
    client = await connectionFactory();
  } else if (connectionFactory && typeof connectionFactory.connect === "function") {
    client = await connectionFactory.connect();
  } else {
    client = connectionFactory;
  }

  try {
    // 1. Discover tables and columns
    const columnsRes = await client.query(`
      SELECT
        table_name,
        column_name,
        data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position;
    `);

    const columns = columnsRes.rows.map(r => [
      r.table_name,
      r.column_name,
      r.data_type
    ]);

    // 2. Discover primary keys
    const pkRes = await client.query(`
      SELECT
        tc.table_name,
        kcu.column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = 'public'
      ORDER BY tc.table_name, kcu.ordinal_position;
    `);

    const primaryKeys = pkRes.rows.map(r => [
      r.table_name,
      r.column_name
    ]);

    // 3. Discover foreign keys
    const fkRes = await client.query(`
      SELECT DISTINCT
        tc.table_name AS source_table,
        kcu.column_name AS source_column,
        ccu.table_name AS target_table,
        ccu.column_name AS target_column
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON tc.constraint_name = ccu.constraint_name
        AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
      ORDER BY
        tc.table_name,
        kcu.column_name;
    `);

    const foreignKeys = fkRes.rows.map(r => [
      r.source_table,
      r.source_column,
      r.target_table,
      r.target_column
    ]);

    return {
      columns,
      primary_keys: primaryKeys,
      foreign_keys: foreignKeys
    };
  } finally {
    if (client && typeof client.release === "function") {
      client.release();
    }
  }
}

/**
 * Print discovered schema in a human-readable format.
 */
export function printSchema(schema, sourceName = "PostgreSQL") {
  const columns = schema?.columns || [];
  const primaryKeys = schema?.primary_keys || [];
  const foreignKeys = schema?.foreign_keys || [];

  const tables = {};
  for (const [tableName, columnName, dataType] of columns) {
    if (!tables[tableName]) {
      tables[tableName] = [];
    }
    tables[tableName].push({
      name: columnName,
      type: dataType
    });
  }

  console.log("\n" + "=".repeat(70));
  console.log(`AUTOMATIC ${sourceName.toUpperCase()} SCHEMA DISCOVERY`);
  console.log("=".repeat(70));

  console.log(`\nTables discovered: ${Object.keys(tables).length}`);

  for (const [tableName, tableColumns] of Object.entries(tables)) {
    console.log(`\nTABLE: ${tableName}`);
    for (const column of tableColumns) {
      console.log(`  - ${column.name} (${column.type})`);
    }
  }

  console.log("\n" + "-".repeat(70));
  console.log("PRIMARY KEYS");
  console.log("-".repeat(70));

  for (const [tableName, columnName] of primaryKeys) {
    console.log(`  ${tableName}.${columnName}`);
  }

  console.log("\n" + "-".repeat(70));
  console.log("FOREIGN KEY RELATIONSHIPS");
  console.log("-".repeat(70));

  for (const [sourceTable, sourceColumn, targetTable, targetColumn] of foreignKeys) {
    console.log(`  ${sourceTable}.${sourceColumn} -> ${targetTable}.${targetColumn}`);
  }

  console.log("\n" + "=".repeat(70));
}

export const discover_schema = discoverSchema;
export const print_schema = printSchema;

export default {
  discoverSchema,
  printSchema,
  discover_schema,
  print_schema
};
