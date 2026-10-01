from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from context.cross_source_inference import (
    find_cross_source_candidates,
)
from context.cross_source_evidence import (
    collect_cross_source_evidence,
)


OUTPUT_FILE = Path("context/cross_source_relationships.json")


# ---------------------------------------------------------------------------
# Decision rules
# ---------------------------------------------------------------------------
#
# Accept / reject is decided from the DATA EVIDENCE with fixed rules, not by
# an LLM. The previous LLM-only validation gave different verdicts for
# identical evidence (uuid vs varchar was accepted for
# project_team_stages.project_id but rejected for project_tasks.project_id).
#
# The LLM is now optional and only writes a short business explanation for
# relationships that were already accepted by the rules.

# One coincidental match is not a relationship.
MIN_MATCHING_IDENTIFIERS = 2

# Two integer surrogate keys ("1", "2", "3") collide by chance, so they need
# a much higher overlap before they count as the same identifier.
MIN_OVERLAP_RATIO_FOR_INTEGER_KEYS = 0.5

# Set CROSS_SOURCE_LLM_EXPLAIN=1 to let the LLM write explanations for the
# ACCEPTED relationships. It can never change the accept/reject decision.
USE_LLM_EXPLANATIONS = os.getenv(
    "CROSS_SOURCE_LLM_EXPLAIN",
    "0",
).strip().lower() in {"1", "true", "yes"}

EXPLAIN_BATCH_SIZE = 20


def _key(candidate: dict[str, Any]) -> tuple[str, str, str, str]:
    return (
        candidate["source_table"],
        candidate["source_column"],
        candidate["target_table"],
        candidate["target_column"],
    )


def _is_integer_type(data_type: str | None) -> bool:
    value = str(data_type or "").lower()

    return any(
        token in value
        for token in ("smallint", "integer", "bigint", "serial")
    ) or value == "int"


def decide_from_evidence(
    candidate: dict[str, Any],
    data_evidence: dict[str, Any] | None,
) -> dict[str, Any]:
    """
    Deterministic accept / reject decision for one candidate.

    Returns:
        {
            "valid": bool,
            "confidence": float,
            "reason": str,
            "evidence": [str, ...],
            "overlap_ratio": float,
        }
    """

    source_label = (
        f"{candidate['source_system']}."
        f"{candidate['source_table']}."
        f"{candidate['source_column']}"
    )

    target_label = (
        f"{candidate['target_system']}."
        f"{candidate['target_table']}."
        f"{candidate['target_column']}"
    )

    if not data_evidence:
        return {
            "valid": False,
            "confidence": 0.0,
            "reason": "No data evidence was collected for this candidate.",
            "evidence": [],
            "overlap_ratio": 0.0,
        }

    status = data_evidence.get("evidence_status")

    if status == "error" or status is None:
        return {
            "valid": False,
            "confidence": 0.0,
            "reason": (
                "Data evidence could not be collected: "
                f"{data_evidence.get('error', 'unknown error')}"
            ),
            "evidence": [],
            "overlap_ratio": 0.0,
        }

    matches = data_evidence.get("matching_identifier_count") or 0
    source_distinct = data_evidence.get("source_distinct_count") or 0
    target_distinct = data_evidence.get("target_distinct_count") or 0

    smaller_side = min(source_distinct, target_distinct)

    ratio = (
        round(matches / smaller_side, 3)
        if smaller_side
        else 0.0
    )

    counts = (
        f"matching={matches}, {source_label} distinct={source_distinct}, "
        f"{target_label} distinct={target_distinct}, "
        f"overlap of smaller side={ratio}"
    )

    if status != "overlap_detected" or matches == 0:
        return {
            "valid": False,
            "confidence": 0.9,
            "reason": (
                f"No matching identifiers between {source_label} and "
                f"{target_label}."
            ),
            "evidence": [counts],
            "overlap_ratio": ratio,
        }

    if matches < MIN_MATCHING_IDENTIFIERS:
        return {
            "valid": False,
            "confidence": 0.3,
            "reason": (
                f"Only {matches} matching identifier between "
                f"{source_label} and {target_label}; too weak to be "
                "a relationship."
            ),
            "evidence": [counts],
            "overlap_ratio": ratio,
        }

    both_integer = _is_integer_type(
        candidate.get("source_column_type")
    ) and _is_integer_type(
        candidate.get("target_column_type")
    )

    if both_integer and ratio < MIN_OVERLAP_RATIO_FOR_INTEGER_KEYS:
        return {
            "valid": False,
            "confidence": 0.6,
            "reason": (
                "Both columns are integer surrogate keys and the overlap "
                f"({ratio}) is low enough to be coincidence."
            ),
            "evidence": [counts],
            "overlap_ratio": ratio,
        }

    confidence = 0.55 + 0.40 * ratio

    if candidate.get("strength") == "strong":
        confidence += 0.05

    confidence = round(min(confidence, 0.95), 2)

    evidence = [
        "Data evidence (hashed identifiers, lower/trim, compared as text): "
        + counts,
        "Column types: "
        f"{candidate.get('source_column_type')} <-> "
        f"{candidate.get('target_column_type')} "
        "(compared as text, so uuid vs varchar is expected).",
    ]

    evidence.extend(
        str(item)
        for item in candidate.get("evidence", [])
    )

    return {
        "valid": True,
        "confidence": confidence,
        "reason": (
            f"{matches} identifiers match between {source_label} and "
            f"{target_label}."
        ),
        "evidence": evidence,
        "overlap_ratio": ratio,
    }


def _relationship_kind(candidate: dict[str, Any]) -> str:
    source_column = str(candidate["source_column"]).lower()

    if source_column in {"email", "website"}:
        return "entity_key"

    if (
        candidate.get("source_is_primary_key")
        and candidate.get("table_similarity", 0) >= 0.5
    ):
        return "same_entity"

    return "reference"


def _join_hint(candidate: dict[str, Any]) -> str:
    """
    How to compare the two columns in SQL / in application code.
    The evidence was collected with the same normalisation.
    """

    return (
        f"lower(btrim(CAST({candidate['source_table']}."
        f"{candidate['source_column']} AS text))) = "
        f"lower(btrim(CAST({candidate['target_table']}."
        f"{candidate['target_column']} AS text)))"
    )


def _build_result(
    candidate: dict[str, Any],
    data_evidence: dict[str, Any] | None,
    decision: dict[str, Any],
) -> dict[str, Any]:

    valid = decision["valid"]

    matches = (
        data_evidence.get("matching_identifier_count")
        if data_evidence
        else None
    )

    relationship = None

    if valid:
        relationship = (
            f"{candidate['source_system']}.{candidate['source_table']}."
            f"{candidate['source_column']} -> "
            f"{candidate['target_system']}.{candidate['target_table']}."
            f"{candidate['target_column']}"
        )

    return {
        "source_system": candidate["source_system"],
        "target_system": candidate["target_system"],
        "source_table": candidate["source_table"],
        "source_column": candidate["source_column"],
        "target_table": candidate["target_table"],
        "target_column": candidate["target_column"],
        "valid": valid,
        "relationship": relationship,
        "relationship_kind": _relationship_kind(candidate),
        "join_hint": _join_hint(candidate) if valid else None,
        "reason": decision["reason"],
        "confidence": decision["confidence"],
        "evidence": decision["evidence"],
        "candidate_strength": candidate["strength"],
        "candidate_score": candidate["score"],
        "candidate_table_similarity": candidate["table_similarity"],
        "candidate_evidence": candidate["evidence"],
        "source_column_type": candidate["source_column_type"],
        "target_column_type": candidate["target_column_type"],
        "source_is_primary_key": candidate["source_is_primary_key"],
        "target_is_primary_key": candidate["target_is_primary_key"],
        "source_is_foreign_key": candidate["source_is_foreign_key"],
        "target_is_foreign_key": candidate["target_is_foreign_key"],
        # Top-level copies: context_graph.py reads these two fields.
        "matching_identifier_count": matches,
        "overlap_detected": bool(matches),
        "overlap_ratio": decision["overlap_ratio"],
        "data_evidence": {
            "evidence_status": (
                data_evidence.get("evidence_status")
                if data_evidence
                else None
            ),
            "source_distinct_count": (
                data_evidence.get("source_distinct_count")
                if data_evidence
                else None
            ),
            "target_distinct_count": (
                data_evidence.get("target_distinct_count")
                if data_evidence
                else None
            ),
            "matching_identifier_count": matches,
        },
        "source": "rule_based_cross_source_validation",
    }


# ---------------------------------------------------------------------------
# Optional LLM explanations (never changes a decision)
# ---------------------------------------------------------------------------

def _extract_json(response: Any) -> dict[str, Any]:
    text = getattr(response, "output_text", None)

    if not text:
        raise ValueError("LLM returned no output text.")

    text = text.strip()

    if text.startswith("```"):
        lines = text.splitlines()

        if lines and lines[0].startswith("```"):
            lines = lines[1:]

        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]

        text = "\n".join(lines).strip()

        if text.lower().startswith("json"):
            text = text[4:].strip()

    return json.loads(text)


def _explain_accepted(
    accepted: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """
    Ask the LLM for a one-line business meaning of each ACCEPTED
    relationship. Only `business_meaning` is written; decisions,
    confidence and evidence are untouched.
    """

    errors: list[dict[str, Any]] = []

    if not accepted:
        return errors

    from llm.openai_client import (  # imported lazily: optional feature
        get_openai_client,
        OPENAI_MODEL,
    )

    client = get_openai_client()

    for start in range(0, len(accepted), EXPLAIN_BATCH_SIZE):
        batch = accepted[start:start + EXPLAIN_BATCH_SIZE]

        payload = [
            {
                "candidate_index": index,
                "source": (
                    f"{item['source_system']}.{item['source_table']}."
                    f"{item['source_column']}"
                ),
                "target": (
                    f"{item['target_system']}.{item['target_table']}."
                    f"{item['target_column']}"
                ),
                "kind": item["relationship_kind"],
            }
            for index, item in enumerate(batch, start=1)
        ]

        prompt = (
            "Each item below is a VERIFIED link between two databases of "
            "the same platform (the values were checked to overlap). For "
            "each, write ONE short sentence describing the business "
            "meaning (for example: 'The same project stored in both "
            "systems'). Do not question the link and do not invent "
            "tables or columns.\n\n"
            "Return ONLY JSON: "
            '{"results":[{"candidate_index":1,"business_meaning":"..."}]}'
            "\n\n" + json.dumps(payload, indent=2)
        )

        try:
            response = client.responses.create(
                model=OPENAI_MODEL,
                input=prompt,
            )

            results = _extract_json(response).get("results", [])

            for result in results:
                index = result.get("candidate_index")

                if (
                    isinstance(index, int)
                    and 1 <= index <= len(batch)
                ):
                    batch[index - 1]["business_meaning"] = str(
                        result.get("business_meaning", "")
                    ).strip()

        except Exception as exc:
            errors.append(
                {
                    "error": (
                        "LLM explanation batch failed "
                        f"(decisions unaffected): {exc}"
                    )
                }
            )

    return errors


# ---------------------------------------------------------------------------
# Main validation pipeline
# ---------------------------------------------------------------------------

def validate_cross_source_relationships(
    db1_context: dict[str, Any],
    db2_context: dict[str, Any],
) -> dict[str, Any]:

    candidates = find_cross_source_candidates(
        db1_context,
        db2_context,
    )

    print("\n" + "=" * 70)
    print("CROSS-SOURCE VALIDATION (rule-based on data evidence)")
    print("=" * 70)

    print(f"\nCandidates received: {len(candidates)}")

    validated: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []

    if candidates:
        print(
            "\nCollecting current read-only cross-source "
            "data evidence..."
        )

        evidence_report = collect_cross_source_evidence(candidates)

        evidence_by_key = {
            _key(item): item
            for item in evidence_report.get("candidates", [])
        }

        for index, candidate in enumerate(candidates, start=1):
            data_evidence = evidence_by_key.get(_key(candidate))

            decision = decide_from_evidence(
                candidate,
                data_evidence,
            )

            result = _build_result(
                candidate,
                data_evidence,
                decision,
            )

            label = (
                f"{candidate['source_table']}."
                f"{candidate['source_column']} -> "
                f"{candidate['target_table']}."
                f"{candidate['target_column']}"
            )

            if decision["valid"]:
                validated.append(result)
                print(
                    f"[{index}/{len(candidates)}] VALID    "
                    f"{label}  (confidence {decision['confidence']})"
                )
            else:
                rejected.append(result)
                print(
                    f"[{index}/{len(candidates)}] REJECTED "
                    f"{label}  ({decision['reason']})"
                )

            if (
                data_evidence
                and data_evidence.get("evidence_status") == "error"
            ):
                errors.append(
                    {
                        "source_table": candidate["source_table"],
                        "source_column": candidate["source_column"],
                        "target_table": candidate["target_table"],
                        "target_column": candidate["target_column"],
                        "error": data_evidence.get("error"),
                    }
                )

        if USE_LLM_EXPLANATIONS:
            print("\nAsking the LLM to explain accepted links...")
            errors.extend(_explain_accepted(validated))

    output = {
        "source_systems": ["db1", "db2"],
        "candidate_count": len(candidates),
        "validated_count": len(validated),
        "rejected_count": len(rejected),
        "error_count": len(errors),
        "validated_relationships": validated,
        "rejected_candidates": rejected,
        "errors": errors,
    }

    OUTPUT_FILE.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    OUTPUT_FILE.write_text(
        json.dumps(
            output,
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    print("\n" + "=" * 70)
    print("VALIDATION SUMMARY")
    print("=" * 70)
    print(f"\nCandidates: {len(candidates)}")
    print(f"Validated:  {len(validated)}")
    print(f"Rejected:   {len(rejected)}")
    print(f"Errors:     {len(errors)}")
    print(f"\nSaved to: {OUTPUT_FILE}")
    print("\n" + "=" * 70)

    return output


# ---------------------------------------------------------------------------
# Test entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":

    from context.context_builder import build_context

    print("\nBuilding DB1 context...")
    db1_context = build_context("db1")

    print("Building DB2 context...")
    db2_context = build_context("db2")

    validate_cross_source_relationships(
        db1_context,
        db2_context,
    )