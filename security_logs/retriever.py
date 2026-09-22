from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from security_logs.client import SecurityLogClient


class SecurityLogRetriever:
    """
    Read-only retrieval and normalization layer for the SIEM source.

    This class does not construct URLs or handle authentication.  Those
    responsibilities stay inside SecurityLogClient.
    """

    SOURCE_TYPE = "security_logs_api"
    SOURCE_ID = "security_logs"
    SOURCE_NAME = "siem_security_logs"

    def __init__(
        self,
        client: SecurityLogClient | None = None,
    ):
        self.client = client or SecurityLogClient()

    @staticmethod
    def _now_iso() -> str:
        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _extract_events(response: dict[str, Any]) -> list[Any]:
        """
        Extract event records from the known security-log response shape.

        Current API shape is data.events.  A top-level events fallback is kept
        for small response-shape variations without inventing field names.
        """

        data = response.get("data")

        if isinstance(data, dict):
            events = data.get("events", [])
            if isinstance(events, list):
                return events

        events = response.get("events", [])
        if isinstance(events, list):
            return events

        return []

    @staticmethod
    def _extract_data(response: dict[str, Any]) -> Any:
        """Return the API's data payload without reshaping unknown fields."""

        if "data" in response:
            return response.get("data")

        return response

    def _source_metadata(
        self,
        *,
        resource: str,
        retrieved_at: str,
        workspace_id: str | None = None,
    ) -> dict[str, Any]:
        metadata = {
            "source_type": self.SOURCE_TYPE,
            "source_id": self.SOURCE_ID,
            "source": self.SOURCE_NAME,
            "resource": resource,
            "retrieved_at": retrieved_at,
        }

        if workspace_id:
            metadata["workspace_id"] = workspace_id

        return metadata

    # --------------------------------------------------
    # Existing security logs retrieval
    # --------------------------------------------------

    def retrieve(
        self,
        earliest: str | None = "-7d",
        latest: str | None = "now",
        limit: int = 100,
        index: str = "*",
        *,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        """Retrieve general security logs."""

        response = self.client.get_security_logs(
            earliest=earliest,
            latest=latest,
            limit=limit,
            index=index,
            force_refresh=force_refresh,
        )

        events = self._extract_events(response)
        retrieved_at = self._now_iso()

        result = self._source_metadata(
            resource="security_logs",
            retrieved_at=retrieved_at,
        )
        result.update(
            {
                "events": events,
                "event_count": len(events),
                "earliest": earliest,
                "latest": latest,
                "index": index,
            }
        )

        return result

    # --------------------------------------------------
    # CLI / Git / Shell audit logs
    # --------------------------------------------------

    def retrieve_cli_audit_logs(
        self,
        sourcetype: str | None = None,
        q: str | None = None,
        earliest: str | None = "-24h",
        latest: str | None = "now",
        limit: int = 100,
        index: str = "cenario_security",
        *,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        """Retrieve CLI audit logs using the existing security-log endpoint."""

        response = self.client.get_security_logs(
            earliest=earliest,
            latest=latest,
            limit=limit,
            index=index,
            sourcetype=sourcetype,
            q=q,
            force_refresh=force_refresh,
        )

        events = self._extract_events(response)
        retrieved_at = self._now_iso()

        result = self._source_metadata(
            resource="cli_audit_logs",
            retrieved_at=retrieved_at,
        )
        result.update(
            {
                "events": events,
                "event_count": len(events),
                "earliest": earliest,
                "latest": latest,
                "limit": limit,
                "index": index,
                "sourcetype": sourcetype,
                "query": q,
            }
        )

        return result

    # --------------------------------------------------
    # Security log summary
    # --------------------------------------------------

    def retrieve_security_logs_summary(
        self,
        earliest: str | None = "-24h",
        latest: str | None = "now",
        index: str = "*",
        *,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        """Retrieve the security-log summary without inventing a schema."""

        response = self.client.get_security_logs_summary(
            earliest=earliest,
            latest=latest,
            index=index,
            force_refresh=force_refresh,
        )

        retrieved_at = self._now_iso()

        result = self._source_metadata(
            resource="security_logs_summary",
            retrieved_at=retrieved_at,
        )
        result.update(
            {
                "data": self._extract_data(response),
                "earliest": earliest,
                "latest": latest,
                "index": index,
            }
        )

        return result

    # --------------------------------------------------
    # Workspace security logs
    # --------------------------------------------------

    def retrieve_workspace_security_logs(
        self,
        workspace_id: str,
        earliest: str | None = "-24h",
        latest: str | None = "now",
        limit: int = 100,
        index: str = "*",
        *,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        """Retrieve logs belonging to one workspace."""

        response = self.client.get_workspace_security_logs(
            workspace_id=workspace_id,
            earliest=earliest,
            latest=latest,
            limit=limit,
            index=index,
            force_refresh=force_refresh,
        )

        events = self._extract_events(response)
        retrieved_at = self._now_iso()

        result = self._source_metadata(
            resource="workspace_security_logs",
            retrieved_at=retrieved_at,
            workspace_id=workspace_id,
        )
        result.update(
            {
                "events": events,
                "event_count": len(events),
                "earliest": earliest,
                "latest": latest,
                "limit": limit,
                "index": index,
            }
        )

        return result

    # --------------------------------------------------
    # Workspace SIEM status
    # --------------------------------------------------

    def retrieve_workspace_siem_status(
        self,
        workspace_id: str,
        *,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        """Retrieve SIEM status for one workspace."""

        response = self.client.get_workspace_siem_status(
            workspace_id=workspace_id,
            force_refresh=force_refresh,
        )

        retrieved_at = self._now_iso()

        result = self._source_metadata(
            resource="workspace_siem_status",
            retrieved_at=retrieved_at,
            workspace_id=workspace_id,
        )
        result["data"] = self._extract_data(response)

        return result

    # --------------------------------------------------
    # Admin security overview
    # --------------------------------------------------

    def retrieve_security_overview(
        self,
        *,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        """Retrieve the admin security overview."""

        response = self.client.get_security_overview(
            force_refresh=force_refresh,
        )

        retrieved_at = self._now_iso()

        result = self._source_metadata(
            resource="security_overview",
            retrieved_at=retrieved_at,
        )
        result["data"] = self._extract_data(response)

        return result

    # --------------------------------------------------
    # Cache control
    # --------------------------------------------------

    def clear_cache(self) -> None:
        """Clear cached SIEM responses for this process."""
        self.client.clear_cache()
