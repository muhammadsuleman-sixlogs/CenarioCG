import re
from typing import Any


TABLE_PATTERN = re.compile(
    r"""
    \bFROM\s+"?([A-Za-z_][A-Za-z0-9_]*)"? |
    \bJOIN\s+"?([A-Za-z_][A-Za-z0-9_]*)"? |
    \bUPDATE\s+"?([A-Za-z_][A-Za-z0-9_]*)"? |
    \bINTO\s+"?([A-Za-z_][A-Za-z0-9_]*)"? 
    """,
    re.IGNORECASE | re.VERBOSE,
)

COLUMN_PATTERN = re.compile(
    r"""
    \bSELECT\s+(.*?)\s+
    \bFROM\b
    """,
    re.IGNORECASE | re.DOTALL | re.VERBOSE,
)


class SourceTracker:
    """
    Track dynamic provenance for retrieved data.

    The tracker derives table/entity and column information
    from the retrieval contract and generated SQL.

    It does not access or modify PostgreSQL.
    It does not make any LLM/API calls.
    """

    def _extract_tables_from_sql(
        self,
        query: str,
    ) -> list[str]:

        matches = TABLE_PATTERN.findall(query)

        tables = []

        for match in matches:
            table = match[0] or match[1] or match[2] or match[3]

            if table and table not in tables:
                tables.append(table)

        return tables

    def _extract_columns_from_sql(
        self,
        query: str,
    ) -> list[str]:

        matches = COLUMN_PATTERN.findall(query)

        columns = []

        for select_section in matches:

            parts = select_section.split(",")

            for part in parts:

                expression = part.strip()

                if not expression:
                    continue

                # Remove aliases.
                expression = re.sub(
                    r"\s+AS\s+[\w\"]+$",
                    "",
                    expression,
                    flags=re.IGNORECASE,
                ).strip()

                # Ignore SELECT *.
                if expression == "*":
                    continue

                if expression not in columns:
                    columns.append(expression)

        return columns

    def build_source(
        self,
        query: str,
        retrieval: dict[str, Any],
        contract: dict[str, Any] | None = None,
    ) -> dict[str, Any]:

        if not query or not query.strip():
            raise ValueError("Query cannot be empty.")

        if not isinstance(retrieval, dict):
            raise ValueError(
                "Retrieval result must be a dictionary."
            )

        rows = retrieval.get("rows", [])
        columns = retrieval.get("columns", [])

        tables = self._extract_tables_from_sql(query)
        sql_columns = self._extract_columns_from_sql(query)

        # Prefer validated contract information when available.
        contract_tables = []

        if contract:
            contract_tables = contract.get(
                "required_tables",
                [],
            )

        entities = list(dict.fromkeys(
            contract_tables + tables
        ))

        return {
            "source_type": "postgresql",
            "source": "postgresql",
            "entities": entities,
            "tables": tables,
            "columns": columns,
            "sql_columns": sql_columns,
            "query": query,
            "row_count": len(rows),
            "rows": rows,
        }

    def build_sources(
        self,
        query: str,
        retrieval: dict[str, Any],
        contract: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:

        source = self.build_source(
            query=query,
            retrieval=retrieval,
            contract=contract,
        )

        return [source]