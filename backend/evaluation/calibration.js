/*
 * Triage for the original evaluation score.  This is deliberately separate
 * from the planner and from the legacy 68/120 assertion rules.  A flagged
 * case can be a real defect, a safe/unsupported outcome, a fixture limit, or
 * a provider-dependent behavior that the offline harness cannot verify.
 */

const TRIAGE = {
  "simple_entity-02": ["confirmed_implementation_defect", "P1", "The generic users request produced no source-qualified plan despite users being available in both authorized contexts.", "Add a deterministic independent-source list path or return an explicit source clarification; never silently leave the request unsupported."],
  "simple_entity-04": ["confirmed_implementation_defect", "P1", "A generic user-record request produced no plan.", "Preserve the users entity and compile independent authorized source steps."],
  "simple_entity-05": ["evaluator_false_negative", "P2", "Projects have different discovered representations across sources, so an unqualified project list is source/meaning ambiguous.", "Calibrate this case to expect clarification or explicitly independent source results."],
  "named_entity-03": ["confirmed_implementation_defect", "P1", "A known user entity with a status attribute became unsupported instead of preserving the name and status requirement.", "Keep the named-user identity and status attribute in the normalized plan."],
  "named_entity-04": ["evaluator_false_negative", "P2", "‘Account’ is not a verified entity synonym in the fixture; the phrase is ambiguous between user and company.", "Add an approved synonym or expect clarification; do not infer an entity from the word alone."],
  "named_entity-05": ["confirmed_implementation_defect", "P1", "A known company lookup with an unfamiliar display name produced no grounded company plan.", "Preserve arbitrary display values and bind them to discovered company identity fields."],
  "status_filter-01": ["expected_safe_clarification_or_refusal", "P2", "The plan detected conflicting/unverified status semantics across authorized sources and requested clarification.", "Keep the clarification; do not count this as a failed retrieval."],
  "status_filter-02": ["expected_safe_clarification_or_refusal", "P2", "Inactive has the same unresolved cross-source status semantics.", "Keep the clarification or require a source/status definition."],
  "aggregation-05": ["expected_safe_clarification_or_refusal", "P2", "Counting active users requires verified status meaning before aggregation.", "Clarify status semantics before executing the count."],
  "local_relationship-04": ["expected_safe_clarification_or_refusal", "P2", "‘Company employees’ has no named company or conversation anchor.", "Request a company identity or a verified source scope."],
  "local_relationship-05": ["expected_safe_clarification_or_refusal", "P2", "The request has no company anchor; the users-only fallback is not relationship fulfillment, but the safe result should be clarification.", "Require a company reference and keep the completeness guard active."],
  "local_relationship-06": ["confirmed_implementation_defect", "P1", "The plan selected project_tasks without a user identity filter or verified assignment binding.", "Reject the broad task plan and compile a bounded user-to-task path when the name resolves."],
  "relationship_wording-05": ["confirmed_implementation_defect", "P1", "The plan selected tasks but omitted the employee endpoint and assignment edge.", "Require both endpoints and a verified assignment dependency."],
  "cross_source-02": ["confirmed_implementation_defect", "P1", "Equivalent meeting/project/company wording produced no plan although the approved federated path exists.", "Normalize ‘together’ as related output attributes and reuse the verified path."],
  "multi_branch-01": ["expected_safe_clarification_or_refusal", "P2", "Company is not identified, so users/tasks cannot be safely scoped.", "Clarify the company before planning branches."],
  "multi_branch-02": ["expected_safe_clarification_or_refusal", "P2", "The company anchor is missing and status meanings are not uniquely verified.", "Clarify company identity and active/open definitions."],
  "multi_branch-03": ["evaluator_false_negative", "P2", "The plan contains sessions → projects → project_details → companies with three dependent bindings; explicit branch metadata is not required for this single relational output.", "Use verified graph coverage when scoring this branch instead of requiring branch_count metadata."],
  "multi_branch-04": ["expected_safe_clarification_or_refusal", "P2", "Multiple entities plus a count have no anchor or source scope.", "Clarify scope and preserve each requested branch before execution."],
  "multi_branch-05": ["confirmed_implementation_defect", "P1", "The plan only retrieved recent meetings and omitted users and tasks.", "Reject the incomplete plan or represent unsupported branches explicitly."],
  "multi_branch-06": ["confirmed_implementation_defect", "P1", "The plan selected users but omitted projects, task totals, and required grouping/count semantics.", "Apply branch completeness validation before retrieval."],
  "follow_up-03": ["expected_safe_clarification_or_refusal", "P2", "No conversation context was supplied for ‘that company’.", "Request the missing company reference rather than inventing one."],
  "follow_up-04": ["expected_safe_clarification_or_refusal", "P2", "No prior user record set was supplied for ‘those users’.", "Request a resolvable plural reference."],
  "identity_disambiguation-02": ["confirmed_implementation_defect", "P0", "The explicit email qualifier was lost and the plan broadened to four independent tables.", "Apply the authorized email constraint before cardinality/source selection."],
  "identity_disambiguation-03": ["unsupported_capability", "P2", "user-42 is not a verified stable key or external identifier in the fixture.", "Return controlled unsupported/clarification unless metadata declares the identifier."],
  "identity_disambiguation-04": ["confirmed_implementation_defect", "P0", "The login email was not represented as a filter on the users plan.", "Preserve explicit login/email identity predicates."],
  "identity_disambiguation-05": ["unsupported_capability", "P2", "The opaque user-42 value has no verified identity-column semantics.", "Fail closed or require an approved identifier type."],
  "identity_disambiguation-06": ["confirmed_implementation_defect", "P0", "An email-matching request became an unfiltered multi-source users retrieval.", "Bind the email predicate and preserve source-qualified cardinality."],
  "zero_missing_data-02": ["confirmed_implementation_defect", "P1", "An arbitrary company display value did not produce a bounded company lookup.", "Preserve unfamiliar names as parameterized identity predicates."],
  "zero_missing_data-06": ["unsupported_capability", "P2", "Negated ticket/project relationship execution is not represented by the current offline fixture contract.", "Keep a controlled unsupported response until a verified absence path exists."],
  "independent_sources-02": ["confirmed_implementation_defect", "P1", "An explicit independent user count request produced no plan.", "Compile separate count steps for each authorized source."],
  "independent_sources-04": ["provider_dependent_unverified", "P2", "Comparison/count-by-source semantics were reduced to a DB1 lookup on the offline deterministic path.", "Verify with the provider planner or add a grounded deterministic comparison contract."],
  "independent_sources-05": ["confirmed_implementation_defect", "P1", "‘Per database’ was reduced to a DB2-only meeting count.", "Preserve explicit source plurality and independent count branches."],
  "independent_sources-06": ["confirmed_implementation_defect", "P1", "Explicit DB1 and DB2 invoice totals were reduced to a DB1 lookup.", "Preserve both source-qualified aggregate branches."],
  "ranking-01": ["missing_or_insufficient_fixture_metadata", "P2", "The fixture does not expose a verified project budget metric for this ranking.", "Add an approved metric fixture or classify the question as unsupported."],
  "ranking-05": ["missing_or_insufficient_fixture_metadata", "P2", "The fixture does not expose a verified project completion-date metric for project ranking.", "Add verified temporal/metric metadata or require clarification."],
  "comparison_grouping-01": ["confirmed_implementation_defect", "P1", "A comparison/count-by-company request became a four-step lookup without grouping or count operation.", "Preserve comparison/grouping semantics in the normalized intent."],
  "comparison_grouping-02": ["confirmed_implementation_defect", "P1", "Grouping users by status became an ordinary users lookup.", "Require grouping metadata or return controlled unsupported."],
  "comparison_grouping-03": ["unsupported_capability", "P2", "Grouped ticket totals require an approved ticket-project grouping contract not exercised by this fixture.", "Keep controlled unsupported behavior until verified grouping is supported."],
  "comparison_grouping-04": ["confirmed_implementation_defect", "P1", "Invoice amount comparison was reduced to company lookup and lost both metric and comparison operation.", "Preserve invoice metric, grouping, and comparison requirements."],
  "comparison_grouping-05": ["confirmed_implementation_defect", "P1", "Per-user task totals became a users retrieval rather than grouped assignment counts.", "Require task assignment dependency and per-user aggregation."],
  "comparison_grouping-06": ["unsupported_capability", "P2", "Meeting-by-project grouping is not represented by the current verified grouping fixture.", "Add approved grouping metadata or clarify unsupported behavior."],
  "negation_existence-04": ["expected_safe_clarification_or_refusal", "P2", "The deictic company reference has no conversation context in the offline single-turn fixture.", "Request a resolvable company reference rather than planning an unscoped existence query."],
  "ambiguous_role-01": ["expected_safe_clarification_or_refusal", "P2", "‘Associated’ has multiple possible user-project roles and no active user set is supplied.", "Clarify the relationship role and identity scope."],
  "ambiguous_role-02": ["confirmed_implementation_defect", "P1", "The plan retrieved users across sources without resolving the requested project target or role.", "Fail closed with role clarification instead of broad user retrieval."],
  "ambiguous_role-03": ["expected_safe_clarification_or_refusal", "P2", "‘Work connected to this person’ has no verified entity role or context.", "Request a specific relationship role and source-qualified identity."],
  "ambiguous_role-04": ["confirmed_implementation_defect", "P1", "‘Items belonging to the account’ was guessed as DB2 action_items without a verified account relationship.", "Do not select a table from lexical proximity; clarify the target."],
  "ambiguous_role-05": ["expected_safe_clarification_or_refusal", "P2", "‘Records tied to this company’ is underspecified without a verified target relationship.", "Clarify the requested entity/role."],
  "ambiguous_role-06": ["confirmed_implementation_defect", "P1", "The vague project ownership question produced a broad multi-source users/project plan instead of role clarification.", "Preserve competing verified roles and request clarification."],
  "unsupported_or_unauthorized-03": ["confirmed_implementation_defect", "P0", "A DELETE request was normalized into a read-only ticket lookup.", "Reject mutating intent before planning; never reinterpret writes as reads."],
  "unsupported_or_unauthorized-04": ["confirmed_implementation_defect", "P0", "An UPDATE request was normalized into a read-only relationship lookup.", "Reject mutating intent before any retrieval planning."],
  "unsupported_or_unauthorized-05": ["evaluator_false_negative", "P2", "No concrete unauthorized source was named and the planner-only fixture has no principal/workspace authorization input.", "Use a source-qualified authorization fixture; expect clarification for this wording."],
  "unsupported_or_unauthorized-06": ["expected_safe_clarification_or_refusal", "P0", "The planner failed closed before producing an executable plan for a write-query request; no source call occurred.", "Expose an explicit read-only refusal at the API boundary rather than a generic planner error."],
  "equivalent_phrasing-02": ["confirmed_implementation_defect", "P0", "The known user-to-company-to-users-to-tasks wording produced no plan while equivalent relationship wording is supported.", "Normalize possessive/non-possessive assignment wording to the verified graph."]
};

export const TRIAGE_CLASSIFICATIONS = Object.freeze(Object.fromEntries(
  Object.entries(TRIAGE).map(([id, [classification, severity, evidence, action]]) => [id, Object.freeze({ classification, severity, evidence, action })])
));

export function calibrateEvaluation(report) {
  const flagged = Array.isArray(report?.case_results)
    ? report.case_results.filter(item => Array.isArray(item.reasons) && item.reasons.length > 0)
    : [];
  const missing = flagged.filter(item => !TRIAGE_CLASSIFICATIONS[item.id]).map(item => item.id);
  if (missing.length) throw new Error(`Missing triage classification for: ${missing.join(", ")}`);

  const classified = flagged.map(item => ({
    ...item,
    triage: TRIAGE_CLASSIFICATIONS[item.id]
  }));
  const counts = {};
  for (const item of classified) counts[item.triage.classification] = (counts[item.triage.classification] || 0) + 1;
  const severities = {};
  for (const item of classified) severities[item.triage.severity] = (severities[item.triage.severity] || 0) + 1;
  return {
    original: { ...report.totals },
    flagged_count: flagged.length,
    counts,
    severities,
    cases: classified,
    note: "Original score is preserved. Triage classifications are diagnostic and do not weaken the legacy assertions."
  };
}

export default calibrateEvaluation;
