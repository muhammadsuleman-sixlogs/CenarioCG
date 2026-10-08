import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Feedback storage directory: backend/data/feedback_store.json
const DATA_DIR = path.resolve(__dirname, "../data");
const FEEDBACK_FILE = path.join(DATA_DIR, "feedback_store.json");

function ensureStorageFile() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(FEEDBACK_FILE)) {
      fs.writeFileSync(FEEDBACK_FILE, JSON.stringify([], null, 2), "utf-8");
    }
  } catch (err) {
    console.error("Failed to ensure feedback storage file:", err);
  }
}

/**
 * Load all feedback items from disk.
 * @returns {Array<Object>}
 */
export function getAllFeedback() {
  ensureStorageFile();
  try {
    const raw = fs.readFileSync(FEEDBACK_FILE, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error("Failed to read feedback store:", err);
    return [];
  }
}

/**
 * Save a new feedback entry to the store.
 * @param {Object} feedbackData
 * @returns {Object}
 */
export function saveFeedback(feedbackData) {
  ensureStorageFile();
  const items = getAllFeedback();

  const id = `fb_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const timestamp = new Date().toISOString();

  const item = {
    id,
    feedback_type: feedbackData.feedback_type === "negative" ? "negative" : "positive",
    comment: String(feedbackData.comment || "").trim(),
    question: String(feedbackData.question || "").trim(),
    answer: String(feedbackData.answer || "").trim(),
    conversation_id: feedbackData.conversation_id || null,
    sources: Array.isArray(feedbackData.sources) ? feedbackData.sources : [],
    source_trace: feedbackData.source_trace || null,
    metadata: feedbackData.metadata || {},
    created_at: timestamp
  };

  // Prepend newest item first
  items.unshift(item);

  try {
    fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(items, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to write feedback item:", err);
    throw err;
  }

  return item;
}

/**
 * Get feedback summary statistics.
 * @returns {{total: number, positive: number, negative: number}}
 */
export function getFeedbackStats() {
  const items = getAllFeedback();
  let positive = 0;
  let negative = 0;

  for (const item of items) {
    if (item.feedback_type === "negative") {
      negative++;
    } else {
      positive++;
    }
  }

  return {
    total: items.length,
    positive,
    negative
  };
}

/**
 * Delete a specific feedback entry by id.
 * @param {string} id
 * @returns {boolean}
 */
export function deleteFeedback(id) {
  ensureStorageFile();
  const items = getAllFeedback();
  const filtered = items.filter((item) => item.id !== id);

  if (filtered.length === items.length) {
    return false;
  }

  try {
    fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(filtered, null, 2), "utf-8");
    return true;
  } catch (err) {
    console.error("Failed to delete feedback item:", err);
    throw err;
  }
}
