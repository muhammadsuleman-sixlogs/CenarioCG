import { isSensitiveFieldName } from "../security/sensitive_data_policy.js";
import { validateReadOnlyQuery } from "../database/readonly_guard.js";
import { validateSqlSyntax } from "./sql_validator.js";

const MAX_IDS_PER_QUERY = 500;

function quoteIdentifier(value) {
  const name = String(value || "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe identifier: ${name}`);
  }
  return `"${name.replaceAll('"', '""')}"`;
}

function profileColumns(context, table) {
  const entity = context?.semantic_catalog?.entities?.[table];
  const template = entity?.display_template;
  const display = Array.isArray(template)
    ? template
    : (Array.isArray(template?.columns) ? template.columns : []);
  const columns = [...display, entity?.secondary_label].filter(Boolean).map(String);
  return [...new Set(columns)].filter(column => !isSensitiveFieldName(column));
}

function labelField(role, foreignKey) {
  const roleWords = String(role || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter(word => !new Set(["owner", "created", "by", "assigned", "assignee", "related", "foreign"]).has(word));
  const fallback = String(foreignKey || "related_entity")
    .replace(/(?:_id|_uuid|_key)$/i, "")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "");
  return `${roleWords.at(-1) || fallback || "related_entity"}_label`;
}

function foreignKeyProfiles(context, table) {
  const roles = context?.semantic_catalog?.entities?.[table]?.column_roles;
  if (!roles || typeof roles !== "object") return [];
  return Object.entries(roles)
    .filter(([column, role]) => role?.role === "foreign_key" && role.relationship_role)
    .filter(([, role]) => context?.tables?.[role.target_table])
    .filter(([column, role]) => (context.relationships || []).some(relationship =>
      relationship?.source_table === table &&
      relationship?.source_column === column &&
      relationship?.target_table === role.target_table &&
      relationship?.target_column === role.target_column &&
      String(relationship.relationship_type || relationship.database_relationship_type || "").toUpperCase() === "FOREIGN_KEY"
    ))
    .map(([column, role]) => ({
      column,
      targetTable: String(role.target_table),
      targetColumn: String(role.target_column),
      relationshipRole: String(role.relationship_role),
      labelColumn: labelField(role.relationship_role, column)
    }));
}

function buildLookupQuery(context, profile, displayColumns) {
  const targetColumns = new Set((context?.tables?.[profile.targetTable]?.columns || [])
    .map(column => String(column?.name || column)));
  if (!targetColumns.has(profile.targetColumn) || !displayColumns.length) return null;
  const selected = [profile.targetColumn, ...displayColumns]
    .filter((column, index, all) => all.indexOf(column) === index && targetColumns.has(column));
  if (!selected.length) return null;
  const query = `SELECT ${selected.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(profile.targetTable)} WHERE ${quoteIdentifier(profile.targetColumn)} = ANY($1)`;
  validateReadOnlyQuery(query);
  validateSqlSyntax(query);
  return { query, parameters: [] };
}

function displayLabel(row, columns) {
  const values = columns.map(column => row?.[column]).filter(value => value !== null && value !== undefined && String(value).trim() !== "");
  return values.length ? values.map(String).join(" ").trim() : null;
}

export async function enrichRetrievedRows({
  rows,
  sourceId,
  table,
  context,
  execute,
  maxRows = 50
} = {}) {
  if (!Array.isArray(rows) || !rows.length || typeof execute !== "function") return rows;
  const shownRows = rows.slice(0, Math.max(0, Number(maxRows) || 0));
  const profiles = foreignKeyProfiles(context, table);
  if (!profiles.length || !shownRows.length) return rows;

  const enrichedRows = rows.map(row => ({ ...row }));
  for (const row of enrichedRows.slice(0, shownRows.length)) {
    row._internal = { ...(row._internal || {}), source_id: sourceId, table, foreign_keys: {} };
    for (const profile of profiles) {
      if (!Object.prototype.hasOwnProperty.call(row, profile.column)) continue;
      const value = row[profile.column];
      row._internal.foreign_keys[profile.column] = value ?? null;
      if (value === null || value === undefined || value === "") {
        row[profile.labelColumn] = "not assigned";
      }
    }
  }

  for (const profile of profiles) {
    const ids = [...new Set(shownRows
      .map(row => row?.[profile.column])
      .filter(value => value !== null && value !== undefined && value !== "")
      .map(value => String(value)))];
    if (!ids.length) continue;
    const displayColumns = profileColumns(context, profile.targetTable);
    const lookup = buildLookupQuery(context, profile, displayColumns);
    if (!lookup) continue;
    const labels = new Map();
    for (let offset = 0; offset < ids.length; offset += MAX_IDS_PER_QUERY) {
      const chunk = ids.slice(offset, offset + MAX_IDS_PER_QUERY);
      const result = await execute(lookup.query, sourceId, { parameters: [chunk] });
      for (const resultRow of Array.isArray(result?.rows) ? result.rows : []) {
        const id = resultRow?.[profile.targetColumn];
        const label = displayLabel(resultRow, displayColumns);
        if (id !== null && id !== undefined && label) labels.set(String(id), label);
      }
    }
    for (let index = 0; index < shownRows.length; index += 1) {
      const value = shownRows[index]?.[profile.column];
      const label = labels.get(String(value));
      if (label) enrichedRows[index][profile.labelColumn] = label;
    }
  }
  return enrichedRows;
}

export const enrich_retrieved_rows = enrichRetrievedRows;

export default { enrichRetrievedRows, enrich_retrieved_rows };
