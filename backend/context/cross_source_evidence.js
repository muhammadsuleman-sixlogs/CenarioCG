import fs from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { getConnection, getDb2Connection } from "../database/connection.js";
import { validateReadOnlyQuery } from "../database/readonly_guard.js";
import { validateSqlSyntax } from "../retrieval/sql_validator.js";
import { findCrossSourceCandidates } from "./cross_source_inference.js";
import { buildContext } from "./context_builder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const OUTPUT_FILE = resolve(__dirname, "cross_source_evidence.json");
export const EVIDENCE_FILE = OUTPUT_FILE;

/**
 * Safely quote a PostgreSQL identifier.
 * Table and column names come from schema discovery / the internal candidate
 * generator, but identifiers are still quoted before being inserted into generated SQL.
 */
export function quoteIdentifier(value) {
  if (!value || typeof value !== "string" || !value.trim()) {
    throw new Error("SQL identifier cannot be empty.");
  }
  return '"' + value.replace(/"/g, '""') + '"';
}

export const _quote_identifier = quoteIdentifier;

/**
 * Return the appropriate read-only PostgreSQL connection / pool.
 */
export function _getConnection(sourceId) {
  if (sourceId === "db1") {
    return getConnection();
  } else if (sourceId === "db2") {
    return getDb2Connection();
  } else {
    throw new Error(`Unknown source_id: ${sourceId}`);
  }
}

export const _get_connection = _getConnection;
export const getConnectionForSource = _getConnection;

/**
 * Build a read-only query that returns distinct hashes of identifier values.
 * Raw identifier values never leave PostgreSQL.
 */
export function buildHashQuery(tableName, columnName) {
  const tableSql = quoteIdentifier(tableName);
  const columnSql = quoteIdentifier(columnName);

  // lower(btrim(...)) makes comparison robust to case/whitespace differences
  return `
    SELECT DISTINCT
      md5(lower(btrim(CAST(${columnSql} AS text)))) AS value_hash
    FROM ${tableSql}
    WHERE ${columnSql} IS NOT NULL
  `.trim();
}

export const _build_hash_query = buildHashQuery;

/**
 * Retrieve distinct identifier hashes from one source table/column.
 * Returns only hashes and counts. Raw database values are never printed or returned.
 */
export async function loadIdentifierHashes(sourceId, tableName, columnName) {
  const query = buildHashQuery(tableName, columnName);

  // Defense in depth: both validators must approve the query
  validateReadOnlyQuery(query);
  validateSqlSyntax(query);

  const pool = _getConnection(sourceId);
  const client = await pool.connect();

  try {
    // Defense in depth: set session transaction read only
    await client.query("SET TRANSACTION READ ONLY;").catch(() => {});
    const res = await client.query(query);
    const hashes = new Set(
      res.rows
        .map(row => row.value_hash)
        .filter(Boolean)
    );

    return {
      source_id: sourceId,
      table: tableName,
      column: columnName,
      distinct_count: hashes.size,
      hashes
    };
  } finally {
    client.release();
  }
}

export const _load_identifier_hashes = loadIdentifierHashes;

/**
 * Load each unique source/table/column only once.
 * Several candidates may use the same column, preventing unnecessary repeated queries.
 */
export async function buildColumnCache(candidates) {
  const uniqueColumns = new Set();

  for (const candidate of candidates) {
    const sourceId = candidate.source_system;
    const sourceTable = candidate.source_table;
    const sourceColumn = candidate.source_column;

    const targetSourceId = candidate.target_system;
    const targetTable = candidate.target_table;
    const targetColumn = candidate.target_column;

    uniqueColumns.add(JSON.stringify([sourceId, sourceTable, sourceColumn]));
    uniqueColumns.add(JSON.stringify([targetSourceId, targetTable, targetColumn]));
  }

  const sortedColumns = Array.from(uniqueColumns)
    .map(s => JSON.parse(s))
    .sort((a, b) => {
      const keyA = `${a[0]}:${a[1]}.${a[2]}`;
      const keyB = `${b[0]}:${b[1]}.${b[2]}`;
      return keyA.localeCompare(keyB);
    });

  console.log(`Unique source columns to inspect: ${sortedColumns.length}`);

  const cache = new Map();

  for (let index = 0; index < sortedColumns.length; index++) {
    const [sourceId, tableName, columnName] = sortedColumns[index];
    const colKey = `${sourceId}:${tableName}.${columnName}`;

    console.log(
      `Reading identifier evidence ${index + 1}/${sortedColumns.length}: ${colKey}`
    );

    try {
      const data = await loadIdentifierHashes(sourceId, tableName, columnName);
      cache.set(colKey, data);
    } catch (exc) {
      cache.set(colKey, {
        source_id: sourceId,
        table: tableName,
        column: columnName,
        distinct_count: null,
        hashes: null,
        error: exc.message || String(exc)
      });
      console.log(`  ERROR: ${exc.name || "Error"}`);
    }
  }

  return cache;
}

export const _build_column_cache = buildColumnCache;

/**
 * Compare hashed identifiers for one cross-source candidate.
 */
export function compareCandidate(candidate, cache) {
  const sourceKey = `${candidate.source_system}:${candidate.source_table}.${candidate.source_column}`;
  const targetKey = `${candidate.target_system}:${candidate.target_table}.${candidate.target_column}`;

  const sourceData = cache.get(sourceKey) || {};
  const targetData = cache.get(targetKey) || {};

  const result = {
    source_system: candidate.source_system,
    source_table: candidate.source_table,
    source_column: candidate.source_column,
    target_system: candidate.target_system,
    target_table: candidate.target_table,
    target_column: candidate.target_column,
    candidate_strength: candidate.strength,
    candidate_score: candidate.score,
    source_distinct_count: sourceData.distinct_count ?? null,
    target_distinct_count: targetData.distinct_count ?? null,
    matching_identifier_count: null,
    evidence_status: "error"
  };

  if (sourceData.error) {
    result.error = `Source query failed: ${sourceData.error}`;
    return result;
  }

  if (targetData.error) {
    result.error = `Target query failed: ${targetData.error}`;
    return result;
  }

  const sourceHashes = sourceData.hashes || new Set();
  const targetHashes = targetData.hashes || new Set();

  let matchingCount = 0;
  for (const h of sourceHashes) {
    if (targetHashes.has(h)) {
      matchingCount++;
    }
  }

  result.matching_identifier_count = matchingCount;

  const smallerSide = Math.min(sourceHashes.size, targetHashes.size);
  result.overlap_ratio_of_smaller_side = smallerSide
    ? Math.round((matchingCount / smallerSide) * 1000) / 1000
    : 0.0;

  if (matchingCount > 0) {
    result.evidence_status = "overlap_detected";
  } else {
    result.evidence_status = "no_overlap";
  }

  return result;
}

export const _compare_candidate = compareCandidate;

/**
 * Collect read-only identifier evidence for all candidates.
 */
export async function collectCrossSourceEvidence(candidates) {
  console.log();
  console.log("CROSS-SOURCE EVIDENCE");
  console.log("=".repeat(60));
  console.log(`Candidates received: ${candidates.length}`);

  if (!candidates || candidates.length === 0) {
    return {
      candidates: [],
      summary: {
        total_candidates: 0,
        overlap_detected: 0,
        no_overlap: 0,
        errors: 0
      }
    };
  }

  const cache = await buildColumnCache(candidates);
  const results = [];

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    console.log();
    console.log(`Candidate ${index + 1}/${candidates.length}`);
    console.log(`${candidate.source_system}:${candidate.source_table}.${candidate.source_column}`);
    console.log(` -> ${candidate.target_system}:${candidate.target_table}.${candidate.target_column}`);

    const result = compareCandidate(candidate, cache);
    results.push(result);

    if (result.evidence_status === "error") {
      console.log("Evidence: ERROR");
    } else {
      console.log(`DB1/Source distinct identifiers: ${result.source_distinct_count}`);
      console.log(`DB2/Target distinct identifiers: ${result.target_distinct_count}`);
      console.log(`Matching identifiers: ${result.matching_identifier_count}`);
      console.log(`Evidence: ${result.evidence_status}`);
    }
  }

  const overlapCount = results.filter(r => r.evidence_status === "overlap_detected").length;
  const noOverlapCount = results.filter(r => r.evidence_status === "no_overlap").length;
  const errorCount = results.filter(r => r.evidence_status === "error").length;

  return {
    candidates: results,
    summary: {
      total_candidates: results.length,
      overlap_detected: overlapCount,
      no_overlap: noOverlapCount,
      errors: errorCount
    }
  };
}

export const collect_cross_source_evidence = collectCrossSourceEvidence;

/**
 * Save evidence metadata to JSON.
 * Raw identifiers and raw hashes are never saved.
 */
export function saveEvidenceReport(report) {
  fs.mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2), "utf-8");
}

export const save_evidence_report = saveEvidenceReport;

/**
 * Build DB1/DB2 contexts, generate cross-source candidates,
 * and perform the read-only evidence check.
 */
export async function runCrossSourceEvidence() {
  console.log("Building DB1 context...");
  const db1Context = await buildContext("db1");

  console.log("Building DB2 context...");
  const db2Context = await buildContext("db2");

  console.log("Building cross-source candidates...");
  const candidates = findCrossSourceCandidates(db1Context, db2Context);

  const report = await collectCrossSourceEvidence(candidates);
  saveEvidenceReport(report);

  console.log();
  console.log("=".repeat(60));
  console.log("EVIDENCE SUMMARY");
  console.log("=".repeat(60));

  const summary = report.summary;
  console.log(`Candidates: ${summary.total_candidates}`);
  console.log(`Overlap detected: ${summary.overlap_detected}`);
  console.log(`No overlap: ${summary.no_overlap}`);
  console.log(`Errors: ${summary.errors}`);
  console.log(`Saved to: ${OUTPUT_FILE}`);

  return report;
}

export const run_cross_source_evidence = runCrossSourceEvidence;

export default {
  OUTPUT_FILE,
  EVIDENCE_FILE,
  quoteIdentifier,
  _quote_identifier: quoteIdentifier,
  _getConnection,
  _get_connection: _getConnection,
  getConnectionForSource: _getConnection,
  buildHashQuery,
  _build_hash_query: buildHashQuery,
  loadIdentifierHashes,
  _load_identifier_hashes: loadIdentifierHashes,
  buildColumnCache,
  _build_column_cache: buildColumnCache,
  compareCandidate,
  _compare_candidate: compareCandidate,
  collectCrossSourceEvidence,
  collect_cross_source_evidence: collectCrossSourceEvidence,
  saveEvidenceReport,
  save_evidence_report: saveEvidenceReport,
  runCrossSourceEvidence,
  run_cross_source_evidence: runCrossSourceEvidence
};
