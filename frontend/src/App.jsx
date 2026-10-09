import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import GraphView from "./components/GraphView";
import KpiDetailView from "./components/KpiDetailView";
import StreamingMarkdown from "./components/StreamingMarkdown";
import AgentFeedbackRow from "./components/AgentFeedbackRow";
import AdminFeedbackModal from "./components/AdminFeedbackModal";
import "./App.css";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000";

const EMPTY_GRAPH = {
  nodes: [],
  edges: [],
};

const EMPTY_GRAPH_TRACE = {
  nodes: [],
  edges: [],
  tables: [],
  source_entities: [],
  source_tables: [],
  matched_graph_nodes: [],
};

const EMPTY_SOURCE_TRACE = {
  data_sources: [],
  external_sources: [],
};

const EMPTY_GRAPH_SUMMARY = {
  nodes: 0,
  edges: 0,
  database_relationships: 0,
  business_relationships: 0,
};

function getNodeSource(node) {
  if (node?.source_id) return String(node.source_id);

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
  if (source === "security_logs_api") return "Security Logs";
  if (source === "postgresql") return "PostgreSQL";

  return sourceId || "Unknown";
}

function normalizeSourceId(source) {
  if (!source) return "";

  if (typeof source === "string") {
    return source;
  }

  return (
    source.source_id ||
    source.id ||
    source.name ||
    source.source ||
    ""
  );
}

function getSourceDetails(message, sourceId) {
  const normalizedSource = String(sourceId || "").toLowerCase();

  const responseData = message?.response_data || {};

  const responseSources = Array.isArray(responseData.sources)
    ? responseData.sources
    : [];

  const responseSourceTrace = responseData.source_trace || {};

  const traceDataSources = Array.isArray(
    responseSourceTrace.data_sources
  )
    ? responseSourceTrace.data_sources
    : [];

  const traceExternalSources = Array.isArray(
    responseSourceTrace.external_sources
  )
    ? responseSourceTrace.external_sources
    : [];

  const messageSourceTrace = message?.sources || {};

  const messageDataSources = Array.isArray(
    messageSourceTrace.data_sources
  )
    ? messageSourceTrace.data_sources
    : [];

  const messageExternalSources = Array.isArray(
    messageSourceTrace.external_sources
  )
    ? messageSourceTrace.external_sources
    : [];

  const allSources = [
    ...responseSources,
    ...traceDataSources,
    ...traceExternalSources,
    ...messageDataSources,
    ...messageExternalSources,
  ];

  const objectSources = allSources.filter(
    (source) => source && typeof source === "object"
  );

  if (normalizedSource === "postgresql") {
    const postgresSources = objectSources.filter((source) => {
      const candidates = [
        source?.source_id,
        source?.id,
        source?.source,
        source?.name,
        source?.source_type,
      ]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase());

      return (
        source?.source_type === "postgresql" ||
        candidates.includes("postgresql") ||
        candidates.includes("db1") ||
        candidates.includes("db2")
      );
    });

    if (postgresSources.length === 1) {
      return postgresSources[0];
    }

    if (postgresSources.length > 1) {
      const combinedTables = Array.from(
        new Set(postgresSources.flatMap((s) => s.tables || []))
      );
      const combinedEntities = Array.from(
        new Set(postgresSources.flatMap((s) => s.entities || []))
      );
      const combinedColumns = Array.from(
        new Set(postgresSources.flatMap((s) => s.columns || []))
      );
      const combinedQueries = postgresSources
        .map((s) => {
          const label = s.source_id || s.source || s.name || "PostgreSQL";
          return `-- Source (${label}):\n${s.query || "No query recorded"}`;
        })
        .join("\n\n");
      const totalRowCount = postgresSources.reduce(
        (sum, s) => sum + (typeof s.row_count === "number" ? s.row_count : 0),
        0
      );
      const sourceIds = Array.from(
        new Set(
          postgresSources.map(
            (s) => s.source_id || s.source || "postgresql"
          )
        )
      ).join(", ");

      return {
        source_type: "postgresql",
        source_id: sourceIds,
        tables: combinedTables,
        entities: combinedEntities,
        columns: combinedColumns,
        query: combinedQueries,
        row_count: totalRowCount,
        retrieval_status:
          totalRowCount > 0 ? "success_with_data" : "success_empty",
      };
    }
  }

  const matchingSource = objectSources.find((source) => {
    const candidates = [
      source?.source_id,
      source?.id,
      source?.source,
      source?.name,
      source?.source_type,
    ]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());

    if (candidates.includes(normalizedSource)) {
      return true;
    }

    if (
      (normalizedSource === "security_logs" ||
        normalizedSource === "security_logs_api") &&
      (candidates.includes("security_logs") ||
        candidates.includes("security_logs_api"))
    ) {
      return true;
    }

    return false;
  });

  return matchingSource || null;
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

  if (details.error) {
    return `Retrieval error: ${details.error}`;
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

function normalizeSourceTrace(trace) {
  if (!trace || typeof trace !== "object") {
    return EMPTY_SOURCE_TRACE;
  }

  return {
    data_sources: Array.isArray(trace.data_sources)
      ? trace.data_sources
      : [],
    external_sources: Array.isArray(trace.external_sources)
      ? trace.external_sources
      : [],
  };
}

function LoginScreen({
  username,
  setUsername,
  password,
  setPassword,
  loginError,
  loginLoading,
  onSubmit,
}) {
  return (
    <div className="app login-app">
      <main className="login-page">
        <div className="login-card">
          <div className="login-logo">
            <span>C</span>
          </div>

          <div className="login-header">
            <div className="header-eyebrow">
              AI DATA INTELLIGENCE
            </div>

            <h1>CENARIO</h1>

            <p>
              Sign in to access the Context Layer.
            </p>
          </div>

          <form
            className="login-form"
            onSubmit={onSubmit}
          >
            <label className="login-field">
              <span>USERNAME</span>

              <input
                type="text"
                value={username}
                onChange={(event) =>
                  setUsername(event.target.value)
                }
                autoComplete="username"
                placeholder="Admin username"
                disabled={loginLoading}
              />
            </label>

            <label className="login-field">
              <span>PASSWORD</span>

              <input
                type="password"
                value={password}
                onChange={(event) =>
                  setPassword(event.target.value)
                }
                autoComplete="current-password"
                placeholder="Password"
                disabled={loginLoading}
              />
            </label>

            {loginError && (
              <div className="login-error">
                {loginError}
              </div>
            )}

            <button
              type="submit"
              className="login-submit"
              disabled={
                loginLoading ||
                !username.trim() ||
                !password
              }
            >
              {loginLoading
                ? "Signing in..."
                : "Sign in"}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}

function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [authChecking, setAuthChecking] = useState(true);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);

  const [selectedEntity, setSelectedEntity] = useState(null);
  const [selectedSource, setSelectedSource] = useState(null);
  const [selectedKpi, setSelectedKpi] = useState(null);
  const [showAdminFeedback, setShowAdminFeedback] = useState(false);
  const [feedbackCount, setFeedbackCount] = useState(0);

  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [graphData, setGraphData] = useState(EMPTY_GRAPH);

  const [graphTrace, setGraphTrace] =
    useState(EMPTY_GRAPH_TRACE);

  const [sourceTrace, setSourceTrace] =
    useState(EMPTY_SOURCE_TRACE);

  const [graphSummary, setGraphSummary] =
    useState(EMPTY_GRAPH_SUMMARY);

  const sourceSummary = useMemo(() => {
    const counts = {};

    (graphData?.nodes || []).forEach((node) => {
      const sourceId = getNodeSource(node);

      counts[sourceId] =
        (counts[sourceId] || 0) + 1;
    });

    return Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([sourceId, count]) => ({
        sourceId,
        label: getSourceLabel(sourceId),
        count,
      }));
  }, [graphData]);

  const activeAnswerSources = useMemo(() => {
    const sources = new Set();

    (sourceTrace?.data_sources || []).forEach(
      (source) => {
        const normalized = normalizeSourceId(source);

        if (normalized) {
          sources.add(String(normalized));
        }
      }
    );

    (sourceTrace?.external_sources || []).forEach(
      (source) => {
        const normalized = normalizeSourceId(source);

        if (normalized) {
          sources.add(String(normalized));
        }
      }
    );

    return Array.from(sources);
  }, [sourceTrace]);

  const getAuthHeaders = (overrideToken) => {
    const token =
      overrideToken ||
      localStorage.getItem("cenariocg_token") ||
      "";

    if (!token) {
      return {};
    }

    return {
      Authorization: `Bearer ${token}`,
    };
  };

  const clearApplicationState = () => {
    localStorage.removeItem("cenariocg_token");
    setAuthenticated(false);

    setUsername("");
    setPassword("");
    setLoginError("");

    setSelectedEntity(null);
    setSelectedSource(null);
    setSelectedKpi(null);

    setQuestion("");
    setMessages([]);
    setLoading(false);
    setRefreshing(false);

    setGraphData(EMPTY_GRAPH);
    setGraphTrace(EMPTY_GRAPH_TRACE);
    setSourceTrace(EMPTY_SOURCE_TRACE);
    setGraphSummary(EMPTY_GRAPH_SUMMARY);
  };

  const clearChatState = () => {
    setMessages([]);
    setQuestion("");
    setLoading(false);
    setSelectedSource(null);

    setGraphTrace(EMPTY_GRAPH_TRACE);
    setSourceTrace(EMPTY_SOURCE_TRACE);
  };

  const checkAuthentication = async (overrideToken) => {
    try {
      const response = await fetch(
        `${API_BASE_URL}/api/auth/me`,
        {
          method: "GET",
          credentials: "include",
          headers: {
            ...getAuthHeaders(overrideToken),
          },
        }
      );

      if (!response.ok) {
        clearApplicationState();
        return false;
      }

      setAuthenticated(true);
      return true;
    } catch (error) {
      console.error(
        "Authentication check failed:",
        error
      );

      clearApplicationState();
      return false;
    }
  };

  const handleLogin = async (event) => {
    event.preventDefault();

    if (
      loginLoading ||
      !username.trim() ||
      !password
    ) {
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
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            username: username.trim(),
            password,
          }),
        }
      );

      const data = await response
        .json()
        .catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.detail ||
          "Invalid username or password."
        );
      }

      if (data?.token) {
        localStorage.setItem("cenariocg_token", data.token);
      }

      const authenticatedNow =
        await checkAuthentication(data?.token);

      if (!authenticatedNow) {
        throw new Error(
          "Login succeeded, but the authentication session could not be verified."
        );
      }

      setPassword("");
      setLoginError("");
    } catch (error) {
      console.error("Login failed:", error);

      setAuthenticated(false);

      setLoginError(
        error?.message ||
        "Unable to sign in right now."
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
          headers: {
            ...getAuthHeaders(),
          },
        }
      );
    } catch (error) {
      console.error(
        "Logout request failed:",
        error
      );
    } finally {
      clearApplicationState();
    }
  };

  const loadGraph = async () => {
    if (refreshing) {
      return;
    }

    setRefreshing(true);
    setGraphTrace(EMPTY_GRAPH_TRACE);
    setSourceTrace(EMPTY_SOURCE_TRACE);
    setSelectedEntity(null);

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/graph?t=${Date.now()}`,
        {
          method: "GET",
          credentials: "include",
          headers: {
            ...getAuthHeaders(),
          },
          cache: "no-store",
        }
      );

      if (response.status === 401) {
        clearApplicationState();
        return;
      }

      if (!response.ok) {
        throw new Error(
          `Failed to load graph (${response.status})`
        );
      }

      const data = await response.json();

      setGraphData(
        data?.graph || EMPTY_GRAPH
      );

      setGraphSummary(
        data?.graph_summary ||
        EMPTY_GRAPH_SUMMARY
      );
    } catch (error) {
      console.error(
        "Failed to load context graph:",
        error
      );
    } finally {
      setRefreshing(false);
    }
  };

  const handleRefresh = async () => {
    setGraphTrace(EMPTY_GRAPH_TRACE);
    setSourceTrace(EMPTY_SOURCE_TRACE);
    setSelectedEntity(null);
    setSelectedSource(null);
    await loadGraph();
    await fetchFeedbackCount();
  };

  const fetchFeedbackCount = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/feedback`, {
        headers: {
          ...getAuthHeaders(),
        },
      });
      if (response.ok) {
        const data = await response.json();
        setFeedbackCount(data?.stats?.total || 0);
      }
    } catch {
      // Ignore background error
    }
  };

  const handleNewChat = () => {
    clearChatState();

    setSelectedEntity(null);
  };

  useEffect(() => {
    let mounted = true;

    const initializeAuthentication =
      async () => {
        try {
          const response = await fetch(
            `${API_BASE_URL}/api/auth/me`,
            {
              method: "GET",
              credentials: "include",
              headers: {
                ...getAuthHeaders(),
              },
            }
          );

          if (!mounted) return;

          if (response.ok) {
            setAuthenticated(true);
          } else {
            setAuthenticated(false);
          }
        } catch (error) {
          if (!mounted) return;

          console.error(
            "Initial authentication check failed:",
            error
          );

          setAuthenticated(false);
        } finally {
          if (mounted) {
            setAuthChecking(false);
          }
        }
      };

    initializeAuthentication();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!authenticated) {
      return;
    }

    loadGraph();
    fetchFeedbackCount();
  }, [authenticated]);

  const handleEntitySelect = useCallback((entity) => {
    setSelectedEntity(entity);
  }, []);

  const handleAsk = async () => {
    const trimmedQuestion = question.trim();

    if (!trimmedQuestion || loading) {
      return;
    }

    const userTimestamp = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    setMessages((previous) => [
      ...previous,
      {
        role: "user",
        content: trimmedQuestion,
        timestamp: userTimestamp,
      },
    ]);

    setQuestion("");
    setLoading(true);
    setSelectedSource(null);

    // Clear previous highlights immediately so graph returns to original full/default state while processing
    setGraphTrace(EMPTY_GRAPH_TRACE);
    setSourceTrace(EMPTY_SOURCE_TRACE);

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/chat`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            ...getAuthHeaders(),
          },
          body: JSON.stringify({
            question: trimmedQuestion,
          }),
        }
      );

      const data = await response
        .json()
        .catch(() => ({}));

      if (response.status === 401) {
        clearApplicationState();

        throw new Error(
          "Your session has expired. Please sign in again."
        );
      }

      if (!response.ok) {
        throw new Error(
          data?.detail ||
          "Unable to process the question."
        );
      }

      /*
       * IMPORTANT:
       * source_trace is the actual provenance object.
       *
       * Some backend responses may place it at:
       *   data.source_trace
       *
       * while retrieval metadata may additionally exist at:
       *   data.sources
       *
       * We preserve BOTH.
       */

      const answerSourceTrace =
        normalizeSourceTrace(
          data?.source_trace
        );

      const responseWithTrace = {
        ...data,
        source_trace: answerSourceTrace,
        sources: Array.isArray(data?.sources)
          ? data.sources
          : [],
      };

      const assistantTimestamp = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });

      setMessages((previous) => [
        ...previous,
        {
          id: `msg-${Date.now()}`,
          role: "assistant",
          content:
            data?.answer ||
            "I could not generate an answer.",
          sources: answerSourceTrace,
          response_data: responseWithTrace,
          isStreaming: true,
          precedingQuestion: trimmedQuestion,
          timestamp: assistantTimestamp,
        },
      ]);

      setGraphData(
        data?.graph || EMPTY_GRAPH
      );

      setGraphTrace(
        data?.graph_trace ||
        EMPTY_GRAPH_TRACE
      );

      setSourceTrace(answerSourceTrace);

      if (data?.graph_summary) {
        setGraphSummary(
          data.graph_summary
        );
      }
    } catch (error) {
      console.error(
        "Chat request failed:",
        error
      );

      const assistantTimestamp = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });

      setMessages((previous) => [
        ...previous,
        {
          id: `msg-${Date.now()}`,
          role: "assistant",
          content:
            error?.message ||
            "Sorry, I could not process your question right now.",
          sources: EMPTY_SOURCE_TRACE,
          response_data: null,
          isStreaming: false,
          precedingQuestion: trimmedQuestion,
          timestamp: assistantTimestamp,
        },
      ]);
    } finally {
      /*
       * IMPORTANT:
       * Always stop the tracing/loading state,
       * including failed requests and API errors.
       */
      setLoading(false);
    }
  };

  const handleSuggestion = (suggestion) => {
    setQuestion(suggestion);
  };

  if (authChecking) {
    return (
      <div className="app login-app">
        <main className="login-page">
          <div className="login-card">
            <div className="login-logo">
              <span>C</span>
            </div>

            <div className="login-header">
              <div className="header-eyebrow">
                AI DATA INTELLIGENCE
              </div>

              <h1>CENARIO</h1>

              <p>
                Verifying authentication session...
              </p>
            </div>

            <div className="login-loading">
              <span className="thinking-indicator">
                <span />
                <span />
                <span />
              </span>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <LoginScreen
        username={username}
        setUsername={setUsername}
        password={password}
        setPassword={setPassword}
        loginError={loginError}
        loginLoading={loginLoading}
        onSubmit={handleLogin}
      />
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <span>C</span>
        </div>

        <nav className="sidebar-nav">
          <button
            className="sidebar-button new-chat-button"
            type="button"
            title="New Chat"
            onClick={handleNewChat}
          >
            <span>＋</span>
            <span className="sidebar-button-text">
              New Chat
            </span>
          </button>
        </nav>

        <div className="sidebar-bottom">
          <div className="status-dot" />

          <span className="sidebar-status-text">
            Connected
          </span>
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
            <button
              type="button"
              className="header-feedback-btn"
              onClick={() => setShowAdminFeedback(true)}
              title="Inspect Agent Feedback & Optimization Log"
            >
              <span className="feedback-btn-sparkle">💬</span>
              <span>Feedback</span>
              {feedbackCount > 0 && (
                <span className="header-feedback-badge">{feedbackCount}</span>
              )}
            </button>

            <div className="system-status">
              <span className="system-dot" />
              Context Layer Active
            </div>

            <button
              type="button"
              className="header-avatar header-logout-button"
              onClick={handleLogout}
              title="Logout"
              aria-label="Logout"
            >
              Logout
            </button>
          </div>
        </header>

        <div className="page">
          <section className="stats-grid">
            <div
              className={`stat-card clickable ${selectedKpi === "entities" ? "active" : ""}`}
              onClick={() => setSelectedKpi(selectedKpi === "entities" ? null : "entities")}
              title="Click to inspect all discovered entities and schema attributes"
            >
              <div className="stat-icon">
                ◈
              </div>

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
              <div className="stat-card-active-indicator" />
            </div>

            <div
              className={`stat-card clickable ${selectedKpi === "database" ? "active" : ""}`}
              onClick={() => setSelectedKpi(selectedKpi === "database" ? null : "database")}
              title="Click to inspect all discovered database foreign-key relationships"
            >
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
                  Database Relationships
                </div>
              </div>

              <div className="stat-description">
                PostgreSQL relationships
              </div>
              <div className="stat-card-active-indicator" />
            </div>

            <div
              className={`stat-card clickable ${selectedKpi === "business" ? "active" : ""}`}
              onClick={() => setSelectedKpi(selectedKpi === "business" ? null : "business")}
              title="Click to inspect all discovered business-semantic relationships"
            >
              <div className="stat-icon">
                C
              </div>

              <div>
                <div className="stat-number">
                  {
                    graphSummary.business_relationships
                  }
                </div>

                <div className="stat-label">
                  Business Relationships
                </div>
              </div>

              <div className="stat-description">
                Validated relationships
              </div>
              <div className="stat-card-active-indicator" />
            </div>

            <div
              className={`stat-card clickable ${selectedKpi === "connections" ? "active" : ""}`}
              onClick={() => setSelectedKpi(selectedKpi === "connections" ? null : "connections")}
              title="Click to inspect all 236 graph connections and edges"
            >
              <div className="stat-icon">
                ◎
              </div>

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
              <div className="stat-card-active-indicator" />
            </div>
          </section>

          {selectedKpi && (
            <KpiDetailView
              selectedKpi={selectedKpi}
              graphData={graphData}
              graphSummary={graphSummary}
              onClose={() => setSelectedKpi(null)}
              onSelectEntity={(entity) => {
                setSelectedEntity(entity);
              }}
            />
          )}

          <section className="source-overview unified-source-bar">
            <div className="source-cards-inline">
              {sourceSummary.length > 0 ? (
                sourceSummary.map((source) => (
                  <div
                    className="source-card compact"
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

            <div className="query-sources-inline-group">
              <div className="query-sources-divider" />
              <span className="query-sources-label">
                CURRENT QUERY SOURCES
              </span>
              <div className="query-sources-list">
                {activeAnswerSources.length > 0 ? (
                  activeAnswerSources.map((source) => (
                    <span
                      className="query-source-pill"
                      key={source}
                    >
                      {getSourceLabel(source)}
                    </span>
                  ))
                ) : (
                  <span className="query-source-pill idle">
                    Ready
                  </span>
                )}
              </div>
            </div>

            <div className="source-overview-live">
              <span />
              LIVE
            </div>
          </section>

          <section className="workspace">
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
                    Dynamically discovered entities
                    and relationships
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
                  selectedEntity={selectedEntity}
                  onEntitySelect={handleEntitySelect}
                  loading={loading}
                  refreshing={refreshing}
                  onRefresh={handleRefresh}
                />

                <div className="graph-overlay">
                  <div className="graph-overlay-title">
                    Context Layer
                  </div>

                  <div className="graph-overlay-text">
                    {(graphData.nodes || []).length}{" "}
                    visible entities
                  </div>
                </div>
              </div>
            </div>

            <aside className="panel entity-panel">
              <div className="panel-header">
                <div>
                  <h2>Entity Details</h2>

                  <p>
                    Inspect discovered schema
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
                        {selectedEntity.label}
                      </div>

                      <div className="entity-type">
                        {selectedEntity.type}
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
                    Click a node in the graph to
                    inspect its dynamically discovered
                    attributes and source.
                  </p>
                </div>
              )}
            </aside>
          </section>

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
                  Ask questions across your connected
                  data
                </p>
              </div>
            </div>

            <div className="chat-content">
              {messages.length === 0 ? (
                <div className="chat-empty">
                  <div className="chat-icon">
                    C
                  </div>

                  <h3>Ask Cenario</h3>

                  <p>
                    Query your connected data using
                    natural language.
                  </p>

                  <div className="suggestions">
                    <button
                      type="button"
                      onClick={() =>
                        handleSuggestion(
                          "What is the total number of companies?"
                        )
                      }
                    >
                      Total companies
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        handleSuggestion(
                          "Show me recent meetings"
                        )
                      }
                    >
                      Show me recent meetings
                    </button>
                  </div>
                </div>
              ) : (
                <div className="messages">
                  {messages.map(
                    (message, index) => (
                      <div
                        key={`msg-${index}`}
                        className={`message ${message.role}`}
                      >
                        <div className="message-role">
                          {message.role}
                        </div>

                        <div className="message-content">
                          {message.role === "assistant" ? (
                            <StreamingMarkdown
                              content={message.content}
                              isStreaming={message.isStreaming}
                              onComplete={() => {
                                setMessages((previous) =>
                                  previous.map((msg, i) =>
                                    i === index
                                      ? { ...msg, isStreaming: false }
                                      : msg
                                  )
                                );
                              }}
                            />
                          ) : (
                            message.content
                          )}
                        </div>

                        {message.role ===
                          "assistant" &&
                          (() => {
                            const trace =
                              normalizeSourceTrace(
                                message.sources
                              );

                            const dataSources =
                              trace.data_sources;

                            const externalSources =
                              trace.external_sources;

                            if (
                              dataSources.length ===
                              0 &&
                              externalSources.length ===
                              0
                            ) {
                              return null;
                            }

                            return (
                              <div className="message-source-row">
                                {dataSources.map(
                                  (source) => {
                                    const sourceId =
                                      normalizeSourceId(
                                        source
                                      );

                                    if (!sourceId) {
                                      return null;
                                    }

                                    return (
                                      <button
                                        type="button"
                                        className="message-source-pill"
                                        key={sourceId}
                                        onClick={() =>
                                          setSelectedSource(
                                            {
                                              source:
                                                sourceId,
                                              message,
                                              details:
                                                getSourceDetails(
                                                  message,
                                                  sourceId
                                                ),
                                            }
                                          )
                                        }
                                      >
                                        {getSourceLabel(
                                          sourceId
                                        )}
                                      </button>
                                    );
                                  }
                                )}

                                {externalSources.map(
                                  (source) => {
                                    const sourceId =
                                      normalizeSourceId(
                                        source
                                      );

                                    if (!sourceId) {
                                      return null;
                                    }

                                    return (
                                      <button
                                        type="button"
                                        className="message-source-pill"
                                        key={sourceId}
                                        onClick={() =>
                                          setSelectedSource(
                                            {
                                              source:
                                                sourceId,
                                              message,
                                              details:
                                                getSourceDetails(
                                                  message,
                                                  sourceId
                                                ),
                                            }
                                          )
                                        }
                                      >
                                        {getSourceLabel(
                                          sourceId
                                        )}
                                      </button>
                                    );
                                  }
                                )}
                              </div>
                            );
                          })()}

                        {message.role === "assistant" && !message.isStreaming && (
                          <AgentFeedbackRow
                            message={message}
                            precedingQuestion={
                              message.precedingQuestion ||
                              (messages[index - 1]?.role === "user"
                                ? messages[index - 1].content
                                : "")
                            }
                            apiBaseUrl={API_BASE_URL}
                            getAuthHeaders={getAuthHeaders}
                            onFeedbackRecorded={fetchFeedbackCount}
                          />
                        )}

                        {message.timestamp && !message.isStreaming && (
                          <div className={`message-time ${message.role}`}>
                            {message.timestamp}
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
                    setQuestion(
                      event.target.value
                    )
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
              setSelectedSource(null)
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
                    Retrieval & provenance
                  </div>
                </div>

                <button
                  type="button"
                  className="source-overlay-close"
                  onClick={() =>
                    setSelectedSource(null)
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
                        RETRIEVAL STATUS
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
                              selectedSource.details
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
                              selectedSource.details
                                .source_id
                            }
                          </div>
                        </div>
                      )}

                    {selectedSource.details
                      .tables?.length > 0 && (
                        <div className="source-detail-section">
                          <div className="section-label">
                            TABLES
                          </div>

                          <div className="source-tag-list">
                            {selectedSource.details.tables.map(
                              (table) => (
                                <span
                                  className="source-tag"
                                  key={String(table)}
                                >
                                  {String(table)}
                                </span>
                              )
                            )}
                          </div>
                        </div>
                      )}

                    {selectedSource.details
                      .entities?.length > 0 && (
                        <div className="source-detail-section">
                          <div className="section-label">
                            ENTITIES
                          </div>

                          <div className="source-tag-list">
                            {selectedSource.details.entities.map(
                              (entity) => (
                                <span
                                  className="source-tag"
                                  key={String(entity)}
                                >
                                  {String(entity)}
                                </span>
                              )
                            )}
                          </div>
                        </div>
                      )}

                    {selectedSource.details
                      .columns?.length > 0 && (
                        <div className="source-detail-section">
                          <div className="section-label">
                            COLUMNS USED
                          </div>

                          <div className="source-column-list">
                            {selectedSource.details.columns.map(
                              (column) => (
                                <span
                                  className="source-column"
                                  key={String(column)}
                                >
                                  {String(column)}
                                </span>
                              )
                            )}
                          </div>
                        </div>
                      )}

                    {selectedSource.details.query && (
                      <div className="source-detail-section">
                        <div className="section-label">
                          SQL QUERY
                        </div>

                        <pre className="source-query">
                          {
                            selectedSource.details
                              .query
                          }
                        </pre>
                      </div>
                    )}

                    {typeof selectedSource.details
                      .row_count ===
                      "number" && (
                        <div className="source-detail-section">
                          <div className="section-label">
                            ROWS RETRIEVED
                          </div>

                          <div className="source-detail-value">
                            {
                              selectedSource.details
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
                              selectedSource.details
                                .resource
                            }
                          </div>
                        </div>
                      )}

                    {typeof selectedSource.details
                      .event_count ===
                      "number" && (
                        <div className="source-detail-section">
                          <div className="section-label">
                            EVENTS RETRIEVED
                          </div>

                          <div className="source-detail-value">
                            {
                              selectedSource.details
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
                            {selectedSource.details
                              .truncated
                              ? "Results truncated"
                              : "Complete result set"}
                          </div>
                        </div>
                      )}
                  </>
                ) : (
                  <div className="source-empty-state">
                    No detailed retrieval information
                    is available for this source.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <AdminFeedbackModal
          isOpen={showAdminFeedback}
          onClose={() => setShowAdminFeedback(false)}
          apiBaseUrl={API_BASE_URL}
          getAuthHeaders={getAuthHeaders}
          onFeedbackChanged={(count) => setFeedbackCount(count)}
        />
      </main>
    </div>
  );
}

export default App;