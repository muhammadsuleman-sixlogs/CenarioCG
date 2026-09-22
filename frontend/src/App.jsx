import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import GraphView from "./components/GraphView";
import "./App.css";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000";

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

function App() {
  const [selectedEntity, setSelectedEntity] = useState(null);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);

  const [graphData, setGraphData] = useState({
    nodes: [],
    edges: [],
  });

  const [graphTrace, setGraphTrace] = useState({
    nodes: [],
    edges: [],
    tables: [],
    source_entities: [],
    source_tables: [],
    matched_graph_nodes: [],
  });

  const [sourceTrace, setSourceTrace] = useState({
    data_sources: [],
    external_sources: [],
  });

  const [graphSummary, setGraphSummary] = useState({
    nodes: 0,
    edges: 0,
    database_relationships: 0,
    business_relationships: 0,
  });

  /*
   * -------------------------------------------------------
   * SOURCE SUMMARY
   * -------------------------------------------------------
   *
   * Derived dynamically from graph node IDs.
   *
   * Examples:
   * db1:project_tasks -> db1
   * db2:projects      -> db2
   */
  const sourceSummary = useMemo(() => {
    const counts = {};

    (graphData?.nodes || []).forEach((node) => {
      const sourceId = getNodeSource(node);

      counts[sourceId] = (counts[sourceId] || 0) + 1;
    });

    return Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([sourceId, count]) => ({
        sourceId,
        label: getSourceLabel(sourceId),
        count,
      }));
  }, [graphData]);

  /*
   * -------------------------------------------------------
   * ANSWER SOURCES
   * -------------------------------------------------------
   */
  const activeAnswerSources = useMemo(() => {
    const sources = new Set();

    (sourceTrace?.data_sources || []).forEach((source) => {
      if (source) {
        sources.add(String(source));
      }
    });

    (sourceTrace?.external_sources || []).forEach((source) => {
      if (source?.id) {
        sources.add(String(source.id));
      }
    });

    return Array.from(sources);
  }, [sourceTrace]);

  /*
   * -------------------------------------------------------
   * LOAD GRAPH
   * -------------------------------------------------------
   */
  useEffect(() => {
    const loadGraph = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/graph`);

        if (!response.ok) {
          throw new Error("Failed to load graph");
        }

        const data = await response.json();

        setGraphData(data.graph || { nodes: [], edges: [] });

        setGraphSummary(
          data.graph_summary || {
            nodes: 0,
            edges: 0,
            database_relationships: 0,
            business_relationships: 0,
          }
        );
      } catch (error) {
        console.error("Failed to load context graph:", error);
      }
    };

    loadGraph();
  }, []);

  /*
   * -------------------------------------------------------
   * ENTITY SELECTION
   * -------------------------------------------------------
   */
  const handleEntitySelect = (entity) => {
    setSelectedEntity(entity);
  };

  /*
   * -------------------------------------------------------
   * CHAT
   * -------------------------------------------------------
   */
  const handleAsk = async () => {
    const trimmedQuestion = question.trim();

    if (!trimmedQuestion || loading) {
      return;
    }

    setMessages((previous) => [
      ...previous,
      {
        role: "user",
        content: trimmedQuestion,
      },
    ]);

    setQuestion("");
    setLoading(true);

    try {
      const response = await fetch(`${API_BASE_URL}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          question: trimmedQuestion,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.detail || "Unable to process the question."
        );
      }

      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          content:
            data.answer ||
            "I could not generate an answer.",
          sources: data.source_trace || null,
        },
      ]);

      /*
       * Update complete graph.
       */
      setGraphData(
        data.graph || {
          nodes: [],
          edges: [],
        }
      );

      /*
       * Update actual retrieval trace.
       */
      setGraphTrace(
        data.graph_trace || {
          nodes: [],
          edges: [],
          tables: [],
          source_entities: [],
          source_tables: [],
          matched_graph_nodes: [],
        }
      );

      /*
       * Update source provenance.
       */
      setSourceTrace(
        data.source_trace || {
          data_sources: [],
          external_sources: [],
        }
      );

      if (data.graph_summary) {
        setGraphSummary(data.graph_summary);
      }
    } catch (error) {
      console.error("Chat request failed:", error);

      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          content:
            "Sorry, I could not process your question right now.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleSuggestion = (suggestion) => {
    setQuestion(suggestion);
  };

  return (
    <div className="app">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <span>C</span>
        </div>

        <nav className="sidebar-nav">
          <button
            className="sidebar-button active"
            type="button"
            title="Context Graph"
          >
            <span>◈</span>
          </button>

          <button
            className="sidebar-button"
            type="button"
            title="AI Assistant"
          >
            <span>✦</span>
          </button>

          <button
            className="sidebar-button"
            type="button"
            title="Analytics"
          >
            <span>◫</span>
          </button>

          <button
            className="sidebar-button"
            type="button"
            title="Settings"
          >
            <span>⚙</span>
          </button>
        </nav>

        <div className="sidebar-bottom">
          <div className="status-dot" />
        </div>
      </aside>

      {/* Main Content */}
      <main className="content">
        {/* Header */}
        <header className="header">
          <div>
            <div className="header-eyebrow">
              AI DATA INTELLIGENCE
            </div>

            <h1>CENARIO</h1>
          </div>

          <div className="header-right">
            <div className="system-status">
              <span className="system-dot" />
              Context Layer Active
            </div>

            <div className="header-avatar">C</div>
          </div>
        </header>

        <div className="page">
          {/* Stats */}
          <section className="stats-grid">
            <div className="stat-card">
              <div className="stat-icon">◈</div>

              <div>
                <div className="stat-number">
                  {graphSummary.nodes}
                </div>

                <div className="stat-label">
                  Entities
                </div>
              </div>

              <div className="stat-description">
                Discovered entities across sources
              </div>
            </div>

            <div className="stat-card">
              <div className="stat-icon">⌁</div>

              <div>
                <div className="stat-number">
                  {graphSummary.database_relationships}
                </div>

                <div className="stat-label">
                  Database Relationships
                </div>
              </div>

              <div className="stat-description">
                PostgreSQL relationships
              </div>
            </div>

            <div className="stat-card">
              <div className="stat-icon">✦</div>

              <div>
                <div className="stat-number">
                  {graphSummary.business_relationships}
                </div>

                <div className="stat-label">
                  Business Relationships
                </div>
              </div>

              <div className="stat-description">
                Validated relationships
              </div>
            </div>

            <div className="stat-card">
              <div className="stat-icon">◎</div>

              <div>
                <div className="stat-number">
                  {graphSummary.edges}
                </div>

                <div className="stat-label">
                  Graph Connections
                </div>
              </div>

              <div className="stat-description">
                Total graph edges
              </div>
            </div>
          </section>

          {/* SOURCE OVERVIEW */}
          <section className="source-overview">
            <div className="source-overview-header">
              <div>
                <div className="source-overview-title">
                  Connected Data Sources
                </div>

                <div className="source-overview-subtitle">
                  Dynamically discovered Context Layer sources
                </div>
              </div>

              <div className="source-overview-live">
                <span />
                LIVE
              </div>
            </div>

            <div className="source-list">
              {sourceSummary.length > 0 ? (
                sourceSummary.map((source) => (
                  <div
                    className="source-card"
                    key={source.sourceId}
                  >
                    <div className="source-card-icon">
                      ◉
                    </div>

                    <div className="source-card-content">
                      <div className="source-card-title">
                        {source.label}
                      </div>

                      <div className="source-card-meta">
                        {source.count} entities
                      </div>
                    </div>

                    <div className="source-card-status">
                      Connected
                    </div>
                  </div>
                ))
              ) : (
                <div className="source-empty">
                  No graph sources available.
                </div>
              )}
            </div>
          </section>

          {/* Current answer source trace */}
          {activeAnswerSources.length > 0 && (
            <section className="answer-source-bar">
              <span className="answer-source-label">
                CURRENT QUERY SOURCES
              </span>

              <div className="answer-source-list">
                {activeAnswerSources.map((source) => (
                  <span
                    className="answer-source-pill"
                    key={source}
                  >
                    {getSourceLabel(source)}
                  </span>
                ))}
              </div>
            </section>
          )}

          {/* Workspace */}
          <section className="workspace">
            {/* Graph */}
            <div className="panel graph-panel">
              <div className="panel-header">
                <div>
                  <div className="panel-title-row">
                    <h2>Context Graph</h2>

                    <span className="live-badge">
                      <span />
                      LIVE
                    </span>
                  </div>

                  <p>
                    Dynamically discovered entities and relationships
                  </p>
                </div>

                <div className="graph-info">
                  <span className="legend-item">
                    <span className="legend-line database" />
                    Database
                  </span>

                  <span className="legend-item">
                    <span className="legend-line business" />
                    Business
                  </span>
                </div>
              </div>

              <div className="graph-wrapper">
                <GraphView
                  graphData={graphData}
                  graphTrace={graphTrace}
                  sourceTrace={sourceTrace}
                  onEntitySelect={handleEntitySelect}
                  loading={loading}
                />

                <div className="graph-overlay">
                  <div className="graph-overlay-title">
                    Context Layer
                  </div>

                  <div className="graph-overlay-text">
                    {(graphData.nodes || []).length} visible
                    entities
                  </div>
                </div>
              </div>
            </div>

            {/* Entity details */}
            <aside className="panel entity-panel">
              <div className="panel-header">
                <div>
                  <h2>Entity Details</h2>
                  <p>Inspect discovered schema</p>
                </div>
              </div>

              {selectedEntity ? (
                <div className="entity-content">
                  <div className="entity-heading">
                    <div className="entity-symbol">
                      ◈
                    </div>

                    <div>
                      <div className="entity-title">
                        {selectedEntity.label}
                      </div>

                      <div className="entity-type">
                        {selectedEntity.type}
                      </div>
                    </div>
                  </div>

                  {/* SOURCE */}
                  <div className="entity-source-section">
                    <div className="section-label">
                      DATA SOURCE
                    </div>

                    <div className="entity-source-card">
                      <span className="entity-source-dot" />

                      <div>
                        <div className="entity-source-name">
                          {getSourceLabel(
                            selectedEntity.source_id
                          )}
                        </div>

                        <div className="entity-source-id">
                          {selectedEntity.source_id ||
                            "Unknown source"}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="section-label">
                    ATTRIBUTES
                  </div>

                  <div className="attributes">
                    {(selectedEntity.columns || []).map(
                      (column) => (
                        <div
                          className="attribute"
                          key={column.name}
                        >
                          <div className="attribute-left">
                            <div className="attribute-name">
                              {column.name}
                            </div>

                            <div className="attribute-type">
                              {column.type}
                            </div>
                          </div>

                          {column.pk && (
                            <span className="pk-badge">
                              PK
                            </span>
                          )}
                        </div>
                      )
                    )}
                  </div>
                </div>
              ) : (
                <div className="entity-empty">
                  <div className="empty-symbol">
                    ◇
                  </div>

                  <h3>Select an entity</h3>

                  <p>
                    Click a node in the graph to inspect its
                    dynamically discovered attributes and
                    source.
                  </p>
                </div>
              )}
            </aside>
          </section>

          {/* AI Assistant */}
          <section className="panel chat-panel">
            <div className="panel-header chat-header">
              <div>
                <div className="panel-title-row">
                  <h2>AI Assistant</h2>

                  <span className="ai-badge">
                    AI
                  </span>
                </div>

                <p>
                  Ask questions across your connected data
                </p>
              </div>
            </div>

            <div className="chat-content">
              {messages.length === 0 ? (
                <div className="chat-empty">
                  <div className="chat-icon">
                    ✦
                  </div>

                  <h3>Ask Cenario</h3>

                  <p>
                    Query your connected data using natural
                    language.
                  </p>

                  <div className="suggestions">
                    <button
                      type="button"
                      onClick={() =>
                        handleSuggestion(
                          "Which records were created most recently?"
                        )
                      }
                    >
                      Recent records
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        handleSuggestion(
                          "What is the status of this ticket?"
                        )
                      }
                    >
                      Ticket status
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        handleSuggestion(
                          "How are the entities connected?"
                        )
                      }
                    >
                      Entity relationships
                    </button>
                  </div>
                </div>
              ) : (
                <div className="messages">
                  {messages.map((message, index) => (
                    <div
                      key={`msg-${index}`}
                      className={`message ${message.role}`}
                    >
                      <div className="message-role">
                        {message.role}
                      </div>

                      <div className="message-content">
                        {message.role === "assistant" ? (
                          <ReactMarkdown>
                            {message.content}
                          </ReactMarkdown>
                        ) : (
                          message.content
                        )}
                      </div>

                      {message.role === "assistant" &&
                        message.sources?.data_sources?.length >
                          0 && (
                          <div className="message-source-row">
                            {message.sources.data_sources.map(
                              (source) => (
                                <span
                                  className="message-source-pill"
                                  key={source}
                                >
                                  {getSourceLabel(source)}
                                </span>
                              )
                            )}
                          </div>
                        )}
                    </div>
                  ))}

                  {loading && (
                    <div className="message assistant loading">
                      <div className="message-role">
                        assistant
                      </div>

                      <div className="message-content">
                        <span className="thinking-indicator">
                          <span />
                          <span />
                          <span />
                        </span>

                        Tracing connected sources...
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="question-box">
                <input
                  type="text"
                  value={question}
                  onChange={(event) =>
                    setQuestion(event.target.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleAsk();
                    }
                  }}
                  placeholder="Ask a question about your connected data..."
                  disabled={loading}
                />

                <button
                  type="button"
                  onClick={handleAsk}
                  disabled={loading || !question.trim()}
                >
                  <span>
                    {loading ? "Tracing..." : "Send"}
                  </span>

                  <span>→</span>
                </button>
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

export default App;