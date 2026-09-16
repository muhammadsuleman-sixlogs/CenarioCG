import React, {
    useEffect,
    useMemo,
    useRef,
  } from "react";
  
  import CytoscapeComponent from "react-cytoscapejs";
  import cytoscape from "cytoscape";
  import fcose from "cytoscape-fcose";
  
  cytoscape.use(fcose);
  
  function GraphView({
    graphData,
    graphTrace,
    loading,
    onEntitySelect,
  }) {
    const cyRef = useRef(null);
    const timersRef = useRef([]);
  
    /*
     * -------------------------------------------------------
     * REAL GRAPH DATA
     * -------------------------------------------------------
     */
  
    const elements = useMemo(() => {
      const nodes = (graphData?.nodes || []).map(
        (node) => ({
          data: {
            id: String(node.id),
            label:
              node.label ||
              String(node.id),
            type:
              node.type ||
              "entity",
          },
        })
      );
  
      const edges = (graphData?.edges || []).map(
        (edge) => ({
          data: {
            id: String(edge.id),
            source: String(edge.source),
            target: String(edge.target),
            label: edge.label || "",
            type:
              edge.type ||
              "database",
          },
        })
      );
  
      return [
        ...nodes,
        ...edges,
      ];
    }, [graphData]);
  
    /*
     * -------------------------------------------------------
     * ACTUAL SOURCE ENTITIES
     *
     * These come from backend provenance.
     * Nothing is hardcoded here.
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
  
      return ids;
    }, [graphTrace]);
  
    /*
     * -------------------------------------------------------
     * ACTUAL TRACE EDGES
     * -------------------------------------------------------
     */
  
    const traceEdgeIds = useMemo(() => {
      const ids = new Set();
  
      (graphTrace?.edges || []).forEach(
        (edge) => {
          if (
            edge.id !== undefined &&
            edge.id !== null
          ) {
            ids.add(String(edge.id));
          }
        }
      );
  
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
     * BASE GRAPH
     * -------------------------------------------------------
     */
  
    const stylesheet = [
      /*
       * NORMAL NODE
       */
      {
        selector: "node",
  
        style: {
          "background-color":
            "#172033",
  
          "border-color":
            "#334155",
  
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
       * NORMAL EDGE
       *
       * IMPORTANT:
       * Don't show 79 relationship labels simultaneously.
       */
      {
        selector: "edge",
  
        style: {
          width: 0.8,
  
          "line-color":
            "#334155",
  
          "target-arrow-color":
            "#334155",
  
          "target-arrow-shape":
            "triangle",
  
          "curve-style":
            "bezier",
  
          opacity: 0.22,
  
          label: "",
  
          "z-index": 1,
        },
      },
  
      /*
       * TRACE NODE
       */
      {
        selector: ".trace-node",
  
        style: {
          "background-color":
            "#facc15",
  
          "border-color":
            "#fef08a",
  
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
       * TRACE EDGE
       */
      {
        selector: ".trace-edge",
  
        style: {
          width: 3,
  
          "line-color":
            "#facc15",
  
          "target-arrow-color":
            "#facc15",
  
          "target-arrow-shape":
            "triangle",
  
          opacity: 1,
  
          label: "data(label)",
  
          color: "#fde68a",
  
          "font-size": 8,
  
          "font-weight": 700,
  
          "text-rotation":
            "autorotate",
  
          "text-background-color":
            "#070b11",
  
          "text-background-opacity": 0.95,
  
          "text-background-padding":
            "3px",
  
          "z-index": 90,
        },
      },
  
      /*
       * ACTIVE BULB
       */
      {
        selector: ".trace-active",
  
        style: {
          "background-color":
            "#fde047",
  
          "border-color":
            "#ffffff",
  
          "border-width": 4,
  
          width: 76,
          height: 76,
  
          "font-size": 11,
  
          "shadow-blur": 28,
  
          "shadow-color":
            "#facc15",
  
          "shadow-opacity": 1,
  
          "shadow-offset-x": 0,
          "shadow-offset-y": 0,
  
          "z-index": 200,
        },
      },
  
      /*
       * ACTIVE EDGE
       */
      {
        selector: ".trace-edge-active",
  
        style: {
          width: 5,
  
          "line-color":
            "#fde047",
  
          "target-arrow-color":
            "#fde047",
  
          opacity: 1,
  
          "shadow-blur": 16,
  
          "shadow-color":
            "#facc15",
  
          "shadow-opacity": 1,
  
          "z-index": 150,
        },
      },
  
      /*
       * THINKING EDGE
       *
       * This is only a visual processing state.
       * It does NOT claim that the edge is part of
       * the final answer.
       */
      {
        selector: ".thinking-edge",
  
        style: {
          width: 2,
  
          "line-color":
            "#64748b",
  
          "target-arrow-color":
            "#64748b",
  
          opacity: 0.45,
  
          "z-index": 20,
        },
      },
  
      /*
       * THINKING NODE
       */
      {
        selector: ".thinking-node",
  
        style: {
          "border-color":
            "#64748b",
  
          "border-width": 2,
  
          opacity: 0.9,
  
          "z-index": 30,
        },
      },
    ];
  
    /*
     * -------------------------------------------------------
     * INITIAL LAYOUT
     * -------------------------------------------------------
     */
  
    const runLayout = () => {
      const cy = cyRef.current;
  
      if (!cy) return;
  
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
  
      cy.fit(
        undefined,
        70
      );
    };
  
    /*
     * -------------------------------------------------------
     * INITIALIZE CYTOSCAPE
     * -------------------------------------------------------
     */
  
    const handleCyReady = (cy) => {
      cyRef.current = cy;
  
      runLayout();
  
      /*
       * Node selection.
       */
      cy.on(
        "tap",
        "node",
        (event) => {
          const node =
            event.target;
  
          if (onEntitySelect) {
            onEntitySelect({
              id: node.id(),
  
              label:
                node.data(
                  "label"
                ),
  
              type:
                node.data(
                  "type"
                ),
            });
          }
        }
      );
    };
  
    /*
     * -------------------------------------------------------
     * THINKING ANIMATION
     *
     * This is intentionally subtle.
     * It doesn't pretend to know the final entities
     * before the backend has returned provenance.
     * -------------------------------------------------------
     */
  
    const startThinkingAnimation =
      () => {
        const cy = cyRef.current;
  
        if (!cy) return;
  
        clearTimers();
  
        cy.elements().removeClass(
          "trace-node",
          "trace-edge",
          "trace-active",
          "trace-edge-active",
          "thinking-node",
          "thinking-edge"
        );
  
        /*
         * Keep the full graph visible.
         */
        cy.nodes().style({
          opacity: 0.82,
        });
  
        cy.edges().style({
          opacity: 0.22,
          label: "",
        });
  
        /*
         * Slowly pulse real graph edges.
         * This represents context processing,
         * not a claimed answer path.
         */
        let edgeIndex = 0;
  
        const edges =
          cy.edges().toArray();
  
        const pulse = () => {
          if (!loading) return;
  
          if (
            edges.length === 0
          ) {
            return;
          }
  
          const edge =
            edges[
              edgeIndex %
                edges.length
            ];
  
          edge.addClass(
            "thinking-edge"
          );
  
          const timer =
            setTimeout(() => {
              edge.removeClass(
                "thinking-edge"
              );
  
              edgeIndex += 1;
  
              pulse();
            }, 90);
  
          timersRef.current.push(
            timer
          );
        };
  
        pulse();
      };
  
    /*
     * -------------------------------------------------------
     * FINAL TRACE
     * -------------------------------------------------------
     */
  
    const showFinalTrace =
      () => {
        const cy = cyRef.current;
  
        if (!cy) return;
  
        clearTimers();
  
        /*
         * Reset graph to subdued state.
         */
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
  
        /*
         * Highlight actual source entities.
         */
        const traceNodes = [];
  
        cy.nodes().forEach(
          (node) => {
            if (
              traceNodeIds.has(
                node.id()
              )
            ) {
              traceNodes.push(node);
  
              node.addClass(
                "trace-node"
              );
  
              node.style({
                opacity: 1,
              });
            }
          }
        );
  
        /*
         * Highlight actual provenance edges.
         */
        cy.edges().forEach(
          (edge) => {
            if (
              traceEdgeIds.has(
                edge.id()
              )
            ) {
              edge.addClass(
                "trace-edge"
              );
  
              edge.style({
                opacity: 1,
              });
            }
          }
        );
  
        /*
         * Focus ONLY on actual source entities.
         */
        if (
          traceNodes.length
        ) {
          const collection =
            cy.collection(
              traceNodes
            );
  
          cy.animate(
            {
              fit: {
                eles:
                  collection,
                padding: 150,
              },
            },
            {
              duration: 900,
            }
          );
        }
  
        /*
         * Sequential bulb effect.
         */
        traceNodes.forEach(
          (node, index) => {
            const timer =
              setTimeout(() => {
                cy.nodes().removeClass(
                  "trace-active"
                );
  
                cy.edges().removeClass(
                  "trace-edge-active"
                );
  
                node.addClass(
                  "trace-active"
                );
  
                /*
                 * Glow the actual connected
                 * provenance relationships.
                 */
                node.connectedEdges().forEach(
                  (edge) => {
                    if (
                      traceEdgeIds.has(
                        edge.id()
                      )
                    ) {
                      edge.addClass(
                        "trace-edge-active"
                      );
                    }
                  }
                );
              }, index * 650);
  
            timersRef.current.push(
              timer
            );
          }
        );
  
        /*
         * Leave all relevant entities
         * glowing after animation.
         */
        const finalTimer =
          setTimeout(() => {
            cy.nodes().removeClass(
              "trace-active"
            );
  
            traceNodes.forEach(
              (node) => {
                node.addClass(
                  "trace-node"
                );
              }
            );
  
            cy.edges().removeClass(
              "trace-edge-active"
            );
  
            cy.edges().forEach(
              (edge) => {
                if (
                  traceEdgeIds.has(
                    edge.id()
                  )
                ) {
                  edge.addClass(
                    "trace-edge"
                  );
                }
              }
            );
          },
          Math.max(
            traceNodes.length * 650,
            1000
          ) + 300
        );
  
        timersRef.current.push(
          finalTimer
        );
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
  
    /*
     * -------------------------------------------------------
     * UI
     * -------------------------------------------------------
     */
  
    const sourceCount =
      traceNodeIds.size;
  
    return (
      <div
        style={{
          position: "relative",
  
          width: "100%",
          height: "100%",
  
          minHeight: 560,
  
          background:
            "#070b11",
  
          border:
            "1px solid #1e293b",
  
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
  
        {/* ------------------------------------------------
            GRAPH STATUS
        ------------------------------------------------ */}
  
        <div
          style={{
            position: "absolute",
  
            left: 18,
            top: 18,
  
            padding:
              "10px 14px",
  
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
              color:
                "#e2e8f0",
  
              fontSize: 13,
  
              fontWeight: 700,
            }}
          >
            Context Graph
          </div>
  
          <div
            style={{
              marginTop: 3,
  
              color:
                "#64748b",
  
              fontSize: 10,
            }}
          >
            {loading
              ? "Tracing context..."
              : sourceCount > 0
                ? `${sourceCount} source entities`
                : `${graphData?.nodes?.length || 0} entities`}
          </div>
        </div>
  
        {/* ------------------------------------------------
            LEGEND
        ------------------------------------------------ */}
  
        <div
          style={{
            position: "absolute",
  
            left: 18,
            bottom: 18,
  
            display: "flex",
  
            gap: 14,
  
            padding:
              "8px 12px",
  
            background:
              "rgba(7, 11, 17, 0.88)",
  
            border:
              "1px solid #1e293b",
  
            borderRadius: 10,
  
            zIndex: 50,
  
            fontSize: 10,
          }}
        >
          <span
            style={{
              color:
                "#64748b",
            }}
          >
            ● Context
          </span>
  
          <span
            style={{
              color:
                "#facc15",
            }}
          >
            ● Retrieved
          </span>
  
          <span
            style={{
              color:
                "#fde68a",
            }}
          >
            ━ Relationship
          </span>
        </div>
  
        {/* ------------------------------------------------
            CONTROLS
        ------------------------------------------------ */}
  
        <div
          style={{
            position: "absolute",
  
            right: 18,
            bottom: 18,
  
            display: "flex",
  
            flexDirection:
              "column",
  
            gap: 5,
  
            zIndex: 60,
          }}
        >
          <button
            onClick={() => {
              const cy =
                cyRef.current;
  
              if (!cy) return;
  
              cy.zoom({
                level:
                  Math.min(
                    cy.zoom() * 1.2,
                    3
                  ),
  
                renderedPosition: {
                  x:
                    cy.width() / 2,
  
                  y:
                    cy.height() / 2,
                },
              });
            }}
          >
            +
          </button>
  
          <button
            onClick={() => {
              const cy =
                cyRef.current;
  
              if (!cy) return;
  
              cy.zoom({
                level:
                  Math.max(
                    cy.zoom() / 1.2,
                    0.15
                  ),
  
                renderedPosition: {
                  x:
                    cy.width() / 2,
  
                  y:
                    cy.height() / 2,
                },
              });
            }}
          >
            −
          </button>
  
          <button
            onClick={() => {
              const cy =
                cyRef.current;
  
              if (!cy) return;
  
              cy.fit(
                undefined,
                70
              );
            }}
          >
            Fit
          </button>
        </div>
      </div>
    );
  }
  
  export default GraphView;