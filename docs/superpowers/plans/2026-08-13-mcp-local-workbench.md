# MCP Local Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build the complete loopback-only MCP evaluation workbench described in `BUILD_BRIEF.md`.

**Architecture:** A framework-independent TypeScript core is shared by an Express service and Commander CLI. Official MCP clients and normalized OpenAI/Anthropic adapters provide transport/model integration; the MCP SDK OAuth interface plus `oauth4webapi` provide OAuth; sanitized history is stored transactionally in SQLite; React/Vite provides the browser workspace.

**Tech Stack:** Node 24, TypeScript, Vitest, MCP SDK, OpenAI SDK, oauth4webapi, Zod, YAML, better-sqlite3, Express, React, Vite.

## Global Constraints

- Bind to `127.0.0.1` by default and require explicit external-bind opt-in.
- Never persist or return secrets; redact before persistence and reporting.
- Use no shell interpolation for stdio processes.
- OAuth supports Authorization Code + PKCE, metadata discovery, DCR or pre-registered clients, refresh/expiry, forget, denial, timeout, cancellation, and state verification.
- Do not commit or push.

---

### Task 1: Redaction and suite boundary

**Files:** `test/core.test.ts`, `src/core/redaction.ts`, `src/core/suite.ts`, `src/core/types.ts`

**Interfaces:** `redact<T>(value: T): T`; `parseSuite(source: string): Suite`.

- [x] Add focused tests proving recursive header/token/cookie/query redaction and strict YAML rejection of unknown keys, malformed calls, invalid limits, and inline secrets.
- [x] Run `npm test -- test/core.test.ts` and confirm imports/behavior fail.
- [x] Implement immutable recursive redaction plus strict Zod suite schemas.
- [x] Re-run the focused tests until green.

### Task 2: Assertions and normalized runner results

**Files:** `test/assertions.test.ts`, `src/core/assertions.ts`, `src/core/events.ts`, `src/core/runner.ts`

**Interfaces:** `evaluateAssertions(assertions, observation): AssertionResult[]`; `runSuite(suite, dependencies, options): Promise<RunResult>`.

- [x] Add one behavioral test per called/not-called/count/order/args/JSONPath/contains/regex/duration/tokens/cost assertion and a runner aggregation test.
- [x] Run the test file and confirm the missing evaluator/runner causes expected failures.
- [x] Implement the smallest assertion evaluator and runner orchestration that satisfies the tests.
- [x] Re-run the focused and core tests.

### Task 3: SQLite history

**Files:** `test/storage.test.ts`, `src/storage/database.ts`, `src/storage/runs.ts`

**Interfaces:** `openDatabase(path): Database`; `RunRepository.start/appendEvent/complete/recoverInterrupted/compare`.

- [x] Test migration/WAL, redacted immutable events, atomic completion rollback, interruption recovery, and comparison deltas.
- [x] Observe expected failures with `npm test -- test/storage.test.ts`.
- [x] Add migrations and transactional repository methods; call redaction before SQL serialization.
- [x] Re-run storage and core tests.

### Task 4: Real MCP transport

**Files:** `examples/sample-mcp-server.ts`, `test/mcp.test.ts`, `src/mcp/validation.ts`, `src/mcp/manager.ts`

**Interfaces:** `McpManager.connect/inspect/call/disconnect/closeAll`; `validateHttpEndpoint(url)`.

- [x] Test unsafe URL rejection and spawn the TS sample through the official stdio SDK for discovery and deterministic echo/add/dangerous calls.
- [x] Observe the missing manager/server failure.
- [x] Implement the deterministic server and official SDK transport manager without a shell.
- [x] Re-run the real stdio test and verify the child exits.

### Task 5: Provider-neutral agent loop and limits

**Files:** `test/agent.test.ts`, `test/helpers/fake-providers.ts`, `src/agent/types.ts`, `src/agent/openai.ts`, `src/agent/anthropic.ts`, `src/agent/loop.ts`

**Interfaces:** `runAgent(input, mcp, config): Promise<AgentResult>` with `AbortSignal` and turn/call/time/cost limits.

- [x] Start fake OpenAI-compatible and Anthropic-compatible HTTP endpoints plus a real sample MCP process; test complete model→tool→model loops, env-referenced custom headers, missing usage, malformed responses, and normalized cost.
- [x] Add separate cancellation, max-turn, max-tool-call, elapsed, and cost-stop tests; observe each expected failure before its implementation.
- [x] Implement the OpenAI SDK loop, normalized trace, usage/cost accounting, and explicit stop reasons.
- [x] Re-run agent, MCP, and core tests.

### Task 6: OAuth lifecycle

**Files:** `test/oauth.test.ts`, `test/helpers/fake-oauth.ts`, `src/mcp/oauth.ts`

**Interfaces:** `OAuthCoordinator.begin/callback/status/refresh/forget/cancel`; in-memory implementation of the MCP SDK `OAuthClientProvider`.

- [x] Start a fake protected-resource/authorization server and test metadata discovery, pre-registered clients, DCR, PKCE success, denial, state mismatch, timeout/cancellation, refresh/expiry, forget, and sanitized history.
- [x] Observe the missing coordinator fail, then implement each lifecycle behavior using MCP SDK OAuth helpers and `oauth4webapi` state generation.
- [x] Prove raw tokens, codes, verifiers, client secrets, and header values are absent from timeline, SQLite, API, and reporters.
- [x] Re-run OAuth and transport tests.

### Task 7: Reporters

**Files:** `test/reporters.test.ts`, `src/reporters/json.ts`, `src/reporters/html.ts`, `src/reporters/junit.ts`

**Interfaces:** `reportJson`, `reportHtml`, `reportJunit` return strings from a sanitized `RunResult`.

- [x] Test parseable formats, key content, XML escaping, and absence of seeded secrets; observe failures.
- [x] Implement deterministic JSON, dependency-free static HTML, and JUnit XML output through a final redaction pass.
- [x] Re-run reporter tests.

### Task 8: Loopback API and CLI

**Files:** `test/api.test.ts`, `src/server/app.ts`, `src/server/runtime.ts`, `src/cli/index.ts`

**Interfaces:** `createApp(runtime): Express`; CLI commands `serve`, `run`, `inspect`.

- [x] Test session bootstrap, external-Origin mutation rejection, secret-free settings, server/call/suite/run/compare endpoints, cancellation, and API sanitization; observe failures.
- [x] Implement the runtime, route validation, CSRF/session boundary, loopback defaults, static production serving, and CLI commands.
- [x] Re-run API tests and exercise CLI help.

### Task 9: React workbench

**Files:** `test/web-model.test.ts`, `web/index.html`, `web/src/api.ts`, `web/src/model.ts`, `web/src/components.tsx`, `web/src/App.tsx`, `web/src/styles.css`, `web/src/main.tsx`

**Interfaces:** browser calls the documented `/api` routes; pure page/view-model helpers remain Vitest-testable.

- [x] Test navigation/page state, trace grouping, compare deltas, and generated form payloads; observe failures.
- [x] Implement the concept-derived shell and fully interactive Servers, Playground, Suites, Runs, Compare, and Settings pages.
- [x] Run web tests, typecheck, and Vite build.

### Task 10: Docs, CI, and end-to-end checks

**Files:** `test/e2e.test.ts`, `examples/sample-suite.yaml`, `scripts/fake-litellm.ts`, `scripts/smoke-browser.ts`, `README.md`, `.github/workflows/ci.yml`

**Interfaces:** documented local/CI commands and report artifacts.

- [x] Add a smoke test for the compiled/local service path and observe it fail before wiring missing pieces.
- [x] Add deterministic examples, GitHub Actions, exact README commands, limitations, and security notes.
- [x] Run `npm test`, `npm run typecheck`, and `npm run build` fresh.
- [x] Run real sample stdio, both fake provider agent/tool loops, OAuth, CLI report, API, and desktop/mobile Chrome smoke commands.
- [x] Inspect concept and final screenshots with `view_image`, record a five-point fidelity ledger, and leave the uncommitted working tree ready for review.
