/**
 * Deterministic business logic relationship validator.
 *
 * Validates candidate business relationships against the discovered
 * PostgreSQL schema context.
 */

export function getKnownTables(context) {
  const tables = context?.tables || {};
  return new Set(Object.keys(tables));
}

export function getKnownColumns(context) {
  const knownColumns = {};
  const tables = context?.tables || {};

  for (const [tableName, tableInfo] of Object.entries(tables)) {
    const cols = tableInfo?.columns || [];
    knownColumns[tableName] = new Set(cols.map(c => c.name));
  }

  return knownColumns;
}

export function getKnownForeignKeys(context) {
  const rels = context?.relationships || [];
  const keys = new Set();

  for (const r of rels) {
    if (r.source_table && r.source_column && r.target_table && r.target_column) {
      keys.add(`${r.source_table}.${r.source_column}->${r.target_table}.${r.target_column}`);
    }
  }

  return keys;
}

export function validateSourceId(relationship, context) {
  const contextSourceId = context?.source_id || "db1";
  const relationshipSourceId = relationship?.source_id;

  if (!relationshipSourceId) {
    return [false, "Missing source_id."];
  }

  if (relationshipSourceId !== contextSourceId) {
    return [
      false,
      "Relationship source_id does not match the supplied context source."
    ];
  }

  return [true, "Source ID is valid."];
}

export function validateConfidence(relationship) {
  const confidence = relationship?.confidence;

  if (typeof confidence !== "number" || isNaN(confidence)) {
    return [false, "Confidence must be numeric."];
  }

  if (confidence < 0 || confidence > 1) {
    return [false, "Confidence must be between 0 and 1."];
  }

  return [true, "Confidence is valid."];
}

export function validateEvidence(relationship) {
  const evidence = relationship?.evidence;

  if (!evidence) {
    return [false, "Relationship must contain evidence."];
  }

  if (!Array.isArray(evidence)) {
    return [false, "Evidence must be a list."];
  }

  const validEvidence = evidence.filter(
    item => typeof item === "string" && item.trim().length > 0
  );

  if (validEvidence.length === 0) {
    return [false, "Relationship evidence cannot be empty."];
  }

  return [true, "Evidence is valid."];
}

export function validateRelationship(relationship, context) {
  const [sourceValid, sourceReason] = validateSourceId(relationship, context);
  if (!sourceValid) {
    return [false, sourceReason];
  }

  const knownTables = getKnownTables(context);
  const knownColumns = getKnownColumns(context);

  const sourceTable = relationship?.source_table;
  const targetTable = relationship?.target_table;

  if (!sourceTable) {
    return [false, "Missing source_table."];
  }

  if (!targetTable) {
    return [false, "Missing target_table."];
  }

  if (!knownTables.has(sourceTable)) {
    return [false, `Unknown source table: ${sourceTable}`];
  }

  if (!knownTables.has(targetTable)) {
    return [false, `Unknown target table: ${targetTable}`];
  }

  const [confidenceValid, confidenceReason] = validateConfidence(relationship);
  if (!confidenceValid) {
    return [false, confidenceReason];
  }

  const [evidenceValid, evidenceReason] = validateEvidence(relationship);
  if (!evidenceValid) {
    return [false, evidenceReason];
  }

  const sourceColumn = relationship?.source_column;
  const targetColumn = relationship?.target_column;

  if (sourceColumn) {
    const tableCols = knownColumns[sourceTable];
    if (!tableCols || !tableCols.has(sourceColumn)) {
      return [false, `Unknown source column: ${sourceTable}.${sourceColumn}`];
    }
  }

  if (targetColumn) {
    const tableCols = knownColumns[targetTable];
    if (!tableCols || !tableCols.has(targetColumn)) {
      return [false, `Unknown target column: ${targetTable}.${targetColumn}`];
    }
  }

  return [true, "Relationship is valid."];
}

export function validateRelationships(relationships, context) {
  const valid = [];
  const invalid = [];

  const relList = Array.isArray(relationships) ? relationships : [];

  for (const relationship of relList) {
    const [isValid, reason] = validateRelationship(relationship, context);
    if (isValid) {
      valid.push(relationship);
    } else {
      invalid.push({
        relationship,
        reason
      });
    }
  }

  return {
    valid,
    invalid
  };
}

// snake_case aliases for Python parity
export const get_known_tables = getKnownTables;
export const get_known_columns = getKnownColumns;
export const get_known_foreign_keys = getKnownForeignKeys;
export const validate_source_id = validateSourceId;
export const validate_confidence = validateConfidence;
export const validate_evidence = validateEvidence;
export const validate_relationship = validateRelationship;
export const validate_relationships = validateRelationships;

export default {
  getKnownTables,
  get_known_tables: getKnownTables,
  getKnownColumns,
  get_known_columns: getKnownColumns,
  getKnownForeignKeys,
  get_known_foreign_keys: getKnownForeignKeys,
  validateSourceId,
  validate_source_id: validateSourceId,
  validateConfidence,
  validate_confidence: validateConfidence,
  validateEvidence,
  validate_evidence: validateEvidence,
  validateRelationship,
  validate_relationship: validateRelationship,
  validateRelationships,
  validate_relationships: validateRelationships
};
