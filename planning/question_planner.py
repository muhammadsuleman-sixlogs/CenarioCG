from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any

from context.context_store import load_all_contexts
from llm.openai_client import (
    OPENAI_MODEL,
    get_openai_client,
)


class QuestionPlanner:
    """
    Single semantic planner for the Context Layer.

    The LLM answers:
        WHAT does the user want?

    Deterministic application code answers:
        HOW should that intent be executed?

    This planner is the only component that performs semantic
    interpretation of the user's question.

    It may produce:
        1. A normal source retrieval contract for simple questions.
        2. A canonical execution_plan for complex/multi-source questions.

    It never:
        - generates SQL
        - executes PostgreSQL
        - executes Security Logs API
        - invents schema
        - invents relationships
        - stores runtime values
        - performs semantic repair after planning
    """

    CANONICAL_OPERATIONS = {
        "lookup",
        "filter",
        "count",
        "sum",
        "average",
        "minimum",
        "maximum",
        "comparison",
        "ranking",
        "grouping",
        "aggregation",
        "general",
    }

    OPERATION_ALIASES = {
        "lookup": "lookup",
        "retrieve": "lookup",
        "show": "lookup",
        "list": "lookup",
        "filter": "filter",
        "where": "filter",
        "count": "count",
        "number": "count",
        "how_many": "count",
        "sum": "sum",
        "total": "sum",
        "average": "average",
        "avg": "average",
        "mean": "average",
        "minimum": "minimum",
        "min": "minimum",
        "lowest": "minimum",
        "maximum": "maximum",
        "max": "maximum",
        "highest": "maximum",
        "comparison": "comparison",
        "compare": "comparison",
        "ranking": "ranking",
        "rank": "ranking",
        "top": "ranking",
        "grouping": "grouping",
        "group": "grouping",
        "aggregation": "aggregation",
        "aggregate": "aggregation",
        "general": "general",
    }

    FILTER_OPERATOR_ALIASES = {
        "equals": "=",
        "eq": "=",
        "==": "=",
        "neq": "!=",
        "not_equals": "!=",
        "gt": ">",
        "gte": ">=",
        "lt": "<",
        "lte": "<=",
    }

    ALLOWED_DATA_SOURCES = {
        "postgresql",
        "security_logs",
    }

    SECURITY_RESOURCES = {
        "security_logs",
        "cli_audit_logs",
        "security_logs_summary",
        "workspace_security_logs",
        "workspace_siem_status",
        "security_overview",
    }

    EXECUTION_STEP_TYPES = {
        "source_query",
        "final_query",
        "set_operation",
    }

    SET_OPERATIONS = {
        "intersect",
        "union",
        "union_all",
        "except",
        "distinct",
    }

    BINDING_OPERATORS = {
        "in",
        "not_in",
        "equals",
    }

    MAX_EXECUTION_STEPS = 16
    MAX_CONTEXT_TABLES_PER_SOURCE = 200
    MAX_CONTEXT_COLUMNS_PER_TABLE = 100
    MAX_CONTEXT_RELATIONSHIPS = 500

    RECENT_QUESTION_TERMS = {
        "recent",
        "latest",
        "newest",
        "most recent",
        "recently",
        "newly created",
        "new records",
        "recent records",
        "latest records",
        "newest records",
        "most recently",
    }

    TEMPORAL_TYPE_HINTS = {
        "date",
        "time",
        "timestamp",
        "datetime",
        "timestamptz",
        "timestamp without time zone",
        "timestamp with time zone",
    }

    TEMPORAL_NAME_HINTS = {
        "created",
        "updated",
        "modified",
        "changed",
        "timestamp",
        "datetime",
        "date",
        "time",
        "occurred",
        "started",
        "ended",
        "published",
        "completed",
        "submitted",
        "received",
    }

    MAX_RECENT_CANDIDATES = 8

    def __init__(
        self,
        contexts: dict[str, Any] | None = None,
    ):
        self.contexts = (
            contexts
            if contexts is not None
            else load_all_contexts()
        )

        if (
            not isinstance(
                self.contexts,
                dict,
            )
            or not self.contexts
        ):
            raise ValueError(
                "No Context Layer sources are available."
            )

        self.client = get_openai_client()

    # ------------------------------------------------------------------
    # Public planner API
    # ------------------------------------------------------------------

    def plan(
        self,
        question: str,
        conversation_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """
        Perform exactly one semantic planning call.

        The returned object is deterministically normalized, but never
        semantically rewritten after the LLM response.
        """

        if (
            not isinstance(
                question,
                str,
            )
            or not question.strip()
        ):
            raise ValueError(
                "Question cannot be empty."
            )

        context = self._build_context_for_llm()

        resolved_entities = self._build_resolved_entity_context(
            conversation_context
        )

        prompt = self._build_prompt(
            question=question.strip(),
            context=context,
            conversation_context=conversation_context,
            resolved_entities=resolved_entities,
        )

        response = self.client.responses.create(
            model=OPENAI_MODEL,
            input=prompt,
        )

        content = (
            response.output_text
            if response.output_text is not None
            else ""
        ).strip()

        if not content:
            raise ValueError(
                "Question planner returned an empty response."
            )

        raw_plan = self._parse_json_response(
            content
        )

        normalized_plan = self._normalize_plan(
            raw_plan,
            question=question.strip(),
        )

        normalized_plan = self._complete_temporal_plan_if_needed(
            normalized_plan,
            question=question.strip(),
        )

        return normalized_plan

    def repair_plan(
        self,
        question: str,
        invalid_plan: dict[str, Any],
        validation_errors: list[Any] | None = None,
        conversation_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """
        Backward-compatible repair method.

        IMPORTANT:
        This method does NOT call an LLM.

        Once the canonical semantic planner has produced a plan, a later
        component must not reinterpret the user's question. The deterministic
        validator should reject an invalid plan rather than asking another
        LLM to invent a different one.
        """

        if (
            not isinstance(
                question,
                str,
            )
            or not question.strip()
        ):
            raise ValueError(
                "Question cannot be empty."
            )

        if not isinstance(
            invalid_plan,
            dict,
        ):
            raise ValueError(
                "invalid_plan must be a dictionary."
            )

        del validation_errors
        del conversation_context

        return self._normalize_plan(
            deepcopy(invalid_plan),
            question=question.strip(),
        )

    # ------------------------------------------------------------------
    # Prompt
    # ------------------------------------------------------------------

    def _build_prompt(
        self,
        question: str,
        context: dict[str, Any],
        conversation_context: dict[str, Any] | None,
        resolved_entities: list[dict[str, Any]],
    ) -> str:
        available_sources = self._get_available_postgresql_sources()

        return f"""
You are the SINGLE semantic planner for a production multi-source
Context Layer.

Your responsibility is to determine WHAT the user is asking for.

You must NOT generate SQL.

You must NOT execute any source.

You must NOT invent schema information.

You must NOT invent identifiers.

You must NOT invent relationships.

You must NOT guess a cross-source relationship.

The application will deterministically execute the plan you return.

IMPORTANT INPUT FLEXIBILITY RULE:
The user's question may be informal, abbreviated, fragmentary, typo-heavy,
missing punctuation, or written as keywords rather than a complete sentence.
Treat that as valid user input. Do NOT reject or reinterpret it merely because
it is not grammatically complete. Use the supplied Context Layer to resolve
what the user is referring to.

Examples of valid input forms include:
- "meeting egv-vpte-sdc transcript"
- "id 96 transcript"
- "show meeting transcript for egv-vpte-sdc"
- "vm logs last day"

For short or ambiguous wording:
1. Use exact discovered table/column/entity matches first.
2. Use discovered relationships only when they explicitly support the request.
3. If one schema-grounded interpretation is clear, return that plan.
4. If multiple interpretations remain genuinely ambiguous, do not invent one.
5. Never choose a source/table only because it is vaguely similar.

Input flexibility means flexible wording, NOT flexible evidence.
Semantic correctness and Context Layer grounding remain mandatory.

USER QUESTION:
{question}

CONVERSATION CONTEXT:
{json.dumps(conversation_context or {}, ensure_ascii=False, indent=2, default=str)}

RESOLVED ENTITY REFERENCES:
{json.dumps(resolved_entities, ensure_ascii=False, indent=2, default=str)}

AVAILABLE POSTGRESQL SOURCE IDS:
{json.dumps(available_sources, ensure_ascii=False, indent=2)}

DISCOVERED CONTEXT LAYER:
{json.dumps(context, ensure_ascii=False, indent=2, default=str)}

DYNAMIC RECENT-RECORD CANDIDATES:
{json.dumps(self._build_recent_record_candidates(), ensure_ascii=False, indent=2, default=str)}

The recent-record candidates above are deterministic hints generated only
from discovered schema metadata. They are NOT database rows and must never
be treated as current business data. For a latest/recent/newest question,
inspect these candidates and the full Context Layer, then select only the
source/table/column combination actually supported by the schema.

============================================================
SOURCE MODEL
============================================================

Logical data_sources may contain only:

- "postgresql"
- "security_logs"

Physical PostgreSQL source IDs belong ONLY in:

"postgresql_sources"

For example:

CORRECT:
{{
  "data_sources": ["postgresql"],
  "postgresql_sources": ["db1"]
}}

INCORRECT:
{{
  "data_sources": ["db1"]
}}

Never place a PostgreSQL source ID directly into data_sources.

When the question requires facts from DB1 and DB2, return:

{{
  "data_sources": ["postgresql"],
  "postgresql_sources": ["db1", "db2"]
}}

and also return an explicit execution_plan.

============================================================
SEMANTIC RULES
============================================================

1. Use only schema, relationships, business relationships, and source IDs
   present in the supplied Context Layer.

2. Never invent a table.

3. Never invent a column.

4. Never invent a relationship.

5. Never infer a relationship merely because column names look similar.

6. Never infer a relationship merely because two tables appear related
   conceptually.

7. A PostgreSQL relationship is valid only when it exists in the discovered
   Context Layer.

8. DB1 and DB2 are separate PostgreSQL sources.

9. Never represent DB1 -> DB2 as a SQL JOIN.

10. When one source produces identifiers needed by another source, represent
    that dependency using execution-plan input_bindings.

11. Runtime values must NEVER be included in the plan.

12. The plan may describe that step s2 needs values produced by s1, but it
    must not contain the actual identifiers.

13. Current business data must be retrieved live.

14. Conversation history is reference context only. It is not authoritative
    current business data.

15. Do not use a previous assistant answer as current business truth.

16. Do not assume that an empty previous conversation result means that a
    current record does not exist.

17. Use only the minimum sources needed to answer the actual question.

18. Do not select another source merely because it contains similarly named
    tables or fields.

============================================================
CANONICAL OPERATIONS
============================================================

Allowed operations:

{json.dumps(sorted(self.CANONICAL_OPERATIONS))}

Normalize synonyms into these canonical operation names.

Examples:

"how many" -> "count"
"average" -> "average"
"top" -> "ranking"
"compare" -> "comparison"
"list/show" -> "lookup"

Do not add unsupported operations.

============================================================
FILTERS
============================================================

Canonical filter operators are:

=
!=
<>
>
>=
<
<=
in
not_in
contains
starts_with
ends_with
is_null
is_not_null

Use "=" for semantic equality.

Do not return "eq" or "equals" in the final normalized plan.

============================================================
RELATIONSHIPS
============================================================

Every relationship object must use:

{{
  "source_table": "...",
  "source_column": "...",
  "target_table": "...",
  "target_column": "...",
  "relationship_type": "...",
  "source_id": "..."
}}

Use the exact discovered relationship metadata whenever present.

Do not remove intermediate tables required for a valid discovered path.

============================================================
REQUESTED METRICS
============================================================

When aggregation is required, use requested_metrics.

Each metric may contain:

{{
  "label": "...",
  "operation": "count|sum|average|minimum|maximum",
  "source_id": "...",
  "table": "...",
  "column": "...",
  "distinct": false
}}

For COUNT(*) where the metric does not need a source column, the column may
be null.

Do not invent a metric column.

============================================================
SIMPLE QUERIES
============================================================

For a simple single-source question, return the normal semantic plan.

Example shape:

{{
  "question": "...",
  "data_sources": ["postgresql"],
  "postgresql_sources": ["db1"],
  "required_tables": [...],
  "required_columns": [...],
  "relationships": [...],
  "filters": [...],
  "operations": ["lookup"],
  "requested_metrics": [],
  "grouping": [],
  "sorting": [],
  "limit": null,
  "entities": [...],
  "needs_conversation_context": false,
  "confidence": 0.0,
  "execution_plan": null,
  "security_resource": null
}}

============================================================
COMPLEX / MULTI-SOURCE QUERIES
============================================================

When the original question genuinely requires multiple retrieval steps,
return an explicit execution_plan.

The execution_plan must contain the smallest number of steps necessary.

Do not create unnecessary intermediate steps.

Each source_query/final_query step MUST contain:

- id
- type
- source_id
- contract
- depends_on
- inputs
- input_bindings
- key_columns
- output_columns
- purpose

The "contract" is the complete semantic retrieval contract for that source
step.

Example structure:

{{
  "id": "s1",
  "type": "source_query",
  "source_id": "db1",
  "contract": {{
    "question": "...",
    "data_sources": ["postgresql"],
    "postgresql_sources": ["db1"],
    "required_tables": [...],
    "required_columns": [...],
    "relationships": [...],
    "filters": [...],
    "operations": [...],
    "requested_metrics": [...],
    "grouping": [...],
    "sorting": [...],
    "limit": null,
    "entities": [...]
  }},
  "depends_on": [],
  "inputs": [],
  "input_bindings": [],
  "key_columns": ["project_id"],
  "output_columns": ["project_id"],
  "purpose": "Produce project keys required by the next source."
}}

A dependent step may contain:

{{
  "id": "s2",
  "type": "final_query",
  "source_id": "db2",
  "contract": {{
    "...": "..."
  }},
  "depends_on": ["s1"],
  "inputs": [],
  "input_bindings": [
    {{
      "from_step": "s1",
      "from_column": "project_id",
      "to_table": "...",
      "to_column": "...",
      "operator": "in"
    }}
  ],
  "key_columns": [],
  "output_columns": [...],
  "purpose": "Retrieve DB2 facts constrained by project keys from DB1."
}}

The binding target table/column must exist in the supplied DB2 Context Layer.

Use:

"operator": "equals"

ONLY when the producing step is guaranteed to return exactly one relevant
value.

Otherwise use:

"operator": "in"

Use:

"operator": "not_in"

for exclusion dependencies.

============================================================
SET OPERATIONS
============================================================

Supported operators:

- intersect
- union
- union_all
- except
- distinct

A set-operation step has:

{{
  "id": "s3",
  "type": "set_operation",
  "source_id": null,
  "contract": {{}},
  "depends_on": ["s1", "s2"],
  "inputs": ["s1", "s2"],
  "input_bindings": [],
  "operator": "intersect",
  "key_columns": ["..."],
  "output_columns": ["..."],
  "purpose": "..."
}}

Use set operations only when the original question requires them.

Never use a set operation merely to make the plan appear complex.

============================================================
FINAL STEP
============================================================

The final_step must identify the step whose output answers the original
question.

Do not choose an intermediate key-producing step as final when another step
is required to answer the question.

============================================================
STEP COUNT
============================================================

Maximum execution steps:

{self.MAX_EXECUTION_STEPS}

Use the smallest valid execution graph.

============================================================
SECURITY LOGS
============================================================

Logical source:

"security_logs"

Allowed resources:

{json.dumps(sorted(self.SECURITY_RESOURCES))}

Choose a security resource only when the question actually requires it.

Do not generate API URLs, authentication values, workspace credentials,
tokens, or runtime configuration.

============================================================
IMPORTANT SINGLE-AUTHORITY RULE
============================================================

You are the ONLY semantic planner.

Do not return alternative plans.

Do not return possible source choices.

Do not return candidate relationships.

Do not return "maybe use DB1 or DB2".

Return the single plan that is supported by the supplied Context Layer.

============================================================
OUTPUT
============================================================

Return ONLY valid JSON.

No markdown.

No explanations.

No code fences.

Use this exact top-level structure:

{{
  "question": "{question}",
  "data_sources": [],
  "postgresql_sources": [],
  "required_tables": [],
  "required_columns": [],
  "relationships": [],
  "filters": [],
  "operations": [],
  "requested_metrics": [],
  "grouping": [],
  "sorting": [],
  "limit": null,
  "entities": [],
  "needs_conversation_context": false,
  "confidence": 0.0,
  "security_resource": null,
  "execution_plan": null
}}

For a complex query, execution_plan must be an object:

{{
  "mode": "single" | "multi_step",
  "steps": [],
  "final_step": "s1",
  "reason": ""
}}

The final execution plan step objects must use:

{{
  "id": "s1",
  "type": "source_query" | "final_query" | "set_operation",
  "source_id": "db1",
  "contract": {{}},
  "depends_on": [],
  "inputs": [],
  "input_bindings": [],
  "operator": null,
  "key_columns": [],
  "output_columns": [],
  "purpose": ""
}}
""".strip()

    # ------------------------------------------------------------------
    # Context
    # ------------------------------------------------------------------

    def _build_context_for_llm(
        self,
    ) -> dict[str, Any]:
        """
        Build a bounded, schema-only Context Layer representation.

        Business row data is not placed into the planner context.
        """

        sources: dict[str, Any] = {}

        for source_id, context in self.contexts.items():
            if not isinstance(
                context,
                dict,
            ):
                continue

            tables = context.get(
                "tables",
                {},
            )

            if not isinstance(
                tables,
                dict,
            ):
                tables = {}

            bounded_tables: dict[str, Any] = {}

            for table_index, (
                table_name,
                table_info,
            ) in enumerate(
                tables.items()
            ):
                if (
                    table_index
                    >= self.MAX_CONTEXT_TABLES_PER_SOURCE
                ):
                    break

                if not isinstance(
                    table_info,
                    dict,
                ):
                    continue

                columns = table_info.get(
                    "columns",
                    [],
                )

                bounded_columns: list[
                    dict[str, Any]
                ] = []

                if isinstance(
                    columns,
                    list,
                ):
                    for column_index, column in enumerate(
                        columns
                    ):
                        if (
                            column_index
                            >= self.MAX_CONTEXT_COLUMNS_PER_TABLE
                        ):
                            break

                        if not isinstance(
                            column,
                            dict,
                        ):
                            continue

                        column_name = column.get(
                            "name"
                        )

                        if not column_name:
                            continue

                        bounded_columns.append(
                            {
                                "name": str(
                                    column_name
                                ),
                                "data_type": (
                                    column.get(
                                        "data_type"
                                    )
                                    if column.get(
                                        "data_type"
                                    )
                                    is not None
                                    else column.get(
                                        "type"
                                    )
                                ),
                            }
                        )

                bounded_tables[
                    str(table_name)
                ] = {
                    "columns": bounded_columns,
                    "primary_keys": list(
                        table_info.get(
                            "primary_keys",
                            [],
                        )
                        or []
                    ),
                }

            relationships = context.get(
                "relationships",
                [],
            )

            if not isinstance(
                relationships,
                list,
            ):
                relationships = []

            bounded_relationships = [
                relationship
                for relationship in relationships[
                    : self.MAX_CONTEXT_RELATIONSHIPS
                ]
                if isinstance(
                    relationship,
                    dict,
                )
            ]

            business_relationships = context.get(
                "business_relationships",
                [],
            )

            if not isinstance(
                business_relationships,
                list,
            ):
                business_relationships = []

            bounded_business_relationships = [
                relationship
                for relationship in business_relationships[
                    : self.MAX_CONTEXT_RELATIONSHIPS
                ]
                if isinstance(
                    relationship,
                    dict,
                )
            ]

            sources[
                str(source_id).strip().lower()
            ] = {
                "source_type": context.get(
                    "source_type",
                    "postgresql",
                ),
                "tables": bounded_tables,
                "relationships": bounded_relationships,
                "business_relationships": (
                    bounded_business_relationships
                ),
            }

        return {
            "sources": sources
        }

    def _build_resolved_entity_context(
        self,
        conversation_context: dict[str, Any] | None,
    ) -> list[dict[str, Any]]:
        if not isinstance(
            conversation_context,
            dict,
        ):
            return []

        entities = conversation_context.get(
            "entities",
            [],
        )

        if not isinstance(
            entities,
            list,
        ):
            return []

        result: list[
            dict[str, Any]
        ] = []

        for entity in entities:
            if not isinstance(
                entity,
                dict,
            ):
                continue

            # Only preserve entity-reference metadata.
            result.append(
                {
                    "type": entity.get(
                        "type"
                    ),
                    "id": entity.get(
                        "id"
                    ),
                    "source_id": entity.get(
                        "source_id"
                    ),
                    "entity_table": entity.get(
                        "entity_table"
                    ),
                    "entity_column": entity.get(
                        "entity_column"
                    ),
                    "confidence": entity.get(
                        "confidence"
                    ),
                    "match_type": entity.get(
                        "match_type"
                    ),
                }
            )

        return result

    def _is_recent_records_question(self, question: str) -> bool:
        text = " ".join(question.lower().split())
        return any(term in text for term in self.RECENT_QUESTION_TERMS)

    def _is_temporal_column(self, column: dict[str, Any]) -> bool:
        if not isinstance(column, dict):
            return False
        name = str(column.get("name") or "").lower()
        data_type = str(
            column.get("data_type")
            if column.get("data_type") is not None
            else column.get("type") or ""
        ).lower()
        if any(hint in data_type for hint in self.TEMPORAL_TYPE_HINTS):
            return True
        tokens = set(name.replace("-", "_").split("_"))
        return bool(tokens & self.TEMPORAL_NAME_HINTS)

    def _recent_column_score(self, column: dict[str, Any]) -> int:
        if not self._is_temporal_column(column):
            return 0
        name = str(column.get("name") or "").lower()
        data_type = str(
            column.get("data_type")
            if column.get("data_type") is not None
            else column.get("type") or ""
        ).lower()
        tokens = set(name.replace("-", "_").split("_"))
        score = 1 + (5 if any(h in data_type for h in self.TEMPORAL_TYPE_HINTS) else 0)
        if "created" in tokens:
            score += 5
        elif tokens & {"updated", "modified"}:
            score += 3
        elif tokens & {"timestamp", "occurred"}:
            score += 3
        elif tokens & self.TEMPORAL_NAME_HINTS:
            score += 2
        return score

    def _build_recent_record_candidates(self) -> list[dict[str, Any]]:
        candidates = []
        for source_id, context in self.contexts.items():
            tables = context.get("tables", {}) if isinstance(context, dict) else {}
            if not isinstance(tables, dict):
                continue
            for table_name, table_info in tables.items():
                if not isinstance(table_info, dict):
                    continue
                columns = table_info.get("columns", [])
                if not isinstance(columns, list):
                    continue
                temporal = [
                    c for c in columns
                    if isinstance(c, dict) and self._is_temporal_column(c)
                ]
                if not temporal:
                    continue
                best = max(temporal, key=self._recent_column_score)
                keys = table_info.get("primary_keys", [])
                keys = keys if isinstance(keys, list) else []
                useful = sum(
                    1 for c in columns
                    if isinstance(c, dict) and c.get("name") not in keys
                )
                score = self._recent_column_score(best) + (3 if keys else 0) + min(useful, 6)
                candidates.append({
                    "source_id": str(source_id),
                    "table": str(table_name),
                    "time_column": best.get("name"),
                    "score": score,
                })
        candidates.sort(key=lambda x: (-x["score"], x["source_id"], x["table"]))
        return candidates[:self.MAX_RECENT_CANDIDATES]

    def _complete_temporal_plan_if_needed(
        self,
        plan: dict[str, Any],
        question: str,
    ) -> dict[str, Any]:
        if (
            not self._is_recent_records_question(question)
            or not isinstance(plan, dict)
            or plan.get("data_sources") != ["postgresql"]
            or plan.get("required_tables")
            or plan.get("sorting")
        ):
            return plan

        candidates = self._build_recent_record_candidates()
        allowed = set(plan.get("postgresql_sources") or [])
        if allowed:
            candidates = [c for c in candidates if c["source_id"] in allowed]
        if not candidates:
            return plan

        selected = []
        seen = set()
        for candidate in candidates:
            if candidate["source_id"] not in seen:
                selected.append(candidate)
                seen.add(candidate["source_id"])

        columns = [
            f'{c["table"]}.{c["time_column"]}'
            for c in selected if c.get("time_column")
        ]
        if not columns:
            return plan

        result = deepcopy(plan)
        result["postgresql_sources"] = [c["source_id"] for c in selected]
        result["required_tables"] = [c["table"] for c in selected]
        result["required_columns"] = columns
        result["sorting"] = [{"field": c, "direction": "desc"} for c in columns]
        result["operations"] = ["ranking"]
        result["limit"] = result.get("limit") or 10
        result["reasoning"] = (
            "Recent-record retrieval was completed from discovered temporal "
            "columns because the initial plan did not identify a retrieval field."
        )
        result["confidence"] = max(float(result.get("confidence", 0) or 0), 0.70)
        return result

    def _infer_postgresql_sources(
        self,
        plan: dict[str, Any],
        question: str,
    ) -> list[str]:
        """Choose source IDs from discovered schema when the model omitted them."""
        available = self._get_available_postgresql_sources()
        if not available:
            return []

        requested = [
            str(value).strip().lower()
            for value in (plan.get("postgresql_sources") or [])
            if isinstance(value, str) and value.strip()
        ]
        requested = [x for x in dict.fromkeys(requested) if x in available]
        if requested:
            return requested

        tables = [
            str(x).strip().lower()
            for x in (plan.get("required_tables") or [])
            if isinstance(x, str) and x.strip()
        ]
        if tables:
            matches = []
            for source_id in available:
                context = self.contexts.get(source_id, {})
                known = context.get("tables", {}) if isinstance(context, dict) else {}
                names = {str(name).strip().lower() for name in known}
                if any(table in names for table in tables):
                    matches.append(source_id)
            if matches:
                return matches

        # Last deterministic fallback: score question tokens against discovered
        # table/column names. This handles short or misspelled questions such as
        # "vm loh" without hardcoding company entities.
        import re
        tokens = {
            token
            for token in re.findall(r"[a-z0-9_]+", question.lower())
            if len(token) >= 2
        }
        scores: dict[str, int] = {}
        for source_id in available:
            context = self.contexts.get(source_id, {})
            source_score = 0
            source_tables = context.get("tables", {}) if isinstance(context, dict) else {}
            if isinstance(source_tables, dict):
                for table_name, table_info in source_tables.items():
                    table_text = str(table_name).lower()
                    if any(token in table_text or table_text in token for token in tokens):
                        source_score += 4
                    columns = table_info.get("columns", []) if isinstance(table_info, dict) else []
                    if isinstance(columns, list):
                        for column in columns:
                            if not isinstance(column, dict):
                                continue
                            name = str(column.get("name") or "").lower()
                            if name and any(token in name or name in token for token in tokens):
                                source_score += 1
            scores[source_id] = source_score

        best = max(scores.values(), default=0)
        if best > 0:
            return [source_id for source_id in available if scores[source_id] == best]

        # Truly broad/ambiguous question: preserve availability and let the
        # retrieval layer independently verify each source.
        return available

    def _get_available_postgresql_sources(
        self,
    ) -> list[str]:
        return [
            str(source_id).strip().lower()
            for source_id in self.contexts
            if isinstance(
                source_id,
                str,
            )
            and source_id.strip()
        ]

    # ------------------------------------------------------------------
    # JSON parsing
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_json_response(
        content: str,
    ) -> dict[str, Any]:
        candidate = content.strip()

        if candidate.startswith(
            "```"
        ):
            lines = candidate.splitlines()

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

            candidate = "\n".join(
                lines
            ).strip()

        try:
            raw = json.loads(
                candidate
            )
        except json.JSONDecodeError as exc:
            raise ValueError(
                "Question planner returned invalid JSON."
            ) from exc

        if not isinstance(
            raw,
            dict,
        ):
            raise ValueError(
                "Question planner response must be a JSON object."
            )

        return raw

    # ------------------------------------------------------------------
    # Deterministic normalization
    # ------------------------------------------------------------------

    def _normalize_plan(
        self,
        plan: dict[str, Any],
        question: str,
    ) -> dict[str, Any]:
        if not isinstance(
            plan,
            dict,
        ):
            raise ValueError(
                "Question plan must be a dictionary."
            )

        normalized = deepcopy(
            plan
        )

        normalized[
            "question"
        ] = question

        normalized[
            "data_sources"
        ] = self._normalize_data_sources(
            normalized
        )

        normalized[
            "postgresql_sources"
        ] = self._normalize_postgresql_sources(
            normalized
        )

        if "postgresql" in normalized["data_sources"]:
            normalized["postgresql_sources"] = self._infer_postgresql_sources(
                normalized,
                question,
            )

        normalized[
            "required_tables"
        ] = self._normalize_string_list(
            normalized.get(
                "required_tables",
                [],
            )
        )

        normalized[
            "required_columns"
        ] = self._normalize_required_columns(
            normalized.get(
                "required_columns",
                [],
            )
        )

        normalized["required_columns"] = self._resolve_required_columns(
            normalized["required_columns"],
            normalized.get("required_tables", []),
            normalized.get("postgresql_sources", []),
        )

        normalized = self._complete_schema_anchor_plan(
            normalized,
            question,
        )

        normalized[
            "relationships"
        ] = self._normalize_relationships(
            normalized.get(
                "relationships",
                [],
            )
        )

        normalized[
            "filters"
        ] = self._normalize_filters(
            normalized.get(
                "filters",
                [],
            )
        )

        normalized[
            "operations"
        ] = self._normalize_operations(
            normalized.get(
                "operations",
                [],
            )
        )

        normalized[
            "requested_metrics"
        ] = self._normalize_requested_metrics(
            normalized.get(
                "requested_metrics",
                [],
            )
        )

        normalized[
            "grouping"
        ] = self._normalize_string_list(
            normalized.get(
                "grouping",
                [],
            )
        )

        normalized[
            "sorting"
        ] = self._normalize_sorting(
            normalized.get(
                "sorting",
                [],
            )
        )

        normalized["sorting"] = self._resolve_sorting_fields(
            normalized["sorting"],
            normalized.get("required_tables", []),
            normalized.get("postgresql_sources", []),
        )

        normalized[
            "entities"
        ] = self._normalize_entities(
            normalized.get(
                "entities",
                [],
            )
        )

        normalized[
            "needs_conversation_context"
        ] = bool(
            normalized.get(
                "needs_conversation_context",
                False,
            )
        )

        confidence = normalized.get(
            "confidence",
            0.0,
        )

        try:
            confidence = float(
                confidence
            )
        except (
            TypeError,
            ValueError,
        ):
            confidence = 0.0

        normalized[
            "confidence"
        ] = max(
            0.0,
            min(
                1.0,
                confidence,
            ),
        )

        if "security_logs" in normalized["data_sources"]:
            normalized["security_resource"] = self._normalize_security_resource(
                normalized.get("security_resource")
            )
        else:
            normalized["security_resource"] = None

        execution_plan = normalized.get(
            "execution_plan"
        )

        if execution_plan is not None:
            normalized[
                "execution_plan"
            ] = self._normalize_execution_plan(
                execution_plan
            )

        return normalized

    def _normalize_data_sources(
        self,
        plan: dict[str, Any],
    ) -> list[str]:
        raw_sources = plan.get(
            "data_sources",
            ["postgresql"],
        )

        if not isinstance(
            raw_sources,
            list,
        ):
            raise ValueError(
                "data_sources must be a list."
            )

        available_postgres = {
            source.lower()
            for source in self._get_available_postgresql_sources()
        }

        normalized: list[str] = []

        for value in raw_sources:
            if not isinstance(
                value,
                str,
            ):
                raise ValueError(
                    "data_sources must contain strings."
                )

            source = value.strip().lower()

            if not source:
                continue

            # Compatibility normalization:
            # if the model accidentally emits db1/db2 here, move that
            # physical source ID into postgresql_sources.
            if source in available_postgres:
                if "postgresql" not in normalized:
                    normalized.append(
                        "postgresql"
                    )
                continue

            if source not in self.ALLOWED_DATA_SOURCES:
                raise ValueError(
                    "Unsupported data source: "
                    f"{source!r}"
                )

            if source not in normalized:
                normalized.append(
                    source
                )

        if not normalized:
            normalized = [
                "postgresql"
            ]

        return normalized

    def _normalize_postgresql_sources(
        self,
        plan: dict[str, Any],
    ) -> list[str]:
        raw_sources = plan.get(
            "postgresql_sources",
            [],
        )

        if raw_sources is None:
            raw_sources = []

        if not isinstance(
            raw_sources,
            list,
        ):
            raise ValueError(
                "postgresql_sources must be a list."
            )

        available = {
            source.lower()
            for source in self._get_available_postgresql_sources()
        }

        normalized: list[str] = []

        for value in raw_sources:
            if not isinstance(
                value,
                str,
            ):
                raise ValueError(
                    "postgresql_sources must contain strings."
                )

            source = value.strip().lower()

            if not source:
                continue

            if (
                available
                and source not in available
            ):
                raise ValueError(
                    "Question planner selected unavailable "
                    f"PostgreSQL source: {source!r}"
                )

            if source not in normalized:
                normalized.append(
                    source
                )

        return normalized

    def _normalize_operations(
        self,
        operations: Any,
    ) -> list[str]:
        if operations is None:
            return []

        if not isinstance(
            operations,
            list,
        ):
            raise ValueError(
                "operations must be a list."
            )

        normalized: list[str] = []

        for operation in operations:
            if not isinstance(
                operation,
                str,
            ):
                raise ValueError(
                    "operations must contain strings."
                )

            value = (
                operation.strip().lower()
            )

            if not value:
                continue

            value = self.OPERATION_ALIASES.get(
                value,
                value,
            )

            if value not in self.CANONICAL_OPERATIONS:
                raise ValueError(
                    "Unsupported operation: "
                    f"{value!r}"
                )

            if value not in normalized:
                normalized.append(
                    value
                )

        return normalized

    def _normalize_filters(
        self,
        filters: Any,
    ) -> list[dict[str, Any]]:
        if filters is None:
            return []
        if isinstance(filters, dict):
            filters = [filters]
        if not isinstance(filters, list):
            return []

        normalized: list[dict[str, Any]] = []
        for item in filters:
            if isinstance(item, str):
                text = item.strip()
                if not text:
                    continue
                import re
                match = re.match(
                    r"^([^\s=<>!]+)\s*(=|!=|<>|>=|<=|>|<|contains|starts_with|ends_with)\s*(.+)$",
                    text,
                    re.IGNORECASE,
                )
                if match:
                    field, operator, value = match.groups()
                    value = value.strip()
                    if (len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}):
                        value = value[1:-1]
                    normalized.append({
                        "field": field.strip(),
                        "operator": self.FILTER_OPERATOR_ALIASES.get(operator.lower(), operator.lower()),
                        "value": value,
                    })
                continue

            if not isinstance(item, dict):
                continue

            current = deepcopy(item)
            field = current.get("field") or current.get("column") or current.get("column_name")
            if isinstance(field, str):
                current["field"] = field.strip()
            operator = current.get("operator") or current.get("op") or "="
            if isinstance(operator, str):
                value = operator.strip().lower()
                current["operator"] = self.FILTER_OPERATOR_ALIASES.get(value, value)
            normalized.append(current)

        return normalized

    def _normalize_required_columns(
        self,
        columns: Any,
    ) -> list[Any]:
        if columns is None:
            return []

        if not isinstance(
            columns,
            list,
        ):
            raise ValueError(
                "required_columns must be a list."
            )

        normalized: list[Any] = []

        for column in columns:
            if isinstance(
                column,
                str,
            ):
                if column.strip():
                    normalized.append(
                        column.strip()
                    )
                continue

            if isinstance(
                column,
                dict,
            ):
                normalized.append(
                    deepcopy(
                        column
                    )
                )
                continue

            raise ValueError(
                "required_columns must contain strings or objects."
            )

        return normalized

    def _complete_schema_anchor_plan(
        self,
        plan: dict[str, Any],
        question: str,
    ) -> dict[str, Any]:
        """Give short/typo-heavy questions a discovered schema anchor."""
        if plan.get("data_sources") != ["postgresql"]:
            return plan
        if plan.get("required_tables"):
            return plan

        import re
        tokens = {
            token
            for token in re.findall(r"[a-z0-9_]+", question.lower())
            if len(token) >= 2
        }
        if not tokens:
            return plan

        candidates = []
        for source_id in plan.get("postgresql_sources", []):
            context = self.contexts.get(source_id, {})
            tables = context.get("tables", {}) if isinstance(context, dict) else {}
            if not isinstance(tables, dict):
                continue
            for table_name, table_info in tables.items():
                table_text = str(table_name).lower()
                score = 4 if any(t in table_text or table_text in t for t in tokens) else 0
                columns = table_info.get("columns", []) if isinstance(table_info, dict) else []
                matched_columns = []
                if isinstance(columns, list):
                    for column in columns:
                        if not isinstance(column, dict) or not column.get("name"):
                            continue
                        name = str(column["name"]).lower()
                        if any(t in name or name in t for t in tokens):
                            score += 1
                            matched_columns.append(str(column["name"]))
                if score > 0:
                    all_columns = [
                        str(c.get("name"))
                        for c in columns
                        if isinstance(c, dict) and c.get("name")
                    ]
                    selected_columns = matched_columns or all_columns[:8]
                    candidates.append((score, source_id, str(table_name), selected_columns))

        if not candidates:
            return plan

        candidates.sort(key=lambda item: (-item[0], item[1], item[2]))
        best_score = candidates[0][0]
        best = [item for item in candidates if item[0] == best_score]
        selected = best[:2]

        result = deepcopy(plan)
        result["postgresql_sources"] = list(dict.fromkeys(item[1] for item in selected))
        result["required_tables"] = [item[2] for item in selected]
        result["required_columns"] = [
            f"{item[2]}.{column}"
            for item in selected
            for column in item[3]
        ]
        if not result.get("operations"):
            result["operations"] = ["lookup"]
        result["confidence"] = max(float(result.get("confidence", 0) or 0), 0.55)
        result["reasoning"] = (
            "A schema anchor was selected from dynamically discovered table/column "
            "names because the initial plan did not identify a concrete target."
        )
        return result

    def _resolve_required_columns(
        self,
        columns: list[Any],
        required_tables: list[str],
        source_ids: list[str],
    ) -> list[str]:
        known: dict[str, set[str]] = {}
        for source_id in source_ids:
            context = self.contexts.get(source_id, {})
            tables = context.get("tables", {}) if isinstance(context, dict) else {}
            if not isinstance(tables, dict):
                continue
            for table_name, info in tables.items():
                cols = info.get("columns", []) if isinstance(info, dict) else []
                known.setdefault(str(table_name), set()).update(
                    str(c.get("name")) for c in cols if isinstance(c, dict) and c.get("name")
                )

        result: list[str] = []
        for item in columns:
            if isinstance(item, dict):
                value = item.get("field") or item.get("column") or item.get("name")
            else:
                value = item
            if not isinstance(value, str) or not value.strip():
                continue
            value = value.strip()
            if value.count(".") == 1:
                result.append(value)
                continue
            matches = [f"{table}.{value}" for table in required_tables if value in known.get(table, set())]
            if len(matches) == 1:
                result.append(matches[0])
            elif matches:
                result.append(matches[0])
        return list(dict.fromkeys(result))

    def _normalize_relationships(
        self,
        relationships: Any,
    ) -> list[dict[str, Any]]:
        if relationships is None:
            return []

        if not isinstance(
            relationships,
            list,
        ):
            raise ValueError(
                "relationships must be a list."
            )

        result: list[
            dict[str, Any]
        ] = []

        for relationship in relationships:
            if not isinstance(
                relationship,
                dict,
            ):
                raise ValueError(
                    "Each relationship must be an object."
                )

            result.append(
                deepcopy(
                    relationship
                )
            )

        return result

    def _normalize_requested_metrics(
        self,
        metrics: Any,
    ) -> list[dict[str, Any]]:
        if metrics is None:
            return []

        if not isinstance(
            metrics,
            list,
        ):
            raise ValueError(
                "requested_metrics must be a list."
            )

        normalized: list[
            dict[str, Any]
        ] = []

        for metric in metrics:
            if not isinstance(
                metric,
                dict,
            ):
                raise ValueError(
                    "Each requested metric must be an object."
                )

            current = deepcopy(
                metric
            )

            operation = current.get(
                "operation"
            )

            if isinstance(
                operation,
                str,
            ):
                value = (
                    operation.strip().lower()
                )

                current[
                    "operation"
                ] = self.OPERATION_ALIASES.get(
                    value,
                    value,
                )

            source_id = current.get(
                "source_id"
            )

            if isinstance(
                source_id,
                str,
            ):
                current[
                    "source_id"
                ] = source_id.strip().lower()

            distinct = current.get(
                "distinct",
                False,
            )

            current[
                "distinct"
            ] = bool(
                distinct
            )

            normalized.append(
                current
            )

        return normalized

    def _normalize_sorting(
        self,
        sorting: Any,
    ) -> list[dict[str, Any]]:
        """Normalize flexible sorting shapes into the validator contract."""
        if sorting is None:
            return []

        if isinstance(sorting, (str, dict)):
            sorting = [sorting]

        if not isinstance(sorting, list):
            return []

        result: list[dict[str, Any]] = []
        for item in sorting:
            if isinstance(item, str):
                field = item.strip()
                if field:
                    result.append({"field": field, "direction": "desc"})
                continue

            if not isinstance(item, dict):
                continue

            current = deepcopy(item)
            field = (
                current.get("field")
                or current.get("column")
                or current.get("column_name")
                or current.get("sort_field")
            )

            if not isinstance(field, str) or not field.strip():
                continue

            field = field.strip()
            direction = str(
                current.get("direction")
                or current.get("order")
                or "desc"
            ).strip().lower()
            if direction in {"descending", "down"}:
                direction = "desc"
            elif direction in {"ascending", "up"}:
                direction = "asc"
            if direction not in {"asc", "desc"}:
                direction = "desc"

            result.append({"field": field, "direction": direction})

        return result

    def _resolve_sorting_fields(
        self,
        sorting: list[dict[str, Any]],
        required_tables: list[str],
        source_ids: list[str],
    ) -> list[dict[str, Any]]:
        if not sorting:
            return []

        known: dict[str, set[str]] = {}
        for source_id in source_ids:
            context = self.contexts.get(source_id, {})
            tables = context.get("tables", {}) if isinstance(context, dict) else {}
            if not isinstance(tables, dict):
                continue
            for table_name, info in tables.items():
                cols = info.get("columns", []) if isinstance(info, dict) else []
                names = {
                    str(c.get("name")).strip()
                    for c in cols
                    if isinstance(c, dict) and c.get("name")
                }
                known.setdefault(str(table_name), set()).update(names)

        resolved = []
        for item in sorting:
            field = item.get("field") if isinstance(item, dict) else None
            if not isinstance(field, str):
                continue
            field = field.strip()
            if field.count(".") == 1:
                resolved.append(item)
                continue

            matches = [
                f"{table}.{field}"
                for table in required_tables
                if field in known.get(table, set())
            ]
            if len(matches) == 1:
                current = deepcopy(item)
                current["field"] = matches[0]
                resolved.append(current)
            elif len(matches) > 1:
                current = deepcopy(item)
                current["field"] = matches[0]
                resolved.append(current)

        return resolved

    def _normalize_entities(
        self,
        entities: Any,
    ) -> list[Any]:
        if entities is None:
            return []

        if not isinstance(
            entities,
            list,
        ):
            raise ValueError(
                "entities must be a list."
            )

        normalized: list[dict[str, Any]] = []

        for item in entities:
            if not isinstance(item, dict):
                continue

            current = deepcopy(item)

            # Some model responses use ``identifier`` even though the
            # canonical planner contract uses ``id``.  This is a structural
            # normalization only; it does not invent or change the value.
            if (
                (
                    "id" not in current
                    or not isinstance(current.get("id"), str)
                    or not current.get("id", "").strip()
                )
                and isinstance(current.get("identifier"), str)
                and current.get("identifier", "").strip()
            ):
                current["id"] = current["identifier"].strip()

            normalized.append(current)

        return normalized

    def _normalize_security_resource(
        self,
        resource: Any,
    ) -> str | None:
        """Normalize security resource without rejecting an omitted value."""
        if resource is None or not isinstance(resource, str) or not resource.strip():
            return "security_logs"

        resource = resource.strip().lower()
        if resource in self.SECURITY_RESOURCES:
            return resource

        # Unknown LLM labels should not make an otherwise valid security
        # query fail. Fall back to the generic live security resource.
        return "security_logs"

    # ------------------------------------------------------------------
    # Execution-plan normalization
    # ------------------------------------------------------------------

    def _normalize_execution_plan(
        self,
        execution_plan: Any,
    ) -> dict[str, Any]:
        if not isinstance(
            execution_plan,
            dict,
        ):
            raise ValueError(
                "execution_plan must be an object."
            )

        raw_steps = execution_plan.get(
            "steps"
        )

        if (
            not isinstance(
                raw_steps,
                list,
            )
            or not raw_steps
        ):
            raise ValueError(
                "execution_plan must contain steps."
            )

        if len(
            raw_steps
        ) > self.MAX_EXECUTION_STEPS:
            raise ValueError(
                "execution_plan exceeds the maximum step count."
            )

        mode = execution_plan.get(
            "mode",
            "multi_step",
        )

        if mode not in {
            "single",
            "multi_step",
        }:
            raise ValueError(
                "execution_plan mode must be single or multi_step."
            )

        normalized_steps: list[
            dict[str, Any]
        ] = []

        for raw_step in raw_steps:
            normalized_steps.append(
                self._normalize_execution_step(
                    raw_step
                )
            )

        # Cross-source input bindings are semantic dependencies, so the
        # LLM is not trusted to choose the target key.  Normalize each
        # binding against the authoritative validated cross-source
        # relationship artifact before the plan is handed to execution.
        normalized_steps = self._normalize_cross_source_bindings(
            normalized_steps
        )

        final_step = execution_plan.get(
            "final_step"
        )

        if (
            not isinstance(
                final_step,
                str,
            )
            or not final_step.strip()
        ):
            raise ValueError(
                "execution_plan final_step must be a non-empty string."
            )

        if (
            mode == "single"
            and len(normalized_steps) != 1
        ):
            mode = "multi_step"

        return {
            "mode": mode,
            "steps": normalized_steps,
            "final_step": final_step.strip(),
            "reason": str(
                execution_plan.get(
                    "reason"
                )
                or ""
            ),
        }

    def _load_cross_source_relationships(self) -> list[dict[str, Any]]:
        """
        Load the authoritative validated cross-source relationship artifact.

        The planner never infers these relationships itself.  If the shared
        Context Graph helper is available, use it; otherwise read the local
        generated artifact as a compatibility fallback.
        """
        try:
            from context.context_graph import load_cross_source_relationships

            relationships = load_cross_source_relationships()
            if isinstance(relationships, dict):
                relationships = relationships.get(
                    "validated_relationships",
                    [],
                )

            if isinstance(relationships, list):
                return [
                    item
                    for item in relationships
                    if isinstance(item, dict)
                    and item.get("valid") is True
                ]
        except (ImportError, AttributeError, TypeError, ValueError):
            pass

        artifact_path = (
            Path(__file__).resolve().parent.parent
            / "context"
            / "cross_source_relationships.json"
        )

        try:
            if not artifact_path.exists():
                return []

            with artifact_path.open(
                "r",
                encoding="utf-8",
            ) as handle:
                payload = json.load(handle)

            if isinstance(payload, dict):
                relationships = payload.get(
                    "validated_relationships",
                    [],
                )
            else:
                relationships = payload

            if not isinstance(relationships, list):
                return []

            return [
                item
                for item in relationships
                if isinstance(item, dict)
                and item.get("valid") is True
            ]
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            return []

    def _normalize_cross_source_bindings(
        self,
        steps: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """
        Normalize cross-source execution bindings against validated mappings.

        The LLM may identify the correct source step and target table but pick
        the wrong target key.  That is unsafe because it can produce a valid
        SQL query with zero or misleading results.

        Only an authoritative ``valid: true`` cross-source relationship can
        change a binding.  No relationship is inferred from column names.
        """
        relationships = self._load_cross_source_relationships()

        if not relationships:
            # Do not silently invent a mapping when the authoritative artifact
            # is unavailable.  Existing bindings remain untouched so the
            # normal deterministic validator can decide whether the plan is
            # otherwise executable.
            return steps

        step_by_id = {
            step.get("id"): step
            for step in steps
            if isinstance(step, dict)
            and isinstance(step.get("id"), str)
        }

        normalized_steps = deepcopy(steps)

        for step in normalized_steps:
            target_source = step.get("source_id")
            if not isinstance(target_source, str):
                continue

            bindings = step.get("input_bindings", [])
            if not isinstance(bindings, list) or not bindings:
                continue

            for binding in bindings:
                if not isinstance(binding, dict):
                    continue

                from_step_id = binding.get("from_step")
                from_column = binding.get("from_column")
                to_table = binding.get("to_table")

                producer = step_by_id.get(from_step_id)
                if not isinstance(producer, dict):
                    continue

                source_source = producer.get("source_id")
                if not isinstance(source_source, str):
                    continue

                if not isinstance(from_column, str) or not from_column.strip():
                    continue
                if not isinstance(to_table, str) or not to_table.strip():
                    continue

                source_tables: set[str] = set()
                producer_contract = producer.get("contract", {})
                if isinstance(producer_contract, dict):
                    required_tables = producer_contract.get(
                        "required_tables",
                        [],
                    )
                    if isinstance(required_tables, list):
                        source_tables = {
                            value.strip()
                            for value in required_tables
                            if isinstance(value, str) and value.strip()
                        }

                candidates = []

                for relationship in relationships:
                    if (
                        str(relationship.get("source_system", "")).strip().lower()
                        != source_source.strip().lower()
                    ):
                        continue

                    if (
                        str(relationship.get("target_system", "")).strip().lower()
                        != target_source.strip().lower()
                    ):
                        continue

                    if relationship.get("source_column") != from_column.strip():
                        continue

                    source_table = relationship.get("source_table")
                    if source_tables and source_table not in source_tables:
                        continue

                    target_table = relationship.get("target_table")
                    if not isinstance(target_table, str) or not target_table.strip():
                        continue

                    # The dependent step may contain an intermediate path.
                    # The authoritative mapping must point to a table that
                    # actually belongs to that step's discovered contract.
                    target_contract = step.get("contract", {})
                    target_tables = set()
                    if isinstance(target_contract, dict):
                        required_tables = target_contract.get(
                            "required_tables",
                            [],
                        )
                        if isinstance(required_tables, list):
                            target_tables = {
                                value.strip()
                                for value in required_tables
                                if isinstance(value, str) and value.strip()
                            }

                    if target_tables and target_table not in target_tables:
                        continue

                    candidates.append(relationship)

                if not candidates:
                    continue

                # Prefer an exact target-table match when the LLM happened
                # to choose the correct table but the wrong key column.
                exact_target_table = [
                    item
                    for item in candidates
                    if item.get("target_table") == to_table.strip()
                ]
                if exact_target_table:
                    candidates = exact_target_table

                # Prefer the strongest validated relationship.  If the top
                # confidence is tied across different mappings, do not guess.
                candidates.sort(
                    key=lambda item: float(item.get("confidence", 0.0) or 0.0),
                    reverse=True,
                )

                top_confidence = float(
                    candidates[0].get("confidence", 0.0) or 0.0
                )
                top = [
                    item
                    for item in candidates
                    if float(item.get("confidence", 0.0) or 0.0)
                    == top_confidence
                ]

                target_pairs = {
                    (
                        item.get("target_table"),
                        item.get("target_column"),
                    )
                    for item in top
                    if isinstance(item.get("target_table"), str)
                    and isinstance(item.get("target_column"), str)
                }

                if len(target_pairs) != 1:
                    raise ValueError(
                        "Ambiguous validated cross-source mapping for "
                        f"{source_source}.{from_column} -> "
                        f"{target_source}.{to_table}."
                    )

                authoritative = top[0]
                binding["to_table"] = authoritative["target_table"]
                binding["to_column"] = authoritative["target_column"]

        return normalized_steps

    def _normalize_execution_step(
        self,
        raw_step: Any,
    ) -> dict[str, Any]:
        if not isinstance(
            raw_step,
            dict,
        ):
            raise ValueError(
                "Each execution-plan step must be an object."
            )

        step_id = raw_step.get(
            "id"
        )

        if (
            not isinstance(
                step_id,
                str,
            )
            or not step_id.strip()
        ):
            raise ValueError(
                "Each execution-plan step requires a non-empty id."
            )

        step_type = raw_step.get(
            "type"
        )

        aliases = {
            "source": "source_query",
            "query": "source_query",
            "final": "final_query",
            "set": "set_operation",
        }

        if isinstance(
            step_type,
            str,
        ):
            step_type = aliases.get(
                step_type.strip().lower(),
                step_type.strip().lower(),
            )

        if step_type not in self.EXECUTION_STEP_TYPES:
            raise ValueError(
                "Unsupported execution step type: "
                f"{step_type!r}"
            )

        source_id = raw_step.get(
            "source_id"
        )

        if step_type in {
            "source_query",
            "final_query",
        }:
            if (
                not isinstance(
                    source_id,
                    str,
                )
                or not source_id.strip()
            ):
                raise ValueError(
                    f"Execution step {step_id!r} requires source_id."
                )

            source_id = (
                source_id.strip().lower()
            )

        else:
            source_id = None

        contract = raw_step.get(
            "contract",
            {},
        )

        if not isinstance(
            contract,
            dict,
        ):
            raise ValueError(
                f"Execution step {step_id!r} contract must be an object."
            )

        if step_type in {
            "source_query",
            "final_query",
        }:
            contract = self._normalize_step_contract(
                contract,
                source_id=source_id,
            )
        else:
            contract = {}

        depends_on = self._normalize_string_list(
            raw_step.get(
                "depends_on",
                [],
            )
        )

        inputs = self._normalize_string_list(
            raw_step.get(
                "inputs",
                [],
            )
        )

        input_bindings = self._normalize_input_bindings(
            raw_step.get(
                "input_bindings",
                []),
            step_id=step_id.strip(),
        )

        operator = raw_step.get(
            "operator"
        )

        if operator is not None:
            if not isinstance(
                operator,
                str,
            ):
                raise ValueError(
                    f"Execution step {step_id!r} operator must be a string."
                )

            operator = operator.strip().lower()

        if step_type == "set_operation":
            if operator not in self.SET_OPERATIONS:
                raise ValueError(
                    f"Unsupported set operation in step "
                    f"{step_id!r}: {operator!r}"
                )

        key_columns = self._normalize_string_list(
            raw_step.get(
                "key_columns",
                [],
            )
        )

        output_columns = self._normalize_string_list(
            raw_step.get(
                "output_columns",
                [],
            )
        )

        purpose = str(
            raw_step.get(
                "purpose"
            )
            or ""
        )

        return {
            "id": step_id.strip(),
            "type": step_type,
            "source_id": source_id,
            "contract": contract,
            "depends_on": depends_on,
            "inputs": inputs,
            "input_bindings": input_bindings,
            "operator": operator,
            "key_columns": key_columns,
            "output_columns": output_columns,
            "purpose": purpose,
        }

    def _normalize_step_contract(
        self,
        contract: dict[str, Any],
        source_id: str,
    ) -> dict[str, Any]:
        current = deepcopy(
            contract
        )

        current[
            "data_sources"
        ] = [
            "postgresql"
        ]

        current[
            "postgresql_sources"
        ] = [
            source_id
        ]

        current[
            "source_id"
        ] = source_id

        current[
            "required_tables"
        ] = self._normalize_string_list(
            current.get(
                "required_tables",
                [],
            )
        )

        current[
            "required_columns"
        ] = self._normalize_required_columns(
            current.get(
                "required_columns",
                [],
            )
        )

        current[
            "relationships"
        ] = self._normalize_relationships(
            current.get(
                "relationships",
                [],
            )
        )

        current[
            "filters"
        ] = self._normalize_filters(
            current.get(
                "filters",
                [],
            )
        )

        current[
            "operations"
        ] = self._normalize_operations(
            current.get(
                "operations",
                [],
            )
        )

        current[
            "requested_metrics"
        ] = self._normalize_requested_metrics(
            current.get(
                "requested_metrics",
                [],
            )
        )

        current[
            "grouping"
        ] = self._normalize_string_list(
            current.get(
                "grouping",
                [],
            )
        )

        current[
            "sorting"
        ] = self._normalize_sorting(
            current.get(
                "sorting",
                [],
            )
        )

        current[
            "entities"
        ] = self._normalize_entities(
            current.get(
                "entities",
                [],
            )
        )

        return current

    def _normalize_input_bindings(
        self,
        bindings: Any,
        step_id: str,
    ) -> list[dict[str, Any]]:
        if bindings is None:
            return []

        if not isinstance(
            bindings,
            list,
        ):
            raise ValueError(
                f"Execution step {step_id!r} input_bindings "
                "must be a list."
            )

        normalized: list[
            dict[str, Any]
        ] = []

        for binding in bindings:
            if not isinstance(
                binding,
                dict,
            ):
                raise ValueError(
                    f"Execution step {step_id!r} contains "
                    "an invalid input binding."
                )

            values: dict[
                str,
                Any,
            ] = {}

            for name in (
                "from_step",
                "from_column",
                "to_table",
                "to_column",
            ):
                value = binding.get(
                    name
                )

                if (
                    not isinstance(
                        value,
                        str,
                    )
                    or not value.strip()
                ):
                    raise ValueError(
                        f"Execution step {step_id!r} binding "
                        f"{name} must be a non-empty string."
                    )

                values[
                    name
                ] = value.strip()

            operator = binding.get(
                "operator",
                "in",
            )

            if not isinstance(
                operator,
                str,
            ):
                raise ValueError(
                    f"Execution step {step_id!r} binding operator "
                    "must be a string."
                )

            operator = operator.strip().lower()

            if operator in {
                "=",
                "==",
                "eq",
                "equals",
            }:
                operator = "equals"

            if operator not in self.BINDING_OPERATORS:
                raise ValueError(
                    f"Unsupported input binding operator: "
                    f"{operator!r}"
                )

            values[
                "operator"
            ] = operator

            normalized.append(
                values
            )

        return normalized

    # ------------------------------------------------------------------
    # Generic normalization helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _normalize_string_list(
        value: Any,
    ) -> list[str]:
        if value is None:
            return []

        if not isinstance(
            value,
            list,
        ):
            raise ValueError(
                "Expected a list of strings."
            )

        result: list[str] = []

        for item in value:
            if (
                not isinstance(
                    item,
                    str,
                )
                or not item.strip()
            ):
                raise ValueError(
                    "List values must be non-empty strings."
                )

            normalized = item.strip()

            if normalized not in result:
                result.append(
                    normalized
                )

        return result