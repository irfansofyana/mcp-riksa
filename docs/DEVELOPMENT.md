# Development

## Requirements

- Node.js 24
- npm 11 or newer
- A C/C++ build toolchain if npm needs to compile `better-sqlite3` from source
- Google Chrome for the automated browser test

## Local setup

```bash
git clone https://github.com/irfansofyana/mcp-riksa.git
cd mcp-riksa
npm install
npm run dev -- --config examples/mcp-riksa.config.yaml
```

Open `http://127.0.0.1:4317`. `npm run dev` serves the Vite dev server through the same Express app used in production, so behavior matches a real build.

## Verification

Run the same checks CI runs:

```bash
npm test
npm run typecheck
npm run build
node dist/src/cli/index.js run examples/sample-suite.yaml \
  --config examples/ci-mcp-riksa.config.yaml \
  --data-dir .mcp-riksa/ci \
  --output reports
```

`npm test` covers real stdio and Streamable HTTP MCP discovery/invocation, streamed and non-streamed fake OpenAI-compatible and Anthropic-compatible agent loops, durable conversations, OAuth callback handoff, API security, SQLite transactions, reporters, CLI subprocesses, and the Chrome desktop/mobile journey. GitHub Actions uploads the CLI report artifacts on every run.

The deterministic fake OpenAI-compatible endpoint (`scripts/fake-provider.ts`) exercises a standard `/v1/chat/completions` tool-call contract without needing any particular gateway product or external credential during tests.

## Releasing to npm

Releases are tag-triggered. Pushing a `v*.*.*` tag runs `.github/workflows/release.yml`, which re-verifies (test/typecheck/build), checks the tag matches `package.json`'s version, then publishes with `npm publish --access public --provenance`.

```bash
npm version patch   # or minor / major — updates package.json and creates the tag
git push --follow-tags
```

Publishing requires an `NPM_TOKEN` repository secret (an npm automation token with publish rights). Nothing is published from a local machine — this keeps releases reproducible and keeps long-lived publish credentials out of any laptop.

## Current limitations

- OAuth material uses memory-only storage — there's no encrypted token persistence in this release.
- Anthropic-compatible endpoints don't expose a standard model-list route, so their connection test sends a short completion request instead.
- JSONPath assertions support property access, array indexes, and quoted bracket keys only — filter expressions and scripts are out of scope.
- Cost is computed from the local prices in provider config. A provider response with no usage data reports zero tokens and zero estimated cost.
- Official conformance testing currently supports unauthenticated loopback Streamable HTTP servers only — stdio, OAuth, custom headers, and frozen dated requirement sets aren't supported.
- The app owns and stops stdio child processes it spawns. It doesn't manage the lifecycle of external HTTP MCP servers you point it at.

## Project history

`BUILD_BRIEF.md` in the repo root captures the original MVP scope and architecture constraints this project was built against, if you want the full backstory on why certain boundaries exist.
