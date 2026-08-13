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
  | { type: 'cost'; maxUsd: number };

export type SuiteLimits = { maxTurns: number; maxToolCalls: number; timeoutMs: number; maxCostUsd?: number };
export type DirectSuiteCase = {
  id: string; kind: 'direct'; server: string;
  call: { tool: string; arguments: Record<string, JsonValue>; dangerous?: boolean };
  assertions: SuiteAssertion[];
};
export type AgentSuiteCase = {
  id: string; kind: 'agent'; server: string; provider: string; model: string; prompt: string;
  limits: SuiteLimits; assertions: SuiteAssertion[];
};
export type SuiteCase = DirectSuiteCase | AgentSuiteCase;
export type SuiteDraft = { version: 1; name: string; description?: string; cases: SuiteCase[] };
export type SuiteDetail = { name: string; source: string; suite: SuiteDraft };

export type Tool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { destructiveHint?: boolean };
};

export type ServerSummary = {
  id: string;
  name: string;
  connected?: boolean;
} & (
  | { transport: 'stdio'; command: string; args: string[]; cwd?: string; envRefs: Record<string, string> }
  | { transport: 'http'; url: string; headerEnv: Record<string, string>; allowUnsafeEndpoint: boolean; oauth?: { scopes: string[]; clientId?: string; clientSecretEnv?: string; timeoutMs: number } }
);

export type ProviderSummary = {
  id: string; name: string; type: 'openai-compatible' | 'anthropic-compatible'; baseUrl: string; models: Record<string, string>;
  apiKeyEnv?: string; apiKeyConfigured?: boolean; headerEnv?: Record<string, string>;
  pricing?: { inputPerMillion: number; outputPerMillion: number };
};

export type EventRecord = {
  id: string; caseId: string; type: string; timestamp: string; durationMs?: number; data: unknown; sanitized: true;
};

export type CaseResult = {
  id: string; kind: string; status: string; error?: string;
  observation: {
    output: unknown; toolCalls: Array<{ name: string; arguments: unknown; result?: unknown; durationMs?: number }>;
    durationMs: number; tokens: { input: number; output: number; total: number }; costUsd: number;
    events: EventRecord[]; stopReason?: string;
  };
  assertions: Array<{ passed: boolean; message: string; expected?: unknown; actual?: unknown; assertion: { type: string; [key: string]: unknown } }>;
};

export type Run = {
  id: string; suite: string; status: string; startedAt: string; completedAt: string;
  summary: { total: number; passed: number; failed: number; passRate: number };
  cases: CaseResult[]; events: EventRecord[];
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
  | { type: 'text_delta'; turn: number; delta: string }
  | { type: 'model_turn'; turn: number; usage: { input: number; output: number; total: number }; tokens: { input: number; output: number; total: number }; costUsd: number; durationMs: number }
  | { type: 'tool_call'; turn: number; call: PlaygroundResult['toolCalls'][number] }
  | { type: 'stop'; reason: string; durationMs: number };

export type Bootstrap = {
  servers: ServerSummary[];
  providers: ProviderSummary[];
  suites: string[];
  runs: Run[];
};
