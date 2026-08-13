import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createApp, type ApiRuntime } from '../src/server/app.js';

let origin: string;
let server: ReturnType<typeof createServer>;
let calls: Array<{ method: string; value?: unknown }>;

const run = {
  id: 'run-1', suite: 'sample', status: 'passed',
  startedAt: '2026-08-13T00:00:00.000Z', completedAt: '2026-08-13T00:00:01.000Z',
  summary: { total: 1, passed: 1, failed: 0, passRate: 1 }, cases: [], events: [],
};

function runtime(): ApiRuntime {
  return {
    bootstrap: async () => ({ servers: [], providers: [], suites: ['sample'], runs: [run] }),
    settings: async () => ({ providers: [{ id: 'local', apiKey: 'api-response-secret', apiKeyEnv: 'SAFE_ENV_NAME' }] }),
    addProvider: async (value) => { calls.push({ method: 'addProvider', value }); return { id: 'local' }; },
    testProvider: async (id) => ({ id, ok: true, models: ['test-model'] }),
    addServer: async (value) => { calls.push({ method: 'addServer', value }); return { id: 'sample' }; },
    connectServer: async (id) => ({ id, identity: { name: 'sample' }, tools: [{ name: 'add' }] }),
    inspectServer: async (id) => ({ id, identity: { name: 'sample' }, tools: [{ name: 'add' }] }),
    callTool: async (id, tool, args, options) => ({ id, tool, args, options, structuredContent: { sum: 5 } }),
    playground: async () => ({ output: '5', toolCalls: [{ name: 'add' }], events: [] }),
    saveSuite: async (source) => { calls.push({ method: 'saveSuite', value: source }); return { name: 'sample' }; },
    listSuites: async () => ['sample'],
    startSuite: async (name) => ({ id: 'run-1', suite: name, status: 'running' }),
    listRuns: async () => [run],
    getRun: async (id) => id === 'run-1' ? run : undefined,
    cancelRun: async (id) => { calls.push({ method: 'cancelRun', value: id }); return true; },
    compareRuns: async (a, b) => ({ runA: a, runB: b, passRateDelta: 0 }),
    beginOAuth: async (id) => ({ id, state: 'authorizing', authorizationUrl: `${origin}/authorize?state=secret-state`, scopes: [], timeline: [] }),
    oauthCallback: async (parameters) => { calls.push({ method: 'oauthCallback', value: parameters }); return { id: 'sample', state: 'authorized', scopes: ['mcp:read'], timeline: [] }; },
    oauthStatus: async (id) => ({ id, state: 'authorized', scopes: ['mcp:read'], timeline: [] }),
    forgetOAuth: async (id) => { calls.push({ method: 'forgetOAuth', value: id }); },
    close: async () => undefined,
  };
}

beforeEach(async () => {
  calls = [];
  const app = createApp(runtime(), { sessionToken: 'test-session' });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('API failed to bind');
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function request(path: string, init: RequestInit = {}) {
  return fetch(`${origin}${path}`, init);
}

function mutation(body: unknown, extra: HeadersInit = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, 'x-workbench-session': 'test-session', ...extra },
    body: JSON.stringify(body),
  };
}

describe('API security boundary', () => {
  test('issues the per-start session token only from loopback', async () => {
    const response = await request('/api/session');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sessionToken: 'test-session' });
  });

  test('rejects external origins and invalid session tokens on mutations', async () => {
    const external = await request('/api/providers', mutation({ id: 'local' }, { origin: 'https://evil.example' }));
    expect(external.status).toBe(403);
    const invalid = await request('/api/providers', mutation({ id: 'local' }, { 'x-workbench-session': 'wrong' }));
    expect(invalid.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test('redacts secrets from settings and errors even if the runtime leaks one', async () => {
    const response = await request('/api/settings');
    const text = await response.text();
    expect(text).not.toContain('api-response-secret');
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('SAFE_ENV_NAME');
  });
});

describe('API workbench flow', () => {
  test('routes server registration, inspection, direct calls, playground, suites, runs, trace and compare', async () => {
    expect((await request('/api/providers', mutation({
      id: 'local', name: 'Local', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:4000/v1',
      models: { default: 'test-model' }, apiKeyEnv: 'SAFE_ENV_NAME', headerEnv: {},
      pricing: { inputPerMillion: 0, outputPerMillion: 0 },
    }))).status).toBe(201);
    expect((await request('/api/providers/local/test', mutation({}))).status).toBe(200);
    expect((await request('/api/servers', mutation({
      id: 'sample', name: 'Sample', transport: 'stdio', command: process.execPath, args: [], envRefs: {},
    }))).status).toBe(201);
    expect((await request('/api/servers/sample/connect', mutation({}))).status).toBe(200);
    expect((await request('/api/servers/sample')).status).toBe(200);

    const tool = await request('/api/servers/sample/call', mutation({ tool: 'add', arguments: { a: 2, b: 3 }, confirmDangerous: false }));
    expect(await tool.json()).toMatchObject({ structuredContent: { sum: 5 } });
    expect((await request('/api/playground', mutation({ prompt: 'add' }))).status).toBe(200);
    expect((await request('/api/suites', mutation({ source: 'version: 1' }))).status).toBe(201);
    expect((await request('/api/suites')).status).toBe(200);

    expect(await (await request('/api/suites/sample/run', mutation({}))).json()).toMatchObject({ id: 'run-1', status: 'running' });
    expect((await request('/api/runs')).status).toBe(200);
    expect(await (await request('/api/runs/run-1')).json()).toMatchObject({ id: 'run-1' });
    expect(await (await request('/api/compare?runA=run-1&runB=run-2')).json()).toMatchObject({ runA: 'run-1', runB: 'run-2' });
    expect((await request('/api/runs/run-1/cancel', mutation({}))).status).toBe(202);
    expect(calls).toContainEqual({ method: 'cancelRun', value: 'run-1' });
  });

  test('routes OAuth begin/status/callback/forget with state handled by the coordinator', async () => {
    expect((await request('/api/servers/sample/oauth/begin', mutation({}))).status).toBe(200);
    expect((await request('/api/servers/sample/oauth')).status).toBe(200);
    const callback = await request('/api/oauth/callback?code=code-value&state=state-value');
    expect(callback.status).toBe(200);
    expect(calls).toContainEqual({ method: 'oauthCallback', value: { code: 'code-value', state: 'state-value' } });
    expect((await request('/api/servers/sample/oauth/forget', mutation({}))).status).toBe(204);
  });
});
