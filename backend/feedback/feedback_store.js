import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Local workspace storage directory (standard development)
const LOCAL_DATA_DIR = path.resolve(__dirname, "../data");
const LOCAL_FEEDBACK_FILE = path.join(LOCAL_DATA_DIR, "feedback_store.json");

// Serverless writable storage (/tmp is the only guaranteed writable directory on Vercel/Lambda)
const TMP_FEEDBACK_FILE = path.join(os.tmpdir(), "cenario_feedback_store.json");

// In-memory cache ensures feedback is always preserved in memory even if disk write fails
let memoryFeedbackStore = null;

const isServerless = Boolean(
  process.env.VERCEL ||
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
  process.env.LAMBDA_TASK_ROOT
);

function getPreferredFilePath() {
  if (isServerless) {
    return TMP_FEEDBACK_FILE;
  }
  return LOCAL_FEEDBACK_FILE;
}

function readJsonFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch (err) {
    // Non-fatal read failure
  }
  return null;
}

function writeJsonFile(filePath, data) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    return true;
  } catch (err) {
    return false;
  }
}

function initMemoryStore() {
  if (memoryFeedbackStore !== null) {
    return;
  }

  // 1. Try reading preferred path
  let loaded = readJsonFile(getPreferredFilePath());

  // 2. If running on Vercel and /tmp doesn't have data yet, read bundled seed data from LOCAL_FEEDBACK_FILE
  if (!loaded && isServerless) {
    loaded = readJsonFile(LOCAL_FEEDBACK_FILE);
  }

  // 3. Fallback to /tmp if local read failed
  if (!loaded && !isServerless) {
    loaded = readJsonFile(TMP_FEEDBACK_FILE);
  }

  memoryFeedbackStore = Array.isArray(loaded) ? loaded : [];
}

function persistStore() {
  if (!memoryFeedbackStore) {
    return;
  }

  const preferredPath = getPreferredFilePath();
  const success = writeJsonFile(preferredPath, memoryFeedbackStore);

  // If writing to preferred path failed (e.g. read-only filesystem on Vercel), fallback to /tmp
  if (!success && preferredPath !== TMP_FEEDBACK_FILE) {
    writeJsonFile(TMP_FEEDBACK_FILE, memoryFeedbackStore);
  }
}

/**
 * Load all feedback items.
 * @returns {Array<Object>}
 */
export function getAllFeedback() {
  initMemoryStore();

  // Check if newer data was written to preferred file or tmp
  const diskData = readJsonFile(getPreferredFilePath()) || readJsonFile(TMP_FEEDBACK_FILE);
  if (Array.isArray(diskData) && diskData.length > 0) {
    const existingIds = new Set(memoryFeedbackStore.map((item) => item.id));
    for (const item of diskData) {
      if (item && item.id && !existingIds.has(item.id)) {
        memoryFeedbackStore.push(item);
        existingIds.add(item.id);
      }
    }
  }

  return [...memoryFeedbackStore];
}

/**
 * Save a new feedback entry.
 * Resilient to read-only environments: saves to in-memory store and persists to disk if writable.
 * @param {Object} feedbackData
 * @returns {Object}
 */
export function saveFeedback(feedbackData) {
  initMemoryStore();

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
  memoryFeedbackStore.unshift(item);

  // Persist to disk (non-blocking failure in serverless read-only mode)
  try {
    persistStore();
  } catch (err) {
    console.warn("Notice: Feedback saved in-memory (disk persistence skipped):", err?.message);
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
  initMemoryStore();
  const initialCount = memoryFeedbackStore.length;
  memoryFeedbackStore = memoryFeedbackStore.filter((item) => item.id !== id);

  if (memoryFeedbackStore.length === initialCount) {
    return false;
  }

  try {
    persistStore();
  } catch (err) {
    console.warn("Notice: Feedback deleted from memory (disk persistence skipped):", err?.message);
  }

  return true;
}

