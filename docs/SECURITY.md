# Security boundaries

- Express binds to `127.0.0.1` unless you pass both a non-loopback `--host` and `--allow-external`.
- The API rejects non-loopback clients and external-origin mutations regardless of bind address — an external bind does not by itself grant remote control.
- Each process generates a random browser session token on startup. Mutations require that token plus a loopback `Origin` header.
- MCP and model endpoints accept HTTP or HTTPS only. The runtime blocks URL-embedded credentials, link-local targets, and common cloud metadata hosts (e.g. `169.254.169.254`).
- Stdio servers spawn fixed executables with argument arrays — no shell.
- Only tools that declare `annotations.destructiveHint: true` require confirmation before being called. Missing annotations do not imply destructive behavior, and don't block manual, Playground, or agent-suite calls — because annotations are server-provided hints, only connect MCP servers you trust.
- The runtime redacts authorization headers, cookies, token fields, URL query secrets, bearer strings, and nested payloads before anything reaches SQLite, API responses, logs, or reports.
- Repository mode keeps committed config and suites outside `.mcp-riksa`. Config is authoritative and read-only through the API; suite YAML remains writable by design. OAuth access tokens, refresh tokens, authorization codes, and PKCE verifiers remain process-memory only and must be reacquired after restart.
- Commit only secret references such as `{ source: env, name: OPENAI_API_KEY }`. Vault/session IDs are machine-local; never commit plaintext credentials.
- SQLite runs in WAL mode with forward-only migrations, transactional writes, recovery for interrupted runs, immutable run/playground event rows, tombstones for deleted seeded config, and sanitized playground history.

## Threat model, in short

MCP Riksa is a local developer tool, not a hosted multi-tenant service. The boundaries above exist to stop three specific things:

1. A browser tab on another origin silently driving your workbench (CSRF-style).
2. A misconfigured MCP server or provider endpoint reaching internal network targets (SSRF-style).
3. A secret you configured ending up somewhere you didn't intend — a log line, a SQLite row, an error message, a report.

It does not attempt to defend against a fully compromised local machine (same-user malware, root access) or a malicious MCP server you've deliberately chosen to trust.
