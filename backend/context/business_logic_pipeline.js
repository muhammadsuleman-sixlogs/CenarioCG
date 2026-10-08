import { inferBusinessRelationships } from "./business_logic_inference.js";
import { validateRelationships } from "./business_logic_validator.js";
import { saveBusinessRelationships } from "./business_logic_store.js";
import { loadContext } from "./context_store.js";

/**
 * Run business-logic inference and validation for one database source.
 *
 * Flow:
 *   Context -> LLM -> Proposed relationships -> Local validation -> Valid relationships -> Local store
 *
 * PostgreSQL is never modified.
 */
export async function inferAndValidateBusinessRelationships(context = null, sourceId = null) {
  let activeContext = context;
  if (!activeContext) {
    activeContext = loadContext();
  }

  let activeSourceId = sourceId;
  if (!activeSourceId) {
    activeSourceId = activeContext?.source_id || "db1";
  }

  activeContext = { ...activeContext, source_id: activeSourceId };

  console.log();
  console.log("=".repeat(70));
  console.log(`BUSINESS RELATIONSHIP PIPELINE - ${activeSourceId}`);
  console.log("=".repeat(70));
  console.log(`Tables available: ${Object.keys(activeContext.tables || {}).length}`);
  console.log(`Database relationships available: ${(activeContext.relationships || []).length}`);

  // 1. LLM inference
  const proposedRelationships = await inferBusinessRelationships(activeContext);
  console.log(`Proposed business relationships: ${proposedRelationships.length}`);

  // 2. Local deterministic schema validation
  const validationResult = validateRelationships(proposedRelationships, activeContext);
  const validRelationships = validationResult.valid || [];
  const invalidRelationships = validationResult.invalid || [];
  console.log(`Valid relationships: ${validRelationships.length}`);
  console.log(`Invalid relationships: ${invalidRelationships.length}`);

  // 3. Local storage
  saveBusinessRelationships(validRelationships, activeSourceId);
  console.log(`Saved relationships for source: ${activeSourceId}`);
  console.log("=".repeat(70));

  return {
    valid: validRelationships,
    invalid: invalidRelationships
  };
}

/**
 * Run the business-relationship pipeline independently for every supplied database source.
 */
export async function runAllSources(contexts) {
  const results = {};
  for (const [sourceId, context] of Object.entries(contexts)) {
    results[sourceId] = await inferAndValidateBusinessRelationships(context, sourceId);
  }
  return results;
}

// snake_case aliases for Python parity
export const infer_and_validate_business_relationships = inferAndValidateBusinessRelationships;
export const run_all_sources = runAllSources;

export default {
  inferAndValidateBusinessRelationships,
  infer_and_validate_business_relationships: inferAndValidateBusinessRelationships,
  runAllSources,
  run_all_sources: runAllSources
};
