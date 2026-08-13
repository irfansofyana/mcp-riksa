# MCP Local Workbench — MVP Build Brief

Build a local-first, login-free MCP evaluation workbench that uses a private OpenAI-compatible LiteLLM gateway and can later run the exact same suites in CI.

## Release slice

The MVP must deliver this end-to-end path:

1. Start locally with one command and bind only to `127.0.0.1` by default.
2. Configure LiteLLM with environment variables (`LITELLM_BASE_URL`, `LITELLM_API_KEY`, optional `LITELLM_MODEL`). Never persist secrets.
3. Register/connect to stdio and Streamable HTTP MCP servers.
4. Inspect server identity, capabilities, tools, schemas and sanitized protocol events.
5. Manually invoke a tool through generated JSON input.
6. Chat with a selected LiteLLM model; expose the complete model/tool turn trace.
7. Save a playground interaction as a versioned YAML evaluation case.
8. Run direct-tool and agent suites with assertions.
9. Persist sanitized runs locally in SQLite and inspect case/assertion/event detail.
10. Compare two runs for pass-rate, latency, tool-call and token/cost deltas.
11. Execute the same suite through a headless CLI and emit JSON, HTML, and JUnit.
12. Include a deterministic sample MCP server and GitHub Actions regression workflow.

## Architecture constraints

- Node 24 + TypeScript monorepo-ish package structure, but avoid framework ceremony.
- React + Vite browser UI served by a local Express service in production mode.
- Official `@modelcontextprotocol/sdk` for MCP.
- OpenAI SDK pointed at LiteLLM for model/tool loops.
- SQLite via `better-sqlite3`, WAL mode, migrations, immutable event rows.
- Zod validation at API/config/suite boundaries.
- YAML is the portable suite format.
- Core runner independent of Express/React; CLI imports the same runner.
- No external fonts, CDN assets, product telemetry, account, analytics, cloud sync, Redis, or plugin system.
- No OAuth implementation in this release beyond static bearer headers and client-credentials token acquisition if it can be done safely with standards libraries. Full interactive PKCE/DCR is Phase 2 and must be clearly labeled as such.

## Required packages/folders

- `src/core`: schemas, suite parsing, assertions, normalized events, redaction.
- `src/mcp`: official SDK connection management for stdio and Streamable HTTP.
- `src/agent`: LiteLLM OpenAI-compatible tool loop with max turns/calls/time/cost.
- `src/storage`: SQLite migrations and repositories.
- `src/server`: loopback Express API, local session token/CSRF boundary, cancellation.
- `src/cli`: `serve`, `run`, and `inspect` commands.
- `src/reporters`: JSON, static HTML, JUnit.
- `web`: React UI for Servers, Playground, Suites, Runs, Compare, Settings.
- `examples`: deterministic sample MCP server and sample suite.
- `.github/workflows/ci.yml`.

## Test-first requirements

Use strict vertical TDD. Before each production behavior, add a focused test and run it to observe the expected failure. Tests must cover at minimum:

- redaction catches authorization headers, common token fields, cookies, URL query secrets, and nested payloads;
- suite parser rejects unknown top-level keys, malformed calls, invalid limits and inline secrets;
- assertions: called/not-called/count/order/args/JSONPath/contains/regex/duration/tokens/cost;
- SQLite migration, transactional run completion, interruption recovery, comparison queries;
- stdio sample server discovery and direct invocation;
- agent loop with a fake OpenAI-compatible server and real MCP sample server;
- cancellation, max-turn, max-tool-call and budget stops;
- reporters produce valid JSON/HTML/JUnit and contain no secrets;
- API rejects non-loopback/external-origin mutation attempts and never returns configured API keys;
- browser success path: add server → inspect → direct call → playground mocked run → save/run suite → inspect trace → compare.

## UX

Warm dark, minimal, technical—not a dashboard template. Information density is welcome. Main navigation: Servers, Playground, Suites, Runs, Compare, Settings.

A run-detail page must visibly show:

- summary and pass/fail;
- model turns;
- expected vs actual tools;
- MCP arguments and results;
- assertion results;
- latency waterfall/timeline;
- tokens and estimated cost;
- sanitized raw event JSON.

Clearly label unsupported/full-PKCE OAuth as Phase 2 rather than pretending it exists.

## Security

- Loopback bind by default; explicit opt-in for external bind.
- Validate Origin on mutating API routes; issue random per-start session token.
- Validate endpoint protocols and block link-local/cloud metadata targets by default.
- Secrets only from env/config references; never suite files, DB, logs, API responses, exports.
- Redact before persistence.
- Manual dangerous tool calls require an explicit confirmation flag.
- Owned stdio children are terminated; external servers are never stopped.
- No `eval`, shell interpolation, or arbitrary custom assertion execution in MVP.

## Definition of done

- `npm test`, typecheck and build pass.
- Real sample stdio MCP server exercised.
- Real fake LiteLLM endpoint exercises agent/tool loop.
- Browser flow exercised at desktop and mobile; console clean.
- Independent security/logic review passes.
- README gives exact local and CI commands plus limitations.
- Commit and push to private `irfansofyana/mcp-local-workbench` repository.
