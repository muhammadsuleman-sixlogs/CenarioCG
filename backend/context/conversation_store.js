import crypto from "crypto";
import { ContextManager } from "./context_manager.js";

/** Bounded process-local store for the explicitly supported single-process deployment. */
export class ConversationStore {
  constructor({ ttlMs = 8 * 60 * 60 * 1000, maxConversations = 500 } = {}) {
    this.ttlMs = ttlMs;
    this.maxConversations = maxConversations;
    this.conversations = new Map();
  }

  _validId(value) { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
  _cleanup(now = Date.now()) { for (const [id, item] of this.conversations) if (item.expires_at <= now) this.conversations.delete(id); }

  getOrCreate({ conversationId = null, principal, workspaceId }) {
    this._cleanup();
    if (typeof principal !== "string" || !principal || typeof workspaceId !== "string" || !workspaceId) throw new Error("Conversation ownership context is required.");
    if (!conversationId) {
      if (this.conversations.size >= this.maxConversations) this._cleanup(Date.now() + this.ttlMs);
      const id = crypto.randomUUID();
      const item = { id, principal, workspace_id: workspaceId, context_manager: new ContextManager(), expires_at: Date.now() + this.ttlMs };
      this.conversations.set(id, item); return { conversation: item, created: true };
    }
    if (!this._validId(conversationId)) { const e = new Error("Invalid conversation identifier."); e.statusCode = 400; e.detail = e.message; throw e; }
    const item = this.conversations.get(conversationId);
    if (!item || item.principal !== principal || item.workspace_id !== workspaceId) { const e = new Error("Conversation not found."); e.statusCode = 404; e.detail = e.message; throw e; }
    item.expires_at = Date.now() + this.ttlMs;
    return { conversation: item, created: false };
  }
}

export default ConversationStore;
