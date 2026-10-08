import { settings } from "../config/settings.js";

/**
 * Deep-clone helper for cache isolation.
 */
function deepClone(obj) {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (obj instanceof Date) {
    return new Date(obj.getTime());
  }
  if (Array.isArray(obj)) {
    return obj.map(deepClone);
  }
  const cloned = {};
  for (const [key, value] of Object.entries(obj)) {
    cloned[key] = deepClone(value);
  }
  return cloned;
}

/**
 * Read-only client for the Security/SIEM API.
 *
 * Security properties:
 * - GET requests only.
 * - Bearer token is loaded from environment variables and is never logged.
 * - No API response is written to disk.
 * - Successful responses are cached in memory for a short, configurable TTL
 *   to reduce repeated API calls and rate-limit pressure.
 * - Errors are never cached.
 * - Automatic retries are limited to transient gateway failures (502/503/504)
 *   and never include mutating methods.
 * - User-controlled path components are URL-encoded.
 */
export class SecurityLogClient {
  static DEFAULT_CACHE_TTLS = {
    security_logs: 30,
    security_logs_summary: 60,
    workspace_security_logs: 30,
    workspace_siem_status: 15,
    security_overview: 60,
  };

  constructor() {
    const rawBaseUrl =
      process.env.SECURITY_API_BASE_URL ||
      (settings && settings.securityApiBaseUrl) ||
      "";
    this.base_url = rawBaseUrl.replace(/\/+$/, "");
    this.baseUrl = this.base_url;

    const rawPrefix =
      process.env.SECURITY_API_PREFIX ||
      (settings && settings.securityApiPrefix) ||
      "";
    this.api_prefix = rawPrefix.replace(/^\/+|\/+$/g, "");
    this.apiPrefix = this.api_prefix;

    this.token =
      process.env.SECURITY_API_TOKEN ||
      (settings && settings.securityApiToken) ||
      "";

    const rawWorkspace =
      process.env.SECURITY_WORKSPACE_ID ||
      (settings && settings.securityWorkspaceId) ||
      "";
    this.default_workspace_id = rawWorkspace.trim();
    this.defaultWorkspaceId = this.default_workspace_id;

    // Security Logs is an optional source.
    // The application must still start when the API is unavailable.
    this.available = Boolean(this.base_url && this.token);

    this.timeout_seconds = this._positive_float_env("SECURITY_API_TIMEOUT", 30.0);
    this.timeout = Math.round(this.timeout_seconds * 1000);

    const cacheEnabledRaw = (
      process.env.SECURITY_API_CACHE_ENABLED || "true"
    )
      .trim()
      .toLowerCase();
    this.cache_enabled = ["1", "true", "yes", "on"].includes(cacheEnabledRaw);

    this.cache_max_entries = this._positive_int_env(
      "SECURITY_API_CACHE_MAX_ENTRIES",
      128
    );

    this._cache = new Map();
  }

  // ==================================================
  // Environment helpers
  // ==================================================

  _positive_int_env(name, defaultValue) {
    const raw = (process.env[name] || String(defaultValue)).trim();
    const value = parseInt(raw, 10);
    return !isNaN(value) && value > 0 ? value : defaultValue;
  }

  _positive_float_env(name, defaultValue) {
    const raw = (process.env[name] || String(defaultValue)).trim();
    const value = parseFloat(raw);
    return !isNaN(value) && value > 0 ? value : defaultValue;
  }

  _cache_ttl(key) {
    const envMap = {
      security_logs: "SECURITY_LOGS_CACHE_TTL",
      security_logs_summary: "SECURITY_LOGS_SUMMARY_CACHE_TTL",
      workspace_security_logs: "WORKSPACE_SECURITY_LOGS_CACHE_TTL",
      workspace_siem_status: "WORKSPACE_SIEM_STATUS_CACHE_TTL",
      security_overview: "SECURITY_OVERVIEW_CACHE_TTL",
    };

    const envName = envMap[key];
    const defaultTtl = SecurityLogClient.DEFAULT_CACHE_TTLS[key] || 30;
    const raw = (process.env[envName] || String(defaultTtl)).trim();
    const ttl = parseInt(raw, 10);

    return Math.max(!isNaN(ttl) ? ttl : defaultTtl, 0);
  }

  // ==================================================
  // URL / input helpers
  // ==================================================

  _build_url(path) {
    const parts = [this.base_url];
    if (this.api_prefix) {
      parts.push(this.api_prefix);
    }
    parts.push(path.replace(/^\/+|\/+$/g, ""));
    return parts.join("/");
  }

  _buildUrl(path) {
    return this._build_url(path);
  }

  _validate_limit(limit) {
    if (
      typeof limit === "boolean" ||
      typeof limit !== "number" ||
      !Number.isInteger(limit)
    ) {
      throw new Error("limit must be an integer.");
    }

    let maxLimit = 1000;
    const rawMax = (process.env.SECURITY_API_MAX_LIMIT || "1000").trim();
    const parsedMax = parseInt(rawMax, 10);
    if (!isNaN(parsedMax) && parsedMax > 0) {
      maxLimit = parsedMax;
    }

    if (limit <= 0) {
      throw new Error("limit must be greater than 0.");
    }

    if (limit > maxLimit) {
      throw new Error(`limit must not exceed ${maxLimit}.`);
    }

    return limit;
  }

  _validateLimit(limit) {
    return this._validate_limit(limit);
  }

  _validate_text(value, name, maxLength) {
    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value !== "string") {
      throw new Error(`${name} must be a string or null.`);
    }

    if (value.length > maxLength) {
      throw new Error(`${name} exceeds the maximum allowed length.`);
    }

    return value;
  }

  _validateText(value, name, maxLength) {
    return this._validate_text(value, name, maxLength);
  }

  _resolve_workspace_id(workspaceId) {
    const resolved =
      typeof workspaceId === "string" && workspaceId.trim()
        ? workspaceId.trim()
        : this.default_workspace_id;

    if (!resolved) {
      throw new Error(
        "workspace_id is required. Set SECURITY_WORKSPACE_ID or pass workspace_id explicitly."
      );
    }

    if (resolved.length > 256) {
      throw new Error("workspace_id is too long.");
    }

    return encodeURIComponent(resolved);
  }

  _resolveWorkspaceId(workspaceId) {
    return this._resolve_workspace_id(workspaceId);
  }

  // ==================================================
  // In-memory cache
  // ==================================================

  _cache_key(path, params) {
    const normalizedParams = Object.entries(params || {})
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => [String(k), String(v)])
      .sort((a, b) => a[0].localeCompare(b[0]));

    return JSON.stringify([path, normalizedParams]);
  }

  _cache_get(key) {
    if (!this.cache_enabled) {
      return null;
    }

    const entry = this._cache.get(key);
    if (!entry) {
      return null;
    }

    const now = Date.now();
    if (entry.expires_at <= now) {
      this._cache.delete(key);
      return null;
    }

    // Refresh LRU order
    this._cache.delete(key);
    this._cache.set(key, entry);

    return deepClone(entry.value);
  }

  _cache_set(key, value, ttlSeconds) {
    if (!this.cache_enabled || ttlSeconds <= 0) {
      return;
    }

    const entry = {
      value: deepClone(value),
      expires_at: Date.now() + ttlSeconds * 1000,
    };

    if (this._cache.has(key)) {
      this._cache.delete(key);
    }

    this._cache.set(key, entry);

    while (this._cache.size > this.cache_max_entries) {
      const oldestKey = this._cache.keys().next().value;
      if (oldestKey !== undefined) {
        this._cache.delete(oldestKey);
      } else {
        break;
      }
    }
  }

  clear_cache() {
    this._cache.clear();
  }

  clearCache() {
    this.clear_cache();
  }

  // ==================================================
  // Generic GET with retries
  // ==================================================

  async _get_json(path, { params = null, cache_key_name, force_refresh = false }) {
    if (!this.available) {
      throw new Error(
        "Security Logs source is unavailable. Configure SECURITY_API_BASE_URL and SECURITY_API_TOKEN before requesting security logs."
      );
    }

    const cleanParams = {};
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== null && value !== undefined) {
        cleanParams[key] = value;
      }
    }

    const cacheKey = this._cache_key(path, cleanParams);
    const ttlSeconds = this._cache_ttl(cache_key_name);

    if (!force_refresh) {
      const cached = this._cache_get(cacheKey);
      if (cached !== null) {
        return cached;
      }
    }

    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(cleanParams)) {
      searchParams.append(key, String(value));
    }

    const queryString = searchParams.toString();
    const url = `${this._build_url(path)}${queryString ? `?${queryString}` : ""}`;

    const headers = {
      Accept: "application/json",
    };

    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    // Retries: up to 2 retries for transient 502/503/504 status codes
    const maxRetries = 2;
    let attempt = 0;
    let lastError = null;

    while (attempt <= maxRetries) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);

      try {
        const response = await fetch(url, {
          method: "GET",
          headers,
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!response.ok) {
          // Retry only on transient gateway failures (502, 503, 504)
          if ([502, 503, 504].includes(response.status) && attempt < maxRetries) {
            attempt++;
            const backoffMs = Math.round(500 * Math.pow(2, attempt - 1));
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            continue;
          }

          throw new Error(
            `Security API HTTP ${response.status}: ${response.statusText}`
          );
        }

        const data = await response.json();

        if (!data || typeof data !== "object" || Array.isArray(data)) {
          throw new Error("Security API returned an unexpected response type.");
        }

        this._cache_set(cacheKey, data, ttlSeconds);
        return deepClone(data);
      } catch (err) {
        clearTimeout(timer);

        // Transient network errors may be retried
        if (
          (err.name === "AbortError" || err.message.includes("fetch failed")) &&
          attempt < maxRetries
        ) {
          attempt++;
          const backoffMs = Math.round(500 * Math.pow(2, attempt - 1));
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }

        lastError = err;
        break;
      }
    }

    throw lastError || new Error("Failed to execute request to Security API.");
  }

  // ==================================================
  // API resources -- GET only
  // ==================================================

  /**
   * Retrieve security logs.
   *
   * Supports both positional parameters and an options object.
   */
  async get_security_logs(
    earliestOrOpts = null,
    latest = null,
    limit = 100,
    index = "*",
    sourcetype = null,
    q = null,
    extraOpts = {}
  ) {
    let opts = {};

    if (
      earliestOrOpts &&
      typeof earliestOrOpts === "object" &&
      !Array.isArray(earliestOrOpts)
    ) {
      opts = { ...earliestOrOpts };
    } else {
      opts = {
        earliest: earliestOrOpts,
        latest,
        limit,
        index,
        sourcetype,
        q,
        ...extraOpts,
      };
    }

    const validatedLimit = this._validate_limit(
      opts.limit !== undefined ? opts.limit : 100
    );
    const validatedEarliest = this._validate_text(opts.earliest, "earliest", 256);
    const validatedLatest = this._validate_text(opts.latest, "latest", 256);
    const validatedIndex = this._validate_text(
      opts.index !== undefined ? opts.index : "*",
      "index",
      256
    );
    const validatedSourcetype = this._validate_text(opts.sourcetype, "sourcetype", 512);
    const validatedQ = this._validate_text(opts.q, "q", 4096);

    return this._get_json("cde/security/logs", {
      params: {
        earliest: validatedEarliest,
        latest: validatedLatest,
        limit: validatedLimit,
        index: validatedIndex,
        sourcetype: validatedSourcetype,
        q: validatedQ,
      },
      cache_key_name: "security_logs",
      force_refresh: Boolean(opts.force_refresh || opts.forceRefresh),
    });
  }

  async getSecurityLogs(...args) {
    return this.get_security_logs(...args);
  }

  /**
   * Retrieve aggregated security-log summary.
   */
  async get_security_logs_summary(
    earliestOrOpts = null,
    latest = null,
    index = "*",
    extraOpts = {}
  ) {
    let opts = {};

    if (
      earliestOrOpts &&
      typeof earliestOrOpts === "object" &&
      !Array.isArray(earliestOrOpts)
    ) {
      opts = { ...earliestOrOpts };
    } else {
      opts = {
        earliest: earliestOrOpts,
        latest,
        index,
        ...extraOpts,
      };
    }

    const validatedEarliest = this._validate_text(opts.earliest, "earliest", 256);
    const validatedLatest = this._validate_text(opts.latest, "latest", 256);
    const validatedIndex = this._validate_text(
      opts.index !== undefined ? opts.index : "*",
      "index",
      256
    );

    return this._get_json("cde/security/logs/summary", {
      params: {
        earliest: validatedEarliest,
        latest: validatedLatest,
        index: validatedIndex,
      },
      cache_key_name: "security_logs_summary",
      force_refresh: Boolean(opts.force_refresh || opts.forceRefresh),
    });
  }

  async getSecurityLogsSummary(...args) {
    return this.get_security_logs_summary(...args);
  }

  /**
   * Retrieve security logs scoped to one workspace.
   */
  async get_workspace_security_logs(
    workspaceIdOrOpts = null,
    earliest = null,
    latest = null,
    limit = 100,
    index = "*",
    extraOpts = {}
  ) {
    let opts = {};

    if (
      workspaceIdOrOpts &&
      typeof workspaceIdOrOpts === "object" &&
      !Array.isArray(workspaceIdOrOpts)
    ) {
      opts = { ...workspaceIdOrOpts };
    } else {
      opts = {
        workspace_id: workspaceIdOrOpts,
        earliest,
        latest,
        limit,
        index,
        ...extraOpts,
      };
    }

    const workspaceId = this._resolve_workspace_id(
      opts.workspace_id || opts.workspaceId
    );
    const validatedLimit = this._validate_limit(
      opts.limit !== undefined ? opts.limit : 100
    );
    const validatedEarliest = this._validate_text(opts.earliest, "earliest", 256);
    const validatedLatest = this._validate_text(opts.latest, "latest", 256);
    const validatedIndex = this._validate_text(
      opts.index !== undefined ? opts.index : "*",
      "index",
      256
    );

    return this._get_json(`cde/workspaces/${workspaceId}/security/logs`, {
      params: {
        earliest: validatedEarliest,
        latest: validatedLatest,
        limit: validatedLimit,
        index: validatedIndex,
      },
      cache_key_name: "workspace_security_logs",
      force_refresh: Boolean(opts.force_refresh || opts.forceRefresh),
    });
  }

  async getWorkspaceSecurityLogs(...args) {
    return this.get_workspace_security_logs(...args);
  }

  /**
   * Retrieve workspace SIEM status.
   */
  async get_workspace_siem_status(workspaceIdOrOpts = null, extraOpts = {}) {
    let opts = {};

    if (
      workspaceIdOrOpts &&
      typeof workspaceIdOrOpts === "object" &&
      !Array.isArray(workspaceIdOrOpts)
    ) {
      opts = { ...workspaceIdOrOpts };
    } else {
      opts = {
        workspace_id: workspaceIdOrOpts,
        ...extraOpts,
      };
    }

    const workspaceId = this._resolve_workspace_id(
      opts.workspace_id || opts.workspaceId
    );

    return this._get_json(`cde/workspaces/${workspaceId}/siem-status`, {
      params: {},
      cache_key_name: "workspace_siem_status",
      force_refresh: Boolean(opts.force_refresh || opts.forceRefresh),
    });
  }

  async getWorkspaceSiemStatus(...args) {
    return this.get_workspace_siem_status(...args);
  }

  /**
   * Retrieve the admin security overview.
   */
  async get_security_overview(opts = {}) {
    return this._get_json("cde/security/overview", {
      params: {},
      cache_key_name: "security_overview",
      force_refresh: Boolean(opts.force_refresh || opts.forceRefresh),
    });
  }

  async getSecurityOverview(opts = {}) {
    return this.get_security_overview(opts);
  }
}

export default {
  SecurityLogClient,
};
