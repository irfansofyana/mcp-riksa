import type { Bootstrap, Run } from './types.js';

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
  addProvider: (value: unknown) => post('/api/providers', value),
  testProvider: (id: string) => post<{ ok: boolean; models: string[] }>(`/api/providers/${encodeURIComponent(id)}/test`, {}),
  addServer: (value: unknown) => post('/api/servers', value),
  connectServer: (id: string) => post(`/api/servers/${encodeURIComponent(id)}/connect`, {}),
  inspectServer: (id: string) => get<{ identity: unknown; capabilities: unknown; tools: import('./types.js').Tool[] }>(`/api/servers/${encodeURIComponent(id)}`),
  callTool: (id: string, body: unknown) => post(`/api/servers/${encodeURIComponent(id)}/call`, body),
  beginOAuth: (id: string) => post<{ authorizationUrl?: string; state: string }>(`/api/servers/${encodeURIComponent(id)}/oauth/begin`, {}),
  oauthStatus: (id: string) => get<{ state: string; scopes: string[]; timeline: unknown[] }>(`/api/servers/${encodeURIComponent(id)}/oauth`),
  forgetOAuth: (id: string) => post(`/api/servers/${encodeURIComponent(id)}/oauth/forget`, {}),
  playground: (body: unknown) => post<{ output: string; toolCalls: unknown[]; events: import('./types.js').EventRecord[]; tokens: { total: number }; costUsd: number; stopReason: string }>('/api/playground', body),
  saveSuite: (source: string) => post<{ name: string; cases: number }>('/api/suites', { source }),
  listSuites: () => get<string[]>('/api/suites'),
  runSuite: (name: string) => post<{ id: string; status: string }>(`/api/suites/${encodeURIComponent(name)}/run`, {}),
  listRuns: () => get<Run[]>('/api/runs'),
  run: (id: string) => get<Run>(`/api/runs/${encodeURIComponent(id)}`),
  cancelRun: (id: string) => post(`/api/runs/${encodeURIComponent(id)}/cancel`, {}),
  compare: (a: string, b: string) => get<Record<string, number | string>>(`/api/compare?runA=${encodeURIComponent(a)}&runB=${encodeURIComponent(b)}`),
};
