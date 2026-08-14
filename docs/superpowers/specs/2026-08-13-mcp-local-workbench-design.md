# MCP Riksa MVP Design

## Product boundary

The workbench is a login-free, local-only instrument for inspecting MCP servers and evaluating direct tool calls or provider-driven tool loops. It uses environment references for secrets, YAML for portable suites, and SQLite only for already-redacted operational history. OpenAI-compatible and Anthropic-compatible adapters normalize both protocols into one agent model.

## Architecture

One Node process owns Express, the MCP connections, the runner, and SQLite. `src/core` contains schemas, redaction, assertions, normalized events, and the suite runner without HTTP or React dependencies. `src/mcp` wraps official SDK clients for owned stdio children and external Streamable HTTP endpoints. `src/agent` owns provider adapters, normalized model messages, and budget stops. The CLI and Express API import these same units.

OAuth uses the MCP SDK `OAuthClientProvider` boundary and discovery/registration/token helpers together with `oauth4webapi` random state generation. A memory-only provider retains PKCE verifier, DCR/pre-registered client information, token expiry, refresh token, and discovery state. The loopback callback validates state, accepts denial, supports timeout and cancellation, and immediately redacts timeline entries. Forget authorization clears all in-memory material. CI uses client credentials or an externally supplied short-lived token.

SQLite uses WAL, forward-only migrations, immutable event rows, and transactions that atomically complete runs. An interrupted `running` record is recovered as `interrupted` on startup. Reporters receive sanitized run values and render JSON, standalone HTML, and JUnit.

## Security boundaries

The service defaults to `127.0.0.1`. Mutations require a random per-start session token and an Origin whose hostname is loopback. HTTP MCP URLs accept only `http:`/`https:` and reject credentials, link-local addresses, and cloud metadata targets. Suite YAML rejects inline secret-bearing keys. Redaction happens before any repository write, reporter output, or API serialization. Stdio uses an executable plus an argument array with no shell. Owned children close with the client; external servers are never stopped.

## UI design system

The accepted concept is [`docs/design/workbench-concept-v2.png`](../../design/workbench-concept-v2.png). The palette is graphite `#11110f`, umber `#1b1814`, parchment `#eee2c8`, clay `#a99a84`, copper `#d68735`, moss `#67a36b`, and brick `#b94f43`. System sans is used for chrome, Georgia sparingly for page titles, and the platform monospace stack for payloads and metrics. Corners are 2–4px, rules are one-pixel copper-tinted lines, and the signature element is a continuous copper event trace connecting model turns, tool calls, assertions, and latency.

Desktop uses a fixed navigation rail, main work area, and optional inspector. Mobile collapses navigation to a horizontal strip and stacks main content before the inspector. Motion is limited to trace/event entry and respects reduced-motion.

## User flows

Servers registers stdio or HTTP configurations and supports connect, discovery, OAuth connection/status/scopes/timeline/reconnect/forget, inspection, direct invocation, and explicit dangerous-call confirmation. Playground selects a server plus provider/model alias, runs a traceable chat interaction, and saves it as versioned YAML. Suites lists YAML files and runs them. Runs shows summaries plus model/tool/assertion/event detail. Compare presents pass-rate, duration, call, token, and cost deltas. Settings exposes Model Providers with compatibility type, model aliases, env-referenced headers, discovery, connection test, and local pricing without returning resolved credentials.

## Error and cancellation model

Validation failures return typed 400 responses. Origin/session failures return 403. Missing resources return 404. Runtime failures become sanitized normalized events and failed case results. Abort signals flow from API cancellation through OAuth callbacks, runners, agent calls, and MCP calls; stop reasons distinguish cancellation, turn, tool-call, elapsed-time, and cost budgets. Unsupported OAuth metadata and grants are reported precisely without implying compatibility.

## Verification

Focused Vitest slices cover redaction, YAML boundaries, assertions, persistence, real sample MCP stdio, fake OpenAI/Anthropic providers plus real MCP, the complete fake-server OAuth matrix, limit/cancellation stops, reporters, and API security. Headless Chrome drives the full browser flow at desktop and mobile sizes. Final verification runs tests, typecheck, build, sample stdio, both fake provider integrations, OAuth/API smoke, and browser smoke.
