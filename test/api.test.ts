import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createApp, type ApiRuntime } from '../src/server/app.js';
import { WorkbenchError } from '../src/server/errors.js';

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
    createProvider: async (value) => { calls.push({ method: 'createProvider', value }); return { id: 'local' }; },
    updateProvider: async (id, value) => { calls.push({ method: 'updateProvider', value: { id, value } }); return { id }; },
    deleteProvider: async (id, force) => { calls.push({ method: 'deleteProvider', value: { id, force } }); return { id, deleted: true }; },
    testProvider: async (id) => ({ id, ok: true, models: ['test-model'] }),
    createServer: async (value) => { calls.push({ method: 'createServer', value }); return { id: 'sample' }; },
    updateServer: async (id, value) => { calls.push({ method: 'updateServer', value: { id, value } }); return { id }; },
    deleteServer: async (id, force) => { calls.push({ method: 'deleteServer', value: { id, force } }); return { id, deleted: true }; },
    connectServer: async (id) => ({ id, identity: { name: 'sample' }, tools: [{ name: 'add' }] }),
    inspectServer: async (id) => ({ id, identity: { name: 'sample' }, tools: [{ name: 'add' }] }),
    callTool: async (id, tool, args, options) => ({ id, tool, args, options, structuredContent: { sum: 5 } }),
    playground: async () => ({ output: '5', toolCalls: [{ name: 'add' }], events: [] }),
    createConversation: async (value) => ({ id: 'conversation-1', title: 'New conversation', messages: [], ...value }),
    listConversations: async () => [{ id: 'conversation-1', title: 'Add numbers', messageCount: 2 }],
    getConversation: async (id) => id === 'conversation-1' ? { id, title: 'Add numbers', messages: [] } : undefined,
    deleteConversation: async () => true,
    streamPlayground: async (_value, onUpdate) => {
      onUpdate({ type: 'text_delta', turn: 1, delta: '5' });
      return { conversationId: 'conversation-1', result: { output: '5', tokens: { total: 2 } } };
    },
    invokePlaygroundTool: async (id, tool, args, confirmDangerous) => ({ conversationId: id, prompt: `Execute ${tool}\n\nArguments:\n${JSON.stringify(args, null, 2)}`, result: { output: { sum: 5 }, toolCalls: [{ name: tool, arguments: args }] }, confirmDangerous }),
    saveSuite: async (source) => { calls.push({ method: 'saveSuite', value: source }); return { name: 'sample' }; },
    createSuite: async (source) => { calls.push({ method: 'createSuite', value: source }); return { name: 'sample', cases: 1 }; },
    updateSuite: async (name, source) => { calls.push({ method: 'updateSuite', value: { name, source } }); return { name: 'renamed', previousName: name, cases: 1, renamed: true }; },
    deleteSuite: async (name) => { calls.push({ method: 'deleteSuite', value: name }); return { name, deleted: true }; },
    listSuites: async () => ['sample'],
    getSuite: async (name) => name === 'sample' ? {
      name,
      source: 'version: 1\nname: sample\ncases: []\n',
      suite: { version: 1, name, cases: [] },
    } : undefined,
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
  test('maps typed configuration conflicts and missing resources to actionable status codes', async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const base = runtime();
    const app = createApp({
      ...base,
      createProvider: async () => { throw new WorkbenchError('already exists', 409); },
      updateServer: async () => { throw new WorkbenchError('not found', 404); },
    }, { sessionToken: 'test-session' });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('API failed to bind');
    origin = `http://127.0.0.1:${address.port}`;
    expect((await request('/api/providers', mutation({ id: 'x', name: 'X', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:4000/v1', models: { default: 'x' }, headerEnv: {}, pricing: { inputPerMillion: 0, outputPerMillion: 0 } }))).status).toBe(409);
    expect((await request('/api/servers/missing', { ...mutation({ id: 'missing', name: 'Missing', transport: 'stdio', command: 'node', args: [], envRefs: {} }), method: 'PUT' })).status).toBe(404);
  });

  test('routes server registration, inspection, direct calls, playground, suites, runs, trace and compare', async () => {
    expect((await request('/api/providers', mutation({
      id: 'local', name: 'Local', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:4000/v1',
      models: { default: 'test-model' }, apiKeyEnv: 'SAFE_ENV_NAME', headerEnv: {},
      pricing: { inputPerMillion: 0, outputPerMillion: 0 },
    }))).status).toBe(201);
    expect((await request('/api/providers/local', { ...mutation({ id: 'local', name: 'Updated', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:4000/v1', models: { fast: 'small', quality: 'large' }, headerEnv: {}, pricing: { inputPerMillion: 0, outputPerMillion: 0 } }), method: 'PUT' })).status).toBe(200);
    expect((await request('/api/providers/local/test', mutation({}))).status).toBe(200);
    expect((await request('/api/servers', mutation({
      id: 'sample', name: 'Sample', transport: 'stdio', command: process.execPath, args: [], envRefs: {},
    }))).status).toBe(201);
    expect((await request('/api/servers/sample', { ...mutation({ id: 'sample', name: 'Updated', transport: 'stdio', command: process.execPath, args: [], envRefs: {} }), method: 'PUT' })).status).toBe(200);
    expect((await request('/api/servers/sample/connect', mutation({}))).status).toBe(200);
    expect((await request('/api/servers/sample')).status).toBe(200);

    const tool = await request('/api/servers/sample/call', mutation({ tool: 'add', arguments: { a: 2, b: 3 }, confirmDangerous: false }));
    expect(await tool.json()).toMatchObject({ structuredContent: { sum: 5 } });
    expect((await request('/api/playground', mutation({ prompt: 'add' }))).status).toBe(200);
    expect((await request('/api/playground/conversations', mutation({ serverId: 'sample', providerId: 'local', model: 'default', systemPrompt: 'Use tools accurately.' }))).status).toBe(201);
    expect((await request('/api/playground/conversations')).status).toBe(200);
    expect((await request('/api/playground/conversations/conversation-1')).status).toBe(200);
    const stream = await request('/api/playground/stream', mutation({ conversationId: 'conversation-1', prompt: 'add' }));
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    expect(await stream.text()).toContain('text_delta');
    expect(await (await request('/api/playground/conversations/conversation-1/tools/add', mutation({ arguments: { a: 2, b: 3 }, confirmDangerous: false }))).json()).toMatchObject({ prompt: expect.stringContaining('Execute add'), result: { output: { sum: 5 } } });
    expect((await request('/api/suites', mutation({ source: 'version: 1' }))).status).toBe(201);
    expect(calls).toContainEqual({ method: 'createSuite', value: 'version: 1' });
    expect((await request('/api/suites')).status).toBe(200);
    expect(await (await request('/api/suites/sample')).json()).toMatchObject({
      name: 'sample', suite: { version: 1, cases: [] }, source: expect.stringContaining('name: sample'),
    });
    expect((await request('/api/suites/missing')).status).toBe(404);
    expect(await (await request('/api/suites/sample', { ...mutation({ source: 'version: 1\nname: renamed' }), method: 'PUT' })).json()).toMatchObject({ name: 'renamed', previousName: 'sample', renamed: true });
    expect((await request('/api/suites/sample', { ...mutation(undefined), method: 'DELETE', body: undefined })).status).toBe(200);
    expect(calls).toContainEqual({ method: 'deleteSuite', value: 'sample' });

    expect(await (await request('/api/suites/sample/run', mutation({}))).json()).toMatchObject({ id: 'run-1', status: 'running' });
    expect((await request('/api/runs')).status).toBe(200);
    expect(await (await request('/api/runs/run-1')).json()).toMatchObject({ id: 'run-1' });
    expect(await (await request('/api/compare?runA=run-1&runB=run-2')).json()).toMatchObject({ runA: 'run-1', runB: 'run-2' });
    expect((await request('/api/runs/run-1/cancel', mutation({}))).status).toBe(202);
    expect(calls).toContainEqual({ method: 'cancelRun', value: 'run-1' });
    expect((await request('/api/providers/local?force=true', { ...mutation(undefined), method: 'DELETE', body: undefined })).status).toBe(200);
    expect((await request('/api/servers/sample?force=true', { ...mutation(undefined), method: 'DELETE', body: undefined })).status).toBe(200);
    expect(calls).toContainEqual({ method: 'deleteProvider', value: { id: 'local', force: true } });
    expect(calls).toContainEqual({ method: 'deleteServer', value: { id: 'sample', force: true } });
  });

  test('routes OAuth begin/status/callback/forget with state handled by the coordinator', async () => {
    expect((await request('/api/servers/sample/oauth/begin', mutation({}))).status).toBe(200);
    expect((await request('/api/servers/sample/oauth')).status).toBe(200);
    const callback = await request('/api/oauth/callback?code=code-value&state=state-value');
    expect(callback.status).toBe(200);
    expect(await callback.json()).toMatchObject({ id: 'sample', state: 'authorized' });
    expect(calls).toContainEqual({ method: 'oauthCallback', value: { code: 'code-value', state: 'state-value' } });

    const browserCallback = await request('/api/oauth/callback?code=browser-code&state=browser-state', { headers: { accept: 'text/html' } });
    expect(browserCallback.headers.get('content-type')).toContain('text/html');
    const html = await browserCallback.text();
    expect(html).toContain('workbench:oauth');
    expect(html).toContain('window.close');
    expect(html).not.toContain('browser-code');
    expect((await request('/api/servers/sample/oauth/forget', mutation({}))).status).toBe(204);
  });
});
