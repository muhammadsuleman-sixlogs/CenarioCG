import json
from typing import Any

from context.context_store import load_context
from database.readonly_guard import validate_read_only_query
from llm.openai_client import (
    OPENAI_MODEL,
    get_openai_client,
)
from retrieval.sql_validator import validate_sql_syntax
from security.sensitive_data_policy import (
    sanitize_schema_context,
)


class SQLGenerator:
    """
    Generate read-only SQL dynamically from a validated retrieval contract.

    No company table or column names are hardcoded.
    """

    def __init__(
        self,
        context: dict[str, Any] | None = None,
        source_id: str = "db1",
    ):
        if not isinstance(source_id, str) or not source_id.strip():
            raise ValueError("source_id must be a non-empty string.")

        self.source_id = source_id.strip().lower()

        self.context = (
            context
            if context is not None
            else load_context(source_id=self.source_id)
        )

        self.client = get_openai_client()

    def _build_schema_context(self) -> dict[str, Any]:
        """
        Build the schema information available to the SQL generator.

        Sensitive/credential fields are removed before this schema
        is supplied to the LLM.

        The original Context Layer is not modified.
        """

        tables = {}

        for table_name, table_info in self.context.get(
            "tables",
            {},
        ).items():
            if not isinstance(table_info, dict):
                continue

            columns = [
                {
                    "name": column.get("name"),
                    "data_type": (
                        column.get("data_type")
                        if column.get("data_type") is not None
                        else column.get("type")
                    ),
                }
                for column in table_info.get(
                    "columns",
                    [],
                )
                if isinstance(column, dict)
            ]

            tables[table_name] = {
                "columns": columns,
                "primary_keys": table_info.get(
                    "primary_keys",
                    [],
                ),
            }

        schema_context = {
            "source_id": self.source_id,
            "tables": tables,
            "relationships": self.context.get(
                "relationships",
                [],
            ),
            "business_relationships": self.context.get(
                "business_relationships",
                [],
            ),
        }

        # Defense in depth:
        # remove sensitive fields before the schema reaches the LLM.
        return sanitize_schema_context(schema_context)

    def generate(
        self,
        contract: dict[str, Any],
        source_id: str | None = None,
    ) -> str:
        if not isinstance(contract, dict):
            raise ValueError("Retrieval contract must be a dictionary.")

        if source_id is not None:
            if not isinstance(source_id, str) or not source_id.strip():
                raise ValueError("source_id must be a non-empty string.")
            active_source_id = source_id.strip().lower()
        else:
            active_source_id = self.source_id

        schema_context = self._build_schema_context()

        prompt = f"""
You are a PostgreSQL SQL generation system.

Your task is to translate the supplied Retrieval Contract
into exactly ONE efficient, read-only PostgreSQL SQL query.

POSTGRESQL SOURCE:

The SQL query will execute against this PostgreSQL source:

{active_source_id}

Use ONLY the tables, columns, relationships, and business relationships
belonging to this PostgreSQL source.

Do not combine schemas from another PostgreSQL source.

Do not invent cross-source joins.

If the retrieval requires another PostgreSQL source, that source must be
retrieved separately by the calling pipeline.

IMPORTANT SAFETY RULES:

1. Generate ONLY SELECT or WITH SQL.
2. Never generate INSERT.
3. Never generate UPDATE.
4. Never generate DELETE.
5. Never generate DROP.
6. Never generate ALTER.
7. Never generate CREATE.
8. Never generate TRUNCATE.
9. Never generate MERGE.
10. Never generate CALL.
11. Never generate DO.
12. Never generate GRANT or REVOKE.
13. Never generate LOCK.
14. Never generate transaction-control statements.
15. Never generate FOR UPDATE, FOR SHARE, or similar locking clauses.
16. Generate exactly ONE SQL statement.
17. Use only tables and columns present in the Context Layer.
18. Do not invent schema information.
19. Do not modify database data or schema.

RETRIEVAL REQUIREMENTS:

20. Treat the Retrieval Contract as the authoritative retrieval instruction.
21. Respect the requested operations.
22. Respect the requested filters.
23. Respect the requested grouping.
24. Respect the requested sorting.
25. Respect the requested limit.
26. If a positive limit is provided, apply it to the final result set.
27. If sorting is provided, apply the requested sorting before applying the limit.
28. Do not retrieve large amounts of unnecessary data when the contract
    requests a limited result.
29. If the contract requests aggregation such as count, sum, average,
    minimum, or maximum, perform that operation in SQL rather than
    retrieving all rows for the LLM.

MULTI-ENTITY SQL GENERATION:

30. Treat the Retrieval Contract as authoritative.
31. When multiple required tables are present, determine the complete
    join path from the supplied Context Layer relationships.
32. Every JOIN must be supported by an explicitly discovered relationship.
33. Do not invent JOIN conditions from column-name similarity.
34. Do not assume primary-key-to-primary-key joins.
35. Use the discovered source_table, source_column, target_table, and
    target_column relationship metadata to construct joins.
36. When the requested answer requires multiple hops, include every
    necessary intermediate table.
37. Do not omit an intermediate table merely because it is not explicitly
    requested in the final output.
38. Select only the columns required by the Retrieval Contract and the
    minimum additional columns needed to establish the joins.
39. When multiple entity types are requested, include identifying/display
    columns for each requested entity when they exist in the schema.
40. Preserve entity identity throughout the query.
41. Avoid accidental many-to-many multiplication. Before aggregation,
    verify that the selected join path represents the requested
    relationship.
42. When aggregation follows multiple joins, determine which entity level
    the aggregate belongs to and group accordingly.
43. Apply requested filters at the correct entity level.
44. If the user asks for pending tickets, filter the ticket status before
    counting tickets.
45. If the user asks for each company and each project, GROUP BY all
    required company/project identifying expressions.
46. Do not use LIMIT unless the Retrieval Contract specifies a valid limit.
47. Never use LIMIT to arbitrarily reduce "each", "all", or "every"
    results.
48. For ranking questions, apply LIMIT only after the required aggregation
    and ordering have been performed.
49. Never change the user's requested entity level merely to simplify SQL.

GROUP BY VALIDATION:

50. When using aggregate functions such as COUNT, SUM, AVG, MIN, or MAX,
    inspect every expression in the SELECT list.
51. Every SELECT expression that is not an aggregate expression must be
    included in the GROUP BY clause, unless PostgreSQL can legally derive
    it from grouped expressions according to PostgreSQL grouping rules.
52. Do not select a non-aggregated column while grouping only by another
    column from the same table.
53. If the query selects identifying fields from multiple entities,
    include the required identifying expressions in GROUP BY.
54. Do not group only by one entity when the SELECT output contains
    identifying fields from another entity.
55. Ensure ORDER BY expressions are also valid for the aggregation query.
56. Before returning an aggregated query, compare the final SELECT list
    against the GROUP BY clause and ensure that every required
    non-aggregated expression is grouped.
57. If the query selects multiple non-aggregated columns, include all
    required columns or expressions in GROUP BY.
58. Do not remove selected columns merely to avoid a GROUP BY error.
    Preserve the Retrieval Contract and include the required grouping.
59. Apply these GROUP BY rules dynamically using the discovered schema
    and Retrieval Contract. Do not hardcode table names or column names.

JOIN PATH VALIDATION:

60. Before returning the query, list the tables used in FROM and JOIN.
61. For every JOIN, verify that the Context Layer contains a relationship
    connecting the two participating tables.
62. For a multi-hop query, verify that all intermediate tables form a
    continuous discovered relationship path.
63. Verify that every JOIN condition uses the actual discovered relationship
    columns.
64. Verify that no unrelated table was introduced.
65. Verify that no required table was omitted.
66. Verify that the final SELECT fields can be traced to the requested
    entities.
67. Verify that aggregation occurs at the requested entity level.
68. Verify that filters apply to the correct table/entity.
69. Verify that LIMIT does not truncate an aggregation or an "each/all"
    result.
70. If any of these checks fail, correct the SQL before returning it.

GENERAL SQL RULES:

71. If the contract requests ranking or "most recent"/"latest"/"top"
    results and provides a limit, return only that number of results.
72. Do not add arbitrary tables or columns that are not required by the
    retrieval contract unless they are necessary to perform a validated
    relationship, filter, grouping, sorting, or operation.
73. Prefer SQL-side filtering, grouping, aggregation, ordering, and limiting
    instead of retrieving unnecessary rows and processing them in the LLM.
74. When filtering by an entity identifier, choose a column whose discovered
    schema type is compatible with the supplied identifier value.
75. Do not compare a textual identifier with a UUID column.
76. If the supplied entity identifier is textual and the schema contains a
    textual identifier/reference column for that entity, use that column.
77. Never cast an incompatible identifier into another type merely to make
    the comparison execute.
78. Use the entity information and evidence supplied in the Retrieval Contract
    together with the Context Layer schema to determine the correct identifier
    column.
79. When a retrieval filter refers to a natural-language categorical or text
    value, do not assume the exact database casing.
80. For case-insensitive equality against a textual database column, use a
    case-insensitive SQL comparison such as LOWER(column) = LOWER('value').
81. Do not hardcode known database values. Resolve the requested value from
    the supplied filter semantics and discovered schema.
82. Preserve exact equality semantics when the filter requires exact matching;
    only normalize casing when the filter represents a natural-language
    categorical value.
83. When using UNION or UNION ALL, corresponding output columns at the
    same ordinal position in every SELECT branch MUST have compatible
    PostgreSQL data types.
84. Before generating a UNION or UNION ALL query, inspect the discovered
    data types of every corresponding output expression across ALL branches.
85. If a projected output field such as record_id has different native
    types across UNION branches, explicitly normalize that field to text
    in EVERY UNION branch, including branches where the value is NULL.
86. For example, if one branch returns a UUID record_id and another branch
    returns NULL, use:
        CAST(record_id AS text) AS record_id
    and:
        CAST(NULL AS text) AS record_id
    so that every UNION branch returns text for record_id.
87. Apply this type normalization consistently to ALL corresponding UNION
    output columns that have incompatible types, not only record_id.
88. Do not use output-type normalization for filtering, joining, grouping,
    or sorting when the native database type is required. Normalize only
    the projected output expressions needed for UNION compatibility.
89. Never assume that casting only one UNION branch is sufficient.
    Every corresponding column across every UNION branch must resolve to
    the same or compatible PostgreSQL type.

The Retrieval Contract has already been validated.

Return ONLY the SQL query.

Do not use markdown.
Do not use ```sql.
Do not provide explanations.

CONTEXT LAYER:{json.dumps(schema_context, indent=2, default=str)}

RETRIEVAL CONTRACT:{json.dumps(contract, indent=2, default=str)}
"""

        response = self.client.responses.create(
            model=OPENAI_MODEL,
            input=prompt,
        )

        query = response.output_text.strip()

        if not query:
            raise ValueError("SQL generator returned an empty query.")

        # Remove accidental markdown fences if the model
        # returns them despite the instruction.
        if query.startswith("```"):
            lines = query.splitlines()

            if lines and lines[0].strip().startswith("```"):
                lines = lines[1:]

            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]

            query = "\n".join(lines).strip()

        # Local safety validation BEFORE returning SQL.
        validate_read_only_query(query)
        validate_sql_syntax(query)

        return query

    def repair(
        self,
        query: str,
        database_error: str,
        contract: dict[str, Any],
        source_id: str | None = None,
    ) -> str:
        """
        Repair a generated read-only SQL query after PostgreSQL
        reports a datatype or SQL execution problem.

        The repair happens only at query-generation time.
        No database schema or data is modified.
        """

        if not query or not query.strip():
            raise ValueError("SQL query cannot be empty.")

        if not database_error or not database_error.strip():
            raise ValueError("Database error cannot be empty.")

        if source_id is not None:
            if not isinstance(source_id, str) or not source_id.strip():
                raise ValueError("source_id must be a non-empty string.")
            active_source_id = source_id.strip().lower()
        else:
            active_source_id = self.source_id

        schema_context = self._build_schema_context()

        prompt = f"""
You are repairing a PostgreSQL SELECT query generated
from a validated Retrieval Contract.

The database rejected the generated query.

Your task is to return ONE corrected, read-only PostgreSQL
query that satisfies the same Retrieval Contract.

POSTGRESQL SOURCE:

The failed query was executed against:

{active_source_id}

Repair the query using ONLY the discovered schema belonging to this
source.

Do not introduce tables or columns from another PostgreSQL source.
Do not create cross-source joins.

IMPORTANT:

1. Generate ONLY SELECT or WITH SQL.
2. Never generate INSERT.
3. Never generate UPDATE.
4. Never generate DELETE.
5. Never generate DROP.
6. Never generate ALTER.
7. Never generate CREATE.
8. Never generate TRUNCATE.
9. Never generate MERGE.
10. Never generate CALL.
11. Never generate DO.
12. Never generate GRANT or REVOKE.
13. Never generate LOCK.
14. Never generate transaction-control statements.
15. Never generate FOR UPDATE, FOR SHARE, or similar locking clauses.
16. Generate exactly ONE SQL statement.
17. Use only tables and columns present in the Context Layer.
18. Do not invent schema information.
19. Do not modify database data or schema.

REPAIR REQUIREMENTS:

20. Preserve the original Retrieval Contract.
21. Fix the PostgreSQL error without changing the requested answer.
22. Inspect the discovered PostgreSQL data types before repairing
    type-related expressions.
23. If the PostgreSQL error involves GROUP BY or aggregation:
    - Inspect every expression in the SELECT list.
    - Identify every non-aggregated SELECT expression.
    - Ensure every required non-aggregated expression appears in GROUP BY.
    - If multiple non-aggregated columns are selected, include all required
      columns or expressions in GROUP BY.
    - Preserve all requested aggregate calculations.
    - Do not remove requested output columns merely to avoid the error.
    - Do not hardcode table or column names.
    - Use the supplied Context Layer schema and Retrieval Contract
      to determine the correct grouping dynamically.
24. Before returning the repaired query, validate the final SELECT list,
    aggregate expressions, and GROUP BY clause together.
25. If the error involves UNION or UNION ALL:
    - Inspect EVERY SELECT branch.
    - Compare EVERY corresponding output column by position.
    - Ensure corresponding output expressions have compatible
      PostgreSQL data types across ALL branches.
26. If corresponding UNION output expressions have incompatible
    PostgreSQL types, normalize the projected output values to one
    compatible type across ALL affected branches.
27. This normalization applies ONLY to SELECT projection/output
    expressions.
28. Do NOT change the database schema or database column types.
29. For PostgreSQL enum types:
    - If an enum value is UNIONed with text/varchar, it may be
      explicitly cast to text.
    - Apply the same output normalization to the corresponding
      UNION branches.
30. For UUID/text conflicts:
    - If the projected output requires textual normalization,
      explicitly cast the UUID to text.
    - Apply the same normalization to corresponding branches.
31. For other incompatible UNION types such as integer, bigint,
    numeric, date, timestamp, text, varchar, UUID, or enum:
    - Determine a compatible output representation.
    - Apply the conversion consistently across ALL corresponding
      UNION branches.
32. If a branch returns NULL for a normalized output field,
    explicitly cast NULL to the selected output type when necessary.
33. Do NOT cast columns merely to make filtering or joining work.
34. Preserve native database types for:
    - WHERE conditions
    - JOIN conditions
    - GROUP BY
    - ORDER BY
    whenever required.
35. Do not change the meaning of the Retrieval Contract.
36. Do not add unnecessary tables or columns.
37. Do not retrieve unnecessary rows.
38. Preserve requested filtering, aggregation, grouping, sorting,
    and limiting.
39. If PostgreSQL identifies one problematic expression, repair it
    AND inspect the corresponding expressions in every other UNION
    branch for the same datatype incompatibility.
40. Before returning the query, mentally verify every corresponding
    UNION output column across every branch.
41. The database must remain completely read-only.
    The repair may ONLY modify the generated SQL query.
42. Return exactly ONE valid read-only PostgreSQL query.

ORIGINAL SQL:{query}

POSTGRESQL ERROR:{database_error}

CONTEXT LAYER:{json.dumps(schema_context, indent=2, default=str)}

RETRIEVAL CONTRACT:{json.dumps(contract, indent=2, default=str)}

Return ONLY the corrected SQL query.

Do not use markdown.
Do not use ```sql.
Do not provide explanations.
"""

        response = self.client.responses.create(
            model=OPENAI_MODEL,
            input=prompt,
        )

        repaired_query = response.output_text.strip()

        if not repaired_query:
            raise ValueError("SQL repair returned an empty query.")

        # Remove accidental markdown fences.
        if repaired_query.startswith("```"):
            lines = repaired_query.splitlines()

            if lines and lines[0].strip().startswith("```"):
                lines = lines[1:]

            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]

            repaired_query = "\n".join(lines).strip()

        # VERY IMPORTANT:
        # Validate repaired SQL before database execution.
        validate_read_only_query(repaired_query)
        validate_sql_syntax(repaired_query)

        return repaired_query


def generate_sql(
    contract: dict[str, Any],
    source_id: str = "db1",
) -> str:
    generator = SQLGenerator(source_id=source_id)

    return generator.generate(
        contract=contract,
        source_id=source_id,
    )


if __name__ == "__main__":
    print("SQL generator initialized successfully.")