/**
 * Central exports for the backend/context module.
 */

export * from "./context_store.js";
export * from "./context_builder.js";
export * from "./context_manager.js";
export * from "./context_graph.js";
export * from "./business_logic_store.js";
export * from "./business_logic_validator.js";
export * from "./business_logic_inference.js";
export * from "./business_logic_pipeline.js";
export * from "./cross_source_inference.js";
export * from "./cross_source_evidence.js";
export * from "./cross_source_business_logic.js";

import contextStore from "./context_store.js";
import contextBuilder from "./context_builder.js";
import contextManager from "./context_manager.js";
import contextGraph from "./context_graph.js";
import businessLogicStore from "./business_logic_store.js";
import businessLogicValidator from "./business_logic_validator.js";
import businessLogicInference from "./business_logic_inference.js";
import businessLogicPipeline from "./business_logic_pipeline.js";
import crossSourceInference from "./cross_source_inference.js";
import crossSourceEvidence from "./cross_source_evidence.js";
import crossSourceBusinessLogic from "./cross_source_business_logic.js";

export default {
  ...contextStore,
  ...contextBuilder,
  ...contextManager,
  ...contextGraph,
  ...businessLogicStore,
  ...businessLogicValidator,
  ...businessLogicInference,
  ...businessLogicPipeline,
  ...crossSourceInference,
  ...crossSourceEvidence,
  ...crossSourceBusinessLogic
};
