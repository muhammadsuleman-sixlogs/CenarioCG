from __future__ import annotations

from collections import deque
from copy import deepcopy
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from context.context_store import load_context
from database.readonly_guard import validate_read_only_query
from retrieval.sql_validator import validate_sql_syntax
from security.sensitive_data_policy import sanitize_schema_context


class SQLGenerator:
    """
    Deterministic PostgreSQL SQL compiler.

    The semantic interpretation of the user's question has already happened
    in QuestionPlanner.

    This class decides HOW to execute that validated intent:

        RetrievalContract
            ->
        schema-grounded SQL
            ->
        read-only validation

    It does not:
        - call an LLM
        - reinterpret the question
        - invent tables
        - invent columns
        - invent relationships
        - join different PostgreSQL sources
        - store runtime values
        - modify PostgreSQL

    PostgreSQL remains strictly READ-ONLY.
    """

    ALLOWED_OPERATORS = {
        "=",
        "!=",
        "<>",
        ">",
        ">=",
        "<",
        "<=",
        "in",
        "not_in",
        "contains",
        "starts_with",
        "ends_with",
        "is_null",
        "is_not_null",
    }

    OPERATOR_ALIASES = {
        "eq": "=",
        "equals": "=",
        "==": "=",
        "neq": "!=",
        "not_equals": "!=",
        "gt": ">",
        "gte": ">=",
        "lt": "<",
        "lte": "<=",
    }

    AGGREGATE_OPERATIONS = {
        "count",
        "sum",
        "average",
        "avg",
        "mean",
        "minimum",
        "min",
        "maximum",
        "max",
    }

    AGGREGATE_ALIASES = {
        "avg": "average",
        "mean": "average",
        "min": "minimum",
        "max": "maximum",
    }

    SORT_DIRECTIONS = {
        "asc",
        "desc",
    }

    def __init__(
        self,
        context: dict[str, Any] | None = None,
        source_id: str = "db1",
    ):
        if (
            not isinstance(source_id, str)
            or not source_id.strip()
        ):
            raise ValueError(
                "source_id must be a non-empty string."
            )

        self.source_id = source_id.strip().lower()

        self.context = (
            context
            if context is not None
            else load_context(
                source_id=self.source_id
            )
        )

        if (
            not isinstance(self.context, dict)
            or not self.context
        ):
            raise ValueError(
                f"No Context Layer is available for "
                f"PostgreSQL source '{self.source_id}'."
            )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def generate(
        self,
        contract: dict[str, Any],
        source_id: str | None = None,
        runtime_bindings: dict[str, Any] | None = None,
    ) -> str:
        """
        Compile a validated RetrievalContract into one read-only SQL query.

        Runtime values are never embedded into the SQL string.

        Runtime binding placeholders are represented with PostgreSQL
        parameter markers and their actual values are handled by the
        execution layer.
        """

        self._validate_contract(contract)

        active_source_id = self._resolve_source_id(
            source_id=source_id,
            contract=contract,
        )

        if active_source_id != self.source_id:
            raise ValueError(
                "SQLGenerator source mismatch: "
                f"generator is bound to '{self.source_id}', "
                f"but execution requested '{active_source_id}'."
            )

        self._validate_contract_source(
            contract=contract,
            active_source_id=active_source_id,
        )

        bindings = self._normalize_runtime_bindings(
            runtime_bindings
        )

        schema_context = self._build_schema_context()

        sql = self._compile_query(
            contract=contract,
            schema_context=schema_context,
            runtime_bindings=bindings,
        )

        sql = self._normalize_sql(sql)

        validate_read_only_query(sql)
        validate_sql_syntax(sql)

        return sql

    def repair(
        self,
        query: str,
        database_error: str,
        contract: dict[str, Any],
        source_id: str | None = None,
        runtime_bindings: dict[str, Any] | None = None,
    ) -> str:
        """
        Deterministic compatibility method.

        The previous implementation sent the failed query and database error
        to an LLM. That created a second semantic authority.

        The optimized architecture does not do that.

        Instead, the contract is compiled again deterministically. Known SQL
        classes such as aggregation/GROUP BY and runtime bindings are already
        handled by the compiler itself.

        If deterministic recompilation still fails, the caller receives the
        actual error instead of receiving an LLM-invented repair.
        """

        if not isinstance(query, str) or not query.strip():
            raise ValueError(
                "SQL query cannot be empty."
            )

        if (
            not isinstance(database_error, str)
            or not database_error.strip()
        ):
            raise ValueError(
                "Database error cannot be empty."
            )

        self._validate_contract(contract)

        return self.generate(
            contract=contract,
            source_id=source_id,
            runtime_bindings=runtime_bindings,
        )

    # ------------------------------------------------------------------
    # Contract validation
    # ------------------------------------------------------------------

    def _validate_contract(
        self,
        contract: dict[str, Any],
    ) -> None:
        if not isinstance(contract, dict):
            raise ValueError(
                "Retrieval contract must be a dictionary."
            )

        question = contract.get("question")

        if question is not None and (
            not isinstance(question, str)
            or not question.strip()
        ):
            raise ValueError(
                "Retrieval contract question must be a "
                "non-empty string."
            )

        for field_name in (
            "required_tables",
            "required_columns",
            "relationships",
            "filters",
            "operations",
            "grouping",
            "sorting",
            "entities",
            "requested_metrics",
        ):
            value = contract.get(field_name, [])

            if value is None:
                continue

            if not isinstance(value, list):
                raise ValueError(
                    f"Retrieval contract {field_name} must be a list."
                )

        limit = contract.get("limit")

        if limit is not None:
            if (
                isinstance(limit, bool)
                or not isinstance(limit, int)
            ):
                raise ValueError(
                    "Retrieval contract limit must be an integer."
                )

            if limit < 1:
                raise ValueError(
                    "Retrieval contract limit must be greater than 0."
                )

        data_sources = contract.get(
            "data_sources",
            ["postgresql"],
        )

        if not isinstance(data_sources, list):
            raise ValueError(
                "Retrieval contract data_sources must be a list."
            )

        invalid = [
            value
            for value in data_sources
            if value not in {
                "postgresql",
                "security_logs",
            }
        ]

        if invalid:
            raise ValueError(
                "Unsupported data source(s): "
                f"{invalid}"
            )

        postgresql_sources = contract.get(
            "postgresql_sources",
            [],
        )

        if not isinstance(postgresql_sources, list):
            raise ValueError(
                "Retrieval contract postgresql_sources "
                "must be a list."
            )

        query_shape = contract.get(
            "query_shape",
            "auto",
        )

        if not isinstance(query_shape, str):
            raise ValueError(
                "contract query_shape must be a string."
            )

        if query_shape.strip().lower() not in {
            "auto",
            "direct",
            "cte",
            "subquery",
        }:
            raise ValueError(
                "Unsupported deterministic query_shape: "
                f"{query_shape!r}"
            )

    def _resolve_source_id(
        self,
        source_id: str | None,
        contract: dict[str, Any],
    ) -> str:
        if source_id is not None:
            if (
                not isinstance(source_id, str)
                or not source_id.strip()
            ):
                raise ValueError(
                    "source_id must be a non-empty string."
                )

            return source_id.strip().lower()

        contract_source = contract.get(
            "source_id"
        )

        if isinstance(
            contract_source,
            str,
        ) and contract_source.strip():
            return contract_source.strip().lower()

        sources = contract.get(
            "postgresql_sources",
            [],
        )

        normalized = [
            value.strip().lower()
            for value in sources
            if isinstance(value, str)
            and value.strip()
        ]

        if len(normalized) == 1:
            return normalized[0]

        return self.source_id

    def _validate_contract_source(
        self,
        contract: dict[str, Any],
        active_source_id: str,
    ) -> None:
        contract_sources = contract.get(
            "postgresql_sources",
            [],
        )

        normalized = {
            value.strip().lower()
            for value in contract_sources
            if isinstance(value, str)
            and value.strip()
        }

        if normalized and (
            active_source_id not in normalized
        ):
            raise ValueError(
                "Retrieval contract does not authorize PostgreSQL "
                f"source '{active_source_id}'."
            )

        declared_source = contract.get(
            "source_id"
        )

        if (
            isinstance(declared_source, str)
            and declared_source.strip()
            and declared_source.strip().lower()
            != active_source_id
        ):
            raise ValueError(
                "Retrieval contract source mismatch: "
                f"contract specifies '{declared_source.strip().lower()}', "
                f"but execution requested '{active_source_id}'."
            )

    # ------------------------------------------------------------------
    # Schema
    # ------------------------------------------------------------------

    def _build_schema_context(
        self,
    ) -> dict[str, Any]:
        """
        Return sanitized schema metadata.

        No schema metadata is generated or inferred here.
        """

        tables: dict[str, Any] = {}

        raw_tables = self.context.get(
            "tables",
            {},
        )

        if not isinstance(
            raw_tables,
            dict,
        ):
            raise ValueError(
                "Context Layer tables must be a dictionary."
            )

        for table_name, table_info in raw_tables.items():
            if not isinstance(
                table_info,
                dict,
            ):
                continue

            raw_columns = table_info.get(
                "columns",
                [],
            )

            columns: list[dict[str, Any]] = []

            if isinstance(
                raw_columns,
                list,
            ):
                for column in raw_columns:
                    if not isinstance(
                        column,
                        dict,
                    ):
                        continue

                    name = column.get(
                        "name"
                    )

                    if not name:
                        continue

                    columns.append(
                        {
                            "name": str(name),
                            "data_type": (
                                column.get("data_type")
                                if column.get("data_type")
                                is not None
                                else column.get("type")
                            ),
                        }
                    )

            tables[str(table_name)] = {
                "columns": columns,
                "primary_keys": list(
                    table_info.get(
                        "primary_keys",
                        [],
                    )
                    or []
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

        return sanitize_schema_context(
            schema_context
        )

    def _tables(
        self,
    ) -> dict[str, dict[str, Any]]:
        context = self._build_schema_context()

        tables = context.get(
            "tables",
            {},
        )

        if not isinstance(
            tables,
            dict,
        ):
            raise ValueError(
                "Context Layer tables must be a dictionary."
            )

        return tables

    def _table_lookup(
        self,
    ) -> dict[str, str]:
        return {
            table_name.lower(): table_name
            for table_name in self._tables()
        }

    def _resolve_table(
        self,
        table_name: str,
    ) -> str:
        if (
            not isinstance(table_name, str)
            or not table_name.strip()
        ):
            raise ValueError(
                "Table name must be a non-empty string."
            )

        requested = table_name.strip()

        lookup = self._table_lookup()

        actual = lookup.get(
            requested.lower()
        )

        if actual is None:
            raise ValueError(
                "Table is not present in the discovered "
                f"Context Layer: {requested!r}"
            )

        return actual

    def _columns(
        self,
        table_name: str,
    ) -> dict[str, dict[str, Any]]:
        table = self._resolve_table(
            table_name
        )

        table_info = self._tables().get(
            table,
            {},
        )

        result: dict[str, dict[str, Any]] = {}

        for column in table_info.get(
            "columns",
            [],
        ):
            if not isinstance(
                column,
                dict,
            ):
                continue

            name = column.get(
                "name"
            )

            if not name:
                continue

            result[str(name).lower()] = column

        return result

    def _resolve_column(
        self,
        table_name: str,
        column_name: str,
    ) -> str:
        actual_table = self._resolve_table(
            table_name
        )

        if (
            not isinstance(column_name, str)
            or not column_name.strip()
        ):
            raise ValueError(
                "Column name must be a non-empty string."
            )

        requested = column_name.strip()

        if "." in requested:
            parts = [p.strip() for p in requested.split(".", 1)]
            if len(parts) == 2 and parts[1]:
                requested = parts[1]

        columns = self._columns(
            actual_table
        )

        column = columns.get(
            requested.lower()
        )

        if column is None:
            raise ValueError(
                "Column is not present in the discovered "
                f"Context Layer: "
                f"{actual_table}.{requested}"
            )

        return str(
            column.get(
                "name",
                requested,
            )
        )

    def _column_metadata(
        self,
        table_name: str,
        column_name: str,
    ) -> dict[str, Any]:
        actual_column = self._resolve_column(
            table_name,
            column_name,
        )

        return self._columns(
            table_name
        )[actual_column.lower()]

    # ------------------------------------------------------------------
    # Contract compilation
    # ------------------------------------------------------------------

    def _compile_query(
        self,
        contract: dict[str, Any],
        schema_context: dict[str, Any],
        runtime_bindings: list[dict[str, Any]],
    ) -> str:
        del schema_context

        required_tables = self._normalize_required_tables(
            contract
        )

        if not required_tables:
            raise ValueError(
                "Retrieval contract requires at least one table."
            )

        contract_rels = contract.get("relationships", [])
        context_rels = self.context.get("relationships", [])
        combined_relationships = (
            list(contract_rels) if isinstance(contract_rels, list) else []
        )
        if isinstance(context_rels, list):
            combined_relationships.extend(
                [rel for rel in context_rels if isinstance(rel, dict)]
            )

        selected_tables = self._build_joined_table_set(
            required_tables,
            combined_relationships,
        )

        where_clauses = self._compile_filters(
            contract.get(
                "filters",
                [],
            ),
            selected_tables,
        )

        where_clauses.extend(
            self._compile_runtime_bindings(
                runtime_bindings,
                selected_tables,
            )
        )

        grouping = self._compile_grouping(
            contract.get(
                "grouping",
                [],
            ),
            selected_tables,
        )

        sorting = self._compile_sorting(
            contract.get(
                "sorting",
                [],
            ),
            selected_tables,
        )

        requested_metrics = contract.get(
            "requested_metrics",
            [],
        )

        operations = [
            str(value).strip().lower()
            for value in contract.get(
                "operations",
                [],
            )
            if isinstance(value, str)
            and value.strip()
        ]

        has_metrics = bool(
            requested_metrics
        ) or any(
            operation in self.AGGREGATE_OPERATIONS
            for operation in operations
        )

        if has_metrics:
            select_sql, aggregate_query = (
                self._compile_aggregate_select(
                    contract=contract,
                    selected_tables=selected_tables,
                    grouping=grouping,
                    requested_metrics=requested_metrics,
                    operations=operations,
                )
            )
        else:
            select_sql = self._compile_projection(
                contract=contract,
                selected_tables=selected_tables,
            )
            aggregate_query = False

        from_sql = self._compile_from_and_joins(
            required_tables=required_tables,
            relationships=combined_relationships,
        )

        distinct = self._uses_distinct(
            contract
        )

        # Ranking with grouping means "latest/top row per group", not SQL
        # aggregation. Use DISTINCT ON so non-grouped selected columns
        # (e.g. meeting_title) remain valid under PostgreSQL.
        is_ranking_query = (
            "ranking" in operations
            and not has_metrics
            and bool(grouping)
        )

        if is_ranking_query:
            select_keyword = (
                "SELECT DISTINCT ON ("
                + ", ".join(grouping)
                + ")"
            )
        elif distinct:
            select_keyword = "SELECT DISTINCT"
        else:
            select_keyword = "SELECT"

        query_parts = [
            f"{select_keyword} {select_sql}",
            f"FROM {from_sql}",
        ]

        if where_clauses:
            query_parts.append(
                "WHERE " + " AND ".join(
                    f"({value})"
                    for value in where_clauses
                )
            )

        if grouping and (aggregate_query or has_metrics):
            query_parts.append(
                "GROUP BY "
                + ", ".join(grouping)
            )

        order_by = self._compile_order_by(
            sorting=sorting,
            grouping=grouping,
            ranking_query=is_ranking_query,
        )
        if order_by:
            query_parts.append(
                "ORDER BY "
                + ", ".join(order_by)
            )

        limit = contract.get(
            "limit"
        )

        if limit is not None:
            query_parts.append(
                f"LIMIT {int(limit)}"
            )

        query = "\n".join(
            query_parts
        )

        query_shape = str(
            contract.get(
                "query_shape",
                "auto",
            )
            or "auto"
        ).strip().lower()

        if query_shape == "cte":
            query = (
                "WITH retrieval_result AS (\n"
                + self._indent_sql(query)
                + "\n)\n"
                "SELECT *\n"
                "FROM retrieval_result"
            )

        elif query_shape == "subquery":
            query = (
                "SELECT *\n"
                "FROM (\n"
                + self._indent_sql(query)
                + "\n) AS retrieval_result"
            )

        return query

    def _normalize_required_tables(
        self,
        contract: dict[str, Any],
    ) -> list[str]:
        raw = contract.get(
            "required_tables",
            [],
        )

        normalized: list[str] = []

        for value in raw:
            if (
                not isinstance(value, str)
                or not value.strip()
            ):
                raise ValueError(
                    "required_tables must contain "
                    "non-empty strings."
                )

            normalized.append(
                self._resolve_table(
                    value
                )
            )

        return list(
            dict.fromkeys(normalized)
        )

    # ------------------------------------------------------------------
    # Relationship / JOIN compilation
    # ------------------------------------------------------------------

    def _normalize_relationship(
        self,
        relationship: Any,
    ) -> dict[str, str] | None:
        if not isinstance(
            relationship,
            dict,
        ):
            return None

        source_table = relationship.get(
            "source_table"
        )
        source_column = relationship.get(
            "source_column"
        )
        target_table = relationship.get(
            "target_table"
        )
        target_column = relationship.get(
            "target_column"
        )

        if not all(
            isinstance(value, str)
            and value.strip()
            for value in (
                source_table,
                source_column,
                target_table,
                target_column,
            )
        ):
            return None

        result = {
            "source_table": self._resolve_table(
                source_table
            ),
            "source_column": self._resolve_column(
                source_table,
                source_column,
            ),
            "target_table": self._resolve_table(
                target_table
            ),
            "target_column": self._resolve_column(
                target_table,
                target_column,
            ),
        }

        relationship_source = relationship.get(
            "source_id"
        )

        if isinstance(
            relationship_source,
            str,
        ) and relationship_source.strip():
            result["source_id"] = (
                relationship_source.strip().lower()
            )

        return result

    def _normalized_relationships(
        self,
        relationships: Any,
    ) -> list[dict[str, str]]:
        if not isinstance(
            relationships,
            list,
        ):
            raise ValueError(
                "relationships must be a list."
            )

        result: list[dict[str, str]] = []

        for relationship in relationships:
            normalized = self._normalize_relationship(
                relationship
            )

            if normalized is not None:
                result.append(
                    normalized
                )

        return result

    def _relationship_graph(
        self,
        relationships: list[dict[str, str]],
    ) -> dict[str, list[tuple[str, dict[str, str]]]]:
        graph: dict[
            str,
            list[
                tuple[
                    str,
                    dict[str, str],
                ]
            ],
        ] = {}

        for relationship in relationships:
            source_table = relationship[
                "source_table"
            ]
            target_table = relationship[
                "target_table"
            ]

            graph.setdefault(
                source_table,
                [],
            ).append(
                (
                    target_table,
                    relationship,
                )
            )

            reverse = {
                "source_table": target_table,
                "source_column": relationship[
                    "target_column"
                ],
                "target_table": source_table,
                "target_column": relationship[
                    "source_column"
                ],
            }

            if "source_id" in relationship:
                reverse["source_id"] = relationship[
                    "source_id"
                ]

            graph.setdefault(
                target_table,
                [],
            ).append(
                (
                    source_table,
                    reverse,
                )
            )

        return graph

    def _build_joined_table_set(
        self,
        required_tables: list[str],
        relationships: Any,
    ) -> list[str]:
        """
        Verify that all required tables are connected through discovered
        relationships.

        Intermediate relationship tables are allowed.

        No column-name similarity or implicit key matching is used.
        """

        if len(required_tables) <= 1:
            return list(required_tables)

        normalized_relationships = (
            self._normalized_relationships(
                relationships
            )
        )

        graph = self._relationship_graph(
            normalized_relationships
        )

        connected = {
            required_tables[0]
        }

        joined_order = [
            required_tables[0]
        ]

        remaining = set(
            required_tables[1:]
        )

        while remaining:
            path = self._find_path_from_connected_to_targets(
                connected=connected,
                targets=remaining,
                graph=graph,
            )

            if path is None:
                missing = sorted(
                    remaining
                )

                raise ValueError(
                    "No complete discovered relationship path exists "
                    "for required tables: "
                    f"{missing}"
                )

            path_nodes, path_edges = path

            for node in path_nodes:
                if node not in joined_order:
                    joined_order.append(
                        node
                    )

                connected.add(
                    node
                )

                remaining.discard(
                    node
                )

            del path_edges

        return joined_order

    def _find_path_from_connected_to_targets(
        self,
        connected: set[str],
        targets: set[str],
        graph: dict[
            str,
            list[
                tuple[
                    str,
                    dict[str, str],
                ]
            ],
        ],
    ) -> tuple[
        list[str],
        list[dict[str, str]],
    ] | None:
        queue = deque()

        parent: dict[
            str,
            tuple[
                str | None,
                dict[str, str] | None,
            ],
        ] = {}

        for start in sorted(
            connected
        ):
            queue.append(
                start
            )
            parent[start] = (
                None,
                None,
            )

        target = None

        while queue:
            current = queue.popleft()

            if (
                current in targets
                and current not in connected
            ):
                target = current
                break

            neighbors = sorted(
                graph.get(
                    current,
                    [],
                ),
                key=lambda item: item[0],
            )

            for neighbor, relationship in neighbors:
                if neighbor in parent:
                    continue

                parent[neighbor] = (
                    current,
                    relationship,
                )

                queue.append(
                    neighbor
                )

        if target is None:
            return None

        nodes: list[str] = []
        edges: list[dict[str, str]] = []

        current = target

        while current is not None:
            nodes.append(
                current
            )

            previous, relationship = parent[
                current
            ]

            if relationship is not None:
                edges.append(
                    relationship
                )

            current = previous

        nodes.reverse()
        edges.reverse()

        return nodes, edges

    def _compile_from_and_joins(
        self,
        required_tables: list[str],
        relationships: Any,
    ) -> str:
        if not required_tables:
            raise ValueError(
                "At least one required table is necessary."
            )

        normalized_relationships = (
            self._normalized_relationships(
                relationships
            )
        )

        graph = self._relationship_graph(
            normalized_relationships
        )

        base_table = required_tables[0]

        joined: set[str] = {
            base_table
        }

        pieces = [
            self._quote_identifier(
                base_table
            )
        ]

        pending = set(
            required_tables[1:]
        )

        while pending:
            path = self._find_path_from_connected_to_targets(
                connected=joined,
                targets=pending,
                graph=graph,
            )

            if path is None:
                raise ValueError(
                    "Required PostgreSQL tables cannot be connected "
                    "using discovered relationships."
                )

            path_nodes, path_edges = path

            for index, relationship in enumerate(
                path_edges
            ):
                left_table = relationship[
                    "source_table"
                ]
                left_column = relationship[
                    "source_column"
                ]
                right_table = relationship[
                    "target_table"
                ]
                right_column = relationship[
                    "target_column"
                ]

                if left_table in joined:
                    new_table = right_table
                    new_column = right_column
                    existing_table = left_table
                    existing_column = left_column

                elif right_table in joined:
                    new_table = left_table
                    new_column = left_column
                    existing_table = right_table
                    existing_column = right_column

                else:
                    # For intermediate path nodes, the path itself must
                    # still determine which side is already reachable.
                    if index > 0:
                        previous_relationship = path_edges[
                            index - 1
                        ]

                        previous_table = path_nodes[
                            index
                        ]

                        if previous_table == left_table:
                            new_table = right_table
                            new_column = right_column
                            existing_table = left_table
                            existing_column = left_column
                        else:
                            new_table = left_table
                            new_column = left_column
                            existing_table = right_table
                            existing_column = right_column
                    else:
                        raise ValueError(
                            "Unable to compile discovered JOIN path."
                        )

                pieces.append(
                    "JOIN "
                    + self._quote_identifier(
                        new_table
                    )
                    + " ON "
                    + self._qualified_identifier(
                        existing_table,
                        existing_column,
                    )
                    + " = "
                    + self._qualified_identifier(
                        new_table,
                        new_column,
                    )
                )

                joined.add(
                    new_table
                )

                pending.discard(
                    new_table
                )

        return "\n".join(
            pieces
        )

    # ------------------------------------------------------------------
    # Projection
    # ------------------------------------------------------------------

    def _compile_projection(
        self,
        contract: dict[str, Any],
        selected_tables: list[str],
    ) -> str:
        required_columns = contract.get(
            "required_columns",
            [],
        )

        expressions: list[str] = []

        for reference in required_columns:
            table_name, column_name = (
                self._parse_field_reference(
                    reference,
                    selected_tables,
                )
            )

            expressions.append(
                self._qualified_identifier(
                    table_name,
                    column_name,
                )
            )

        if expressions:
            return ", ".join(
                expressions
            )

        # Never fall back to SELECT * for an unconstrained retrieval.
        #
        # Use discovered primary keys as the smallest meaningful result.
        for table_name in selected_tables:
            table_info = self._tables().get(
                table_name,
                {},
            )

            primary_keys = table_info.get(
                "primary_keys",
                [],
            ) or []

            for primary_key in primary_keys:
                if not isinstance(
                    primary_key,
                    str,
                ):
                    continue

                column_name = self._resolve_column(
                    table_name,
                    primary_key,
                )

                expressions.append(
                    self._qualified_identifier(
                        table_name,
                        column_name,
                    )
                )

        if not expressions:
            raise ValueError(
                "Retrieval contract did not provide any required output "
                "columns, and no discovered primary key is available "
                "for a safe projection."
            )

        return ", ".join(
            dict.fromkeys(
                expressions
            )
        )

    # ------------------------------------------------------------------
    # Aggregation / metrics
    # ------------------------------------------------------------------

    def _compile_aggregate_select(
        self,
        contract: dict[str, Any],
        selected_tables: list[str],
        grouping: list[str],
        requested_metrics: Any,
        operations: list[str],
    ) -> tuple[str, bool]:
        expressions: list[str] = []

        for field in grouping:
            expressions.append(
                self._resolve_field_expression(
                    field,
                    selected_tables,
                )
            )

        metrics = (
            requested_metrics
            if isinstance(
                requested_metrics,
                list,
            )
            else []
        )

        if metrics:
            for metric in metrics:
                expressions.append(
                    self._compile_metric(
                        metric,
                        selected_tables,
                    )
                )

        else:
            aggregate_operations = [
                self.AGGREGATE_ALIASES.get(
                    operation,
                    operation,
                )
                for operation in operations
                if operation in self.AGGREGATE_OPERATIONS
            ]

            for operation in aggregate_operations:
                expressions.append(
                    self._compile_implicit_metric(
                        operation,
                        contract,
                        selected_tables,
                    )
                )

        if not expressions:
            raise ValueError(
                "An aggregate retrieval requires at least one "
                "grouping field or requested metric."
            )

        return (
            ", ".join(expressions),
            True,
        )

    def _compile_metric(
        self,
        metric: Any,
        selected_tables: list[str],
    ) -> str:
        if not isinstance(
            metric,
            dict,
        ):
            raise ValueError(
                "Each requested metric must be an object."
            )

        operation = str(
            metric.get(
                "operation",
                "",
            )
        ).strip().lower()

        operation = self.AGGREGATE_ALIASES.get(
            operation,
            operation,
        )

        if operation not in {
            "count",
            "sum",
            "average",
            "minimum",
            "maximum",
        }:
            raise ValueError(
                "Unsupported requested metric operation: "
                f"{operation!r}"
            )

        source_id = metric.get(
            "source_id"
        )

        if (
            source_id is not None
            and str(source_id).strip().lower()
            != self.source_id
        ):
            raise ValueError(
                "Requested metric source_id does not match "
                f"SQLGenerator source '{self.source_id}'."
            )

        table_name = metric.get(
            "table"
        )
        column_name = metric.get(
            "column"
        )

        if (
            not isinstance(
                table_name,
                str,
            )
            or not table_name.strip()
        ):
            raise ValueError(
                "Requested metric table is required."
            )

        table_name = self._resolve_table(
            table_name
        )

        if table_name not in selected_tables:
            raise ValueError(
                f"Requested metric table '{table_name}' "
                "is not part of the selected query scope."
            )

        if (
            not isinstance(
                column_name,
                str,
            )
            or not column_name.strip()
        ):
            if operation == "count":
                expression = "COUNT(*)"
            else:
                raise ValueError(
                    f"Metric operation '{operation}' requires "
                    "a column."
                )
        else:
            column_name = self._resolve_column(
                table_name,
                column_name,
            )

            qualified = self._qualified_identifier(
                table_name,
                column_name,
            )

            distinct = bool(
                metric.get(
                    "distinct",
                    False,
                )
            )

            if operation == "count":
                expression = (
                    f"COUNT(DISTINCT {qualified})"
                    if distinct
                    else f"COUNT({qualified})"
                )

            elif operation == "sum":
                expression = (
                    f"SUM({qualified})"
                )

            elif operation == "average":
                expression = (
                    f"AVG({qualified})"
                )

            elif operation == "minimum":
                expression = (
                    f"MIN({qualified})"
                )

            else:
                expression = (
                    f"MAX({qualified})"
                )

        label = metric.get(
            "label"
        )

        if isinstance(
            label,
            str,
        ) and label.strip():
            expression += (
                " AS "
                + self._quote_identifier(
                    label.strip()
                )
            )

        return expression

    def _compile_implicit_metric(
        self,
        operation: str,
        contract: dict[str, Any],
        selected_tables: list[str],
    ) -> str:
        required_columns = [
            value
            for value in contract.get(
                "required_columns",
                [],
            )
            if isinstance(
                value,
                str,
            )
        ]

        if operation == "count":
            return "COUNT(*) AS " + self._quote_identifier(
                "count"
            )

        if not required_columns:
            raise ValueError(
                f"Operation '{operation}' requires a numeric/value "
                "column or requested_metrics."
            )

        candidates: list[
            tuple[str, str]
        ] = []

        for reference in required_columns:
            table_name, column_name = (
                self._parse_field_reference(
                    reference,
                    selected_tables,
                )
            )

            metadata = self._column_metadata(
                table_name,
                column_name,
            )

            data_type = str(
                metadata.get(
                    "data_type",
                    "",
                )
                or ""
            ).lower()

            candidates.append(
                (
                    reference,
                    data_type,
                )
            )

        numeric_candidates = [
            reference
            for reference, data_type in candidates
            if any(
                token in data_type
                for token in (
                    "integer",
                    "bigint",
                    "smallint",
                    "numeric",
                    "decimal",
                    "real",
                    "double",
                    "money",
                )
            )
        ]

        if len(numeric_candidates) != 1:
            raise ValueError(
                f"Operation '{operation}' requires an unambiguous "
                "metric column in the Retrieval Contract."
            )

        table_name, column_name = (
            self._parse_field_reference(
                numeric_candidates[0],
                selected_tables,
            )
        )

        qualified = self._qualified_identifier(
            table_name,
            column_name,
        )

        functions = {
            "sum": "SUM",
            "average": "AVG",
            "minimum": "MIN",
            "maximum": "MAX",
        }

        return (
            f"{functions[operation]}({qualified}) "
            f"AS {self._quote_identifier(operation)}"
        )

    # ------------------------------------------------------------------
    # Filters
    # ------------------------------------------------------------------

    def _compile_filters(
        self,
        filters: Any,
        selected_tables: list[str],
    ) -> list[str]:
        if not isinstance(
            filters,
            list,
        ):
            raise ValueError(
                "filters must be a list."
            )

        result: list[str] = []

        for filter_value in filters:
            if not isinstance(
                filter_value,
                dict,
            ):
                raise ValueError(
                    "Each filter must be an object."
                )

            reference = (
                filter_value.get("field")
                or filter_value.get("column")
            )

            table_name = filter_value.get(
                "table"
            )

            if (
                isinstance(
                    reference,
                    str,
                )
                and "." in reference
                and not table_name
            ):
                table_name, reference = (
                    reference.split(
                        ".",
                        1,
                    )
                )

            if (
                not isinstance(
                    table_name,
                    str,
                )
                or not table_name.strip()
            ):
                raise ValueError(
                    "Filter table is required."
                )

            if (
                not isinstance(
                    reference,
                    str,
                )
                or not reference.strip()
            ):
                raise ValueError(
                    "Filter column is required."
                )

            table_name = self._resolve_table(
                table_name
            )

            if table_name not in selected_tables:
                raise ValueError(
                    f"Filter references table '{table_name}' "
                    "outside the selected query scope."
                )

            column_name = self._resolve_column(
                table_name,
                reference,
            )

            operator = filter_value.get(
                "operator",
                "=",
            )

            if not isinstance(
                operator,
                str,
            ):
                raise ValueError(
                    "Filter operator must be a string."
                )

            operator = self.OPERATOR_ALIASES.get(
                operator.strip().lower(),
                operator.strip().lower(),
            )

            if operator not in self.ALLOWED_OPERATORS:
                raise ValueError(
                    f"Unsupported filter operator: "
                    f"{operator!r}"
                )

            qualified = self._qualified_identifier(
                table_name,
                column_name,
            )

            result.append(
                self._compile_filter_expression(
                    qualified=qualified,
                    operator=operator,
                    value=filter_value.get(
                        "value"
                    ),
                )
            )

        return result

    def _compile_filter_expression(
        self,
        qualified: str,
        operator: str,
        value: Any,
    ) -> str:
        if operator == "is_null":
            return f"{qualified} IS NULL"

        if operator == "is_not_null":
            return f"{qualified} IS NOT NULL"

        if operator == "in":
            if not isinstance(
                value,
                list,
            ):
                raise ValueError(
                    "IN filter value must be a list."
                )

            if not value:
                return "FALSE"

            return (
                f"{qualified} IN ("
                + ", ".join(
                    self._sql_literal(item)
                    for item in value
                )
                + ")"
            )

        if operator == "not_in":
            if not isinstance(
                value,
                list,
            ):
                raise ValueError(
                    "NOT_IN filter value must be a list."
                )

            if not value:
                return "TRUE"

            return (
                f"{qualified} NOT IN ("
                + ", ".join(
                    self._sql_literal(item)
                    for item in value
                )
                + ")"
            )

        if operator == "contains":
            return (
                f"{qualified} ILIKE "
                f"{self._sql_literal('%' + str(value) + '%')}"
            )

        if operator == "starts_with":
            return (
                f"{qualified} ILIKE "
                f"{self._sql_literal(str(value) + '%')}"
            )

        if operator == "ends_with":
            return (
                f"{qualified} ILIKE "
                f"{self._sql_literal('%' + str(value))}"
            )

        return (
            f"{qualified} {operator} "
            f"{self._sql_literal(value)}"
        )

    # ------------------------------------------------------------------
    # Runtime bindings
    # ------------------------------------------------------------------

    def _normalize_runtime_bindings(
        self,
        runtime_bindings: dict[str, Any] | None,
    ) -> list[dict[str, Any]]:
        if runtime_bindings is None:
            return []

        if not isinstance(
            runtime_bindings,
            dict,
        ):
            raise ValueError(
                "runtime_bindings must be a dictionary."
            )

        bindings = runtime_bindings.get(
            "bindings",
            [],
        )

        if not isinstance(
            bindings,
            list,
        ):
            raise ValueError(
                "runtime_bindings bindings must be a list."
            )

        normalized: list[dict[str, Any]] = []
        seen_indexes: set[int] = set()

        for binding in bindings:
            if not isinstance(
                binding,
                dict,
            ):
                raise ValueError(
                    "Each runtime binding must be an object."
                )

            index = binding.get(
                "index"
            )

            if (
                isinstance(index, bool)
                or not isinstance(index, int)
                or index < 0
            ):
                raise ValueError(
                    "Runtime binding index must be "
                    "a non-negative integer."
                )

            if index in seen_indexes:
                raise ValueError(
                    f"Duplicate runtime binding index: {index}"
                )

            seen_indexes.add(
                index
            )

            to_table = binding.get(
                "to_table"
            )

            to_column = binding.get(
                "to_column"
            )

            if (
                not isinstance(
                    to_table,
                    str,
                )
                or not to_table.strip()
            ):
                raise ValueError(
                    "Runtime binding to_table must "
                    "be non-empty."
                )

            if (
                not isinstance(
                    to_column,
                    str,
                )
                or not to_column.strip()
            ):
                raise ValueError(
                    "Runtime binding to_column must "
                    "be non-empty."
                )

            operator = str(
                binding.get(
                    "operator",
                    "in",
                )
            ).strip().lower()

            if operator == "eq":
                operator = "equals"

            if operator in {
                "=",
                "==",
            }:
                operator = "equals"

            if operator not in {
                "in",
                "not_in",
                "equals",
            }:
                raise ValueError(
                    "Unsupported runtime binding operator: "
                    f"{operator!r}"
                )

            normalized.append(
                {
                    "index": index,
                    "to_table": self._resolve_table(
                        to_table
                    ),
                    "to_column": self._resolve_column(
                        to_table,
                        to_column,
                    ),
                    "operator": operator,
                }
            )

        return sorted(
            normalized,
            key=lambda value: value["index"],
        )

    def _compile_runtime_bindings(
        self,
        bindings: list[dict[str, Any]],
        selected_tables: list[str],
    ) -> list[str]:
        result: list[str] = []

        for binding in bindings:
            table_name = binding[
                "to_table"
            ]

            column_name = binding[
                "to_column"
            ]

            if table_name not in selected_tables:
                raise ValueError(
                    "Runtime binding target table "
                    f"'{table_name}' is not in the selected query scope."
                )

            qualified = self._qualified_identifier(
                table_name,
                column_name,
            )

            index = binding[
                "index"
            ]

            operator = binding[
                "operator"
            ]

            placeholder = "%s"

            if operator == "in":
                result.append(
                    f"CAST({qualified} AS text) = ANY({placeholder})"
                )

            elif operator == "not_in":
                result.append(
                    f"CAST({qualified} AS text) <> ALL({placeholder})"
                )

            else:
                result.append(
                    f"CAST({qualified} AS text) = {placeholder}"
                )

        return result

    # ------------------------------------------------------------------
    # GROUP BY / ORDER BY
    # ------------------------------------------------------------------

    def _compile_grouping(
        self,
        grouping: Any,
        selected_tables: list[str],
    ) -> list[str]:
        if not grouping:
            return []

        result: list[str] = []

        for field in grouping:
            result.append(
                self._resolve_field_expression(
                    field,
                    selected_tables,
                )
            )

        return list(
            dict.fromkeys(
                result
            )
        )

    def _compile_order_by(
        self,
        sorting: list[str],
        grouping: list[str],
        ranking_query: bool,
    ) -> list[str]:
        """
        Build ORDER BY expressions.

        PostgreSQL DISTINCT ON requires the leading ORDER BY expressions to
        match the DISTINCT ON expressions. For ranking queries, prepend the
        grouping keys, then append the requested sort keys.
        """
        if ranking_query and grouping:
            order_by = [f"{field} ASC" for field in grouping]
            seen = {field.lower() for field in grouping}

            for item in sorting:
                expression = item.rsplit(" ", 1)[0].strip()
                if expression.lower() in seen:
                    continue
                order_by.append(item)
                seen.add(expression.lower())

            return order_by

        return list(sorting)

    def _compile_sorting(
        self,
        sorting: Any,
        selected_tables: list[str],
    ) -> list[str]:
        if not sorting:
            return []

        result: list[str] = []

        for item in sorting:
            if isinstance(
                item,
                str,
            ):
                expression = item.strip()
                direction = "asc"

                parts = expression.split()

                if (
                    len(parts) >= 2
                    and parts[-1].lower()
                    in self.SORT_DIRECTIONS
                ):
                    direction = parts[-1].lower()
                    expression = " ".join(
                        parts[:-1]
                    )

                result.append(
                    f"{self._resolve_field_expression(expression, selected_tables)} "
                    f"{direction.upper()}"
                )
                continue

            if isinstance(
                item,
                dict,
            ):
                field = (
                    item.get("field")
                    or item.get("column")
                )

                if not isinstance(
                    field,
                    str,
                ):
                    raise ValueError(
                        "Sorting field must be a string."
                    )

                direction = str(
                    item.get(
                        "direction",
                        "asc",
                    )
                ).strip().lower()

                if direction not in self.SORT_DIRECTIONS:
                    raise ValueError(
                        f"Unsupported sort direction: "
                        f"{direction!r}"
                    )

                result.append(
                    f"{self._resolve_field_expression(field, selected_tables)} "
                    f"{direction.upper()}"
                )
                continue

            raise ValueError(
                "Each sorting item must be a string or object."
            )

        return result

    # ------------------------------------------------------------------
    # Field resolution
    # ------------------------------------------------------------------

    def _parse_field_reference(
        self,
        reference: Any,
        selected_tables: list[str],
    ) -> tuple[str, str]:
        if not isinstance(
            reference,
            str,
        ) or not reference.strip():
            raise ValueError(
                "Field reference must be a non-empty string."
            )

        value = reference.strip()

        if "." in value:
            table_name, column_name = (
                value.split(
                    ".",
                    1,
                )
            )

            table_name = self._resolve_table(
                table_name
            )

            if table_name not in selected_tables:
                raise ValueError(
                    f"Field references table '{table_name}' "
                    "outside the selected query scope."
                )

            column_name = self._resolve_column(
                table_name,
                column_name,
            )

            return (
                table_name,
                column_name,
            )

        matches: list[
            tuple[str, str]
        ] = []

        for table_name in selected_tables:
            try:
                column_name = self._resolve_column(
                    table_name,
                    value,
                )
            except ValueError:
                continue

            matches.append(
                (
                    table_name,
                    column_name,
                )
            )

        if not matches:
            raise ValueError(
                "Field is not present in the selected "
                f"Context Layer scope: {value!r}"
            )

        if len(matches) > 1:
            raise ValueError(
                "Ambiguous unqualified field reference: "
                f"{value!r}. Use an explicit table.column reference."
            )

        return matches[0]

    def _resolve_field_expression(
        self,
        reference: Any,
        selected_tables: list[str],
    ) -> str:
        table_name, column_name = (
            self._parse_field_reference(
                reference,
                selected_tables,
            )
        )

        return self._qualified_identifier(
            table_name,
            column_name,
        )

    # ------------------------------------------------------------------
    # DISTINCT
    # ------------------------------------------------------------------

    @staticmethod
    def _uses_distinct(
        contract: dict[str, Any],
    ) -> bool:
        operations = {
            str(value).strip().lower()
            for value in contract.get(
                "operations",
                [],
            )
            if isinstance(value, str)
        }

        return (
            "distinct" in operations
            or bool(
                contract.get(
                    "distinct",
                    False,
                )
            )
        )

    # ------------------------------------------------------------------
    # SQL safety / serialization
    # ------------------------------------------------------------------

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

    def _qualified_identifier(
        self,
        table_name: str,
        column_name: str,
    ) -> str:
        return (
            self._quote_identifier(
                table_name
            )
            + "."
            + self._quote_identifier(
                column_name
            )
        )

    @staticmethod
    def _sql_literal(
        value: Any,
    ) -> str:
        """
        Safely serialize a scalar value as a PostgreSQL literal.

        Runtime dependency values are never handled here; those use
        PostgreSQL parameter placeholders.
        """

        if value is None:
            return "NULL"

        if isinstance(
            value,
            bool,
        ):
            return "TRUE" if value else "FALSE"

        if isinstance(
            value,
            (int, float, Decimal),
        ):
            return str(value)

        if isinstance(
            value,
            (datetime, date),
        ):
            return (
                "'"
                + value.isoformat().replace(
                    "'",
                    "''",
                )
                + "'"
            )

        text_value = str(
            value
        )

        return (
            "'"
            + text_value.replace(
                "'",
                "''",
            )
            + "'"
        )

    @staticmethod
    def _normalize_sql(
        query: str,
    ) -> str:
        if not isinstance(
            query,
            str,
        ) or not query.strip():
            raise ValueError(
                "Generated SQL cannot be empty."
            )

        return query.strip()

    @staticmethod
    def _indent_sql(
        query: str,
    ) -> str:
        return "\n".join(
            "    " + line
            for line in query.splitlines()
        )


def generate_sql(
    contract: dict[str, Any],
    source_id: str = "db1",
) -> str:
    """
    Backward-compatible helper.
    """

    generator = SQLGenerator(
        source_id=source_id
    )

    return generator.generate(
        contract=contract,
        source_id=source_id,
    )


if __name__ == "__main__":
    print(
        "Deterministic SQL generator initialized successfully."
    )