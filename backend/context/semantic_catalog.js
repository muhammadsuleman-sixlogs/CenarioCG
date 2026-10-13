import crypto from "crypto";
import fs from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
export const SEMANTIC_CATALOG_FILE = resolve(__dirname, "semantic_catalog.json");
export const CROSS_SOURCE_RELATIONSHIPS_FILE = resolve(__dirname, "cross_source_relationships.json");

function words(value) {
  return (String(value || "").toLowerCase().match(/[a-z0-9_]+/g) || []).map(token => {
    if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
    return token.endsWith("s") && token.length > 3 ? token.slice(0, -1) : token;
  });
}

function tableColumns(context, table) {
  return new Set((context?.tables?.[table]?.columns || []).map(column => String(column?.name || column)));
}

function humanize(value) {
  return String(value || "").replace(/[_-]+/g, " ").trim();
}

/**
 * Schema-derived entries make newly discovered technical objects routable
 * without granting them business semantics, identity, or cross-source trust.
 */
export function deriveTechnicalEntities(context) {
  const entities = {};
  for (const [table, info] of Object.entries(context?.tables || {})) {
    const phrase = humanize(table);
    if (!phrase) continue;
    const singular = phrase.endsWith("ies") ? `${phrase.slice(0, -3)}y` : (phrase.endsWith("s") ? phrase.slice(0, -1) : phrase);
    const columns = Array.isArray(info?.columns) ? info.columns : [];
    const identifierColumns = columns
      .map(column => String(column?.name || ""))
      .filter(column => /(?:^|_)(?:id|uuid|key|code|reference|number|name|title|label)$/i.test(column))
      .slice(0, 12);
    entities[table] = {
      entity_type: `technical:${table}`,
      description: `Automatically discovered technical entity for ${table}.`,
      synonyms: [...new Set([phrase, singular, table])],
      source_qualified_meaning: `Discovered ${context?.source_id || "postgresql"} table`,
      provenance: [`technical_schema:${context?.source_id || "unknown"}.${table}`],
      technical_entity: true,
      trust_level: "discovered_technical",
      identifier_columns: identifierColumns,
      primary_keys: Array.isArray(info?.primary_keys) ? [...info.primary_keys] : []
    };
  }
  return entities;
}

export function catalogFingerprint(contexts) {
  const technical = Object.fromEntries(Object.entries(contexts || {}).sort().map(([sourceId, context]) => [
    sourceId,
    { tables: context?.tables || {}, relationships: context?.relationships || [] }
  ]));
  return crypto.createHash("sha256").update(JSON.stringify(technical)).digest("hex");
}

export function loadSemanticCatalog(file = SEMANTIC_CATALOG_FILE) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function validateSemanticCatalog(contexts, catalog) {
  const errors = [];
  let evidenceRelationships = new Set();
  try {
    const report = JSON.parse(fs.readFileSync(CROSS_SOURCE_RELATIONSHIPS_FILE, "utf8"));
    evidenceRelationships = new Set((report.validated_relationships || []).filter(item => item?.valid && item.relationship).map(item => item.relationship));
  } catch {
    errors.push("validated cross-source relationship evidence is unavailable");
  }
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) return ["semantic catalog must be an object"];
  for (const [sourceId, source] of Object.entries(catalog.sources || {})) {
    if (!contexts?.[sourceId]) { errors.push(`semantic source is unavailable: ${sourceId}`); continue; }
    for (const [table, entity] of Object.entries(source.entities || {})) {
      if (!contexts[sourceId].tables?.[table]) { errors.push(`${sourceId}.${table} is not a discovered table`); continue; }
      if (!entity || typeof entity !== "object" || !Array.isArray(entity.provenance) || entity.provenance.length === 0) errors.push(`${sourceId}.${table} requires semantic provenance`);
      if (!Array.isArray(entity.synonyms) || entity.synonyms.length === 0) errors.push(`${sourceId}.${table} requires synonyms`);
      const orderColumn = entity.ordering?.column;
      if (orderColumn && !tableColumns(contexts[sourceId], table).has(orderColumn)) errors.push(`${sourceId}.${table}.${orderColumn} is not a discovered column`);
      if (entity.identity) {
        if (!entity.identity.column || !tableColumns(contexts[sourceId], table).has(entity.identity.column)) errors.push(`${sourceId}.${table} identity column is not a discovered column`);
        if (!entity.identity.group || !entity.identity.mapping_id || entity.identity.validation_status !== "validated" || !Array.isArray(entity.identity.provenance) || entity.identity.provenance.length === 0) errors.push(`${sourceId}.${table} identity mapping requires validated provenance`);
      }
    }
  }
  for (const path of catalog.verified_paths || []) {
    if (path.validation_status !== "validated") { errors.push(`path ${path.id} is not validated`); continue; }
    if (!Array.isArray(path.provenance) || path.provenance.length === 0) errors.push(`path ${path.id} requires provenance`);
    for (const step of path.steps || []) {
      if (!contexts?.[step.source_id]?.tables?.[step.table]) errors.push(`path ${path.id} references an unavailable table`);
      else if (!tableColumns(contexts[step.source_id], step.table).has(step.column)) errors.push(`path ${path.id} references an unavailable column`);
    }
    for (const relationship of path.evidence_relationships || []) {
      const [left, right] = String(relationship).split(" -> ");
      const [leftSource, leftTable] = String(left || "").split(".");
      const [rightSource, rightTable] = String(right || "").split(".");
      const sameSource = leftSource && leftSource === rightSource && (contexts?.[leftSource]?.relationships || []).some(item => item.source_table === leftTable && item.target_table === rightTable);
      if (!sameSource && !evidenceRelationships.has(relationship)) errors.push(`path ${path.id} lacks validated relationship evidence: ${relationship}`);
    }
  }
  return errors;
}

export function getSemanticCatalogStatus(contexts, catalog, now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000) {
  const errors = validateSemanticCatalog(contexts, catalog);
  const generatedAt = catalog?.generated_at ? Date.parse(catalog.generated_at) : NaN;
  const age = Number.isFinite(generatedAt) ? Math.max(0, now - generatedAt) : null;
  const expectedFingerprint = catalogFingerprint(contexts);
  const declaredFingerprint = typeof catalog?.technical_fingerprint === "string" ? catalog.technical_fingerprint : null;
  const fingerprintStatus = declaredFingerprint ? (declaredFingerprint === expectedFingerprint ? "verified" : "mismatch") : "unknown";
  if (fingerprintStatus === "mismatch") errors.push("semantic catalog technical fingerprint does not match the loaded schemas");
  if (!catalog?.provenance || catalog.provenance.kind !== "application_owned_semantic_overlay" || catalog.provenance.business_approval_required_for_new_mappings !== true) errors.push("semantic catalog provenance is incomplete");
  return {
    validation_status: errors.length ? "invalid" : "validated",
    freshness_status: errors.length ? "invalid" : (age === null ? "unknown" : (age > maxAgeMs ? "stale" : "fresh")),
    age_ms: age,
    fingerprint: expectedFingerprint,
    fingerprint_status: fingerprintStatus,
    errors
  };
}

export function attachSemanticCatalog(contexts, catalog = null) {
  const semanticCatalog = catalog || loadSemanticCatalog();
  const status = getSemanticCatalogStatus(contexts, semanticCatalog);
  const fingerprintOnlyMismatch = status.errors.length === 1 && status.errors[0] === "semantic catalog technical fingerprint does not match the loaded schemas";
  // A routine technical addition changes the fingerprint but does not make
  // unrelated, still schema-valid approved definitions unsafe. Any missing
  // table/column/path validation error still disables the approved overlay.
  const semanticUsable = (status.validation_status !== "invalid" || fingerprintOnlyMismatch) && status.freshness_status !== "stale";
  const enriched = Object.fromEntries(Object.entries(contexts || {}).map(([sourceId, context]) => {
    const approved = semanticUsable ? (semanticCatalog.sources?.[sourceId]?.entities || {}) : {};
    // Approved entries always win. Derived entries are intentionally scoped to
    // tables missing an approved definition and can never provide identity or
    // verified-path authority.
    const entities = { ...deriveTechnicalEntities(context), ...approved };
    return [sourceId, {
      ...context,
      semantic_catalog_status: status,
      semantic_catalog: semanticUsable ? { entities, verified_paths: semanticCatalog.verified_paths || [] } : undefined
    }];
  }));
  return { contexts: enriched, catalog: semanticUsable ? semanticCatalog : null, status };
}

export function findSemanticCandidates(question, contexts, authorizedSources = null) {
  const allowed = authorizedSources ? new Set(authorizedSources.map(source => String(source).toLowerCase())) : null;
  const query = String(question || "").toLowerCase();
  const recent = /\b(recent|latest|newest|most recent|newly created)\b/i.test(query);
  const candidates = [];
  for (const [sourceId, context] of Object.entries(contexts || {})) {
    if (allowed && !allowed.has(sourceId.toLowerCase())) continue;
    for (const [table, entity] of Object.entries(context.semantic_catalog?.entities || {})) {
      const tableInfo = context.tables?.[table];
      if (!tableInfo) continue;
      const aliases = [...new Map([table, ...(entity.synonyms || []), entity.entity_type].filter(Boolean).map(String).map(value => [words(value).join(" "), value.toLowerCase()])).values()];
      const matchedWords = new Set(words(query));
      const aliasMatches = aliases.map(alias => {
        const aliasWords = words(alias);
        const overlap = aliasWords.filter(token => matchedWords.has(token));
        return { alias, overlap, complete: aliasWords.length > 0 && overlap.length === aliasWords.length };
      }).filter(match => match.complete);
      const matchedAliases = aliasMatches.map(match => match.alias);
      const bestAlias = aliasMatches.sort((left, right) => right.overlap.length - left.overlap.length || right.alias.length - left.alias.length)[0];
      let score = aliasMatches.reduce((total, match) => total + (match.alias === table ? 8 : 12) + (match.overlap.length * 8), 0);
      if (bestAlias) score += bestAlias.overlap.length * 10;
      for (const column of tableInfo.columns || []) if (matchedWords.has(words(column?.name || "")[0])) score += 2;
      const orderingColumn = entity.ordering?.column || null;
      if (recent && orderingColumn) score += 10;
      if (score > 0) candidates.push({
        source_id: sourceId,
        table,
        entity_type: entity.entity_type,
        description: entity.description,
        matched_aliases: matchedAliases,
        ordering_column: orderingColumn,
        identity_key: entity.identity?.column || null,
        identity_group: entity.identity?.group || null,
        identity_mapping_id: entity.identity?.mapping_id || null,
        identity_validation_status: entity.identity?.validation_status || null,
        identity_provenance: Array.isArray(entity.identity?.provenance) ? entity.identity.provenance : [],
        status_semantics: entity.status_semantics || null,
        score,
        provenance: entity.provenance || []
      });
    }
  }
  // Established business semantics retain precedence. Technical candidates
  // exist for newly discovered objects, not to silently change existing
  // meeting/project/company routing behavior.
  const approved = candidates.filter(candidate => !contexts?.[candidate.source_id]?.semantic_catalog?.entities?.[candidate.table]?.technical_entity);
  return (approved.length > 0 ? approved : candidates)
    .sort((left, right) => right.score - left.score || left.source_id.localeCompare(right.source_id) || left.table.localeCompare(right.table));
}

export function findVerifiedPaths(question, contexts, authorizedSources = null, options = {}) {
  const allowed = authorizedSources ? new Set(authorizedSources.map(source => String(source).toLowerCase())) : null;
  const candidates = findSemanticCandidates(question, contexts, authorizedSources);
  const queryWords = new Set(words(question));
  const technicalCandidates = [];
  for (const [sourceId, context] of Object.entries(contexts || {})) {
    if (allowed && !allowed.has(String(sourceId).toLowerCase())) continue;
    for (const table of Object.keys(context?.tables || {})) {
      const tableWords = words(table);
      if (tableWords.length > 0 && tableWords.some(token => queryWords.has(token))) {
        technicalCandidates.push({ source_id: sourceId, table });
      }
    }
  }
  const candidateNodes = new Set([
    ...candidates.map(candidate => `${candidate.source_id}:${candidate.table}`),
    ...technicalCandidates.map(candidate => `${candidate.source_id}:${candidate.table}`)
  ]);
  const declaredPaths = [...new Map(Object.values(contexts || {}).flatMap(context => context.semantic_catalog?.verified_paths || []).map(path => [path.id || JSON.stringify(path.steps), path])).values()]
    .filter(path => path.validation_status === "validated" && path.steps?.length > 1)
    .filter(path => path.steps.every(step => !allowed || allowed.has(String(step.source_id).toLowerCase())))
    .flatMap(path => {
      if (!options.active) return [path];
      const first = path.steps[0];
      const last = path.steps.at(-1);
      const activeIndex = path.steps.findIndex(step => step?.source_id === options.active.source_id && step?.table === options.active.table);
      if (activeIndex < 0) return [];
      const activeMatchesFirst = activeIndex === 0;
      const activeMatchesLast = activeIndex === path.steps.length - 1;
      // An established entity may be an intermediate node in an approved
      // path. Traverse only the adjacent approved segment, never invent a
      // shortcut through the technical graph.
      const oriented = !activeMatchesFirst && !activeMatchesLast
        ? { ...path, id: `${path.id}:reverse-prefix`, steps: path.steps.slice(0, activeIndex + 1).reverse(), evidence_relationships: (path.evidence_relationships || []).slice(0, activeIndex).reverse().map(item => {
          const [left, right] = String(item).split(" -> ");
          return left && right ? `${right} -> ${left}` : item;
        }) }
        : activeMatchesLast && !activeMatchesFirst
        ? { ...path, steps: [...path.steps].reverse(), evidence_relationships: [...(path.evidence_relationships || [])].reverse().map(item => {
          const [left, right] = String(item).split(" -> ");
          return left && right ? `${right} -> ${left}` : item;
        }) }
        : path;
      return oriented.steps.slice(1).some(step => candidateNodes.has(`${step.source_id}:${step.table}`)) ? [oriented] : [];
    });
  if (declaredPaths.length > 0) return declaredPaths;
  const graph = new Map();
  const edgeEvidence = new Map();
  const addEdge = (left, right, evidence) => {
    if (allowed && (!allowed.has(left.source_id) || !allowed.has(right.source_id))) return;
    const leftKey = `${left.source_id}:${left.table}`;
    const rightKey = `${right.source_id}:${right.table}`;
    if (!graph.has(leftKey)) graph.set(leftKey, []);
    if (!graph.has(rightKey)) graph.set(rightKey, []);
    graph.get(leftKey).push({ node: right, evidence });
    graph.get(rightKey).push({ node: left, evidence });
    edgeEvidence.set(`${leftKey}->${rightKey}`, evidence);
    edgeEvidence.set(`${rightKey}->${leftKey}`, evidence);
  };
  for (const [sourceId, context] of Object.entries(contexts || {})) {
    if (allowed && !allowed.has(sourceId)) continue;
    for (const relationship of context.relationships || []) {
      if (!relationship?.source_table || !relationship?.target_table) continue;
      addEdge(
        { source_id: sourceId, table: relationship.source_table, column: relationship.source_column },
        { source_id: sourceId, table: relationship.target_table, column: relationship.target_column },
        `${sourceId}.${relationship.source_table}.${relationship.source_column} -> ${sourceId}.${relationship.target_table}.${relationship.target_column}`
      );
    }
  }
  let evidenceReport = {};
  try { evidenceReport = JSON.parse(fs.readFileSync(CROSS_SOURCE_RELATIONSHIPS_FILE, "utf8")); } catch { evidenceReport = {}; }
  // Cross-source traversal must come from the semantic overlay's approved
  // paths above.  The evidence report is useful for validating those paths,
  // but its statistical candidates are not an execution-relationship graph.
  for (const relationship of evidenceReport.validated_relationships || []) {
    if (!relationship?.valid || !relationship.source_system || !relationship.target_system ||
        !relationship.source_table || !relationship.source_column ||
        !relationship.target_table || !relationship.target_column) continue;
    addEdge(
      { source_id: relationship.source_system, table: relationship.source_table, column: relationship.source_column },
      { source_id: relationship.target_system, table: relationship.target_table, column: relationship.target_column },
      `${relationship.source_system}.${relationship.source_table}.${relationship.source_column} -> ${relationship.target_system}.${relationship.target_table}.${relationship.target_column}`
    );
  }

  const starts = [];
  if (options.active?.source_id && options.active?.table) {
    const stableColumn = Object.keys(options.active.stable_keys || {}).find(column => Object.values(contexts[options.active.source_id]?.tables?.[options.active.table]?.columns || {}).some(item => String(item?.name || item) === column));
    starts.push({ key: `${options.active.source_id}:${options.active.table}`, column: stableColumn || null });
  } else {
    for (const candidate of candidates) starts.push({ key: `${candidate.source_id}:${candidate.table}`, column: candidate.ordering_column || null });
  }
  const paths = [];
  for (const start of starts) {
    if (!graph.has(start.key)) continue;
    const queue = [{ key: start.key, nodes: [{ source_id: start.key.split(":")[0], table: start.key.split(":")[1], column: start.column }], visited: new Set([start.key]), evidence: [] }];
    while (queue.length) {
      const current = queue.shift();
      if (current.nodes.length > 1 && candidateNodes.has(current.key) && current.key !== start.key) paths.push({ id: `graph:${start.key}->${current.key}`, purpose: "verified_relationship_traversal", steps: current.nodes, evidence_relationships: current.evidence, validation_status: "validated", provenance: ["technical_context_relationships", "cross_source_relationships.json"] });
      if (current.nodes.length >= 5) continue;
      for (const next of graph.get(current.key) || []) {
        const nextKey = `${next.node.source_id}:${next.node.table}`;
        if (current.visited.has(nextKey)) continue;
        queue.push({ key: nextKey, nodes: [...current.nodes, next.node], visited: new Set([...current.visited, nextKey]), evidence: [...current.evidence, next.evidence] });
      }
    }
  }
  const unique = new Map(paths.map(path => [path.steps.map(step => `${step.source_id}.${step.table}.${step.column}`).join("|"), path]));
  const activeEntityType = options.active?.source_id && options.active?.table
    ? contexts?.[options.active.source_id]?.semantic_catalog?.entities?.[options.active.table]?.entity_type
    : null;
  const validatedConfidence = new Map((evidenceReport.validated_relationships || [])
    .filter(item => item?.valid && item.relationship)
    .map(item => [item.relationship, Number(item.confidence || 0)]));
  const pathScore = path => {
    const equivalentEntities = activeEntityType
      ? path.steps.slice(1).filter(step => contexts?.[step.source_id]?.semantic_catalog?.entities?.[step.table]?.entity_type === activeEntityType).length
      : 0;
    const confidence = path.evidence_relationships.reduce((total, evidence) => {
      const reverse = String(evidence).split(" -> ").reverse().join(" -> ");
      return total + (validatedConfidence.get(evidence) ?? validatedConfidence.get(reverse) ?? 1);
    }, 0);
    return { equivalentEntities, confidence };
  };
  return [...unique.values()].sort((left, right) => {
    const leftScore = pathScore(left);
    const rightScore = pathScore(right);
    return rightScore.equivalentEntities - leftScore.equivalentEntities ||
      left.steps.length - right.steps.length ||
      rightScore.confidence - leftScore.confidence;
  });
}

export default { SEMANTIC_CATALOG_FILE, CROSS_SOURCE_RELATIONSHIPS_FILE, catalogFingerprint, loadSemanticCatalog, validateSemanticCatalog, deriveTechnicalEntities, attachSemanticCatalog, findSemanticCandidates, findVerifiedPaths };
