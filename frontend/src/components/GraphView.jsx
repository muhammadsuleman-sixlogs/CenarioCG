import React, {
  useEffect,
  useMemo,
  useRef,
} from "react";

import CytoscapeComponent from "react-cytoscapejs";
import cytoscape from "cytoscape";
import fcose from "cytoscape-fcose";

cytoscape.use(fcose);

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

  if (source === "db1") {
    return "DB1";
  }

  if (source === "db2") {
    return "DB2";
  }

  if (source === "security_logs") {
    return "Security Logs";
  }

  if (source === "postgresql") {
    return "PostgreSQL";
  }

  return sourceId || "Unknown";
}

function GraphView({
  graphData,
  graphTrace,
  sourceTrace,
  loading,
  onEntitySelect,
}) {
  const cyRef = useRef(null);
  const timersRef = useRef([]);

  /*
   * -------------------------------------------------------
   * GRAPH DATA
   * -------------------------------------------------------
   */
  const elements = useMemo(() => {
    const nodes = (graphData?.nodes || []).map((node) => {
      const sourceId = getNodeSource(node);

      return {
        data: {
          id: String(node.id),

          label:
            node.label ||
            String(node.id),

          type:
            node.type ||
            "entity",

          source_id: sourceId,

          source_label: getSourceLabel(sourceId),

          columns:
            node.columns || [],

          primary_keys:
            node.primary_keys || [],
        },
      };
    });

    const edges = (graphData?.edges || []).map((edge) => ({
      data: {
        id: String(edge.id),

        source: String(edge.source),

        target: String(edge.target),

        label: edge.label || "",

        type:
          edge.type ||
          "database",

        relationship_type:
          edge.relationship_type || "",

        confidence:
          edge.confidence ?? null,

        source_column:
          edge.source_column || "",

        target_column:
          edge.target_column || "",
      },
    }));

    /*
     * External sources are separate from PostgreSQL
     * graph entities.
     */
    const externalSources =
      sourceTrace?.external_sources || [];

    const externalSourceNodes =
      externalSources
        .filter(
          (source) =>
            source &&
            source.id !== undefined &&
            source.id !== null
        )
        .map((source) => {
          const sourceId =
            `external-source:${String(source.id)}`;

          return {
            data: {
              id: sourceId,

              label:
                source.label ||
                String(source.id),

              type:
                source.type ||
                "external_source",

              source_id:
                String(source.id),

              source_label:
                source.label ||
                String(source.id),

              source_type:
                source.source_type || "",

              source:
                source.source || "",

              event_count:
                source.event_count || 0,

              truncated:
                source.truncated || false,
            },

            classes:
              "external-source",
          };
        });

    return [
      ...nodes,
      ...edges,
      ...externalSourceNodes,
    ];
  }, [graphData, sourceTrace]);

  /*
   * -------------------------------------------------------
   * TRACE NODE IDS
   * -------------------------------------------------------
   */
  const traceNodeIds = useMemo(() => {
    const ids = new Set();

    const candidates = [
      ...(graphTrace?.matched_graph_nodes || []),

      ...(graphTrace?.source_tables || []),

      ...(graphTrace?.source_entities || []),

      ...(graphTrace?.nodes || []).map(
        (node) => node.id
      ),
    ];

    candidates.forEach((id) => {
      if (id !== undefined && id !== null) {
        ids.add(String(id));
      }
    });

    /*
     * Also accept source-qualified IDs.
     *
     * If backend sends:
     *
     * db1:project_tasks
     *
     * it stays intact.
     */
    (graphTrace?.nodes || []).forEach((node) => {
      if (node?.id) {
        ids.add(String(node.id));
      }
    });

    /*
     * External source nodes.
     */
    (sourceTrace?.external_sources || []).forEach(
      (source) => {
        if (
          source &&
          source.id !== undefined &&
          source.id !== null
        ) {
          ids.add(
            `external-source:${String(source.id)}`
          );
        }
      }
    );

    return ids;
  }, [graphTrace, sourceTrace]);

  /*
   * -------------------------------------------------------
   * TRACE EDGES
   * -------------------------------------------------------
   */
  const traceEdgeIds = useMemo(() => {
    const ids = new Set();

    (graphTrace?.edges || []).forEach((edge) => {
      if (
        edge.id !== undefined &&
        edge.id !== null
      ) {
        ids.add(String(edge.id));
      }
    });

    return ids;
  }, [graphTrace]);

  /*
   * -------------------------------------------------------
   * CLEANUP
   * -------------------------------------------------------
   */
  const clearTimers = () => {
    timersRef.current.forEach(
      (timer) => clearTimeout(timer)
    );

    timersRef.current = [];
  };

  /*
   * -------------------------------------------------------
   * STYLES
   * -------------------------------------------------------
   */
  const stylesheet = [
    {
      selector: "node",

      style: {
        "background-color": "#172033",

        "border-color": "#334155",

        "border-width": 1,

        color: "#94a3b8",

        label: "data(label)",

        width: 48,

        height: 48,

        "font-size": 8,

        "font-weight": 500,

        "text-valign": "center",

        "text-halign": "center",

        "text-wrap": "ellipsis",

        "text-max-width": 42,

        opacity: 0.82,

        "z-index": 2,
      },
    },

    /*
     * DB1
     */
    {
      selector: 'node[source_id = "db1"]',

      style: {
        "background-color": "#172033",
        "border-color": "#475569",
      },
    },

    /*
     * DB2
     *
     * This styling does NOT claim anything about the
     * underlying database. It only visually separates
     * source systems.
     */
    {
      selector: 'node[source_id = "db2"]',

      style: {
        "background-color": "#18212b",
        "border-color": "#64748b",
      },
    },

    /*
     * Unknown/unqualified source.
     */
    {
      selector: 'node[source_id = "unknown"]',

      style: {
        "background-color": "#172033",
        "border-color": "#334155",
      },
    },

    /*
     * External source.
     */
    {
      selector: "node.external-source",

      style: {
        "background-color": "#0f172a",

        "border-color": "#38bdf8",

        "border-width": 2,

        color: "#e0f2fe",

        width: 62,

        height: 62,

        "font-size": 9,

        "font-weight": 700,

        "text-valign": "center",

        "text-halign": "center",

        "text-wrap": "wrap",

        "text-max-width": 52,

        opacity: 0.95,

        "z-index": 5,
      },
    },

    /*
     * Normal edge.
     */
    {
      selector: "edge",

      style: {
        width: 0.8,

        "line-color": "#334155",

        "target-arrow-color": "#334155",

        "target-arrow-shape": "triangle",

        "curve-style": "bezier",

        opacity: 0.22,

        label: "",

        "z-index": 1,
      },
    },

    /*
     * Trace node.
     */
    {
      selector: ".trace-node",

      style: {
        "background-color": "#facc15",

        "border-color": "#fef08a",

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

    /*
     * External trace node.
     */
    {
      selector:
        "node.external-source.trace-node",

      style: {
        "background-color": "#0f172a",

        "border-color": "#38bdf8",

        "border-width": 4,

        color: "#e0f2fe",

        width: 74,

        height: 74,

        "font-size": 10,

        "font-weight": 700,

        "shadow-blur": 24,

        "shadow-color": "#38bdf8",

        "shadow-opacity": 1,

        "z-index": 200,
      },
    },

    /*
     * Trace edge.
     */
    {
      selector: ".trace-edge",

      style: {
        width: 3,

        "line-color": "#facc15",

        "target-arrow-color": "#facc15",

        "target-arrow-shape": "triangle",

        opacity: 1,

        label: "data(label)",

        color: "#fde68a",

        "font-size": 8,

        "font-weight": 700,

        "text-rotation": "autorotate",

        "text-background-color": "#070b11",

        "text-background-opacity": 0.95,

        "text-background-padding": "3px",

        "z-index": 90,
      },
    },

    /*
     * Active bulb.
     */
    {
      selector: ".trace-active",

      style: {
        "background-color": "#fde047",

        "border-color": "#ffffff",

        "border-width": 4,

        width: 76,

        height: 76,

        "font-size": 11,

        "shadow-blur": 28,

        "shadow-color": "#facc15",

        "shadow-opacity": 1,

        "shadow-offset-x": 0,

        "shadow-offset-y": 0,

        "z-index": 200,
      },
    },

    /*
     * Active edge.
     */
    {
      selector: ".trace-edge-active",

      style: {
        width: 5,

        "line-color": "#fde047",

        "target-arrow-color": "#fde047",

        opacity: 1,

        "shadow-blur": 16,

        "shadow-color": "#facc15",

        "shadow-opacity": 1,

        "z-index": 150,
      },
    },

    /*
     * Thinking edge.
     */
    {
      selector: ".thinking-edge",

      style: {
        width: 2,

        "line-color": "#64748b",

        "target-arrow-color": "#64748b",

        opacity: 0.45,

        "z-index": 20,
      },
    },

    /*
     * Thinking node.
     */
    {
      selector: ".thinking-node",

      style: {
        "border-color": "#64748b",

        "border-width": 2,

        opacity: 0.9,

        "z-index": 30,
      },
    },
  ];

  /*
   * -------------------------------------------------------
   * LAYOUT
   * -------------------------------------------------------
   */
  const runLayout = () => {
    const cy = cyRef.current;

    if (!cy) {
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

  /*
   * -------------------------------------------------------
   * CYTOSCAPE READY
   * -------------------------------------------------------
   */
  const handleCyReady = (cy) => {
    cyRef.current = cy;

    runLayout();

    cy.on(
      "tap",
      "node",
      (event) => {
        const node = event.target;

        if (!onEntitySelect) {
          return;
        }

        onEntitySelect({
          id: node.id(),

          label:
            node.data("label"),

          type:
            node.data("type"),

          source_id:
            node.data("source_id") ||
            "unknown",

          source_label:
            node.data("source_label") ||
            getSourceLabel(
              node.data("source_id")
            ),

          columns:
            node.data("columns") || [],

          primary_keys:
            node.data("primary_keys") || [],

          source_type:
            node.data("source_type") || "",

          source:
            node.data("source") || "",

          event_count:
            node.data("event_count") || 0,

          truncated:
            node.data("truncated") || false,
        });
      }
    );
  };

  /*
   * -------------------------------------------------------
   * THINKING
   * -------------------------------------------------------
   */
  const startThinkingAnimation = () => {
    const cy = cyRef.current;

    if (!cy) {
      return;
    }

    clearTimers();

    cy.elements().removeClass(
      "trace-node",
      "trace-edge",
      "trace-active",
      "trace-edge-active",
      "thinking-node",
      "thinking-edge"
    );

    cy.nodes().style({
      opacity: 0.82,
    });

    cy.edges().style({
      opacity: 0.22,
      label: "",
    });

    let edgeIndex = 0;

    const edges = cy.edges().toArray();

    const pulse = () => {
      if (!loading) {
        return;
      }

      if (edges.length === 0) {
        return;
      }

      const edge =
        edges[
          edgeIndex % edges.length
        ];

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

  /*
   * -------------------------------------------------------
   * FINAL TRACE
   * -------------------------------------------------------
   */
  const showFinalTrace = () => {
    const cy = cyRef.current;

    if (!cy) {
      return;
    }

    clearTimers();

    cy.elements().removeClass(
      "thinking-node",
      "thinking-edge",
      "trace-node",
      "trace-edge",
      "trace-active",
      "trace-edge-active"
    );

    cy.nodes().style({
      opacity: 0.10,
    });

    cy.edges().style({
      opacity: 0.035,
      label: "",
    });

    const traceNodes = [];

    cy.nodes().forEach((node) => {
      if (traceNodeIds.has(node.id())) {
        traceNodes.push(node);

        node.addClass("trace-node");

        node.style({
          opacity: 1,
        });
      }
    });

    cy.edges().forEach((edge) => {
      if (traceEdgeIds.has(edge.id())) {
        edge.addClass("trace-edge");

        edge.style({
          opacity: 1,
        });
      }
    });

    if (traceNodes.length) {
      const collection =
        cy.collection(traceNodes);

      cy.animate(
        {
          fit: {
            eles: collection,
            padding: 150,
          },
        },
        {
          duration: 900,
        }
      );
    }

    traceNodes.forEach((node, index) => {
      const timer = setTimeout(() => {
        cy.nodes().removeClass(
          "trace-active"
        );

        cy.edges().removeClass(
          "trace-edge-active"
        );

        node.addClass("trace-active");

        node.connectedEdges().forEach(
          (edge) => {
            if (
              traceEdgeIds.has(edge.id())
            ) {
              edge.addClass(
                "trace-edge-active"
              );
            }
          }
        );
      }, index * 650);

      timersRef.current.push(timer);
    });

    const finalTimer = setTimeout(
      () => {
        cy.nodes().removeClass(
          "trace-active"
        );

        traceNodes.forEach((node) => {
          node.addClass("trace-node");
        });

        cy.edges().removeClass(
          "trace-edge-active"
        );

        cy.edges().forEach((edge) => {
          if (traceEdgeIds.has(edge.id())) {
            edge.addClass("trace-edge");
          }
        });
      },
      Math.max(
        traceNodes.length * 650,
        1000
      ) + 300
    );

    timersRef.current.push(finalTimer);
  };

  /*
   * -------------------------------------------------------
   * QUESTION STARTED
   * -------------------------------------------------------
   */
  useEffect(() => {
    if (loading) {
      startThinkingAnimation();
    }

    return () => {
      clearTimers();
    };
  }, [loading]);

  /*
   * -------------------------------------------------------
   * ANSWER ARRIVED
   * -------------------------------------------------------
   */
  useEffect(() => {
    if (
      !loading &&
      graphTrace &&
      (
        traceNodeIds.size > 0 ||
        traceEdgeIds.size > 0
      )
    ) {
      showFinalTrace();
    }
  }, [
    loading,
    graphTrace,
    sourceTrace,
    traceNodeIds,
    traceEdgeIds,
  ]);

  /*
   * -------------------------------------------------------
   * CLEANUP
   * -------------------------------------------------------
   */
  useEffect(() => {
    return () => {
      clearTimers();
    };
  }, []);

  const sourceCount =
    traceNodeIds.size;

  const externalSourceCount =
    (sourceTrace?.external_sources || [])
      .length;

  const graphSourceCount =
    new Set(
      (graphData?.nodes || []).map(
        (node) => getNodeSource(node)
      )
    ).size;

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: 560,
        background: "#070b11",
        border: "1px solid #1e293b",
        borderRadius: 16,
        overflow: "hidden",
      }}
    >
      <CytoscapeComponent
        elements={elements}
        stylesheet={stylesheet}
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
          padding: "10px 14px",
          background:
            "rgba(7, 11, 17, 0.88)",
          border:
            "1px solid #243044",
          borderRadius: 10,
          backdropFilter:
            "blur(10px)",
          zIndex: 50,
        }}
      >
        <div
          style={{
            color: "#e2e8f0",
            fontSize: 13,
            fontWeight: 700,
          }}
        >
          Context Graph
        </div>

        <div
          style={{
            marginTop: 3,
            color: "#64748b",
            fontSize: 10,
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
              marginTop: 4,
              color: "#94a3b8",
              fontSize: 9,
              fontWeight: 600,
            }}
          >
            {graphSourceCount} data source
            {graphSourceCount === 1
              ? ""
              : "s"}
          </div>
        )}

        {externalSourceCount > 0 &&
          !loading && (
            <div
              style={{
                marginTop: 4,
                color: "#38bdf8",
                fontSize: 9,
                fontWeight: 600,
              }}
            >
              {externalSourceCount} external source
              {externalSourceCount === 1
                ? ""
                : "s"}
            </div>
          )}
      </div>

      {/* SOURCE LEGEND */}
      <div
        className="graph-source-legend"
      >
        <span>
          <i className="source-dot db1" />
          DB1
        </span>

        <span>
          <i className="source-dot db2" />
          DB2
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
          gap: 5,
          zIndex: 60,
        }}
      >
        <button
          className="graph-control-button"
          onClick={() => {
            const cy = cyRef.current;

            if (!cy) {
              return;
            }

            cy.zoom({
              level: Math.min(
                cy.zoom() * 1.2,
                3
              ),
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
          className="graph-control-button"
          onClick={() => {
            const cy = cyRef.current;

            if (!cy) {
              return;
            }

            cy.zoom({
              level: Math.max(
                cy.zoom() / 1.2,
                0.15
              ),
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
          className="graph-control-button fit-button"
          onClick={() => {
            const cy = cyRef.current;

            if (!cy) {
              return;
            }

            cy.fit(undefined, 70);
          }}
        >
          Fit
        </button>
      </div>
    </div>
  );
}

export default GraphView;