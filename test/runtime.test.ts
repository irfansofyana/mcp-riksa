import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { WorkbenchRuntime } from '../src/server/runtime.js';

const directories: string[] = [];
const tsxCli = resolve('node_modules/tsx/dist/cli.mjs');
const sampleServer = resolve('examples/sample-mcp-server.ts');

function createRuntime() {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-runtime-'));
  directories.push(directory);
  const databasePath = join(directory, 'workbench.db');
  const runtime = new WorkbenchRuntime({
    databasePath,
    suiteDirectory: join(directory, 'suites'),
    callbackUrl: 'http://127.0.0.1:4317/api/oauth/callback',
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

describe('concrete workbench runtime', () => {
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
      const conversation = await runtime.createConversation({ serverId: 'sample', providerId: 'local', model: 'fast' });
      const deltas: string[] = [];
      await runtime.streamPlayground({ conversationId: conversation.id, prompt: 'First' }, (update) => { if (update.type === 'text_delta') deltas.push(update.delta); });
      await runtime.streamPlayground({ conversationId: conversation.id, prompt: 'Second' }, () => undefined);
      const detail = await runtime.getConversation(conversation.id);
      expect(deltas).toEqual(['Hello ', 'there']);
      expect(detail).toMatchObject({ messageCount: 4, totals: { tokens: { total: 12 } } });
      expect(receivedMessages[1]).toHaveLength(3);
      await expect(runtime.streamPlayground({ conversationId: conversation.id, prompt: 'Fail' }, () => undefined)).rejects.toThrow();
      expect(await runtime.getConversation(conversation.id)).toMatchObject({ messageCount: 4 });
    } finally {
      await runtime.close();
      await new Promise<void>((resolveClose, reject) => provider.close((error) => error ? reject(error) : resolveClose()));
    }
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

    const firstStart = await runtime.startSuite('sample-direct');
    const first = await waitForRun(runtime, firstStart.id) as { status: string; summary: { passRate: number } };
    expect(first).toMatchObject({ status: 'passed', summary: { passRate: 1 } });

    const secondStart = await runtime.startSuite('sample-direct');
    await waitForRun(runtime, secondStart.id);
    expect(await runtime.compareRuns(firstStart.id, secondStart.id)).toMatchObject({
      runA: firstStart.id, runB: secondStart.id, passRateDelta: 0, toolCallDelta: 0,
    });
    await runtime.close();
  });
});
