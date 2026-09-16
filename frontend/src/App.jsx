import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import GraphView from "./components/GraphView";
import "./App.css";

function App() {
  const [selectedEntity, setSelectedEntity] = useState(null);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);

  /*
   * Graph state and summary metrics
   */
  const [graphData, setGraphData] = useState({
    nodes: [],
    edges: [],
  });

  const [graphTrace, setGraphTrace] = useState({
    nodes: [],
    edges: [],
    tables: [],
  });

  const [graphSummary, setGraphSummary] = useState({
    nodes: 0,
    edges: 0,
    database_relationships: 0,
    business_relationships: 0,
  });

  /*
   * Load the context graph on initial mount
   */
  useEffect(() => {
    const loadGraph = async () => {
      try {
        const response = await fetch(
          "http://127.0.0.1:8000/api/graph"
        );

        if (!response.ok) {
          throw new Error("Failed to load graph");
        }

        const data = await response.json();

        setGraphData(data.graph);
        setGraphSummary(data.graph_summary);
      } catch (error) {
        console.error("Failed to load context graph:", error);
      }
    };

    loadGraph();
  }, []);

  const handleEntitySelect = (entity) => {
    setSelectedEntity(entity);
  };

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
      const response = await fetch(
        "http://127.0.0.1:8000/api/chat",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            question: trimmedQuestion,
          }),
        }
      );

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
        },
      ]);

      // Update graph data and execution trace from response
      setGraphData(data.graph || { nodes: [], edges: [] });
      setGraphTrace(
        data.graph_trace || { nodes: [], edges: [], tables: [] }
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

        {/* Dashboard */}
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
                Discovered tables
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
                AI validated relationships
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

          {/* Main workspace */}
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
                    Dynamically discovered entities and
                    relationships
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
                    <div className="entity-symbol">◈</div>

                    <div>
                      <div className="entity-title">
                        {selectedEntity.label}
                      </div>

                      <div className="entity-type">
                        {selectedEntity.type}
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
                  <div className="empty-symbol">◇</div>

                  <h3>Select an entity</h3>

                  <p>
                    Click a node in the graph to inspect its
                    dynamically discovered attributes.
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

                  <span className="ai-badge">AI</span>
                </div>

                <p>
                  Ask questions about your business data
                </p>
              </div>
            </div>

            <div className="chat-content">
              {messages.length === 0 ? (
                <div className="chat-empty">
                  <div className="chat-icon">✦</div>

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
                    </div>
                  ))}

                  {loading && (
                    <div className="message assistant loading">
                      <div className="message-role">
                        assistant
                      </div>

                      <div className="message-content">
                        Thinking...
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
                  placeholder="Ask a question about your data..."
                  disabled={loading}
                />

                <button
                  type="button"
                  onClick={handleAsk}
                  disabled={loading || !question.trim()}
                >
                  <span>
                    {loading ? "Thinking..." : "Send"}
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