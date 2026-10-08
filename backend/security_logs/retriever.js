import { SecurityLogClient } from "./client.js";

/**
 * Read-only retrieval and normalization layer for the SIEM source.
 *
 * This class does not construct URLs or handle authentication. Those
 * responsibilities stay inside SecurityLogClient.
 */
export class SecurityLogRetriever {
  static SOURCE_TYPE = "security_logs_api";
  static SOURCE_ID = "security_logs";
  static SOURCE_NAME = "siem_security_logs";

  constructor(client = null) {
    this.client = client || new SecurityLogClient();
    this.SOURCE_TYPE = SecurityLogRetriever.SOURCE_TYPE;
    this.SOURCE_ID = SecurityLogRetriever.SOURCE_ID;
    this.SOURCE_NAME = SecurityLogRetriever.SOURCE_NAME;
  }

  _now_iso() {
    return new Date().toISOString();
  }

  _nowIso() {
    return this._now_iso();
  }

  /**
   * Extract event records from the known security-log response shape.
   *
   * Current API shape is data.events. A top-level events fallback is kept
   * for small response-shape variations without inventing field names.
   */
  _extract_events(response) {
    if (!response || typeof response !== "object") {
      return [];
    }

    const data = response.data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const events = data.events;
      if (Array.isArray(events)) {
        return events;
      }
    }

    const events = response.events;
    if (Array.isArray(events)) {
      return events;
    }

    return [];
  }

  _extractEvents(response) {
    return this._extract_events(response);
  }

  /**
   * Return the API's data payload without reshaping unknown fields.
   */
  _extract_data(response) {
    if (response && typeof response === "object" && "data" in response) {
      return response.data;
    }
    return response;
  }

  _extractData(response) {
    return this._extract_data(response);
  }

  _source_metadata({ resource, retrieved_at, workspace_id = null }) {
    const metadata = {
      source_type: this.SOURCE_TYPE,
      source_id: this.SOURCE_ID,
      source: this.SOURCE_NAME,
      resource,
      retrieved_at,
    };

    if (workspace_id) {
      metadata.workspace_id = workspace_id;
    }

    return metadata;
  }

  _sourceMetadata(resource, retrievedAt, workspaceId = null) {
    return this._source_metadata({
      resource,
      retrieved_at: retrievedAt,
      workspace_id: workspaceId,
    });
  }

  // --------------------------------------------------
  // Existing security logs retrieval
  // --------------------------------------------------

  /**
   * Retrieve general security logs.
   */
  async retrieve(
    earliestOrOpts = "-7d",
    latest = "now",
    limit = 100,
    index = "*",
    extraOpts = {}
  ) {
    let opts = {};

    if (
      earliestOrOpts &&
      typeof earliestOrOpts === "object" &&
      !Array.isArray(earliestOrOpts)
    ) {
      opts = {
        earliest: "-7d",
        latest: "now",
        limit: 100,
        index: "*",
        ...earliestOrOpts,
      };
    } else {
      opts = {
        earliest: earliestOrOpts !== undefined ? earliestOrOpts : "-7d",
        latest: latest !== undefined ? latest : "now",
        limit: limit !== undefined ? limit : 100,
        index: index !== undefined ? index : "*",
        ...extraOpts,
      };
    }

    const response = await this.client.get_security_logs(
      opts.earliest,
      opts.latest,
      opts.limit,
      opts.index,
      null,
      null,
      { force_refresh: Boolean(opts.force_refresh || opts.forceRefresh) }
    );

    const events = this._extract_events(response);
    const retrieved_at = this._now_iso();

    const result = this._source_metadata({
      resource: "security_logs",
      retrieved_at,
    });

    return {
      ...result,
      events,
      event_count: events.length,
      earliest: opts.earliest,
      latest: opts.latest,
      index: opts.index,
    };
  }

  // --------------------------------------------------
  // CLI / Git / Shell audit logs
  // --------------------------------------------------

  /**
   * Retrieve CLI audit logs using the existing security-log endpoint.
   */
  async retrieve_cli_audit_logs(
    sourcetypeOrOpts = null,
    q = null,
    earliest = "-24h",
    latest = "now",
    limit = 100,
    index = "cenario_security",
    extraOpts = {}
  ) {
    let opts = {};

    if (
      sourcetypeOrOpts &&
      typeof sourcetypeOrOpts === "object" &&
      !Array.isArray(sourcetypeOrOpts)
    ) {
      opts = {
        earliest: "-24h",
        latest: "now",
        limit: 100,
        index: "cenario_security",
        ...sourcetypeOrOpts,
      };
    } else {
      opts = {
        sourcetype: sourcetypeOrOpts,
        q,
        earliest: earliest !== undefined ? earliest : "-24h",
        latest: latest !== undefined ? latest : "now",
        limit: limit !== undefined ? limit : 100,
        index: index !== undefined ? index : "cenario_security",
        ...extraOpts,
      };
    }

    const response = await this.client.get_security_logs(
      opts.earliest,
      opts.latest,
      opts.limit,
      opts.index,
      opts.sourcetype,
      opts.q,
      { force_refresh: Boolean(opts.force_refresh || opts.forceRefresh) }
    );

    const events = this._extract_events(response);
    const retrieved_at = this._now_iso();

    const result = this._source_metadata({
      resource: "cli_audit_logs",
      retrieved_at,
    });

    return {
      ...result,
      events,
      event_count: events.length,
      earliest: opts.earliest,
      latest: opts.latest,
      limit: opts.limit,
      index: opts.index,
      sourcetype: opts.sourcetype,
      query: opts.q,
    };
  }

  async retrieveCliAuditLogs(...args) {
    return this.retrieve_cli_audit_logs(...args);
  }

  // --------------------------------------------------
  // Security log summary
  // --------------------------------------------------

  /**
   * Retrieve the security-log summary without inventing a schema.
   */
  async retrieve_security_logs_summary(
    earliestOrOpts = "-24h",
    latest = "now",
    index = "*",
    extraOpts = {}
  ) {
    let opts = {};

    if (
      earliestOrOpts &&
      typeof earliestOrOpts === "object" &&
      !Array.isArray(earliestOrOpts)
    ) {
      opts = {
        earliest: "-24h",
        latest: "now",
        index: "*",
        ...earliestOrOpts,
      };
    } else {
      opts = {
        earliest: earliestOrOpts !== undefined ? earliestOrOpts : "-24h",
        latest: latest !== undefined ? latest : "now",
        index: index !== undefined ? index : "*",
        ...extraOpts,
      };
    }

    const response = await this.client.get_security_logs_summary(
      opts.earliest,
      opts.latest,
      opts.index,
      { force_refresh: Boolean(opts.force_refresh || opts.forceRefresh) }
    );

    const retrieved_at = this._now_iso();

    const result = this._source_metadata({
      resource: "security_logs_summary",
      retrieved_at,
    });

    return {
      ...result,
      data: this._extract_data(response),
      earliest: opts.earliest,
      latest: opts.latest,
      index: opts.index,
    };
  }

  async retrieveSecurityLogsSummary(...args) {
    return this.retrieve_security_logs_summary(...args);
  }

  async retrieveSummary(...args) {
    return this.retrieve_security_logs_summary(...args);
  }

  // --------------------------------------------------
  // Workspace security logs
  // --------------------------------------------------

  /**
   * Retrieve logs belonging to one workspace.
   */
  async retrieve_workspace_security_logs(
    workspaceIdOrOpts,
    earliest = "-24h",
    latest = "now",
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
      opts = {
        earliest: "-24h",
        latest: "now",
        limit: 100,
        index: "*",
        ...workspaceIdOrOpts,
      };
    } else {
      opts = {
        workspace_id: workspaceIdOrOpts,
        earliest: earliest !== undefined ? earliest : "-24h",
        latest: latest !== undefined ? latest : "now",
        limit: limit !== undefined ? limit : 100,
        index: index !== undefined ? index : "*",
        ...extraOpts,
      };
    }

    const workspace_id = opts.workspace_id || opts.workspaceId;

    const response = await this.client.get_workspace_security_logs(
      workspace_id,
      opts.earliest,
      opts.latest,
      opts.limit,
      opts.index,
      { force_refresh: Boolean(opts.force_refresh || opts.forceRefresh) }
    );

    const events = this._extract_events(response);
    const retrieved_at = this._now_iso();

    const result = this._source_metadata({
      resource: "workspace_security_logs",
      retrieved_at,
      workspace_id,
    });

    return {
      ...result,
      events,
      event_count: events.length,
      earliest: opts.earliest,
      latest: opts.latest,
      limit: opts.limit,
      index: opts.index,
    };
  }

  async retrieveWorkspaceSecurityLogs(...args) {
    return this.retrieve_workspace_security_logs(...args);
  }

  async retrieveWorkspaceLogs(...args) {
    return this.retrieve_workspace_security_logs(...args);
  }

  // --------------------------------------------------
  // Workspace SIEM status
  // --------------------------------------------------

  /**
   * Retrieve SIEM status for one workspace.
   */
  async retrieve_workspace_siem_status(workspaceIdOrOpts, extraOpts = {}) {
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

    const workspace_id = opts.workspace_id || opts.workspaceId;

    const response = await this.client.get_workspace_siem_status(workspace_id, {
      force_refresh: Boolean(opts.force_refresh || opts.forceRefresh),
    });

    const retrieved_at = this._now_iso();

    const result = this._source_metadata({
      resource: "workspace_siem_status",
      retrieved_at,
      workspace_id,
    });

    result.data = this._extract_data(response);
    return result;
  }

  async retrieveWorkspaceSiemStatus(...args) {
    return this.retrieve_workspace_siem_status(...args);
  }

  // --------------------------------------------------
  // Admin security overview
  // --------------------------------------------------

  /**
   * Retrieve the admin security overview.
   */
  async retrieve_security_overview(opts = {}) {
    const response = await this.client.get_security_overview({
      force_refresh: Boolean(opts.force_refresh || opts.forceRefresh),
    });

    const retrieved_at = this._now_iso();

    const result = this._source_metadata({
      resource: "security_overview",
      retrieved_at,
    });

    result.data = this._extract_data(response);
    return result;
  }

  async retrieveSecurityOverview(opts = {}) {
    return this.retrieve_security_overview(opts);
  }

  // --------------------------------------------------
  // Cache control
  // --------------------------------------------------

  clear_cache() {
    this.client.clear_cache();
  }

  clearCache() {
    this.clear_cache();
  }
}

export default {
  SecurityLogRetriever,
};
