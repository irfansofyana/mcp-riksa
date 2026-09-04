# Configuration

`examples/mcp-riksa.config.yaml` shows the complete file shape. The schema is `version: 2`. MCP Riksa is unpublished as of this version, so pricing corrections and other breaking config changes ship as clean schema bumps rather than automatic migrations.

Browser edits persist in SQLite. Configuration passed via `serve --config` seeds missing entries without overwriting browser edits; deleting a seeded entry creates a local tombstone so it stays deleted across restarts. Headless `run --config` is authoritative for that run — it does not read or write the browser's SQLite state.

## Repository-managed configuration

`serve --workspace <path>` makes `<workspace>/mcp-riksa.config.yaml` authoritative for that process:

```bash
mcp-riksa serve --workspace .
```

Repository providers and servers are loaded fresh on startup, are not copied into SQLite, and cannot be created, edited, duplicated, or deleted through the UI. Connection tests, MCP inspection, OAuth, Playground, suite generation, and suite execution remain available. Edit YAML and restart to apply changes.

Repository mode intentionally ignores provider/server rows and tombstones in the runtime database. Those rows remain untouched and become visible again when starting the same data directory in legacy local mode. This avoids destructive configuration migration while ensuring every teammate gets the committed configuration.

Use environment references for portable team configuration. Vault and session IDs belong to one local workbench and should not be committed as shared assumptions.

Relative stdio working directories resolve from the workspace root. When `cwd` is omitted, stdio servers start from the workspace root.

## Providers

Provider configs support:

- `openai-compatible` and `anthropic-compatible` protocols
- multiple model aliases per provider, each mapped to its upstream model ID and its own input/output price
- API keys and custom headers backed by vault, session, or environment references
- OpenAI-compatible model discovery and connection testing
- create, edit, duplicate, and reference-safe delete workflows for providers and MCP servers

Each provider owns a model catalog, so one endpoint and credential set can expose aliases such as `fast`, `quality`, and `reasoning`. Cost assertions, comparisons, reports, Playground totals, and `maxCostUsd` all use the selected alias's pricing. Editing a provider keeps its ID stable; duplicating creates a new ID. Removing a model alias is blocked while a saved suite or conversation still references it.

## Secrets

The **Secrets** workspace accepts write-only credentials in two forms: an encrypted persistent vault, or session-only memory.

Persistent saves generate a random 256-bit key at `~/.config/mcp-riksa/vault.key` and encrypt values into `.mcp-riksa/secrets.vault`. The browser and APIs return only opaque IDs and metadata — there is no reveal or copy operation. Use the returned reference directly in provider or server configuration:

```yaml
apiKey:
  source: vault
  id: secret_00000000-0000-4000-8000-000000000001
```

Environment references remain the best fit for CI, containers, and process-managed secrets:

```bash
export MCP_RIKSA_PROVIDER_API_KEY=local-test-only
```

```yaml
apiKey:
  source: env
  name: MCP_RIKSA_PROVIDER_API_KEY
```

The config file only ever stores the reference (`{ source: env, name: ... }` or `{ source: vault, id: ... }`), never the value. Resolved values are registered with the redaction system immediately before use, so they never reach logs, SQLite, or API responses in plaintext.

The vault prevents plaintext-at-rest and common accidental leaks, but it is not equivalent to a user-held passphrase. On POSIX systems, MCP Riksa creates and verifies owner-only directories and files. On Windows, place both paths in directories protected by owner-only ACLs — MCP Riksa does not currently verify Windows ACLs itself. Malware running as the same OS user, root/administrator access, or an attacker who obtains both the key and the vault file can decrypt it.

## OAuth (Streamable HTTP servers)

Authorization Code + PKCE, metadata discovery, Dynamic Client Registration (DCR) when advertised, and pre-registered clients are supported:

```yaml
oauth:
  scopes: [mcp:read, mcp:write]
  timeoutMs: 120000
  # Omit clientId to use DCR when the authorization server advertises it.
  clientId: pre-registered-client
  clientSecret:
    source: env
    name: MCP_OAUTH_CLIENT_SECRET
```

The workbench discovers RFC 9728 protected-resource metadata and RFC 8414 authorization-server metadata, and uses the MCP SDK's OAuth provider interface for DCR, Authorization Code + PKCE, token exchange, refresh, and invalidation. `oauth4webapi` supplies standards-based random OAuth state. The callback accepts loopback HTTP URLs and checks state before code exchange.

Interactive authorization opens in a popup. A successful callback notifies the opener through a same-origin channel, closes the popup, refreshes authorization status, and reconnects the MCP server automatically. A bounded status poll covers browsers that suppress popup messaging.

OAuth tokens, authorization codes, and PKCE verifiers are held in memory only — "Forget authorization" clears them, and a process restart requires re-authorization. There is no encrypted token persistence in this release. OAuth client secrets may use vault, session, or environment references. CI can inject a short-lived bearer token through a static authorization environment reference instead of running interactive OAuth.

## Static authorization

For direct token authentication without OAuth, configure static authorization. MCP Riksa resolves the credential and assembles the final header only in the backend:

```yaml
staticAuth:
  header: Authorization
  scheme: Bearer
  credential:
    source: vault
    id: secret_00000000-0000-4000-8000-000000000001
```

Bearer, Basic, and custom schemes are supported. Static authorization and OAuth are mutually exclusive on the same server config. Arbitrary HTTP headers and stdio environment values use the same secret-reference shape (`source: env | vault | session`).
