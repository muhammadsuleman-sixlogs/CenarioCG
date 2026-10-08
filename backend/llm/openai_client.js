import OpenAI from "openai";
import { settings } from "../config/settings.js";

export const OPENAI_MODEL =
  process.env.OPENAI_MODEL || settings.openaiModel || "gpt-5.4-nano-2026-03-17";

let cachedClient = null;
let cachedKey = null;

/**
 * Create and return the OpenAI client.
 * The API key is loaded from environment variables.
 */
export function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY || settings.openaiApiKey;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  if (cachedClient && cachedKey === apiKey) {
    return cachedClient;
  }

  cachedKey = apiKey;
  cachedClient = new OpenAI({ apiKey });
  return cachedClient;
}

export const get_openai_client = getOpenAIClient;

export default {
  getOpenAIClient,
  get_openai_client,
  OPENAI_MODEL
};
