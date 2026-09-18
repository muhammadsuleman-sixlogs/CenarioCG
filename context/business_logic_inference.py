import json
from typing import Any

from llm.openai_client import get_openai_client


def build_schema_for_llm(
    context: dict[str, Any],
) -> dict[str, Any]:
    """
    Convert the automatically discovered Context Layer
    into a schema representation for LLM analysis.

    No database entities, columns, or relationships
    are hardcoded here.
    """

    return {
        "tables": context.get("tables", {}),
        "relationships": context.get(
            "relationships",
            [],
        ),
    }


def infer_business_relationships(
    context: dict[str, Any],
) -> list[dict[str, Any]]:
    """
    Infer possible business-level relationships from
    automatically discovered database schema information.

    PostgreSQL is never modified.
    """

    client = get_openai_client()

    schema_context = build_schema_for_llm(context)

    prompt = f"""
You are analyzing a company's relational database schema.

Your task is to infer possible BUSINESS-LEVEL relationships
from the schema information provided below.

IMPORTANT RULES:

1. Do not invent tables.
2. Do not invent columns.
3. Do not invent entity names.
4. Every relationship must reference tables that actually
   exist in the supplied schema.
5. Every relationship must be supported by schema evidence
   or foreign-key evidence.
6. Do not modify the database.
7. Do not assume a relationship merely because table names
   sound related.
8. Return only relationships for which there is reasonable
   evidence.
9. Keep database relationships and inferred business
   semantics conceptually separate.
10. Include the evidence used for every inference.
11. Include a confidence score between 0 and 1.
12. If there is not enough evidence, do not create a
    relationship.

Return JSON only:

{{
  "relationships": [
    {{
      "source_table": "...",
      "target_table": "...",
      "business_relationship": "...",
      "reason": "...",
      "evidence": [
        "..."
      ],
      "confidence": 0.0
    }}
  ]
}}

DATABASE CONTEXT:

{json.dumps(schema_context, indent=2)}
"""

    response = client.responses.create(
        model=OPENAI_MODEL,
        input=prompt,
    )

    output_text = response.output_text

    result = json.loads(output_text)

    return result.get(
        "relationships",
        [],
    )