# CLI and repository workspace

MCP Riksa supports a repository-owned browser workspace and headless suite runs. Both use the same suite runner.

## Repository workspace

Use repository mode when configuration and suites belong in Git while OAuth, run history, and local secrets must remain local:

```text
project/
├── mcp-riksa.config.yaml
├── suites/
│   └── smoke.yaml
├── .mcp-riksa/       # runtime state; ignored
└── .gitignore
```

```bash
cd project
mcp-riksa serve --workspace .
```

`--workspace` selects these defaults:

- configuration: `<workspace>/mcp-riksa.config.yaml`
- portable suites: `<workspace>/suites`
- runtime state: `<workspace>/.mcp-riksa`

Repository configuration is authoritative and read-only in the UI. Edit YAML and restart MCP Riksa to apply configuration changes. Suite edits made in the UI write directly to the repository suite directory. OAuth authorization remains available in the UI and its tokens remain in process memory only.

Custom paths override workspace defaults:

```bash
mcp-riksa serve --workspace . \
  --config ./config/mcp-riksa.yaml \
  --suites-dir ./evals \
  --data-dir ./.mcp-riksa
```

`--suites-dir` expects a flat directory of `.yaml` files. Each filename must match its suite `name`. Runtime data and suite directories cannot overlap in repository mode.

Recommended `.gitignore`:

```gitignore
.mcp-riksa/
reports/
.env
```

### OAuth-only server example

The bundled repository example targets Notion's hosted Streamable HTTP server:

```bash
export OPENAI_API_KEY="..."
mcp-riksa serve --workspace ./examples/notion-workspace
```

Open the printed URL, authenticate Notion from **Servers**, then run `notion-smoke` from **Suites**. Notion documents `https://mcp.notion.com/mcp` as its hosted OAuth server: [Notion MCP setup](https://developers.notion.com/guides/mcp/get-started-with-mcp).

## Inspect a server without a full config

```bash
npx tsx src/cli/index.ts inspect --sample --json
```

`--sample` connects to the bundled deterministic stdio server without needing any config file — useful for a first smoke test.

## Run a direct-tool suite

```bash
npx tsx src/cli/index.ts run examples/sample-suite.yaml \
  --config examples/mcp-riksa.config.yaml \
  --data-dir .mcp-riksa/cli \
  --output reports
```

## Run an agent suite

Agent suites drive a real provider/model turn, so start the bundled fake provider first:

```bash
export MCP_RIKSA_PROVIDER_API_KEY=local-test-only
npx tsx scripts/fake-provider.ts --port 4000
```

Then, in another terminal:

```bash
npx tsx src/cli/index.ts run examples/sample-agent-suite.yaml \
  --config examples/mcp-riksa.config.yaml \
  --data-dir .mcp-riksa/agent-cli \
  --output agent-reports
```

## Runtime data directory

`serve`, `inspect`, and `run` use one runtime-data resolution order:

1. Explicit `--data-dir <path>`
2. `MCP_RIKSA_DATA_HOME`
3. `<workspace>/.mcp-riksa` in repository mode, otherwise `.mcp-riksa` relative to current working directory

The directory contains local SQLite history and encrypted vault data. In legacy mode it also contains saved suite-library files. Repository mode keeps suites in `--suites-dir` instead. `serve` prints its resolved absolute mode, config, suite, and data paths at startup.

### Project mode

For repository-owned browser workflows, prefer workspace mode:

```bash
mcp-riksa serve --workspace .
```

For legacy UI-managed configuration, state and suites can remain isolated together:

```bash
mcp-riksa serve --data-dir .mcp-riksa --config ./mcp-riksa.config.yaml
```

Without `--workspace`, `serve --config` seeds missing entries and preserves browser edits.

### Personal mode

Use one persistent workbench from any directory:

```bash
export MCP_RIKSA_DATA_HOME="$HOME/.local/state/mcp-riksa"
# Or choose another absolute directory, such as "$HOME/.mcp-riksa".
mcp-riksa serve --config ./mcp-riksa.config.yaml
```

`--data-dir` always overrides `MCP_RIKSA_DATA_HOME`. Repository mode changes only the fallback; an explicit data directory or environment setting still wins.

## Output

Each run writes three report formats into `--output`:

- `run.json` — full machine-readable result
- `run.html` — human-readable report
- `junit.xml` — for CI test-result integrations

The CLI also prints JSON to stdout and returns a non-zero exit code when the suite fails, so it composes cleanly with any CI runner.

## Compiled entry point

Once installed from npm (`npm install -g mcp-riksa` or via `npx mcp-riksa`), the same commands are available directly as `mcp-riksa`:

```bash
mcp-riksa serve --config ./mcp-riksa.config.yaml
mcp-riksa run ./suites/regression.yaml --config ./mcp-riksa.config.yaml --output reports
```
