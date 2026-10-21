import crypto from "crypto";
import { build_context } from "./context_builder.js";
import { getActiveSemanticCatalogFile, markActiveGenerationVerified, publishContextGeneration, save_context } from "./context_store.js";
import { loadSemanticCatalog } from "./semantic_catalog.js";
import { saveValidatedCrossSourceRelationships, validateCrossSourceRelationships } from "./cross_source_business_logic.js";
import { getRegisteredPostgresqlSourceIds } from "../database/connection.js";
import { settings } from "../config/settings.js";
import { fetchAndDiscoverOpenApiContext } from "../external_api/openapi.js";
import { clearCategoricalValueCache } from "../retrieval/categorical_value_cache.js";

/**
 * Explicit, local snapshot lifecycle. Callers must authorize the source before
 * invoking this function. Discovery queries PostgreSQL catalogs only; it never
 * mutates a connected source. Failed or empty discoveries are not published.
 */
export async function refreshContextSnapshot(sourceId, { buildContext = build_context } = {}) {
  const normalized = typeof sourceId === "string" ? sourceId.trim().toLowerCase() : "";
  if (!normalized) throw new Error("A source identifier is required for context refresh.");
  const context = await buildContext(normalized);
  if (!context || typeof context !== "object" || !context.tables || Object.keys(context.tables).length === 0) {
    throw new Error("Context discovery returned no tables; the existing snapshot was retained.");
  }
  const canonical = {
    ...context,
    source_id: normalized,
    snapshot: {
      version: 1,
      fingerprint: crypto.createHash("sha256").update(JSON.stringify({ tables: context.tables, relationships: context.relationships || [] })).digest("hex"),
      generated_at: new Date().toISOString(),
      validation_status: "validated"
    }
  };
  save_context(canonical, normalized);
  clearCategoricalValueCache();
  return canonical;
}

/**
 * Refresh both independent sources as one coherent application metadata
 * generation. Discovery is read-only; only local snapshot files are written.
 * A discovery failure prevents publication and leaves the active generation
 * untouched.
 */
export async function refreshContextGeneration({ sourceIds = null, buildContext = build_context, buildExternalApiContext = fetchAndDiscoverOpenApiContext, apiSourceConfigs = settings.externalApiSources, retention = 5, now = new Date(), directory = undefined, validateRelationships = validateCrossSourceRelationships } = {}) {
  const registered = new Set(getRegisteredPostgresqlSourceIds());
  const apiSources = apiSourceConfigs || {};
  const requested = [...new Set((sourceIds || [...registered, ...Object.keys(apiSources)]).map(sourceId => String(sourceId || "").trim().toLowerCase()))].sort();
  if (requested.length === 0 || requested.some(sourceId => !registered.has(sourceId) && !apiSources[sourceId])) throw new Error("Context refresh requires registered sources.");
  // Build before publication.  The existing scheduler prevents overlap, and a
  // failure leaves the active generation untouched.
  const contexts = Object.fromEntries(await Promise.all(requested.map(async sourceId => [sourceId, registered.has(sourceId)
    ? await buildContext(sourceId)
    : await buildExternalApiContext(apiSources[sourceId])
  ])));
  for (const [sourceId, context] of Object.entries(contexts)) {
    if (!context?.tables || Object.keys(context.tables).length === 0) {
      throw new Error(`${sourceId} discovery returned no tables; active metadata was retained.`);
    }
  }
  let semanticCatalog;
  try {
    semanticCatalog = loadSemanticCatalog(getActiveSemanticCatalogFile(directory) || undefined);
  } catch (error) {
    throw new Error(`Semantic catalog could not be loaded; active metadata was retained: ${error.message || String(error)}`);
  }
  const publication = publishContextGeneration(contexts, { retention, now, directory, requiredSourceIds: requested, semanticCatalog });
  if (!publication.published) {
    // Discovery and compatibility validation succeeded, but the technical
    // fingerprint did not change. Advance only the trusted verification time;
    // never rewrite the generation or claim freshness after a failed refresh.
    const verification = markActiveGenerationVerified({ now, directory });
    clearCategoricalValueCache();
    return { ...publication, last_verified_at: verification.last_verified_at };
  }
  clearCategoricalValueCache();
  // A changed schema may invalidate old cross-source edges. Revalidate using
  // independent, read-only evidence. Keep the prior artifact if collection
  // fails, rather than publishing an incomplete relationship set.
  // Existing business-approved DB1/DB2 contracts retain their dedicated
  // validation path. Other sources contribute only declared, same-source FKs
  // until independent cross-source evidence validates a relationship.
  if (!requested.includes("db1") || !requested.includes("db2")) return publication;
  try {
    const relationships = await validateRelationships(contexts.db1, contexts.db2, { publish: false });
    if (relationships?.error_count === 0) saveValidatedCrossSourceRelationships(relationships);
    else publication.relationships_retained = true;
  } catch (error) {
    publication.relationships_retained = true;
    publication.relationship_refresh_error = String(error?.message || error);
  }
  return publication;
}

/** Start one bounded, non-overlapping application-local refresh loop. */
export function startContextRefreshScheduler({ intervalMs = 15 * 60 * 1000, refresh = refreshContextGeneration, onError = null, onResult = null } = {}) {
  const boundedInterval = Math.max(60_000, Number.isFinite(Number(intervalMs)) ? Number(intervalMs) : 15 * 60 * 1000);
  let running = false;
  let stopped = false;
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await refresh();
      if (typeof onResult === "function") onResult(result);
    } catch (error) {
      if (typeof onError === "function") onError(error);
      else console.warn("Context metadata refresh failed; retaining last known-good generation:", error.message);
    } finally { running = false; }
  };
  const timer = setInterval(run, boundedInterval);
  if (typeof timer.unref === "function") timer.unref();
  return { run, stop() { stopped = true; clearInterval(timer); }, interval_ms: boundedInterval };
}

export default { refreshContextSnapshot, refreshContextGeneration, startContextRefreshScheduler };
