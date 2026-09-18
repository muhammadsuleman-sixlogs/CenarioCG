import json

from typing import Any

from context.context_store import load_context
from llm.openai_client import (
    get_openai_client,
    OPENAI_MODEL,
)


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

RELATIONSHIP AND MULTI-HOP PLANNING:

15. When a question involves multiple entities, identify every entity
    that must appear in the final answer.

16. Distinguish between:
    - source entities: entities used to filter or start the retrieval
    - target entities: entities the user wants returned
    - intermediate entities: entities required to connect source and target

17. For relationship questions, inspect the complete discovered Context
    Layer relationship graph before selecting tables.

18. Follow discovered database relationships and validated business
    relationships to determine a valid retrieval path.

19. A relationship question may require multiple hops.

20. If entity A is connected to entity B through entity C, include C when
    C is required to traverse the relationship.

21. Do not assume that semantically related tables are directly connected.

22. Never invent a join path.

23. Every multi-hop path must be supported by discovered relationships.

24. Prefer the shortest valid relationship path that can answer the question.

25. If multiple valid paths exist, select the path that best matches the
    user's requested entities and the discovered Context Layer semantics.

26. Do not stop retrieval after finding the first matching entity.
    Continue traversal until all requested target entities can be obtained.

27. If the question asks for:
    "companies, their projects, and tickets"
    identify Company, Project, and Ticket as separate entities and
    retrieve the relationships required to connect all three.

28. If the question asks for:
    "companies, projects, and assigned users"
    identify all three entities and include every required intermediate
    relationship.

29. If a requested entity cannot be reached through the discovered
    relationships, explain the limitation in the reasoning field rather
    than inventing a relationship.

MULTI-ENTITY OUTPUT PLANNING:

30. When the user requests information about multiple entity types,
    required_columns must contain identifying/display fields for each
    requested entity when those fields exist.

31. For each requested entity, include the minimum relevant attributes
    needed to answer the question.

32. Do not retrieve unrelated columns merely because they exist.

33. If the question asks for an entity and an aggregate about that entity,
    retrieve both the entity identifying fields and the aggregate input
    required to calculate the result.

34. Preserve all requested entity levels in the plan.

35. Do not collapse multiple entity types into a single entity merely
    because one table contains a foreign key referencing another.

MULTI-HOP AGGREGATION:

36. When aggregation is combined with relationships, perform the joins
    required to establish the requested relationship before calculating
    the aggregate.

37. Determine the correct aggregation level from the wording of the
    question.

38. For "number of tickets for each project", group at the project level.

39. For "number of pending tickets for each company", group at the
    company level.

40. For "number of pending tickets for each project for each company",
    preserve both company and project as grouping levels.

41. Do not aggregate at an intermediate entity level if the user asks for
    a different entity level.

42. Apply filters such as status before counting when the question asks
    for the count of records matching that status.

43. Do not use LIMIT before an aggregation when doing so would change the
    requested aggregate.

44. For "each", "all", or "every" entity questions, use limit = null unless
    the user explicitly specifies a limit or requests ranking/top/bottom
    results.

ENTITY DETAIL LOOKUPS:

45. When the user asks to show, display, retrieve, or provide the details
    of a specific entity, include the entity's identifying/display fields
    in required_columns when those fields exist in the discovered schema.

46. For an entity-detail question, do not select only technical identifiers
    such as primary keys if the Context Layer contains additional fields
    that identify or describe the entity.

47. Consider available fields such as names, titles, labels, slugs, codes,
    descriptions, and other semantically identifying fields when selecting
    required_columns.

48. Select these fields dynamically from the discovered schema.
    Never assume a particular column name such as "name", "title", or "label".

49. If the schema does not contain an appropriate identifying/display field,
    do not invent one. Return only fields that actually exist.

50. For a specific entity-detail question, include the requested entity's
    identifying information together with its other relevant available
    attributes.

51. Do not retrieve unnecessary columns merely because they exist in the
    table. Prefer fields relevant to identifying or describing the requested
    entity.

OPERATIONS:

52. Operations may include:

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

53. Filters must describe conditions that retrieval will need.

54. When a filter refers to a categorical/text value described in natural language,
    do not assume the exact database casing or spelling of the value.

55. Preserve the user's requested semantic value in the filter description,
    but do not invent an exact database literal when the Context Layer does not
    provide the actual value.

56. For example, if the user asks for records that are "pending", the plan
    may describe the filter as "tickets.status matches pending", but must not
    assume that the stored value is exactly "pending" rather than "Pending".

57. Grouping must describe the fields needed for grouped results.

58. Sorting must identify actual available columns using table.column format
    where appropriate.

CONVERSATION:

59. If the user refers to something from an earlier conversation turn,
    use conversation context.

60. Set needs_conversation_context to true when previous conversation
    information is required to understand the current question.

LIMIT:

61. Determine limit from the user's requested result size when explicitly
    stated.

62. Examples:

    "top 5" -> limit 5
    "latest 10" -> limit 10
    "show me 20" -> limit 20
    "first 3" -> limit 3

63. For ranking, newest, latest, most recent, top, or bottom questions where
    the user does NOT specify a result size, use a small default limit such
    as 10.

64. Do NOT use a row limit for count, sum, average, minimum, maximum, or
    other aggregate operations when the limit would incorrectly reduce the
    aggregation input.

65. For a specific record lookup or a question clearly asking about one
    entity, use a limit appropriate for that single-result lookup.

66. The limit must be an integer greater than 0 or null.

67. Never invent a limit based on database size.

68. Sorting and limit must work together.

69. For "most recent", "latest", "newest", or similar questions, identify
    an appropriate available time-related column and sort descending.

BROAD QUESTIONS:

70. For broad questions such as:

    "Which records were created most recently?"
    "What are the latest records?"
    "Show me recent data"

    do NOT automatically select every table that contains a created_at,
    updated_at, timestamp, or similar column.

71. For a broad question, first identify which tables are most likely to
    represent meaningful business records based on the complete Context
    Layer.

72. Prefer a focused candidate set rather than querying the entire database.

73. If several tables are genuinely equally relevant and the question
    explicitly asks across the whole database, multiple tables may be
    selected. However, unnecessary tables must still be excluded.

74. When selecting multiple tables for a broad ranking question, every
    selected table must have a clear reason for being included in the plan.

75. The reasoning field should briefly explain why the selected tables are
    relevant and why obviously unrelated tables were excluded.

SCHEMA LIMITATION:

76. If the question cannot be answered from the available schema, return
    the best possible plan and clearly explain the limitation.

77. confidence must be between 0 and 1.

AVAILABLE CONTEXT LAYER:

{json.dumps(context_for_llm, indent=2, default=str)}

CONVERSATION CONTEXT:

{json.dumps(conversation_context or {}, indent=2, default=str)}

USER QUESTION:

{question}

"""

        response = self.client.responses.create(
            model=OPENAI_MODEL,
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