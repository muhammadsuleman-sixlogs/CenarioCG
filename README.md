# CenarioCG

CenarioCG is a Node.js and React AI Data Intelligence platform for safe,
source-qualified retrieval across PostgreSQL systems and the optional
`security_logs` API. It turns natural-language questions into validated,
bounded read-only retrieval plans, correlates grounded evidence, and returns
an answer with provenance.

## Architecture

```text
React/Vite UI -> Express API -> RAGPipeline
  -> QuestionPlanner -> QuestionPlanValidator -> QueryPlanExecutor
  -> safe parameterized PostgreSQL / read-only security-log retrieval
  -> evidence manager and answer generator -> source-qualified provenance
```

The Context Layer discovers PostgreSQL tables, columns, primary keys, and
declared foreign keys with read-only catalog queries. `context_store.js`
publishes validated application-owned metadata generations atomically;
`context_graph.js`, the semantic catalog, planner, resolver, and SQL generator
read the active generation. The graph is source-qualified, so sources are never
joined in database SQL.

Important backend boundaries:

- `backend/config/settings.js` — environment loading and source registry.
- `backend/database/connection.js` — registered PostgreSQL pools and read-only
  session initialization.
- `backend/context/` — discovery, metadata generations, semantic overlay,
  graph, conversation context, and relationship evidence.
- `backend/planning/` — natural-language planning, deterministic validation,
  and multi-step dependency planning.
- `backend/retrieval/` — SQL generation, read-only validation, execution, and
  runtime bindings.
- `backend/tracing/` and `backend/llm/` — provenance, evidence, and grounded
  answer generation.

The original Python implementation is preserved in `older files/`; the active
application is Node.js ES modules.

## Local development

Prerequisites: Node.js 18+ and npm.

```powershell
# Backend
cd backend
npm install
npm start       # node main.js
# or: npm run dev

# Frontend (separate terminal)
cd frontend
npm install
npm run dev
```

The backend listens on port 8000 by default and Vite uses its configured local
development port (normally 5173).

## Environment configuration

`backend/config/settings.js` explicitly loads `backend/.env` first. See
[Environment-file behavior](#environment-file-behavior) before maintaining
local configuration.

### DB1 and DB2 compatibility

Existing deployments remain supported through the legacy variables:

- DB1: `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DATABASE`, `POSTGRES_USER`,
  `POSTGRES_PASSWORD`
- DB2: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`

### Additional PostgreSQL sources

Register future sources privately with `POSTGRES_SOURCES_JSON`, a JSON object
whose keys are lowercase source IDs and whose values contain `host`, `port`,
`database`, `user`, and `password`. `sslRejectUnauthorized` is optional.

```ini
POSTGRES_SOURCES_JSON={"db3":{"host":"...","port":5432,"database":"...","user":"...","password":"..."}}
```

Registration makes a source eligible for connection and metadata discovery; it
does **not** authorize any user or workspace to query it. Source IDs are also
validated before a pool is created. Do not commit any `.env` file or secrets.

### Workspace authorization

`WORKSPACE_AUTHORIZATION_JSON` is the server-owned allow-list for each
principal/workspace. PostgreSQL source access and security-log resource access
are both fail-closed. A browser request cannot grant itself source access, and
adding credentials for a source does not add it to any workspace.

## Automatic schema discovery and metadata safety

The configured refresh controls are:

- `CONTEXT_REFRESH_ENABLED` (default `true`)
- `CONTEXT_REFRESH_ON_STARTUP` (default `true`)
- `CONTEXT_REFRESH_INTERVAL_MS` (default `900000`)
- `CONTEXT_SNAPSHOT_RETENTION` (default `5`)

On startup and at the bounded interval, the scheduler discovers every
registered PostgreSQL source through read-only catalog access. It publishes a
new generation only after all requested contexts are non-empty and validated.
Generations have deterministic fingerprints, timestamps, source lists, bounded
retention, and rollback support. Requests keep using the last known-good active
generation if discovery or publication fails; incomplete metadata is not made
visible.

New authorized tables, ordinary columns, primary keys, and declared same-source
foreign keys become discovered technical entities without semantic-catalog
edits. The planner receives a bounded, sensitive-field-filtered view of that
metadata. A discovered technical entity is not automatically an approved
business concept.

## Relationships and identity

Declared PostgreSQL foreign keys are available for same-source traversal.
Cross-source inference produces candidates and collects read-only hashed-value
evidence, including compatible UUID-to-varchar comparisons. Matching names or
values alone never create an executable identity.

Existing approved DB1/DB2 identities and verified paths are preserved,
including the project UUID and project-code mappings. The dedicated automatic
publication of approved cross-source business contracts remains DB1/DB2 scoped;
new-source cross-source candidates require sufficient validation and business
approval before becoming executable. CenarioCG never performs cross-database
SQL joins.

## Safety, conversation, and provenance

Every PostgreSQL session is initialized read-only. SQL is parameterized and
checked for mutating statements, locks, wildcard projections, and sensitive
fields. Source isolation, workspace authorization, and row/result bounds remain
in force after schema refreshes.

Conversation state is server-owned, source-qualified, and bounded to five
complete exchanges. Stored references are revalidated when metadata changes.
Answers are grounded in independent retrieval results and retain source,
query, table, row-count, and evidence provenance for the UI.

## Verification

```powershell
# Backend regression suite
cd backend
npm test

# Frontend production build
cd frontend
npm run build
```

The backend suite is offline/mocked where appropriate; it is not a substitute
for approved live-source verification. Additional PostgreSQL onboarding has not
yet been live-verified against a real DB3+ source. Real-provider follow-up
reliability also remains under investigation.

### Playwright / browser verification

This repository currently has no tracked `playwright.config.*`, Playwright
dependency, or npm script. Local `.playwright-mcp/` captures show that browser
MCP tooling has been used, but it is not a reproducible repository test runner.
For a safe manual UI check, start the backend and frontend locally, use an
authorized test account only when explicitly approved, and do not exercise
source-changing actions. Standard Playwright output directories and local MCP
captures are ignored by Git; a future custom output path must also be ignored.

## Environment-file behavior

- `backend/.env` is the canonical backend environment file: it is loaded first
  by `backend/config/settings.js` using an explicit path.
- A second default `dotenv.config()` call can load `.env` from the process
  working directory without overriding values already loaded from `backend/.env`.
  Therefore root `.env` can supply missing values when the backend is launched
  as `node backend/main.js` from the repository root.
- `cd backend; npm start` loads `backend/.env` for both calls and does not use
  the root file.
- Vite runs with `frontend` as its project root and reads `frontend/.env` for
  `VITE_*` values; it does not configure `envDir` to use the repository root.
- `vercel.json` deploys `backend/main.js`; deployed environment variables are
  supplied by the hosting environment, not by a committed `.env` file.

Keep `backend/.env` as the canonical backend file. The root `.env` is a legacy
fallback and creates drift risk because it overlaps backend settings. It may be
retired only after the team stops invoking the backend from the repository root
and verifies no external workflow depends on that fallback.

## Repository hygiene

Do not commit credentials, local environment files, browser captures, runtime
logs, or generated test reports. The committed files in `backend/context/` are
application-owned metadata fixtures and must not be indiscriminately ignored or
regenerated. Review `git diff --cached`, run the backend suite, and build the
frontend before release.
