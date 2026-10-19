import fs from "fs";
import crypto from "crypto";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { attachSemanticCatalog, catalogFingerprint, loadSemanticCatalog, reconcileSemanticCatalog } from "./semantic_catalog.js";
import { getRegisteredPostgresqlSourceIds } from "../database/connection.js";
import { settings } from "../config/settings.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const CONTEXT_DIR = __dirname;
export const DB1_CONTEXT_FILE = resolve(CONTEXT_DIR, "context_db1.json");
export const DB2_CONTEXT_FILE = resolve(CONTEXT_DIR, "context_db2.json");

// Backward-compatible existing context file.
export const LEGACY_CONTEXT_FILE = resolve(CONTEXT_DIR, "context.json");
export const CONTEXT_GENERATIONS_DIR = resolve(CONTEXT_DIR, "generations");
export const ACTIVE_GENERATION_FILE = resolve(CONTEXT_DIR, "active_generation.json");
export const SEMANTIC_CATALOG_SNAPSHOT_FILE = "semantic_catalog.json";

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contextFingerprint(context) {
  return crypto.createHash("sha256")
    .update(stableJson({ source_type: context?.source_type || "postgresql", tables: context?.tables || {}, relationships: context?.relationships || [], api_operations: context?.api_operations || {} }))
    .digest("hex");
}

function prepareSnapshot(context, sourceId, generatedAt = new Date().toISOString(), generation = null) {
  if (!context || typeof context !== "object" || Array.isArray(context)) throw new Error("Context must be a dictionary.");
  if (context.source_id && String(context.source_id).trim().toLowerCase() !== sourceId) throw new Error("Context source_id does not match the target source.");
  if (!context.tables || typeof context.tables !== "object" || Object.keys(context.tables).length === 0) throw new Error("Refusing to publish an empty Context Layer snapshot.");
  return {
    ...context,
    source_id: sourceId,
    snapshot: {
      ...(context.snapshot && typeof context.snapshot === "object" ? context.snapshot : {}),
      version: 2,
      generation,
      fingerprint: contextFingerprint(context),
      generated_at: generatedAt,
      validation_status: "validated",
      table_count: Object.keys(context.tables).length
    }
  };
}

function storagePaths(directory = CONTEXT_DIR) {
  return {
    generationsDir: resolve(directory, "generations"),
    activeGenerationFile: resolve(directory, "active_generation.json")
  };
}

function generationFingerprint(contexts, sourceIds = Object.keys(contexts || {}).sort()) {
  const technical = Object.fromEntries(sourceIds.map(sourceId => [sourceId, {
    fingerprint: contextFingerprint(contexts[sourceId]),
    source_type: contexts[sourceId]?.source_type || "postgresql",
    tables: contexts[sourceId]?.tables || {},
    relationships: contexts[sourceId]?.relationships || [],
    api_operations: contexts[sourceId]?.api_operations || {}
  }]));
  return crypto.createHash("sha256").update(stableJson(technical)).digest("hex");
}

function readActiveGeneration(activeGenerationFile = ACTIVE_GENERATION_FILE) {
  try {
    const manifest = JSON.parse(fs.readFileSync(activeGenerationFile, "utf8"));
    if (!manifest || !/^[A-Za-z0-9_-]+$/.test(String(manifest.generation || ""))) return null;
    return manifest;
  } catch { return null; }
}

function generationContextFile(sourceId, directory = CONTEXT_DIR) {
  const { activeGenerationFile } = storagePaths(directory);
  const active = readActiveGeneration(activeGenerationFile);
  if (!active) return null;
  if (!Array.isArray(active.sources) || !active.sources.includes(sourceId)) return null;
  const { generationsDir } = storagePaths(directory);
  const file = resolve(generationsDir, active.generation, `${sourceId}.json`);
  const expectedRoot = resolve(generationsDir, active.generation);
  return file.startsWith(`${expectedRoot}\\`) || file.startsWith(`${expectedRoot}/`) ? file : null;
}

export function getActiveSemanticCatalogFile(directory = CONTEXT_DIR) {
  const { generationsDir, activeGenerationFile } = storagePaths(directory);
  const active = readActiveGeneration(activeGenerationFile);
  if (!active) return null;
  const file = resolve(generationsDir, active.generation, SEMANTIC_CATALOG_SNAPSHOT_FILE);
  return fs.existsSync(file) ? file : null;
}

export function _get_context_file(source_id) {
  const sourceId = String(source_id || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(sourceId)) throw new Error(`Unsupported context source: ${source_id}`);
  if (sourceId === "db1") return DB1_CONTEXT_FILE;
  if (sourceId === "db2") return DB2_CONTEXT_FILE;
  return resolve(CONTEXT_DIR, `context_${sourceId}.json`);
}

export const getContextFile = _get_context_file;

/**
 * Save one source's discovered Context Layer locally.
 *
 * This writes ONLY to application-local storage.
 * It does NOT write anything to PostgreSQL.
 */
export function save_context(context, source_id = "db1") {
  if (!fs.existsSync(CONTEXT_DIR)) {
    fs.mkdirSync(CONTEXT_DIR, { recursive: true });
  }

  const sourceId = String(source_id).trim().toLowerCase();
  const snapshot = prepareSnapshot(context, sourceId);
  const context_file = _get_context_file(sourceId);
  const temporaryFile = `${context_file}.tmp`;
  // Atomic replace prevents readers from observing a partial discovery result.
  fs.writeFileSync(temporaryFile, JSON.stringify(snapshot, null, 2), "utf-8");
  fs.renameSync(temporaryFile, context_file);

  console.log(`${source_id.toUpperCase()} context saved to: ${context_file}`);
}

export const saveContext = save_context;

/**
 * Load one source's previously generated Context Layer.
 */
export function load_context(source_id = "db1") {
  const context_file = generationContextFile(source_id) || _get_context_file(source_id);

  // Backward compatibility:
  // existing context/context.json is treated as DB1 when the new DB1 file
  // has not been created yet.
  if (!fs.existsSync(context_file)) {
    if (source_id === "db1" && fs.existsSync(LEGACY_CONTEXT_FILE)) {
      const data = fs.readFileSync(LEGACY_CONTEXT_FILE, "utf-8");
      return JSON.parse(data);
    }

    throw new Error(`Context file not found for ${source_id}: ${context_file}`);
  }

  const data = fs.readFileSync(context_file, "utf-8");
  return JSON.parse(data);
}

export const loadContext = load_context;

/**
 * Atomically activate one coherent, application-owned DB1/DB2 metadata
 * generation. Readers follow the manifest pointer, so they see either the
 * old generation or the complete new one, never a half-written pair.
 */
export function publishContextGeneration(contexts, { now = new Date(), retention = 5, directory = CONTEXT_DIR, requiredSourceIds = null, semanticCatalog = null } = {}) {
  if (!contexts || typeof contexts !== "object" || Array.isArray(contexts)) throw new Error("Contexts must be a dictionary.");
  const sourceIds = Object.keys(contexts).sort();
  if (sourceIds.length === 0 || sourceIds.some(sourceId => !/^[a-z][a-z0-9_-]{0,63}$/.test(sourceId))) throw new Error("A coherent generation requires valid source IDs.");
  const required = [...new Set((requiredSourceIds || sourceIds).map(sourceId => String(sourceId || "").trim().toLowerCase()))].sort();
  if (required.length === 0 || required.some(sourceId => !sourceIds.includes(sourceId)) || required.length !== sourceIds.length) throw new Error("A coherent generation must include exactly all required source contexts.");
  const generatedAt = now.toISOString();
  const fingerprint = generationFingerprint(contexts, sourceIds);
  const generation = `${generatedAt.replace(/[^0-9]/g, "").slice(0, 14)}-${fingerprint.slice(0, 12)}`;
  const semanticSnapshot = semanticCatalog
    ? reconcileSemanticCatalog(contexts, semanticCatalog, { generation, validatedAt: now })
    : null;
  const { generationsDir, activeGenerationFile } = storagePaths(directory);
  const active = readActiveGeneration(activeGenerationFile);
  const activeSemanticFile = active?.generation
    ? resolve(generationsDir, active.generation, SEMANTIC_CATALOG_SNAPSHOT_FILE)
    : null;
  const activeSemanticMatches = Boolean(
    semanticSnapshot &&
    active?.semantic_catalog?.technical_fingerprint === semanticSnapshot.technical_fingerprint &&
    active?.semantic_catalog?.schema_generation === active.generation &&
    activeSemanticFile &&
    fs.existsSync(activeSemanticFile)
  );
  if (active?.fingerprint === fingerprint && (!semanticCatalog || activeSemanticMatches)) {
    return { published: false, generation: active.generation, fingerprint, reason: "unchanged" };
  }
  const staging = resolve(generationsDir, `.staging-${generation}`);
  const target = resolve(generationsDir, generation);
  fs.mkdirSync(generationsDir, { recursive: true });
  if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    for (const sourceId of sourceIds) {
      const snapshot = prepareSnapshot(contexts[sourceId], sourceId, generatedAt, generation);
      fs.writeFileSync(resolve(staging, `${sourceId}.json`), JSON.stringify(snapshot, null, 2), "utf8");
    }
    const manifest = {
      version: 1,
      generation,
      fingerprint,
      generated_at: generatedAt,
      last_verified_at: generatedAt,
      sources: sourceIds,
      validation_status: "validated",
      ...(semanticSnapshot ? {
        semantic_catalog: {
          file: SEMANTIC_CATALOG_SNAPSHOT_FILE,
          schema_generation: generation,
          technical_fingerprint: semanticSnapshot.technical_fingerprint,
          validation_status: semanticSnapshot.validation_status
        }
      } : {})
    };
    if (semanticSnapshot) fs.writeFileSync(resolve(staging, SEMANTIC_CATALOG_SNAPSHOT_FILE), JSON.stringify(semanticSnapshot, null, 2), "utf8");
    fs.writeFileSync(resolve(staging, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    fs.renameSync(staging, target);
    const temporaryManifest = `${activeGenerationFile}.tmp`;
    fs.writeFileSync(temporaryManifest, JSON.stringify(manifest, null, 2), "utf8");
    fs.renameSync(temporaryManifest, activeGenerationFile);
  } catch (error) {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  const keep = Math.max(1, Number.isInteger(retention) ? retention : 5);
  const generations = fs.readdirSync(generationsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^[A-Za-z0-9_-]+$/.test(entry.name) && entry.name !== generation)
    .map(entry => entry.name).sort().reverse();
  for (const oldGeneration of generations.slice(Math.max(0, keep - 1))) {
    fs.rmSync(resolve(generationsDir, oldGeneration), { recursive: true, force: true });
  }
  return { published: true, generation, fingerprint };
}

/**
 * Record a successful live verification of the active generation without
 * creating a new schema snapshot. This is deliberately a manifest-only,
 * atomic update: the technical snapshots and semantic catalog remain the
 * exact coherent generation that was just validated by refresh.
 */
export function markActiveGenerationVerified({ now = new Date(), directory = CONTEXT_DIR } = {}) {
  const { generationsDir, activeGenerationFile } = storagePaths(directory);
  const active = readActiveGeneration(activeGenerationFile);
  if (!active?.generation) throw new Error("No active context generation is available to verify.");

  const generationDirectory = resolve(generationsDir, active.generation);
  const manifestFile = resolve(generationDirectory, "manifest.json");
  if (!fs.existsSync(manifestFile)) throw new Error("The active context generation manifest is unavailable.");

  let generationManifest;
  try {
    generationManifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  } catch (error) {
    throw new Error(`The active context generation manifest is invalid: ${error.message || String(error)}`);
  }
  if (generationManifest?.generation !== active.generation || generationManifest.validation_status !== "validated") {
    throw new Error("The active context generation is not validated.");
  }
  for (const sourceId of active.sources || generationManifest.sources || []) {
    const sourceFile = resolve(generationDirectory, `${sourceId}.json`);
    if (!fs.existsSync(sourceFile)) throw new Error("The active context generation is incomplete.");
  }

  const verifiedAt = new Date(now).toISOString();
  const updated = { ...active, last_verified_at: verifiedAt, verification_status: "verified" };
  const temporaryManifest = `${activeGenerationFile}.tmp`;
  fs.writeFileSync(temporaryManifest, JSON.stringify(updated, null, 2), "utf8");
  fs.renameSync(temporaryManifest, activeGenerationFile);
  return updated;
}

export function rollbackContextGeneration(generation, { directory = CONTEXT_DIR } = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(generation || ""))) throw new Error("Invalid context generation.");
  const { generationsDir, activeGenerationFile } = storagePaths(directory);
  const generationDirectory = resolve(generationsDir, generation);
  const generationManifestFile = resolve(generationDirectory, "manifest.json");
  let generationManifest;
  try { generationManifest = JSON.parse(fs.readFileSync(generationManifestFile, "utf8")); } catch {
    // Backward-compatible generations published before per-generation manifests.
    generationManifest = { sources: ["db1", "db2"] };
  }
  const sourceIds = generationManifest.sources;
  if (!Array.isArray(sourceIds) || sourceIds.length === 0 || sourceIds.some(sourceId => !/^[a-z][a-z0-9_-]{0,63}$/.test(String(sourceId)))) throw new Error("Requested context generation is incomplete.");
  const contexts = Object.fromEntries(sourceIds.map(sourceId => {
    const file = resolve(generationDirectory, `${sourceId}.json`);
    if (!fs.existsSync(file)) throw new Error("Requested context generation is incomplete.");
    return [sourceId, JSON.parse(fs.readFileSync(file, "utf8"))];
  }));
  if (generationManifest.semantic_catalog) {
    const semanticFile = resolve(generationDirectory, generationManifest.semantic_catalog.file || SEMANTIC_CATALOG_SNAPSHOT_FILE);
    if (!fs.existsSync(semanticFile)) throw new Error("Requested context generation has no matching semantic catalog snapshot.");
    const semanticCatalog = loadSemanticCatalog(semanticFile);
    if (semanticCatalog.technical_fingerprint !== catalogFingerprint(contexts) || semanticCatalog.provenance?.reconciliation?.schema_generation !== generation) {
      throw new Error("Requested context generation has an incompatible semantic catalog snapshot.");
    }
  }
  const fingerprint = generationFingerprint(contexts, sourceIds.sort());
  const manifest = {
    version: 1,
    generation,
    fingerprint,
    generated_at: new Date().toISOString(),
    sources: sourceIds.sort(),
    validation_status: "rolled_back",
    ...(generationManifest.semantic_catalog ? { semantic_catalog: generationManifest.semantic_catalog } : {})
  };
  const temporaryManifest = `${activeGenerationFile}.tmp`;
  fs.writeFileSync(temporaryManifest, JSON.stringify(manifest, null, 2), "utf8");
  fs.renameSync(temporaryManifest, activeGenerationFile);
  return manifest;
}

export function getContextFreshness(context, maxAgeMs = 24 * 60 * 60 * 1000, now = Date.now()) {
  const generatedAt = context?.snapshot?.generated_at;
  const timestamp = generatedAt ? Date.parse(generatedAt) : NaN;
  if (!Number.isFinite(timestamp)) return { freshness_status: "unknown", age_ms: null };
  const ageMs = Math.max(0, now - timestamp);
  return { freshness_status: ageMs > maxAgeMs ? "stale" : "fresh", age_ms: ageMs };
}

/**
 * Load all available PostgreSQL Context Layers.
 *
 * Returns:
 *   {
 *     "db1": {...},
 *     "db2": {...}
 *   }
 *
 * Only sources with an available context file are loaded.
 */
export function load_all_contexts() {
  const contexts = {};
  const active = readActiveGeneration();
  const sourceIds = Array.isArray(active?.sources) && active.sources.length > 0
    ? active.sources
    : [...getRegisteredPostgresqlSourceIds(), ...Object.keys(settings.externalApiSources || {})];
  for (const source_id of [...new Set(sourceIds)]) {
    try {
      contexts[source_id] = load_context(source_id);
    } catch {
      // Individual missing context files are skipped
      continue;
    }
  }

  if (Object.keys(contexts).length === 0) {
    throw new Error("No PostgreSQL Context Layer files were found.");
  }
  // The semantic overlay is application-owned metadata. A malformed overlay
  // must never replace or mutate the technical schema snapshots.
  try {
    const catalogFile = getActiveSemanticCatalogFile();
    const catalog = loadSemanticCatalog(catalogFile || undefined);
    // `generated_at` identifies when approved semantic definitions were
    // reconciled. A successful unchanged-schema refresh records a separate
    // manifest verification timestamp, which is safe to trust only because
    // the active pointer and all generation files were read together above.
    const verifiedCatalog = active?.last_verified_at
      ? { ...catalog, last_verified_at: active.last_verified_at }
      : catalog;
    return attachSemanticCatalog(contexts, verifiedCatalog).contexts;
  } catch {
    return contexts;
  }
}

export const loadAllContexts = load_all_contexts;

export default {
  CONTEXT_DIR,
  DB1_CONTEXT_FILE,
  DB2_CONTEXT_FILE,
  LEGACY_CONTEXT_FILE,
  SEMANTIC_CATALOG_SNAPSHOT_FILE,
  _get_context_file,
  getContextFile,
  getActiveSemanticCatalogFile,
  save_context,
  saveContext,
  load_context,
  loadContext,
  contextFingerprint,
  publishContextGeneration,
  markActiveGenerationVerified,
  rollbackContextGeneration,
  getContextFreshness,
  load_all_contexts,
  loadAllContexts,
};
