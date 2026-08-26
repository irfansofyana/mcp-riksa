export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type SuiteAssertion =
  | { type: 'tool_called'; tool: string }
  | { type: 'tool_not_called'; tool: string }
  | { type: 'tool_count'; tool?: string; count: number }
  | { type: 'tool_order'; tools: string[] }
  | { type: 'args'; tool: string; path?: string; equals: JsonValue }
  | { type: 'jsonpath'; path: string; equals?: JsonValue; exists?: boolean }
  | { type: 'contains'; path?: string; value: string }
  | { type: 'regex'; path?: string; pattern: string; flags?: string }
  | { type: 'duration'; maxMs: number }
  | { type: 'tokens'; max: number }
  | { type: 'cost'; maxUsd: number }
  | { type: 'tool'; tool: string; occurrence?: number; arguments?: { path?: string; equals: JsonValue }; result?: { path?: string; equals?: JsonValue; exists?: boolean }; success?: boolean };

export type SuiteLimits = { maxTurns: number; maxToolCalls: number; timeoutMs: number; maxCostUsd?: number };
export type DirectSuiteCase = {
  id: string; kind: 'direct'; server: string;
  call: { tool: string; arguments: Record<string, JsonValue>; dangerous?: boolean };
  assertions: SuiteAssertion[];
};
export type AgentSuiteCaseV1 = {
  id: string; kind: 'agent'; server: string; provider: string; model: string; prompt: string;
  limits: SuiteLimits; assertions: SuiteAssertion[];
};
export type AgentSuiteTurn = { id: string; user: string; assertions: SuiteAssertion[] };
export type AgentSuiteCaseV2 = {
  id: string; kind: 'agent'; server: string; provider: string; model: string;
  turns: AgentSuiteTurn[]; iterations: { count: number; minPasses: number };
  limits: SuiteLimits; assertions: SuiteAssertion[];
};
export type AgentSuiteCase = AgentSuiteCaseV1 | AgentSuiteCaseV2;
export type SuiteCase = DirectSuiteCase | AgentSuiteCase;
export type SuiteDraftV1 = { version: 1; name: string; description?: string; cases: SuiteCase[] };
export type SuiteDraftV2 = { version: 2; name: string; description?: string; cases: SuiteCase[] };
export type SuiteDraft = SuiteDraftV1 | SuiteDraftV2;
export type SuiteDetail = { name: string; source: string; suite: SuiteDraft };

export type Tool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean; idempotentHint?: boolean };
};

export type SecretReference =
  | { source: 'env'; name: string }
  | { source: 'vault'; id: string }
  | { source: 'session'; id: string };

export type ServerSummary = {
  id: string;
  name: string;
  connected?: boolean;
} & (
  | { transport: 'stdio'; command: string; args: string[]; cwd?: string; envRefs: Record<string, string>; env: Record<string, SecretReference> }
  | { transport: 'http'; url: string; headerEnv: Record<string, string>; headers: Record<string, SecretReference>; staticAuth?: { header: string; scheme: string; credential: SecretReference }; allowUnsafeEndpoint: boolean; oauth?: { scopes: string[]; clientId?: string; clientSecretEnv?: string; clientSecret?: SecretReference; timeoutMs: number } }
);

export type ProviderSummary = {
  id: string; name: string; type: 'openai-compatible' | 'anthropic-compatible'; baseUrl: string;
  models: Record<string, { id: string; pricing: { inputPerMillion: number; outputPerMillion: number } }>;
  apiKeyEnv?: string; apiKey?: SecretReference; apiKeyConfigured?: boolean; headerEnv?: Record<string, string>; headers?: Record<string, SecretReference>;
  headerStatus?: Record<string, { source: string; reference: string; configured: boolean }>;
};

export type EventRecord = {
  id: string; caseId: string; type: string; timestamp: string; durationMs?: number; data: unknown; sanitized: true;
};

export type TurnObservation = { id?: string; user?: string; observation?: unknown; [key: string]: unknown };
export type IterationObservation = { turns?: TurnObservation[]; status?: string; passed?: boolean; observation?: { turns?: TurnObservation[]; [key: string]: unknown }; [key: string]: unknown };
export type CaseResult = {
  id: string; kind: string; status: string; error?: string;
  observation: {
    output: unknown; toolCalls: Array<{ name: string; arguments: unknown; result?: unknown; durationMs?: number }>;
    durationMs: number; tokens: { input: number; output: number; total: number }; costUsd: number;
    events: EventRecord[]; stopReason?: string; turns?: TurnObservation[];
  };
  assertions: Array<{ passed: boolean; message: string; expected?: unknown; actual?: unknown; assertion: { type: string; [key: string]: unknown } }>;
  evaluation?: { passed?: boolean; count?: number; minPasses?: number; iterations?: { count?: number; minPasses?: number; passes?: number } | IterationObservation[]; [key: string]: unknown };
  iterations?: IterationObservation[];
};

export type Run = {
  id: string; suite: string; status: string; startedAt: string; completedAt: string;
  summary: { total: number; passed: number; failed: number; passRate: number };
  cases: CaseResult[]; events: EventRecord[];
};

export type ConformanceCheck = {
  sequence: number; scenario: string; id: string; name: string; description: string;
  status: 'passed' | 'failed' | 'warning' | 'skipped' | 'harness_error'; timestamp?: string;
  specReferences: Array<{ id: string; url?: string }>; error?: string; details?: unknown;
};

export type ConformanceReportSummary = {
  id: string; serverId: string; endpoint: string;
  selection: { kind: 'suite'; suite: 'active' } | { kind: 'scenario'; scenario: string };
  status: 'running' | 'passed' | 'failed' | 'warning' | 'harness_error' | 'cancelled' | 'timed_out' | 'interrupted';
  startedAt: string; completedAt?: string; runnerVersion: string;
  summary: { total: number; passed: number; failed: number; warnings: number; skipped: number; harnessErrors: number };
  diagnostic?: string;
};

export type ConformanceReport = ConformanceReportSummary & {
  checks: ConformanceCheck[]; rawReport?: unknown;
};

export type PlaygroundResult = {
  output: string;
  toolCalls: Array<{ name: string; arguments: unknown; result?: unknown; durationMs?: number }>;
  events: EventRecord[];
  durationMs: number;
  tokens: { input: number; output: number; total: number };
  costUsd: number;
  stopReason: string;
};

export type ConversationMessage = {
  id: string;
  sequence: number;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  durationMs?: number;
  tokens?: { input: number; output: number; total: number };
  costUsd?: number;
  toolCalls?: PlaygroundResult['toolCalls'];
  events?: EventRecord[];
  stopReason?: string;
};

export type ConversationSummary = {
  id: string;
  title: string;
  serverId: string;
  providerId: string;
  model: string;
  systemPrompt: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  totals: { tokens: { input: number; output: number; total: number }; costUsd: number; toolCalls: number; durationMs: number };
};

export type ConversationDetail = ConversationSummary & { messages: ConversationMessage[] };

export type AgentUpdate =
  | { type: 'text_delta'; delta: string }
  | { type: 'model_turn'; turn: number; usage: { input: number; output: number; total: number }; tokens: { input: number; output: number; total: number }; costUsd: number; durationMs: number }
  | { type: 'tool_call'; turn: number; call: PlaygroundResult['toolCalls'][number] }
  | { type: 'stop'; reason: string; durationMs: number };

export type SecretPurpose = 'provider-api-key' | 'provider-header' | 'mcp-header' | 'oauth-client-secret' | 'oauth-token' | 'stdio-env';
export type SecretMetadata = {
  id: string;
  label: string;
  backend: 'encrypted-file' | 'session';
  purposes: SecretPurpose[];
  configured: boolean;
  createdAt: string;
  updatedAt: string;
};
export type VaultStatus = {
  state: 'empty' | 'ready' | 'missing-key' | 'invalid-key' | 'insecure-permissions' | 'corrupt';
  keyLocation: string;
};

export type Bootstrap = {
  servers: ServerSummary[];
  providers: ProviderSummary[];
  suites: string[];
  runs: Run[];
  conformanceReports: ConformanceReportSummary[];
};
