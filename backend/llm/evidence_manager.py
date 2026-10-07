from __future__ import annotations

from typing import Any


class EvidenceManager:
    """
    Prepare and bound retrieved evidence before it is sent
    to the LLM.

    Supports:
    - PostgreSQL rows
    - Security/SIEM event resources
    - Security/SIEM structured resources
    - Source/provenance metadata

    This class does not access or modify any data source.
    """

    EVENT_RESOURCES = {
        "security_logs",
        "cli_audit_logs",
        "workspace_security_logs",
    }

    STRUCTURED_RESOURCES = {
        "security_logs_summary",
        "workspace_siem_status",
        "security_overview",
    }

    def __init__(
        self,
        max_rows: int = 50,
        max_events: int = 50,
        max_structured_items: int = 50,
    ):
        if not isinstance(max_rows, int) or max_rows < 1:
            raise ValueError(
                "max_rows must be a positive integer."
            )

        if not isinstance(max_events, int) or max_events < 1:
            raise ValueError(
                "max_events must be a positive integer."
            )

        if (
            not isinstance(max_structured_items, int)
            or max_structured_items < 1
        ):
            raise ValueError(
                "max_structured_items must be a positive integer."
            )

        self.max_rows = max_rows
        self.max_events = max_events
        self.max_structured_items = max_structured_items

    # --------------------------------------------------
    # PostgreSQL
    # --------------------------------------------------

    def _prepare_postgresql_evidence(
        self,
        retrieval: dict[str, Any],
        sources: list[dict[str, Any]],
    ) -> dict[str, Any]:
        rows = retrieval.get("rows", [])
        columns = retrieval.get("columns", [])

        if not isinstance(rows, list):
            rows = []

        if not isinstance(columns, list):
            columns = []

        limited_rows = rows[: self.max_rows]

        limited_sources = []

        for source in sources:
            if not isinstance(source, dict):
                continue

            source_copy = dict(source)

            source_rows = source_copy.get(
                "rows",
                [],
            )

            if isinstance(source_rows, list):
                source_copy["rows"] = (
                    source_rows[: self.max_rows]
                )

            limited_sources.append(source_copy)

        return {
            "source_type": "postgresql",
            "rows": limited_rows,
            "columns": columns,
            "row_count": len(limited_rows),
            "total_retrieved": len(rows),
            "truncated": len(rows) > self.max_rows,
            "sources": limited_sources,
        }

    # --------------------------------------------------
    # Security event resources
    # --------------------------------------------------

    def _prepare_security_event_evidence(
        self,
        retrieval: dict[str, Any],
        sources: list[dict[str, Any]],
        resource: str,
    ) -> dict[str, Any]:
        events = retrieval.get("events", [])

        if not isinstance(events, list):
            events = []

        limited_events = events[: self.max_events]

        limited_sources = []

        for source in sources:
            if not isinstance(source, dict):
                continue

            source_copy = dict(source)

            source_events = source_copy.get(
                "events",
                [],
            )

            if isinstance(source_events, list):
                source_copy["events"] = (
                    source_events[: self.max_events]
                )

            limited_sources.append(source_copy)

        return {
            "source_type": "security_logs_api",
            "resource": resource,
            "events": limited_events,
            "event_count": len(limited_events),
            "total_retrieved": len(events),
            "truncated": len(events) > self.max_events,
            "sources": limited_sources,
        }

    # --------------------------------------------------
    # Security structured resources
    # --------------------------------------------------

    def _bound_structured_data(
        self,
        value: Any,
    ) -> Any:
        """
        Bound structured API data without assuming a fixed
        response schema.

        Unknown fields are preserved.
        """

        if isinstance(value, dict):
            items = list(value.items())[
                : self.max_structured_items
            ]

            return {
                str(key): self._bound_structured_data(item)
                for key, item in items
            }

        if isinstance(value, list):
            return [
                self._bound_structured_data(item)
                for item in value[: self.max_structured_items]
            ]

        return value

    def _prepare_security_structured_evidence(
        self,
        retrieval: dict[str, Any],
        sources: list[dict[str, Any]],
        resource: str,
    ) -> dict[str, Any]:
        data = retrieval.get("data")

        bounded_data = self._bound_structured_data(
            data
        )

        limited_sources = []

        for source in sources:
            if not isinstance(source, dict):
                continue

            source_copy = dict(source)

            if "data" in source_copy:
                source_copy["data"] = (
                    self._bound_structured_data(
                        source_copy["data"]
                    )
                )

            limited_sources.append(source_copy)

        return {
            "source_type": "security_logs_api",
            "resource": resource,
            "data": bounded_data,
            "sources": limited_sources,
        }

    # --------------------------------------------------
    # Main entry point
    # --------------------------------------------------

    def prepare(
        self,
        retrieval: dict[str, Any],
        sources: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """
        Prepare one source's retrieved evidence.

        PostgreSQL retrieval:
            rows / columns

        Security event resources:
            events

        Security structured resources:
            data
        """

        if not isinstance(retrieval, dict):
            raise ValueError(
                "Retrieval result must be a dictionary."
            )

        if not isinstance(sources, list):
            raise ValueError(
                "Sources must be a list."
            )

        source_type = retrieval.get(
            "source_type"
        )

        if source_type == "security_logs_api":
            resource = retrieval.get(
                "resource",
                "security_logs",
            )

            if resource in self.EVENT_RESOURCES:
                return self._prepare_security_event_evidence(
                    retrieval=retrieval,
                    sources=sources,
                    resource=resource,
                )

            if resource in self.STRUCTURED_RESOURCES:
                return self._prepare_security_structured_evidence(
                    retrieval=retrieval,
                    sources=sources,
                    resource=resource,
                )

            raise ValueError(
                "Unsupported security resource: "
                f"{resource!r}"
            )

        return self._prepare_postgresql_evidence(
            retrieval=retrieval,
            sources=sources,
        )