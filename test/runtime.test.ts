import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { ConformanceRunner } from '../src/conformance/types.js';
import { WorkbenchRuntime } from '../src/server/runtime.js';

const directories: string[] = [];
const tsxCli = resolve('node_modules/tsx/dist/cli.mjs');
const sampleServer = resolve('examples/sample-mcp-server.ts');

const model = (id: string, inputPerMillion = 0, outputPerMillion = 0) => ({
  id,
  pricing: { inputPerMillion, outputPerMillion },
});

function createRuntime(conformanceRunner?: ConformanceRunner) {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-runtime-'));
  directories.push(directory);
  const databasePath = join(directory, 'workbench.db');
  const runtime = new WorkbenchRuntime({
    databasePath,
    suiteDirectory: join(directory, 'suites'),
    callbackUrl: 'http://127.0.0.1:4317/api/oauth/callback',
    ...(conformanceRunner ? { conformanceRunner } : {}),
  });
  return { runtime, databasePath, directory };
}

afterEach(async () => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  delete process.env.RUNTIME_PROVIDER_SECRET;
});

const suite = `
version: 1
name: sample-direct
cases:
  - id: adds
    kind: direct
    server: sample
    call:
      tool: add
      arguments: { a: 2, b: 3 }
    assertions:
      - type: tool_called
        tool: add
      - type: jsonpath
        path: $.sum
        equals: 5
`;

async function waitForRun(runtime: WorkbenchRuntime, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await runtime.getRun(id) as { status?: string } | undefined;
    if (value && value.status !== 'running') return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error('Run did not complete');
}

async function waitForConformance(runtime: WorkbenchRuntime, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await runtime.getConformanceReport(id);
    if (value && value.status !== 'running') return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error('Conformance report did not complete');
}

describe('concrete workbench runtime', () => {
  test('runs HTTP conformance with config locking, cancellation and transport safety', async () => {
    const runner: ConformanceRunner = {
      run: async (_input, signal) => new Promise((resolveRun) => signal.addEventListener('abort', () => resolveRun({ checks: [], rawReport: {}, exitCode: null, timedOut: false, cancelled: true }), { once: true })),
    };
    const { runtime } = createRuntime(runner);
    await runtime.addServer({ id: 'http', name: 'HTTP', transport: 'http', url: 'http://127.0.0.1:3000/mcp', headerEnv: {}, headers: {}, allowUnsafeEndpoint: false });
    await runtime.addServer({ id: 'stdio', name: 'Stdio', transport: 'stdio', command: process.execPath, args: [], envRefs: {}, env: {} });
    await expect(runtime.startConformance({ serverId: 'stdio', selection: { kind: 'suite', suite: 'active' }, timeoutMs: 30_000 })).rejects.toMatchObject({ status: 400 });
    const started = await runtime.startConformance({ serverId: 'http', selection: { kind: 'scenario', scenario: 'server-initialize' }, timeoutMs: 30_000 });
    await expect(runtime.updateServer('http', { id: 'http', name: 'Changed', transport: 'http', url: 'http://127.0.0.1:3000/mcp', headerEnv: {}, headers: {}, allowUnsafeEndpoint: false })).rejects.toMatchObject({ status: 409 });
    expect(await runtime.cancelConformance(started.id)).toBe(true);
    expect(await waitForConformance(runtime, started.id)).toMatchObject({ status: 'cancelled', runnerVersion: '0.1.10', selection: { scenario: 'server-initialize' } });
    expect(await runtime.listConformanceReports('http')).toHaveLength(1);
    await runtime.addServer({ id: 'query-secret', name: 'Query secret', transport: 'http', url: 'http://127.0.0.1:3000/mcp?access_token=secret', headerEnv: {}, headers: {}, allowUnsafeEndpoint: false });
    await expect(runtime.startConformance({ serverId: 'query-secret', selection: { kind: 'suite', suite: 'active' }, timeoutMs: 30_000 })).rejects.toMatchObject({ status: 400 });
    await runtime.addServer({ id: 'remote', name: 'Remote', transport: 'http', url: 'https://example.com/mcp', headerEnv: {}, headers: {}, allowUnsafeEndpoint: false });
    await expect(runtime.startConformance({ serverId: 'remote', selection: { kind: 'suite', suite: 'active' }, timeoutMs: 30_000 })).rejects.toMatchObject({ status: 400 });
    await runtime.addServer({ id: 'secret-header', name: 'Secret header', transport: 'http', url: 'http://127.0.0.1:3000/mcp', headerEnv: {}, headers: { Authorization: { source: 'env', name: 'RUNTIME_PROVIDER_SECRET' } }, allowUnsafeEndpoint: false });
    await expect(runtime.startConformance({ serverId: 'secret-header', selection: { kind: 'suite', suite: 'active' }, timeoutMs: 30_000 })).rejects.toMatchObject({ status: 400 });
    await runtime.addServer({ id: 'static-auth', name: 'Static auth', transport: 'http', url: 'http://127.0.0.1:3000/mcp', headerEnv: {}, headers: {}, staticAuth: { header: 'Authorization', scheme: 'Bearer', credential: { source: 'env', name: 'RUNTIME_PROVIDER_SECRET' } }, allowUnsafeEndpoint: false });
    await expect(runtime.startConformance({ serverId: 'static-auth', selection: { kind: 'suite', suite: 'active' }, timeoutMs: 30_000 })).rejects.toMatchObject({ status: 400 });
    await expect(runtime.beginOAuth('http')).rejects.toMatchObject({ status: 400 });
    await expect(runtime.beginOAuth('static-auth')).rejects.toMatchObject({ status: 400 });
    await runtime.close();
  });

  test('rejects a conformance start that is still validating when shutdown begins', async () => {
    const runner: ConformanceRunner = {
      run: async () => ({ checks: [], rawReport: {}, exitCode: 0, timedOut: false, cancelled: false }),
    };
    const { runtime } = createRuntime(runner);
    await runtime.addServer({
      id: 'http', name: 'HTTP', transport: 'http', url: 'http://127.0.0.1:3000/mcp',
      headerEnv: {}, headers: {}, allowUnsafeEndpoint: false,
    });

    const starting = runtime.startConformance({
      serverId: 'http', selection: { kind: 'scenario', scenario: 'server-initialize' }, timeoutMs: 30_000,
    });
    await runtime.close();
    await expect(starting).rejects.toMatchObject({ status: 409 });
  });

  test('blocks referenced secret deletion unless explicitly forced', async () => {
    const { runtime } = createRuntime();
    const secret = await runtime.createSecret({ backend: 'session', label: 'Provider key', purposes: ['provider-api-key'], value: 'session-only-value' });
    await runtime.addProvider({
      id: 'secret-provider', name: 'Secret provider', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:4000/v1',
      models: { default: model('test') }, apiKey: { source: 'session', id: secret.id }, headerEnv: {}, headers: {},
    });
    await expect(runtime.deleteSecret(secret.id)).rejects.toMatchObject({ status: 409 });
    await expect(runtime.deleteSecret(secret.id, true)).resolves.toMatchObject({ deleted: true, forced: true });
    const danglingProvider = {
      id: 'dangling-provider', name: 'Dangling provider', type: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:4012/v1',
      apiKeyEnv: undefined, apiKey: { source: 'session' as const, id: secret.id }, headerEnv: {}, headers: {}, models: { default: { id: 'fake-model', pricing: { inputPerMillion: 0, outputPerMillion: 0 } } },
    };
    await expect(runtime.createProvider(danglingProvider)).rejects.toMatchObject({ status: 409 });
    await expect(runtime.seedProvider({ ...danglingProvider, id: 'dangling-seed' })).rejects.toMatchObject({ status: 409 });
    await runtime.addServer({ id: 'seed-tombstone', name: 'Seed tombstone', transport: 'stdio', command: process.execPath, args: [tsxCli, sampleServer], envRefs: {}, env: {} });
    await runtime.deleteServer('seed-tombstone', true);
    await expect(runtime.seedServer({
      id: 'seed-tombstone', name: 'Ignored seed', transport: 'stdio', command: process.execPath, args: [tsxCli, sampleServer], envRefs: {},
      env: { TOKEN: { source: 'session', id: 'secret_00000000-0000-4000-8000-000000000000' } },
    })).resolves.toBe(false);
    const wrongPurpose = await runtime.createSecret({ backend: 'session', label: 'Header only', purposes: ['mcp-header'], value: 'wrong-purpose-value' });
    await expect(runtime.createProvider({
      ...danglingProvider, id: 'wrong-purpose-provider', apiKey: { source: 'session', id: wrongPurpose.id },
    })).rejects.toMatchObject({ status: 409 });
    await runtime.deleteSecret(wrongPurpose.id, true);

    const connectedSecret = await runtime.createSecret({ backend: 'session', label: 'Connected server token', purposes: ['stdio-env'], value: 'connected-session-value' });
    await runtime.addServer({
      id: 'secret-server', name: 'Secret server', transport: 'stdio', command: process.execPath,
      args: [tsxCli, sampleServer], envRefs: {}, env: { API_TOKEN: { source: 'session', id: connectedSecret.id } },
    });
    await runtime.connectServer('secret-server');
    await expect(runtime.updateServer('secret-server', {
      id: 'secret-server', name: 'Rejected update', transport: 'stdio', command: process.execPath,
      args: [tsxCli, sampleServer], envRefs: {}, env: { API_TOKEN: { source: 'session', id: 'secret_00000000-0000-4000-8000-000000000000' } },
    })).rejects.toMatchObject({ status: 409 });
    await expect(runtime.inspectServer('secret-server')).resolves.toMatchObject({ id: 'secret-server' });
    await expect(runtime.replaceSecret(connectedSecret.id, 'rotated-connected-value')).rejects.toMatchObject({ status: 409 });
    await expect(runtime.deleteSecret(connectedSecret.id, true)).rejects.toMatchObject({ status: 409 });
    await expect(runtime.disconnectServer('secret-server')).resolves.toEqual({ id: 'secret-server', connected: false });
    await expect(runtime.inspectServer('secret-server')).rejects.toMatchObject({ status: 409 });
    await expect(runtime.replaceSecret(connectedSecret.id, 'rotated-connected-value')).resolves.toMatchObject({ id: connectedSecret.id });
    await expect(runtime.deleteSecret(connectedSecret.id, true)).resolves.toMatchObject({ deleted: true });
    await runtime.close();
  });
  test('rejects OAuth reauthorization while a server call is active', async () => {
    const { runtime } = createRuntime();
    await runtime.addServer({
      id: 'oauth-active', name: 'OAuth active', transport: 'http', url: 'http://127.0.0.1:3000/mcp',
      headerEnv: {}, headers: {}, oauth: { scopes: [], timeoutMs: 30_000 }, allowUnsafeEndpoint: false,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const activeCall = runtime['withConfigUse'](['server:oauth-active'], async () => gate);

    await expect(runtime.beginOAuth('oauth-active')).rejects.toMatchObject({ status: 409 });
    release();
    await activeCall;
    await runtime.close();
  });

  test('waits for active configuration mutations before closing storage', async () => {
    const { runtime } = createRuntime();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mutation = runtime['withConfigMutation']('provider:closing-test', async () => gate);
    let closed = false;
    const closing = runtime.close().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);
    release();
    await Promise.all([mutation, closing]);
    expect(closed).toBe(true);
  });

  test('rejects credential-bearing provider URLs before seeding configuration', async () => {
    const { runtime } = createRuntime();
    await expect(runtime.seedProvider({
      id: 'credentialed', name: 'Credentialed', type: 'openai-compatible',
      baseUrl: 'http://user:password@127.0.0.1:4000/v1', models: { default: model('test') },
      headerEnv: {}, headers: {},
    })).rejects.toThrow('Credentials are not allowed');
    expect((await runtime.bootstrap() as { providers: unknown[] }).providers).toEqual([]);
    await runtime.close();
  });

  test('ignores invalid provider seeds when the ID is already stored or tombstoned', async () => {
    const invalidSeed = {
      id: 'stale', name: 'Stale config', type: 'openai-compatible' as const,
      baseUrl: 'http://user:password@127.0.0.1:4000/v1', models: { default: model('test') },
      headerEnv: {}, headers: {},
    };
    const { runtime } = createRuntime();
    await runtime.addProvider({ ...invalidSeed, name: 'Stored', baseUrl: 'http://127.0.0.1:4000/v1' });
    await expect(runtime.seedProvider(invalidSeed)).resolves.toBe(false);
    await runtime.deleteProvider('stale');
    await expect(runtime.seedProvider(invalidSeed)).resolves.toBe(false);
    expect((await runtime.bootstrap() as { providers: unknown[] }).providers).toEqual([]);
    await runtime.close();
  });

  test('resolves a configured model alias before sending a playground request upstream', async () => {
    let receivedModel = '';
    const provider = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: string };
      receivedModel = payload.model ?? '';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'alias-test', object: 'chat.completion', created: 1, model: receivedModel,
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
    await new Promise<void>((resolveListen) => provider.listen(0, '127.0.0.1', resolveListen));
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('Provider did not bind');
    const { runtime } = createRuntime();
    try {
      await runtime.addProvider({
        id: 'alias-provider', name: 'Alias provider', type: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${address.port}/v1`, models: { fast: model('upstream-model-name') }, headerEnv: {}, headers: {},
      });
      await runtime.addServer({
        id: 'sample', name: 'Sample', transport: 'stdio', command: process.execPath,
        args: [tsxCli, sampleServer], envRefs: {}, env: {},
      });
      await runtime.connectServer('sample');
      await runtime.playground({ serverId: 'sample', providerId: 'alias-provider', model: 'fast', prompt: 'Reply OK' });
      expect(receivedModel).toBe('upstream-model-name');
    } finally {
      await runtime.close();
      await new Promise<void>((resolveClose, reject) => provider.close((error) => error ? reject(error) : resolveClose()));
    }
  });

  test('streams and persists multi-turn playground conversations', async () => {
    const receivedMessages: unknown[][] = [];
    const provider = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages?: unknown[]; stream?: boolean };
      receivedMessages.push(payload.messages ?? []);
      if (JSON.stringify(payload.messages).includes('Fail')) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'provider failed' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'chunk-1', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta: { content: 'Hello ' }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: 'chunk-2', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta: { content: 'there' }, finish_reason: 'stop' }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: 'usage', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolveListen) => provider.listen(0, '127.0.0.1', resolveListen));
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('Provider did not bind');
    const { runtime } = createRuntime();
    try {
      await runtime.addProvider({ id: 'local', name: 'Local', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, models: { fast: model('test', 1, 2) }, headerEnv: {}, headers: {} });
      await runtime.addServer({ id: 'sample', name: 'Sample', transport: 'stdio', command: process.execPath, args: [tsxCli, sampleServer], envRefs: {}, env: {} });
      await runtime.connectServer('sample');
      const conversation = await runtime.createConversation({ serverId: 'sample', providerId: 'local', model: 'fast', systemPrompt: 'Use tools accurately.' });
      expect(conversation).toMatchObject({ systemPrompt: 'Use tools accurately.' });
      const deltas: string[] = [];
      await runtime.streamPlayground({ conversationId: conversation.id, prompt: 'First' }, (update) => { if (update.type === 'text_delta') deltas.push(update.delta); });
      await runtime.streamPlayground({ conversationId: conversation.id, prompt: 'Second' }, () => undefined);
      const direct = await runtime.invokePlaygroundTool(conversation.id, 'add', { a: 4, b: 5 }, false);
      expect(direct).toMatchObject({ prompt: expect.stringContaining('Execute add'), result: { output: { sum: 9 } }, conversation: { messageCount: 6 } });
      expect(direct.prompt).toContain('"a": 4');
      const detail = await runtime.getConversation(conversation.id);
      expect(deltas.join('')).toBe('Hello there');
      expect(detail).toMatchObject({ messageCount: 6, totals: { tokens: { total: 12 }, toolCalls: 1 } });
      expect(receivedMessages[0]?.[0]).toEqual({ role: 'system', content: 'Use tools accurately.' });
      expect(receivedMessages[1]).toHaveLength(4);
      expect(receivedMessages[1]?.[0]).toEqual({ role: 'system', content: 'Use tools accurately.' });
      const cancelledConversation = await runtime.createConversation({ serverId: 'sample', providerId: 'local', model: 'fast', systemPrompt: 'Use tools accurately.' });
      const controller = new AbortController();
      controller.abort(new Error('cancelled by test'));
      const cancelled = await runtime.streamPlayground(
        { conversationId: cancelledConversation.id, prompt: 'Cancelled turn' },
        () => undefined,
        controller.signal,
      );
      expect(cancelled.result).toMatchObject({ stopReason: 'cancelled', transcript: [] });
      await runtime.streamPlayground({ conversationId: cancelledConversation.id, prompt: 'After cancellation' }, () => undefined);
      expect(receivedMessages[2]).toEqual([
        { role: 'system', content: 'Use tools accurately.' },
        { role: 'user', content: 'After cancellation' },
      ]);
      await expect(runtime.streamPlayground({ conversationId: conversation.id, prompt: 'Fail' }, () => undefined)).rejects.toThrow();
      expect(await runtime.getConversation(conversation.id)).toMatchObject({ messageCount: 6 });
    } finally {
      await runtime.close();
      await new Promise<void>((resolveClose, reject) => provider.close((error) => error ? reject(error) : resolveClose()));
    }
  });

  test('creates, edits, and safely deletes multi-model providers and servers', async () => {
    const { runtime, databasePath, directory } = createRuntime();
    await runtime.createProvider({
      id: 'gateway', name: 'Gateway', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:4000/v1',
      models: { fast: model('small-model', 1, 2), quality: model('large-model', 3, 4) }, headerEnv: {}, headers: {},
    });
    await expect(runtime.createProvider({
      id: 'gateway', name: 'Duplicate', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:4000/v1',
      models: { default: model('x') }, headerEnv: {}, headers: {},
    })).rejects.toMatchObject({ status: 409 });
    await runtime.createServer({ id: 'sample', name: 'Sample', transport: 'stdio', command: process.execPath, args: [tsxCli, sampleServer], envRefs: {}, env: {} });
    await runtime.connectServer('sample');
    await runtime.forgetOAuth('sample');
    expect((await runtime.bootstrap() as { servers: Array<{ connected: boolean }> }).servers[0]?.connected).toBe(false);
    await runtime.connectServer('sample');
    const conversation = await runtime.createConversation({ serverId: 'sample', providerId: 'gateway', model: 'quality' });

    await expect(runtime.updateProvider('gateway', {
      id: 'gateway', name: 'Gateway', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:4000/v1',
      models: { fast: model('small-model', 1, 2) }, headerEnv: {}, headers: {},
    })).rejects.toMatchObject({ status: 409 });
    await runtime.updateProvider('gateway', {
      id: 'gateway', name: 'Updated Gateway', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:4000/v1',
      models: { fast: model('small-v2', 1, 2), quality: model('large-v2', 3, 4), reasoning: model('reasoner', 5, 6) }, headerEnv: {}, headers: {},
    });
    await runtime.updateServer('sample', { id: 'sample', name: 'Updated Sample', transport: 'stdio', command: process.execPath, args: [tsxCli, sampleServer], envRefs: {}, env: {} });
    expect((await runtime.bootstrap() as { servers: Array<{ id: string; connected: boolean }> }).servers[0]).toMatchObject({ id: 'sample', connected: false });
    await expect(runtime.deleteProvider('gateway')).rejects.toMatchObject({ status: 409 });
    await expect(runtime.deleteServer('sample')).rejects.toMatchObject({ status: 409 });
    expect(await runtime.deleteProvider('gateway', true)).toMatchObject({ deleted: true, forced: true });
    expect(await runtime.deleteServer('sample', true)).toMatchObject({ deleted: true, forced: true });
    expect(await runtime.getConversation(conversation.id)).toMatchObject({ providerId: 'gateway', serverId: 'sample', model: 'quality' });
    await runtime.close();

    const restored = new WorkbenchRuntime({ databasePath, suiteDirectory: join(directory, 'suites'), callbackUrl: 'http://127.0.0.1:4317/api/oauth/callback' });
    expect(await restored.seedProvider({ id: 'gateway', name: 'Seed', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:4000/v1', models: { default: model('seed') }, headerEnv: {}, headers: {} })).toBe(false);
    expect(await restored.seedServer({ id: 'sample', name: 'Seed', transport: 'stdio', command: process.execPath, args: [], envRefs: {}, env: {} })).toBe(false);
    expect((await restored.bootstrap() as { providers: unknown[]; servers: unknown[] })).toMatchObject({ providers: [], servers: [] });
    await restored.close();
  });

  test('persists only environment references and restores provider/server configuration', async () => {
    process.env.RUNTIME_PROVIDER_SECRET = 'must-never-reach-disk';
    const { runtime, databasePath, directory } = createRuntime();
    await runtime.addProvider({
      id: 'local', name: 'Local', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:4000/v1',
      models: { default: model('test') }, apiKeyEnv: 'RUNTIME_PROVIDER_SECRET', headerEnv: { 'X-Custom-Key': 'RUNTIME_PROVIDER_SECRET' }, headers: {},
    });
    await runtime.addServer({
      id: 'sample', name: 'Sample', transport: 'stdio', command: process.execPath,
      args: [tsxCli, sampleServer], envRefs: {}, env: {},
    });
    await runtime.close();

    expect(readFileSync(databasePath).toString('latin1')).not.toContain('must-never-reach-disk');
    const restored = new WorkbenchRuntime({
      databasePath, suiteDirectory: join(directory, 'suites'), callbackUrl: 'http://127.0.0.1:4317/api/oauth/callback',
    });
    const settings = await restored.settings();
    expect(settings).toMatchObject({ providers: [{
      id: 'local', apiKeyEnv: 'RUNTIME_PROVIDER_SECRET', apiKeyConfigured: true,
      headerStatus: { 'X-Custom-Key': { source: 'env', reference: 'RUNTIME_PROVIDER_SECRET', configured: true } },
    }] });
    expect((await restored.bootstrap() as { servers: unknown[] }).servers).toHaveLength(1);
    await restored.close();
  });

  test('runs a saved direct suite through the real sample MCP server and compares persisted runs', async () => {
    const { runtime } = createRuntime();
    await runtime.addServer({
      id: 'sample', name: 'Sample', transport: 'stdio', command: process.execPath,
      args: [tsxCli, sampleServer], envRefs: {}, env: {},
    });
    await runtime.connectServer('sample');
    await runtime.saveSuite(suite);
    expect(await runtime.listSuites()).toEqual(['sample-direct']);
    expect(await runtime.getSuite('sample-direct')).toMatchObject({
      name: 'sample-direct', source: expect.stringContaining('kind: direct'), suite: { version: 1, name: 'sample-direct' },
    });
    expect(await runtime.getSuite('../sample-direct')).toBeUndefined();
    await expect(runtime.createSuite(suite)).rejects.toMatchObject({ status: 409 });

    const updatedSource = suite.replace('name: sample-direct', 'name: renamed-direct').replace('equals: 5', 'equals: 6');
    expect(await runtime.updateSuite('sample-direct', updatedSource)).toMatchObject({ name: 'renamed-direct', previousName: 'sample-direct', renamed: true });
    expect(await runtime.listSuites()).toEqual(['renamed-direct']);
    expect(await runtime.getSuite('sample-direct')).toBeUndefined();
    expect(await runtime.getSuite('renamed-direct')).toMatchObject({ source: expect.stringContaining('equals: 6') });
    await runtime.updateSuite('renamed-direct', suite.replace('name: sample-direct', 'name: renamed-direct'));

    const duplicate = suite.replace('name: sample-direct', 'name: copied-direct');
    expect(await runtime.createSuite(duplicate)).toMatchObject({ name: 'copied-direct' });
    expect(await runtime.deleteSuite('copied-direct')).toEqual({ name: 'copied-direct', deleted: true });
    expect(await runtime.getSuite('copied-direct')).toBeUndefined();
    await expect(runtime.deleteSuite('copied-direct')).rejects.toMatchObject({ status: 404 });

    const firstStart = await runtime.startSuite('renamed-direct');
    const first = await waitForRun(runtime, firstStart.id) as { status: string; summary: { passRate: number } };
    expect(first).toMatchObject({ status: 'passed', summary: { passRate: 1 } });

    const secondStart = await runtime.startSuite('renamed-direct');
    await waitForRun(runtime, secondStart.id);
    expect(await runtime.compareRuns(firstStart.id, secondStart.id)).toMatchObject({
      runA: firstStart.id, runB: secondStart.id, passRateDelta: 0, toolCallDelta: 0,
    });
    await runtime.close();
  });
});
