from __future__ import annotations

from typing import Any

from context.context_store import load_all_contexts
from database.connection import (
    get_connection,
    get_db2_connection,
)
from database.readonly_guard import validate_read_only_query


class EntityResolver:
    """
    Resolve natural-language entity references using the
    automatically discovered multi-source Context Layer.

    PostgreSQL access is strictly read-only.

    No company-specific table names, column names, entity names,
    or business relationships are hardcoded here.
    """

    IDENTIFIER_HINTS = (
        "id",
        "code",
        "reference",
        "number",
        "key",
        "name",
        "title",
        "label",
        "email",
        "username",
    )

    def __init__(
        self,
        context: dict[str, Any] | None = None,
        contexts: dict[str, dict[str, Any]] | None = None,
    ):
        """
        Initialize the resolver.

        If a single context is supplied, it is used as one source.

        If multiple contexts are supplied, each PostgreSQL source
        remains isolated and source_id is preserved in results.

        If nothing is supplied, all discovered Context Layer
        PostgreSQL sources are loaded.
        """

        if contexts is not None:
            self.contexts = contexts

        elif context is not None:
            source_id = context.get("source_id", "db1")

            self.contexts = {
                source_id: context,
            }

        else:
            self.contexts = load_all_contexts()

        if not isinstance(self.contexts, dict):
            raise ValueError(
                "EntityResolver requires a valid Context Layer mapping."
            )

    def _get_candidate_columns(
        self,
        source_id: str,
        context: dict[str, Any],
    ) -> list[dict[str, str]]:
        """
        Discover candidate identifier/display columns from one source.

        Candidate selection is based only on discovered schema metadata.
        """

        candidates: list[dict[str, str]] = []

        for table_name, table_info in context.get(
            "tables",
            {},
        ).items():

            primary_keys = {
                str(pk).lower()
                for pk in table_info.get(
                    "primary_keys",
                    [],
                )
            }

            for column in table_info.get(
                "columns",
                [],
            ):
                column_name = column.get("name")

                if not column_name:
                    continue

                column_lower = str(column_name).lower()

                is_primary_key = (
                    column_lower in primary_keys
                )

                has_identifier_hint = any(
                    hint in column_lower
                    for hint in self.IDENTIFIER_HINTS
                )

                if not (
                    is_primary_key
                    or has_identifier_hint
                ):
                    continue

                candidates.append(
                    {
                        "source_id": source_id,
                        "table": str(table_name),
                        "column": str(column_name),
                    }
                )

        return candidates

    @staticmethod
    def _match_value(
        value: Any,
        search_text: str,
    ) -> tuple[float, str] | None:
        """
        Classify a matched value.

        Exact matches receive the strongest confidence.
        """

        if value is None:
            return None

        value_text = str(value)
        value_lower = value_text.lower()
        search_lower = search_text.lower()

        if value_lower == search_lower:
            return 1.0, "exact"

        if value_lower.startswith(search_lower):
            return 0.90, "prefix"

        if search_lower in value_lower:
            return 0.70, "partial"

        return None

    def _get_connection(
        self,
        source_id: str,
    ):
        """
        Return the PostgreSQL connection for the requested
        discovered source.

        Source selection is explicit and isolated so that
        entity resolution never executes a DB2 query through
        the DB1 connection or vice versa.
        """

        normalized_source_id = (
            str(source_id).strip().lower()
        )

        connection_factories = {
            "db1": get_connection,
            "db2": get_db2_connection,
        }

        factory = connection_factories.get(
            normalized_source_id
        )

        if factory is None:
            raise ValueError(
                "Unsupported PostgreSQL entity-resolution "
                f"source: {source_id!r}"
            )

        return factory()

    def _search_source(
        self,
        source_id: str,
        context: dict[str, Any],
        search_text: str,
        limit: int,
    ) -> list[dict[str, Any]]:
        """
        Search one PostgreSQL source using only discovered candidate
        columns.

        All queries are validated by the read-only guard before execution.
        """

        candidate_columns = self._get_candidate_columns(
            source_id,
            context,
        )

        if not candidate_columns:
            return []

        connection = self._get_connection(
            source_id
        )

        candidates: list[dict[str, Any]] = []

        try:
            with connection.cursor() as cursor:
                for candidate in candidate_columns:
                    table_name = candidate["table"]
                    column_name = candidate["column"]

                    query = f"""
                        SELECT
                            "{column_name}"
                        FROM "{table_name}"
                        WHERE LOWER(CAST("{column_name}" AS TEXT))
                              LIKE %s
                        LIMIT %s;
                    """

                    validate_read_only_query(query)

                    cursor.execute(
                        query,
                        (
                            f"%{search_text.lower()}%",
                            limit,
                        ),
                    )

                    rows = cursor.fetchall()

                    for row in rows:
                        value = row[0]

                        match = self._match_value(
                            value,
                            search_text,
                        )

                        if match is None:
                            continue

                        confidence, match_type = match

                        candidates.append(
                            {
                                "source_id": source_id,
                                "entity_type": table_name,
                                "entity_table": table_name,
                                "entity_column": column_name,
                                "value": str(value),
                                "confidence": confidence,
                                "match_type": match_type,
                                "evidence": (
                                    f"{table_name}.{column_name}"
                                ),
                            }
                        )

        finally:
            connection.close()

        return candidates

    def resolve(
        self,
        search_text: str,
        limit: int = 5,
        source_ids: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """
        Resolve a possible entity reference.

        Returns an empty list when no reference is supplied or
        no matching entity is found.

        This is intentionally optional: normal questions do not
        require entity resolution.
        """

        if not search_text or not search_text.strip():
            return []

        search_text = search_text.strip()

        if limit <= 0:
            return []

        if source_ids is None:
            selected_sources = list(
                self.contexts.keys()
            )
        else:
            selected_sources = [
                source_id
                for source_id in source_ids
                if source_id in self.contexts
            ]

        if not selected_sources:
            return []

        all_candidates: list[dict[str, Any]] = []

        for source_id in selected_sources:
            context = self.contexts.get(source_id)

            if not isinstance(context, dict):
                continue

            source_type = context.get(
                "source_type"
            )

            # Entity resolution currently applies only to
            # discovered PostgreSQL sources.
            if (
                source_type
                and source_type != "postgresql"
            ):
                continue

            try:
                source_candidates = self._search_source(
                    source_id=source_id,
                    context=context,
                    search_text=search_text,
                    limit=limit,
                )

            except Exception:
                # A source-level resolution failure should not
                # prevent resolution against other available sources.
                continue

            all_candidates.extend(
                source_candidates
            )

        all_candidates.sort(
            key=lambda item: (
                -float(
                    item.get(
                        "confidence",
                        0.0,
                    )
                ),
                str(
                    item.get(
                        "source_id",
                        "",
                    )
                ),
                str(
                    item.get(
                        "entity_table",
                        "",
                    )
                ),
                str(
                    item.get(
                        "entity_column",
                        "",
                    )
                ),
            )
        )

        return all_candidates[:limit]

