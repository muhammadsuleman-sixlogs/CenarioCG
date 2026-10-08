import fs from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const BUSINESS_LOGIC_FILE = resolve(__dirname, "business_relationships.json");

export function loadStore() {
  if (!fs.existsSync(BUSINESS_LOGIC_FILE)) {
    return { relationships: [] };
  }

  try {
    const raw = fs.readFileSync(BUSINESS_LOGIC_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") {
      return { relationships: [] };
    }
    return data;
  } catch {
    return { relationships: [] };
  }
}

/**
 * Save validated business relationships locally.
 *
 * Relationships are stored with their source identity so multiple
 * databases can coexist safely.
 *
 * This writes only to application-local storage.
 * PostgreSQL is never modified.
 */
export function saveBusinessRelationships(relationships, sourceId = "db1") {
  if (!sourceId) {
    throw new Error("source_id is required when saving business relationships.");
  }

  if (!Array.isArray(relationships)) {
    throw new Error("relationships must be an array.");
  }

  const store = loadStore();
  const existing = Array.isArray(store.relationships) ? store.relationships : [];

  // Remove previously stored relationships for this source
  const remaining = existing.filter(r => r.source_id !== sourceId);

  // Add source identity to each newly saved relationship
  const sourceRelationships = relationships.map(relationship => {
    const copy = { ...relationship };
    if (!copy.source_id) {
      copy.source_id = sourceId;
    }
    return copy;
  });

  store.relationships = [...remaining, ...sourceRelationships];

  fs.writeFileSync(
    BUSINESS_LOGIC_FILE,
    JSON.stringify(store, null, 2),
    "utf-8"
  );
}

/**
 * Load previously validated business relationships from local storage.
 *
 * If source_id is provided, only relationships belonging to that source are returned.
 * If source_id is null/undefined, all stored relationships are returned.
 */
export function loadBusinessRelationships(sourceId = null) {
  const store = loadStore();
  const relationships = Array.isArray(store.relationships) ? store.relationships : [];

  if (!sourceId) {
    return relationships;
  }

  return relationships.filter(r => r.source_id === sourceId);
}

// snake_case aliases
export const _load_store = loadStore;
export const load_store = loadStore;
export const save_business_relationships = saveBusinessRelationships;
export const load_business_relationships = loadBusinessRelationships;

export default {
  BUSINESS_LOGIC_FILE,
  loadStore,
  _load_store: loadStore,
  load_store: loadStore,
  saveBusinessRelationships,
  save_business_relationships: saveBusinessRelationships,
  loadBusinessRelationships,
  load_business_relationships: loadBusinessRelationships
};
