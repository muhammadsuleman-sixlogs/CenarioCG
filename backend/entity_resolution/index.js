export {
  MAX_SEARCH_TEXT_LENGTH,
  QUOTED_VALUE_PATTERN,
  EMAIL_PATTERN,
  IDENTIFIER_PATTERN,
  EXPLICIT_NUMERIC_IDENTIFIER_PATTERN,
  extractEntitySearchText,
  extract_entity_search_text
} from "./entity_search.js";

export {
  normalizeEntityCandidates,
  normalize_entity_candidates
} from "./entity_normalizer.js";

export {
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_AMBIGUITY_MARGIN,
  selectEntity,
  select_entity,
  _same_entity_reference
} from "./entity_selector.js";

export {
  EntityResolver
} from "./entity_resolver.js";

import { extractEntitySearchText, extract_entity_search_text } from "./entity_search.js";
import { normalizeEntityCandidates, normalize_entity_candidates } from "./entity_normalizer.js";
import { selectEntity, select_entity } from "./entity_selector.js";
import { EntityResolver } from "./entity_resolver.js";

export default {
  extractEntitySearchText,
  extract_entity_search_text,
  normalizeEntityCandidates,
  normalize_entity_candidates,
  selectEntity,
  select_entity,
  EntityResolver
};
