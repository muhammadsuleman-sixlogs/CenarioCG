export const DEFAULT_MIN_CONFIDENCE = 0.90;
export const DEFAULT_AMBIGUITY_MARGIN = 0.05;

/**
 * Determine whether two candidates describe the same discovered entity
 * reference rather than merely similar text.
 */
function sameEntityReference(left, right) {
  const leftSource = String((left && left.source_id) || "").toLowerCase();
  const rightSource = String((right && right.source_id) || "").toLowerCase();
  const leftType = String((left && left.type) || "").toLowerCase();
  const rightType = String((right && right.type) || "").toLowerCase();
  const leftTable = String((left && left.entity_table) || "").toLowerCase();
  const rightTable = String((right && right.entity_table) || "").toLowerCase();
  const leftId = String((left && left.id) || "").toLowerCase();
  const rightId = String((right && right.id) || "").toLowerCase();

  return (
    leftSource === rightSource &&
    leftType === rightType &&
    leftTable === rightTable &&
    leftId === rightId
  );
}

/**
 * Select one unambiguous entity candidate.
 *
 * An entity is selected only when:
 *     - required identity fields are present
 *     - confidence meets the threshold
 *     - a competing candidate is not sufficiently close
 *     - the competing candidate does not represent the same resolved
 *       source/type/table identity
 *
 * When ambiguity remains, return null rather than guessing.
 */
export function selectEntity(
  candidates,
  minConfidence = DEFAULT_MIN_CONFIDENCE,
  ambiguityMargin = DEFAULT_AMBIGUITY_MARGIN
) {
  if (!Array.isArray(candidates)) {
    throw new Error("Entity candidates must be a list.");
  }

  const minConf = Number(minConfidence);
  if (isNaN(minConf) || minConf < 0.0 || minConf > 1.0) {
    throw new Error("min_confidence must be between 0 and 1.");
  }

  const ambMargin = Number(ambiguityMargin);
  if (isNaN(ambMargin) || ambMargin < 0) {
    throw new Error("ambiguity_margin cannot be negative.");
  }

  const validCandidates = [];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }

    let confidence = 0.0;
    try {
      const parsed = parseFloat(candidate.confidence !== undefined ? candidate.confidence : 0.0);
      if (isNaN(parsed)) {
        continue;
      }
      confidence = parsed;
    } catch {
      continue;
    }

    if (confidence < minConf) {
      continue;
    }

    const entityId = candidate.id;
    const entityType = candidate.type;

    if (
      entityId === null ||
      entityId === undefined ||
      !String(entityId).trim() ||
      typeof entityType !== "string" ||
      !entityType.trim()
    ) {
      continue;
    }

    validCandidates.push(candidate);
  }

  if (validCandidates.length === 0) {
    return null;
  }

  validCandidates.sort((a, b) => {
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

  const best = validCandidates[0];
  const bestConfidence = Number(best.confidence) || 0.0;

  const competitors = validCandidates.slice(1);

  for (const competitor of competitors) {
    const competitorConfidence = Number(competitor.confidence) || 0.0;

    if (bestConfidence - competitorConfidence > ambMargin) {
      break;
    }

    if (!sameEntityReference(best, competitor)) {
      return null;
    }
  }

  return { ...best };
}

export const select_entity = selectEntity;
export const _same_entity_reference = sameEntityReference;

export default {
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_AMBIGUITY_MARGIN,
  selectEntity,
  select_entity,
  _same_entity_reference
};
