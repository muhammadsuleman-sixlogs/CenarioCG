from __future__ import annotations

from concurrent.futures import (
    ThreadPoolExecutor,
    as_completed,
)
from typing import Any

from context.context_store import load_all_contexts
from database.connection import (
    get_connection,
    get_db2_connection,
)
from database.readonly_guard import (
    validate_read_only_query,
)


class EntityResolver:
    """
    Resolve explicit natural-language entity references against the
    automatically discovered PostgreSQL Context Layer.

    PostgreSQL access is strictly READ-ONLY.

    This component performs deterministic candidate lookup only.
    It does not perform semantic interpretation or decide the final
    meaning of the user's question.
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

    MAX_SOURCES = 8
    MAX_CANDIDATE_COLUMNS_PER_SOURCE = 24
    MAX_QUERY_BRANCH_RESULTS = 3
    MAX_TOTAL_RESULTS = 100
    MAX_WORKERS = 4

    def __init__(
        self,
        context: dict[str, Any] | None = None,
        contexts: dict[str, dict[str, Any]] | None = None,
    ):
        if contexts is not None:
            self.contexts = contexts

        elif context is not None:
            source_id = context.get(
                "source_id",
                "db1",
            )

            if not isinstance(
                source_id,
                str,
            ):
                raise ValueError(
                    "Entity context source_id must be a string."
                )

            self.contexts = {
                source_id.strip().lower(): context,
            }

        else:
            self.contexts = load_all_contexts()

        if not isinstance(
            self.contexts,
            dict,
        ):
            raise ValueError(
                "EntityResolver requires a valid Context Layer mapping."
            )

    # ------------------------------------------------------------------
    # Candidate schema discovery
    # ------------------------------------------------------------------

    def _get_candidate_columns(
        self,
        source_id: str,
        context: dict[str, Any],
    ) -> list[dict[str, Any]]:
        """
        Discover a bounded set of identifier/display columns from one
        PostgreSQL source.

        Primary keys are prioritized. Generic identifier hints are allowed
        only because they come from schema metadata, not company schema.
        """

        tables = context.get(
            "tables",
            {},
        )

        if not isinstance(
            tables,
            dict,
        ):
            return []

        candidates: list[
            dict[str, Any]
        ] = []

        for table_name, table_info in tables.items():
            if not isinstance(
                table_info,
                dict,
            ):
                continue

            primary_keys = {
                str(value).lower()
                for value in table_info.get(
                    "primary_keys",
                    [],
                )
                if value
            }

            columns = table_info.get(
                "columns",
                [],
            )

            if not isinstance(
                columns,
                list,
            ):
                continue

            for column in columns:
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

                column_name = str(
                    column_name
                )

                column_lower = (
                    column_name.lower()
                )

                is_primary_key = (
                    column_lower in primary_keys
                )

                hint_score = self._identifier_hint_score(
                    column_lower
                )

                if (
                    not is_primary_key
                    and hint_score <= 0
                ):
                    continue

                priority = (
                    100
                    if is_primary_key
                    else hint_score
                )

                candidates.append(
                    {
                        "source_id": source_id,
                        "table": str(
                            table_name
                        ),
                        "column": column_name,
                        "priority": priority,
                    }
                )

        candidates.sort(
            key=lambda item: (
                -int(
                    item["priority"]
                ),
                item["table"].lower(),
                item["column"].lower(),
            )
        )

        return candidates[
            :self.MAX_CANDIDATE_COLUMNS_PER_SOURCE
        ]

    def _identifier_hint_score(
        self,
        column_name: str,
    ) -> int:
        score = 0

        for hint in self.IDENTIFIER_HINTS:
            if column_name == hint:
                score = max(
                    score,
                    80,
                )
            elif column_name.endswith(
                "_" + hint
            ):
                score = max(
                    score,
                    70,
                )
            elif hint in column_name:
                score = max(
                    score,
                    40,
                )

        return score

    # ------------------------------------------------------------------
    # Matching
    # ------------------------------------------------------------------

    @staticmethod
    def _match_value(
        value: Any,
        search_text: str,
    ) -> tuple[float, str] | None:
        if value is None:
            return None

        value_text = str(
            value
        ).strip()

        if not value_text:
            return None

        value_lower = value_text.lower()
        search_lower = search_text.lower()

        if value_lower == search_lower:
            return 1.0, "exact"

        if value_lower.startswith(
            search_lower
        ):
            return 0.90, "prefix"

        if search_lower in value_lower:
            return 0.70, "partial"

        return None

    # ------------------------------------------------------------------
    # PostgreSQL connections
    # ------------------------------------------------------------------

    @staticmethod
    def _get_connection(
        source_id: str,
    ):
        normalized = (
            str(source_id)
            .strip()
            .lower()
        )

        connection_factories = {
            "db1": get_connection,
            "db2": get_db2_connection,
        }

        factory = connection_factories.get(
            normalized
        )

        if factory is None:
            raise ValueError(
                "Unsupported PostgreSQL entity-resolution "
                f"source: {source_id!r}"
            )

        return factory()

    # ------------------------------------------------------------------
    # One-source search
    # ------------------------------------------------------------------

    def _search_source(
        self,
        source_id: str,
        context: dict[str, Any],
        search_text: str,
        limit: int,
    ) -> list[dict[str, Any]]:
        """
        Search one PostgreSQL source with one parameterized UNION query.

        All identifiers are taken from discovered schema metadata and quoted.
        Runtime search text is always parameterized.

        This method never modifies PostgreSQL.
        """

        candidate_columns = (
            self._get_candidate_columns(
                source_id=source_id,
                context=context,
            )
        )

        if not candidate_columns:
            return []

        connection = self._get_connection(
            source_id
        )

        try:
            connection.set_session(
                readonly=True
            )

            branches: list[str] = []
            parameters: list[Any] = []

            pattern = (
                f"%{search_text.lower()}%"
            )

            for candidate in candidate_columns:
                table_name = candidate[
                    "table"
                ]

                column_name = candidate[
                    "column"
                ]

                quoted_table = (
                    self._quote_identifier(
                        table_name
                    )
                )

                quoted_column = (
                    self._quote_identifier(
                        column_name
                    )
                )

                branches.append(
                    "SELECT "
                    "%s AS entity_table, "
                    "%s AS entity_column, "
                    f"{quoted_column} AS value "
                    f"FROM {quoted_table} "
                    f"WHERE LOWER(CAST({quoted_column} AS TEXT)) "
                    "LIKE %s "
                    "LIMIT %s"
                )

                parameters.extend(
                    [
                        table_name,
                        column_name,
                        pattern,
                        self.MAX_QUERY_BRANCH_RESULTS,
                    ]
                )

            query = "\nUNION ALL\n".join(
                branches
            )

            validate_read_only_query(
                query
            )

            with connection.cursor() as cursor:
                cursor.execute(
                    query,
                    parameters,
                )

                rows = cursor.fetchmany(
                    self.MAX_TOTAL_RESULTS
                )

            candidates: list[
                dict[str, Any]
            ] = []

            for row in rows:
                if len(row) != 3:
                    continue

                table_name = str(
                    row[0]
                )

                column_name = str(
                    row[1]
                )

                value = row[2]

                match = self._match_value(
                    value=value,
                    search_text=search_text,
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
                        "value": str(
                            value
                        ),
                        "confidence": confidence,
                        "match_type": match_type,
                        "evidence": (
                            f"{table_name}.{column_name}"
                        ),
                    }
                )

            return candidates

        finally:
            connection.close()

    # ------------------------------------------------------------------
    # Multi-source resolution
    # ------------------------------------------------------------------

    def resolve(
        self,
        search_text: str,
        limit: int = 5,
        source_ids: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """
        Resolve an explicit entity reference.

        Searches selected PostgreSQL sources independently.

        Independent sources are queried concurrently, but their results are
        never merged into a database-level relationship.
        """

        if (
            not isinstance(
                search_text,
                str,
            )
            or not search_text.strip()
        ):
            return []

        search_text = search_text.strip()

        if len(
            search_text
        ) > 256:
            search_text = search_text[
                :256
            ]

        if (
            isinstance(
                limit,
                bool,
            )
            or not isinstance(
                limit,
                int,
            )
            or limit <= 0
        ):
            return []

        selected_sources = (
            self._resolve_source_ids(
                source_ids
            )
        )

        if not selected_sources:
            return []

        results: list[
            dict[str, Any]
        ] = []

        worker_count = min(
            self.MAX_WORKERS,
            len(selected_sources),
        )

        with ThreadPoolExecutor(
            max_workers=worker_count
        ) as executor:
            futures = {}

            for source_id in selected_sources:
                context = self.contexts.get(
                    source_id
                )

                if not isinstance(
                    context,
                    dict,
                ):
                    continue

                source_type = context.get(
                    "source_type"
                )

                if (
                    source_type
                    and source_type != "postgresql"
                ):
                    continue

                futures[
                    executor.submit(
                        self._safe_search_source,
                        source_id,
                        context,
                        search_text,
                        limit,
                    )
                ] = source_id

            for future in as_completed(
                futures
            ):
                try:
                    results.extend(
                        future.result()
                    )
                except Exception:
                    # Entity resolution is optional context. A source-level
                    # failure must not break the main retrieval pipeline.
                    continue

        results.sort(
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

        return results[
            :min(
                limit,
                self.MAX_TOTAL_RESULTS,
            )
        ]

    def _safe_search_source(
        self,
        source_id: str,
        context: dict[str, Any],
        search_text: str,
        limit: int,
    ) -> list[dict[str, Any]]:
        try:
            return self._search_source(
                source_id=source_id,
                context=context,
                search_text=search_text,
                limit=limit,
            )
        except Exception:
            return []

    def _resolve_source_ids(
        self,
        source_ids: list[str] | None,
    ) -> list[str]:
        available = [
            str(
                source_id
            ).strip().lower()
            for source_id in self.contexts
            if isinstance(
                source_id,
                str,
            )
            and source_id.strip()
        ]

        available = list(
            dict.fromkeys(
                available
            )
        )

        if source_ids is None:
            selected = available

        else:
            if not isinstance(
                source_ids,
                list,
            ):
                raise ValueError(
                    "source_ids must be a list or null."
                )

            selected = [
                str(
                    source_id
                ).strip().lower()
                for source_id in source_ids
                if isinstance(
                    source_id,
                    str,
                )
                and source_id.strip()
            ]

            selected = list(
                dict.fromkeys(
                    selected
                )
            )

            selected = [
                source_id
                for source_id in selected
                if source_id in set(
                    available
                )
            ]

        return selected[
            :self.MAX_SOURCES
        ]

    @staticmethod
    def _quote_identifier(
        identifier: str,
    ) -> str:
        if (
            not isinstance(
                identifier,
                str,
            )
            or not identifier.strip()
        ):
            raise ValueError(
                "SQL identifier must be a non-empty string."
            )

        return (
            '"'
            + identifier.strip().replace(
                '"',
                '""',
            )
            + '"'
        )