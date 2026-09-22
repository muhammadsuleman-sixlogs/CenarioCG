from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from context.cross_source_inference import (
    find_cross_source_candidates,
)
from context.cross_source_evidence import (
    collect_cross_source_evidence,
)
from llm.openai_client import (
    get_openai_client,
    OPENAI_MODEL,
)


OUTPUT_FILE = Path("context/cross_source_relationships.json")


# ---------------------------------------------------------------------------
# JSON helper
# ---------------------------------------------------------------------------

def _extract_json(response: Any) -> dict[str, Any]:
    """
    Extract JSON from an OpenAI Responses API response.
    Handles plain JSON and markdown-fenced JSON.
    """
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

    try:
        return json.loads(text)

    except json.JSONDecodeError as exc:
        raise ValueError(
            f"LLM returned invalid JSON: {text}"
        ) from exc


# ---------------------------------------------------------------------------
# Schema context helpers
# ---------------------------------------------------------------------------

def _get_table_context(
    context: dict[str, Any],
    table_name: str,
) -> dict[str, Any]:
    """
    Return only the schema metadata for one table.

    No database rows are accessed.
    """

    table = context.get("tables", {}).get(table_name)

    if not table:
        return {
            "table": table_name,
            "columns": [],
            "primary_keys": [],
            "relationships": [],
        }

    relationships = []

    for relationship in context.get("relationships", []):
        if (
            relationship.get("source_table") == table_name
            or relationship.get("target_table") == table_name
        ):
            relationships.append(
                {
                    "source_table": relationship.get(
                        "source_table"
                    ),
                    "source_column": relationship.get(
                        "source_column"
                    ),
                    "target_table": relationship.get(
                        "target_table"
                    ),
                    "target_column": relationship.get(
                        "target_column"
                    ),
                    "relationship_type": relationship.get(
                        "relationship_type"
                    ),
                    "confidence": relationship.get(
                        "confidence"
                    ),
                    "source": relationship.get(
                        "source"
                    ),
                }
            )

    return {
        "table": table_name,
        "columns": table.get("columns", []),
        "primary_keys": table.get("primary_keys", []),
        "relationships": relationships,
    }


def _build_candidate_context(
    candidate: dict[str, Any],
    db1_context: dict[str, Any],
    db2_context: dict[str, Any],
    data_evidence: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Build the minimum schema and read-only data evidence
    required to validate one candidate.

    Raw database identifiers and hashes are never included.
    """

    source_context = (
        db1_context
        if candidate["source_system"] == "db1"
        else db2_context
    )

    target_context = (
        db1_context
        if candidate["target_system"] == "db1"
        else db2_context
    )

    return {
        "candidate": candidate,
        "source_table_schema": _get_table_context(
            source_context,
            candidate["source_table"],
        ),
        "target_table_schema": _get_table_context(
            target_context,
            candidate["target_table"],
        ),
        "data_evidence": data_evidence or {},
    }


# ---------------------------------------------------------------------------
# Result validation
# ---------------------------------------------------------------------------

def _normalize_validation_result(
    result: dict[str, Any],
    candidate: dict[str, Any],
    data_evidence: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Validate and normalize one LLM decision.

    Source/target identity always comes from the
    schema-derived candidate, never from the LLM.
    """

    valid = result.get("valid")

    if not isinstance(valid, bool):
        raise ValueError(
            "LLM result must contain boolean 'valid'."
        )

    confidence = result.get("confidence", 0.0)

    try:
        confidence = float(confidence)
    except (TypeError, ValueError):
        confidence = 0.0

    confidence = max(
        0.0,
        min(1.0, confidence),
    )

    relationship = result.get("relationship")

    if relationship is not None:
        relationship = str(
            relationship
        ).strip()

    reason = str(
        result.get("reason", "")
    ).strip()

    evidence = result.get(
        "evidence",
        [],
    )

    if not isinstance(evidence, list):
        evidence = [str(evidence)]

    evidence = [
        str(item).strip()
        for item in evidence
        if str(item).strip()
    ]

    return {
        "source_system": candidate["source_system"],
        "target_system": candidate["target_system"],
        "source_table": candidate["source_table"],
        "source_column": candidate["source_column"],
        "target_table": candidate["target_table"],
        "target_column": candidate["target_column"],
        "valid": valid,
        "relationship": (
            relationship
            if valid
            else None
        ),
        "reason": reason,
        "confidence": confidence,
        "evidence": evidence,
        "candidate_strength": candidate["strength"],
        "candidate_score": candidate["score"],
        "candidate_table_similarity": candidate[
            "table_similarity"
        ],
        "candidate_evidence": candidate[
            "evidence"
        ],
        "source_column_type": candidate[
            "source_column_type"
        ],
        "target_column_type": candidate[
            "target_column_type"
        ],
        "source_is_primary_key": candidate[
            "source_is_primary_key"
        ],
        "target_is_primary_key": candidate[
            "target_is_primary_key"
        ],
        "source_is_foreign_key": candidate[
            "source_is_foreign_key"
        ],
        "target_is_foreign_key": candidate[
            "target_is_foreign_key"
        ],
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
            "matching_identifier_count": (
                data_evidence.get("matching_identifier_count")
                if data_evidence
                else None
            ),
        },
        "source": "gpt_cross_source_validation",
    }


# ---------------------------------------------------------------------------
# Batched prompt
# ---------------------------------------------------------------------------

def _build_batch_prompt(
    candidate_contexts: list[dict[str, Any]],
) -> str:
    """
    Build one prompt containing candidate schema metadata
    plus privacy-preserving read-only data evidence.
    """

    context_json = json.dumps(
        candidate_contexts,
        indent=2,
        default=str,
    )

    return f"""
You are validating possible relationships between two
independent PostgreSQL data sources.

Your task is to validate each automatically generated
cross-source candidate using BOTH:

1. schema metadata
2. privacy-preserving data evidence

The data evidence contains only aggregate counts and
whether matching hashed identifiers were detected.

Raw database identifiers are NOT provided.

IMPORTANT RULES:

1. Do NOT invent relationships.

2. Do NOT change any source or target table names.

3. Do NOT change any source or target column names.

4. Do NOT invent tables or columns.

5. Do NOT assume that similarly named columns represent
   the same entity.

6. A foreign key inside one database does NOT automatically
   prove a cross-source relationship.

7. Compatible data types are supporting evidence only.

8. Different data types can represent the same logical
   identifier only when the supplied evidence supports it.

9. Generic fields such as:
   - id
   - name
   - title
   - description
   - created_at
   - updated_at
   - email
   - phone
   - website

   are NOT sufficient by themselves.

10. An "overlap_detected" data evidence result means that
    at least one identifier representation was present in
    both source columns.

11. Data overlap is evidence, but overlap alone does not
    automatically prove the business relationship.

12. A "no_overlap" result is evidence against the proposed
    relationship. Do not mark such a candidate valid unless
    there is exceptionally strong independent schema evidence.

13. The matching_identifier_count represents the number of
    matching hashed identifier values. Raw identifiers are
    intentionally unavailable.

14. Do NOT attempt to reconstruct, guess, or infer the
    underlying identifier values.

15. Do NOT use real-world assumptions that are not supported
    by the supplied schema and data evidence.

16. Confidence must represent confidence in the validation
    decision, not confidence in the candidate generator.

17. Return exactly one result for every candidate.

18. candidate_index must match the supplied candidate index.

19. If evidence is insufficient, mark the candidate invalid.

20. Keep the relationship direction exactly as supplied.

The supplied context is:

{context_json}

Return ONLY valid JSON in exactly this structure:

{{
  "results": [
    {{
      "candidate_index": 1,
      "valid": false,
      "relationship": null,
      "reason": "specific schema and data-evidence based reason",
      "confidence": 0.0,
      "evidence": [
        "specific schema evidence",
        "specific data evidence"
      ]
    }}
  ]
}}

There must be exactly one result for every candidate.
""".strip()


# ---------------------------------------------------------------------------
# Batched LLM validation
# ---------------------------------------------------------------------------

def _validate_batch(
    client: Any,
    candidate_contexts: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """
    Validate all candidates using ONE OpenAI API request.
    """

    prompt = _build_batch_prompt(
        candidate_contexts
    )

    response = client.responses.create(
        model=OPENAI_MODEL,
        input=prompt,
    )

    parsed = _extract_json(response)

    results = parsed.get("results")

    if not isinstance(results, list):
        raise ValueError(
            "LLM response must contain a 'results' list."
        )

    return results


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
    print("CROSS-SOURCE LLM VALIDATION")
    print("=" * 70)

    print(
        f"\nCandidates received: "
        f"{len(candidates)}"
    )

    if not candidates:
        output = {
            "source_systems": [
                "db1",
                "db2",
            ],
            "candidate_count": 0,
            "validated_count": 0,
            "rejected_count": 0,
            "error_count": 0,
            "validated_relationships": [],
            "rejected_candidates": [],
            "errors": [],
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

        return output

    # ---------------------------------------------------------------
    # Collect current read-only data evidence.
    #
    # This queries both databases using the already generated
    # candidates. Only aggregate counts and overlap status are
    # passed to the LLM. Raw identifiers and hashes stay local.
    # ---------------------------------------------------------------

    print(
        "\nCollecting current read-only "
        "cross-source data evidence..."
    )

    evidence_report = collect_cross_source_evidence(
        candidates
    )

    evidence_results = evidence_report.get(
        "candidates",
        [],
    )

    # ---------------------------------------------------------------
    # Build schema + data evidence context for every candidate.
    # ---------------------------------------------------------------

    candidate_contexts = []

    for index, candidate in enumerate(
        candidates,
        start=1,
    ):
        candidate_with_index = dict(candidate)

        candidate_with_index[
            "candidate_index"
        ] = index

        if index <= len(evidence_results):
            data_evidence = evidence_results[
                index - 1
            ]
        else:
            data_evidence = {
                "evidence_status": "error",
                "error": (
                    "No data evidence result "
                    "was returned for this candidate."
                ),
            }

        candidate_contexts.append(
            _build_candidate_context(
                candidate_with_index,
                db1_context,
                db2_context,
                data_evidence=data_evidence,
            )
        )

    print(
        "\nSending all candidates in "
        "ONE LLM validation request..."
    )

    client = get_openai_client()

    validated = []
    rejected = []
    errors = []

    try:
        llm_results = _validate_batch(
            client,
            candidate_contexts,
        )

        result_by_index = {}

        for result in llm_results:
            candidate_index = result.get(
                "candidate_index"
            )

            if not isinstance(
                candidate_index,
                int,
            ):
                continue

            result_by_index[
                candidate_index
            ] = result

        # -----------------------------------------------------------
        # Normalize results against the original candidates.
        # -----------------------------------------------------------

        for index, candidate in enumerate(
            candidates,
            start=1,
        ):

            result = result_by_index.get(
                index
            )

            if result is None:
                errors.append(
                    {
                        "candidate_index": index,
                        "source_system": candidate[
                            "source_system"
                        ],
                        "target_system": candidate[
                            "target_system"
                        ],
                        "source_table": candidate[
                            "source_table"
                        ],
                        "source_column": candidate[
                            "source_column"
                        ],
                        "target_table": candidate[
                            "target_table"
                        ],
                        "target_column": candidate[
                            "target_column"
                        ],
                        "error": (
                            "LLM did not return "
                            "a result for this candidate."
                        ),
                    }
                )

                continue

            try:
                data_evidence = (
                    evidence_results[index - 1]
                    if index <= len(evidence_results)
                    else None
                )

                normalized = (
                    _normalize_validation_result(
                        result,
                        candidate,
                        data_evidence=data_evidence,
                    )
                )

                print("\n" + "-" * 70)

                print(
                    f"Candidate {index}/"
                    f"{len(candidates)}:"
                )

                print(
                    f"{candidate['source_system']}:"
                    f"{candidate['source_table']}."
                    f"{candidate['source_column']}"
                    f" -> "
                    f"{candidate['target_system']}:"
                    f"{candidate['target_table']}."
                    f"{candidate['target_column']}"
                )

                if normalized["valid"]:
                    validated.append(
                        normalized
                    )

                    print(
                        "LLM decision: VALID"
                    )

                else:
                    rejected.append(
                        normalized
                    )

                    print(
                        "LLM decision: REJECTED"
                    )

                print(
                    "Confidence: "
                    f"{normalized['confidence']}"
                )

            except Exception as exc:
                errors.append(
                    {
                        "candidate_index": index,
                        "source_system": candidate[
                            "source_system"
                        ],
                        "target_system": candidate[
                            "target_system"
                        ],
                        "source_table": candidate[
                            "source_table"
                        ],
                        "source_column": candidate[
                            "source_column"
                        ],
                        "target_table": candidate[
                            "target_table"
                        ],
                        "target_column": candidate[
                            "target_column"
                        ],
                        "error": str(exc),
                    }
                )

    except Exception as exc:

        errors.append(
            {
                "error": (
                    "Batch LLM validation failed: "
                    f"{exc}"
                )
            }
        )

    # ----------------------------------------------------------------
    # Save output
    # ----------------------------------------------------------------

    output = {
        "source_systems": [
            "db1",
            "db2",
        ],
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

    # ----------------------------------------------------------------
    # Summary
    # ----------------------------------------------------------------

    print("\n" + "=" * 70)
    print("VALIDATION SUMMARY")
    print("=" * 70)

    print(
        f"\nCandidates: "
        f"{len(candidates)}"
    )

    print(
        f"Validated: "
        f"{len(validated)}"
    )

    print(
        f"Rejected: "
        f"{len(rejected)}"
    )

    print(
        f"Errors: "
        f"{len(errors)}"
    )

    print(
        "\nOpenAI validation requests: 1"
    )

    print(
        f"\nSaved to: "
        f"{OUTPUT_FILE}"
    )

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