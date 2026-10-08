import fs from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { findCrossSourceCandidates } from "./cross_source_inference.js";
import { collectCrossSourceEvidence } from "./cross_source_evidence.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const OUTPUT_FILE = resolve(__dirname, "cross_source_relationships.json");

// ---------------------------------------------------------------------------
// Decision rules
// ---------------------------------------------------------------------------
//
// Accept / reject is decided from DATA EVIDENCE with fixed rules, not by LLM.
// The LLM is optional and only writes a short business explanation for
// relationships that were already accepted by the rules.

export const MIN_MATCHING_IDENTIFIERS = 2;
export const MIN_OVERLAP_RATIO_FOR_INTEGER_KEYS = 0.5;

export const USE_LLM_EXPLANATIONS = ["1", "true", "yes"].includes(
  String(process.env.CROSS_SOURCE_LLM_EXPLAIN || "0").trim().toLowerCase()
);

export const EXPLAIN_BATCH_SIZE = 20;

export function _key(candidate) {
  return `${candidate.source_table}|${candidate.source_column}|${candidate.target_table}|${candidate.target_column}`;
}

export function isIntegerType(dataType) {
  const value = String(dataType || "").toLowerCase();
  return (
    ["smallint", "integer", "bigint", "serial"].some(token => value.includes(token)) ||
    value === "int"
  );
}

export const _is_integer_type = isIntegerType;

/**
 * Deterministic accept / reject decision for one candidate.
 */
export function decideFromEvidence(candidate, dataEvidence) {
  const sourceLabel = `${candidate.source_system}.${candidate.source_table}.${candidate.source_column}`;
  const targetLabel = `${candidate.target_system}.${candidate.target_table}.${candidate.target_column}`;

  if (!dataEvidence) {
    return {
      valid: false,
      confidence: 0.0,
      reason: "No data evidence was collected for this candidate.",
      evidence: [],
      overlap_ratio: 0.0
    };
  }

  const status = dataEvidence.evidence_status;

  if (status === "error" || !status) {
    return {
      valid: false,
      confidence: 0.0,
      reason: `Data evidence could not be collected: ${dataEvidence.error || "unknown error"}`,
      evidence: [],
      overlap_ratio: 0.0
    };
  }

  const matches = dataEvidence.matching_identifier_count || 0;
  const sourceDistinct = dataEvidence.source_distinct_count || 0;
  const targetDistinct = dataEvidence.target_distinct_count || 0;

  const smallerSide = Math.min(sourceDistinct, targetDistinct);
  const ratio = smallerSide ? Math.round((matches / smallerSide) * 1000) / 1000 : 0.0;

  const counts = `matching=${matches}, ${sourceLabel} distinct=${sourceDistinct}, ${targetLabel} distinct=${targetDistinct}, overlap of smaller side=${ratio}`;

  if (status !== "overlap_detected" || matches === 0) {
    return {
      valid: false,
      confidence: 0.9,
      reason: `No matching identifiers between ${sourceLabel} and ${targetLabel}.`,
      evidence: [counts],
      overlap_ratio: ratio
    };
  }

  if (matches < MIN_MATCHING_IDENTIFIERS) {
    return {
      valid: false,
      confidence: 0.3,
      reason: `Only ${matches} matching identifier between ${sourceLabel} and ${targetLabel}; too weak to be a relationship.`,
      evidence: [counts],
      overlap_ratio: ratio
    };
  }

  const bothInteger =
    isIntegerType(candidate.source_column_type) &&
    isIntegerType(candidate.target_column_type);

  if (bothInteger && ratio < MIN_OVERLAP_RATIO_FOR_INTEGER_KEYS) {
    return {
      valid: false,
      confidence: 0.6,
      reason: `Both columns are integer surrogate keys and the overlap (${ratio}) is low enough to be coincidence.`,
      evidence: [counts],
      overlap_ratio: ratio
    };
  }

  let confidence = 0.55 + 0.4 * ratio;
  if (candidate.strength === "strong") {
    confidence += 0.05;
  }
  confidence = Math.round(Math.min(confidence, 0.95) * 100) / 100;

  const evidence = [
    "Data evidence (hashed identifiers, lower/trim, compared as text): " + counts,
    `Column types: ${candidate.source_column_type} <-> ${candidate.target_column_type} (compared as text, so uuid vs varchar is expected).`
  ];

  if (Array.isArray(candidate.evidence)) {
    for (const item of candidate.evidence) {
      evidence.push(String(item));
    }
  }

  return {
    valid: true,
    confidence,
    reason: `${matches} identifiers match between ${sourceLabel} and ${targetLabel}.`,
    evidence,
    overlap_ratio: ratio
  };
}

export const decide_from_evidence = decideFromEvidence;

export function _relationship_kind(candidate) {
  const sourceColumn = String(candidate.source_column || "").toLowerCase();

  if (["email", "website"].includes(sourceColumn)) {
    return "entity_key";
  }

  if (
    candidate.source_is_primary_key &&
    (candidate.table_similarity || 0) >= 0.5
  ) {
    return "same_entity";
  }

  return "reference";
}

export function _join_hint(candidate) {
  return `lower(btrim(CAST(${candidate.source_table}.${candidate.source_column} AS text))) = lower(btrim(CAST(${candidate.target_table}.${candidate.target_column} AS text)))`;
}

export function _build_result(candidate, dataEvidence, decision) {
  const valid = decision.valid;
  const matches = dataEvidence ? dataEvidence.matching_identifier_count : null;

  let relationship = null;
  if (valid) {
    relationship = `${candidate.source_system}.${candidate.source_table}.${candidate.source_column} -> ${candidate.target_system}.${candidate.target_table}.${candidate.target_column}`;
  }

  return {
    source_system: candidate.source_system,
    target_system: candidate.target_system,
    source_table: candidate.source_table,
    source_column: candidate.source_column,
    target_table: candidate.target_table,
    target_column: candidate.target_column,
    valid,
    relationship,
    relationship_kind: _relationship_kind(candidate),
    join_hint: valid ? _join_hint(candidate) : null,
    reason: decision.reason,
    confidence: decision.confidence,
    evidence: decision.evidence,
    candidate_strength: candidate.strength,
    candidate_score: candidate.score,
    candidate_table_similarity: candidate.table_similarity,
    candidate_evidence: candidate.evidence,
    source_column_type: candidate.source_column_type,
    target_column_type: candidate.target_column_type,
    source_is_primary_key: candidate.source_is_primary_key,
    target_is_primary_key: candidate.target_is_primary_key,
    source_is_foreign_key: candidate.source_is_foreign_key,
    target_is_foreign_key: candidate.target_is_foreign_key,
    matching_identifier_count: matches,
    overlap_detected: Boolean(matches),
    overlap_ratio: decision.overlap_ratio,
    data_evidence: {
      evidence_status: dataEvidence ? dataEvidence.evidence_status : null,
      source_distinct_count: dataEvidence ? dataEvidence.source_distinct_count : null,
      target_distinct_count: dataEvidence ? dataEvidence.target_distinct_count : null,
      matching_identifier_count: matches
    },
    source: "rule_based_cross_source_validation"
  };
}

export function _extract_json(text) {
  let cleaned = String(text || "").trim();
  if (cleaned.startsWith("```")) {
    const lines = cleaned.split("\n");
    if (lines[0].startsWith("```")) lines.shift();
    if (lines.length && lines[lines.length - 1].trim() === "```") lines.pop();
    cleaned = lines.join("\n").trim();
    if (cleaned.toLowerCase().startsWith("json")) {
      cleaned = cleaned.slice(4).trim();
    }
  }
  return JSON.parse(cleaned);
}

export async function _explain_accepted(accepted) {
  const errors = [];
  if (!accepted || accepted.length === 0) return errors;

  try {
    const { getOpenAIClient, OPENAI_MODEL } = await import("../llm/openai_client.js");
    const client = getOpenAIClient();

    for (let start = 0; start < accepted.length; start += EXPLAIN_BATCH_SIZE) {
      const batch = accepted.slice(start, start + EXPLAIN_BATCH_SIZE);
      const payload = batch.map((item, idx) => ({
        candidate_index: idx + 1,
        source: `${item.source_system}.${item.source_table}.${item.source_column}`,
        target: `${item.target_system}.${item.target_table}.${item.target_column}`,
        kind: item.relationship_kind
      }));

      const prompt =
        "Each item below is a VERIFIED link between two databases of the same platform (the values were checked to overlap). For each, write ONE short sentence describing the business meaning (for example: 'The same project stored in both systems'). Do not question the link and do not invent tables or columns.\n\n" +
        'Return ONLY JSON: {"results":[{"candidate_index":1,"business_meaning":"..."}]}\n\n' +
        JSON.stringify(payload, null, 2);

      try {
        const response = await client.chat.completions.create({
          model: OPENAI_MODEL,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" }
        });

        const outputText = response.choices?.[0]?.message?.content || "{}";
        const results = _extract_json(outputText).results || [];

        for (const res of results) {
          const index = res.candidate_index;
          if (typeof index === "number" && index >= 1 && index <= batch.length) {
            batch[index - 1].business_meaning = String(res.business_meaning || "").trim();
          }
        }
      } catch (exc) {
        errors.push({
          error: `LLM explanation batch failed (decisions unaffected): ${exc.message || String(exc)}`
        });
      }
    }
  } catch (err) {
    errors.push({
      error: `Failed to load OpenAI client: ${err.message || String(err)}`
    });
  }

  return errors;
}

/**
 * Main cross-source validation pipeline.
 */
export async function validateCrossSourceRelationships(db1Context, db2Context) {
  const candidates = findCrossSourceCandidates(db1Context, db2Context);

  console.log("\n" + "=".repeat(70));
  console.log("CROSS-SOURCE VALIDATION (rule-based on data evidence)");
  console.log("=".repeat(70));
  console.log(`\nCandidates received: ${candidates.length}`);

  const validated = [];
  const rejected = [];
  const errors = [];

  if (candidates.length > 0) {
    console.log("\nCollecting current read-only cross-source data evidence...");
    const evidenceReport = await collectCrossSourceEvidence(candidates);

    const evidenceByKey = new Map();
    for (const item of evidenceReport.candidates || []) {
      const key = `${item.source_table}|${item.source_column}|${item.target_table}|${item.target_column}`;
      evidenceByKey.set(key, item);
    }

    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      const key = `${candidate.source_table}|${candidate.source_column}|${candidate.target_table}|${candidate.target_column}`;
      const dataEvidence = evidenceByKey.get(key);

      const decision = decideFromEvidence(candidate, dataEvidence);
      const result = _build_result(candidate, dataEvidence, decision);

      const label = `${candidate.source_table}.${candidate.source_column} -> ${candidate.target_table}.${candidate.target_column}`;

      if (decision.valid) {
        validated.push(result);
        console.log(
          `[${index + 1}/${candidates.length}] VALID    ${label}  (confidence ${decision.confidence})`
        );
      } else {
        rejected.push(result);
        console.log(
          `[${index + 1}/${candidates.length}] REJECTED ${label}  (${decision.reason})`
        );
      }

      if (dataEvidence && dataEvidence.evidence_status === "error") {
        errors.push({
          source_table: candidate.source_table,
          source_column: candidate.source_column,
          target_table: candidate.target_table,
          target_column: candidate.target_column,
          error: dataEvidence.error
        });
      }
    }

    if (USE_LLM_EXPLANATIONS) {
      console.log("\nAsking the LLM to explain accepted links...");
      const llmErrors = await _explain_accepted(validated);
      errors.push(...llmErrors);
    }
  }

  const output = {
    source_systems: ["db1", "db2"],
    candidate_count: candidates.length,
    validated_count: validated.length,
    rejected_count: rejected.length,
    error_count: errors.length,
    validated_relationships: validated,
    rejected_candidates: rejected,
    errors
  };

  fs.mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf-8");

  console.log("\n" + "=".repeat(70));
  console.log("VALIDATION SUMMARY");
  console.log("=".repeat(70));
  console.log(`\nCandidates: ${candidates.length}`);
  console.log(`Validated:  ${validated.length}`);
  console.log(`Rejected:   ${rejected.length}`);
  console.log(`Errors:     ${errors.length}`);
  console.log(`\nSaved to: ${OUTPUT_FILE}`);
  console.log("\n" + "=".repeat(70));

  return output;
}

export const validate_cross_source_relationships = validateCrossSourceRelationships;

export default {
  OUTPUT_FILE,
  MIN_MATCHING_IDENTIFIERS,
  MIN_OVERLAP_RATIO_FOR_INTEGER_KEYS,
  USE_LLM_EXPLANATIONS,
  EXPLAIN_BATCH_SIZE,
  _key,
  isIntegerType,
  _is_integer_type: isIntegerType,
  decideFromEvidence,
  decide_from_evidence: decideFromEvidence,
  _relationship_kind,
  _join_hint,
  _build_result,
  _extract_json,
  _explain_accepted,
  validateCrossSourceRelationships,
  validate_cross_source_relationships: validateCrossSourceRelationships
};
