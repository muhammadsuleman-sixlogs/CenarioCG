/**
 * Structured schema models representing discovered PostgreSQL schema components.
 */

export class Column {
  constructor(name, dataType) {
    // Support object or positional arguments
    if (typeof name === "object" && name !== null) {
      this.name = name.name;
      this.data_type = name.data_type || name.dataType;
    } else {
      this.name = name;
      this.data_type = dataType;
    }
  }
}

export class PrimaryKey {
  constructor(tableName, columnName) {
    if (typeof tableName === "object" && tableName !== null) {
      this.table_name = tableName.table_name || tableName.tableName;
      this.column_name = tableName.column_name || tableName.columnName;
    } else {
      this.table_name = tableName;
      this.column_name = columnName;
    }
  }
}

export class ForeignKey {
  constructor(sourceTable, sourceColumn, targetTable, targetColumn) {
    if (typeof sourceTable === "object" && sourceTable !== null) {
      this.source_table = sourceTable.source_table || sourceTable.sourceTable;
      this.source_column = sourceTable.source_column || sourceTable.sourceColumn;
      this.target_table = sourceTable.target_table || sourceTable.targetTable;
      this.target_column = sourceTable.target_column || sourceTable.targetColumn;
    } else {
      this.source_table = sourceTable;
      this.source_column = sourceColumn;
      this.target_table = targetTable;
      this.target_column = targetColumn;
    }
  }
}

export class Table {
  constructor(options = {}) {
    const name = typeof options === "string" ? options : options.name;
    this.name = name;
    this.columns = options.columns || [];
    this.primary_keys = options.primary_keys || options.primaryKeys || [];
    this.foreign_keys = options.foreign_keys || options.foreignKeys || [];
  }
}

export class DatabaseSchema {
  constructor(options = {}) {
    this.tables = Array.isArray(options) ? options : (options.tables || []);
  }

  /**
   * Factory method to build a DatabaseSchema model from raw discovered schema output.
   */
  static fromDiscoveredSchema(rawSchema) {
    const tablesMap = new Map();

    for (const [tableName, columnName, dataType] of rawSchema?.columns || []) {
      if (!tablesMap.has(tableName)) {
        tablesMap.set(tableName, new Table({ name: tableName }));
      }
      tablesMap.get(tableName).columns.push(new Column(columnName, dataType));
    }

    for (const [tableName, columnName] of rawSchema?.primary_keys || []) {
      if (tablesMap.has(tableName)) {
        tablesMap.get(tableName).primary_keys.push(columnName);
      }
    }

    for (const [sourceTable, sourceColumn, targetTable, targetColumn] of rawSchema?.foreign_keys || []) {
      const fk = new ForeignKey(sourceTable, sourceColumn, targetTable, targetColumn);
      if (tablesMap.has(sourceTable)) {
        tablesMap.get(sourceTable).foreign_keys.push(fk);
      }
    }

    return new DatabaseSchema(Array.from(tablesMap.values()));
  }
}

export default {
  Column,
  PrimaryKey,
  ForeignKey,
  Table,
  DatabaseSchema
};
