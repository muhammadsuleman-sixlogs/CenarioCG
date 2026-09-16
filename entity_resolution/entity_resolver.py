from typing import Any

from database.connection import get_connection
from database.readonly_guard import validate_read_only_query
from context.context_store import load_context


class EntityResolver:
    """
    Resolve natural-language entity references using the
    automatically discovered database schema.

    PostgreSQL is strictly read-only.
    No table or column names are hardcoded.
    """

    def __init__(self, context: dict[str, Any] | None = None):
        self.context = (
            context
            if context is not None
            else load_context()
        )

    def _get_candidate_columns(self) -> list[dict[str, str]]:
        candidates = []

        identifier_hints = (
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

        for table_name, table_info in self.context.get("tables", {}).items():
            primary_keys = {
                str(pk).lower()
                for pk in table_info.get("primary_keys", [])
            }

            for column in table_info.get("columns", []):
                column_name = column["name"]
                column_lower = column_name.lower()

                is_primary_key = column_lower in primary_keys
                has_identifier_hint = any(
                    hint in column_lower
                    for hint in identifier_hints
                )

                if is_primary_key or has_identifier_hint:
                    candidates.append(
                        {
                            "table": table_name,
                            "column": column_name,
                        }
                    )

        return candidates

    def resolve(
        self,
        search_text: str,
        limit: int = 5,
    ) -> list[dict[str, Any]]:
        """
        Resolve a natural-language entity reference.

        Searches dynamically discovered candidate columns.
        """

        if not search_text or not search_text.strip():
            return []

        search_text = search_text.strip()

        candidate_columns = self._get_candidate_columns()

        if not candidate_columns:
            return []

        connection = get_connection()

        candidates = []

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

                        if value is None:
                            continue

                        value_text = str(value)

                        value_lower = value_text.lower()
                        search_lower = search_text.lower()

                        if value_lower == search_lower:
                            confidence = 1.0
                            match_type = "exact"

                        elif value_lower.startswith(
                            search_lower
                        ):
                            confidence = 0.90
                            match_type = "prefix"

                        else:
                            confidence = 0.70
                            match_type = "partial"

                        candidates.append(
                            {
                                "entity_type": table_name,
                                "entity_table": table_name,
                                "entity_column": column_name,
                                "value": value_text,
                                "confidence": confidence,
                                "match_type": match_type,
                                "evidence": (
                                    f"{table_name}."
                                    f"{column_name}"
                                ),
                            }
                        )

        finally:
            connection.close()

        candidates.sort(
            key=lambda item: item["confidence"],
            reverse=True,
        )

        return candidates[:limit]