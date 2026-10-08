import React, { useState } from "react";

export default function AgentFeedbackRow({
  message,
  precedingQuestion,
  apiBaseUrl,
  getAuthHeaders,
  onFeedbackRecorded
}) {
  const [feedbackType, setFeedbackType] = useState(message.feedbackState || null);
  const [showWrongPrompt, setShowWrongPrompt] = useState(false);
  const [wrongComment, setWrongComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [skipped, setSkipped] = useState(false);

  const sendFeedback = async (type, comment = "") => {
    setSubmitting(true);
    setStatusMessage("");

    try {
      const payload = {
        feedback_type: type,
        comment: comment.trim(),
        question: precedingQuestion || message.question || "",
        answer: message.content || "",
        conversation_id: message.conversation_id || null,
        sources: message.sources?.data_sources || message.sources || [],
        source_trace: message.sources || null,
        metadata: {
          timestamp: new Date().toISOString(),
          sources_count: (message.sources?.data_sources || []).length
        }
      };

      const response = await fetch(`${apiBaseUrl}/api/feedback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeaders()
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error("Failed to record feedback");
      }

      setFeedbackType(type);
      if (type === "positive") {
        setStatusMessage("Thank you for your feedback!");
      } else {
        setShowWrongPrompt(false);
        setStatusMessage("Feedback recorded for Super Admin optimization.");
      }

      if (onFeedbackRecorded) {
        onFeedbackRecorded();
      }
    } catch (err) {
      console.error("Error submitting feedback:", err);
      setStatusMessage("Could not save feedback. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleThumbsUp = () => {
    if (submitting) return;
    if (feedbackType === "positive") return;
    setShowWrongPrompt(false);
    sendFeedback("positive");
  };

  const handleThumbsDown = () => {
    if (submitting) return;
    if (feedbackType === "negative" && !showWrongPrompt) {
      // Toggle form open if they want to update/view
      setShowWrongPrompt(true);
      return;
    }
    setShowWrongPrompt((prev) => !prev);
  };

  const handleNegativeSubmit = (e) => {
    e.preventDefault();
    if (!wrongComment.trim() || submitting) return;
    sendFeedback("negative", wrongComment);
  };

  if (skipped) {
    return (
      <div className="agent-feedback-container skipped">
        <span className="feedback-skipped-text">Feedback skipped</span>
        <button
          type="button"
          className="feedback-undo-btn"
          onClick={() => setSkipped(false)}
          title="Rate this response"
        >
          Rate
        </button>
      </div>
    );
  }

  return (
    <div className="agent-feedback-container">
      <div className="agent-feedback-bar">
        <span className="feedback-hint">Rate this response:</span>

        <div className="feedback-buttons-group">
          <button
            type="button"
            className={`feedback-icon-btn thumbs-up ${feedbackType === "positive" ? "active" : ""}`}
            onClick={handleThumbsUp}
            disabled={submitting}
            title="Good response (Thumbs up)"
            aria-label="Thumbs up"
          >
            <span className="btn-icon">👍</span>
            {feedbackType === "positive" && <span className="btn-text">Helpful</span>}
          </button>

          <button
            type="button"
            className={`feedback-icon-btn thumbs-down ${feedbackType === "negative" ? "active" : ""}`}
            onClick={handleThumbsDown}
            disabled={submitting}
            title="Report issue (Thumbs down)"
            aria-label="Thumbs down"
          >
            <span className="btn-icon">👎</span>
            {feedbackType === "negative" && !showWrongPrompt && (
              <span className="btn-text">Issue reported</span>
            )}
          </button>

          {!feedbackType && (
            <button
              type="button"
              className="feedback-icon-btn skip-btn"
              onClick={() => setSkipped(true)}
              disabled={submitting}
              title="Skip giving feedback"
              aria-label="Skip feedback"
            >
              <span className="btn-text">Skip</span>
            </button>
          )}
        </div>

        {statusMessage && (
          <span className={`feedback-status-text ${feedbackType === "negative" ? "negative" : "positive"}`}>
            {statusMessage}
          </span>
        )}
      </div>

      {/* "What did we get wrong?" inline prompt */}
      {showWrongPrompt && (
        <form className="wrong-prompt-panel" onSubmit={handleNegativeSubmit}>
          <div className="wrong-prompt-header">
            <span className="wrong-prompt-icon">⚠️</span>
            <div className="wrong-prompt-title">What did we get wrong?</div>
          </div>
          <p className="wrong-prompt-subtitle">
            Provide details so our Super Admin can optimize retrieval patterns and fix inaccuracies:
          </p>

          <textarea
            className="wrong-prompt-textarea"
            rows={3}
            value={wrongComment}
            onChange={(e) => setWrongComment(e.target.value)}
            placeholder="E.g., Inaccurate project code, missed milestone date, incorrect table joined, hallucinated numbers..."
            disabled={submitting}
            autoFocus
          />

          <div className="wrong-prompt-actions">
            <button
              type="button"
              className="wrong-prompt-btn-cancel"
              onClick={() => setShowWrongPrompt(false)}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="wrong-prompt-btn-skip"
              onClick={() => {
                setShowWrongPrompt(false);
                setSkipped(true);
              }}
              disabled={submitting}
            >
              Skip
            </button>
            <button
              type="submit"
              className="wrong-prompt-btn-submit"
              disabled={!wrongComment.trim() || submitting}
            >
              {submitting ? "Submitting..." : "Submit Feedback"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
