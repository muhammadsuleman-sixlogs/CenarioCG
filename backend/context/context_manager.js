import { settings } from "../config/settings.js";

function deepClone(obj) {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (obj instanceof Date) {
    return new Date(obj.getTime());
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => deepClone(item));
  }
  const cloned = {};
  for (const [key, value] of Object.entries(obj)) {
    cloned[key] = deepClone(value);
  }
  return cloned;
}

/**
 * Manage bounded short-term conversational context.
 *
 * This class stores conversational state only.
 *
 * It is NOT:
 *  - a database cache
 *  - a source of business truth
 *  - a replacement for live retrieval
 *  - a semantic planner
 *
 * Historical answers and resolved entities help interpret follow-up
 * questions, but they are never treated as authoritative current business data.
 */
export class ContextManager {
  constructor(
    maxTurnsOrOpts = null,
    maxItems = null,
    maxQuestionChars = null,
    maxAnswerChars = null,
    maxEntityChars = null
  ) {
    let opts = {};
    if (
      maxTurnsOrOpts &&
      typeof maxTurnsOrOpts === "object" &&
      !Array.isArray(maxTurnsOrOpts)
    ) {
      opts = { ...maxTurnsOrOpts };
    } else {
      opts = {
        max_turns: maxTurnsOrOpts,
        max_items: maxItems,
        max_question_chars: maxQuestionChars,
        max_answer_chars: maxAnswerChars,
        max_entity_chars: maxEntityChars,
      };
    }

    this.max_turns = this._read_positive_int(
      opts.max_turns !== undefined ? opts.max_turns : opts.maxTurns,
      "CONTEXT_MAX_TURNS",
      settings?.contextMaxTurns || 5
    );
    this.maxTurns = this.max_turns;

    this.max_items = this._read_positive_int(
      opts.max_items !== undefined ? opts.max_items : opts.maxItems,
      "CONTEXT_MAX_ITEMS",
      settings?.contextMaxItems || 20
    );
    this.maxItems = this.max_items;

    this.max_question_chars = this._read_positive_int(
      opts.max_question_chars !== undefined
        ? opts.max_question_chars
        : opts.maxQuestionChars,
      "CONTEXT_MAX_QUESTION_CHARS",
      4000
    );
    this.maxQuestionChars = this.max_question_chars;

    this.max_answer_chars = this._read_positive_int(
      opts.max_answer_chars !== undefined
        ? opts.max_answer_chars
        : opts.maxAnswerChars,
      "CONTEXT_MAX_ANSWER_CHARS",
      20000
    );
    this.maxAnswerChars = this.max_answer_chars;

    this.max_entity_chars = this._read_positive_int(
      opts.max_entity_chars !== undefined
        ? opts.max_entity_chars
        : opts.maxEntityChars,
      "CONTEXT_MAX_ENTITY_CHARS",
      8000
    );
    this.maxEntityChars = this.max_entity_chars;

    this.history = [];
    this.entities = [];
  }

  // ------------------------------------------------------------------
  // Configuration
  // ------------------------------------------------------------------

  _read_positive_int(explicitValue, envName, defaultValue) {
    let value;
    if (explicitValue !== null && explicitValue !== undefined) {
      value = explicitValue;
    } else {
      const rawValue = (process.env[envName] || String(defaultValue)).trim();
      const parsed = parseInt(rawValue, 10);
      if (isNaN(parsed)) {
        throw new Error(`${envName} must be a valid integer.`);
      }
      value = parsed;
    }

    if (
      typeof value === "boolean" ||
      typeof value !== "number" ||
      isNaN(value) ||
      value < 1
    ) {
      throw new Error(`${envName} must be greater than 0.`);
    }

    return value;
  }

  _readPositiveInt(explicitValue, envOrSettingValue, envName, defaultValue) {
    return this._read_positive_int(explicitValue, envName, defaultValue);
  }

  // ------------------------------------------------------------------
  // Turn management
  // ------------------------------------------------------------------

  add_turn(question, answer, entities = null) {
    const normQuestion = this._normalize_text(
      question,
      "Question",
      this.max_question_chars
    );

    const normAnswer = this._normalize_text(
      answer,
      "Answer",
      this.max_answer_chars
    );

    const normEntities = this._normalize_entities(entities);

    const turn = {
      question: normQuestion,
      answer: normAnswer,
      entities: normEntities,
      context_role: "conversation_reference",
    };

    this.history.push(turn);

    if (normEntities.length > 0) {
      this.entities.push(...deepClone(normEntities));
    }

    this._trim();
  }

  addTurn(question, answer, entities = null) {
    return this.add_turn(question, answer, entities);
  }

  _normalize_text(value, label, maximum) {
    if (typeof value !== "string") {
      throw new Error(`${label} must be a string.`);
    }

    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error(`${label} cannot be empty.`);
    }

    if (trimmed.length > maximum) {
      throw new Error(
        `${label} exceeds the configured maximum of ${maximum} characters.`
      );
    }

    return trimmed;
  }

  _normalizeText(value, label, maximum) {
    return this._normalize_text(value, label, maximum);
  }

  // ------------------------------------------------------------------
  // Entity management
  // ------------------------------------------------------------------

  _normalize_entities(entities) {
    if (entities === null || entities === undefined) {
      return [];
    }

    if (!Array.isArray(entities)) {
      throw new Error("entities must be a list.");
    }

    const normalized = [];
    for (const entity of entities) {
      if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
        continue;
      }

      const entityCopy = deepClone(entity);
      const bounded = this._bound_object(entityCopy, this.max_entity_chars);
      normalized.push(bounded);
    }

    return normalized;
  }

  _normalizeEntities(entities) {
    return this._normalize_entities(entities);
  }

  _bound_object(value, maximumChars) {
    if (typeof value === "string") {
      if (value.length <= maximumChars) {
        return value;
      }
      return value.slice(0, maximumChars) + "…";
    }

    if (Array.isArray(value)) {
      return value.map((item) => this._bound_object(item, maximumChars));
    }

    if (value && typeof value === "object" && !(value instanceof Date) && !(value instanceof RegExp)) {
      const result = {};
      for (const [key, item] of Object.entries(value)) {
        result[String(key)] = this._bound_object(item, maximumChars);
      }
      return result;
    }

    return value;
  }

  _boundObject(value, maximumChars) {
    return this._bound_object(value, maximumChars);
  }

  // ------------------------------------------------------------------
  // Context trimming
  // ------------------------------------------------------------------

  _trim() {
    if (this.history.length > this.max_turns) {
      this.history = this.history.slice(-this.max_turns);
    }

    if (this.entities.length > this.max_items) {
      this.entities = this.entities.slice(-this.max_items);
    }
  }

  // ------------------------------------------------------------------
  // Read-only accessors
  // ------------------------------------------------------------------

  get_history() {
    return deepClone(this.history);
  }

  getHistory() {
    return this.get_history();
  }

  get_entities() {
    return deepClone(this.entities);
  }

  getEntities() {
    return this.get_entities();
  }

  get_last_turn() {
    if (this.history.length === 0) {
      return null;
    }
    return deepClone(this.history[this.history.length - 1]);
  }

  getLastTurn() {
    return this.get_last_turn();
  }

  get_last_entities() {
    const lastTurn = this.get_last_turn();
    if (!lastTurn) {
      return [];
    }

    const entities = lastTurn.entities;
    if (!Array.isArray(entities)) {
      return [];
    }

    return deepClone(entities);
  }

  getLastEntities() {
    return this.get_last_entities();
  }

  // ------------------------------------------------------------------
  // Planner-facing context
  // ------------------------------------------------------------------

  get_planning_context() {
    return {
      history: this.get_history(),
      entities: this.get_entities(),
      authority: {
        conversation_history: "reference_only",
        resolved_entities: "reference_only",
        current_business_data: "live_retrieval_required",
      },
    };
  }

  getPlanningContext() {
    return this.get_planning_context();
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  clear() {
    this.history = [];
    this.entities = [];
  }
}

export default ContextManager;
