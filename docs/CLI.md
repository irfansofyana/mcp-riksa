# Headless CLI

The CLI runs the same suite runner used by the browser workbench, so a suite behaves identically whether it's launched interactively or from CI.

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
