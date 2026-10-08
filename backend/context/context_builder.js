import { getConnection, getDb2Connection } from "../database/connection.js";
import { discoverSchema } from "../database/schema_discovery.js";

/**
 * Build an automatic context representation from
 * PostgreSQL schema metadata.
 *
 * The database is accessed in read-only mode.
 *
 * source_id:
 *     db1 -> primary PostgreSQL database
 *     db2 -> second PostgreSQL database
 */
export async function build_context(source_id = "db1") {
  let schema;
  if (source_id === "db1") {
    schema = await discoverSchema(getConnection);
  } else if (source_id === "db2") {
    schema = await discoverSchema(getDb2Connection);
  } else {
    throw new Error(`Unknown source: ${source_id}`);
  }

  const columns = schema.columns || [];
  const primary_keys = schema.primary_keys || [];
  const foreign_keys = schema.foreign_keys || [];

  const context = {
    source_id,
    tables: {},
    relationships: [],
  };

  // --------------------------------------------------
  // Build table/column context
  // --------------------------------------------------

  for (const [table_name, column_name, data_type] of columns) {
    if (!context.tables[table_name]) {
      context.tables[table_name] = {
        columns: [],
        primary_keys: [],
      };
    }

    context.tables[table_name].columns.push({
      name: column_name,
      type: data_type,
    });
  }

  // --------------------------------------------------
  // Add primary keys
  // --------------------------------------------------

  for (const [table_name, column_name] of primary_keys) {
    if (context.tables[table_name]) {
      context.tables[table_name].primary_keys.push(column_name);
    }
  }

  // --------------------------------------------------
  // Add relationships
  // --------------------------------------------------

  for (const [source_table, source_column, target_table, target_column] of foreign_keys) {
    context.relationships.push({
      source_table,
      source_column,
      target_table,
      target_column,
      relationship_type: "FOREIGN_KEY",
      confidence: 1.0,
      source: "postgresql_foreign_key",
    });
  }

  return context;
}

export const buildContext = build_context;

export function print_context(context) {
  console.log("=".repeat(70));
  console.log(`AUTOMATIC CONTEXT LAYER - SOURCE: ${context?.source_id || "unknown"}`);
  console.log("=".repeat(70));

  const tables = context?.tables || {};
  const relationships = context?.relationships || [];

  console.log(`\nTables: ${Object.keys(tables).length}`);
  console.log(`Relationships: ${relationships.length}`);

  console.log("\n" + "-".repeat(70));
  console.log("TABLE CONTEXT");
  console.log("-".repeat(70));

  for (const [table_name, table_info] of Object.entries(tables)) {
    console.log(`\nTABLE: ${table_name}`);
    console.log(`  Columns: ${(table_info.columns || []).length}`);
    console.log(`  Primary Keys: ${JSON.stringify(table_info.primary_keys || [])}`);
  }

  console.log("\n" + "-".repeat(70));
  console.log("RELATIONSHIP CONTEXT");
  console.log("-".repeat(70));

  for (const relationship of relationships) {
    console.log(
      `  ${relationship.source_table}.${relationship.source_column} -> ` +
        `${relationship.target_table}.${relationship.target_column} ` +
        `[confidence=${relationship.confidence}]`
    );
  }

  console.log("\n" + "=".repeat(70));
}

export const printContext = print_context;

export default {
  build_context,
  buildContext,
  print_context,
  printContext,
};
