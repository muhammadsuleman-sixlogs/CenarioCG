import re from "process"; // placeholder check

// ---------------------------------------------------------------------------
// Generic fields
// ---------------------------------------------------------------------------

export const GENERIC_COLUMNS = new Set([
  "id",
  "created_at",
  "updated_at",
  "deleted_at",
  "timestamp",
  "created",
  "date",
  "time",
  "title",
  "description",
  "name",
  "status",
  "priority",
  "type",
  "source"
]);

// These can be useful for entity resolution, but should not automatically
// create structural cross-source joins.
export const ENTITY_COLUMNS = new Set([
  "email",
  "phone",
  "website",
  "url",
  "slug"
]);

// Canonical identifier suffixes.
export const IDENTIFIER_SUFFIXES = [
  "_id",
  "_uuid",
  "_key",
  "_code"
];

// Qualifiers that can appear after an identifier.
export const IDENTIFIER_QUALIFIERS = [
  "_display",
  "_display_id",
  "_display_value",
  "_name",
  "_number",
  "_no",
  "_num",
  "_ref",
  "_reference",
  "_value",
  "_label",
  "_text"
];

// Common wrappers that should be removed before comparing identifiers.
export const SEMANTIC_QUALIFIERS = new Set([
  "display",
  "value",
  "label",
  "text",
  "number",
  "num",
  "no",
  "ref",
  "reference",
  "name"
]);

// Entity-level keys that are safe to compare across systems when the two
// tables represent the same entity (users.email <-> users.email).
export const ENTITY_KEY_COLUMNS = new Set(["email", "website"]);

// ---------------------------------------------------------------------------
// Name normalization
// ---------------------------------------------------------------------------

export function _normalize(value) {
  let val = String(value ?? "").trim().toLowerCase();

  // camelCase -> snake_case
  val = val.replace(/([a-z0-9])([A-Z])/g, "$1_$2");

  // Remove non-alphanumeric separators
  val = val.replace(/[^a-z0-9]+/g, "_");

  return val.replace(/^_+|_+$/g, "");
}

export const normalize = _normalize;
export const normalizeName = _normalize;

export function _tokens(value) {
  const normalized = _normalize(value);
  if (!normalized) return new Set();

  return new Set(normalized.split("_").filter(Boolean));
}

export const tokens = _tokens;

export function _semantic_tokens(value) {
  const tok = _tokens(value);
  const ignored = new Set([
    "id",
    "ids",
    "uuid",
    "key",
    "keys",
    "code",
    "codes",
    "data",
    "table"
  ]);

  const result = new Set();
  for (const token of tok) {
    if (!ignored.has(token)) {
      result.add(token);
    }
  }
  return result;
}

export const semantic_tokens = _semantic_tokens;
export const semanticTokens = _semantic_tokens;

export function _plural_variants(token) {
  const variants = new Set([token]);

  if (token.endsWith("ies") && token.length > 3) {
    variants.add(token.slice(0, -3) + "y");
  }

  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 2) {
    variants.add(token.slice(0, -1));
  } else {
    variants.add(token + "s");
  }

  return variants;
}

export const plural_variants = _plural_variants;
export const pluralVariants = _plural_variants;

export function _semantic_similarity(left, right) {
  const leftTokens = _semantic_tokens(left);
  const rightTokens = _semantic_tokens(right);

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0.0;
  }

  const leftExpanded = new Set();
  const rightExpanded = new Set();

  for (const token of leftTokens) {
    for (const v of _plural_variants(token)) {
      leftExpanded.add(v);
    }
  }

  for (const token of rightTokens) {
    for (const v of _plural_variants(token)) {
      rightExpanded.add(v);
    }
  }

  let intersectionCount = 0;
  for (const v of leftExpanded) {
    if (rightExpanded.has(v)) {
      intersectionCount++;
    }
  }

  const union = new Set([...leftExpanded, ...rightExpanded]);
  if (union.size === 0) return 0.0;

  return intersectionCount / union.size;
}

export const semantic_similarity = _semantic_similarity;
export const semanticSimilarity = _semantic_similarity;

// ---------------------------------------------------------------------------
// Identifier normalization
// ---------------------------------------------------------------------------

export function _strip_identifier_qualifiers(normalized) {
  let value = normalized;
  let changed = true;

  while (changed) {
    changed = false;
    for (const qualifier of IDENTIFIER_QUALIFIERS) {
      if (value.endsWith(qualifier)) {
        const candidate = value.slice(0, -qualifier.length).replace(/_+$/, "");
        if (candidate) {
          value = candidate;
          changed = true;
          break;
        }
      }
    }
  }

  return value;
}

export const strip_identifier_qualifiers = _strip_identifier_qualifiers;
export const stripIdentifierQualifiers = _strip_identifier_qualifiers;

export function _identifier_base(columnName) {
  let normalized = _normalize(columnName);
  if (!normalized) return null;

  normalized = _strip_identifier_qualifiers(normalized);

  for (const suffix of IDENTIFIER_SUFFIXES) {
    if (normalized.endsWith(suffix)) {
      const base = normalized.slice(0, -suffix.length).replace(/^_+|_+$/g, "");
      if (base) return base;
    }
  }

  return null;
}

export const identifier_base = _identifier_base;
export const identifierBase = _identifier_base;

export function _canonical_identifier(columnName) {
  return _identifier_base(columnName);
}

export const canonical_identifier = _canonical_identifier;
export const canonicalIdentifier = _canonical_identifier;

export function _is_identifier_column(columnName) {
  return _identifier_base(columnName) !== null;
}

export const is_identifier_column = _is_identifier_column;
export const isIdentifierColumn = _is_identifier_column;

export function _identifier_semantic_signature(columnName) {
  const base = _identifier_base(columnName);
  if (!base) return new Set();
  return _semantic_tokens(base);
}

export const identifier_semantic_signature = _identifier_semantic_signature;
export const identifierSemanticSignature = _identifier_semantic_signature;

// ---------------------------------------------------------------------------
// Column classification
// ---------------------------------------------------------------------------

export function _is_generic_column(columnName) {
  const normalized = _normalize(columnName);
  if (GENERIC_COLUMNS.has(normalized)) return true;
  if (normalized.endsWith("_at")) return true;
  if (normalized.endsWith("_date")) return true;
  if (normalized.endsWith("_time")) return true;
  return false;
}

export const is_generic_column = _is_generic_column;
export const isGenericColumn = _is_generic_column;

export function _is_entity_column(columnName) {
  const normalized = _normalize(columnName);
  if (ENTITY_COLUMNS.has(normalized)) return true;
  for (const field of ENTITY_COLUMNS) {
    if (normalized.endsWith(`_${field}`)) return true;
  }
  return false;
}

export const is_entity_column = _is_entity_column;
export const isEntityColumn = _is_entity_column;

// ---------------------------------------------------------------------------
// Context metadata helpers
// ---------------------------------------------------------------------------

export function _table_columns(context) {
  const result = {};
  const tables = context?.tables;
  if (!tables || typeof tables !== "object") return result;

  for (const [tableName, tableInfo] of Object.entries(tables)) {
    if (!tableInfo || typeof tableInfo !== "object") continue;
    const columns = tableInfo.columns;
    if (!Array.isArray(columns)) continue;
    const normalizedCols = columns.filter(c => c && typeof c === "object");
    result[String(tableName)] = normalizedCols;
  }
  return result;
}

export const table_columns = _table_columns;
export const tableColumns = _table_columns;

export function _primary_keys(context) {
  const result = {};
  const tables = context?.tables;
  if (!tables || typeof tables !== "object") return result;

  for (const [tableName, tableInfo] of Object.entries(tables)) {
    if (!tableInfo || typeof tableInfo !== "object") continue;
    const pks = tableInfo.primary_keys || [];
    const pkSet = new Set(
      (Array.isArray(pks) ? pks : [])
        .filter(c => typeof c === "string")
        .map(c => _normalize(c))
    );
    result[String(tableName)] = pkSet;
  }
  return result;
}

export const primary_keys = _primary_keys;
export const primaryKeys = _primary_keys;

export function _foreign_key_columns(context) {
  const result = new Set();
  const rels = context?.relationships;
  if (!Array.isArray(rels)) return result;

  for (const rel of rels) {
    if (!rel || typeof rel !== "object") continue;
    const type = String(rel.relationship_type || "").trim().toUpperCase();
    if (type !== "FOREIGN_KEY") continue;
    const sourceTable = rel.source_table;
    const sourceColumn = rel.source_column;
    if (sourceTable && sourceColumn) {
      result.add(`${String(sourceTable)}|${_normalize(String(sourceColumn))}`);
    }
  }
  return result;
}

export const foreign_key_columns = _foreign_key_columns;
export const foreignKeyColumns = _foreign_key_columns;

export function _column_type(tableColumnsMap, tableName, columnName) {
  const normalizedCol = _normalize(columnName);
  const cols = tableColumnsMap[tableName] || [];
  for (const c of cols) {
    if (!c || typeof c !== "object") continue;
    if (_normalize(String(c.name || "")) === normalizedCol) {
      return String(c.type || "").toLowerCase();
    }
  }
  return "";
}

export const column_type = _column_type;
export const columnType = _column_type;

// ---------------------------------------------------------------------------
// Type compatibility
// ---------------------------------------------------------------------------

export function _normalized_type(dataType) {
  const val = String(dataType || "").toLowerCase().trim();
  if (!val) return "";
  if (val.includes("uuid")) return "uuid";
  if (["smallint", "integer", "bigint", "serial", "int"].some(t => val.includes(t))) return "integer";
  if (["character", "varchar", "text", "citext"].some(t => val.includes(t))) return "string";
  if (val.includes("boolean") || val === "bool") return "boolean";
  if (["numeric", "decimal", "double", "real", "float"].some(t => val.includes(t))) return "numeric";
  if (["timestamp", "date", "time"].some(t => val.includes(t))) return "datetime";
  return val;
}

export const normalized_type = _normalized_type;
export const normalizedType = _normalized_type;

export function _types_compatible(left, right) {
  const leftType = _normalized_type(left);
  const rightType = _normalized_type(right);
  if (!leftType || !rightType) return true;
  if (leftType === rightType) return true;

  const textCastable = new Set(["uuid", "integer"]);
  if (
    (leftType === "string" && textCastable.has(rightType)) ||
    (rightType === "string" && textCastable.has(leftType))
  ) {
    return true;
  }
  return false;
}

export const types_compatible = _types_compatible;
export const typesCompatible = _types_compatible;

// ---------------------------------------------------------------------------
// Semantic entity matching
// ---------------------------------------------------------------------------

export function _identifier_matches_table(identifierBase, tableName) {
  const idTokens = _semantic_tokens(identifierBase);
  const tableTokens = _semantic_tokens(tableName);
  if (idTokens.size === 0 || tableTokens.size === 0) return false;

  const idExpanded = new Set();
  const tableExpanded = new Set();
  for (const t of idTokens) {
    for (const v of _plural_variants(t)) idExpanded.add(v);
  }
  for (const t of tableTokens) {
    for (const v of _plural_variants(t)) tableExpanded.add(v);
  }

  for (const v of idExpanded) {
    if (tableExpanded.has(v)) return true;
  }
  return false;
}

export const identifier_matches_table = _identifier_matches_table;
export const identifierMatchesTable = _identifier_matches_table;

export function _same_identifier_semantics(left, right) {
  const leftBase = _identifier_base(left) || _normalize(left);
  const rightBase = _identifier_base(right) || _normalize(right);
  if (!leftBase || !rightBase) return false;

  const leftTokens = _semantic_tokens(leftBase);
  const rightTokens = _semantic_tokens(rightBase);
  if (leftTokens.size === 0 || rightTokens.size === 0) return false;

  const leftExpanded = new Set();
  const rightExpanded = new Set();
  for (const t of leftTokens) {
    for (const v of _plural_variants(t)) leftExpanded.add(v);
  }
  for (const t of rightTokens) {
    for (const v of _plural_variants(t)) rightExpanded.add(v);
  }

  for (const v of leftExpanded) {
    if (rightExpanded.has(v)) return true;
  }
  return false;
}

export const same_identifier_semantics = _same_identifier_semantics;
export const sameIdentifierSemantics = _same_identifier_semantics;

export function _identifier_family_match(leftColumn, rightColumn) {
  const leftBase = _canonical_identifier(leftColumn);
  const rightBase = _canonical_identifier(rightColumn);
  if (!leftBase || !rightBase) return false;
  return _same_identifier_semantics(leftBase, rightBase);
}

export const identifier_family_match = _identifier_family_match;
export const identifierFamilyMatch = _identifier_family_match;

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export function _build_evidence({
  source_table,
  source_column,
  target_table,
  target_column,
  source_is_pk,
  target_is_pk,
  source_is_fk,
  target_is_fk,
  source_type,
  target_type,
  source_base = null,
  target_base = null
}) {
  let score = 0;
  const evidence = [];

  const effectiveSourceBase = source_base || _identifier_base(source_column);
  const effectiveTargetBase = target_base || _identifier_base(target_column);

  const tableSimilarity = _semantic_similarity(source_table, target_table);

  // 1. Canonical identifier family
  if (_identifier_family_match(source_column, target_column)) {
    score += 7;
    evidence.push(
      "Source and target columns belong to the same semantic identifier family"
    );
  }

  // 2. Source identifier -> target entity
  if (
    effectiveSourceBase &&
    _identifier_matches_table(effectiveSourceBase, target_table)
  ) {
    score += 5;
    evidence.push(
      `${source_column} identifies the semantic entity represented by target table ${target_table}`
    );
  }

  // 3. Target identifier -> source entity
  if (
    effectiveTargetBase &&
    _identifier_matches_table(effectiveTargetBase, source_table)
  ) {
    score += 2;
    evidence.push(
      `${target_column} identifies the semantic entity represented by source table ${source_table}`
    );
  }

  // 4. Identifier semantics
  if (effectiveSourceBase && effectiveTargetBase) {
    if (_same_identifier_semantics(effectiveSourceBase, effectiveTargetBase)) {
      score += 4;
      evidence.push(
        `Identifier semantics match: ${source_column} <-> ${target_column}`
      );
    }
  }

  // 5. Table similarity
  if (tableSimilarity >= 0.5) {
    score += 2;
    evidence.push("Source and target tables have matching semantic tokens");
  } else if (tableSimilarity >= 0.25) {
    score += 1;
    evidence.push("Source and target tables have partial semantic overlap");
  }

  // 6. FK -> PK
  if (source_is_fk && target_is_pk) {
    score += 4;
    evidence.push(
      "Source column is a foreign key and target column is a primary key"
    );
  } else if (source_is_fk) {
    score += 1;
    evidence.push("Source column participates in a foreign-key relationship");
  }

  if (source_is_pk && target_is_fk) {
    score += 1;
    evidence.push(
      "Source column is a primary key and target column participates in a foreign-key relationship"
    );
  }

  // 7. Exact column match
  if (_normalize(source_column) === _normalize(target_column)) {
    if (
      _is_identifier_column(source_column) &&
      _is_identifier_column(target_column)
    ) {
      score += 3;
      evidence.push("Identifier column names match exactly");
    }
  }

  // 8. Type compatibility
  if (_types_compatible(source_type, target_type)) {
    score += 2;
    evidence.push(`Compatible data types: ${source_type} <-> ${target_type}`);
  } else {
    score -= 3;
    evidence.push(`Data types differ: ${source_type} <-> ${target_type}`);
  }

  return [score, evidence, tableSimilarity];
}

export const build_evidence = _build_evidence;
export const buildEvidence = _build_evidence;

// ---------------------------------------------------------------------------
// Candidate generation
// ---------------------------------------------------------------------------

export function _entity_base(tableName, columnName, isPk) {
  const base = _identifier_base(columnName);
  if (base) return base;
  if (isPk && _normalize(columnName) === "id") {
    return _normalize(tableName);
  }
  return null;
}

export function _is_child_of(tableName, fkColumnsSet, entityTable) {
  for (const entry of fkColumnsSet) {
    const [fkTable, fkColNorm] = entry.split("|");
    if (fkTable !== tableName) continue;

    const fkBase = _identifier_base(fkColNorm);
    if (fkBase && _identifier_matches_table(fkBase, entityTable)) {
      return true;
    }
  }
  return false;
}

/**
 * Generate dynamic DB1 -> DB2 relationship candidates.
 * Schema-driven and read-only. Nothing is hardcoded per database.
 */
export function findCrossSourceCandidates(db1Context, db2Context) {
  const db1Columns = _table_columns(db1Context);
  const db2Columns = _table_columns(db2Context);

  const db1Pks = _primary_keys(db1Context);
  const db2Pks = _primary_keys(db2Context);

  const db1Fks = _foreign_key_columns(db1Context);
  const db2Fks = _foreign_key_columns(db2Context);

  let candidates = [];

  for (const [sourceTable, sourceCols] of Object.entries(db1Columns)) {
    for (const sourceInfo of sourceCols) {
      if (!sourceInfo || typeof sourceInfo !== "object") continue;

      const sourceColumn = sourceInfo.name;
      if (!sourceColumn) continue;

      const sourceColStr = String(sourceColumn);
      const sourceNorm = _normalize(sourceColStr);

      const sourceIsPk = (db1Pks[sourceTable] || new Set()).has(sourceNorm);
      const sourceIsFk = db1Fks.has(`${sourceTable}|${sourceNorm}`);
      const sourceIsPkId = sourceIsPk && sourceNorm === "id";
      const sourceIsEntityKey = ENTITY_KEY_COLUMNS.has(sourceNorm);

      if (_is_generic_column(sourceColStr) && !sourceIsPkId) {
        continue;
      }

      if (_is_entity_column(sourceColStr) && !sourceIsEntityKey) {
        continue;
      }

      const sourceBase = _entity_base(sourceTable, sourceColStr, sourceIsPk);
      if (!sourceBase && !sourceIsEntityKey) {
        continue;
      }

      const sourceType = _column_type(db1Columns, sourceTable, sourceColStr);

      for (const [targetTable, targetCols] of Object.entries(db2Columns)) {
        const tableSimilarity = _semantic_similarity(sourceTable, targetTable);
        const sameSemanticTable = tableSimilarity >= 0.5;

        for (const targetInfo of targetCols) {
          if (!targetInfo || typeof targetInfo !== "object") continue;

          const targetColumn = targetInfo.name;
          if (!targetColumn) continue;

          const targetColStr = String(targetColumn);
          const targetNorm = _normalize(targetColStr);

          const targetIsPk = (db2Pks[targetTable] || new Set()).has(targetNorm);
          const targetIsFk = db2Fks.has(`${targetTable}|${targetNorm}`);
          const targetIsPkId = targetIsPk && targetNorm === "id";
          const targetIsEntityKey = ENTITY_KEY_COLUMNS.has(targetNorm);

          if (_is_generic_column(targetColStr) && !targetIsPkId) {
            continue;
          }

          if (_is_entity_column(targetColStr) && !targetIsEntityKey) {
            continue;
          }

          let entityKeyPair = false;
          let targetBase = null;

          if (sourceIsEntityKey || targetIsEntityKey) {
            if (
              !(
                sourceIsEntityKey &&
                targetIsEntityKey &&
                sourceNorm === targetNorm &&
                sameSemanticTable
              )
            ) {
              continue;
            }
            entityKeyPair = true;
            targetBase = null;
          } else {
            entityKeyPair = false;
            targetBase = _entity_base(targetTable, targetColStr, targetIsPk);

            if (!targetBase) continue;

            // Home-key rule: target column must identify target table's own entity
            if (!_identifier_matches_table(targetBase, targetTable)) {
              continue;
            }
          }

          const targetType = _column_type(db2Columns, targetTable, targetColStr);

          // Type compatibility
          if (!_types_compatible(sourceType, targetType)) {
            continue;
          }

          // Integer surrogate keys check
          if (
            _normalized_type(targetType) === "integer" &&
            _normalized_type(sourceType) !== "integer"
          ) {
            continue;
          }

          // Primary-key "id" on the source side
          if (sourceIsPkId && !entityKeyPair) {
            if (!sameSemanticTable) continue;
            if (_is_child_of(sourceTable, db1Fks, targetTable)) continue;
          }

          // Semantic gate
          let sourcePointsToTarget = false;
          let targetPointsToSource = false;
          let identifiersMatch = false;
          let identifierFamilyMatch = false;

          if (!entityKeyPair) {
            sourcePointsToTarget = _identifier_matches_table(sourceBase, targetTable);
            targetPointsToSource = _identifier_matches_table(targetBase, sourceTable);
            identifiersMatch = _same_identifier_semantics(sourceBase, targetBase);
            identifierFamilyMatch = identifiersMatch;

            if (
              !(
                sourcePointsToTarget ||
                identifiersMatch ||
                sourceIsPkId
              )
            ) {
              continue;
            }
          } else {
            sourcePointsToTarget = true;
            targetPointsToSource = true;
            identifiersMatch = true;
            identifierFamilyMatch = true;
          }

          const [score, evidence, computedSimilarity] = _build_evidence({
            source_table: sourceTable,
            source_column: sourceColStr,
            target_table: targetTable,
            target_column: targetColStr,
            source_is_pk: sourceIsPk,
            target_is_pk: targetIsPk,
            source_is_fk: sourceIsFk,
            target_is_fk: targetIsFk,
            source_type: sourceType,
            target_type: targetType,
            source_base: sourceBase,
            target_base: targetBase
          });

          const compatibleTypes = _types_compatible(sourceType, targetType);
          let strength;

          if (entityKeyPair) {
            strength = "possible";
            evidence.push(
              "Entity key (same column on the same entity table) - data evidence decides"
            );
          } else if (identifierFamilyMatch && sourcePointsToTarget) {
            strength = "strong";
          } else if (score >= 11) {
            strength = "strong";
          } else if (score >= 7) {
            strength = "possible";
          } else {
            continue;
          }

          candidates.push({
            relationship_type: "CROSS_SOURCE_SEMANTIC",
            source_system: "db1",
            target_system: "db2",
            source_table: sourceTable,
            source_column: sourceColStr,
            target_table: targetTable,
            target_column: targetColStr,
            strength,
            score,
            table_similarity: Math.round(computedSimilarity * 1000) / 1000,
            semantic_similarity: Math.round(computedSimilarity * 1000) / 1000,
            source_column_type: sourceType,
            target_column_type: targetType,
            source_is_primary_key: sourceIsPk,
            target_is_primary_key: targetIsPk,
            source_is_foreign_key: sourceIsFk,
            target_is_foreign_key: targetIsFk,
            identifier_family: sourceBase,
            identifier_family_match: identifierFamilyMatch,
            compatible_types: compatibleTypes,
            evidence
          });
        }
      }
    }
  }

  // Deduplicate: unique by (source_table, source_column, target_table, target_column), keep highest score
  const unique = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.source_table}|${candidate.source_column}|${candidate.target_table}|${candidate.target_column}`;
    const previous = unique.get(key);
    if (!previous || candidate.score > previous.score) {
      unique.set(key, candidate);
    }
  }

  candidates = Array.from(unique.values());

  // Sort matching Python lambda
  candidates.sort((a, b) => {
    const strA = a.strength === "strong" ? 0 : 1;
    const strB = b.strength === "strong" ? 0 : 1;
    if (strA !== strB) return strA - strB;
    if (b.score !== a.score) return b.score - a.score;
    if (b.table_similarity !== a.table_similarity) return b.table_similarity - a.table_similarity;
    const cmpST = a.source_table.localeCompare(b.source_table);
    if (cmpST !== 0) return cmpST;
    const cmpSC = a.source_column.localeCompare(b.source_column);
    if (cmpSC !== 0) return cmpSC;
    const cmpTT = a.target_table.localeCompare(b.target_table);
    if (cmpTT !== 0) return cmpTT;
    return a.target_column.localeCompare(b.target_column);
  });

  return candidates;
}

export const find_cross_source_candidates = findCrossSourceCandidates;

export default {
  GENERIC_COLUMNS,
  ENTITY_COLUMNS,
  IDENTIFIER_SUFFIXES,
  IDENTIFIER_QUALIFIERS,
  SEMANTIC_QUALIFIERS,
  ENTITY_KEY_COLUMNS,
  _normalize,
  normalize,
  normalizeName,
  _tokens,
  tokens,
  _semantic_tokens,
  semantic_tokens,
  semanticTokens,
  _plural_variants,
  plural_variants,
  pluralVariants,
  _semantic_similarity,
  semantic_similarity,
  semanticSimilarity,
  _strip_identifier_qualifiers,
  strip_identifier_qualifiers,
  stripIdentifierQualifiers,
  _identifier_base,
  identifier_base,
  identifierBase,
  _canonical_identifier,
  canonical_identifier,
  canonicalIdentifier,
  _is_identifier_column,
  is_identifier_column,
  isIdentifierColumn,
  _identifier_semantic_signature,
  identifier_semantic_signature,
  identifierSemanticSignature,
  _is_generic_column,
  is_generic_column,
  isGenericColumn,
  _is_entity_column,
  is_entity_column,
  isEntityColumn,
  _table_columns,
  table_columns,
  tableColumns,
  _primary_keys,
  primary_keys,
  primaryKeys,
  _foreign_key_columns,
  foreign_key_columns,
  foreignKeyColumns,
  _column_type,
  column_type,
  columnType,
  _normalized_type,
  normalized_type,
  normalizedType,
  _types_compatible,
  types_compatible,
  typesCompatible,
  _identifier_matches_table,
  identifier_matches_table,
  identifierMatchesTable,
  _same_identifier_semantics,
  same_identifier_semantics,
  sameIdentifierSemantics,
  _identifier_family_match,
  identifier_family_match,
  identifierFamilyMatch,
  _build_evidence,
  build_evidence,
  buildEvidence,
  _entity_base,
  _is_child_of,
  findCrossSourceCandidates,
  find_cross_source_candidates: findCrossSourceCandidates
};
