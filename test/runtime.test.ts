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
    await runtime.addServer({ id: 'http', name: 'HTTP', transport: 'http', url: 'http://127.0.0.1:3000/mcp', headerEnv: {}, allowUnsafeEndpoint: false });
    await runtime.addServer({ id: 'stdio', name: 'Stdio', transport: 'stdio', command: process.execPath, args: [], envRefs: {} });
    await expect(runtime.startConformance({ serverId: 'stdio', selection: { kind: 'suite', suite: 'active' }, timeoutMs: 30_000 })).rejects.toMatchObject({ status: 400 });
    const started = await runtime.startConformance({ serverId: 'http', selection: { kind: 'scenario', scenario: 'server-initialize' }, timeoutMs: 30_000 });
    await expect(runtime.updateServer('http', { id: 'http', name: 'Changed', transport: 'http', url: 'http://127.0.0.1:3000/mcp', headerEnv: {}, allowUnsafeEndpoint: false })).rejects.toMatchObject({ status: 409 });
    expect(await runtime.cancelConformance(started.id)).toBe(true);
    expect(await waitForConformance(runtime, started.id)).toMatchObject({ status: 'cancelled', runnerVersion: '0.1.10', selection: { scenario: 'server-initialize' } });
    expect(await runtime.listConformanceReports('http')).toHaveLength(1);
    await runtime.addServer({ id: 'query-secret', name: 'Query secret', transport: 'http', url: 'http://127.0.0.1:3000/mcp?access_token=secret', headerEnv: {}, allowUnsafeEndpoint: false });
    await expect(runtime.startConformance({ serverId: 'query-secret', selection: { kind: 'suite', suite: 'active' }, timeoutMs: 30_000 })).rejects.toMatchObject({ status: 400 });
    await runtime.addServer({ id: 'remote', name: 'Remote', transport: 'http', url: 'https://example.com/mcp', headerEnv: {}, allowUnsafeEndpoint: false });
    await expect(runtime.startConformance({ serverId: 'remote', selection: { kind: 'suite', suite: 'active' }, timeoutMs: 30_000 })).rejects.toMatchObject({ status: 400 });
    await runtime.close();
  });
  test('rejects credential-bearing provider URLs before seeding configuration', async () => {
    const { runtime } = createRuntime();
    await expect(runtime.seedProvider({
      id: 'credentialed', name: 'Credentialed', type: 'openai-compatible',
      baseUrl: 'http://user:password@127.0.0.1:4000/v1', models: { default: 'test' },
      headerEnv: {}, pricing: { inputPerMillion: 0, outputPerMillion: 0 },
    })).rejects.toThrow('Credentials are not allowed');
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
        baseUrl: `http://127.0.0.1:${address.port}/v1`, models: { fast: 'upstream-model-name' }, headerEnv: {},
        pricing: { inputPerMillion: 0, outputPerMillion: 0 },
      });
      await runtime.addServer({
        id: 'sample', name: 'Sample', transport: 'stdio', command: process.execPath,
        args: [tsxCli, sampleServer], envRefs: {},
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
      await runtime.addProvider({ id: 'local', name: 'Local', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, models: { fast: 'test' }, headerEnv: {}, pricing: { inputPerMillion: 1, outputPerMillion: 2 } });
      await runtime.addServer({ id: 'sample', name: 'Sample', transport: 'stdio', command: process.execPath, args: [tsxCli, sampleServer], envRefs: {} });
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
      expect(deltas).toEqual(['Hello ', 'there']);
      expect(detail).toMatchObject({ messageCount: 6, totals: { tokens: { total: 12 }, toolCalls: 1 } });
      expect(receivedMessages[0]?.[0]).toEqual({ role: 'system', content: 'Use tools accurately.' });
      expect(receivedMessages[1]).toHaveLength(4);
      expect(receivedMessages[1]?.[0]).toEqual({ role: 'system', content: 'Use tools accurately.' });
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
      models: { fast: 'small-model', quality: 'large-model' }, headerEnv: {}, pricing: { inputPerMillion: 1, outputPerMillion: 2 },
    });
    await expect(runtime.createProvider({
      id: 'gateway', name: 'Duplicate', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:4000/v1',
      models: { default: 'x' }, headerEnv: {}, pricing: { inputPerMillion: 0, outputPerMillion: 0 },
    })).rejects.toMatchObject({ status: 409 });
    await runtime.createServer({ id: 'sample', name: 'Sample', transport: 'stdio', command: process.execPath, args: [tsxCli, sampleServer], envRefs: {} });
    await runtime.connectServer('sample');
    await runtime.forgetOAuth('sample');
    expect((await runtime.bootstrap() as { servers: Array<{ connected: boolean }> }).servers[0]?.connected).toBe(false);
    await runtime.connectServer('sample');
    const conversation = await runtime.createConversation({ serverId: 'sample', providerId: 'gateway', model: 'quality' });

    await expect(runtime.updateProvider('gateway', {
      id: 'gateway', name: 'Gateway', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:4000/v1',
      models: { fast: 'small-model' }, headerEnv: {}, pricing: { inputPerMillion: 1, outputPerMillion: 2 },
    })).rejects.toMatchObject({ status: 409 });
    await runtime.updateProvider('gateway', {
      id: 'gateway', name: 'Updated Gateway', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:4000/v1',
      models: { fast: 'small-v2', quality: 'large-v2', reasoning: 'reasoner' }, headerEnv: {}, pricing: { inputPerMillion: 3, outputPerMillion: 4 },
    });
    await runtime.updateServer('sample', { id: 'sample', name: 'Updated Sample', transport: 'stdio', command: process.execPath, args: [tsxCli, sampleServer], envRefs: {} });
    expect((await runtime.bootstrap() as { servers: Array<{ id: string; connected: boolean }> }).servers[0]).toMatchObject({ id: 'sample', connected: false });
    await expect(runtime.deleteProvider('gateway')).rejects.toMatchObject({ status: 409 });
    await expect(runtime.deleteServer('sample')).rejects.toMatchObject({ status: 409 });
    expect(await runtime.deleteProvider('gateway', true)).toMatchObject({ deleted: true, forced: true });
    expect(await runtime.deleteServer('sample', true)).toMatchObject({ deleted: true, forced: true });
    expect(await runtime.getConversation(conversation.id)).toMatchObject({ providerId: 'gateway', serverId: 'sample', model: 'quality' });
    await runtime.close();

    const restored = new WorkbenchRuntime({ databasePath, suiteDirectory: join(directory, 'suites'), callbackUrl: 'http://127.0.0.1:4317/api/oauth/callback' });
    expect(await restored.seedProvider({ id: 'gateway', name: 'Seed', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:4000/v1', models: { default: 'seed' }, headerEnv: {}, pricing: { inputPerMillion: 0, outputPerMillion: 0 } })).toBe(false);
    expect(await restored.seedServer({ id: 'sample', name: 'Seed', transport: 'stdio', command: process.execPath, args: [], envRefs: {} })).toBe(false);
    expect((await restored.bootstrap() as { providers: unknown[]; servers: unknown[] })).toMatchObject({ providers: [], servers: [] });
    await restored.close();
  });

  test('persists only environment references and restores provider/server configuration', async () => {
    process.env.RUNTIME_PROVIDER_SECRET = 'must-never-reach-disk';
    const { runtime, databasePath, directory } = createRuntime();
    await runtime.addProvider({
      id: 'local', name: 'Local', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:4000/v1',
      models: { default: 'test' }, apiKeyEnv: 'RUNTIME_PROVIDER_SECRET', headerEnv: { Authorization: 'RUNTIME_PROVIDER_SECRET' },
      pricing: { inputPerMillion: 0, outputPerMillion: 0 },
    });
    await runtime.addServer({
      id: 'sample', name: 'Sample', transport: 'stdio', command: process.execPath,
      args: [tsxCli, sampleServer], envRefs: {},
    });
    await runtime.close();

    expect(readFileSync(databasePath).toString('latin1')).not.toContain('must-never-reach-disk');
    const restored = new WorkbenchRuntime({
      databasePath, suiteDirectory: join(directory, 'suites'), callbackUrl: 'http://127.0.0.1:4317/api/oauth/callback',
    });
    const settings = await restored.settings();
    expect(settings).toMatchObject({ providers: [{
      id: 'local', apiKeyEnv: 'RUNTIME_PROVIDER_SECRET', apiKeyConfigured: true,
      headerStatus: { Authorization: { environment: 'RUNTIME_PROVIDER_SECRET', configured: true } },
    }] });
    expect((await restored.bootstrap() as { servers: unknown[] }).servers).toHaveLength(1);
    await restored.close();
  });

  test('runs a saved direct suite through the real sample MCP server and compares persisted runs', async () => {
    const { runtime } = createRuntime();
    await runtime.addServer({
      id: 'sample', name: 'Sample', transport: 'stdio', command: process.execPath,
      args: [tsxCli, sampleServer], envRefs: {},
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
