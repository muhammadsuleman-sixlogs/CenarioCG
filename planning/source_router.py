from __future__ import annotations

from typing import Any



class SourceRouter:
    """Resolve the smallest PostgreSQL source set required by a validated plan.

    This router is deliberately schema-driven. It does not contain company
    table names, column names, entity names, or business rules.
    """

    def __init__(self, contexts: dict[str, Any] | None = None):
        if contexts is None:
            from context.context_store import load_all_contexts
            contexts = load_all_contexts()

        self.contexts = contexts
        if not isinstance(self.contexts, dict):
            raise ValueError("Context Layer sources must be a dictionary.")

    def route(
        self,
        plan: dict[str, Any],
        conversation_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not isinstance(plan, dict):
            raise ValueError("Retrieval plan must be a dictionary.")

        requested_sources = self._normalise_sources(
            plan.get("postgresql_sources", [])
        )

        if "security_logs" in self._normalise_sources(
            plan.get("data_sources", [])
        ):
            # Security routing is handled independently. This router only
            # chooses among discovered PostgreSQL Context Layer sources.
            return {
                "status": "ok",
                "postgresql_sources": self._route_postgresql_sources(
                    plan,
                    requested_sources,
                    conversation_context,
                ),
                "reason": "Security source kept outside PostgreSQL routing.",
            }

        return {
            "status": "ok",
            "postgresql_sources": self._route_postgresql_sources(
                plan,
                requested_sources,
                conversation_context,
            ),
            "reason": "Selected the smallest dynamically supported PostgreSQL source set.",
        }

    def _route_postgresql_sources(
        self,
        plan: dict[str, Any],
        requested_sources: list[str],
        conversation_context: dict[str, Any] | None,
    ) -> list[str]:
        available = [
            source_id
            for source_id, context in self.contexts.items()
            if isinstance(context, dict)
        ]
        available = list(dict.fromkeys(available))
        available_set = set(available)

        requested_sources = [
            source_id
            for source_id in requested_sources
            if source_id in available_set
        ]

        # Once the planner starts emitting a per-step execution plan, those
        # step-level source IDs become authoritative.
        query_plan = plan.get("query_plan")
        if isinstance(query_plan, dict):
            step_sources = []
            for step in query_plan.get("steps", []):
                if not isinstance(step, dict):
                    continue
                source_id = step.get("source_id")
                if (
                    isinstance(source_id, str)
                    and source_id.strip()
                    and source_id.strip().lower() in available_set
                ):
                    source_id = source_id.strip().lower()
                    if source_id not in step_sources:
                        step_sources.append(source_id)
            if step_sources:
                return step_sources

        explicit_sources = self._get_explicit_sources(
            plan,
            conversation_context,
        ) & available_set

        # One explicit source is a hard source boundary.
        if len(requested_sources) == 1:
            return requested_sources
        if len(explicit_sources) == 1:
            return list(explicit_sources)
        if len(explicit_sources) > 1:
            return self._rank_sources(
                list(explicit_sources),
                plan,
                [
                    item.strip()
                    for item in plan.get("required_columns", [])
                    if isinstance(item, str) and item.strip()
                ],
                conversation_context,
            )

        required_tables = {
            table.strip()
            for table in plan.get("required_tables", [])
            if isinstance(table, str) and table.strip()
        }

        required_columns = [
            item.strip()
            for item in plan.get("required_columns", [])
            if isinstance(item, str) and item.strip()
        ]

        if not required_tables:
            if len(available) == 1:
                return available
            if len(requested_sources) > 1:
                raise ValueError(
                    "PostgreSQL source routing is ambiguous without a "
                    "multi-step execution plan."
                )
            return requested_sources

        # Build source coverage for every required table.
        table_sources: dict[str, list[str]] = {
            table: [
                source_id
                for source_id in available
                if table in self._source_tables(source_id)
            ]
            for table in required_tables
        }

        missing_tables = [
            table
            for table, sources in table_sources.items()
            if not sources
        ]
        if missing_tables:
            raise ValueError(
                "No discovered PostgreSQL source contains required table(s): "
                f"{sorted(missing_tables)}"
            )

        # If every required table belongs to exactly one source, routing is
        # deterministic and does not need an LLM guess.
        unique_sources = {
            sources[0]
            for sources in table_sources.values()
            if len(sources) == 1
        }
        duplicated_tables = [
            table
            for table, sources in table_sources.items()
            if len(sources) > 1
        ]

        if not duplicated_tables:
            return sorted(unique_sources)

        # A duplicated table is intentionally ambiguous. Do not silently
        # query both sources because that recreates the current collision bug.
        if len(requested_sources) > 1:
            requested_cover = {
                source_id
                for source_id in requested_sources
                if any(
                    table in self._source_tables(source_id)
                    for table in required_tables
                )
            }
            if requested_cover:
                raise ValueError(
                    "PostgreSQL source routing is ambiguous for duplicated "
                    "table(s): "
                    f"{sorted(duplicated_tables)}. A multi-step execution plan "
                    "must identify the source for each step."
                )

        # A single planner-selected source is already handled above. If we get
        # here, there is no trustworthy deterministic source choice.
        raise ValueError(
            "PostgreSQL source routing could not deterministically identify "
            "the required source from the discovered Context Layer."
        )

    def _rank_sources(
        self,
        candidates: list[str],
        plan: dict[str, Any],
        required_columns: list[str],
        conversation_context: dict[str, Any] | None,
    ) -> list[str]:
        return sorted(
            dict.fromkeys(candidates),
            key=lambda source_id: (
                -self._source_score(
                    source_id,
                    plan,
                    required_columns,
                    conversation_context,
                ),
                source_id,
            ),
        )

    def _source_score(
        self,
        source_id: str,
        plan: dict[str, Any],
        required_columns: list[str],
        conversation_context: dict[str, Any] | None,
    ) -> int:
        score = 0
        context = self.contexts.get(source_id, {})
        if not isinstance(context, dict):
            return score

        source_tables = self._source_tables(source_id)

        required_tables = {
            table.strip()
            for table in plan.get("required_tables", [])
            if isinstance(table, str) and table.strip()
        }
        score += 10 * len(required_tables & source_tables)

        for reference in required_columns:
            if "." not in reference:
                continue
            table, column = reference.split(".", 1)
            if table in source_tables and self._has_column(
                source_id,
                table,
                column,
            ):
                score += 5

        # Valid entity evidence is a strong tie-breaker because it is
        # already resolved against a source by the existing entity layer.
        for entity in self._conversation_entities(conversation_context):
            if entity.get("source_id") == source_id:
                score += 100

        # Explicit metric source evidence is authoritative for that metric.
        for metric in plan.get("requested_metrics", []):
            if isinstance(metric, dict) and metric.get("source_id") == source_id:
                score += 100

        # Discovered relationship endpoints provide another deterministic
        # tie-breaker without hardcoding domain terminology.
        relationships = context.get("relationships", [])
        if isinstance(relationships, list):
            relevant_tables = required_tables & source_tables
            for relationship in relationships:
                if not isinstance(relationship, dict):
                    continue
                if (
                    relationship.get("source_table") in relevant_tables
                    or relationship.get("target_table") in relevant_tables
                ):
                    score += 2

        return score

    def _get_explicit_sources(
        self,
        plan: dict[str, Any],
        conversation_context: dict[str, Any] | None,
    ) -> set[str]:
        sources: set[str] = set()

        for metric in plan.get("requested_metrics", []):
            if not isinstance(metric, dict):
                continue
            source_id = metric.get("source_id")
            if isinstance(source_id, str) and source_id.strip():
                sources.add(source_id.strip().lower())

        for entity in self._conversation_entities(conversation_context):
            source_id = entity.get("source_id")
            if isinstance(source_id, str) and source_id.strip():
                sources.add(source_id.strip().lower())

        return sources

    def _conversation_entities(
        self,
        conversation_context: dict[str, Any] | None,
    ) -> list[dict[str, Any]]:
        if not isinstance(conversation_context, dict):
            return []
        entities = conversation_context.get("entities", [])
        if not isinstance(entities, list):
            return []
        return [item for item in entities if isinstance(item, dict)]

    def _source_tables(self, source_id: str) -> set[str]:
        context = self.contexts.get(source_id, {})
        if not isinstance(context, dict):
            return set()
        tables = context.get("tables", {})
        return set(tables.keys()) if isinstance(tables, dict) else set()

    def _has_column(
        self,
        source_id: str,
        table_name: str,
        column_name: str,
    ) -> bool:
        context = self.contexts.get(source_id, {})
        if not isinstance(context, dict):
            return False

        table = context.get("tables", {}).get(table_name)
        if not isinstance(table, dict):
            return False

        columns = table.get("columns", [])
        if not isinstance(columns, list):
            return False

        return any(
            isinstance(column, dict)
            and column.get("name") == column_name
            for column in columns
        )

    @staticmethod
    def _normalise_sources(value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        return list(
            dict.fromkeys(
                item.strip().lower()
                for item in value
                if isinstance(item, str) and item.strip()
            )
        )
