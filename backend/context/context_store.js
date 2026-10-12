import fs from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { attachSemanticCatalog, loadSemanticCatalog } from "./semantic_catalog.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const CONTEXT_DIR = __dirname;
export const DB1_CONTEXT_FILE = resolve(CONTEXT_DIR, "context_db1.json");
export const DB2_CONTEXT_FILE = resolve(CONTEXT_DIR, "context_db2.json");

// Backward-compatible existing context file.
export const LEGACY_CONTEXT_FILE = resolve(CONTEXT_DIR, "context.json");

export function _get_context_file(source_id) {
  if (source_id === "db1") return DB1_CONTEXT_FILE;
  if (source_id === "db2") return DB2_CONTEXT_FILE;
  throw new Error(`Unsupported context source: ${source_id}`);
}

export const getContextFile = _get_context_file;

/**
 * Save one source's discovered Context Layer locally.
 *
 * This writes ONLY to application-local storage.
 * It does NOT write anything to PostgreSQL.
 */
export function save_context(context, source_id = "db1") {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new Error("Context must be a dictionary.");
  }

  if (!fs.existsSync(CONTEXT_DIR)) {
    fs.mkdirSync(CONTEXT_DIR, { recursive: true });
  }

  const sourceId = String(source_id).trim().toLowerCase();
  if (context.source_id && String(context.source_id).trim().toLowerCase() !== sourceId) {
    throw new Error("Context source_id does not match the target source.");
  }
  if (!context.tables || typeof context.tables !== "object" || Object.keys(context.tables).length === 0) {
    throw new Error("Refusing to publish an empty Context Layer snapshot.");
  }
  const snapshot = {
    ...context,
    source_id: sourceId,
    snapshot: {
      ...(context.snapshot && typeof context.snapshot === "object" ? context.snapshot : {}),
      version: 1,
      generated_at: new Date().toISOString(),
      validation_status: "validated",
      table_count: Object.keys(context.tables).length
    }
  };
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
  const context_file = _get_context_file(source_id);

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

  for (const source_id of ["db1", "db2"]) {
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
  getContextFreshness,
  load_all_contexts,
  loadAllContexts,
};
