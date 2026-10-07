from __future__ import annotations

import copy
import os
import time
from collections import OrderedDict
from dataclasses import dataclass
from threading import RLock
from typing import Any
from urllib.parse import quote

import requests
from dotenv import load_dotenv
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


load_dotenv()


@dataclass
class _CacheEntry:
    value: dict[str, Any]
    expires_at: float


class SecurityLogClient:
    """
    Read-only client for the Security/SIEM API.

    Security properties:
    - GET requests only.
    - Bearer token is loaded from environment variables and is never logged.
    - No API response is written to disk.
    - Successful responses are cached in memory for a short, configurable TTL
      to reduce repeated API calls and rate-limit pressure.
    - Errors are never cached.
    - Automatic retries are limited to transient gateway failures (502/503/504)
      and never include mutating methods.
    - User-controlled path components are URL-encoded.
    """

    DEFAULT_CACHE_TTLS = {
        "security_logs": 30,
        "security_logs_summary": 60,
        "workspace_security_logs": 30,
        "workspace_siem_status": 15,
        "security_overview": 60,
    }

    def __init__(self):
        self.base_url = os.getenv(
            "SECURITY_API_BASE_URL",
            "",
        ).rstrip("/")

        self.api_prefix = os.getenv(
            "SECURITY_API_PREFIX",
            "",
        ).strip("/")

        self.token = os.getenv(
            "SECURITY_API_TOKEN",
            "",
        )

        self.default_workspace_id = os.getenv(
            "SECURITY_WORKSPACE_ID",
            "",
        ).strip()

        # Security Logs is an optional source.
        # The application must still start when the API is unavailable.
        self.available = bool(
            self.base_url and self.token
        )

        self.timeout = self._positive_float_env(
            "SECURITY_API_TIMEOUT",
            30.0,
        )

        self.cache_enabled = os.getenv(
            "SECURITY_API_CACHE_ENABLED",
            "true",
        ).strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }

        self.cache_max_entries = self._positive_int_env(
            "SECURITY_API_CACHE_MAX_ENTRIES",
            128,
        )

        self._cache: OrderedDict[
            tuple[Any, ...],
            _CacheEntry,
        ] = OrderedDict()

        self._cache_lock = RLock()

        self.session = requests.Session()

        # Only configure authentication when credentials exist.
        if self.token:
            self.session.headers.update(
                {
                    "Authorization": f"Bearer {self.token}",
                    "Accept": "application/json",
                }
            )
        else:
            self.session.headers.update(
                {
                    "Accept": "application/json",
                }
            )

        # Retry only transient GET failures.
        #
        # Do NOT retry:
        # - 401
        # - 403
        # - 429
        #
        # This avoids unnecessary API traffic and avoids hiding
        # authentication/rate-limit problems.
        retry = Retry(
            total=2,
            connect=2,
            read=2,
            status=2,
            backoff_factor=0.5,
            status_forcelist=(
                502,
                503,
                504,
            ),
            allowed_methods=frozenset({"GET"}),
            respect_retry_after_header=True,
            raise_on_status=False,
        )

        adapter = HTTPAdapter(
            max_retries=retry,
        )

        self.session.mount(
            "https://",
            adapter,
        )

        self.session.mount(
            "http://",
            adapter,
        )

    # ==================================================
    # Environment helpers
    # ==================================================

    @staticmethod
    def _positive_int_env(
        name: str,
        default: int,
    ) -> int:
        raw = os.getenv(
            name,
            str(default),
        ).strip()

        try:
            value = int(raw)
        except ValueError:
            return default

        return value if value > 0 else default

    @staticmethod
    def _positive_float_env(
        name: str,
        default: float,
    ) -> float:
        raw = os.getenv(
            name,
            str(default),
        ).strip()

        try:
            value = float(raw)
        except ValueError:
            return default

        return value if value > 0 else default

    def _cache_ttl(
        self,
        key: str,
    ) -> int:

        env_name = {
            "security_logs": (
                "SECURITY_LOGS_CACHE_TTL"
            ),
            "security_logs_summary": (
                "SECURITY_LOGS_SUMMARY_CACHE_TTL"
            ),
            "workspace_security_logs": (
                "WORKSPACE_SECURITY_LOGS_CACHE_TTL"
            ),
            "workspace_siem_status": (
                "WORKSPACE_SIEM_STATUS_CACHE_TTL"
            ),
            "security_overview": (
                "SECURITY_OVERVIEW_CACHE_TTL"
            ),
        }[key]

        raw = os.getenv(
            env_name,
            str(self.DEFAULT_CACHE_TTLS[key]),
        ).strip()

        try:
            ttl = int(raw)
        except ValueError:
            ttl = self.DEFAULT_CACHE_TTLS[key]

        return max(ttl, 0)

    # ==================================================
    # URL / input helpers
    # ==================================================

    def _build_url(
        self,
        path: str,
    ) -> str:

        parts = [
            self.base_url,
        ]

        if self.api_prefix:
            parts.append(
                self.api_prefix
            )

        parts.append(
            path.strip("/")
        )

        return "/".join(parts)

    @staticmethod
    def _validate_limit(
        limit: int,
    ) -> int:

        if isinstance(limit, bool) or not isinstance(
            limit,
            int,
        ):
            raise ValueError(
                "limit must be an integer."
            )

        max_limit = 1000

        raw_max = os.getenv(
            "SECURITY_API_MAX_LIMIT",
            "1000",
        ).strip()

        try:
            max_limit = max(
                int(raw_max),
                1,
            )
        except ValueError:
            pass

        if limit <= 0:
            raise ValueError(
                "limit must be greater than 0."
            )

        if limit > max_limit:
            raise ValueError(
                f"limit must not exceed {max_limit}."
            )

        return limit

    @staticmethod
    def _validate_text(
        value: str | None,
        name: str,
        max_length: int,
    ) -> str | None:

        if value is None:
            return None

        if not isinstance(
            value,
            str,
        ):
            raise ValueError(
                f"{name} must be a string or null."
            )

        if len(value) > max_length:
            raise ValueError(
                f"{name} exceeds the maximum allowed length."
            )

        return value

    def _resolve_workspace_id(
        self,
        workspace_id: str | None,
    ) -> str:

        resolved = (
            workspace_id.strip()
            if (
                isinstance(
                    workspace_id,
                    str,
                )
                and workspace_id.strip()
            )
            else self.default_workspace_id
        )

        if not resolved:
            raise ValueError(
                "workspace_id is required. "
                "Set SECURITY_WORKSPACE_ID "
                "or pass workspace_id explicitly."
            )

        if len(resolved) > 256:
            raise ValueError(
                "workspace_id is too long."
            )

        # Encode the complete path segment so a workspace ID
        # cannot inject path separators or query-string characters.
        return quote(
            resolved,
            safe="",
        )

    # ==================================================
    # In-memory cache
    # ==================================================

    def _cache_key(
        self,
        path: str,
        params: dict[str, Any] | None,
    ) -> tuple[Any, ...]:

        normalized_params = tuple(
            sorted(
                (
                    str(key),
                    str(value),
                )
                for key, value in (
                    params or {}
                ).items()
                if value is not None
            )
        )

        return (
            path,
            normalized_params,
        )

    def _cache_get(
        self,
        key: tuple[Any, ...],
    ) -> dict[str, Any] | None:

        if not self.cache_enabled:
            return None

        now = time.monotonic()

        with self._cache_lock:

            entry = self._cache.get(
                key
            )

            if entry is None:
                return None

            if entry.expires_at <= now:
                self._cache.pop(
                    key,
                    None,
                )

                return None

            self._cache.move_to_end(
                key
            )

            return copy.deepcopy(
                entry.value
            )

    def _cache_set(
        self,
        key: tuple[Any, ...],
        value: dict[str, Any],
        ttl_seconds: int,
    ) -> None:

        if (
            not self.cache_enabled
            or ttl_seconds <= 0
        ):
            return

        with self._cache_lock:

            self._cache[key] = _CacheEntry(
                value=copy.deepcopy(
                    value
                ),
                expires_at=(
                    time.monotonic()
                    + ttl_seconds
                ),
            )

            self._cache.move_to_end(
                key
            )

            while len(
                self._cache
            ) > self.cache_max_entries:

                self._cache.popitem(
                    last=False
                )

    def clear_cache(self) -> None:
        """
        Clear all in-memory cached API responses.
        """

        with self._cache_lock:
            self._cache.clear()

    # ==================================================
    # Generic GET
    # ==================================================

    def _get_json(
        self,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        cache_key_name: str,
        force_refresh: bool = False,
    ) -> dict[str, Any]:

        if not self.available:
            raise RuntimeError(
                "Security Logs source is unavailable. "
                "Configure SECURITY_API_BASE_URL and "
                "SECURITY_API_TOKEN before requesting security logs."
            )

        clean_params = {
            key: value
            for key, value in (
                params or {}
            ).items()
            if value is not None
        }

        cache_key = self._cache_key(
            path,
            clean_params,
        )

        ttl_seconds = self._cache_ttl(
            cache_key_name
        )

        if not force_refresh:

            cached = self._cache_get(
                cache_key
            )

            if cached is not None:
                return cached

        response = self.session.get(
            self._build_url(path),
            params=clean_params,
            timeout=self.timeout,
        )

        # Never cache failed requests.
        response.raise_for_status()

        data = response.json()

        if not isinstance(
            data,
            dict,
        ):
            raise ValueError(
                "Security API returned an unexpected response type."
            )

        self._cache_set(
            cache_key,
            data,
            ttl_seconds,
        )

        return copy.deepcopy(
            data
        )

    # ==================================================
    # API resources -- GET only
    # ==================================================

    def get_security_logs(
        self,
        earliest: str | None = None,
        latest: str | None = None,
        limit: int = 100,
        index: str = "*",
        sourcetype: str | None = None,
        q: str | None = None,
        *,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        """
        Retrieve security logs.

        This also supports the CLI/Git/Shell audit-log use case
        through the optional sourcetype and q filters.
        """

        limit = self._validate_limit(
            limit
        )

        earliest = self._validate_text(
            earliest,
            "earliest",
            256,
        )

        latest = self._validate_text(
            latest,
            "latest",
            256,
        )

        index = self._validate_text(
            index,
            "index",
            256,
        )

        sourcetype = self._validate_text(
            sourcetype,
            "sourcetype",
            512,
        )

        q = self._validate_text(
            q,
            "q",
            4096,
        )

        return self._get_json(
            "cde/security/logs",
            params={
                "earliest": earliest,
                "latest": latest,
                "limit": limit,
                "index": index,
                "sourcetype": sourcetype,
                "q": q,
            },
            cache_key_name="security_logs",
            force_refresh=force_refresh,
        )

    def get_security_logs_summary(
        self,
        earliest: str | None = None,
        latest: str | None = None,
        index: str = "*",
        *,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        """
        Retrieve aggregated security-log summary.
        """

        earliest = self._validate_text(
            earliest,
            "earliest",
            256,
        )

        latest = self._validate_text(
            latest,
            "latest",
            256,
        )

        index = self._validate_text(
            index,
            "index",
            256,
        )

        return self._get_json(
            "cde/security/logs/summary",
            params={
                "earliest": earliest,
                "latest": latest,
                "index": index,
            },
            cache_key_name="security_logs_summary",
            force_refresh=force_refresh,
        )

    def get_workspace_security_logs(
        self,
        workspace_id: str | None = None,
        earliest: str | None = None,
        latest: str | None = None,
        limit: int = 100,
        index: str = "*",
        *,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        """
        Retrieve security logs scoped to one workspace.
        """

        workspace_id = self._resolve_workspace_id(
            workspace_id
        )

        limit = self._validate_limit(
            limit
        )

        earliest = self._validate_text(
            earliest,
            "earliest",
            256,
        )

        latest = self._validate_text(
            latest,
            "latest",
            256,
        )

        index = self._validate_text(
            index,
            "index",
            256,
        )

        return self._get_json(
            (
                "cde/workspaces/"
                f"{workspace_id}/security/logs"
            ),
            params={
                "earliest": earliest,
                "latest": latest,
                "limit": limit,
                "index": index,
            },
            cache_key_name=(
                "workspace_security_logs"
            ),
            force_refresh=force_refresh,
        )

    def get_workspace_siem_status(
        self,
        workspace_id: str | None = None,
        *,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        """
        Retrieve workspace SIEM status.
        """

        workspace_id = self._resolve_workspace_id(
            workspace_id
        )

        return self._get_json(
            (
                "cde/workspaces/"
                f"{workspace_id}/siem-status"
            ),
            cache_key_name=(
                "workspace_siem_status"
            ),
            force_refresh=force_refresh,
        )

    def get_security_overview(
        self,
        *,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        """
        Retrieve the admin security overview.
        """

        return self._get_json(
            "cde/security/overview",
            cache_key_name=(
                "security_overview"
            ),
            force_refresh=force_refresh,
        )