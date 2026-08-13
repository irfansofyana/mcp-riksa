export type Tool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { destructiveHint?: boolean };
};

export type ServerSummary = {
  id: string; name: string; transport: 'stdio' | 'http'; connected?: boolean; url?: string; oauth?: unknown;
};

export type ProviderSummary = {
  id: string; name: string; type: string; baseUrl: string; models: Record<string, string>;
  apiKeyEnv?: string; apiKeyConfigured?: boolean; pricing?: { inputPerMillion: number; outputPerMillion: number };
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

export type Bootstrap = {
  servers: ServerSummary[];
  providers: ProviderSummary[];
  suites: string[];
  runs: Run[];
};
