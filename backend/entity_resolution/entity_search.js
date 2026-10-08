export const MAX_SEARCH_TEXT_LENGTH = 256;

export const QUOTED_VALUE_PATTERN = /["']([^"']+)["']/g;
export const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
export const IDENTIFIER_PATTERN = /\b[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\b/g;
export const EXPLICIT_NUMERIC_IDENTIFIER_PATTERN = /\b(?:id|identifier|code|reference|number|key)\s*(?:is|=|:)?\s*(\d+)\b/gi;

/**
 * Extract an explicit entity reference from a natural-language question.
 *
 * This function intentionally does NOT try to identify arbitrary names
 * such as "Umar daraz". Free-form semantic interpretation belongs to
 * QuestionPlanner.
 *
 * Supported explicit forms:
 *     "ABC-123"
 *     "TKT-001-XYZ"
 *     "user@example.com"
 *     "ID 123"
 *     'project "ABC-123"'
 *
 * Returned text is only a search candidate. It is not an entity identity.
 */
export function extractEntitySearchText(question) {
  if (typeof question !== "string" || !question.trim()) {
    return null;
  }

  let text = question.trim();

  if (text.length > MAX_SEARCH_TEXT_LENGTH) {
    text = text.slice(0, MAX_SEARCH_TEXT_LENGTH);
  }

  // Explicitly quoted values.
  const quotedMatches = [...text.matchAll(/["']([^"']+)["']/g)];
  if (quotedMatches.length > 0) {
    const value = quotedMatches[quotedMatches.length - 1][1].trim();
    if (value) {
      return value;
    }
  }

  // Email addresses.
  const emailMatches = [...text.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g)];
  if (emailMatches.length > 0) {
    const value = emailMatches[emailMatches.length - 1][0].trim();
    if (value) {
      return value;
    }
  }

  // Identifier-like values.
  const identifierMatches = [...text.matchAll(/\b[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\b/g)];
  if (identifierMatches.length > 0) {
    const value = identifierMatches[identifierMatches.length - 1][0].trim();
    if (value) {
      return value;
    }
  }

  // Numeric values are considered entities only when the question
  // explicitly identifies them as an ID/code/reference/etc.
  const numericMatches = [...text.matchAll(/\b(?:id|identifier|code|reference|number|key)\s*(?:is|=|:)?\s*(\d+)\b/gi)];
  if (numericMatches.length > 0) {
    const value = numericMatches[numericMatches.length - 1][1].trim();
    if (value) {
      return value;
    }
  }

  return null;
}

export const extract_entity_search_text = extractEntitySearchText;

export default {
  MAX_SEARCH_TEXT_LENGTH,
  QUOTED_VALUE_PATTERN,
  EMAIL_PATTERN,
  IDENTIFIER_PATTERN,
  EXPLICIT_NUMERIC_IDENTIFIER_PATTERN,
  extractEntitySearchText,
  extract_entity_search_text
};
