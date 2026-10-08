import { getOpenAIClient, OPENAI_MODEL } from "../llm/openai_client.js";

/**
 * Convert the automatically discovered Context Layer into a schema
 * representation for LLM analysis.
 *
 * No database entities, columns, or relationships are hardcoded here.
 */
export function buildSchemaForLLM(context) {
  return {
    source_id: context?.source_id || "db1",
    tables: context?.tables || {},
    relationships: context?.relationships || []
  };
}

/**
 * Infer possible business-level relationships from automatically discovered
 * database schema information.
 *
 * PostgreSQL is never modified.
 *
 * Relationships are inferred only within the supplied database context.
 */
export async function inferBusinessRelationships(context) {
  const client = getOpenAIClient();
  const sourceId = context?.source_id || "db1";
  const schemaContext = buildSchemaForLLM(context);

  const prompt = `You are analyzing a company's relational database schema.

DATABASE SOURCE:
${sourceId}

Your task is to infer possible BUSINESS-LEVEL relationships from the schema information provided below.

IMPORTANT RULES:
1. Do not invent tables.
2. Do not invent columns.
3. Do not invent entity names.
4. Every relationship must reference tables that actually exist in the supplied schema.
5. Every relationship must be supported by schema evidence or foreign-key evidence.
6. Do not modify the database.
7. Do not assume a relationship merely because table names sound related.
8. Return only relationships for which there is reasonable evidence.
9. Keep database relationships and inferred business semantics conceptually separate.
10. Include the evidence used for every inference.
11. Include a confidence score between 0 and 1.
12. If there is not enough evidence, do not create a relationship.
13. Relationships in this task must be INTERNAL to the supplied database source.
14. Do not create relationships to tables outside the supplied schema.
15. Every returned relationship MUST include this exact source_id:
    ${sourceId}

Return JSON only in this exact format:
{
  "relationships": [
    {
      "source_id": "${sourceId}",
      "source_table": "...",
      "target_table": "...",
      "business_relationship": "...",
      "reason": "...",
      "evidence": [
        "..."
      ],
      "confidence": 0.0
    }
  ]
}

DATABASE CONTEXT:
${JSON.stringify(schemaContext, null, 2)}
`;

  const response = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      {
        role: "user",
        content: prompt
      }
    ],
    response_format: { type: "json_object" }
  });

  const outputText = response.choices?.[0]?.message?.content || "{}";
  let result;
  try {
    result = JSON.parse(outputText);
  } catch {
    return [];
  }

  const relationships = Array.isArray(result.relationships)
    ? result.relationships
    : [];

  // Defense-in-depth: ensure every returned relationship has the source_id
  const validatedSourceRelationships = [];
  for (const rel of relationships) {
    if (!rel || typeof rel !== "object") continue;
    const copy = { ...rel };
    copy.source_id = sourceId;
    validatedSourceRelationships.push(copy);
  }

  return validatedSourceRelationships;
}

// snake_case aliases for Python parity
export const build_schema_for_llm = buildSchemaForLLM;
export const infer_business_relationships = inferBusinessRelationships;

export default {
  buildSchemaForLLM,
  build_schema_for_llm: buildSchemaForLLM,
  inferBusinessRelationships,
  infer_business_relationships: inferBusinessRelationships
};
