import React, { useState, useMemo } from "react";

function getSourceBadgeClass(sourceId) {
  const s = String(sourceId || "").toLowerCase();
  if (s.includes("db1")) return "badge-db1";
  if (s.includes("db2")) return "badge-db2";
  return "badge-default";
}

function cleanNodeName(id) {
  if (!id) return "";
  const str = String(id);
  if (str.includes(":")) {
    return str.split(":")[1];
  }
  return str;
}

function getNodeSourceId(id) {
  if (!id) return "";
  const str = String(id);
  if (str.includes(":")) {
    return str.split(":")[0];
  }
  return "";
}

export default function KpiDetailView({
  selectedKpi,
  graphData,
  graphSummary,
  onClose,
  onSelectEntity
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedRows, setExpandedRows] = useState(new Set());
  const [filterType, setFilterType] = useState("all"); // For connections: all, database, business, cross_source

  // Reset expanded rows when switching KPIs
  React.useEffect(() => {
    setExpandedRows(new Set());
    setSearchQuery("");
    setFilterType("all");
  }, [selectedKpi]);

  const toggleRow = (id) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const expandAll = (allIds) => {
    setExpandedRows(new Set(allIds));
  };

  const collapseAll = () => {
    setExpandedRows(new Set());
  };

  // 1. Entities data
  const entities = useMemo(() => {
    if (!graphData?.nodes) return [];
    return graphData.nodes;
  }, [graphData]);

  // 2. Database relationships data
  const dbRelationships = useMemo(() => {
    if (!graphData?.edges) return [];
    return graphData.edges.filter(
      (e) => (e.relationship_type || e.type) === "DATABASE_RELATIONSHIP" || e.type === "database"
    );
  }, [graphData]);

  // 3. Business relationships data
  const businessRelationships = useMemo(() => {
    if (!graphData?.edges) return [];
    return graphData.edges.filter(
      (e) => (e.relationship_type || e.type) === "BUSINESS_RELATIONSHIP" || e.type === "business"
    );
  }, [graphData]);

  // 4. All graph connections
  const allConnections = useMemo(() => {
    if (!graphData?.edges) return [];
    return graphData.edges;
  }, [graphData]);

  // Filtered views
  const filteredEntities = useMemo(() => {
    if (!searchQuery.trim()) return entities;
    const q = searchQuery.toLowerCase().trim();
    return entities.filter((node) => {
      const name = String(node.label || "").toLowerCase();
      const id = String(node.id || "").toLowerCase();
      const source = String(node.source_id || "").toLowerCase();
      const hasCol = (node.columns || []).some(
        (c) => String(c.name || "").toLowerCase().includes(q) || String(c.type || "").toLowerCase().includes(q)
      );
      return name.includes(q) || id.includes(q) || source.includes(q) || hasCol;
    });
  }, [entities, searchQuery]);

  const filteredDbRelationships = useMemo(() => {
    let list = dbRelationships;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((rel) => {
        const src = String(rel.source || rel.parent_table || "").toLowerCase();
        const tgt = String(rel.target || rel.child_table || "").toLowerCase();
        const srcCol = String(rel.source_column || rel.parent_column || "").toLowerCase();
        const tgtCol = String(rel.target_column || rel.child_column || "").toLowerCase();
        const ev = String(rel.evidence || "").toLowerCase();
        return src.includes(q) || tgt.includes(q) || srcCol.includes(q) || tgtCol.includes(q) || ev.includes(q);
      });
    }
    return list;
  }, [dbRelationships, searchQuery]);

  const filteredBusinessRelationships = useMemo(() => {
    let list = businessRelationships;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((rel) => {
        const src = String(rel.source || "").toLowerCase();
        const tgt = String(rel.target || "").toLowerCase();
        const label = String(rel.label || rel.business_relationship || "").toLowerCase();
        const reason = String(rel.reason || "").toLowerCase();
        return src.includes(q) || tgt.includes(q) || label.includes(q) || reason.includes(q);
      });
    }
    return list;
  }, [businessRelationships, searchQuery]);

  const filteredAllConnections = useMemo(() => {
    let list = allConnections;
    if (filterType !== "all") {
      list = list.filter((e) => {
        const type = (e.relationship_type || e.type || "").toLowerCase();
        if (filterType === "database") return type.includes("database");
        if (filterType === "business") return type.includes("business");
        if (filterType === "cross_source") return type.includes("cross");
        return true;
      });
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((rel) => {
        const src = String(rel.source || "").toLowerCase();
        const tgt = String(rel.target || "").toLowerCase();
        const label = String(rel.label || "").toLowerCase();
        const type = String(rel.relationship_type || rel.type || "").toLowerCase();
        return src.includes(q) || tgt.includes(q) || label.includes(q) || type.includes(q);
      });
    }
    return list;
  }, [allConnections, filterType, searchQuery]);

  if (!selectedKpi) return null;

  // Header configs per KPI
  const kpiConfig = {
    entities: {
      title: "Discovered Entities & Schema Attributes",
      subtitle: "Inspecting all discovered tables, primary keys, and data types across connected sources",
      count: entities.length,
      filteredCount: filteredEntities.length,
      icon: "◈",
      themeColor: "var(--cyan)",
      softColor: "var(--cyan-soft)"
    },
    database: {
      title: "Discovered Database Relationships",
      subtitle: "Inspecting foreign-key relational links, connected tables, and schema constraints",
      count: dbRelationships.length,
      filteredCount: filteredDbRelationships.length,
      icon: "⌁",
      themeColor: "var(--purple)",
      softColor: "var(--purple-soft)"
    },
    business: {
      title: "Discovered Business Relationships",
      subtitle: "Inspecting validated business-semantic links and reasoning metadata",
      count: businessRelationships.length,
      filteredCount: filteredBusinessRelationships.length,
      icon: "✦",
      themeColor: "var(--green)",
      softColor: "var(--green-soft)"
    },
    connections: {
      title: "Complete Graph Relationships",
      subtitle: "Inspecting the full set of 236 edges across database, business, and cross-source layers",
      count: allConnections.length,
      filteredCount: filteredAllConnections.length,
      icon: "◎",
      themeColor: "var(--amber)",
      softColor: "var(--amber-soft)"
    }
  }[selectedKpi] || {
    title: "KPI Detail Explorer",
    subtitle: "Inspecting discovered schema structure",
    count: 0,
    filteredCount: 0,
    icon: "◈",
    themeColor: "var(--cyan)",
    softColor: "var(--cyan-soft)"
  };

  return (
    <section className="kpi-detail-panel" style={{ "--kpi-accent": kpiConfig.themeColor, "--kpi-accent-soft": kpiConfig.softColor }}>
      {/* Top Header */}
      <div className="kpi-detail-header">
        <div className="kpi-detail-title-group">
          <div className="kpi-detail-icon">{kpiConfig.icon}</div>
          <div>
            <div className="kpi-detail-title-row">
              <h2 className="kpi-detail-title">{kpiConfig.title}</h2>
              <span className="kpi-detail-badge">
                {kpiConfig.filteredCount === kpiConfig.count
                  ? `${kpiConfig.count} Total`
                  : `${kpiConfig.filteredCount} of ${kpiConfig.count}`}
              </span>
            </div>
            <p className="kpi-detail-subtitle">{kpiConfig.subtitle}</p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="kpi-detail-actions">
          <div className="kpi-search-box">
            <span className="kpi-search-icon">🔍</span>
            <input
              type="text"
              placeholder={`Filter ${selectedKpi}...`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="kpi-search-input"
            />
            {searchQuery && (
              <button
                type="button"
                className="kpi-search-clear"
                onClick={() => setSearchQuery("")}
                title="Clear filter"
              >
                ✕
              </button>
            )}
          </div>

          {selectedKpi === "connections" && (
            <div className="kpi-filter-pills">
              <button
                type="button"
                className={`kpi-filter-pill ${filterType === "all" ? "active" : ""}`}
                onClick={() => setFilterType("all")}
              >
                All (236)
              </button>
              <button
                type="button"
                className={`kpi-filter-pill ${filterType === "database" ? "active" : ""}`}
                onClick={() => setFilterType("database")}
              >
                Database (100)
              </button>
              <button
                type="button"
                className={`kpi-filter-pill ${filterType === "business" ? "active" : ""}`}
                onClick={() => setFilterType("business")}
              >
                Business (96)
              </button>
              <button
                type="button"
                className={`kpi-filter-pill ${filterType === "cross_source" ? "active" : ""}`}
                onClick={() => setFilterType("cross_source")}
              >
                Cross-Source (40)
              </button>
            </div>
          )}

          <div className="kpi-view-buttons">
            <button
              type="button"
              className="kpi-btn-secondary"
              onClick={() => {
                let ids = [];
                if (selectedKpi === "entities") ids = filteredEntities.map((n) => n.id);
                else if (selectedKpi === "database") ids = filteredDbRelationships.map((r, i) => r.id || `db-${i}`);
                else if (selectedKpi === "business") ids = filteredBusinessRelationships.map((r, i) => r.id || `biz-${i}`);
                else ids = filteredAllConnections.map((r, i) => r.id || `conn-${i}`);

                if (expandedRows.size === ids.length) {
                  collapseAll();
                } else {
                  expandAll(ids);
                }
              }}
              title="Toggle expand/collapse all rows"
            >
              {expandedRows.size > 0 ? "Collapse All" : "Expand All"}
            </button>

            <button
              type="button"
              className="kpi-btn-reset"
              onClick={onClose}
              title="Close detail view and return to default dashboard"
            >
              ⟲ Reset
            </button>
          </div>
        </div>
      </div>

      {/* Table Container */}
      <div className="kpi-table-container">
        {/* KPI 1: ENTITIES TABLE */}
        {selectedKpi === "entities" && (
          <table className="kpi-table">
            <thead>
              <tr>
                <th style={{ width: "48px" }}></th>
                <th>Entity / Table Name</th>
                <th>Data Source</th>
                <th>Attributes</th>
                <th>Primary Key</th>
                <th>Entity Type</th>
                <th style={{ textAlign: "right" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredEntities.length === 0 ? (
                <tr>
                  <td colSpan={7} className="kpi-table-empty">
                    No matching entities found for "{searchQuery}".
                  </td>
                </tr>
              ) : (
                filteredEntities.map((node) => {
                  const isExpanded = expandedRows.has(node.id);
                  const source = node.source_id || getNodeSourceId(node.id);
                  const columns = node.columns || [];
                  const pks = node.primary_keys || [];

                  return (
                    <React.Fragment key={node.id}>
                      <tr className={`kpi-row ${isExpanded ? "expanded" : ""}`} onClick={() => toggleRow(node.id)}>
                        <td className="kpi-cell-toggle">
                          <span className={`kpi-chevron ${isExpanded ? "open" : ""}`}>▶</span>
                        </td>
                        <td className="kpi-cell-primary">
                          <span className="kpi-entity-symbol">◈</span>
                          <span className="kpi-entity-name">{node.label}</span>
                        </td>
                        <td>
                          <span className={`kpi-source-badge ${getSourceBadgeClass(source)}`}>
                            {source.toUpperCase() || "DB1"}
                          </span>
                        </td>
                        <td>
                          <span className="kpi-count-pill">{columns.length} columns</span>
                        </td>
                        <td>
                          {pks.length > 0 ? (
                            <span className="kpi-pk-tag">{pks.join(", ")}</span>
                          ) : (
                            <span className="kpi-dim-text">None</span>
                          )}
                        </td>
                        <td>
                          <span className="kpi-type-badge">{node.type || "table"}</span>
                        </td>
                        <td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                          {onSelectEntity && (
                            <button
                              type="button"
                              className="kpi-inspect-btn"
                              onClick={() => onSelectEntity(node)}
                              title="Inspect this entity in graph & sidebar"
                            >
                              Inspect ➔
                            </button>
                          )}
                        </td>
                      </tr>

                      {/* Expanded Row: Columns with Data Types */}
                      {isExpanded && (
                        <tr className="kpi-expanded-row">
                          <td colSpan={7}>
                            <div className="kpi-attributes-wrapper">
                              <div className="kpi-attr-header">
                                <span className="kpi-attr-title">Discovered Schema Attributes & Data Types</span>
                                <span className="kpi-dim-text">
                                  Table ID: <code>{node.id}</code> | {columns.length} columns discovered
                                </span>
                              </div>

                              <div className="kpi-columns-grid">
                                {columns.map((col) => {
                                  const isPk = pks.includes(col.name) || col.pk;
                                  return (
                                    <div key={col.name} className={`kpi-col-card ${isPk ? "is-pk" : ""}`}>
                                      <div className="kpi-col-top">
                                        <span className="kpi-col-name">{col.name}</span>
                                        {isPk && <span className="pk-badge">PK</span>}
                                      </div>
                                      <span className="kpi-col-type">{col.type || "unknown"}</span>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        )}

        {/* KPI 2: DATABASE RELATIONSHIPS TABLE */}
        {selectedKpi === "database" && (
          <table className="kpi-table">
            <thead>
              <tr>
                <th style={{ width: "48px" }}></th>
                <th>Source Table</th>
                <th style={{ width: "32px", textAlign: "center" }}></th>
                <th>Target Table</th>
                <th>Foreign Key Connection</th>
                <th>Type</th>
                <th>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {filteredDbRelationships.length === 0 ? (
                <tr>
                  <td colSpan={7} className="kpi-table-empty">
                    No matching database relationships found for "{searchQuery}".
                  </td>
                </tr>
              ) : (
                filteredDbRelationships.map((rel, index) => {
                  const rowId = rel.id || `db-${index}`;
                  const isExpanded = expandedRows.has(rowId);

                  const sourceTable = rel.parent_table || cleanNodeName(rel.source);
                  const targetTable = rel.child_table || cleanNodeName(rel.target);
                  const sourceCol = rel.parent_column || rel.target_column || "id";
                  const targetCol = rel.child_column || rel.source_column || "";
                  const sourceDb = rel.source_id || getNodeSourceId(rel.source) || "db1";

                  return (
                    <React.Fragment key={rowId}>
                      <tr className={`kpi-row ${isExpanded ? "expanded" : ""}`} onClick={() => toggleRow(rowId)}>
                        <td className="kpi-cell-toggle">
                          <span className={`kpi-chevron ${isExpanded ? "open" : ""}`}>▶</span>
                        </td>
                        <td className="kpi-cell-primary">
                          <span className={`kpi-source-badge ${getSourceBadgeClass(sourceDb)}`}>
                            {sourceDb.toUpperCase()}
                          </span>
                          <span className="kpi-entity-name">{sourceTable}</span>
                        </td>
                        <td className="kpi-cell-arrow">➔</td>
                        <td className="kpi-cell-primary">
                          <span className={`kpi-source-badge ${getSourceBadgeClass(sourceDb)}`}>
                            {sourceDb.toUpperCase()}
                          </span>
                          <span className="kpi-entity-name">{targetTable}</span>
                        </td>
                        <td>
                          <div className="kpi-fk-badge">
                            <code>
                              {targetTable}.{targetCol} ➔ {sourceTable}.{sourceCol}
                            </code>
                          </div>
                        </td>
                        <td>
                          <span className="kpi-badge-database">FOREIGN_KEY</span>
                        </td>
                        <td>
                          <span className="kpi-confidence-pill">
                            {rel.confidence != null ? `${(rel.confidence * 100).toFixed(0)}%` : "100%"}
                          </span>
                        </td>
                      </tr>

                      {/* Expanded Row: Full FK Details */}
                      {isExpanded && (
                        <tr className="kpi-expanded-row">
                          <td colSpan={7}>
                            <div className="kpi-attributes-wrapper">
                              <div className="kpi-attr-header">
                                <span className="kpi-attr-title">Foreign-Key Connection Specification</span>
                                <span className="kpi-dim-text">Source: {sourceDb.toUpperCase()}</span>
                              </div>

                              <div className="kpi-rel-detail-grid">
                                <div className="kpi-detail-item">
                                  <span className="kpi-detail-label">Parent Table (Target Key)</span>
                                  <span className="kpi-detail-val">
                                    <code>
                                      {sourceTable}.{sourceCol}
                                    </code>
                                  </span>
                                </div>
                                <div className="kpi-detail-item">
                                  <span className="kpi-detail-label">Child Table (Foreign Key)</span>
                                  <span className="kpi-detail-val">
                                    <code>
                                      {targetTable}.{targetCol}
                                    </code>
                                  </span>
                                </div>
                                <div className="kpi-detail-item" style={{ gridColumn: "span 2" }}>
                                  <span className="kpi-detail-label">Relational Evidence Statement</span>
                                  <span className="kpi-detail-val">
                                    <code>{rel.evidence || `${targetTable}.${targetCol} -> ${sourceTable}.${sourceCol}`}</code>
                                  </span>
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        )}

        {/* KPI 3: BUSINESS RELATIONSHIPS TABLE */}
        {selectedKpi === "business" && (
          <table className="kpi-table">
            <thead>
              <tr>
                <th style={{ width: "48px" }}></th>
                <th>Source Table</th>
                <th style={{ width: "32px", textAlign: "center" }}></th>
                <th>Target Table</th>
                <th>Business Semantics / Meaning</th>
                <th>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {filteredBusinessRelationships.length === 0 ? (
                <tr>
                  <td colSpan={6} className="kpi-table-empty">
                    No matching business relationships found for "{searchQuery}".
                  </td>
                </tr>
              ) : (
                filteredBusinessRelationships.map((rel, index) => {
                  const rowId = rel.id || `biz-${index}`;
                  const isExpanded = expandedRows.has(rowId);

                  const sourceTable = cleanNodeName(rel.source);
                  const targetTable = cleanNodeName(rel.target);
                  const sourceDb = rel.source_id || getNodeSourceId(rel.source) || "db1";
                  const label = rel.label || rel.business_relationship || "Business connection";

                  return (
                    <React.Fragment key={rowId}>
                      <tr className={`kpi-row ${isExpanded ? "expanded" : ""}`} onClick={() => toggleRow(rowId)}>
                        <td className="kpi-cell-toggle">
                          <span className={`kpi-chevron ${isExpanded ? "open" : ""}`}>▶</span>
                        </td>
                        <td className="kpi-cell-primary">
                          <span className={`kpi-source-badge ${getSourceBadgeClass(sourceDb)}`}>
                            {sourceDb.toUpperCase()}
                          </span>
                          <span className="kpi-entity-name">{sourceTable}</span>
                        </td>
                        <td className="kpi-cell-arrow">➔</td>
                        <td className="kpi-cell-primary">
                          <span className={`kpi-source-badge ${getSourceBadgeClass(sourceDb)}`}>
                            {sourceDb.toUpperCase()}
                          </span>
                          <span className="kpi-entity-name">{targetTable}</span>
                        </td>
                        <td>
                          <span className="kpi-biz-label">{label}</span>
                        </td>
                        <td>
                          <span className="kpi-confidence-pill">
                            {rel.confidence != null ? `${(rel.confidence * 100).toFixed(0)}%` : "100%"}
                          </span>
                        </td>
                      </tr>

                      {/* Expanded Row: Business Logic Reasoning & Evidence */}
                      {isExpanded && (
                        <tr className="kpi-expanded-row">
                          <td colSpan={6}>
                            <div className="kpi-attributes-wrapper">
                              <div className="kpi-attr-header">
                                <span className="kpi-attr-title">Validated Business Semantics</span>
                                <span className="kpi-dim-text">Source: {sourceDb.toUpperCase()}</span>
                              </div>

                              <div className="kpi-rel-detail-grid">
                                <div className="kpi-detail-item" style={{ gridColumn: "span 2" }}>
                                  <span className="kpi-detail-label">Business Meaning</span>
                                  <span className="kpi-detail-val" style={{ color: "var(--text)" }}>
                                    {label}
                                  </span>
                                </div>
                                {rel.reason && (
                                  <div className="kpi-detail-item" style={{ gridColumn: "span 2" }}>
                                    <span className="kpi-detail-label">Reasoning & Justification</span>
                                    <span className="kpi-detail-val">{rel.reason}</span>
                                  </div>
                                )}
                                {rel.evidence && (
                                  <div className="kpi-detail-item" style={{ gridColumn: "span 2" }}>
                                    <span className="kpi-detail-label">Evidence Traces</span>
                                    <span className="kpi-detail-val">
                                      {Array.isArray(rel.evidence) ? (
                                        <ul className="kpi-evidence-list">
                                          {rel.evidence.map((ev, i) => (
                                            <li key={i}>{ev}</li>
                                          ))}
                                        </ul>
                                      ) : (
                                        <code>{String(rel.evidence)}</code>
                                      )}
                                    </span>
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        )}

        {/* KPI 4: GRAPH CONNECTIONS TABLE (COMPLETE 236 EDGES) */}
        {selectedKpi === "connections" && (
          <table className="kpi-table">
            <thead>
              <tr>
                <th style={{ width: "48px" }}></th>
                <th>Source Node</th>
                <th style={{ width: "32px", textAlign: "center" }}></th>
                <th>Target Node</th>
                <th>Category</th>
                <th>Relationship Description</th>
                <th>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {filteredAllConnections.length === 0 ? (
                <tr>
                  <td colSpan={7} className="kpi-table-empty">
                    No matching graph connections found for "{searchQuery}".
                  </td>
                </tr>
              ) : (
                filteredAllConnections.map((conn, index) => {
                  const rowId = conn.id || `conn-${index}`;
                  const isExpanded = expandedRows.has(rowId);

                  const sourceNode = conn.source || "";
                  const targetNode = conn.target || "";
                  const sourceDb = getNodeSourceId(sourceNode) || conn.source_id || "db1";
                  const targetDb = getNodeSourceId(targetNode) || conn.target_source_id || sourceDb;

                  const relType = conn.relationship_type || conn.type || "";
                  const isDb = relType === "DATABASE_RELATIONSHIP" || conn.type === "database";
                  const isBiz = relType === "BUSINESS_RELATIONSHIP" || conn.type === "business";
                  const isCross = relType === "CROSS_SOURCE_RELATIONSHIP" || conn.type === "cross_source";

                  return (
                    <React.Fragment key={rowId}>
                      <tr className={`kpi-row ${isExpanded ? "expanded" : ""}`} onClick={() => toggleRow(rowId)}>
                        <td className="kpi-cell-toggle">
                          <span className={`kpi-chevron ${isExpanded ? "open" : ""}`}>▶</span>
                        </td>
                        <td className="kpi-cell-primary">
                          <span className={`kpi-source-badge ${getSourceBadgeClass(sourceDb)}`}>
                            {sourceDb.toUpperCase()}
                          </span>
                          <span className="kpi-entity-name">{cleanNodeName(sourceNode)}</span>
                        </td>
                        <td className="kpi-cell-arrow">➔</td>
                        <td className="kpi-cell-primary">
                          <span className={`kpi-source-badge ${getSourceBadgeClass(targetDb)}`}>
                            {targetDb.toUpperCase()}
                          </span>
                          <span className="kpi-entity-name">{cleanNodeName(targetNode)}</span>
                        </td>
                        <td>
                          {isDb && <span className="kpi-badge-database">Database FK</span>}
                          {isBiz && <span className="kpi-badge-business">Business</span>}
                          {isCross && <span className="kpi-badge-cross">Cross-Source</span>}
                          {!isDb && !isBiz && !isCross && <span className="kpi-type-badge">{relType}</span>}
                        </td>
                        <td>
                          <span className="kpi-conn-label">{conn.label || "Relationship edge"}</span>
                        </td>
                        <td>
                          <span className="kpi-confidence-pill">
                            {conn.confidence != null ? `${(conn.confidence * 100).toFixed(0)}%` : "—"}
                          </span>
                        </td>
                      </tr>

                      {/* Expanded Row: Complete Edge Metadata */}
                      {isExpanded && (
                        <tr className="kpi-expanded-row">
                          <td colSpan={7}>
                            <div className="kpi-attributes-wrapper">
                              <div className="kpi-attr-header">
                                <span className="kpi-attr-title">Graph Edge Metadata</span>
                                <span className="kpi-dim-text">
                                  ID: <code>{conn.id}</code>
                                </span>
                              </div>

                              <div className="kpi-rel-detail-grid">
                                <div className="kpi-detail-item">
                                  <span className="kpi-detail-label">Source Node</span>
                                  <span className="kpi-detail-val">
                                    <code>{conn.source}</code>
                                  </span>
                                </div>
                                <div className="kpi-detail-item">
                                  <span className="kpi-detail-label">Target Node</span>
                                  <span className="kpi-detail-val">
                                    <code>{conn.target}</code>
                                  </span>
                                </div>
                                {(conn.source_column || conn.target_column) && (
                                  <div className="kpi-detail-item" style={{ gridColumn: "span 2" }}>
                                    <span className="kpi-detail-label">Connecting Columns</span>
                                    <span className="kpi-detail-val">
                                      <code>
                                        {conn.source_column || "—"} ➔ {conn.target_column || "—"}
                                      </code>
                                    </span>
                                  </div>
                                )}
                                {conn.evidence && (
                                  <div className="kpi-detail-item" style={{ gridColumn: "span 2" }}>
                                    <span className="kpi-detail-label">Evidence / Link Specification</span>
                                    <span className="kpi-detail-val">
                                      {Array.isArray(conn.evidence) ? (
                                        <ul className="kpi-evidence-list">
                                          {conn.evidence.map((ev, i) => (
                                            <li key={i}>{ev}</li>
                                          ))}
                                        </ul>
                                      ) : (
                                        <code>{String(conn.evidence)}</code>
                                      )}
                                    </span>
                                  </div>
                                )}
                                {conn.reason && (
                                  <div className="kpi-detail-item" style={{ gridColumn: "span 2" }}>
                                    <span className="kpi-detail-label">Business Rationale</span>
                                    <span className="kpi-detail-val">{conn.reason}</span>
                                  </div>
                                )}
                                {conn.matching_identifier_count != null && (
                                  <div className="kpi-detail-item">
                                    <span className="kpi-detail-label">Matching Identifier Overlap</span>
                                    <span className="kpi-detail-val">
                                      {conn.matching_identifier_count} distinct matching records
                                    </span>
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
