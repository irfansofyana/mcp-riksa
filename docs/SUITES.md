# Suite format

Suites are strict, versioned YAML — unknown keys, malformed calls, invalid budgets, and inline secret fields all fail parsing at load time instead of failing silently mid-run.

There are two kinds of cases:

- **Direct cases** invoke a named tool on a connected MCP server directly, with fixed arguments.
- **Agent cases** reference a server alias, a provider alias, and a model alias, and drive a full provider/tool turn loop.

Version 1 agent cases contain one `prompt`. Version 2 agent cases contain explicit scripted `turns`, so a deterministic user answer can follow a model clarification without involving a human or an LLM simulator. Each v2 iteration starts with fresh model history; limits apply across all user turns in that iteration.

```yaml
version: 2
name: calendar-follow-up
cases:
  - id: book-after-time
    kind: agent
    server: calendar
    provider: local-openai
    model: default
    turns:
      - id: request
        user: Book a planning meeting tomorrow.
        assertions:
          - type: tool_count
            count: 0
      - id: time
        user: At 15:00 Jakarta time.
        assertions:
          - type: tool
            tool: create_meeting
            arguments: { path: $.time, equals: "15:00" }
            success: true
    iterations: { count: 5, minPasses: 4 }
    limits: { maxTurns: 8, maxToolCalls: 2, timeoutMs: 30000 }
    assertions:
      - type: tool_count
        tool: create_meeting
        count: 1
```

`iterations.count` runs independent samples; `minPasses` is required for logical case success. A `tool` assertion selects named tool occurrence (default `1`) and can check exact arguments, result JSONPath, and MCP success/error outcome.

## Assertions

Supported assertion types:

- tool called / not called
- call count
- call order
- argument matching
- JSONPath (property access, array indexes, quoted bracket keys — no filter expressions or scripts)
- string contains
- regex
- duration budget
- total token budget
- estimated cost budget (`maxCostUsd`, using the selected model alias's local pricing)

See [`examples/sample-suite.yaml`](../examples/sample-suite.yaml) for a direct-tool suite and [`examples/sample-agent-suite.yaml`](../examples/sample-agent-suite.yaml) for an agent suite.

## Composing suites in the browser

The **Suites** workspace has a visual case composer for both direct and agent cases — add expected tool calls, output assertions, JSONPath checks, and budgets without hand-authoring YAML. The YAML tab stays canonical: visual edits serialize to strict version-1 suite YAML that commits and runs unchanged through the CLI or CI.

Existing suite files load back into the visual composer, and raw YAML stays editable for anything the composer doesn't cover. The suite library supports full CRUD — create, load/edit, rename, duplicate, delete. Renaming moves the underlying YAML file; deleting removes only the suite definition and keeps historical run evidence intact.

## Playground → suite

Any completed Playground turn can be saved as a portable YAML regression case via **Save YAML case**, which is the fastest way to turn an exploratory chat into a repeatable check.
