import fs from "fs";
import crypto from "crypto";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { attachSemanticCatalog, loadSemanticCatalog } from "./semantic_catalog.js";
import { getRegisteredPostgresqlSourceIds } from "../database/connection.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const CONTEXT_DIR = __dirname;
export const DB1_CONTEXT_FILE = resolve(CONTEXT_DIR, "context_db1.json");
export const DB2_CONTEXT_FILE = resolve(CONTEXT_DIR, "context_db2.json");

// Backward-compatible existing context file.
export const LEGACY_CONTEXT_FILE = resolve(CONTEXT_DIR, "context.json");
export const CONTEXT_GENERATIONS_DIR = resolve(CONTEXT_DIR, "generations");
export const ACTIVE_GENERATION_FILE = resolve(CONTEXT_DIR, "active_generation.json");

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contextFingerprint(context) {
  return crypto.createHash("sha256")
    .update(stableJson({ tables: context?.tables || {}, relationships: context?.relationships || [] }))
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

function readActiveGeneration(activeGenerationFile = ACTIVE_GENERATION_FILE) {
  try {
    const manifest = JSON.parse(fs.readFileSync(activeGenerationFile, "utf8"));
    if (!manifest || !/^[A-Za-z0-9_-]+$/.test(String(manifest.generation || ""))) return null;
    return manifest;
  } catch { return null; }
}

function generationContextFile(sourceId) {
  const active = readActiveGeneration();
  if (!active) return null;
  if (!Array.isArray(active.sources) || !active.sources.includes(sourceId)) return null;
  const file = resolve(CONTEXT_GENERATIONS_DIR, active.generation, `${sourceId}.json`);
  const expectedRoot = resolve(CONTEXT_GENERATIONS_DIR, active.generation);
  return file.startsWith(`${expectedRoot}\\`) || file.startsWith(`${expectedRoot}/`) ? file : null;
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
export function publishContextGeneration(contexts, { now = new Date(), retention = 5, directory = CONTEXT_DIR, requiredSourceIds = null } = {}) {
  if (!contexts || typeof contexts !== "object" || Array.isArray(contexts)) throw new Error("Contexts must be a dictionary.");
  const sourceIds = Object.keys(contexts).sort();
  if (sourceIds.length === 0 || sourceIds.some(sourceId => !/^[a-z][a-z0-9_-]{0,63}$/.test(sourceId))) throw new Error("A coherent generation requires valid source IDs.");
  const required = [...new Set((requiredSourceIds || sourceIds).map(sourceId => String(sourceId || "").trim().toLowerCase()))].sort();
  if (required.length === 0 || required.some(sourceId => !sourceIds.includes(sourceId)) || required.length !== sourceIds.length) throw new Error("A coherent generation must include exactly all required source contexts.");
  const generatedAt = now.toISOString();
  const technical = Object.fromEntries(sourceIds.map(sourceId => [sourceId, {
    fingerprint: contextFingerprint(contexts[sourceId]), tables: contexts[sourceId]?.tables || {}, relationships: contexts[sourceId]?.relationships || []
  }]));
  const fingerprint = crypto.createHash("sha256").update(stableJson(technical)).digest("hex");
  const { generationsDir, activeGenerationFile } = storagePaths(directory);
  const active = readActiveGeneration(activeGenerationFile);
  if (active?.fingerprint === fingerprint) return { published: false, generation: active.generation, fingerprint, reason: "unchanged" };
  const generation = `${generatedAt.replace(/[^0-9]/g, "").slice(0, 14)}-${fingerprint.slice(0, 12)}`;
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
    fs.writeFileSync(resolve(staging, "manifest.json"), JSON.stringify({ version: 1, generation, fingerprint, generated_at: generatedAt, sources: sourceIds, validation_status: "validated" }, null, 2), "utf8");
    fs.renameSync(staging, target);
    const manifest = { version: 1, generation, fingerprint, generated_at: generatedAt, sources: sourceIds, validation_status: "validated" };
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

export function rollbackContextGeneration(generation, { directory = CONTEXT_DIR } = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(generation || ""))) throw new Error("Invalid context generation.");
  const { generationsDir, activeGenerationFile } = storagePaths(directory);
  const generationDirectory = resolve(generationsDir, generation);
  const generationManifestFile = resolve(generationDirectory, "manifest.json");
  let sourceIds;
  try { sourceIds = JSON.parse(fs.readFileSync(generationManifestFile, "utf8")).sources; } catch {
    // Backward-compatible generations published before per-generation manifests.
    sourceIds = ["db1", "db2"];
  }
  if (!Array.isArray(sourceIds) || sourceIds.length === 0 || sourceIds.some(sourceId => !/^[a-z][a-z0-9_-]{0,63}$/.test(String(sourceId)))) throw new Error("Requested context generation is incomplete.");
  const contexts = Object.fromEntries(sourceIds.map(sourceId => {
    const file = resolve(generationDirectory, `${sourceId}.json`);
    if (!fs.existsSync(file)) throw new Error("Requested context generation is incomplete.");
    return [sourceId, JSON.parse(fs.readFileSync(file, "utf8"))];
  }));
  const fingerprint = crypto.createHash("sha256").update(stableJson(Object.fromEntries(Object.entries(contexts).map(([sourceId, context]) => [sourceId, { fingerprint: contextFingerprint(context), tables: context.tables, relationships: context.relationships || [] }])))).digest("hex");
  const manifest = { version: 1, generation, fingerprint, generated_at: new Date().toISOString(), sources: sourceIds.sort(), validation_status: "rolled_back" };
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
    : getRegisteredPostgresqlSourceIds();
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
    return attachSemanticCatalog(contexts, loadSemanticCatalog()).contexts;
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
  _get_context_file,
  getContextFile,
  save_context,
  saveContext,
  load_context,
  loadContext,
  contextFingerprint,
  publishContextGeneration,
  rollbackContextGeneration,
  getContextFreshness,
  load_all_contexts,
  loadAllContexts,
};
