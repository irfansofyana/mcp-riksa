# Suite format

Suites are strict, versioned YAML — unknown keys, malformed calls, invalid budgets, and inline secret fields all fail parsing at load time instead of failing silently mid-run.

There are two kinds of cases:

- **Direct cases** invoke a named tool on a connected MCP server directly, with fixed arguments.
- **Agent cases** reference a server alias, a provider alias, and a model alias, and drive a full provider/tool turn loop.

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
