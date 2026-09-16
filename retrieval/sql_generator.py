import json
from typing import Any

from context.context_store import load_context
from database.readonly_guard import validate_read_only_query
from llm.openai_client import get_openai_client
from retrieval.sql_validator import validate_sql_syntax


class SQLGenerator:
    """
    Generate read-only SQL dynamically from a validated retrieval contract.

    No company table or column names are hardcoded.
    """

    def __init__(self, context: dict[str, Any] | None = None):
        self.context = (
            context
            if context is not None
            else load_context()
        )
        self.client = get_openai_client()

    def _build_schema_context(self) -> dict[str, Any]:
        """
        Build the schema information available to the SQL generator.
        """

        tables = {}

        for table_name, table_info in self.context.get(
            "tables", {}
        ).items():

            tables[table_name] = {
                "columns": [
                    {
                        "name": column.get("name"),
                        "data_type": column.get("data_type"),
                    }
                    for column in table_info.get(
                        "columns", []
                    )
                ],
                "primary_keys": table_info.get(
                    "primary_keys",
                    [],
                ),
            }

        return {
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

    def generate(
        self,
        contract: dict[str, Any],
    ) -> str:
        if not isinstance(contract, dict):
            raise ValueError(
                "Retrieval contract must be a dictionary."
            )

        schema_context = self._build_schema_context()

        prompt = f"""
You are a PostgreSQL SQL generation system.

Your task is to translate the supplied Retrieval Contract
into exactly ONE efficient, read-only PostgreSQL SQL query.

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
30. If the contract requests ranking or "most recent"/"latest"/"top"
    results and provides a limit, return only that number of results.
31. Do not add arbitrary tables or columns that are not required by the
    retrieval contract unless they are necessary to perform a validated
    relationship, filter, grouping, sorting, or operation.
32. Prefer SQL-side filtering, grouping, aggregation, ordering, and limiting
    instead of retrieving unnecessary rows and processing them in the LLM.
33. When filtering by an entity identifier, choose a column whose discovered
    schema type is compatible with the supplied identifier value.
34. Do not compare a textual identifier with a UUID column.
35. If the supplied entity identifier is textual and the schema contains a
    textual identifier/reference column for that entity, use that column.
36. Never cast an incompatible identifier into another type merely to make
    the comparison execute.
37. Use the entity information and evidence supplied in the Retrieval Contract
    together with the Context Layer schema to determine the correct identifier
    column.
38. When a retrieval filter refers to a natural-language categorical or text
    value, do not assume the exact database casing.
39. For case-insensitive equality against a textual database column, use a
    case-insensitive SQL comparison such as LOWER(column) = LOWER('value').
40. Do not hardcode known database values. Resolve the requested value from
    the supplied filter semantics and discovered schema.
41. Preserve exact equality semantics when the filter requires exact matching;
    only normalize casing when the filter represents a natural-language
    categorical value.
42. When using UNION or UNION ALL, corresponding output columns at the
    same ordinal position in every SELECT branch MUST have compatible
    PostgreSQL data types.
43. Before generating a UNION or UNION ALL query, inspect the discovered
    data types of every corresponding output expression across ALL branches.
44. If a projected output field such as record_id has different native
    types across UNION branches, explicitly normalize that field to text
    in EVERY UNION branch, including branches where the value is NULL.
45. For example, if one branch returns a UUID record_id and another branch
    returns NULL, use:
        CAST(record_id AS text) AS record_id
    and:
        CAST(NULL AS text) AS record_id
    so that every UNION branch returns text for record_id.
46. Apply this type normalization consistently to ALL corresponding UNION
    output columns that have incompatible types, not only record_id.
47. Do not use output-type normalization for filtering, joining, grouping,
    or sorting when the native database type is required. Normalize only
    the projected output expressions needed for UNION compatibility.
48. Never assume that casting only one UNION branch is sufficient.
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
            model="gpt-5.4-nano-2026-03-17",
            input=prompt,
        )

        query = response.output_text.strip()

        if not query:
            raise ValueError(
                "SQL generator returned an empty query."
            )

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
    ) -> str:
        """
        Repair a generated read-only SQL query after PostgreSQL
        reports a datatype or SQL execution problem.

        The repair happens only at query-generation time.
        No database schema or data is modified.
        """

        if not query or not query.strip():
            raise ValueError(
                "SQL query cannot be empty."
            )

        if not database_error or not database_error.strip():
            raise ValueError(
                "Database error cannot be empty."
            )

        schema_context = self._build_schema_context()

        prompt = f"""
You are repairing a PostgreSQL SELECT query generated
from a validated Retrieval Contract.

The database rejected the generated query.

Your task is to return ONE corrected, read-only PostgreSQL
query that satisfies the same Retrieval Contract.

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
23. If the error involves UNION or UNION ALL:
    - Inspect EVERY SELECT branch.
    - Compare EVERY corresponding output column by position.
    - Ensure corresponding output expressions have compatible
      PostgreSQL data types across ALL branches.

24. If corresponding UNION output expressions have incompatible
    PostgreSQL types, normalize the projected output values to one
    compatible type across ALL affected branches.

25. This normalization applies ONLY to SELECT projection/output
    expressions.

26. Do NOT change the database schema or database column types.

27. For PostgreSQL enum types:
    - If an enum value is UNIONed with text/varchar, it may be
      explicitly cast to text.
    - Apply the same output normalization to the corresponding
      UNION branches.

28. For UUID/text conflicts:
    - If the projected output requires textual normalization,
      explicitly cast the UUID to text.
    - Apply the same normalization to corresponding branches.

29. For other incompatible UNION types such as integer, bigint,
    numeric, date, timestamp, text, varchar, UUID, or enum:
    - Determine a compatible output representation.
    - Apply the conversion consistently across ALL corresponding
      UNION branches.

30. If a branch returns NULL for a normalized output field,
    explicitly cast NULL to the selected output type when necessary.

31. Do NOT cast columns merely to make filtering or joining work.

32. Preserve native database types for:
    - WHERE conditions
    - JOIN conditions
    - GROUP BY
    - ORDER BY
    whenever required.

33. Do not change the meaning of the Retrieval Contract.

34. Do not add unnecessary tables or columns.

35. Do not retrieve unnecessary rows.

36. Preserve requested filtering, aggregation, grouping, sorting,
    and limiting.

37. If PostgreSQL identifies one problematic expression, repair it
    AND inspect the corresponding expressions in every other UNION
    branch for the same datatype incompatibility.

38. Before returning the query, mentally verify every corresponding
    UNION output column across every branch.

39. The database must remain completely read-only.
    The repair may ONLY modify the generated SQL query.

40. Return exactly ONE valid read-only PostgreSQL query.

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
            model="gpt-5.4-nano-2026-03-17",
            input=prompt,
        )

        repaired_query = response.output_text.strip()

        if not repaired_query:
            raise ValueError(
                "SQL repair returned an empty query."
            )

        # Remove accidental markdown fences.
        if repaired_query.startswith("```"):
            lines = repaired_query.splitlines()

            if (
                lines
                and lines[0].strip().startswith("```")
            ):
                lines = lines[1:]

            if (
                lines
                and lines[-1].strip() == "```"
            ):
                lines = lines[:-1]

            repaired_query = "\n".join(
                lines
            ).strip()

        # VERY IMPORTANT:
        # Validate repaired SQL before database execution.
        validate_read_only_query(
            repaired_query
        )

        validate_sql_syntax(
            repaired_query
        )

        return repaired_query


def generate_sql(
    contract: dict[str, Any],
) -> str:

    generator = SQLGenerator()

    return generator.generate(contract)


if __name__ == "__main__":

    print(
        "SQL generator initialized successfully."
    )