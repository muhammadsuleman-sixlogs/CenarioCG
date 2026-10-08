import React, { useState, useEffect } from "react";

export default function AdminFeedbackModal({
  isOpen,
  onClose,
  apiBaseUrl,
  getAuthHeaders,
  onFeedbackChanged
}) {
  const [feedbackList, setFeedbackList] = useState([]);
  const [stats, setStats] = useState({ total: 0, positive: 0, negative: 0 });
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("all"); // "all", "negative", "positive"
  const [search, setSearch] = useState("");
  const [expandedItems, setExpandedItems] = useState(new Set());

  const loadFeedback = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${apiBaseUrl}/api/feedback`, {
        headers: {
          ...getAuthHeaders()
        }
      });
      if (response.ok) {
        const data = await response.json();
        const items = data.feedback || [];
        setFeedbackList(items);
        setStats(data.stats || { total: 0, positive: 0, negative: 0 });
        // Initialize all loaded items as expanded by default
        setExpandedItems(new Set(items.map((i) => i.id)));
        if (onFeedbackChanged) {
          onFeedbackChanged(data.stats?.total || 0);
        }
      }
    } catch (err) {
      console.error("Failed to load feedback in Admin panel:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadFeedback();
    }
  }, [isOpen]);

  const handleDelete = async (id, e) => {
    e.stopPropagation();
    try {
      const response = await fetch(`${apiBaseUrl}/api/feedback/${id}`, {
        method: "DELETE",
        headers: {
          ...getAuthHeaders()
        }
      });
      if (response.ok) {
        loadFeedback();
      }
    } catch (err) {
      console.error("Failed to delete feedback entry:", err);
    }
  };

  const toggleExpand = (id) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!isOpen) return null;

  const filtered = feedbackList.filter((item) => {
    if (filter === "negative" && item.feedback_type !== "negative") return false;
    if (filter === "positive" && item.feedback_type !== "positive") return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      const matchQ = (item.question || "").toLowerCase().includes(q);
      const matchA = (item.answer || "").toLowerCase().includes(q);
      const matchC = (item.comment || "").toLowerCase().includes(q);
      return matchQ || matchA || matchC;
    }
    return true;
  });

  return (
    <div className="feedback-modal-overlay" onClick={onClose}>
      <div className="feedback-modal-card" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="feedback-modal-header">
          <div>
            <div className="feedback-modal-title-row">
              <span className="feedback-header-sparkle">✦</span>
              <h2>Agent Feedback & Optimization Log</h2>
              <span className="feedback-badge-total">{stats.total} Entries</span>
            </div>
            <p className="feedback-modal-desc">
              Super Admin inspection of user ratings, negative critique responses, and source traces for retrieval tuning.
            </p>
          </div>

          <button
            type="button"
            className="feedback-modal-close"
            onClick={onClose}
            title="Close Feedback Log"
          >
            ✕
          </button>
        </div>

        {/* Stats Row */}
        <div className="feedback-stats-row">
          <div className="feedback-stat-box">
            <span className="feedback-stat-val">{stats.total}</span>
            <span className="feedback-stat-lbl">Total Reviews</span>
          </div>

          <div className="feedback-stat-box positive">
            <span className="feedback-stat-val">👍 {stats.positive}</span>
            <span className="feedback-stat-lbl">Positive Responses</span>
          </div>

          <div className="feedback-stat-box negative">
            <span className="feedback-stat-val">👎 {stats.negative}</span>
            <span className="feedback-stat-lbl">Issues Flagged</span>
          </div>

          <div className="feedback-stat-box rate">
            <span className="feedback-stat-val">
              {stats.total > 0
                ? `${Math.round((stats.positive / stats.total) * 100)}%`
                : "100%"}
            </span>
            <span className="feedback-stat-lbl">Satisfaction Rate</span>
          </div>
        </div>

        {/* Filters and Search */}
        <div className="feedback-filter-bar">
          <div className="feedback-pills">
            <button
              type="button"
              className={`feedback-pill ${filter === "all" ? "active" : ""}`}
              onClick={() => setFilter("all")}
            >
              All ({stats.total})
            </button>
            <button
              type="button"
              className={`feedback-pill negative ${filter === "negative" ? "active" : ""}`}
              onClick={() => setFilter("negative")}
            >
              Issues Flagged ({stats.negative})
            </button>
            <button
              type="button"
              className={`feedback-pill positive ${filter === "positive" ? "active" : ""}`}
              onClick={() => setFilter("positive")}
            >
              Positive ({stats.positive})
            </button>
          </div>

          <div className="feedback-search-wrapper">
            <input
              type="text"
              placeholder="Search feedback context..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="feedback-search-input"
            />
            {search && (
              <button
                type="button"
                className="feedback-search-clear"
                onClick={() => setSearch("")}
              >
                ✕
              </button>
            )}
          </div>

          <button
            type="button"
            className="feedback-toggle-all-btn"
            onClick={() => {
              if (expandedItems.size > 0) {
                setExpandedItems(new Set());
              } else {
                setExpandedItems(new Set(filtered.map((item) => item.id)));
              }
            }}
            title={expandedItems.size > 0 ? "Collapse all items" : "Expand all items"}
          >
            {expandedItems.size > 0 ? "Collapse All" : "Expand All"}
          </button>

          <button
            type="button"
            className="feedback-refresh-btn"
            onClick={loadFeedback}
            title="Refresh list"
            disabled={loading}
          >
            ↻
          </button>
        </div>

        {/* Content List */}
        <div className="feedback-list-container">
          {loading ? (
            <div className="feedback-empty-state">
              <span className="feedback-empty-icon">↻</span>
              <p>Loading agent feedback...</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="feedback-empty-state">
              <span className="feedback-empty-icon">✓</span>
              <h4>No feedback records found</h4>
              <p>
                {filter === "negative"
                  ? "No negative issues have been flagged by users."
                  : search
                  ? "No feedback matched your search criteria."
                  : "Feedback submitted through chat responses will appear here for Admin optimization."}
              </p>
            </div>
          ) : (
            filtered.map((item) => {
              const isNegative = item.feedback_type === "negative";
              const isExpanded = expandedItems.has(item.id);
              const dateStr = item.created_at
                ? new Date(item.created_at).toLocaleString()
                : "Recent";

              return (
                <div
                  key={item.id}
                  className={`feedback-item-card ${isNegative ? "negative-border" : "positive-border"} ${isExpanded ? "expanded" : "collapsed"}`}
                >
                  <div
                    className="feedback-item-top"
                    onClick={() => toggleExpand(item.id)}
                    title={isExpanded ? "Click to close feedback detail" : "Click to expand feedback detail"}
                  >
                    <div className="feedback-item-tags">
                      <span className={`feedback-type-tag ${isNegative ? "negative" : "positive"}`}>
                        {isNegative ? "👎 ISSUE REPORTED" : "👍 POSITIVE"}
                      </span>
                      <span className="feedback-time-tag">{dateStr}</span>
                      {!isExpanded && item.question && (
                        <span className="feedback-question-preview">
                          "{item.question}"
                        </span>
                      )}
                    </div>

                    <div className="feedback-item-actions">
                      <button
                        type="button"
                        className="feedback-delete-btn"
                        onClick={(e) => handleDelete(item.id, e)}
                        title="Delete this feedback entry"
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        className={`feedback-expand-btn ${isExpanded ? "open" : ""}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpand(item.id);
                        }}
                        title={isExpanded ? "Click to close feedback detail" : "Click to expand feedback detail"}
                        aria-label={isExpanded ? "Close feedback detail" : "Expand feedback detail"}
                      >
                        {isExpanded ? "▲" : "▼"}
                      </button>
                    </div>
                  </div>

                  {/* Expandable Details Body */}
                  {isExpanded && (
                    <div className="feedback-item-body">
                      {/* Negative feedback prompt response */}
                      {isNegative && item.comment && (
                        <div className="feedback-critique-box">
                          <div className="feedback-critique-label">
                            What did we get wrong?
                          </div>
                          <div className="feedback-critique-text">
                            "{item.comment}"
                          </div>
                        </div>
                      )}

                      {/* Question */}
                      <div className="feedback-field">
                        <span className="feedback-field-label">USER QUESTION:</span>
                        <span className="feedback-field-val question-val">
                          {item.question || "(Empty question)"}
                        </span>
                      </div>

                      {/* Answer */}
                      <div className="feedback-field">
                        <span className="feedback-field-label">AGENT RESPONSE:</span>
                        <div className="feedback-field-val answer-val">
                          {item.answer || "(Empty answer)"}
                        </div>
                      </div>

                      {/* Sources info */}
                      {Array.isArray(item.sources) && item.sources.length > 0 && (
                        <div className="feedback-sources-row">
                          <span className="feedback-field-label">ATTRIBUTED SOURCES:</span>
                          <div className="feedback-sources-pills">
                            {item.sources.map((src, i) => {
                              const srcName = typeof src === "object" ? src.source_id || src.id || "source" : String(src);
                              return (
                                <span key={i} className="feedback-src-pill">
                                  {srcName}
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="feedback-modal-footer">
          <span className="feedback-footer-tip">
            💡 Tip: Use negative feedback to inspect incorrect source attribution and optimize the question planner.
          </span>
          <button type="button" className="feedback-footer-close-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
