export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type Limits = {
  maxTurns: number;
  maxToolCalls: number;
  timeoutMs: number;
  maxCostUsd?: number;
};

export type Assertion =
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

type BaseCase = {
  id: string;
  server: string;
  assertions: Assertion[];
};

export type DirectCase = BaseCase & {
  kind: 'direct';
  call: { tool: string; arguments: Record<string, JsonValue>; dangerous?: boolean };
};

export type AgentCase = BaseCase & {
  kind: 'agent';
  provider: string;
  model: string;
  prompt: string;
  limits: Limits;
};

export type Suite = {
  version: 1;
  name: string;
  description?: string;
  cases: Array<DirectCase | AgentCase>;
};

export type ToolCallObservation = {
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  durationMs?: number;
};

export type NormalizedEvent = {
  id: string;
  caseId: string;
  type: 'case_started' | 'model_turn' | 'tool_call' | 'tool_result' | 'assertion' | 'stop' | 'case_completed' | 'error' | 'oauth';
  timestamp: string;
  durationMs?: number;
  data: unknown;
  sanitized: true;
};

export type Observation = {
  output: unknown;
  toolCalls: ToolCallObservation[];
  durationMs: number;
  tokens: { input: number; output: number; total: number };
  costUsd: number;
  events: NormalizedEvent[];
  stopReason?: string;
};

export type AssertionResult = {
  assertion: Assertion;
  passed: boolean;
  message: string;
  expected?: unknown;
  actual?: unknown;
};

export type CaseResult = {
  id: string;
  kind: 'direct' | 'agent';
  status: 'passed' | 'failed' | 'cancelled';
  observation: Observation;
  assertions: AssertionResult[];
  error?: string;
};

export type RunResult = {
  id: string;
  suite: string;
  status: 'passed' | 'failed' | 'cancelled' | 'interrupted';
  startedAt: string;
  completedAt: string;
  summary: { total: number; passed: number; failed: number; passRate: number };
  cases: CaseResult[];
  events: NormalizedEvent[];
};
