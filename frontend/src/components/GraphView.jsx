import React, { useEffect, useMemo, useRef } from "react";

import CytoscapeComponent from "react-cytoscapejs";
import cytoscape from "cytoscape";
import fcose from "cytoscape-fcose";

cytoscape.use(fcose);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function getNodeSource(node) {
  if (node?.source_id) {
    return String(node.source_id);
  }

  const id = String(node?.id || "");

  if (id.includes(":")) {
    return id.split(":")[0];
  }

  return "unknown";
}

function getSourceLabel(sourceId) {
  const source = String(sourceId || "").toLowerCase();

  if (source === "db1") return "Base DB";
  if (source === "db2") return "Companion DB";
  if (source === "security_logs") return "Security Logs";
  if (source === "postgresql") return "PostgreSQL";

  return sourceId || "Unknown";
}

const TRACE_CLASSES =
  "trace-node trace-edge trace-active trace-edge-active thinking-node thinking-edge entity-selected entity-selected-edge";

/* ------------------------------------------------------------------ */
/* Cenario theme                                                       */
/*                                                                     */
/* Defined at module level so the stylesheet keeps a stable identity   */
/* and react-cytoscapejs does not re-apply it on every render (which   */
/* would fight with the inline opacity changes used by the trace).     */
/* ------------------------------------------------------------------ */

const STYLESHEET = [
  {
    selector: "node",
    style: {
      "background-color": "#171b22",
      "border-color": "#2a303b",
      "border-width": 1,
      color: "#cbd5e1",
      label: "data(label)",
      width: 48,
      height: 48,
      "font-family": "Inter, sans-serif",
      "font-size": 8,
      "font-weight": 500,
      "text-valign": "center",
      "text-halign": "center",
      "text-wrap": "ellipsis",
      "text-max-width": 42,
      opacity: 0.85,
      "z-index": 2,
    },
  },

  /* DB1 - cyan */
  {
    selector: 'node[source_id = "db1"]',
    style: {
      "background-color": "#0c2a3d",
      "border-color": "#0ea5e9",
    },
  },

  /* DB2 - green */
  {
    selector: 'node[source_id = "db2"]',
    style: {
      "background-color": "#0b2e26",
      "border-color": "#10b981",
    },
  },

  /* Unknown source */
  {
    selector: 'node[source_id = "unknown"]',
    style: {
      "background-color": "#171b22",
      "border-color": "#2a303b",
    },
  },

  /* External source - purple */
  {
    selector: "node.external-source",
    style: {
      "background-color": "#211a3d",
      "border-color": "#8b5cf6",
      "border-width": 2,
      color: "#ede9fe",
      width: 62,
      height: 62,
      "font-size": 9,
      "font-weight": 700,
      "text-wrap": "wrap",
      "text-max-width": 52,
      opacity: 0.95,
      "z-index": 5,
    },
  },

  /* Normal edge */
  {
    selector: "edge",
    style: {
      width: 0.8,
      "line-color": "#2a303b",
      "target-arrow-color": "#2a303b",
      "target-arrow-shape": "triangle",
      "curve-style": "bezier",
      opacity: 0.35,
      label: "",
      "z-index": 1,
    },
  },

  /* Trace node */
  {
    selector: ".trace-node",
    style: {
      "background-color": "#0ea5e9",
      "border-color": "#7dd3fc",
      "border-width": 3,
      color: "#ffffff",
      width: 66,
      height: 66,
      "font-size": 10,
      "font-weight": 700,
      opacity: 1,
      "text-wrap": "wrap",
      "text-max-width": 58,
      "z-index": 100,
    },
  },

  /* External trace node */
  {
    selector: "node.external-source.trace-node",
    style: {
      "background-color": "#211a3d",
      "border-color": "#a78bfa",
      "border-width": 4,
      color: "#ede9fe",
      width: 74,
      height: 74,
      "font-size": 10,
      "font-weight": 700,
      "shadow-blur": 24,
      "shadow-color": "#8b5cf6",
      "shadow-opacity": 1,
      "shadow-offset-x": 0,
      "shadow-offset-y": 0,
      "z-index": 200,
    },
  },

  /* Trace edge */
  {
    selector: ".trace-edge",
    style: {
      width: 3,
      "line-color": "#0ea5e9",
      "target-arrow-color": "#0ea5e9",
      "target-arrow-shape": "triangle",
      opacity: 1,
      label: "data(label)",
      color: "#7dd3fc",
      "font-size": 8,
      "font-weight": 700,
      "text-rotation": "autorotate",
      "text-background-color": "#0a0d12",
      "text-background-opacity": 0.95,
      "text-background-padding": "3px",
      "z-index": 90,
    },
  },

  /* Active node (moving light) */
  {
    selector: ".trace-active",
    style: {
      "background-color": "#38bdf8",
      "border-color": "#ffffff",
      "border-width": 4,
      width: 76,
      height: 76,
      "font-size": 11,
      "shadow-blur": 28,
      "shadow-color": "#0ea5e9",
      "shadow-opacity": 1,
      "shadow-offset-x": 0,
      "shadow-offset-y": 0,
      "z-index": 200,
    },
  },

  /* Active edge */
  {
    selector: ".trace-edge-active",
    style: {
      width: 5,
      "line-color": "#38bdf8",
      "target-arrow-color": "#38bdf8",
      opacity: 1,
      "shadow-blur": 16,
      "shadow-color": "#0ea5e9",
      "shadow-opacity": 1,
      "z-index": 150,
    },
  },

  /* Thinking edge */
  {
    selector: ".thinking-edge",
    style: {
      width: 2,
      "line-color": "#0ea5e9",
      "target-arrow-color": "#0ea5e9",
      opacity: 0.6,
      "z-index": 20,
    },
  },

  /* Thinking node */
  {
    selector: ".thinking-node",
    style: {
      "border-color": "#0ea5e9",
      "border-width": 2,
      opacity: 0.9,
      "z-index": 30,
    },
  },

  /* Selected entity via KPI click or graph tap */
  {
    selector: ".entity-selected",
    style: {
      "border-color": "#38bdf8",
      "border-width": 4,
      width: 68,
      height: 68,
      "shadow-blur": 24,
      "shadow-color": "#0ea5e9",
      "shadow-opacity": 1,
      opacity: 1,
      "z-index": 210,
    },
  },
  {
    selector: ".entity-selected-edge",
    style: {
      width: 3.5,
      "line-color": "#38bdf8",
      "target-arrow-color": "#38bdf8",
      opacity: 1,
      "shadow-blur": 12,
      "shadow-color": "#0ea5e9",
      "shadow-opacity": 0.8,
      "z-index": 160,
    },
  },
];

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

function GraphView({
  graphData,
  graphTrace,
  sourceTrace,
  selectedEntity,
  loading,
  onEntitySelect,
}) {
  const cyRef = useRef(null);
  const timersRef = useRef([]);
  const loadingRef = useRef(loading);
  const onEntitySelectRef = useRef(onEntitySelect);

  /* Keep refs current so long-lived callbacks never go stale. */
  loadingRef.current = loading;
  onEntitySelectRef.current = onEntitySelect;

  /* ---------------------------------------------------------------- */
  /* Graph elements                                                    */
  /* ---------------------------------------------------------------- */
  const elements = useMemo(() => {
    const nodes = (graphData?.nodes || []).map((node) => {
      const sourceId = getNodeSource(node);

      return {
        data: {
          id: String(node.id),
          label: node.label || String(node.id),
          type: node.type || "entity",
          source_id: sourceId,
          source_label: getSourceLabel(sourceId),
          columns: node.columns || [],
          primary_keys: node.primary_keys || [],
        },
      };
    });

    const edges = (graphData?.edges || []).map((edge) => ({
      data: {
        id: String(edge.id),
        source: String(edge.source),
        target: String(edge.target),
        label: edge.label || "",
        type: edge.type || "database",
        relationship_type: edge.relationship_type || "",
        confidence: edge.confidence ?? null,
        source_column: edge.source_column || "",
        target_column: edge.target_column || "",
      },
    }));

    /* External sources are separate from PostgreSQL graph entities. */
    const externalSourceNodes = (sourceTrace?.external_sources || [])
      .filter(
        (source) =>
          source && source.id !== undefined && source.id !== null
      )
      .map((source) => ({
        data: {
          id: `external-source:${String(source.id)}`,
          label: source.label || String(source.id),
          type: source.type || "external_source",
          source_id: String(source.id),
          source_label: source.label || String(source.id),
          source_type: source.source_type || "",
          source: source.source || "",
          event_count: source.event_count || 0,
          truncated: source.truncated || false,
        },
        classes: "external-source",
      }));

    return [...nodes, ...edges, ...externalSourceNodes];
  }, [graphData, sourceTrace]);

  /* ---------------------------------------------------------------- */
  /* Trace node / edge ids                                             */
  /* ---------------------------------------------------------------- */
  const traceNodeIds = useMemo(() => {
    const ids = new Set();

    const candidates = [
      ...(graphTrace?.matched_graph_nodes || []),
      ...(graphTrace?.source_tables || []),
      ...(graphTrace?.source_entities || []),
      ...(graphTrace?.nodes || []).map((node) => node?.id),
    ];

    candidates.forEach((id) => {
      if (id !== undefined && id !== null) {
        ids.add(String(id));
      }
    });

    (sourceTrace?.external_sources || []).forEach((source) => {
      if (source && source.id !== undefined && source.id !== null) {
        ids.add(`external-source:${String(source.id)}`);
      }
    });

    return ids;
  }, [graphTrace, sourceTrace]);

  const traceEdgeIds = useMemo(() => {
    const ids = new Set();

    (graphTrace?.edges || []).forEach((edge) => {
      if (edge?.id !== undefined && edge?.id !== null) {
        ids.add(String(edge.id));
      }
    });

    return ids;
  }, [graphTrace]);

  /* ---------------------------------------------------------------- */
  /* Timers                                                            */
  /* ---------------------------------------------------------------- */
  const clearTimers = () => {
    timersRef.current.forEach((timer) => clearTimeout(timer));
    timersRef.current = [];
  };

  /* ---------------------------------------------------------------- */
  /* Layout                                                            */
  /* ---------------------------------------------------------------- */
  const runLayout = () => {
    const cy = cyRef.current;

    if (!cy || cy.destroyed() || cy.nodes().length === 0) {
      return;
    }

    cy.layout({
      name: "fcose",
      quality: "proof",
      randomize: true,
      animate: false,
      fit: true,
      padding: 90,
      nodeDimensionsIncludeLabels: true,
      nodeRepulsion: 9000,
      idealEdgeLength: 150,
      edgeElasticity: 0.25,
      gravity: 0.12,
      gravityRange: 3.8,
      numIter: 2500,
      tile: true,
      tilingPaddingHorizontal: 60,
      tilingPaddingVertical: 60,
    }).run();

    cy.fit(undefined, 70);
  };

  /* ---------------------------------------------------------------- */
  /* Cytoscape ready (stable attachment once only)                    */
  /* ---------------------------------------------------------------- */
  const handleCyReady = (cy) => {
    if (cyRef.current === cy) {
      return;
    }

    cyRef.current = cy;

    cy.on("tap", "node", (event) => {
      const node = event.target;
      const handler = onEntitySelectRef.current;

      if (!handler) {
        return;
      }

      handler({
        id: node.id(),
        label: node.data("label"),
        type: node.data("type"),
        source_id: node.data("source_id") || "unknown",
        source_label:
          node.data("source_label") ||
          getSourceLabel(node.data("source_id")),
        columns: node.data("columns") || [],
        primary_keys: node.data("primary_keys") || [],
        source_type: node.data("source_type") || "",
        source: node.data("source") || "",
        event_count: node.data("event_count") || 0,
        truncated: node.data("truncated") || false,
      });
    });
  };

  /* ---------------------------------------------------------------- */
  /* Reset visual state                                                */
  /* ---------------------------------------------------------------- */
  const resetVisualState = (cy) => {
    /* removeClass takes ONE space-separated string. */
    cy.elements().removeClass(TRACE_CLASSES);

    /* Drop inline overrides so the stylesheet applies again. */
    cy.nodes().removeStyle("opacity");
    cy.edges().removeStyle("opacity label");
  };

  /* ---------------------------------------------------------------- */
  /* Thinking animation                                                */
  /* ---------------------------------------------------------------- */
  const startThinkingAnimation = () => {
    const cy = cyRef.current;

    if (!cy || cy.destroyed()) {
      return;
    }

    clearTimers();
    resetVisualState(cy);

    let edgeIndex = 0;
    const edges = cy.edges().toArray();

    const pulse = () => {
      if (!loadingRef.current || edges.length === 0) {
        return;
      }

      const edge = edges[edgeIndex % edges.length];

      edge.addClass("thinking-edge");

      const timer = setTimeout(() => {
        edge.removeClass("thinking-edge");
        edgeIndex += 1;
        pulse();
      }, 90);

      timersRef.current.push(timer);
    };

    pulse();
  };

  /* ---------------------------------------------------------------- */
  /* Final trace                                                       */
  /* ---------------------------------------------------------------- */
  const showFinalTrace = () => {
    const cy = cyRef.current;

    if (!cy || cy.destroyed()) {
      return;
    }

    clearTimers();
    resetVisualState(cy);

    // Keep the complete graph visible! Dim non-relevant nodes slightly so trace glows
    cy.nodes().style({ opacity: 0.35 });
    cy.edges().style({ opacity: 0.15, label: "" });

    const traceNodes = [];

    cy.nodes().forEach((node) => {
      if (traceNodeIds.has(node.id())) {
        traceNodes.push(node);
        node.addClass("trace-node");
        node.style({ opacity: 1 });
      }
    });

    cy.edges().forEach((edge) => {
      if (traceEdgeIds.has(edge.id())) {
        edge.addClass("trace-edge");
        edge.style({ opacity: 1 });
      }
    });

    if (traceNodes.length) {
      cy.animate(
        {
          fit: {
            eles: cy.collection(traceNodes),
            padding: 150,
          },
        },
        { duration: 900 }
      );
    }

    traceNodes.forEach((node, index) => {
      const timer = setTimeout(() => {
        if (cy.destroyed()) {
          return;
        }

        cy.nodes().removeClass("trace-active");
        cy.edges().removeClass("trace-edge-active");

        node.addClass("trace-active");

        node.connectedEdges().forEach((edge) => {
          if (traceEdgeIds.has(edge.id())) {
            edge.addClass("trace-edge-active");
          }
        });
      }, index * 650);

      timersRef.current.push(timer);
    });

    const finalTimer = setTimeout(
      () => {
        if (cy.destroyed()) {
          return;
        }

        cy.nodes().removeClass("trace-active");
        cy.edges().removeClass("trace-edge-active");
      },
      Math.max(traceNodes.length * 650, 1000) + 300
    );

    timersRef.current.push(finalTimer);
  };

  /* ---------------------------------------------------------------- */
  /* Effects                                                           */
  /* ---------------------------------------------------------------- */

  const graphFingerprintRef = useRef("");

  /* Re-layout ONLY when actual graph dataset changes (initial load or new schema) */
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || cy.destroyed()) {
      return;
    }

    const nodes = graphData?.nodes || [];
    const edges = graphData?.edges || [];
    if (nodes.length === 0) {
      return;
    }

    const currentFingerprint = `${nodes.length}-${edges.length}-${nodes[0]?.id}`;

    // Only load elements into Cytoscape and compute layout if not loaded yet or data changed!
    if (graphFingerprintRef.current !== currentFingerprint) {
      graphFingerprintRef.current = currentFingerprint;

      clearTimers();

      cy.batch(() => {
        cy.elements().remove();
        if (elements.length > 0) {
          cy.add(elements);
        }
      });

      resetVisualState(cy);
      runLayout();
    }
  }, [graphData, elements]);

  /* Handle entity selection from KPI table, graph tap, or external selection */
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || cy.destroyed()) return;

    cy.elements().removeClass("entity-selected entity-selected-edge");

    if (!selectedEntity) {
      return;
    }

    const targetId = String(selectedEntity.id || "");
    const matchingNode = cy.getElementById(targetId);

    if (matchingNode.length > 0) {
      matchingNode.addClass("entity-selected");
      matchingNode.connectedEdges().addClass("entity-selected-edge");

      // Smoothly pan/center onto the node without changing layout or recreating anything
      cy.animate(
        {
          center: { eles: matchingNode },
        },
        { duration: 400 }
      );
    }
  }, [selectedEntity]);

  /* Question started: clear previous highlights immediately, keep graph stable */
  useEffect(() => {
    if (loading) {
      const cy = cyRef.current;
      if (cy && !cy.destroyed()) {
        clearTimers();
        resetVisualState(cy);
      }
    }
    return () => {
      clearTimers();
    };
  }, [loading]);

  /* Final trace applied when LLM answer arrives, or cleared when trace is empty */
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || cy.destroyed()) {
      return;
    }

    // Only apply highlights when NOT loading and an actual answer trace exists
    if (
      !loading &&
      graphTrace &&
      (traceNodeIds.size > 0 || traceEdgeIds.size > 0)
    ) {
      showFinalTrace();
    } else if (!loading) {
      // Clear previous answer's highlights and return to original full/default state
      clearTimers();
      resetVisualState(cy);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, graphTrace, traceNodeIds, traceEdgeIds]);

  /* Unmount cleanup */
  useEffect(() => {
    return () => {
      clearTimers();
    };
  }, []);

  /* ---------------------------------------------------------------- */
  /* Status counts                                                     */
  /* ---------------------------------------------------------------- */
  const sourceCount = traceNodeIds.size;

  const externalSourceCount = (sourceTrace?.external_sources || []).length;

  const graphSourceCount = new Set(
    (graphData?.nodes || []).map((node) => getNodeSource(node))
  ).size;

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */
  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: 560,
        background: "#0a0d12",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        borderRadius: 18,
        overflow: "hidden",
      }}
    >
      <CytoscapeComponent
        key="cenario-context-graph-canvas"
        elements={elements}
        stylesheet={STYLESHEET}
        cy={handleCyReady}
        style={{
          width: "100%",
          height: "100%",
        }}
      />

      {/* GRAPH STATUS */}
      <div
        style={{
          position: "absolute",
          left: 18,
          top: 18,
          padding: "11px 15px",
          background: "rgba(18, 21, 27, 0.9)",
          border: "1px solid rgba(255, 255, 255, 0.08)",
          borderRadius: 12,
          backdropFilter: "blur(10px)",
          zIndex: 50,
        }}
      >
        <div
          style={{
            color: "#f1f5f9",
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          Context Graph
        </div>

        <div
          style={{
            marginTop: 3,
            color: "#8b95a5",
            fontSize: 12,
          }}
        >
          {loading
            ? "Tracing connected sources..."
            : sourceCount > 0
              ? `${sourceCount} retrieved nodes`
              : `${graphData?.nodes?.length || 0} entities`}
        </div>

        {!loading && graphSourceCount > 0 && (
          <div
            style={{
              marginTop: 5,
              color: "#cbd5e1",
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {graphSourceCount} data source
            {graphSourceCount === 1 ? "" : "s"}
          </div>
        )}

        {externalSourceCount > 0 && !loading && (
          <div
            style={{
              marginTop: 4,
              color: "#8b5cf6",
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {externalSourceCount} external source
            {externalSourceCount === 1 ? "" : "s"}
          </div>
        )}
      </div>

      {/* SOURCE LEGEND */}
      <div className="graph-source-legend">
        <span>
          <i className="source-dot db1" />
          Base DB
        </span>

        <span>
          <i className="source-dot db2" />
          Companion DB
        </span>

        <span>
          <i className="source-dot external" />
          External
        </span>
      </div>

      {/* CONTROLS */}
      <div
        style={{
          position: "absolute",
          right: 18,
          bottom: 18,
          display: "flex",
          flexDirection: "column",
          gap: 6,
          zIndex: 60,
        }}
      >
        <button
          type="button"
          className="graph-control-button"
          aria-label="Zoom in"
          onClick={() => {
            const cy = cyRef.current;

            if (!cy) return;

            cy.zoom({
              level: Math.min(cy.zoom() * 1.2, 3),
              renderedPosition: {
                x: cy.width() / 2,
                y: cy.height() / 2,
              },
            });
          }}
        >
          +
        </button>

        <button
          type="button"
          className="graph-control-button"
          aria-label="Zoom out"
          onClick={() => {
            const cy = cyRef.current;

            if (!cy) return;

            cy.zoom({
              level: Math.max(cy.zoom() / 1.2, 0.15),
              renderedPosition: {
                x: cy.width() / 2,
                y: cy.height() / 2,
              },
            });
          }}
        >
          −
        </button>

        <button
          type="button"
          className="graph-control-button fit-button"
          aria-label="Fit graph to view"
          onClick={() => {
            const cy = cyRef.current;

            if (!cy) return;

            cy.fit(undefined, 70);
          }}
        >
          Fit
        </button>
      </div>
    </div>
  );
}

export default React.memo(GraphView);
