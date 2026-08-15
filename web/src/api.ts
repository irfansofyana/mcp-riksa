import type { AgentUpdate, Bootstrap, ConformanceReport, ConformanceReportSummary, ConversationDetail, ConversationSummary, PlaygroundResult, Run, SecretMetadata, SecretPurpose, SuiteDetail, VaultStatus } from './types.js';

let sessionToken = '';

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const value = text ? JSON.parse(text) as unknown : undefined;
  if (!response.ok) {
    const message = value && typeof value === 'object' && 'error' in value ? String((value as { error: unknown }).error) : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return value as T;
}

export async function get<T>(path: string): Promise<T> {
  return parse<T>(await fetch(path));
}

export async function post<T>(path: string, body: unknown): Promise<T> {
  return parse<T>(await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workbench-session': sessionToken },
    body: JSON.stringify(body),
  }));
}

export async function put<T>(path: string, body: unknown): Promise<T> {
  return parse<T>(await fetch(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-workbench-session': sessionToken },
    body: JSON.stringify(body),
  }));
}

export async function remove<T>(path: string): Promise<T> {
  return parse<T>(await fetch(path, {
    method: 'DELETE',
    headers: { 'x-workbench-session': sessionToken },
  }));
}

async function streamPlayground(
  body: unknown,
  onUpdate: (update: AgentUpdate) => void,
  signal?: AbortSignal,
): Promise<{ conversationId: string; result: PlaygroundResult; conversation: ConversationDetail }> {
  const response = await fetch('/api/playground/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workbench-session': sessionToken },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok || !response.body) return parse(response);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed: { conversationId: string; result: PlaygroundResult; conversation: ConversationDetail } | undefined;
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      let eventName = 'message';
      const data: string[] = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (data.length === 0) continue;
      const payload = JSON.parse(data.join('\n')) as unknown;
      if (eventName === 'update') onUpdate(payload as AgentUpdate);
      if (eventName === 'done') completed = payload as typeof completed;
      if (eventName === 'error') {
        const message = payload && typeof payload === 'object' && 'error' in payload ? String((payload as { error: unknown }).error) : 'Playground stream failed';
        throw new Error(message);
      }
    }
    if (done) break;
  }
  if (!completed) throw new Error('Playground stream ended before completion');
  return completed;
}

export async function initialize(): Promise<Bootstrap> {
  const [session, bootstrap] = await Promise.all([
    get<{ sessionToken: string }>('/api/session'),
    get<Bootstrap>('/api/bootstrap'),
  ]);
  sessionToken = session.sessionToken;
  return bootstrap;
}

export const api = {
  refresh: () => get<Bootstrap>('/api/bootstrap'),
  settings: () => get<{ providers: Bootstrap['providers']; callbackUrl: string; loopbackOnly: boolean }>('/api/settings'),
  secrets: () => get<SecretMetadata[]>('/api/secrets'),
  createSecret: (value: { backend: 'vault' | 'session'; label: string; purposes: SecretPurpose[]; value: string }) => post<SecretMetadata>('/api/secrets', value),
  replaceSecret: (id: string, value: string) => put<SecretMetadata>(`/api/secrets/${encodeURIComponent(id)}/value`, { value }),
  deleteSecret: (id: string, force = false) => remove<{ id: string; deleted: boolean }>(`/api/secrets/${encodeURIComponent(id)}?force=${force}`),
  vaultStatus: () => get<VaultStatus>('/api/secrets/vault/status'),
  resetVault: (force = false) => post<{ reset: boolean }>('/api/secrets/vault/reset', { confirm: 'RESET', force }),
  addProvider: (value: unknown) => post('/api/providers', value),
  updateProvider: (id: string, value: unknown) => put(`/api/providers/${encodeURIComponent(id)}`, value),
  deleteProvider: (id: string, force = false) => remove(`/api/providers/${encodeURIComponent(id)}?force=${force}`),
  testProvider: (id: string) => post<{ ok: boolean; models: string[] }>(`/api/providers/${encodeURIComponent(id)}/test`, {}),
  addServer: (value: unknown) => post('/api/servers', value),
  updateServer: (id: string, value: unknown) => put(`/api/servers/${encodeURIComponent(id)}`, value),
  deleteServer: (id: string, force = false) => remove(`/api/servers/${encodeURIComponent(id)}?force=${force}`),
  connectServer: (id: string) => post(`/api/servers/${encodeURIComponent(id)}/connect`, {}),
  disconnectServer: (id: string) => post(`/api/servers/${encodeURIComponent(id)}/disconnect`, {}),
  inspectServer: (id: string) => get<{ id: string; identity: unknown; capabilities: unknown; tools: import('./types.js').Tool[] }>(`/api/servers/${encodeURIComponent(id)}`),
  callTool: (id: string, body: unknown) => post(`/api/servers/${encodeURIComponent(id)}/call`, body),
  beginOAuth: (id: string) => post<{ id: string; authorizationUrl?: string; state: string; scopes: string[]; timeline: unknown[]; expiresAt?: string }>(`/api/servers/${encodeURIComponent(id)}/oauth/begin`, {}),
  oauthStatus: (id: string) => get<{ id: string; state: string; scopes: string[]; timeline: unknown[]; expiresAt?: string }>(`/api/servers/${encodeURIComponent(id)}/oauth`),
  forgetOAuth: (id: string) => post(`/api/servers/${encodeURIComponent(id)}/oauth/forget`, {}),
  playground: (body: unknown) => post<PlaygroundResult>('/api/playground', body),
  conversations: () => get<ConversationSummary[]>('/api/playground/conversations'),
  conversation: (id: string) => get<ConversationDetail>(`/api/playground/conversations/${encodeURIComponent(id)}`),
  createConversation: (body: { serverId: string; providerId: string; model: string; systemPrompt?: string }) => post<ConversationDetail>('/api/playground/conversations', body),
  deleteConversation: (id: string) => remove<{ id: string; deleted: boolean }>(`/api/playground/conversations/${encodeURIComponent(id)}`),
  invokePlaygroundTool: (id: string, tool: string, body: { arguments: Record<string, unknown>; confirmDangerous: boolean }) => post<{ conversationId: string; prompt: string; result: PlaygroundResult; conversation: ConversationDetail }>(`/api/playground/conversations/${encodeURIComponent(id)}/tools/${encodeURIComponent(tool)}`, body),
  streamPlayground,
  saveSuite: (source: string) => post<{ name: string; cases: number }>('/api/suites', { source }),
  updateSuite: (name: string, source: string) => put<{ name: string; previousName: string; cases: number; renamed: boolean }>(`/api/suites/${encodeURIComponent(name)}`, { source }),
  deleteSuite: (name: string) => remove<{ name: string; deleted: boolean }>(`/api/suites/${encodeURIComponent(name)}`),
  listSuites: () => get<string[]>('/api/suites'),
  suite: (name: string) => get<SuiteDetail>(`/api/suites/${encodeURIComponent(name)}`),
  runSuite: (name: string) => post<{ id: string; status: string }>(`/api/suites/${encodeURIComponent(name)}/run`, {}),
  listRuns: () => get<Run[]>('/api/runs'),
  run: (id: string) => get<Run>(`/api/runs/${encodeURIComponent(id)}`),
  cancelRun: (id: string) => post(`/api/runs/${encodeURIComponent(id)}/cancel`, {}),
  compare: (a: string, b: string) => get<Record<string, number | string>>(`/api/compare?runA=${encodeURIComponent(a)}&runB=${encodeURIComponent(b)}`),
  startConformance: (body: { serverId: string; selection: { kind: 'suite'; suite: 'active' } | { kind: 'scenario'; scenario: string }; timeoutMs: number }) => post<{ id: string; status: 'running'; runnerVersion: string }>('/api/conformance', body),
  conformanceReports: (serverId?: string) => get<ConformanceReportSummary[]>(`/api/conformance${serverId ? `?serverId=${encodeURIComponent(serverId)}` : ''}`),
  conformanceReport: (id: string) => get<ConformanceReport>(`/api/conformance/${encodeURIComponent(id)}`),
  cancelConformance: (id: string) => post<{ id: string; cancelled: boolean }>(`/api/conformance/${encodeURIComponent(id)}/cancel`, {}),
};
