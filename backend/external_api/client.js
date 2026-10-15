import { getApprovedOperation } from "./openapi.js";

export class ExternalApiClient {
  constructor(config, context, fetchImpl = fetch) { this.config = config; this.context = context; this.fetch = fetchImpl; }
  async retrieve(operationId, query = {}) {
    const operation = getApprovedOperation(this.context, operationId);
    const allowed = new Map(operation.parameters.map(parameter => [parameter.name, parameter]));
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query || {})) {
      if (!allowed.has(key) || value === undefined || value === null) throw new Error("External API request contains an unapproved parameter.");
      if (String(value).length > 256) throw new Error("External API parameter is too long.");
      params.set(key, String(value));
    }
    const url = new URL(operation.path, `${this.config.baseUrl}/`);
    if (url.origin !== new URL(this.config.baseUrl).origin || url.protocol !== "https:") throw new Error("External API operation escaped its approved origin.");
    url.search = params.toString();
    const headers = { Accept: "application/json" };
    if (this.config.auth.type === "bearer_env") {
      const secret = process.env[this.config.auth.secretEnv];
      if (!secret) throw new Error("External API credential reference is unavailable.");
      headers.Authorization = `Bearer ${secret}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      let response;
      let lastError;
      for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
        try {
          response = await this.fetch(url, { method: "GET", headers, redirect: "error", signal: controller.signal });
          if (response.ok || ![408, 429, 502, 503, 504].includes(response.status) || attempt === this.config.maxRetries) break;
        } catch (error) {
          lastError = error;
          if (attempt === this.config.maxRetries) throw error;
        }
      }
      if (!response) throw lastError || new Error("External API request did not return a response.");
      if (!response.ok) throw new Error(`External API HTTP ${response.status}.`);
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > 2_000_000) throw new Error("External API response exceeds the approved size limit.");
      const body = await response.text();
      if (Buffer.byteLength(body, "utf8") > 2_000_000) throw new Error("External API response exceeds the approved size limit.");
      let data;
      try { data = JSON.parse(body); } catch { throw new Error("External API returned invalid JSON."); }
      const rawRows = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : [data]);
      if (!rawRows.every(row => row && typeof row === "object" && !Array.isArray(row))) throw new Error("External API response does not match its approved object schema.");
      const columns = operation.response_fields.map(field => field.name);
      // Never allow undeclared response fields (including sensitive fields not
      // admitted during discovery) into evidence, prompts, or diagnostics.
      const rows = rawRows.map(row => Object.fromEntries(columns.filter(column => Object.hasOwn(row, column)).map(column => [column, row[column]])));
      return { rows: rows.slice(0, this.config.maxResults), row_count: Math.min(rows.length, this.config.maxResults), columns, truncated: rows.length > this.config.maxResults, provenance: { source_type: "external_api", source_id: this.config.id, operation_id: operation.operation_id, path: operation.path } };
    } finally { clearTimeout(timer); }
  }
}
