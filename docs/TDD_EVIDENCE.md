# TDD execution evidence

Each production slice started with its focused test. The first run failed for the missing behavior, then the implementation made the same command pass.

| Slice | Red evidence | Green command |
| --- | --- | --- |
| Redaction and suite parsing | `Cannot find module '../src/core/redaction.js'` | `npm test -- test/core.test.ts` |
| Assertions and runner | `Cannot find module '../src/core/assertions.js'` | `npm test -- test/assertions.test.ts test/core.test.ts` |
| SQLite history | `Cannot find module '../src/storage/database.js'` | `npm test -- test/storage.test.ts` |
| MCP stdio and endpoint safety | `Cannot find module '../src/mcp/manager.js'` | `npm test -- test/mcp.test.ts` |
| Provider adapters and agent limits | `Cannot find module '../src/agent/providers.js'` | `npm test -- test/agent.test.ts` |
| OAuth lifecycle | `Cannot find module '../src/mcp/oauth.js'` | `npm test -- test/oauth.test.ts` |
| Reporters | `Cannot find module '../src/reporters/json.js'` | `npm test -- test/reporters.test.ts` |
| Loopback API | `Cannot find module '../src/server/app.js'` | `npm test -- test/api.test.ts` |
| Concrete runtime | `Cannot find module '../src/server/runtime.js'` | `npm test -- test/runtime.test.ts` |
| Headless CLI | child exited `1` before `src/cli/index.ts` existed | `npm test -- test/cli.test.ts` |
| Browser view model | `Cannot find module '../web/src/model.js'` | `npm test -- test/web-model.test.ts` |
| Browser journey | `Cannot find module '../scripts/smoke-browser.js'` | `npm test -- test/browser.test.ts` |
| Provider protocol and env-reference persistence | focused assertions failed on `file:` acceptance and redacted env names | `npm test -- test/agent.test.ts test/runtime.test.ts` |
| Secret references, DNS rebinding, and terminal run failures | focused assertions accepted inline references and reported missing `createSafeLookup` / `RunRepository.fail` | `npm test -- test/agent.test.ts test/mcp.test.ts test/storage.test.ts test/runtime.test.ts` |
| Normalized case correlation | injected observation events retained a server ID instead of the suite case ID | `npm test -- test/assertions.test.ts` |
| Static-client and DCR OAuth registration UI | HTTP server form discarded scopes and static-client environment references | `npm test -- test/web-model.test.ts` |

The browser harness then exposed two test timing assumptions. Failure diagnostics showed the Settings heading appeared before bootstrap mounted its form, and a selected running record did not render the empty-state “Run detail” heading. Condition-based waits now target the real controls and run state.
