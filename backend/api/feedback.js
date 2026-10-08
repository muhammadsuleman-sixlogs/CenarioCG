import express from "express";
import {
  saveFeedback,
  getAllFeedback,
  getFeedbackStats,
  deleteFeedback
} from "../feedback/feedback_store.js";

const router = express.Router();

// GET /api/feedback - Retrieve all recorded agent feedback
router.get("/", (req, res) => {
  try {
    const feedback = getAllFeedback();
    const stats = getFeedbackStats();

    return res.json({
      status: "ok",
      feedback,
      stats
    });
  } catch (err) {
    console.error("GET /api/feedback error:", err);
    return res.status(500).json({
      detail: "Failed to retrieve feedback."
    });
  }
});

// POST /api/feedback - Save a new feedback entry
router.post("/", (req, res) => {
  try {
    const body = req.body || {};
    const feedbackType = body.feedback_type === "negative" ? "negative" : "positive";

    if (!body.answer && !body.question) {
      return res.status(400).json({
        detail: "Missing question or answer context for feedback."
      });
    }

    const saved = saveFeedback({
      feedback_type: feedbackType,
      comment: body.comment || "",
      question: body.question || "",
      answer: body.answer || "",
      conversation_id: body.conversation_id || null,
      sources: body.sources || [],
      source_trace: body.source_trace || null,
      metadata: body.metadata || {}
    });

    return res.status(201).json({
      status: "ok",
      feedback: saved
    });
  } catch (err) {
    console.error("POST /api/feedback error:", err);
    return res.status(500).json({
      detail: "Failed to record feedback."
    });
  }
});

// DELETE /api/feedback/:id - Remove a feedback entry
router.delete("/:id", (req, res) => {
  try {
    const id = req.params.id;
    const deleted = deleteFeedback(id);

    return res.json({
      status: "ok",
      deleted
    });
  } catch (err) {
    console.error("DELETE /api/feedback error:", err);
    return res.status(500).json({
      detail: "Failed to delete feedback."
    });
  }
});

export default router;
