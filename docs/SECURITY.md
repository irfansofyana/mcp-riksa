# Security boundaries

- Express binds to `127.0.0.1` unless you pass both a non-loopback `--host` and `--allow-external`.
- The API rejects non-loopback clients and external-origin mutations regardless of bind address — an external bind does not by itself grant remote control.
- Each process generates a random browser session token on startup. Mutations require that token plus a loopback `Origin` header.
- MCP and model endpoints accept HTTP or HTTPS only. The runtime blocks URL-embedded credentials, link-local targets, and common cloud metadata hosts (e.g. `169.254.169.254`).
- Stdio servers and the official conformance runner spawn fixed executables with argument arrays — no shell. Conformance children get a minimal environment, bounded output, a timeout, cancellation, and a forced-kill fallback.
- Only tools that declare `annotations.destructiveHint: true` require confirmation before being called. Missing annotations do not imply destructive behavior, and don't block manual, Playground, or agent-suite calls — because annotations are server-provided hints, only connect MCP servers you trust.
- The runtime redacts authorization headers, cookies, token fields, URL query secrets, bearer strings, and nested payloads before anything reaches SQLite, API responses, logs, or reports.
- Repository mode keeps committed config and suites outside `.mcp-riksa`. Config is authoritative and read-only through the API; suite YAML remains writable by design. OAuth access tokens, refresh tokens, authorization codes, and PKCE verifiers remain process-memory only and must be reacquired after restart.
- Commit only secret references such as `{ source: env, name: OPENAI_API_KEY }`. Vault/session IDs are machine-local; never commit plaintext credentials.
- SQLite runs in WAL mode with forward-only migrations, transactional writes, recovery for interrupted runs/conformance jobs, immutable run/playground event rows, tombstones for deleted seeded config, and sanitized conformance/playground history.

## MCP conformance runner

The **Conformance** workspace runs the official `@modelcontextprotocol/conformance` package, pinned exactly at `0.1.10`.

That release ships a CLI-only executable (`dist/index.js`) with no safe library export, so the workbench launches it with `process.execPath` and a fixed argument array — never a shell.

Execution is restricted to saved Streamable HTTP endpoints on `localhost`, `127.0.0.1`, or `::1`. Traffic passes through a temporary loopback proxy that rejects endpoint redirects, so the child runner can't escape the configured loopback boundary. Endpoints containing credentials, query parameters, or fragments are rejected outright. Stdio servers are shown as unsupported.

This pinned runner can't receive workbench OAuth or custom header credentials — those configurations are rejected up front rather than risking a leak into a spawned child process. Release `0.1.10` also doesn't provide frozen dated requirements sets; the UI states that limitation rather than approximating it.

Reports persist separately from workbench Suites/Runs. Each report records normalized passed/failed/warning/skipped/harness-error checks, spec references, runner version, bounded sanitized raw output, timeout/cancellation state, and startup-interruption recovery. Server configuration is locked while its report is running. "Passed" means every tested scenario passed — it is not a claim of universal MCP certification.

## Threat model, in short

MCP Riksa is a local developer tool, not a hosted multi-tenant service. The boundaries above exist to stop three specific things:

1. A browser tab on another origin silently driving your workbench (CSRF-style).
2. A misconfigured MCP server or provider endpoint reaching internal network targets (SSRF-style).
3. A secret you configured ending up somewhere you didn't intend — a log line, a SQLite row, an error message, a report.

It does not attempt to defend against a fully compromised local machine (same-user malware, root access) or a malicious MCP server you've deliberately chosen to trust.
