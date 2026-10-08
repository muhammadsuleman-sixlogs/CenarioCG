import { loadAllContexts } from "../context/context_store.js";

/**
 * Resolve the smallest PostgreSQL source set required by a validated plan.
 *
 * This router is deliberately schema-driven. It does not contain company
 * table names, column names, entity names, or business rules.
 */
export class SourceRouter {
  constructor(contexts = null) {
    if (contexts === null || contexts === undefined) {
      contexts = loadAllContexts();
    }
    this.contexts = contexts;
    if (!this.contexts || typeof this.contexts !== "object" || Array.isArray(this.contexts)) {
      throw new Error("Context Layer sources must be a dictionary.");
    }
  }

  route(plan, conversationContext = null) {
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
      throw new Error("Retrieval plan must be a dictionary.");
    }

    const requestedSources = this._normalise_sources(plan.postgresql_sources);

    if (this._normalise_sources(plan.data_sources).includes("security_logs")) {
      // Security routing is handled independently. This router only
      // chooses among discovered PostgreSQL Context Layer sources.
      return {
        status: "ok",
        postgresql_sources: this._route_postgresql_sources(
          plan,
          requestedSources,
          conversationContext
        ),
        reason: "Security source kept outside PostgreSQL routing."
      };
    }

    return {
      status: "ok",
      postgresql_sources: this._route_postgresql_sources(
        plan,
        requestedSources,
        conversationContext
      ),
      reason: "Selected the smallest dynamically supported PostgreSQL source set."
    };
  }

  _route_postgresql_sources(plan, requestedSources, conversationContext) {
    const available = Object.keys(this.contexts).filter(
      sourceId => this.contexts[sourceId] && typeof this.contexts[sourceId] === "object" && !Array.isArray(this.contexts[sourceId])
    );
    const availableDeduped = Array.from(new Set(available));
    const availableSet = new Set(availableDeduped);

    requestedSources = requestedSources.filter(sourceId => availableSet.has(sourceId));

    // Once the planner starts emitting a per-step execution plan, those
    // step-level source IDs become authoritative.
    const queryPlan = plan.query_plan;
    if (queryPlan && typeof queryPlan === "object" && !Array.isArray(queryPlan)) {
      const stepSources = [];
      const steps = Array.isArray(queryPlan.steps) ? queryPlan.steps : [];
      for (const step of steps) {
        if (!step || typeof step !== "object" || Array.isArray(step)) {
          continue;
        }
        let sourceId = step.source_id;
        if (typeof sourceId === "string" && sourceId.trim() && availableSet.has(sourceId.trim().toLowerCase())) {
          sourceId = sourceId.trim().toLowerCase();
          if (!stepSources.includes(sourceId)) {
            stepSources.push(sourceId);
          }
        }
      }
      if (stepSources.length > 0) {
        return stepSources;
      }
    }

    const explicitSourcesSet = new Set(
      Array.from(this._get_explicit_sources(plan, conversationContext)).filter(s => availableSet.has(s))
    );
    const explicitSources = Array.from(explicitSourcesSet);

    // One explicit source is a hard source boundary.
    if (requestedSources.length === 1) {
      return requestedSources;
    }
    if (explicitSources.length === 1) {
      return explicitSources;
    }
    if (explicitSources.length > 1) {
      const reqCols = (Array.isArray(plan.required_columns) ? plan.required_columns : [])
        .filter(item => typeof item === "string" && item.trim())
        .map(item => item.trim());
      return this._rank_sources(
        explicitSources,
        plan,
        reqCols,
        conversationContext
      );
    }

    const requiredTables = new Set(
      (Array.isArray(plan.required_tables) ? plan.required_tables : [])
        .filter(table => typeof table === "string" && table.trim())
        .map(table => table.trim())
    );

    const requiredColumns = (Array.isArray(plan.required_columns) ? plan.required_columns : [])
      .filter(item => typeof item === "string" && item.trim())
      .map(item => item.trim());

    if (requiredTables.size === 0) {
      if (availableDeduped.length === 1) {
        return availableDeduped;
      }
      if (requestedSources.length > 1) {
        throw new Error(
          "PostgreSQL source routing is ambiguous without a multi-step execution plan."
        );
      }
      return requestedSources;
    }

    // Build source coverage for every required table.
    const tableSources = {};
    for (const table of requiredTables) {
      tableSources[table] = availableDeduped.filter(sourceId => this._source_tables(sourceId).has(table));
    }

    const missingTables = Object.keys(tableSources).filter(table => tableSources[table].length === 0);
    if (missingTables.length > 0) {
      missingTables.sort();
      throw new Error(
        `No discovered PostgreSQL source contains required table(s): [${missingTables.map(t => `'${t}'`).join(", ")}]`
      );
    }

    // If every required table belongs to exactly one source, routing is
    // deterministic and does not need an LLM guess.
    const uniqueSources = new Set();
    for (const sources of Object.values(tableSources)) {
      if (sources.length === 1) {
        uniqueSources.add(sources[0]);
      }
    }
    const duplicatedTables = Object.keys(tableSources).filter(table => tableSources[table].length > 1);

    if (duplicatedTables.length === 0) {
      return Array.from(uniqueSources).sort();
    }

    // A duplicated table is intentionally ambiguous. Do not silently
    // query both sources because that recreates the current collision bug.
    if (requestedSources.length > 1) {
      const requestedCover = new Set(
        requestedSources.filter(sourceId => {
          const srcTables = this._source_tables(sourceId);
          return Array.from(requiredTables).some(table => srcTables.has(table));
        })
      );
      if (requestedCover.size > 0) {
        duplicatedTables.sort();
        throw new Error(
          `PostgreSQL source routing is ambiguous for duplicated table(s): [${duplicatedTables.map(t => `'${t}'`).join(", ")}]. A multi-step execution plan must identify the source for each step.`
        );
      }
    }

    // A single planner-selected source is already handled above. If we get
    // here, there is no trustworthy deterministic source choice.
    throw new Error(
      "PostgreSQL source routing could not deterministically identify the required source from the discovered Context Layer."
    );
  }

  _rank_sources(candidates, plan, requiredColumns, conversationContext) {
    const deduped = Array.from(new Set(candidates));
    return deduped.sort((a, b) => {
      const scoreA = this._source_score(a, plan, requiredColumns, conversationContext);
      const scoreB = this._source_score(b, plan, requiredColumns, conversationContext);
      if (scoreA !== scoreB) {
        return scoreB - scoreA; // descending
      }
      return a.localeCompare(b); // ascending tie-breaker
    });
  }

  _source_score(sourceId, plan, requiredColumns, conversationContext) {
    let score = 0;
    const context = this.contexts[sourceId] || {};
    if (!context || typeof context !== "object" || Array.isArray(context)) {
      return score;
    }

    const sourceTables = this._source_tables(sourceId);

    const requiredTables = new Set(
      (Array.isArray(plan.required_tables) ? plan.required_tables : [])
        .filter(table => typeof table === "string" && table.trim())
        .map(table => table.trim())
    );

    let matchCount = 0;
    for (const table of requiredTables) {
      if (sourceTables.has(table)) {
        matchCount++;
      }
    }
    score += 10 * matchCount;

    for (const reference of requiredColumns) {
      if (!reference.includes(".")) {
        continue;
      }
      const [table, column] = reference.split(".", 2);
      if (sourceTables.has(table) && this._has_column(sourceId, table, column)) {
        score += 5;
      }
    }

    // Valid entity evidence is a strong tie-breaker because it is
    // already resolved against a source by the existing entity layer.
    for (const entity of this._conversation_entities(conversationContext)) {
      if (entity.source_id === sourceId) {
        score += 100;
      }
    }

    // Explicit metric source evidence is authoritative for that metric.
    const metrics = Array.isArray(plan.requested_metrics) ? plan.requested_metrics : [];
    for (const metric of metrics) {
      if (metric && typeof metric === "object" && metric.source_id === sourceId) {
        score += 100;
      }
    }

    // Discovered relationship endpoints provide another deterministic
    // tie-breaker without hardcoding domain terminology.
    const relationships = context.relationships || [];
    if (Array.isArray(relationships)) {
      const relevantTables = new Set([...requiredTables].filter(t => sourceTables.has(t)));
      for (const relationship of relationships) {
        if (!relationship || typeof relationship !== "object") {
          continue;
        }
        if (
          relevantTables.has(relationship.source_table) ||
          relevantTables.has(relationship.target_table)
        ) {
          score += 2;
        }
      }
    }

    return score;
  }

  _get_explicit_sources(plan, conversationContext) {
    const sources = new Set();

    const metrics = Array.isArray(plan.requested_metrics) ? plan.requested_metrics : [];
    for (const metric of metrics) {
      if (!metric || typeof metric !== "object") {
        continue;
      }
      const sourceId = metric.source_id;
      if (typeof sourceId === "string" && sourceId.trim()) {
        sources.add(sourceId.trim().toLowerCase());
      }
    }

    for (const entity of this._conversation_entities(conversationContext)) {
      const sourceId = entity.source_id;
      if (typeof sourceId === "string" && sourceId.trim()) {
        sources.add(sourceId.trim().toLowerCase());
      }
    }

    return sources;
  }

  _conversation_entities(conversationContext) {
    if (!conversationContext || typeof conversationContext !== "object" || Array.isArray(conversationContext)) {
      return [];
    }
    const entities = conversationContext.entities;
    if (!Array.isArray(entities)) {
      return [];
    }
    return entities.filter(item => item && typeof item === "object" && !Array.isArray(item));
  }

  _source_tables(sourceId) {
    const context = this.contexts[sourceId] || {};
    if (!context || typeof context !== "object" || Array.isArray(context)) {
      return new Set();
    }
    const tables = context.tables || {};
    return typeof tables === "object" && !Array.isArray(tables) ? new Set(Object.keys(tables)) : new Set();
  }

  _has_column(sourceId, tableName, columnName) {
    const context = this.contexts[sourceId] || {};
    if (!context || typeof context !== "object" || Array.isArray(context)) {
      return false;
    }
    const table = (context.tables || {})[tableName];
    if (!table || typeof table !== "object" || Array.isArray(table)) {
      return false;
    }
    const columns = table.columns || [];
    if (!Array.isArray(columns)) {
      return false;
    }
    return columns.some(
      column => column && typeof column === "object" && column.name === columnName
    );
  }

  _normalise_sources(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    const deduped = [];
    for (const item of value) {
      if (typeof item === "string" && item.trim()) {
        const val = item.trim().toLowerCase();
        if (!deduped.includes(val)) {
          deduped.push(val);
        }
      }
    }
    return deduped;
  }

  // CamelCase aliases for backwards compatibility with existing JS calls
  _normaliseSources(value) {
    return this._normalise_sources(value);
  }

  _sourceTables(sourceId) {
    return this._source_tables(sourceId);
  }

  _hasColumn(sourceId, tableName, columnName) {
    return this._has_column(sourceId, tableName, columnName);
  }

  _routePostgresqlSources(plan, requestedSources, conversationContext) {
    return this._route_postgresql_sources(plan, requestedSources, conversationContext);
  }
}

export default {
  SourceRouter
};
