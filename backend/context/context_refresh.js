import crypto from "crypto";
import { build_context } from "./context_builder.js";
import { save_context } from "./context_store.js";

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
  return canonical;
}

export default { refreshContextSnapshot };
