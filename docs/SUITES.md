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

## Repository suite directory

Use `serve --workspace .` to load portable suites from `./suites`, or override it with `--suites-dir <path>`. Repository suite files remain fully editable through the browser and can be committed directly; runtime history and secrets stay under `.mcp-riksa`.

Suite directories are flat. Every file must end in `.yaml`, its filename must equal `<suite.name>.yaml`, symbolic links are rejected, and case-insensitive name collisions fail startup. External file edits require restart in this release.

To migrate suites from legacy project storage:

```bash
mkdir -p suites
cp .mcp-riksa/suites/*.yaml suites/
```

Review files before committing; migration is never automatic.

## Composing suites in the browser

Choose **Create suite** once, then select **Generate with AI** or **Build manually**. Both routes produce an unsaved draft in the same visual composer for direct and agent cases. Add expected tool calls, output assertions, JSONPath checks, and budgets without hand-authoring YAML. The YAML tab stays canonical: visual edits serialize to strict versioned suite YAML that commits and runs unchanged through the CLI or CI.

New browser-authored suites use the current multi-turn-capable format. Existing Version 1 files still load and remain editable; the composer labels them as legacy and offers an explicit one-way upgrade instead of asking authors to choose a schema version during creation.

Existing suite files load back into the visual composer, and raw YAML stays editable for anything the composer doesn't cover. The suite library supports full CRUD — create, load/edit, rename, duplicate, delete. Renaming moves the underlying YAML file; deleting removes only the suite definition and keeps historical run evidence intact. Unsaved or edited suites cannot run until saved, preventing a visible draft from accidentally running older persisted YAML.

## Generate an agent suite draft

In **Create suite**, choose **Generate with AI** to turn a connected server's live tool names, descriptions, and input schemas into a reviewable agent suite. Select the configured **AI author** provider/model separately from the **Model to test**, then choose a generation goal:

- **Specific scenarios** — describe one to eight workflows. The author chooses only relevant expected tools, can plan multiple calls per case, and does not force unrelated tool coverage. Optionally restrict which safe tools it may use.
- **Selected tool coverage** — select explicit tools. The author must create or justify excluding exactly those tools; unrelated safe tools stay outside the ledger.
- **All safe tools** — preserve exhaustive behavior. The author must create a case for every non-destructive tool or exclude it with a concrete uncertainty reason.

Generation is draft-only. It never invokes MCP tools, saves a suite file, or starts a run. Tools declaring `annotations.destructiveHint: true` are excluded before model generation and cannot be selected. Missing destructive annotations are not proof that a tool is safe. Fixture and domain guidance can supply known IDs, realistic values, and forbidden actions, but it never changes the structured generation scope.

Review generated cases, expected tool calls, and exclusions; choose **Use generated cases**; inspect every prompt and assertion in the composer; then save explicitly. Starting another creation session always clears the previous generated review. Running the saved suite executes real MCP tools and may cause side effects. Generated exclusion reasons belong to the current review session and are not written into portable suite YAML.

## Live run progress

Starting a suite opens its Runs view immediately. While execution is active, the workbench refreshes automatically and reports completed/total cases, pass/fail counts, remaining cases, elapsed time, the active case, and the current iteration for sampled Version 2 cases. Final case evidence, model/tool timelines, and assertion details replace the live panel when execution finishes; manual Refresh is not required.

## Playground → suite

Any completed Playground turn can be saved as a portable YAML regression case via **Save YAML case**, which is the fastest way to turn an exploratory chat into a repeatable check.
