/**
 * Normalize EntityResolver output into the standard Context Layer
 * conversational-entity representation.
 *
 * This function:
 *     - preserves source provenance
 *     - preserves the discovered table/column
 *     - preserves match evidence
 *     - clamps invalid confidence values
 *     - removes duplicate candidates
 *
 * It does not:
 *     - query PostgreSQL
 *     - infer entity identity
 *     - invent identifiers
 *     - select a winner
 */
export function normalizeEntityCandidates(candidates) {
  if (!Array.isArray(candidates)) {
    throw new Error("Entity candidates must be a list.");
  }

  const normalized = [];
  const seen = new Set();

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }

    const rawEntityId = candidate.value !== undefined && candidate.value !== null
      ? candidate.value
      : (candidate.id !== undefined && candidate.id !== null ? candidate.id : null);

    const rawEntityType = typeof candidate.entity_type === "string"
      ? candidate.entity_type
      : (typeof candidate.type === "string" ? candidate.type : null);

    if (
      rawEntityId === null ||
      !String(rawEntityId).trim() ||
      typeof rawEntityType !== "string" ||
      !rawEntityType.trim()
    ) {
      continue;
    }

    let sourceId = candidate.source_id;
    if (typeof sourceId !== "string" || !sourceId.trim()) {
      sourceId = null;
    } else {
      sourceId = sourceId.trim().toLowerCase();
    }

    let entityTable = candidate.entity_table;
    if (typeof entityTable !== "string" || !entityTable.trim()) {
      entityTable = null;
    } else {
      entityTable = entityTable.trim();
    }

    let entityColumn = candidate.entity_column;
    if (typeof entityColumn !== "string" || !entityColumn.trim()) {
      entityColumn = null;
    } else {
      entityColumn = entityColumn.trim();
    }

    let confidence = 0.0;
    try {
      const parsed = parseFloat(candidate.confidence !== undefined ? candidate.confidence : 0.0);
      confidence = isNaN(parsed) ? 0.0 : parsed;
    } catch {
      confidence = 0.0;
    }

    confidence = Math.max(0.0, Math.min(1.0, confidence));

    const normalizedId = String(rawEntityId).trim();
    const normalizedType = rawEntityType.trim();

    const dedupeKey = `${sourceId || ""}|${normalizedType.toLowerCase()}|${entityTable ? entityTable.toLowerCase() : ""}|${normalizedId.toLowerCase()}`;

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);

    normalized.push({
      type: normalizedType,
      id: normalizedId,
      source_id: sourceId,
      entity_table: entityTable,
      entity_column: entityColumn,
      confidence,
      evidence: candidate.evidence !== undefined ? candidate.evidence : null,
      match_type: candidate.match_type !== undefined ? candidate.match_type : null,
      context_role: "entity_reference"
    });
  }

  normalized.sort((a, b) => {
    const confDiff = (Number(b.confidence) || 0) - (Number(a.confidence) || 0);
    if (confDiff !== 0) return confDiff;

    const srcCmp = String(a.source_id || "").localeCompare(String(b.source_id || ""));
    if (srcCmp !== 0) return srcCmp;

    const tblCmp = String(a.entity_table || "").localeCompare(String(b.entity_table || ""));
    if (tblCmp !== 0) return tblCmp;

    const colCmp = String(a.entity_column || "").localeCompare(String(b.entity_column || ""));
    if (colCmp !== 0) return colCmp;

    return String(a.id || "").localeCompare(String(b.id || ""));
  });

  return normalized;
}

export const normalize_entity_candidates = normalizeEntityCandidates;

export default {
  normalizeEntityCandidates,
  normalize_entity_candidates
};
