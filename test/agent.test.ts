import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { providerConfigSchema, type ProviderAdapter, type ProviderConfig } from '../src/agent/types.js';
import { createProviderAdapter } from '../src/agent/providers.js';
import { runAgent } from '../src/agent/loop.js';
import { REDACTED, registerSecretValue } from '../src/core/redaction.js';
import { McpManager } from '../src/mcp/manager.js';

const tsxCli = resolve('node_modules/tsx/dist/cli.mjs');
const sampleServer = resolve('examples/sample-mcp-server.ts');

let baseUrl = '';
let receivedPrivateHeader = false;
let httpServer: ReturnType<typeof createServer>;
let manager: McpManager;
const requestCounts = new Map<string, number>();

test('rejects non-HTTP model provider endpoints', () => {
  expect(() => createProviderAdapter({
    id: 'unsafe', name: 'Unsafe', type: 'openai-compatible', baseUrl: 'file:///tmp/provider',
    models: { default: 'test' }, headerEnv: {}, pricing: { inputPerMillion: 0, outputPerMillion: 0 },
  })).toThrow(/http/i);
});

test.each(['raw-secret-value', 'Bearer secret', '123_INVALID'])('rejects non-environment provider secret reference %s', (reference) => {
  expect(() => providerConfigSchema.parse({
    id: 'safe', name: 'Safe', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:4000/v1',
    models: { default: 'test' }, apiKeyEnv: reference, headerEnv: {},
  })).toThrow(/environment variable name/i);
});

test('rejects inline secrets in provider header references', () => {
  expect(() => providerConfigSchema.parse({
    id: 'safe', name: 'Safe', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:4000/v1',
    models: { default: 'test' }, headerEnv: { Authorization: 'Bearer raw-secret-value' },
  })).toThrow(/environment variable name/i);
});

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

beforeAll(async () => {
  process.env.TEST_PROVIDER_SECRET = 'provider-secret-value';
  httpServer = createServer(async (request, response) => {
    receivedPrivateHeader ||= request.headers['x-private-provider'] === 'provider-secret-value';
    const url = request.url ?? '';
    const payload = await body(request);
    const count = (requestCounts.get(url) ?? 0) + 1;
    requestCounts.set(url, count);

    if (url.includes('/malformed/')) return json(response, { unexpected: true });
    if (url.endsWith('/chat/completions')) {
      const hasToolResult = Array.isArray(payload.messages)
        && payload.messages.some((entry) => (entry as { role?: string }).role === 'tool');
      if (payload.stream === true) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunks = hasToolResult
          ? [
              { choices: [{ index: 0, delta: { content: 'The sum ' }, finish_reason: null }] },
              { choices: [{ index: 0, delta: { content: 'is 5' }, finish_reason: 'stop' }] },
            ]
          : [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'add', arguments: '{"a":2,"b":3}' } }] }, finish_reason: 'tool_calls' }] }];
        for (const chunk of chunks) response.write(`data: ${JSON.stringify({ id: `openai-${count}`, object: 'chat.completion.chunk', created: 1, model: 'test-model', ...chunk })}\n\n`);
        response.write(`data: ${JSON.stringify({ id: `openai-${count}`, object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
        response.end('data: [DONE]\n\n');
        return;
      }
      return json(response, {
        id: `openai-${count}`,
        object: 'chat.completion',
        created: 1,
        model: 'test-model',
        choices: [{
          index: 0,
          message: hasToolResult
            ? { role: 'assistant', content: 'The sum is 5' }
            : { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'add', arguments: '{"a":2,"b":3}' } }] },
          finish_reason: hasToolResult ? 'stop' : 'tool_calls',
        }],
        ...(url.includes('/missing-usage/') ? {} : { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }),
      });
    }
    if (url.endsWith('/messages')) {
      const content = payload.messages as Array<{ content?: unknown }>;
      const hasToolResult = JSON.stringify(content).includes('tool_result');
      if (payload.stream === true) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
        send({ type: 'message_start', message: { usage: { input_tokens: 80 } } });
        if (hasToolResult) {
          send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
          send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The sum ' } });
          send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'is 5' } });
          send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } });
        } else {
          send({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-1', name: 'add', input: {} } });
          send({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":2,"b":3}' } });
          send({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } });
        }
        response.end();
        return;
      }
      return json(response, {
        id: `anthropic-${count}`,
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: hasToolResult
          ? [{ type: 'text', text: 'The sum is 5' }]
          : [{ type: 'tool_use', id: 'call-1', name: 'add', input: { a: 2, b: 3 } }],
        stop_reason: hasToolResult ? 'end_turn' : 'tool_use',
        ...(url.includes('/missing-usage/') ? {} : { usage: { input_tokens: 80, output_tokens: 10 } }),
      });
    }
    return json(response, { error: 'not found' }, 404);
  });
  await new Promise<void>((resolveListen) => httpServer.listen(0, '127.0.0.1', resolveListen));
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Fake provider did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;

  manager = new McpManager();
  await manager.connect({
    id: 'sample', name: 'sample', transport: 'stdio', command: process.execPath, args: [tsxCli, sampleServer],
  });
});

afterAll(async () => {
  await manager.closeAll();
  await new Promise<void>((resolveClose, reject) => httpServer.close((error) => error ? reject(error) : resolveClose()));
  delete process.env.TEST_PROVIDER_SECRET;
});

function config(type: ProviderConfig['type'], segment = type.startsWith('openai') ? 'openai' : 'anthropic'): ProviderConfig {
  return {
    id: segment,
    name: segment,
    type,
    baseUrl: `${baseUrl}/${segment}/v1`,
    models: { default: 'test-model' },
    apiKeyEnv: 'TEST_PROVIDER_SECRET',
    headerEnv: { 'x-private-provider': 'TEST_PROVIDER_SECRET' },
    pricing: { inputPerMillion: 1, outputPerMillion: 2 },
  };
}

describe.each([
  ['OpenAI', 'openai-compatible' as const],
  ['Anthropic', 'anthropic-compatible' as const],
])('%s-compatible provider', (_label, type) => {
  test('runs a complete provider → MCP tool → provider loop with normalized usage and sanitized trace', async () => {
    receivedPrivateHeader = false;
    const result = await runAgent(
      { prompt: 'Add 2 and 3', systemPrompt: 'Use tools accurately.', model: 'default', serverId: 'sample', limits: { maxTurns: 4, maxToolCalls: 3, timeoutMs: 5000 } },
      { provider: createProviderAdapter(config(type)), mcp: manager },
    );

    expect(result.output).toBe('The sum is 5');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ name: 'add', arguments: { a: 2, b: 3 } });
    expect(result.tokens.total).toBeGreaterThan(0);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.stopReason).toBe('complete');
    expect(receivedPrivateHeader).toBe(true);
    expect(JSON.stringify(result)).not.toContain('provider-secret-value');
  });

  test('streams provider text deltas through the agent loop', async () => {
    const updates: Array<{ type: string; [key: string]: unknown }> = [];
    const result = await runAgent(
      { prompt: 'Add 2 and 3', model: 'default', serverId: 'sample', limits: { maxTurns: 4, maxToolCalls: 3, timeoutMs: 5000 } },
      { provider: createProviderAdapter(config(type)), mcp: manager },
      { onUpdate: (update) => updates.push(update) },
    );
    expect(result.output).toBe('The sum is 5');
    expect(updates.filter((update) => update.type === 'text_delta').map((update) => update.delta)).toEqual(['The sum is 5']);
    expect(updates).toContainEqual(expect.objectContaining({ type: 'tool_call' }));
    expect(result.tokens.total).toBeGreaterThan(0);
  });
});

test('streams text deltas and progress while retaining normalized final result', async () => {
  const updates: Array<{ type: string; [key: string]: unknown }> = [];
  const provider = scriptedAdapter(async (request) => {
    request.onTextDelta?.('Hello');
    request.onTextDelta?.(' world');
    return {
      text: 'Hello world', toolCalls: [], usage: { input: 3, output: 2, total: 5 },
      stopReason: 'complete', raw: { streamed: true },
    };
  });
  const result = await runAgent(
    { prompt: 'hello', model: 'x', serverId: 'sample', limits: { maxTurns: 2, maxToolCalls: 1, timeoutMs: 5000 } },
    { provider, mcp: manager },
    { onUpdate: (update) => updates.push(update) },
  );

  expect(result.output).toBe('Hello world');
  expect(updates.filter((update) => update.type === 'text_delta').map((update) => update.delta)).toEqual(['Hello world']);
  expect(updates).toContainEqual(expect.objectContaining({ type: 'model_turn', turn: 1 }));
  expect(updates).toContainEqual(expect.objectContaining({ type: 'stop', reason: 'complete' }));
});

test('never exposes secrets split across provider text deltas', async () => {
  const secret = 'split-stream-secret-value';
  registerSecretValue(secret);
  const updates: Array<{ type: string; delta?: string }> = [];
  const provider = scriptedAdapter(async (request) => {
    request.onTextDelta?.('Known secret: split-stream-');
    request.onTextDelta?.('secret-value; Authorization: Bear');
    request.onTextDelta?.('er another-secret-value');
    return {
      text: `Known secret: ${secret}; Authorization: Bearer another-secret-value`,
      toolCalls: [], usage: { input: 1, output: 1, total: 2 }, stopReason: 'complete', raw: {},
    };
  });
  await runAgent(
    { prompt: 'show secret', model: 'x', serverId: 'sample', limits: { maxTurns: 1, maxToolCalls: 1, timeoutMs: 5000 } },
    { provider, mcp: manager },
    { onUpdate: (update) => updates.push(update) },
  );

  const streamed = updates.filter((update) => update.type === 'text_delta').map((update) => update.delta ?? '').join('');
  expect(streamed).toBe(`Known secret: ${REDACTED}; Authorization: Bearer ${REDACTED}`);
  expect(streamed).not.toContain(secret);
  expect(streamed).not.toContain('another-secret-value');
});

test('normalizes missing usage to zero', async () => {
  const adapter = createProviderAdapter(config('openai-compatible', 'missing-usage'));
  const response = await adapter.complete({ model: 'default', messages: [{ role: 'user', content: 'hello' }], tools: [] });
  expect(response.usage).toEqual({ input: 0, output: 0, total: 0 });
});

test('rejects malformed compatibility responses with a precise error', async () => {
  const adapter = createProviderAdapter(config('anthropic-compatible', 'malformed'));
  await expect(adapter.complete({ model: 'default', messages: [{ role: 'user', content: 'hello' }], tools: [] }))
    .rejects.toThrow(/malformed Anthropic-compatible response/i);
});

function scriptedAdapter(script: ProviderAdapter['complete']): ProviderAdapter {
  return { id: 'scripted', pricing: { inputPerMillion: 1_000_000, outputPerMillion: 1_000_000 }, complete: script };
}

describe('agent stop boundaries', () => {
  test('stops at max turns', async () => {
    const provider = scriptedAdapter(async () => ({
      text: '', toolCalls: [{ id: '1', name: 'add', arguments: { a: 1, b: 1 } }],
      usage: { input: 0, output: 0, total: 0 }, stopReason: 'tool_calls', raw: {},
    }));
    const result = await runAgent(
      { prompt: 'loop', model: 'x', serverId: 'sample', limits: { maxTurns: 1, maxToolCalls: 3, timeoutMs: 5000 } },
      { provider, mcp: manager },
    );
    expect(result.stopReason).toBe('max_turns');
  });

  test('stops before exceeding max tool calls', async () => {
    const provider = scriptedAdapter(async () => ({
      text: '',
      toolCalls: [
        { id: '1', name: 'add', arguments: { a: 1, b: 1 } },
        { id: '2', name: 'add', arguments: { a: 2, b: 2 } },
      ],
      usage: { input: 0, output: 0, total: 0 }, stopReason: 'tool_calls', raw: {},
    }));
    const result = await runAgent(
      { prompt: 'twice', model: 'x', serverId: 'sample', limits: { maxTurns: 2, maxToolCalls: 1, timeoutMs: 5000 } },
      { provider, mcp: manager },
    );
    expect(result.stopReason).toBe('max_tool_calls');
    expect(result.toolCalls).toHaveLength(0);
  });

  test('stops when estimated cost exceeds the budget', async () => {
    const provider = scriptedAdapter(async () => ({
      text: 'expensive', toolCalls: [], usage: { input: 1, output: 1, total: 2 }, stopReason: 'complete', raw: {},
    }));
    const result = await runAgent(
      { prompt: 'cost', model: 'x', serverId: 'sample', limits: { maxTurns: 2, maxToolCalls: 1, timeoutMs: 5000, maxCostUsd: 0.5 } },
      { provider, mcp: manager },
    );
    expect(result.stopReason).toBe('max_cost');
  });

  test.each([
    ['cancelled', 5000, 10],
    ['max_time', 20, 100],
  ] as const)('stops as %s', async (expected, timeoutMs, cancelAfterMs) => {
    const provider = scriptedAdapter(async ({ signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ text: 'late', toolCalls: [], usage: { input: 0, output: 0, total: 0 }, stopReason: 'complete', raw: {} }), 1000);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    }));
    const controller = new AbortController();
    const timer = expected === 'cancelled' ? setTimeout(() => controller.abort(new Error('user cancelled')), cancelAfterMs) : undefined;
    const result = await runAgent(
      { prompt: 'wait', model: 'x', serverId: 'sample', limits: { maxTurns: 2, maxToolCalls: 1, timeoutMs } },
      { provider, mcp: manager },
      { signal: controller.signal },
    );
    if (timer) clearTimeout(timer);
    expect(result.stopReason).toBe(expected);
  });
});
