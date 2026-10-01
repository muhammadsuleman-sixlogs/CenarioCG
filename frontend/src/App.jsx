import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import GraphView from "./components/GraphView";
import "./App.css";


const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ||
  "http://127.0.0.1:8000";


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
  const source = String(
    sourceId || ""
  ).toLowerCase();

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


function getSourceDetails(message, sourceId) {
  const sources = Array.isArray(
    message?.response_data?.sources
  )
    ? message.response_data.sources
    : [];

  const normalizedSource = String(
    sourceId || ""
  ).toLowerCase();

  const postgresSource = sources.find(
    (source) =>
      source?.source_type === "postgresql" &&
      String(
        source?.source_id || ""
      ).toLowerCase() === normalizedSource
  );

  if (postgresSource) {
    return postgresSource;
  }

  if (normalizedSource === "security_logs") {
    return (
      sources.find(
        (source) =>
          source?.source_type ===
          "security_logs_api"
      ) ||
      message?.response_data?.source_trace?.external_sources?.find(
        (source) =>
          String(
            source?.id || ""
          ).toLowerCase() === normalizedSource
      ) ||
      null
    );
  }

  return null;
}


function getSourceStatus(details) {
  if (!details) {
    return "No retrieval details available";
  }

  if (details.retrieval_status) {
    return details.retrieval_status;
  }

  if (details.status) {
    return details.status;
  }

  if (typeof details.row_count === "number") {
    return details.row_count > 0
      ? "Retrieved"
      : "No rows returned";
  }

  if (typeof details.event_count === "number") {
    return details.event_count > 0
      ? "Retrieved"
      : "No events returned";
  }

  return "Retrieved";
}


function App() {
  const [authenticated, setAuthenticated] =
    useState(false);

  const [authChecking, setAuthChecking] =
    useState(true);

  const [username, setUsername] =
    useState("");

  const [password, setPassword] =
    useState("");

  const [loginError, setLoginError] =
    useState("");

  const [loginLoading, setLoginLoading] =
    useState(false);

  const [selectedEntity, setSelectedEntity] =
    useState(null);

  const [selectedSource, setSelectedSource] =
    useState(null);

  const [question, setQuestion] =
    useState("");

  const [messages, setMessages] =
    useState([]);

  const [loading, setLoading] =
    useState(false);

  const [graphData, setGraphData] = useState({
    nodes: [],
    edges: [],
  });

  const [graphTrace, setGraphTrace] =
    useState({
      nodes: [],
      edges: [],
      tables: [],
      source_entities: [],
      source_tables: [],
      matched_graph_nodes: [],
    });

  const [sourceTrace, setSourceTrace] =
    useState({
      data_sources: [],
      external_sources: [],
    });

  const [graphSummary, setGraphSummary] =
    useState({
      nodes: 0,
      edges: 0,
      database_relationships: 0,
      business_relationships: 0,
    });


  // -------------------------------------------------------
  // Authentication
  // -------------------------------------------------------

  useEffect(() => {
    const checkAuthentication =
      async () => {
        try {
          const response = await fetch(
            `${API_BASE_URL}/api/auth/me`,
            {
              credentials: "include",
            }
          );

          setAuthenticated(
            response.ok
          );
        } catch (error) {
          console.error(
            "Authentication check failed:",
            error
          );

          setAuthenticated(false);
        } finally {
          setAuthChecking(false);
        }
      };

    checkAuthentication();
  }, []);


  const handleLogin = async (
    event
  ) => {
    event.preventDefault();

    if (
      !username.trim() ||
      !password
    ) {
      setLoginError(
        "Please enter your username and password."
      );

      return;
    }

    setLoginLoading(true);
    setLoginError("");

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/auth/login`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            username: username.trim(),
            password,
          }),
        }
      );

      const data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.detail ||
            "Invalid username or password."
        );
      }

      setAuthenticated(true);
      setUsername("");
      setPassword("");
    } catch (error) {
      console.error(
        "Login failed:",
        error
      );

      setLoginError(
        error.message ||
          "Unable to sign in."
      );
    } finally {
      setLoginLoading(false);
    }
  };


  const handleLogout = async () => {
    try {
      await fetch(
        `${API_BASE_URL}/api/auth/logout`,
        {
          method: "POST",
          credentials: "include",
        }
      );
    } catch (error) {
      console.error(
        "Logout failed:",
        error
      );
    } finally {
      setAuthenticated(false);
      setMessages([]);
      setSelectedEntity(null);
      setSelectedSource(null);
      setQuestion("");
      setGraphData({
        nodes: [],
        edges: [],
      });
      setGraphTrace({
        nodes: [],
        edges: [],
        tables: [],
        source_entities: [],
        source_tables: [],
        matched_graph_nodes: [],
      });
      setSourceTrace({
        data_sources: [],
        external_sources: [],
      });
    }
  };


  // -------------------------------------------------------
  // Graph source summary
  // -------------------------------------------------------

  const sourceSummary = useMemo(() => {
    const counts = {};

    (graphData?.nodes || []).forEach(
      (node) => {
        const sourceId =
          getNodeSource(node);

        counts[sourceId] =
          (counts[sourceId] || 0) + 1;
      }
    );

    return Object.entries(counts)
      .sort(([a], [b]) =>
        a.localeCompare(b)
      )
      .map(
        ([sourceId, count]) => ({
          sourceId,
          label:
            getSourceLabel(
              sourceId
            ),
          count,
        })
      );
  }, [graphData]);


  // -------------------------------------------------------
  // Current query sources
  // -------------------------------------------------------

  const activeAnswerSources =
    useMemo(() => {
      const sources = new Set();

      (
        sourceTrace?.data_sources ||
        []
      ).forEach((source) => {
        if (source) {
          sources.add(
            String(source)
          );
        }
      });

      (
        sourceTrace?.external_sources ||
        []
      ).forEach((source) => {
        if (source?.id) {
          sources.add(
            String(source.id)
          );
        }
      });

      return Array.from(sources);
    }, [sourceTrace]);


  // -------------------------------------------------------
  // Load graph
  // -------------------------------------------------------

  useEffect(() => {
    if (!authenticated) {
      return;
    }

    const loadGraph = async () => {
      try {
        const response =
          await fetch(
            `${API_BASE_URL}/api/graph`,
            {
              credentials: "include",
            }
          );

        if (!response.ok) {
          throw new Error(
            "Failed to load graph"
          );
        }

        const data =
          await response.json();

        setGraphData(
          data.graph || {
            nodes: [],
            edges: [],
          }
        );

        setGraphSummary(
          data.graph_summary || {
            nodes: 0,
            edges: 0,
            database_relationships: 0,
            business_relationships: 0,
          }
        );
      } catch (error) {
        console.error(
          "Failed to load context graph:",
          error
        );
      }
    };

    loadGraph();
  }, [authenticated]);


  // -------------------------------------------------------
  // Entity selection
  // -------------------------------------------------------

  const handleEntitySelect =
    (entity) => {
      setSelectedEntity(entity);
    };


  // -------------------------------------------------------
  // Ask Cenario
  // -------------------------------------------------------

  const handleAsk = async () => {
    const trimmedQuestion =
      question.trim();

    if (
      !trimmedQuestion ||
      loading
    ) {
      return;
    }

    setMessages(
      (previous) => [
        ...previous,
        {
          role: "user",
          content:
            trimmedQuestion,
        },
      ]
    );

    setQuestion("");
    setLoading(true);
    setSelectedSource(null);

    try {
      const response =
        await fetch(
          `${API_BASE_URL}/api/chat`,
          {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type":
                "application/json",
            },
            body: JSON.stringify({
              question:
                trimmedQuestion,
            }),
          }
        );

      const data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.detail ||
            "Unable to process the question."
        );
      }

      setMessages(
        (previous) => [
          ...previous,
          {
            role: "assistant",
            content:
              data.answer ||
              "I could not generate an answer.",
            sources:
              data.source_trace ||
              null,
            response_data: data,
          },
        ]
      );

      setGraphData(
        data.graph || {
          nodes: [],
          edges: [],
        }
      );

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

      setSourceTrace(
        data.source_trace || {
          data_sources: [],
          external_sources: [],
        }
      );

      if (data.graph_summary) {
        setGraphSummary(
          data.graph_summary
        );
      }
    } catch (error) {
      console.error(
        "Chat request failed:",
        error
      );

      setMessages(
        (previous) => [
          ...previous,
          {
            role: "assistant",
            content:
              "Sorry, I could not process your question right now.",
          },
        ]
      );
    } finally {
      setLoading(false);
    }
  };


  // -------------------------------------------------------
  // Suggestions
  // -------------------------------------------------------

  const handleSuggestion =
    (suggestion) => {
      setQuestion(suggestion);
    };


  // -------------------------------------------------------
  // Authentication loading screen
  // -------------------------------------------------------

  if (authChecking) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="auth-logo">
            C
          </div>

          <div className="auth-eyebrow">
            AI DATA INTELLIGENCE
          </div>

          <h1>CENARIO</h1>

          <p className="auth-subtitle">
            Sign in to access the
            Context Layer.
          </p>

          <div className="auth-loading">
            Checking authentication...
          </div>
        </div>
      </div>
    );
  }


  // -------------------------------------------------------
  // Login screen
  // -------------------------------------------------------

  if (!authenticated) {
    return (
      <div className="auth-screen">
        <form
          className="auth-card"
          onSubmit={handleLogin}
        >
          <div className="auth-logo">
            C
          </div>

          <div className="auth-eyebrow">
            AI DATA INTELLIGENCE
          </div>

          <h1>CENARIO</h1>

          <p className="auth-subtitle">
            Sign in to access the
            Context Layer.
          </p>

          <div className="auth-field">
            <label htmlFor="username">
              Username
            </label>

            <input
              id="username"
              type="text"
              value={username}
              onChange={(event) =>
                setUsername(
                  event.target.value
                )
              }
              autoComplete="username"
              disabled={
                loginLoading
              }
              autoFocus
            />
          </div>

          <div className="auth-field">
            <label htmlFor="password">
              Password
            </label>

            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) =>
                setPassword(
                  event.target.value
                )
              }
              autoComplete="current-password"
              disabled={
                loginLoading
              }
            />
          </div>

          {loginError && (
            <div className="auth-error">
              {loginError}
            </div>
          )}

          <button
            className="auth-button"
            type="submit"
            disabled={
              loginLoading
            }
          >
            {loginLoading
              ? "Signing in..."
              : "Sign In"}
          </button>
        </form>
      </div>
    );
  }


  // -------------------------------------------------------
  // Main CenarioCG application
  // -------------------------------------------------------

  return (
    <div className="app">
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

      <main className="content">
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

            <button
              type="button"
              className="logout-button"
              onClick={handleLogout}
            >
              Logout
            </button>

            <div className="header-avatar">
              C
            </div>
          </div>
        </header>

        <div className="page">
          <section className="stats-grid">
            <div className="stat-card">
              <div className="stat-icon">
                ◈
              </div>

              <div>
                <div className="stat-number">
                  {
                    graphSummary.nodes
                  }
                </div>

                <div className="stat-label">
                  Entities
                </div>
              </div>

              <div className="stat-description">
                Discovered entities
                across sources
              </div>
            </div>

            <div className="stat-card">
              <div className="stat-icon">
                ⌁
              </div>

              <div>
                <div className="stat-number">
                  {
                    graphSummary.database_relationships
                  }
                </div>

                <div className="stat-label">
                  Database
                  Relationships
                </div>
              </div>

              <div className="stat-description">
                PostgreSQL
                relationships
              </div>
            </div>

            <div className="stat-card">
              <div className="stat-icon">
                ✦
              </div>

              <div>
                <div className="stat-number">
                  {
                    graphSummary.business_relationships
                  }
                </div>

                <div className="stat-label">
                  Business
                  Relationships
                </div>
              </div>

              <div className="stat-description">
                Validated
                relationships
              </div>
            </div>

            <div className="stat-card">
              <div className="stat-icon">
                ◎
              </div>

              <div>
                <div className="stat-number">
                  {
                    graphSummary.edges
                  }
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

          <section className="source-overview">
            <div className="source-overview-header">
              <div>
                <div className="source-overview-title">
                  Connected Data
                  Sources
                </div>

                <div className="source-overview-subtitle">
                  Dynamically discovered
                  Context Layer sources
                </div>
              </div>

              <div className="source-overview-live">
                <span />
                LIVE
              </div>
            </div>

            <div className="source-list">
              {sourceSummary.length >
              0 ? (
                sourceSummary.map(
                  (source) => (
                    <div
                      className="source-card"
                      key={
                        source.sourceId
                      }
                    >
                      <div className="source-card-icon">
                        ◉
                      </div>

                      <div className="source-card-content">
                        <div className="source-card-title">
                          {
                            source.label
                          }
                        </div>

                        <div className="source-card-meta">
                          {
                            source.count
                          }{" "}
                          entities
                        </div>
                      </div>

                      <div className="source-card-status">
                        Connected
                      </div>
                    </div>
                  )
                )
              ) : (
                <div className="source-empty">
                  No graph sources
                  available.
                </div>
              )}
            </div>
          </section>

          {activeAnswerSources.length >
            0 && (
            <section className="answer-source-bar">
              <span className="answer-source-label">
                CURRENT QUERY
                SOURCES
              </span>

              <div className="answer-source-list">
                {activeAnswerSources.map(
                  (source) => (
                    <span
                      className="answer-source-pill"
                      key={source}
                    >
                      {getSourceLabel(
                        source
                      )}
                    </span>
                  )
                )}
              </div>
            </section>
          )}

          <section className="workspace">
            <div className="panel graph-panel">
              <div className="panel-header">
                <div>
                  <div className="panel-title-row">
                    <h2>
                      Context Graph
                    </h2>

                    <span className="live-badge">
                      <span />
                      LIVE
                    </span>
                  </div>

                  <p>
                    Dynamically
                    discovered
                    entities and
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
                  graphData={
                    graphData
                  }
                  graphTrace={
                    graphTrace
                  }
                  sourceTrace={
                    sourceTrace
                  }
                  onEntitySelect={
                    handleEntitySelect
                  }
                  loading={
                    loading
                  }
                />

                <div className="graph-overlay">
                  <div className="graph-overlay-title">
                    Context Layer
                  </div>

                  <div className="graph-overlay-text">
                    {
                      (
                        graphData.nodes ||
                        []
                      ).length
                    }{" "}
                    visible
                    entities
                  </div>
                </div>
              </div>
            </div>

            <aside className="panel entity-panel">
              <div className="panel-header">
                <div>
                  <h2>
                    Entity Details
                  </h2>

                  <p>
                    Inspect discovered
                    schema
                  </p>
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
                        {
                          selectedEntity.label
                        }
                      </div>

                      <div className="entity-type">
                        {
                          selectedEntity.type
                        }
                      </div>
                    </div>
                  </div>

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
                          {
                            selectedEntity.source_id
                          }
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="section-label">
                    ATTRIBUTES
                  </div>

                  <div className="attributes">
                    {(
                      selectedEntity.columns ||
                      []
                    ).map(
                      (column) => (
                        <div
                          className="attribute"
                          key={
                            column.name
                          }
                        >
                          <div className="attribute-left">
                            <div className="attribute-name">
                              {
                                column.name
                              }
                            </div>

                            <div className="attribute-type">
                              {
                                column.type
                              }
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

                  <h3>
                    Select an entity
                  </h3>

                  <p>
                    Click a node in the
                    graph to inspect
                    its dynamically
                    discovered
                    attributes and
                    source.
                  </p>
                </div>
              )}
            </aside>
          </section>

          <section className="panel chat-panel">
            <div className="panel-header chat-header">
              <div>
                <div className="panel-title-row">
                  <h2>
                    AI Assistant
                  </h2>

                  <span className="ai-badge">
                    AI
                  </span>
                </div>

                <p>
                  Ask questions across
                  your connected data
                </p>
              </div>
            </div>

            <div className="chat-content">
              {messages.length ===
              0 ? (
                <div className="chat-empty">
                  <div className="chat-icon">
                    ✦
                  </div>

                  <h3>
                    Ask Cenario
                  </h3>

                  <p>
                    Query your
                    connected data
                    using natural
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
                      Entity
                      relationships
                    </button>
                  </div>
                </div>
              ) : (
                <div className="messages">
                  {messages.map(
                    (
                      message,
                      index
                    ) => (
                      <div
                        key={`msg-${index}`}
                        className={`message ${message.role}`}
                      >
                        <div className="message-role">
                          {
                            message.role
                          }
                        </div>

                        <div className="message-content">
                          {message.role ===
                          "assistant" ? (
                            <ReactMarkdown>
                              {
                                message.content
                              }
                            </ReactMarkdown>
                          ) : (
                            message.content
                          )}
                        </div>

                        {message.role ===
                          "assistant" &&
                          (
                            message
                              .sources
                              ?.postgresql_sources
                              ?.length >
                              0 ||
                            message
                              .sources
                              ?.external_sources
                              ?.length >
                              0
                          ) && (
                            <div className="message-source-row">
                              {message.sources?.postgresql_sources?.map(
                                (
                                  source
                                ) => (
                                  <button
                                    type="button"
                                    className="message-source-pill"
                                    key={
                                      source
                                    }
                                    onClick={() =>
                                      setSelectedSource(
                                        {
                                          source,
                                          message,
                                          details:
                                            getSourceDetails(
                                              message,
                                              source
                                            ),
                                        }
                                      )
                                    }
                                  >
                                    {getSourceLabel(
                                      source
                                    )}
                                  </button>
                                )
                              )}

                              {message.sources?.external_sources?.map(
                                (
                                  source
                                ) => (
                                  <button
                                    type="button"
                                    className="message-source-pill"
                                    key={
                                      source.id
                                    }
                                    onClick={() =>
                                      setSelectedSource(
                                        {
                                          source:
                                            source.id,
                                          message,
                                          details:
                                            getSourceDetails(
                                              message,
                                              source.id
                                            ),
                                        }
                                      )
                                    }
                                  >
                                    {getSourceLabel(
                                      source.id
                                    )}
                                  </button>
                                )
                              )}
                            </div>
                          )}
                      </div>
                    )
                  )}

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

                        Tracing
                        connected
                        sources...
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
                    setQuestion(
                      event.target.value
                    )
                  }
                  onKeyDown={(event) => {
                    if (
                      event.key ===
                      "Enter"
                    ) {
                      event.preventDefault();
                      handleAsk();
                    }
                  }}
                  placeholder="Ask a question about your connected data..."
                  disabled={
                    loading
                  }
                />

                <button
                  type="button"
                  onClick={
                    handleAsk
                  }
                  disabled={
                    loading ||
                    !question.trim()
                  }
                >
                  <span>
                    {loading
                      ? "Tracing..."
                      : "Send"}
                  </span>

                  <span>→</span>
                </button>
              </div>
            </div>
          </section>
        </div>

        {selectedSource && (
          <div
            className="source-overlay-backdrop"
            onClick={() =>
              setSelectedSource(
                null
              )
            }
          >
            <div
              className="source-overlay-card"
              onClick={(event) =>
                event.stopPropagation()
              }
            >
              <div className="source-overlay-header">
                <div>
                  <div className="source-overlay-title">
                    {getSourceLabel(
                      selectedSource.source
                    )}
                  </div>

                  <div className="source-overlay-subtitle">
                    Retrieval &
                    provenance
                  </div>
                </div>

                <button
                  type="button"
                  className="source-overlay-close"
                  onClick={() =>
                    setSelectedSource(
                      null
                    )
                  }
                  aria-label="Close source details"
                >
                  ×
                </button>
              </div>

              <div className="source-overlay-body">
                {selectedSource.details ? (
                  <>
                    <div className="source-detail-section">
                      <div className="section-label">
                        RETRIEVAL
                        STATUS
                      </div>

                      <div className="source-detail-status">
                        ✓{" "}
                        {getSourceStatus(
                          selectedSource.details
                        )}
                      </div>
                    </div>

                    {selectedSource.details
                      .source_type && (
                      <div className="source-detail-section">
                        <div className="section-label">
                          SOURCE TYPE
                        </div>

                        <div className="source-detail-value">
                          {
                            selectedSource
                              .details
                              .source_type
                          }
                        </div>
                      </div>
                    )}

                    {selectedSource.details
                      .source_id && (
                      <div className="source-detail-section">
                        <div className="section-label">
                          SOURCE ID
                        </div>

                        <div className="source-detail-value">
                          {
                            selectedSource
                              .details
                              .source_id
                          }
                        </div>
                      </div>
                    )}

                    {selectedSource.details
                      .tables?.length >
                      0 && (
                      <div className="source-detail-section">
                        <div className="section-label">
                          TABLES
                        </div>

                        <div className="source-tag-list">
                          {selectedSource.details.tables.map(
                            (
                              table
                            ) => (
                              <span
                                className="source-tag"
                                key={String(
                                  table
                                )}
                              >
                                {String(
                                  table
                                )}
                              </span>
                            )
                          )}
                        </div>
                      </div>
                    )}

                    {selectedSource.details
                      .entities?.length >
                      0 && (
                      <div className="source-detail-section">
                        <div className="section-label">
                          ENTITIES
                        </div>

                        <div className="source-tag-list">
                          {selectedSource.details.entities.map(
                            (
                              entity
                            ) => (
                              <span
                                className="source-tag"
                                key={String(
                                  entity
                                )}
                              >
                                {String(
                                  entity
                                )}
                              </span>
                            )
                          )}
                        </div>
                      </div>
                    )}

                    {selectedSource.details
                      .columns?.length >
                      0 && (
                      <div className="source-detail-section">
                        <div className="section-label">
                          COLUMNS USED
                        </div>

                        <div className="source-column-list">
                          {selectedSource.details.columns.map(
                            (
                              column
                            ) => (
                              <span
                                className="source-column"
                                key={String(
                                  column
                                )}
                              >
                                {String(
                                  column
                                )}
                              </span>
                            )
                          )}
                        </div>
                      </div>
                    )}

                    {selectedSource.details
                      .query && (
                      <div className="source-detail-section">
                        <div className="section-label">
                          SQL QUERY
                        </div>

                        <pre className="source-query">
                          {
                            selectedSource
                              .details
                              .query
                          }
                        </pre>
                      </div>
                    )}

                    {typeof selectedSource
                      .details
                      .row_count ===
                      "number" && (
                      <div className="source-detail-section">
                        <div className="section-label">
                          ROWS
                          RETRIEVED
                        </div>

                        <div className="source-detail-value">
                          {
                            selectedSource
                              .details
                              .row_count
                          }
                        </div>
                      </div>
                    )}

                    {selectedSource.details
                      .resource && (
                      <div className="source-detail-section">
                        <div className="section-label">
                          RESOURCE
                        </div>

                        <div className="source-detail-value">
                          {
                            selectedSource
                              .details
                              .resource
                          }
                        </div>
                      </div>
                    )}

                    {typeof selectedSource
                      .details
                      .event_count ===
                      "number" && (
                      <div className="source-detail-section">
                        <div className="section-label">
                          EVENTS
                          RETRIEVED
                        </div>

                        <div className="source-detail-value">
                          {
                            selectedSource
                              .details
                              .event_count
                          }
                        </div>
                      </div>
                    )}

                    {selectedSource.details
                      .truncated !==
                      undefined && (
                      <div className="source-detail-section">
                        <div className="section-label">
                          RESULT STATUS
                        </div>

                        <div className="source-detail-value">
                          {selectedSource
                            .details
                            .truncated
                            ? "Results truncated"
                            : "Complete result set"}
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="source-empty-state">
                    No detailed
                    retrieval
                    information is
                    available for
                    this source.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}


export default App;