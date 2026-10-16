import {
  getActiveSemanticCatalogFile,
  loadContext
} from "../context/context_store.js";
import {
  attachSemanticCatalog,
  loadSemanticCatalog
} from "../context/semantic_catalog.js";

// A truthy client with no provider methods keeps QuestionPlanner.plan() on its
// deterministic fallback path without allowing it to recreate an OpenAI client.
export const OFFLINE_PROVIDER = Object.freeze({});

// Tests read the coherent active-generation source/snapshot pair, then remove
// only runtime age from an in-memory catalog copy. The existing semantic
// catalog is attached through its normal fingerprint, schema, relationship,
// and approval validation; no snapshot is modified or rewritten.
export function loadTestContexts() {
  const contexts = {
    db1: loadContext("db1"),
    db2: loadContext("db2")
  };
  const catalogFile = getActiveSemanticCatalogFile();
  if (!catalogFile) {
    throw new Error("No active semantic catalog snapshot is available for tests.");
  }
  const loadedCatalog = loadSemanticCatalog(catalogFile);
  // The active snapshot is a coherent production artifact, but its age is
  // runtime state. Removing only generated_at in this in-memory test copy
  // makes freshness deterministic (unknown) while preserving its actual
  // fingerprint, paths, relationships, and approval metadata.
  const { generated_at: _runtimeGeneratedAt, ...catalog } = loadedCatalog;
  const attached = attachSemanticCatalog(contexts, catalog);

  if (
    attached.status.validation_status !== "validated" ||
    attached.status.fingerprint_status !== "verified"
  ) {
    throw new Error("Test Context Layer fixtures failed semantic catalog validation.");
  }

  return attached.contexts;
}
