# Playground

Playground is the interactive chat surface for exercising a configured provider/model against connected MCP servers.

## Streaming and the agent loop

Playground sends provider output over a local SSE stream. Both OpenAI-compatible and Anthropic-compatible adapters emit text deltas while model turns and MCP tool calls continue through the same normalized agent loop that suites use. Suite execution itself stays non-streaming, so assertions run against a deterministic, complete result.

New conversations start with an empty composer — nothing is pre-filled. An optional system prompt is fixed when the conversation is created and shown in the Model Context inspector. The Raw view exposes a sanitized preview of exactly what's sent to the model: system prompt, prior messages, the pending user turn, MCP tool source, and execution limits. Different provider adapters may encode that context differently on the wire — Anthropic, for example, uses a top-level `system` field instead of a system message.

## Tools and sessions

The left rail switches between **Tools** and **Sessions**:

- **Tools** discovers the selected server's tools, shows descriptions and input schemas, and generates typed parameter forms (required/optional strings, numbers, booleans, enums, nested objects, arrays) — raw JSON stays available as a fallback. **Run Tool** performs a direct invocation and writes a truthful `Execute <tool>` user turn plus the sanitized result into chat history.
- Tool confirmation follows explicit server metadata: only tools declaring `annotations.destructiveHint: true` require confirmation before running. This keeps common unannotated read-only tools usable while still gating anything a server explicitly flags as destructive.

## History and evidence

Conversations and their sanitized message traces persist in local SQLite, so history survives browser and workbench restarts. Each conversation tracks input/output tokens, cumulative cost, agent time, tool calls, stop reason, and an immutable sequence of normalized trace events.

Three views cover different needs:

- **Chat** — rendered Markdown (headings, emphasis, lists, tables, links, blockquotes, fenced code — no raw HTML execution).
- **Trace** — an observability-style latency waterfall with expandable span data.
- **Raw** — the complete sanitized record, for when you need to see exactly what happened.

MCP tool results render text, inline images, resource links, and embedded resource/structured-content blocks, with raw JSON inspection always available underneath.

Use **Save YAML case** on any completed turn to turn it into a portable regression case — see [SUITES.md](SUITES.md).
