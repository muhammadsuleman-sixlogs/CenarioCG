# Offline reliability baseline

`representative_questions.js` is a versioned corpus of 120 natural-language
questions. It covers entity lookup, identity and status filters, aggregates,
temporal ordering, local and approved cross-source relationships, branches,
follow-ups, ambiguity, missing data, security refusals, set/existence wording,
ranking, grouping, equivalent phrasing, and unfamiliar synthetic schemas.

`baseline_runner.js` evaluates the corpus through the existing
`QuestionPlanner`, using the normal active metadata fixtures and the existing
offline provider stub. It records only structural fields:

- expected and observed safe outcome by category;
- source count, step count, dependency bindings, and operation presence;
- planner context/prompt character sizes, calls, and fallback attempts;
- answer evidence shape and prompt characters from a synthetic answer probe.

It never opens a database connection, executes SQL, calls an external model,
or writes a report file. Character measurements are offline estimates and must
not be presented as provider token usage. The answer probe uses a local mock
provider and synthetic evidence; its zero provider-reported token count is
intentional.

`calibration.js` preserves the original 68/120 score while attaching a
per-case diagnostic to every flagged case. The current triage is:

- 26 confirmed implementation defects;
- 4 evaluator false negatives (including a verified graph that lacked
  explicit branch metadata);
- 14 expected clarification/refusal outcomes;
- 5 unsupported capabilities;
- 2 cases needing richer fixture metadata;
- 1 provider-dependent, offline-unverified case.

The calibrated structural score is 69/120 only because the verified-graph
branch false negative is corrected. It must not replace the original 68/120
baseline when comparing future runs.

Run the baseline with:

```powershell
cd backend
npm.cmd test -- --test-name-pattern="offline representative evaluation"
node.exe --test tests/evaluation_calibration.test.js
```

The full backend suite remains the regression gate. The scorecard is
diagnostic: category failures are recorded for prioritization rather than
silently changing planner behavior or making known unsupported semantics look
successful.

## Production-readiness review checklist

- Read-only source pools, SQL validation, and parameter binding are covered by
  the backend regression suite; live authorization and deployment wiring still
  require environment-specific verification.
- Workspace/principal isolation and source-qualified conversation references
  are tested offline; expiry, rotation, and multi-instance persistence need a
  staging check.
- Metadata generations, fingerprints, and fail-closed refresh behavior are
  tested with fixtures; production refresh scheduling and rollback alerting
  need operational verification.
- Bounded retrieval, truncation, partial-source status, and evidence
  provenance are tested; production timeout budgets and monitoring need a
  staging check.
- Provider token values are recorded only when the provider reports them.
  This offline baseline reports no provider tokens.
