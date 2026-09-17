import json

from typing import Any

from context.context_store import load_context
from llm.openai_client import get_openai_client


class QuestionPlanner:
    """
    Dynamically analyze any user question using the discovered Context Layer.

    No database table names, columns, or business relationships are hardcoded.
    """

    def __init__(self, context: dict[str, Any] | None = None):
        self.context = context if context is not None else load_context()
        self.client = get_openai_client()

    def _build_context_for_llm(self) -> dict[str, Any]:
        """
        Build a compact representation of the available Context Layer.
        """

        tables = {}

        for table_name, table_info in self.context.get("tables", {}).items():
            tables[table_name] = {
                "columns": [
                    {
                        "name": column.get("name"),
                        "data_type": column.get("data_type"),
                    }
                    for column in table_info.get("columns", [])
                ],
                "primary_keys": table_info.get("primary_keys", []),
            }

        relationships = self.context.get("relationships", [])

        business_relationships = self.context.get(
            "business_relationships",
            [],
        )

        return {
            "tables": tables,
            "relationships": relationships,
            "business_relationships": business_relationships,
        }

    def plan(
        self,
        question: str,
        conversation_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:

        if not question or not question.strip():
            raise ValueError("Question cannot be empty.")

        context_for_llm = self._build_context_for_llm()

        prompt = f"""
You are a dynamic database question planner.

The user can ask ANY question that may be answerable from the available
company data.

You MUST reason only from the supplied Context Layer.

Do NOT invent:

- tables
- columns
- relationships
- entities
- database fields

Do NOT assume a fixed business domain.

Your task is to determine the SMALLEST RELEVANT retrieval plan that can
answer the user's question.

Return ONLY valid JSON.

Required JSON structure:

{{
  "question": "...",
  "understanding": "...",
  "entities": [
    {{
      "type": "...",
      "id": "..."
    }}
  ],
  "required_tables": [],
  "required_columns": [],
  "relationships": [],
  "filters": [],
  "operations": [],
  "grouping": [],
  "sorting": [],
  "limit": null,
  "needs_conversation_context": false,
  "reasoning": "...",
  "confidence": 0.0
}}

IMPORTANT FORMAT RULE:

required_columns MUST be a flat list of strings using exactly:

"table_name.column_name"

For example:

"required_columns": [
  "some_table.id",
  "some_table.created_at"
]

DO NOT return objects such as:

{{
  "table": "some_table",
  "columns": ["id", "created_at"]
}}

ENTITY FORMAT RULE:

"entities" MUST be a list of objects.

Each entity object MUST use exactly this structure:

{{
  "type": "...",
  "id": "..."
}}

ENTITY RULES:

1. If the user explicitly identifies a specific entity or record,
   include its entity type and identifier.

2. If an entity is resolved from conversation context,
   preserve the resolved entity type and identifier.

3. When conversation context provides entity evidence, use that evidence
   to construct filters.

4. Entity evidence identifies the actual Context Layer table and column
   where the identifier was found.

5. If the conversation context contains:

   {{
     "type": "...",
     "id": "...",
     "evidence": "table_name.column_name"
   }}

   then use that evidence column for the entity filter.

6. Do NOT replace the evidence column with the table's primary key
   merely because the primary key exists.

7. Do NOT assume that an entity identifier is the primary key.

8. Never compare an identifier against a column whose discovered data type
   is incompatible with that identifier.

9. The entity identifier must come from the user's question or the
   supplied conversation context. Never invent an identifier.

10. If no specific entity can be identified, return:

"entities": []

11. Never return bare entity type strings.

12. Never return an entity object without an identifier.

13. When an entity has evidence, preserve the entity type and identifier
    in the "entities" field. The evidence may be used internally to
    construct the correct filter.

For example, if conversation context provides:

{{
  "type": "tickets",
  "id": "TKT-MU2JXPTA-WXLJ",
  "evidence": "tickets.reference_id"
}}

then the retrieval filter MUST use:

"tickets.reference_id = 'TKT-MU2JXPTA-WXLJ'"

and MUST NOT use:

"tickets.id = 'TKT-MU2JXPTA-WXLJ'"

GENERAL RULES:

1. required_tables must contain only tables that exist in the Context Layer.

2. required_columns must contain only columns that exist in the selected
   required_tables.

3. Every required column MUST use table.column format.

4. relationships must use only relationships supported by the Context Layer.

5. Never create fake schema information.

6. Do not assume a fixed business domain.

7. Use the available table columns, primary keys, database relationships,
   and business relationships to understand the data model.

8. Select tables based on their semantic relevance to the user's question.

9. Prefer the SMALLEST set of tables that can answer the question.

10. Do NOT select a table merely because it contains a column with a name
    similar to something mentioned in the question.

11. Do NOT select every table containing a compatible column when only a
    smaller subset is relevant.

12. If multiple tables could potentially answer the question, prefer tables
    whose structure and relationships provide the strongest semantic match.

13. Use relationships to expand the retrieval plan only when those
    relationships are actually useful for answering the question.

14. Avoid unnecessary joins, unnecessary tables, and unnecessary columns.

ENTITY DETAIL LOOKUPS:

15. When the user asks to show, display, retrieve, or provide the details
    of a specific entity, include the entity's identifying/display fields
    in required_columns when those fields exist in the discovered schema.

16. For an entity-detail question, do not select only technical identifiers
    such as primary keys if the Context Layer contains additional fields
    that identify or describe the entity.

17. Consider available fields such as names, titles, labels, slugs, codes,
    descriptions, and other semantically identifying fields when selecting
    required_columns.

18. Select these fields dynamically from the discovered schema.
    Never assume a particular column name such as "name", "title", or "label".

19. If the schema does not contain an appropriate identifying/display field,
    do not invent one. Return only fields that actually exist.

20. For a specific entity-detail question, include the requested entity's
    identifying information together with its other relevant available
    attributes.

21. Do not retrieve unnecessary columns merely because they exist in the
    table. Prefer fields relevant to identifying or describing the requested
    entity.

OPERATIONS:

22. Operations may include:

    lookup
    filter
    count
    sum
    average
    minimum
    maximum
    comparison
    ranking
    grouping
    aggregation

23. Filters must describe conditions that retrieval will need.

24. When a filter refers to a categorical/text value described in natural language,
    do not assume the exact database casing or spelling of the value.

25. Preserve the user's requested semantic value in the filter description,
    but do not invent an exact database literal when the Context Layer does not
    provide the actual value.

26. For example, if the user asks for records that are "pending", the plan
    may describe the filter as "tickets.status matches pending", but must not
    assume that the stored value is exactly "pending" rather than "Pending".

27. Grouping must describe the fields needed for grouped results.

28. Sorting must identify actual available columns using table.column format
    where appropriate.

CONVERSATION:

29. If the user refers to something from an earlier conversation turn,
    use conversation context.

30. Set needs_conversation_context to true when previous conversation
    information is required to understand the current question.

LIMIT:

31. Determine limit from the user's requested result size when explicitly
    stated.

32. Examples:

    "top 5" -> limit 5
    "latest 10" -> limit 10
    "show me 20" -> limit 20
    "first 3" -> limit 3

33. For ranking, newest, latest, most recent, top, or bottom questions where
    the user does NOT specify a result size, use a small default limit such
    as 10.

34. Do NOT use a row limit for count, sum, average, minimum, maximum, or
    other aggregate operations when the limit would incorrectly reduce the
    aggregation input.

35. For a specific record lookup or a question clearly asking about one
    entity, use a limit appropriate for that single-result lookup.

36. The limit must be an integer greater than 0 or null.

37. Never invent a limit based on database size.

38. Sorting and limit must work together.

39. For "most recent", "latest", "newest", or similar questions, identify
    an appropriate available time-related column and sort descending.

BROAD QUESTIONS:

40. For broad questions such as:

    "Which records were created most recently?"
    "What are the latest records?"
    "Show me recent data"

    do NOT automatically select every table that contains a created_at,
    updated_at, timestamp, or similar column.

41. For a broad question, first identify which tables are most likely to
    represent meaningful business records based on the complete Context
    Layer.

42. Prefer a focused candidate set rather than querying the entire database.

43. If several tables are genuinely equally relevant and the question
    explicitly asks across the whole database, multiple tables may be
    selected. However, unnecessary tables must still be excluded.

44. When selecting multiple tables for a broad ranking question, every
    selected table must have a clear reason for being included in the plan.

45. The reasoning field should briefly explain why the selected tables are
    relevant and why obviously unrelated tables were excluded.

SCHEMA LIMITATION:

46. If the question cannot be answered from the available schema, return
    the best possible plan and clearly explain the limitation.

47. confidence must be between 0 and 1.

AVAILABLE CONTEXT LAYER:

{json.dumps(context_for_llm, indent=2, default=str)}

CONVERSATION CONTEXT:

{json.dumps(conversation_context or {}, indent=2, default=str)}

USER QUESTION:

{question}

"""

        response = self.client.responses.create(
            model="gpt-5.4-nano-2026-03-17",
            input=prompt,
        )

        content = response.output_text.strip()

        try:
            plan = json.loads(content)
        except json.JSONDecodeError as exc:
            raise ValueError(
                f"Question planner returned invalid JSON: {content}"
            ) from exc

        return plan


def plan_question(
    question: str,
    conversation_context: dict[str, Any] | None = None,
) -> dict[str, Any]:

    planner = QuestionPlanner()

    return planner.plan(
        question=question,
        conversation_context=conversation_context,
    )


if __name__ == "__main__":
    example_question = input("Enter question: ").strip()

    result = plan_question(example_question)

    print(json.dumps(result, indent=2, default=str))