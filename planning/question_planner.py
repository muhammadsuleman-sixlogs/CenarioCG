from __future__ import annotations

import json
from typing import Any

from context.context_store import load_all_contexts
from llm.openai_client import OPENAI_MODEL, get_openai_client


class QuestionPlanner:
    CANONICAL_OPERATIONS = {
        "lookup", "filter", "count", "sum", "average", "minimum",
        "maximum", "comparison", "ranking", "grouping", "aggregation", "general",
    }

    OPERATION_ALIASES = {
        "retrieve": "general", "fetch": "general", "get": "lookup",
        "query": "general", "search": "general", "select": "general",
        "aggregate": "aggregation", "avg": "average",
        "min": "minimum", "max": "maximum",
    }

    ALLOWED_DATA_SOURCES = {"postgresql", "security_logs"}

    ALLOWED_SECURITY_RESOURCES = {
        "security_logs",
        "cli_audit_logs",
        "security_logs_summary",
        "workspace_security_logs",
        "workspace_siem_status",
        "security_overview",
    }

    DEFAULT_SECURITY_RESOURCE = "security_logs"

    SECURITY_KEYWORDS = {
        "security event", "security events", "security log", "security logs",
        "siem event", "siem events", "siem log", "siem logs",
        "security activity", "security alert", "security alerts",
        "security incident", "security incidents", "authentication event",
        "authentication events", "login event", "login events", "access event",
        "access events", "audit activity", "audit event", "audit events",
        "audit log", "audit logs", "suspicious activity",
        "security monitoring", "security monitoring events",
    }

    SECURITY_RESOURCE_HINTS = {
        "cli_audit_logs": {
            "cli", "shell", "git", "command line", "command-line",
        },
        "security_logs_summary": {
            "summary", "summarize", "summarised", "aggregated", "aggregation",
        },
        "workspace_siem_status": {"siem status"},
        "security_overview": {"security overview"},
        "workspace_security_logs": {
            "workspace security",
            "security logs for workspace",
            "security events for workspace",
        },
    }

    def __init__(self, context: dict[str, Any] | None = None):
        if context is not None:
            if "tables" in context:
                source_id = context.get("source_id", "db1")
                self.contexts = {source_id: context}
            else:
                self.contexts = context
        else:
            self.contexts = load_all_contexts()

        if not isinstance(self.contexts, dict):
            raise ValueError("Context Layer sources must be a dictionary.")
        if not self.contexts:
            raise ValueError(
                "No PostgreSQL Context Layer sources are available."
            )

        self.client = get_openai_client()

    def _build_context_for_llm(self) -> dict[str, Any]:
        sources: dict[str, Any] = {}

        for source_id, context in self.contexts.items():
            if not isinstance(context, dict):
                continue

            tables: dict[str, Any] = {}

            for table_name, table_info in context.get("tables", {}).items():
                if not isinstance(table_info, dict):
                    continue

                columns = []

                for column in table_info.get("columns", []):
                    if not isinstance(column, dict):
                        continue

                    data_type = column.get("data_type")
                    if data_type is None:
                        data_type = column.get("type")

                    columns.append({
                        "name": column.get("name"),
                        "data_type": data_type,
                    })

                tables[table_name] = {
                    "columns": columns,
                    "primary_keys": table_info.get("primary_keys", []),
                }

            sources[source_id] = {
                "tables": tables,
                "relationships": context.get("relationships", []),
                "business_relationships": context.get(
                    "business_relationships", []
                ),
            }

        return {"sources": sources}

    def _build_resolved_entity_context(
        self,
        conversation_context: dict[str, Any] | None,
    ) -> list[dict[str, Any]]:
        if not isinstance(conversation_context, dict):
            return []

        entities = conversation_context.get("entities")
        if not isinstance(entities, list):
            return []

        resolved_entities = []

        for entity in entities:
            if not isinstance(entity, dict):
                continue

            entity_id = entity.get("id")
            entity_type = entity.get("type")
            source_id = entity.get("source_id")

            if entity_id is None or entity_type is None:
                continue

            item = {
                "source_id": source_id,
                "type": entity_type,
                "id": entity_id,
            }

            if entity.get("table"):
                item["table"] = entity["table"]
            if entity.get("column"):
                item["column"] = entity["column"]
            if entity.get("confidence") is not None:
                item["confidence"] = entity["confidence"]
            if entity.get("match_type"):
                item["match_type"] = entity["match_type"]
            if entity.get("evidence"):
                item["evidence"] = entity["evidence"]

            resolved_entities.append(item)

        return resolved_entities

    def _get_available_postgresql_sources(self) -> list[str]:
        return list(self.contexts.keys())

    def _get_available_tables(self, source_ids: list[str]) -> set[str]:
        tables: set[str] = set()

        for source_id in source_ids:
            source_context = self.contexts.get(source_id, {})
            if not isinstance(source_context, dict):
                continue

            source_tables = source_context.get("tables", {})
            if isinstance(source_tables, dict):
                tables.update(source_tables.keys())

        return tables

    def _is_security_candidate(self, question: str) -> bool:
        normalized = " ".join(question.lower().split())
        return any(
            keyword in normalized
            for keyword in self.SECURITY_KEYWORDS
        )

    def _infer_security_resource(self, question: str) -> str:
        normalized = " ".join(question.lower().split())

        for resource, hints in self.SECURITY_RESOURCE_HINTS.items():
            if any(hint in normalized for hint in hints):
                return resource

        return self.DEFAULT_SECURITY_RESOURCE

    def _build_security_only_plan(self, question: str) -> dict[str, Any]:
        resource = self._infer_security_resource(question)

        return self._normalize_plan({
            "question": question,
            "understanding": (
                "The question requests security/SIEM information."
            ),
            "entities": [],
            "data_sources": ["security_logs"],
            "security_resource": resource,
            "postgresql_sources": [],
            "required_tables": [],
            "required_columns": [],
            "relationships": [],
            "filters": [],
            "operations": ["general"],
            "grouping": [],
            "sorting": [],
            "limit": None,
            "needs_conversation_context": False,
            "reasoning": (
                "The question was routed through the "
                "security-only fast path."
            ),
            "confidence": 1.0,
        })

    def _normalize_operations(
        self,
        operations: Any,
        entities: list[dict[str, Any]],
    ) -> list[str]:
        if isinstance(operations, str):
            operations = [operations]

        if not isinstance(operations, list):
            operations = []

        normalized = []

        for operation in operations:
            if not isinstance(operation, str):
                continue

            name = operation.strip().lower()

            if name in {
                "sort", "sorting", "order",
                "ordering", "limit",
            }:
                continue

            name = self.OPERATION_ALIASES.get(name, name)

            if name not in self.CANONICAL_OPERATIONS:
                continue

            if name not in normalized:
                normalized.append(name)

        if not normalized:
            return ["lookup"] if entities else ["general"]

        return normalized

    def _normalize_plan(self, plan: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(plan, dict):
            raise ValueError(
                "Question planner must return a JSON object."
            )

        entities = plan.get("entities", [])
        if not isinstance(entities, list):
            entities = []

        plan["entities"] = entities
        plan["operations"] = self._normalize_operations(
            plan.get("operations", []),
            entities,
        )

        data_sources = plan.get(
            "data_sources",
            ["postgresql"],
        )

        if not isinstance(data_sources, list):
            raise ValueError(
                "Question planner data_sources must be a list."
            )

        data_sources = list(dict.fromkeys(data_sources))

        invalid_data_sources = [
            source for source in data_sources
            if source not in self.ALLOWED_DATA_SOURCES
        ]

        if invalid_data_sources:
            raise ValueError(
                "Question planner selected unsupported "
                f"data source(s): {invalid_data_sources}"
            )

        if not data_sources:
            raise ValueError(
                "Question planner did not select a data source."
            )

        plan["data_sources"] = data_sources

        if "security_logs" in data_sources:
            security_resource = plan.get(
                "security_resource",
                self.DEFAULT_SECURITY_RESOURCE,
            )

            if security_resource is None:
                security_resource = self.DEFAULT_SECURITY_RESOURCE

            if not isinstance(security_resource, str):
                raise ValueError(
                    "security_resource must be a string."
                )

            security_resource = security_resource.strip()

            if not security_resource:
                security_resource = self.DEFAULT_SECURITY_RESOURCE

            if security_resource not in self.ALLOWED_SECURITY_RESOURCES:
                raise ValueError(
                    "Question planner selected unsupported "
                    "security resource: "
                    f"{security_resource!r}"
                )

            plan["security_resource"] = security_resource
        else:
            plan["security_resource"] = None

        if data_sources == ["security_logs"]:
            plan["postgresql_sources"] = []
            plan["required_tables"] = []
            plan["required_columns"] = []
            plan["relationships"] = []
            plan["sorting"] = []
            return plan

        if "postgresql" in data_sources:
            available_sources = (
                self._get_available_postgresql_sources()
            )

            postgres_sources = plan.get(
                "postgresql_sources",
                [],
            )

            if not isinstance(postgres_sources, list):
                raise ValueError(
                    "postgresql_sources must be a list."
                )

            postgres_sources = list(
                dict.fromkeys(postgres_sources)
            )

            if (
                not postgres_sources
                and len(available_sources) == 1
            ):
                postgres_sources = [available_sources[0]]

            invalid_postgres_sources = [
                source for source in postgres_sources
                if source not in available_sources
            ]

            if invalid_postgres_sources:
                raise ValueError(
                    "Question planner selected unsupported "
                    "PostgreSQL source(s): "
                    f"{invalid_postgres_sources}"
                )

            if not postgres_sources:
                raise ValueError(
                    "PostgreSQL was selected but no "
                    "postgresql_sources were provided."
                )

            plan["postgresql_sources"] = postgres_sources

            required_tables = plan.get(
                "required_tables",
                [],
            )

            if not isinstance(required_tables, list):
                raise ValueError(
                    "required_tables must be a list."
                )

            available_tables = self._get_available_tables(
                postgres_sources
            )

            invalid_tables = [
                table for table in required_tables
                if not isinstance(table, str)
                or table not in available_tables
            ]

            if invalid_tables:
                raise ValueError(
                    "Question planner selected table(s) "
                    "not found in the selected PostgreSQL "
                    f"Context Layer source(s): {invalid_tables}"
                )

            sorting = plan.get("sorting", [])

            if sorting is None:
                sorting = []

            if isinstance(sorting, dict):
                sorting = [sorting]

            if not isinstance(sorting, list):
                sorting = []

            normalized_sorting = []

            for item in sorting:
                if isinstance(item, str):
                    normalized_sorting.append(item)
                    continue

                if not isinstance(item, dict):
                    continue

                field = item.get("field")
                if field is None:
                    field = item.get("column")

                normalized_sorting.append({
                    "field": field,
                    "direction": item.get("direction", "asc"),
                })

            plan["sorting"] = normalized_sorting

        return plan

    def _build_repair_tables(
        self,
        source_tables: dict[str, Any],
        focus_tables: list[Any],
    ) -> dict[str, Any]:
        tables_for_repair: dict[str, Any] = {}

        for table_name, table_info in source_tables.items():
            if focus_tables and table_name not in focus_tables:
                continue

            if not isinstance(table_info, dict):
                continue

            columns = []

            for column in table_info.get("columns", []):
                if not isinstance(column, dict):
                    continue

                data_type = column.get("data_type")
                if data_type is None:
                    data_type = column.get("type")

                columns.append({
                    "name": column.get("name"),
                    "data_type": data_type,
                })

            tables_for_repair[table_name] = {
                "columns": columns,
                "primary_keys": table_info.get(
                    "primary_keys",
                    [],
                ),
            }

        return tables_for_repair

    def repair_plan(
        self,
        question: str,
        invalid_plan: dict[str, Any],
        validation_errors: list[str],
        conversation_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not isinstance(invalid_plan, dict):
            raise ValueError(
                "Invalid plan must be a dictionary."
            )

        if not isinstance(validation_errors, list):
            validation_errors = []

        available_sources = (
            self._get_available_postgresql_sources()
        )

        resolved_entity_context = (
            self._build_resolved_entity_context(
                conversation_context
            )
        )

        if invalid_plan.get("data_sources") == ["security_logs"]:
            return self._normalize_plan(invalid_plan)

        selected_sources = invalid_plan.get(
            "postgresql_sources",
            [],
        )

        if not isinstance(selected_sources, list):
            selected_sources = []

        selected_sources = [
            source for source in selected_sources
            if source in available_sources
        ]

        if not selected_sources:
            selected_sources = available_sources

        focus_tables = invalid_plan.get(
            "required_tables",
            [],
        )

        if not isinstance(focus_tables, list):
            focus_tables = []

        repair_sources: dict[str, Any] = {}

        for source_id in selected_sources:
            source_context = self.contexts.get(
                source_id,
                {},
            )

            if not isinstance(source_context, dict):
                continue

            source_tables = source_context.get(
                "tables",
                {},
            )

            if not isinstance(source_tables, dict):
                continue

            tables_for_repair = self._build_repair_tables(
                source_tables,
                focus_tables,
            )

            if not tables_for_repair:
                tables_for_repair = self._build_repair_tables(
                    source_tables,
                    [],
                )

            repair_sources[source_id] = {
                "tables": tables_for_repair,
                "relationships": source_context.get(
                    "relationships",
                    [],
                ),
                "business_relationships": source_context.get(
                    "business_relationships",
                    [],
                ),
            }

        prompt = f"""
You are repairing an invalid retrieval plan for a production
multi-source PostgreSQL Context Layer.

Return ONLY valid JSON.

The original user question is:

{question}

The previous invalid plan is:

{json.dumps(invalid_plan, indent=2, default=str)}

The validator reported these errors:

{json.dumps(validation_errors, indent=2, default=str)}

RESOLVED ENTITY EVIDENCE:

{json.dumps(resolved_entity_context, indent=2, default=str)}

IMPORTANT ENTITY EVIDENCE RULES:

1. Resolved entity evidence comes from previous conversational
   resolution and is a planning signal only.
2. The supplied Context Layer remains authoritative for actual
   tables, columns, relationships, and PostgreSQL source IDs.
3. Preserve source_id when present.
4. Preserve the resolved entity type and identifier when the
   current question refers to that entity.
5. If the evidence identifies a table and column, validate that
   table and column against the supplied Context Layer for the
   same source.
6. Do not invent a table or column from the entity evidence.
7. Do not replace an exact resolved identifier with a guessed entity.
8. Do not assume that the resolved identifier is a primary key.
9. Do not replace the discovered evidence column with a primary key
   merely because the primary key exists.
10. Never compare an identifier against a column whose discovered
    data type is incompatible with that identifier.
11. If the current question asks for details, use the resolved entity
    as the subject of the lookup and dynamically select meaningful
    display/detail fields from the discovered schema.
12. If the current question is unrelated to the resolved entity,
    do not force the entity into the plan.
13. If the resolved entity cannot be validated against the supplied
    Context Layer, do not fabricate a replacement table or column.

GENERAL RULES:

1. Use ONLY the supplied discovered Context Layer schema.
2. Never invent a table.
3. Never invent a column.
4. Never invent a PostgreSQL source ID.
5. Never invent a relationship.
6. Preserve the user's original intent.
7. required_columns MUST use table.column format.
8. Every required column must exist in the selected source.
9. Every relationship must exist in the selected Context Layer.
10. Do not use a column merely because its name sounds appropriate.
11. Inspect the actual discovered columns before selecting a sort field.
12. Do not use sort, sorting, limit, retrieve, fetch, query,
    or select as values inside the operations list.
13. Valid canonical operations are only:
{json.dumps(sorted(self.CANONICAL_OPERATIONS), indent=2)}
14. Sorting belongs in the "sorting" field.
15. Limit belongs in the "limit" field.
16. If the user asks for latest, recent, newest, or most recent
    records, select an actual discovered time-related column.
17. Never assume that a table contains created_at, updated_at,
    id, name, title, label, or any other conventional column.
18. If a requested table does not contain an appropriate time column,
    use another discovered table only when an actual discovered
    relationship supports that retrieval path.
19. Never substitute a nonexistent column.
20. Keep the smallest relevant set of tables.
21. Keep the smallest relevant set of columns.
22. PostgreSQL remains strictly read-only.
23. If security_logs is the only required source, do not select
    PostgreSQL tables, columns, or relationships.
24. If PostgreSQL is required, postgresql_sources must contain only
    valid dynamically discovered source IDs.
25. Do not select multiple PostgreSQL sources merely because they
    contain similarly named tables.
26. If the same table name exists in multiple sources, determine the
    correct source from the supplied schema, relationships,
    business relationships, and question semantics.
27. Do not assume identical table names in different sources contain
    the same records.

The repaired JSON must use exactly this top-level structure:

{{
  "question": "...",
  "understanding": "...",
  "entities": [],
  "data_sources": [],
  "security_resource": null,
  "postgresql_sources": [],
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

DISCOVERED REPAIR CONTEXT:

{json.dumps(repair_sources, indent=2, default=str)}

AVAILABLE POSTGRESQL SOURCE IDS:

{json.dumps(available_sources, indent=2, default=str)}

CONVERSATION CONTEXT:

{json.dumps(conversation_context or {}, indent=2, default=str)}

Return ONLY the corrected JSON object.
"""

        response = self.client.responses.create(
            model=OPENAI_MODEL,
            input=prompt,
        )

        content = response.output_text.strip()

        if not content:
            raise ValueError(
                "Question planner repair returned an empty response."
            )

        try:
            repaired_plan = json.loads(content)
        except json.JSONDecodeError as exc:
            raise ValueError(
                "Question planner repair returned invalid JSON."
            ) from exc

        return self._normalize_plan(repaired_plan)

    def plan(
        self,
        question: str,
        conversation_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not question or not question.strip():
            raise ValueError("Question cannot be empty.")

        question = question.strip()

        resolved_entity_context = (
            self._build_resolved_entity_context(
                conversation_context
            )
        )

        if (
            self._is_security_candidate(question)
            and not conversation_context
        ):
            return self._build_security_only_plan(question)

        context_for_llm = self._build_context_for_llm()

        available_postgresql_sources = (
            self._get_available_postgresql_sources()
        )

        prompt = f"""
You are a dynamic database question planner.

The user can ask ANY question that may be answerable from the
available company data.

You MUST reason only from the supplied Context Layer.

Do NOT invent:
- tables
- columns
- relationships
- entities
- database fields
- PostgreSQL source IDs

Do NOT assume a fixed business domain.

Your task is to determine the SMALLEST RELEVANT retrieval plan that can
answer the user's question.

Return ONLY valid JSON.

Required JSON structure:

{{
  "question": "...",
  "understanding": "...",
  "entities": [{{"type": "...", "id": "..."}}],
  "data_sources": [],
  "security_resource": null,
  "postgresql_sources": [],
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

RESOLVED ENTITY EVIDENCE:

{json.dumps(resolved_entity_context, indent=2, default=str)}

RESOLVED ENTITY EVIDENCE RULES:

1. Resolved entity evidence is derived from previous conversational
   entity resolution.
2. It is a planning signal, NOT authoritative schema.
3. The supplied Context Layer is authoritative for PostgreSQL source IDs,
   tables, columns, data types, relationships, and business relationships.
4. When resolved entity evidence is present and the current question
   clearly refers to that entity:
   - preserve its source_id when present;
   - preserve its entity type;
   - preserve its identifier;
   - preserve the discovered evidence table/column when supplied;
   - validate the table/column against the supplied Context Layer;
   - use the evidence column for the entity filter when it is valid.
5. Do NOT replace a resolved evidence column with a guessed primary key.
6. Do NOT assume an entity identifier is the primary key.
7. Do NOT invent a table or column from the resolved entity evidence.
8. Do NOT invent an identifier.
9. Never compare an identifier against an incompatible discovered column type.
10. If the current question asks for details about the resolved entity,
    use that entity as the subject of the lookup.
11. For entity-detail questions, dynamically select meaningful
    identifying/display/detail fields from the discovered schema.
12. If the resolved entity evidence cannot be validated against the
    supplied Context Layer, do not fabricate schema information.
13. If the current question is unrelated to the resolved entity,
    do not force that entity into the plan.
14. If no resolved entity evidence exists, plan normally.

POSTGRESQL SOURCE FORMAT:

"postgresql_sources" identifies the specific PostgreSQL Context Layer
source or sources required for the PostgreSQL portion of the answer.

Available PostgreSQL source IDs:

{json.dumps(available_postgresql_sources, indent=2, default=str)}

Rules:

1. Never invent a PostgreSQL source ID.
2. Every value in postgresql_sources MUST exist in the available IDs.
3. If PostgreSQL is not required: "postgresql_sources": []
4. If only one source is required, select only that source.
5. If both are genuinely required, select both.
6. Do NOT select multiple sources merely because they contain similarly
   named tables.
7. Select a source only when its Context Layer contains relevant evidence.
8. If the same table exists in multiple sources, use schema,
   relationships, business relationships, and question semantics.
9. Do not assume identical table names contain the same records.

IMPORTANT FORMAT RULE:

required_columns MUST be a flat list of strings using exactly:
"table_name.column_name"

ENTITY FORMAT RULE:

"entities" MUST be a list of objects:
{{"type": "...", "id": "..."}}

ENTITY RULES:

1. Include an explicitly identified entity or record.
2. Preserve resolved entity type and identifier.
3. Use resolved evidence to construct filters.
4. Preserve the actual evidence table and column.
5. Do NOT replace the evidence column with a primary key.
6. Do NOT assume the identifier is a primary key.
7. Never compare an identifier against an incompatible column type.
8. The identifier must come from the question or conversation context.
9. If no specific entity exists: "entities": []
10. Never return bare entity type strings.
11. Never return an entity without an identifier.
12. Preserve source_id evidence when applicable.

GENERAL RULES:

1. required_tables must exist in the selected Context Layer.
2. required_columns must exist in selected tables.
3. Every required column uses table.column format.
4. relationships must be supported by the Context Layer.
5. Never create fake schema information.
6. Do not assume a fixed business domain.
7. Use discovered columns, primary keys, relationships, and business
   relationships to understand the data model.
8. Select tables by semantic relevance.
9. Prefer the SMALLEST set of tables.
10. Do NOT select a table merely because it has a similar column name.
11. Do NOT select every table with a compatible column.
12. Prefer the strongest semantic match.
13. Use relationships only when useful.
14. Avoid unnecessary joins, tables, and columns.

DATA SOURCE SELECTION:

Available data sources:

1. postgresql
   - Live company/business data through the Context Layer.
2. security_logs
   - Live security/SIEM events through the Security Logs API.

SOURCE CLASSIFICATION:

Strong security_logs indicators include:
security events, security logs, SIEM events, SIEM logs, security activity,
security alerts, security incidents, authentication events, login events,
access events, audit activity, audit events, audit logs, suspicious activity,
security monitoring events, recent security events, latest security events,
most recent security events.

If primarily asking for security/SIEM activity:
"data_sources": ["security_logs"]

Then:
- postgresql_sources MUST be []
- required_tables MUST be []
- required_columns MUST be []
- relationships MUST be []
- sorting MUST be []
- PostgreSQL schema MUST NOT answer the security-log portion.

If both security and PostgreSQL business information are explicitly required,
use both.

SECURITY RESOURCE SELECTION:

Available resources:
1. security_logs
2. cli_audit_logs
3. security_logs_summary
4. workspace_security_logs
5. workspace_siem_status
6. security_overview

Choose the smallest matching resource.

Examples:
general security events -> security_logs
Git/shell/CLI audit -> cli_audit_logs
summary/count/overview -> security_logs_summary
security logs for workspace -> workspace_security_logs
SIEM status -> workspace_siem_status
administrative overview -> security_overview

Never generate API URLs, bearer tokens, authorization headers, or workspace IDs.
Workspace IDs come from trusted runtime application context.

GENERAL SOURCE RULES:

1. Use postgresql for company/business data.
2. Use security_logs for security/SIEM/audit data.
3. Use both only when both are required.
4. Do not select security_logs merely because a business entity appears.
5. Do not select postgresql when security logs alone answer the question.
6. Never invent additional sources.
7. data_sources may only contain postgresql and security_logs.
8. PostgreSQL-only -> ["postgresql"]
9. Security-only -> ["security_logs"]
10. Both -> ["postgresql", "security_logs"]
11. Security retrieval is read-only.
12. Security-only means no PostgreSQL schema selection.
13. PostgreSQL-only means no security retrieval.
14. Source selection happens before PostgreSQL table selection.

RELATIONSHIP AND MULTI-HOP PLANNING:

15. Identify every entity required in the final answer.
16. Distinguish source, target, and intermediate entities.
17. Inspect the complete discovered relationship graph.
18. Follow discovered database and validated business relationships.
19. Relationship questions may require multiple hops.
20. Include intermediate entities when required for traversal.
21. Do not assume semantically related tables are directly connected.
22. Never invent a join path.
23. Every multi-hop path must be discovered.
24. Prefer the shortest valid path.
25. Select the path best matching the question and Context Layer.
26. Do not stop after finding the first matching entity.
27. Preserve all requested entity levels.
28. If unreachable, explain the limitation rather than inventing a relationship.

MULTI-ENTITY OUTPUT:

29. Include identifying/display fields for requested entity types.
30. Include minimum relevant attributes.
31. Do not retrieve unrelated columns.
32. Entity plus aggregate requires both identifying fields and aggregate input.
33. Preserve requested entity levels.
34. Do not collapse multiple entity types.

MULTI-HOP AGGREGATION:

35. Establish relationships before calculating aggregates.
36. Determine aggregation level from wording.
37. "number of tickets for each project" -> project grouping.
38. "number of pending tickets for each company" -> company grouping.
39. Preserve both grouping levels when both are requested.
40. Do not aggregate at the wrong entity level.
41. Apply filters before counting.
42. Do not LIMIT before aggregation when it changes the result.
43. "each", "all", or "every" -> limit = null unless explicitly requested.

ENTITY DETAIL LOOKUPS:

44. Specific entity details require identifying/display fields.
45. Do not select only technical identifiers when meaningful fields exist.
46. Consider names, titles, labels, slugs, codes, descriptions, etc.
47. Select dynamically from discovered schema.
48. Never assume column names.
49. Do not invent missing fields.
50. Include relevant identifying and detail attributes.

OPERATIONS:

51. Operations describe BUSINESS OPERATIONS ONLY.
52. Canonical operations:
lookup, filter, count, sum, average, minimum, maximum,
comparison, ranking, grouping, aggregation, general.
53. Do NOT put sort or limit into operations.
54. Do NOT use retrieve, fetch, query, search, select, sort, sorting,
    order, ordering, or limit as operations.
55. Sorting belongs only in sorting.
56. Result size belongs only in limit.
57. Filters describe retrieval conditions.
58. Preserve semantic categorical/text values without inventing exact literals.
59. Grouping describes fields needed for grouped results.
60. Sorting must identify an actual discovered table.column.
61. Never assume created_at, updated_at, timestamp, id, name, title, label.
62. Latest/recent/newest requires an actual discovered time column.
63. Sorting direction must be asc or desc.
64. Latest/recent/newest -> descending time column.

CONVERSATION:

65. Use conversation context for earlier-turn references.
66. Set needs_conversation_context true when required.
67. Set it true when resolved entity evidence identifies the subject.
68. If identifier is explicitly in the current question, context is not required.

LIMIT:

69. Explicit result size determines limit.
70. "top 5" -> 5
71. "latest 10" -> 10
72. "show me 20" -> 20
73. "first 3" -> 3
74. Ranking/latest/top/bottom without size -> small default such as 10.
75. Do not limit aggregate input incorrectly.
76. Specific record lookup uses an appropriate limit.
77. Limit must be positive integer or null.
78. Never invent limit from database size.
79. Sorting and limit work together.

BROAD QUESTIONS:

80. Do not automatically select every time-like table.
81. Identify meaningful business-record tables.
82. Prefer a focused candidate set.
83. Across-whole-database requests may require multiple tables.
84. Every selected table needs a reason.
85. Reasoning should explain selected and excluded tables.

SCHEMA LIMITATION:

86. If unavailable schema prevents an answer, return the best possible plan
    and clearly explain the limitation.
87. confidence must be between 0 and 1.

FINAL SOURCE CONSISTENCY:

1. Security-only:
   postgresql_sources=[], required_tables=[], required_columns=[],
   relationships=[], sorting=[].
2. PostgreSQL-only requires valid postgresql_sources.
3. Both requires appropriate PostgreSQL source IDs.
4. Never return PostgreSQL tables for security-only.
5. Never return unknown source IDs.
6. Never return an unknown sorting field.
7. Never put sort or limit inside operations.

AVAILABLE CONTEXT LAYER:

{json.dumps(context_for_llm, indent=2, default=str)}

CONVERSATION CONTEXT:

{json.dumps(conversation_context or {}, indent=2, default=str)}

USER QUESTION:

{question}

Return ONLY the JSON object.
"""

        response = self.client.responses.create(
            model=OPENAI_MODEL,
            input=prompt,
        )

        content = response.output_text.strip()

        if not content:
            raise ValueError(
                "Question planner returned an empty response."
            )

        try:
            plan = json.loads(content)
        except json.JSONDecodeError as exc:
            raise ValueError(
                "Question planner returned invalid JSON: "
                f"{content}"
            ) from exc

        return self._normalize_plan(plan)

    def plan_with_repair(
        self,
        question: str,
        conversation_context: dict[str, Any] | None = None,
        validation_errors: list[str] | None = None,
    ) -> dict[str, Any]:
        plan = self.plan(
            question=question,
            conversation_context=conversation_context,
        )

        if not validation_errors:
            return plan

        return self.repair_plan(
            question=question,
            invalid_plan=plan,
            validation_errors=validation_errors,
            conversation_context=conversation_context,
        )


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

    print(
        json.dumps(
            result,
            indent=2,
            default=str,
        )
    )

