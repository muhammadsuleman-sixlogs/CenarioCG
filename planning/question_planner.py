from __future__ import annotations

import json

from typing import Any

from context.context_store import (
    load_all_contexts,
)

from llm.openai_client import (
    OPENAI_MODEL,
    get_openai_client,
)


class QuestionPlanner:
    """
    Dynamically analyze any user question using the discovered
    multi-source Context Layer.

    PostgreSQL sources are discovered dynamically from the local
    Context Layer files.

    No database table names, columns, entities, or business
    relationships are hardcoded.
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
        "retrieve": "general",
        "fetch": "general",
        "get": "lookup",
        "query": "general",
        "search": "general",
        "select": "general",
        "aggregate": "aggregation",
        "avg": "average",
        "min": "minimum",
        "max": "maximum",
    }

    ALLOWED_DATA_SOURCES = {
        "postgresql",
        "security_logs",
    }

    ALLOWED_SECURITY_RESOURCES = {
        "security_logs",
        "cli_audit_logs",
        "security_logs_summary",
        "workspace_security_logs",
        "workspace_siem_status",
        "security_overview",
    }

    DEFAULT_SECURITY_RESOURCE = "security_logs"

    # --------------------------------------------------
    # Security fast-path vocabulary
    # --------------------------------------------------

    SECURITY_KEYWORDS = {
        "security event",
        "security events",
        "security log",
        "security logs",
        "siem event",
        "siem events",
        "siem log",
        "siem logs",
        "security activity",
        "security alert",
        "security alerts",
        "security incident",
        "security incidents",
        "authentication event",
        "authentication events",
        "login event",
        "login events",
        "access event",
        "access events",
        "audit activity",
        "audit event",
        "audit events",
        "audit log",
        "audit logs",
        "suspicious activity",
        "security monitoring",
        "security monitoring events",
    }

    SECURITY_RESOURCE_HINTS = {
        "cli_audit_logs": {
            "cli",
            "shell",
            "git",
            "command line",
            "command-line",
        },
        "security_logs_summary": {
            "summary",
            "summarize",
            "summarised",
            "aggregated",
            "aggregation",
        },
        "workspace_siem_status": {
            "siem status",
        },
        "security_overview": {
            "security overview",
        },
        "workspace_security_logs": {
            "workspace security",
            "security logs for workspace",
            "security events for workspace",
        },
    }

    def __init__(
        self,
        context: dict[str, Any] | None = None,
    ):
        """
        Initialize the planner.

        When no context is supplied, load all available PostgreSQL
        Context Layers.

        For backward compatibility, a single Context Layer dictionary
        can still be supplied directly.
        """

        if context is not None:
            # Backward-compatible single-context usage.
            if "tables" in context:
                source_id = context.get(
                    "source_id",
                    "db1",
                )

                self.contexts = {
                    source_id: context,
                }

            # Multi-source Context Layers:
            #
            # {
            #     "db1": {...},
            #     "db2": {...}
            # }
            else:
                self.contexts = context

        else:
            self.contexts = load_all_contexts()

        if not isinstance(
            self.contexts,
            dict,
        ):
            raise ValueError(
                "Context Layer sources must be a dictionary."
            )

        if not self.contexts:
            raise ValueError(
                "No PostgreSQL Context Layer sources are available."
            )

        self.client = get_openai_client()

    # --------------------------------------------------
    # Context preparation
    # --------------------------------------------------

    def _build_context_for_llm(
        self,
    ) -> dict[str, Any]:
        """
        Build a compact source-aware representation of the
        available Context Layer.

        Each PostgreSQL source is kept separate so the LLM can
        distinguish DB1 tables from DB2 tables.
        """

        sources: dict[str, Any] = {}

        for source_id, context in self.contexts.items():

            if not isinstance(
                context,
                dict,
            ):
                continue

            tables: dict[str, Any] = {}

            for (
                table_name,
                table_info,
            ) in context.get(
                "tables",
                {},
            ).items():

                if not isinstance(
                    table_info,
                    dict,
                ):
                    continue

                table_columns = []

                for column in table_info.get(
                    "columns",
                    [],
                ):

                    if not isinstance(
                        column,
                        dict,
                    ):
                        continue

                    # Current Context Builder uses "type".
                    # Older context files may use "data_type".
                    data_type = column.get(
                        "data_type"
                    )

                    if data_type is None:
                        data_type = column.get(
                            "type"
                        )

                    table_columns.append(
                        {
                            "name": column.get(
                                "name"
                            ),
                            "data_type": data_type,
                        }
                    )

                tables[table_name] = {
                    "columns": table_columns,
                    "primary_keys": table_info.get(
                        "primary_keys",
                        [],
                    ),
                }

            relationships = context.get(
                "relationships",
                [],
            )

            business_relationships = context.get(
                "business_relationships",
                [],
            )

            sources[source_id] = {
                "tables": tables,
                "relationships": relationships,
                "business_relationships": (
                    business_relationships
                ),
            }

        return {
            "sources": sources,
        }

    # --------------------------------------------------
    # Known source/table helpers
    # --------------------------------------------------

    def _get_available_postgresql_sources(
        self,
    ) -> list[str]:
        """
        Return the PostgreSQL Context Layer source IDs that
        are actually available.
        """

        return list(
            self.contexts.keys()
        )

    def _get_available_tables(
        self,
        source_ids: list[str],
    ) -> set[str]:
        """
        Return tables available in the selected PostgreSQL
        source IDs.

        Table names are discovered dynamically from the
        selected Context Layer sources.
        """

        tables: set[str] = set()

        for source_id in source_ids:

            source_context = self.contexts.get(
                source_id,
                {},
            )

            if not isinstance(
                source_context,
                dict,
            ):
                continue

            source_tables = source_context.get(
                "tables",
                {},
            )

            if isinstance(
                source_tables,
                dict,
            ):
                tables.update(
                    source_tables.keys()
                )

        return tables

    # --------------------------------------------------
    # Security fast-path
    # --------------------------------------------------

    def _is_security_candidate(
        self,
        question: str,
    ) -> bool:
        """
        Detect whether the question clearly references
        security/SIEM information.

        This is only a routing hint.

        It does not decide whether PostgreSQL is also
        required.
        """

        normalized = " ".join(
            question.lower().split()
        )

        return any(
            keyword in normalized
            for keyword in self.SECURITY_KEYWORDS
        )

    def _infer_security_resource(
        self,
        question: str,
    ) -> str:
        """
        Infer the smallest known security API resource
        from explicit wording in the question.

        No API URL, authentication value, or workspace ID
        is generated here.
        """

        normalized = " ".join(
            question.lower().split()
        )

        for (
            resource,
            hints,
        ) in self.SECURITY_RESOURCE_HINTS.items():

            if any(
                hint in normalized
                for hint in hints
            ):
                return resource

        return self.DEFAULT_SECURITY_RESOURCE

    def _build_security_only_plan(
        self,
        question: str,
    ) -> dict[str, Any]:
        """
        Build a security-only plan without sending the
        PostgreSQL Context Layer to the LLM.

        No PostgreSQL schema, table, column, relationship,
        or SQL is generated here.
        """

        resource = self._infer_security_resource(
            question
        )

        return self._normalize_plan(
            {
                "question": question,
                "understanding": (
                    "The question requests security/SIEM "
                    "information."
                ),
                "entities": [],
                "data_sources": [
                    "security_logs"
                ],
                "security_resource": resource,
                "postgresql_sources": [],
                "required_tables": [],
                "required_columns": [],
                "relationships": [],
                "filters": [],
                "operations": [
                    "general"
                ],
                "grouping": [],
                "sorting": [],
                "limit": None,
                "needs_conversation_context": False,
                "reasoning": (
                    "The question was routed through the "
                    "security-only fast path."
                ),
                "confidence": 1.0,
            }
        )

    # --------------------------------------------------
    # Operation normalization
    # --------------------------------------------------

    def _normalize_operations(
        self,
        operations: Any,
        entities: list[dict[str, Any]],
    ) -> list[str]:
        """
        Normalize planner operation vocabulary into the canonical
        QuestionPlanValidator vocabulary.

        Execution directives such as sort and limit are not operations.
        They are represented by the sorting and limit fields.
        """

        if isinstance(
            operations,
            str,
        ):
            operations = [
                operations
            ]

        if not isinstance(
            operations,
            list,
        ):
            operations = []

        normalized: list[str] = []

        for operation in operations:

            if not isinstance(
                operation,
                str,
            ):
                continue

            name = operation.strip().lower()

            # Execution directives are not business operations.
            if name in {
                "sort",
                "sorting",
                "order",
                "ordering",
                "limit",
            }:
                continue

            # Normalize aliases.
            name = self.OPERATION_ALIASES.get(
                name,
                name,
            )

            if name not in self.CANONICAL_OPERATIONS:
                continue

            # Prevent duplicate operations.
            if name not in normalized:
                normalized.append(name)

        # If the planner returned only invalid/ignored operations,
        # create a safe canonical operation.
        if not normalized:

            if entities:
                return [
                    "lookup"
                ]

            return [
                "general"
            ]

        return normalized

    # --------------------------------------------------
    # Plan normalization
    # --------------------------------------------------

    def _normalize_plan(
        self,
        plan: dict[str, Any],
    ) -> dict[str, Any]:
        """
        Validate and normalize source-related planner output.

        This does not call an LLM and does not access PostgreSQL.
        """

        if not isinstance(
            plan,
            dict,
        ):
            raise ValueError(
                "Question planner must return a JSON object."
            )

        # --------------------------------------------------
        # Entities
        # --------------------------------------------------

        entities = plan.get(
            "entities",
            [],
        )

        if not isinstance(
            entities,
            list,
        ):
            entities = []

        plan["entities"] = entities

        # --------------------------------------------------
        # Operations
        # --------------------------------------------------

        plan["operations"] = (
            self._normalize_operations(
                operations=plan.get(
                    "operations",
                    [],
                ),
                entities=entities,
            )
        )

        # --------------------------------------------------
        # Data sources
        # --------------------------------------------------

        data_sources = plan.get(
            "data_sources",
            [
                "postgresql"
            ],
        )

        if not isinstance(
            data_sources,
            list,
        ):
            raise ValueError(
                "Question planner data_sources must be a list."
            )

        data_sources = list(
            dict.fromkeys(
                data_sources
            )
        )

        invalid_data_sources = [
            source
            for source in data_sources
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

        # --------------------------------------------------
        # Security resource
        # --------------------------------------------------

        if "security_logs" in data_sources:

            security_resource = plan.get(
                "security_resource",
                self.DEFAULT_SECURITY_RESOURCE,
            )

            if security_resource is None:
                security_resource = (
                    self.DEFAULT_SECURITY_RESOURCE
                )

            if not isinstance(
                security_resource,
                str,
            ):
                raise ValueError(
                    "security_resource must be a string."
                )

            security_resource = (
                security_resource.strip()
            )

            if not security_resource:
                security_resource = (
                    self.DEFAULT_SECURITY_RESOURCE
                )

            if (
                security_resource
                not in self.ALLOWED_SECURITY_RESOURCES
            ):
                raise ValueError(
                    "Question planner selected unsupported "
                    "security resource: "
                    f"{security_resource!r}"
                )

            plan["security_resource"] = (
                security_resource
            )

        else:
            plan["security_resource"] = None

        # --------------------------------------------------
        # Security-log-only plan
        # --------------------------------------------------

        if data_sources == [
            "security_logs"
        ]:

            plan["postgresql_sources"] = []
            plan["required_tables"] = []
            plan["required_columns"] = []
            plan["relationships"] = []
            plan["sorting"] = []

            return plan

        # --------------------------------------------------
        # PostgreSQL source validation
        # --------------------------------------------------

        if "postgresql" in data_sources:

            available_sources = (
                self._get_available_postgresql_sources()
            )

            postgres_sources = plan.get(
                "postgresql_sources",
                [],
            )

            if not isinstance(
                postgres_sources,
                list,
            ):
                raise ValueError(
                    "postgresql_sources must be a list."
                )

            postgres_sources = list(
                dict.fromkeys(
                    postgres_sources
                )
            )

            # Backward compatibility:
            # If only one Context Layer is available and
            # the LLM omitted the new field, use that source.
            if (
                not postgres_sources
                and len(available_sources) == 1
            ):
                postgres_sources = [
                    available_sources[0]
                ]

            invalid_postgres_sources = [
                source
                for source in postgres_sources
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

            plan["postgresql_sources"] = (
                postgres_sources
            )

            # --------------------------------------------------
            # Validate required tables
            # --------------------------------------------------

            required_tables = plan.get(
                "required_tables",
                [],
            )

            if not isinstance(
                required_tables,
                list,
            ):
                raise ValueError(
                    "required_tables must be a list."
                )

            available_tables = (
                self._get_available_tables(
                    postgres_sources
                )
            )

            invalid_tables = [
                table
                for table in required_tables
                if not isinstance(
                    table,
                    str,
                )
                or table not in available_tables
            ]

            if invalid_tables:
                raise ValueError(
                    "Question planner selected table(s) "
                    "not found in the selected PostgreSQL "
                    f"Context Layer source(s): {invalid_tables}"
                )

            # --------------------------------------------------
            # Normalize sorting structure
            # --------------------------------------------------

            sorting = plan.get(
                "sorting",
                [],
            )

            if sorting is None:
                sorting = []

            if isinstance(
                sorting,
                dict,
            ):
                sorting = [
                    sorting
                ]

            if not isinstance(
                sorting,
                list,
            ):
                sorting = []

            plan["sorting"] = sorting

        else:
            plan["postgresql_sources"] = []
            plan["sorting"] = []

        return plan

    # --------------------------------------------------
    # Automatic plan repair
    # --------------------------------------------------

    def repair_plan(
        self,
        question: str,
        invalid_plan: dict[str, Any],
        validation_errors: list[str],
        conversation_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """
        Make one schema-constrained repair attempt for an invalid plan.

        The repair uses:
        - the invalid plan
        - validator errors
        - the actual discovered Context Layer
        - the original user question

        No PostgreSQL queries are executed here.
        """

        if not isinstance(
            invalid_plan,
            dict,
        ):
            raise ValueError(
                "Invalid plan must be a dictionary."
            )

        if not isinstance(
            validation_errors,
            list,
        ):
            validation_errors = []

        available_sources = (
            self._get_available_postgresql_sources()
        )

        # --------------------------------------------------
        # Security-only repair
        # --------------------------------------------------

        if (
            invalid_plan.get(
                "data_sources"
            )
            == ["security_logs"]
        ):
            return self._normalize_plan(
                invalid_plan
            )

        # Use selected sources when available.
        selected_sources = invalid_plan.get(
            "postgresql_sources",
            [],
        )

        if not isinstance(
            selected_sources,
            list,
        ):
            selected_sources = []

        selected_sources = [
            source
            for source in selected_sources
            if source in available_sources
        ]

        # If the invalid plan did not identify valid sources,
        # expose all available sources to the repair model.
        if not selected_sources:
            selected_sources = available_sources

        focus_tables = invalid_plan.get(
            "required_tables",
            [],
        )

        if not isinstance(
            focus_tables,
            list,
        ):
            focus_tables = []

        repair_sources: dict[str, Any] = {}

        for source_id in selected_sources:

            source_context = self.contexts.get(
                source_id,
                {},
            )

            if not isinstance(
                source_context,
                dict,
            ):
                continue

            source_tables = source_context.get(
                "tables",
                {},
            )

            if not isinstance(
                source_tables,
                dict,
            ):
                continue

            tables_for_repair: dict[str, Any] = {}

            # First try to focus on tables involved in the invalid plan.
            for (
                table_name,
                table_info,
            ) in source_tables.items():

                if (
                    focus_tables
                    and table_name not in focus_tables
                ):
                    continue

                if not isinstance(
                    table_info,
                    dict,
                ):
                    continue

                columns = []

                for column in table_info.get(
                    "columns",
                    [],
                ):

                    if not isinstance(
                        column,
                        dict,
                    ):
                        continue

                    data_type = column.get(
                        "data_type"
                    )

                    if data_type is None:
                        data_type = column.get(
                            "type"
                        )

                    columns.append(
                        {
                            "name": column.get(
                                "name"
                            ),
                            "data_type": data_type,
                        }
                    )

                tables_for_repair[table_name] = {
                    "columns": columns,
                    "primary_keys": table_info.get(
                        "primary_keys",
                        [],
                    ),
                }

            # If no focused table matched, expose the complete
            # discovered source schema to allow the model to repair
            # an incorrect table selection.
            if not tables_for_repair:

                for (
                    table_name,
                    table_info,
                ) in source_tables.items():

                    if not isinstance(
                        table_info,
                        dict,
                    ):
                        continue

                    columns = []

                    for column in table_info.get(
                        "columns",
                        [],
                    ):

                        if not isinstance(
                            column,
                            dict,
                        ):
                            continue

                        data_type = column.get(
                            "data_type"
                        )

                        if data_type is None:
                            data_type = column.get(
                                "type"
                            )

                        columns.append(
                            {
                                "name": column.get(
                                    "name"
                                ),
                                "data_type": data_type,
                            }
                        )

                    tables_for_repair[table_name] = {
                        "columns": columns,
                        "primary_keys": table_info.get(
                            "primary_keys",
                            [],
                        ),
                    }

            repair_sources[source_id] = {
                "tables": tables_for_repair,
                "relationships": source_context.get(
                    "relationships",
                    [],
                ),
                "business_relationships": (
                    source_context.get(
                        "business_relationships",
                        [],
                    )
                ),
            }

        prompt = f"""
You are repairing an invalid retrieval plan for a production
multi-source PostgreSQL Context Layer.

Return ONLY valid JSON.

The original user question is:

{question}

The previous invalid plan is:

{json.dumps(
    invalid_plan,
    indent=2,
    default=str,
)}

The validator reported these errors:

{json.dumps(
    validation_errors,
    indent=2,
    default=str,
)}

IMPORTANT RULES:

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

12. Do not use sort, sorting, limit, retrieve, fetch, query, or select
    as values inside the operations list.

13. Valid canonical operations are only:

{json.dumps(
    sorted(self.CANONICAL_OPERATIONS),
    indent=2,
)}

14. Sorting belongs in the "sorting" field.

15. Limit belongs in the "limit" field.

16. If the user asks for latest, recent, newest, or most recent records,
    select an actual discovered time-related column.

17. Never assume that a table contains created_at, updated_at, id,
    name, title, label, or any other conventional column.

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

{json.dumps(
    repair_sources,
    indent=2,
    default=str,
)}

AVAILABLE POSTGRESQL SOURCE IDS:

{json.dumps(
    available_sources,
    indent=2,
    default=str,
)}

CONVERSATION CONTEXT:

{json.dumps(
    conversation_context or {},
    indent=2,
    default=str,
)}

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
            repaired_plan = json.loads(
                content
            )

        except json.JSONDecodeError as exc:
            raise ValueError(
                "Question planner repair returned invalid JSON."
            ) from exc

        return self._normalize_plan(
            repaired_plan
        )

    # --------------------------------------------------
    # Main planning function
    # --------------------------------------------------

    def plan(
        self,
        question: str,
        conversation_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:

        if not question or not question.strip():
            raise ValueError(
                "Question cannot be empty."
            )

        question = question.strip()

        # --------------------------------------------------
        # Security fast-path
        # --------------------------------------------------
        #
        # Only use the deterministic fast-path when there is
        # no conversation context.
        #
        # If conversation context exists, allow the normal
        # planner to inspect that context because the security
        # question may depend on a previously resolved entity.
        #
        if (
            self._is_security_candidate(question)
            and not conversation_context
        ):
            return self._build_security_only_plan(
                question
            )

        # --------------------------------------------------
        # Normal multi-source PostgreSQL/security planning
        # --------------------------------------------------

        context_for_llm = (
            self._build_context_for_llm()
        )

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
  "entities": [
    {{
      "type": "...",
      "id": "..."
    }}
  ],
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

POSTGRESQL SOURCE FORMAT:

"postgresql_sources" identifies the specific PostgreSQL Context Layer
source or sources required for the PostgreSQL portion of the answer.

Available PostgreSQL source IDs are dynamically discovered from the
Context Layer:

{json.dumps(
    available_postgresql_sources,
    indent=2,
    default=str,
)}

Rules:

1. Never invent a PostgreSQL source ID.

2. Every value in postgresql_sources MUST exist in the available
   PostgreSQL Context Layer source IDs.

3. If PostgreSQL is not required:
   "postgresql_sources": []

4. If only one PostgreSQL source is required, select only that source.

5. If both PostgreSQL sources are genuinely required:
   select both dynamically discovered source IDs.

6. Do NOT select multiple PostgreSQL sources merely because they contain
   similarly named tables.

7. Select a PostgreSQL source only when its discovered Context Layer
   contains evidence relevant to answering the question.

8. If the same table name exists in multiple PostgreSQL sources, use the
   surrounding schema, relationships, business relationships, and
   question semantics to determine which source is relevant.

9. Do not assume that identical table names in different sources contain
   the same business records.

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
    in the "entities" field.

GENERAL RULES:

1. required_tables must contain only tables that exist in the selected
   Context Layer source or sources.

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

DATA SOURCE SELECTION:

Determine which available data sources are required to answer the user's
question.

Available data sources:

1. postgresql

   - Live company/business data available through the Context Layer.

   - PostgreSQL sources are distinguished by postgresql_sources.

   - Tables, columns, database relationships, and business relationships
     are discovered dynamically.

2. security_logs

   - Live security/SIEM events available through the Security Logs API.

   - This source is read-only retrieval data.

SOURCE CLASSIFICATION RULES:

Before planning PostgreSQL retrieval, first determine whether the user's
question is asking for security/SIEM activity.

Treat the following concepts as strong indicators of security_logs:

- security events
- security logs
- SIEM events
- SIEM logs
- security activity
- security alerts
- security incidents
- authentication events
- login events
- access events
- audit activity
- audit events
- audit logs
- suspicious activity
- security monitoring events
- recent security events
- latest security events
- most recent security events

If the question is primarily asking for security/SIEM events or activity,
use:

"data_sources": ["security_logs"]

and:

- postgresql_sources MUST be []
- required_tables MUST be []
- required_columns MUST be []
- relationships MUST be []
- sorting MUST be []
- PostgreSQL schema MUST NOT be used to answer the security-log portion.

Do not select PostgreSQL merely because security events may contain
references to users, companies, projects, tickets, or other business
entities.

If the question explicitly requires both security-log evidence and
PostgreSQL business information, use both sources.

SECURITY RESOURCE SELECTION:

The security_logs source exposes these read-only GET resources:

1. security_logs
   - General security log events.

2. cli_audit_logs
   - CLI, Git, shell, and audit-log event retrieval.

3. security_logs_summary
   - Aggregated/summary security-log information.

4. workspace_security_logs
   - Security-log events scoped to a specific workspace.

5. workspace_siem_status
   - SIEM status information for a specific workspace.

6. security_overview
   - Administrative security overview information.

If security_logs is selected, choose the smallest resource that
matches the user's request.

Examples:

- general security events -> security_logs
- Git/shell/CLI audit activity -> cli_audit_logs
- summary/count/overview of security logs -> security_logs_summary
- security logs for a workspace -> workspace_security_logs
- SIEM status for a workspace -> workspace_siem_status
- administrative security overview -> security_overview

Never generate:

- API URLs
- bearer tokens
- authorization headers
- workspace identifiers

A workspace identifier must come from trusted runtime application
context, not from the LLM.

Return the selected resource in:

"security_resource": "..."

GENERAL SOURCE RULES:

1. Use "postgresql" when the answer requires company/business data.

2. Use "security_logs" when the answer requires security/SIEM/audit data.

3. Use both only when evidence from both sources is actually required.

4. Do not select security_logs merely because a business entity appears
   in the question.

5. Do not select postgresql when security logs alone answer the question.

6. Never invent additional data sources.

7. data_sources must contain only:
   - "postgresql"
   - "security_logs"

8. If the question requires only PostgreSQL:
   "data_sources": ["postgresql"]

9. If the question requires only security logs:
   "data_sources": ["security_logs"]

10. If both are required:
    "data_sources": ["postgresql", "security_logs"]

11. Security log retrieval is read-only.

12. When data_sources contains only "security_logs", do not create or
    select PostgreSQL tables, columns, or relationships.

13. When data_sources contains only "postgresql", do not retrieve
    security logs.

14. Source selection must happen before PostgreSQL table selection.

RELATIONSHIP AND MULTI-HOP PLANNING:

15. When a question involves multiple entities, identify every entity
    that must appear in the final answer.

16. Distinguish between:
    - source entities
    - target entities
    - intermediate entities

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

24. Prefer the shortest valid relationship path.

25. If multiple valid paths exist, select the path that best matches the
    user's requested entities and the discovered Context Layer semantics.

26. Do not stop retrieval after finding the first matching entity.

27. If the question asks for multiple entity types, preserve all requested
    entity levels in the plan.

28. If a requested entity cannot be reached through discovered
    relationships, explain the limitation in reasoning rather than
    inventing a relationship.

MULTI-ENTITY OUTPUT PLANNING:

29. When the user requests information about multiple entity types,
    required_columns must contain identifying/display fields for each
    requested entity when those fields exist.

30. For each requested entity, include the minimum relevant attributes.

31. Do not retrieve unrelated columns merely because they exist.

32. If the question asks for an entity and an aggregate about that entity,
    retrieve both the entity identifying fields and the aggregate input.

33. Preserve all requested entity levels.

34. Do not collapse multiple entity types into a single entity merely
    because one table contains a foreign key referencing another.

MULTI-HOP AGGREGATION:

35. When aggregation is combined with relationships, perform the joins
    required to establish the requested relationship before calculating
    the aggregate.

36. Determine the correct aggregation level from the wording.

37. For "number of tickets for each project", group at the project level.

38. For "number of pending tickets for each company", group at the
    company level.

39. For "number of pending tickets for each project for each company",
    preserve both company and project grouping levels.

40. Do not aggregate at an intermediate entity level if the user asks for
    a different entity level.

41. Apply filters before counting when the question asks for records
    matching that filter.

42. Do not use LIMIT before an aggregation when doing so would change
    the requested aggregate.

43. For "each", "all", or "every" entity questions, use limit = null
    unless the user explicitly specifies a limit or requests ranking.

ENTITY DETAIL LOOKUPS:

44. When the user asks to show, display, retrieve, or provide details of
    a specific entity, include its identifying/display fields when they exist.

45. Do not select only technical identifiers if additional meaningful
    identifying fields exist.

46. Consider available names, titles, labels, slugs, codes, descriptions,
    and other semantically identifying fields.

47. Select these fields dynamically from the discovered schema.

48. Never assume a particular column name.

49. If the schema does not contain an appropriate identifying/display field,
    do not invent one.

50. For a specific entity-detail question, include relevant identifying
    information and other relevant attributes.

OPERATIONS:

51. Operations describe BUSINESS OPERATIONS ONLY.

52. Canonical operations are:

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
    general

53. Do NOT put execution directives such as sort or limit into operations.

54. Do NOT use retrieve, fetch, query, search, select, sort, sorting,
    order, ordering, or limit as operation values.

55. Sorting MUST be represented only by the "sorting" field.

56. Result size MUST be represented only by the "limit" field.

57. Filters must describe conditions retrieval will need.

58. When a filter refers to a categorical/text value described in natural
    language, do not assume exact database casing or spelling.

59. Preserve the user's semantic value without inventing an exact literal
    when the Context Layer does not provide it.

60. Grouping must describe the fields needed for grouped results.

61. Sorting must identify an ACTUAL discovered column using table.column.

62. Never assume a column named created_at, updated_at, timestamp, id,
    name, title, or label exists.

63. For latest/recent/newest questions, inspect discovered schema and
    select an actual time-related column.

64. Sorting direction must be either "asc" or "desc".

65. For latest/recent/newest questions, use descending order on the
    selected time-related column.

CONVERSATION:

66. If the user refers to something from an earlier conversation turn,
    use conversation context.

67. Set needs_conversation_context to true when previous conversation
    information is required.

LIMIT:

68. Determine limit from the user's requested result size when explicitly
    stated.

69. Examples:
    "top 5" -> limit 5
    "latest 10" -> limit 10
    "show me 20" -> limit 20
    "first 3" -> limit 3

70. For ranking, newest, latest, most recent, top, or bottom questions
    where the user does NOT specify a result size, use a small default
    limit such as 10.

71. Do NOT use a row limit for count, sum, average, minimum, maximum,
    or other aggregate operations when it would incorrectly reduce the
    aggregation input.

72. For a specific record lookup or a question clearly asking about one
    entity, use a limit appropriate for that lookup.

73. The limit must be an integer greater than 0 or null.

74. Never invent a limit based on database size.

75. Sorting and limit must work together.

BROAD QUESTIONS:

76. For broad questions such as:
    "Which records were created most recently?"
    "What are the latest records?"
    "Show me recent data"

    do NOT automatically select every table that contains a time-like
    column.

77. First identify which tables most likely represent meaningful business
    records based on the complete Context Layer.

78. Prefer a focused candidate set rather than querying the entire database.

79. If several tables are genuinely equally relevant and the question
    explicitly asks across the whole database, multiple tables may be selected.

80. Every selected table must have a clear reason for being included.

81. The reasoning field should briefly explain why selected tables are
    relevant and why unrelated tables were excluded.

SCHEMA LIMITATION:

82. If the question cannot be answered from the available schema, return
    the best possible plan and clearly explain the limitation.

83. confidence must be between 0 and 1.

FINAL SOURCE CONSISTENCY CHECK:

Before returning the JSON plan, verify:

1. If data_sources == ["security_logs"]:
   - postgresql_sources MUST be []
   - required_tables MUST be []
   - required_columns MUST be []
   - relationships MUST be []
   - sorting MUST be []

2. If data_sources == ["postgresql"]:
   - postgresql_sources MUST contain one or more valid PostgreSQL
     Context Layer source IDs.

3. If data_sources == ["postgresql", "security_logs"]:
   - postgresql_sources MUST identify the PostgreSQL source or sources
     needed for the PostgreSQL portion.

4. Never return PostgreSQL tables for a security_logs-only question.

5. Never return a PostgreSQL source ID that was not supplied in the
   Context Layer.

6. Never return a sorting field that does not exist in the selected
   PostgreSQL Context Layer.

7. Never put sort or limit inside operations.

AVAILABLE CONTEXT LAYER:

{json.dumps(
    context_for_llm,
    indent=2,
    default=str,
)}

CONVERSATION CONTEXT:

{json.dumps(
    conversation_context or {},
    indent=2,
    default=str,
)}

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
            plan = json.loads(
                content
            )

        except json.JSONDecodeError as exc:
            raise ValueError(
                "Question planner returned invalid JSON: "
                f"{content}"
            ) from exc

        return self._normalize_plan(
            plan
        )

    # --------------------------------------------------
    # Public repair helper
    # --------------------------------------------------

    def plan_with_repair(
        self,
        question: str,
        conversation_context: dict[str, Any] | None = None,
        validation_errors: list[str] | None = None,
    ) -> dict[str, Any]:
        """
        Generate a question plan.

        If an existing validation error list is supplied, make one
        repair attempt after the initial planning result.

        This method does not execute PostgreSQL queries.
        """

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

    example_question = input(
        "Enter question: "
    ).strip()

    result = plan_question(
        example_question
    )

    print(
        json.dumps(
            result,
            indent=2,
            default=str,
        )
    )
