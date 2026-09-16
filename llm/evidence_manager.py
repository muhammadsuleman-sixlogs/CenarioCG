from typing import Any


class EvidenceManager:
    """
    Prepare and truncate retrieved evidence to fit safely within LLM prompts.
    """

    def __init__(self, max_rows: int = 50):
        self.max_rows = max_rows

    def prepare(
        self,
        retrieval: dict[str, Any],
        sources: list[dict[str, Any]],
    ) -> dict[str, Any]:

        if not isinstance(retrieval, dict):
            raise ValueError("Retrieval result must be a dictionary.")

        if not isinstance(sources, list):
            raise ValueError("Sources must be a list.")

        rows = retrieval.get("rows", [])
        columns = retrieval.get("columns", [])

        limited_rows = rows[: self.max_rows] if isinstance(rows, list) else []

        limited_sources = []
        for source in sources:
            source_copy = dict(source)
            source_rows = source_copy.get("rows", [])

            if isinstance(source_rows, list):
                source_copy["rows"] = source_rows[: self.max_rows]

            limited_sources.append(source_copy)

        return {
            "rows": limited_rows,
            "columns": columns,
            "row_count": len(limited_rows),
            "total_retrieved": len(rows) if isinstance(rows, list) else 0,
            "truncated": len(rows) > self.max_rows if isinstance(rows, list) else False,
            "sources": limited_sources,
        }