# CenarioCG engineering guide

## Scope and architecture

CenarioCG is an ES-module Node.js/Express backend with a React/Vite frontend.
The active flow is:

```text
API -> RAGPipeline -> QuestionPlanner -> QuestionPlanValidator
    -> QueryPlanExecutor -> read-only retrieval -> evidence/answer/provenance
```

Use the existing subsystem boundaries:

- `backend/config/settings.js` and `backend/database/connection.js` own
  environment-derived PostgreSQL registration and read-only pools.
- `backend/external_api/` owns configuration-driven OpenAPI validation,
  specification transformation, and approved GET-only retrieval. Reuse it;
  do not add source-specific REST clients for conforming APIs.
- `backend/context/` owns schema discovery, metadata generations, semantic
  overlays, graph construction, relationship evidence, and conversation state.
- `backend/planning/` owns plan generation, repair, validation, and dependency
  graphs.
- `backend/retrieval/` owns safe SQL generation, validation, execution, and
  runtime bindings.
- `backend/tracing/`, `backend/llm/`, and `backend/security/` own provenance,
  evidence/answers, and protected-data controls.

Reuse these components. Do not add a second planner, schema discovery system,
identity registry, relationship engine, or metadata store.

## PostgreSQL sources and metadata lifecycle

`POSTGRES_SOURCES_JSON` registers future PostgreSQL source IDs while legacy
DB1/DB2 variables remain supported. Registration is not authorization.
`WORKSPACE_AUTHORIZATION_JSON` is the server-owned, fail-closed authority for
source/resource access; never accept source permissions or workspace scope from
the browser.

Discovery is catalog-only and source connections are strictly read-only. The
refresh scheduler builds all registered contexts before publishing a generation.
Publish only non-empty, validated, coherent metadata atomically; retain the
last known-good generation on error. Preserve fingerprints, retention, rollback,
and request-level generation consistency. Do not regenerate or overwrite
approved semantic definitions or metadata artifacts indiscriminately.

New technical tables and declared same-source FKs can be planner-visible after
a valid refresh, subject to authorization and sensitive-field filtering. Keep
LLM schema context bounded. Renamed/removed/type-incompatible objects must fail
closed and invalidate stale references rather than producing speculative SQL.

## External API sources

`EXTERNAL_API_SOURCES_JSON` registers supported OpenAPI/Swagger REST sources;
it never grants workspace access. `WORKSPACE_AUTHORIZATION_JSON` must allow
both the source (`external_api_sources`) and exact operation IDs
(`external_api_operations`). Filter unauthorized API metadata before planning.

Only the existing OpenAPI 3.x/Swagger 2.0 JSON contract is supported: explicit
operation allow-list, approved HTTPS origin, safe GET with inline JSON response
schema, bounded response/retry settings, and no inferred pagination. Reject
writes, request bodies, redirects, path parameters, unapproved query
parameters, alternate origins, unsupported authentication, and ambiguous
schemas. The LLM must never construct URLs, methods, headers, bodies, or
credentials. APIs without this contract need an approved manifest or adapter;
do not add scraping or implicit discovery.

Keep API resources as lower-trust technical entities. API/database identifier
matches are candidates only and are never executable relationships or business
identities without independent validation and approval. API evidence must use
the existing provenance pipeline without persisting secrets or raw sensitive
responses.

## Relationship and identity rules

Keep source IDs on all nodes, plans, retrievals, and provenance. Never use a
cross-database SQL join. A UUID primary key and a UUID/varchar field in another
source can be an evidence candidate, not a canonical identity by itself.

Preserve approved DB1/DB2 identities and verified paths. Only declared FKs or
relationships that are independently validated and approved may be executable.
Unverified inferred candidates must remain non-executable. Do not replace the
existing DB1/DB2 business-contract publication path with confidence-only
ranking; new-source cross-source mappings require the same evidence and
approval discipline.

## Security and conversation requirements

- Never run source writes, DDL, migrations, permission changes, locking reads,
  or schema-altering SQL. Pools initialize transactions read-only.
- Preserve parameterized SQL, SQL validation, row bounds, source isolation,
  sensitive-field protection, output sanitization, and provenance.
- Keep conversations server-owned and principal/workspace isolated. Preserve
  the five-complete-exchange limit and revalidate stored entity references when
  active metadata changes.
- Do not put credentials, raw sensitive values, or secrets in logs, metadata,
  prompts, evidence, tests, or documentation.

## Change discipline and verification

Make minimal, evidence-based modifications. Inspect call sites and tests before
changing an architectural component; preserve working DB1/DB2 behavior while
making source-ID handling generic where required.

Run the relevant checks after changes:

```powershell
cd backend
npm test

cd ..\frontend
npm run build
```

The repository has no tracked Playwright configuration or npm script. Local
browser MCP verification is manual and must be explicitly authorized; do not
claim it is a reproducible automated suite. Keep standard Playwright reports,
traces, videos, screenshots, MCP captures, and response bodies untracked; add
an ignore rule if a future configuration uses a custom output path.

Clearly label verification as offline, mocked, or live. Never imply live schema
evolution, authorization, or provider behavior was verified from a mock. Do not
connect to a real source or perform discovery unless the task authorizes it.

## Environment and repository hygiene

`backend/.env` is the canonical backend file because settings load it by
explicit path. Root `.env` is only a possible fallback for a root-working-
directory launch; do not edit, synchronize, or remove either without explicit
approval. `frontend/.env` is Vite-specific.

Do not stage `.env` files, `.playwright-mcp/`, browser response captures,
runtime logs, `node_modules`, or build outputs. Do not blindly ignore the whole
`backend/context/` directory: its committed JSON files are maintained metadata
fixtures. Before release, inspect `git diff --cached`, run backend regression
tests, build the frontend, and distinguish runtime artifacts from intentional
source fixtures.
