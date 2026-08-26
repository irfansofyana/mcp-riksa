import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { providerConfigSchema, type ProviderAdapter, type ProviderConfig, type ProviderMessage } from '../src/agent/types.js';
import { createProviderAdapter } from '../src/agent/providers.js';
import { runAgent, runScriptedConversation } from '../src/agent/loop.js';
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

test('rejects invalid provider HTTP header names before saving', () => {
  for (const input of [
    { headers: { 'X Bad': { source: 'env' as const, name: 'TEST_PROVIDER_SECRET' } } },
    { headerEnv: { 'X Bad': 'TEST_PROVIDER_SECRET' } },
  ]) {
    expect(() => providerConfigSchema.parse({
      id: 'safe', name: 'Safe', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:4000/v1',
      models: { default: { id: 'test' } }, ...input,
    })).toThrow(/invalid http header name/i);
  }
});

test('rejects case-insensitive duplicates across provider header maps', () => {
  expect(() => providerConfigSchema.parse({
    id: 'safe', name: 'Safe', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:4000/v1',
    models: { default: { id: 'test' } },
    headerEnv: { Authorization: 'LEGACY_TOKEN' },
    headers: { authorization: { source: 'env', name: 'MODERN_TOKEN' } },
  })).toThrow(/duplicate http header name/i);
});

test('rejects simultaneous provider API-key sources', () => {
  expect(() => providerConfigSchema.parse({
    id: 'safe', name: 'Safe', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:4000/v1',
    models: { default: { id: 'test' } }, apiKeyEnv: 'LEGACY_API_KEY',
    apiKey: { source: 'env', name: 'MANAGED_API_KEY' },
  })).toThrow(/apiKey and apiKeyEnv are mutually exclusive/i);
});

test('rejects provider API-key header collisions', () => {
  for (const [type, header] of [
    ['openai-compatible', 'authorization'],
    ['anthropic-compatible', 'X-Api-Key'],
  ] as const) {
    expect(() => providerConfigSchema.parse({
      id: 'safe', name: 'Safe', type, baseUrl: 'http://127.0.0.1:4000/v1',
      models: { default: { id: 'test' } },
      apiKey: { source: 'env', name: 'PROVIDER_API_KEY' },
      headers: { [header]: { source: 'env', name: 'CUSTOM_HEADER_SECRET' } },
    })).toThrow(/conflicts with the provider api-key header/i);
  }
});

test('rejects fixed Anthropic-compatible header collisions via headers or headerEnv', () => {
  for (const input of [
    { headers: { 'Content-Type': { source: 'env' as const, name: 'CUSTOM_CONTENT_TYPE' } } },
    { headers: { 'Anthropic-Version': { source: 'env' as const, name: 'CUSTOM_ANTHROPIC_VERSION' } } },
    { headerEnv: { 'content-type': 'CUSTOM_CONTENT_TYPE' } },
    { headerEnv: { 'anthropic-version': 'CUSTOM_ANTHROPIC_VERSION' } },
  ]) {
    expect(() => providerConfigSchema.parse({
      id: 'safe', name: 'Safe', type: 'anthropic-compatible', baseUrl: 'http://127.0.0.1:4000/v1',
      models: { default: { id: 'test' } }, ...input,
    })).toThrow(/conflicts with the fixed anthropic-compatible header/i);
  }
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
    models: { default: { id: 'test-model', pricing: { inputPerMillion: 1, outputPerMillion: 2 } } },
    apiKeyEnv: 'TEST_PROVIDER_SECRET',
    headerEnv: { 'x-private-provider': 'TEST_PROVIDER_SECRET' },
    headers: {},

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

test('never exposes secrets split across tool-separated model turns', async () => {
  const secret = 'cross-turn-secret-value';
  registerSecretValue(secret);
  const updates: Array<{ type: string; delta?: string }> = [];
  let turn = 0;
  const provider = scriptedAdapter(async (request) => {
    turn += 1;
    if (turn === 1) {
      request.onTextDelta?.('harmless-');
      return {
        text: 'cross-turn-',
        toolCalls: [{ id: 'call-1', name: 'add', arguments: { a: 1, b: 2 } }],
        usage: { input: 1, output: 1, total: 2 }, stopReason: 'tool_calls', raw: {},
      };
    }
    request.onTextDelta?.('text');
    return {
      text: 'secret-value', toolCalls: [], usage: { input: 1, output: 1, total: 2 }, stopReason: 'complete', raw: {},
    };
  });
  const result = await runAgent(
    { prompt: 'use tool', model: 'x', serverId: 'sample', limits: { maxTurns: 2, maxToolCalls: 1, timeoutMs: 5000 } },
    { provider, mcp: manager },
    { onUpdate: (update) => updates.push(update) },
  );

  const streamed = updates.filter((update) => update.type === 'text_delta').map((update) => update.delta ?? '').join('');
  expect(streamed).toBe(REDACTED);
  expect(streamed).not.toContain(secret);
  expect(updates.find((update) => update.type === 'text_delta')).not.toHaveProperty('turn');
  expect(result.output).toBe(REDACTED);
  expect(JSON.stringify(result)).not.toContain('cross-turn-');
  expect(JSON.stringify(result)).not.toContain('secret-value');
});

test('sanitizes cross-turn secrets without a streaming callback', async () => {
  const secret = 'nonstream-cross-turn-secret';
  registerSecretValue(secret);
  let turn = 0;
  const provider = scriptedAdapter(async () => {
    turn += 1;
    return turn === 1
      ? {
        text: 'nonstream-cross-',
        toolCalls: [{ id: 'call-1', name: 'add', arguments: { a: 1, b: 2 } }],
        usage: { input: 1, output: 1, total: 2 }, stopReason: 'tool_calls', raw: { text: 'nonstream-cross-' },
      }
      : {
        text: 'turn-secret', toolCalls: [], usage: { input: 1, output: 1, total: 2 },
        stopReason: 'complete', raw: { text: 'turn-secret' },
      };
  });
  const result = await runAgent(
    { prompt: 'use tool', model: 'x', serverId: 'sample', limits: { maxTurns: 2, maxToolCalls: 1, timeoutMs: 5000 } },
    { provider, mcp: manager },
  );

  expect(result.output).toBe(REDACTED);
  expect(JSON.stringify(result)).not.toContain('nonstream-cross-');
  expect(JSON.stringify(result)).not.toContain('turn-secret');
});

test('preserves a safe final answer when only an earlier turn is redacted', async () => {
  const secret = 'earlier-turn-secret';
  registerSecretValue(secret);
  let turn = 0;
  const provider = scriptedAdapter(async () => {
    turn += 1;
    return turn === 1
      ? {
        text: secret,
        toolCalls: [{ id: 'call-1', name: 'add', arguments: { a: 1, b: 2 } }],
        usage: { input: 1, output: 1, total: 2 }, stopReason: 'tool_calls', raw: { text: secret },
      }
      : {
        text: 'SAFE FINAL', toolCalls: [], usage: { input: 1, output: 1, total: 2 },
        stopReason: 'complete', raw: { text: 'SAFE FINAL' },
      };
  });
  const result = await runAgent(
    { prompt: 'use tool', model: 'x', serverId: 'sample', limits: { maxTurns: 2, maxToolCalls: 1, timeoutMs: 5000 } },
    { provider, mcp: manager },
  );

  expect(result.output).toBe('SAFE FINAL');
  expect(result.transcript.filter((message) => message.role === 'assistant').map((message) => message.content)).toEqual([REDACTED, 'SAFE FINAL']);
  expect(JSON.stringify(result)).not.toContain(secret);
});

test('discards buffered text when a provider resolves after cancellation', async () => {
  const controller = new AbortController();
  const updates: Array<{ type: string; delta?: string }> = [];
  const provider = scriptedAdapter(async (request) => {
    request.onTextDelta?.('cancelled-secret-fragment');
    controller.abort();
    return {
      text: 'cancelled-secret-fragment', toolCalls: [], usage: { input: 1, output: 1, total: 2 }, stopReason: 'complete', raw: {},
    };
  });
  const result = await runAgent(
    { prompt: 'cancel', model: 'x', serverId: 'sample', limits: { maxTurns: 1, maxToolCalls: 1, timeoutMs: 5000 } },
    { provider, mcp: manager },
    { signal: controller.signal, onUpdate: (update) => updates.push(update) },
  );

  expect(result.stopReason).toBe('cancelled');
  expect(updates.filter((update) => update.type === 'text_delta')).toEqual([]);
  expect(updates).toContainEqual(expect.objectContaining({ type: 'stop', reason: 'cancelled' }));
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
  return { id: 'scripted', pricingFor: () => ({ inputPerMillion: 1_000_000, outputPerMillion: 1_000_000 }), complete: script };
}

test('prices usage from the selected model alias', async () => {
  const provider = {
    id: 'model-priced',

    pricingFor: (alias: string) => alias === 'cheap'
      ? { inputPerMillion: 0.15, outputPerMillion: 0.6 }
      : { inputPerMillion: 2.5, outputPerMillion: 10 },
    complete: async () => ({
      text: 'done', toolCalls: [], usage: { input: 1_000_000, output: 1_000_000, total: 2_000_000 }, stopReason: 'complete', raw: {},
    }),
  };
  const noTools = { inspect: async () => ({ tools: [] }), call: async () => ({}) };
  const limits = { maxTurns: 1, maxToolCalls: 0, timeoutMs: 5000 };

  const cheap = await runAgent({ prompt: 'cheap', model: 'cheap', serverId: 'none', limits }, { provider, mcp: noTools });
  const quality = await runAgent({ prompt: 'quality', model: 'quality', serverId: 'none', limits }, { provider, mcp: noTools });

  expect(cheap.costUsd).toBeCloseTo(0.75);
  expect(quality.costUsd).toBeCloseTo(12.5);
});

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
    expect(result.toolCalls).toHaveLength(1);
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

  test('records a completed final answer when cumulative cost exceeds the budget', async () => {
    let turn = 0;
    const provider = scriptedAdapter(async () => {
      turn += 1;
      if (turn === 1) return {
        text: '', toolCalls: [{ id: 'cost-tool', name: 'add', arguments: { a: 1, b: 2 } }],
        usage: { input: 0, output: 0, total: 0 }, stopReason: 'tool_use', raw: {},
      };
      return {
        text: 'expensive', toolCalls: [], usage: { input: 1, output: 1, total: 2 }, stopReason: 'complete', raw: {},
      };
    });
    const result = await runAgent(
      { prompt: 'cost', model: 'x', serverId: 'sample', limits: { maxTurns: 2, maxToolCalls: 1, timeoutMs: 5000, maxCostUsd: 0.5 } },
      { provider, mcp: manager },
    );
    expect(result.stopReason).toBe('max_cost');
    expect(result.transcript).toEqual([
      { role: 'assistant', content: '', toolCalls: [{ id: 'cost-tool', name: 'add', arguments: { a: 1, b: 2 } }] },
      { role: 'tool', toolCallId: 'cost-tool', name: 'add', content: '{"content":[{"type":"text","text":"3"}],"structuredContent":{"sum":3}}' },
      { role: 'assistant', content: 'expensive', toolCalls: [] },
    ]);
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

  test.each([
    ['cancelled', 5000, 10],
    ['max_time', 20, 100],
  ] as const)('returns a terminal %s result when a pending tool call aborts', async (expected, timeoutMs, cancelAfterMs) => {
    const provider = scriptedAdapter(async () => ({
      text: '', toolCalls: [{ id: '1', name: 'add', arguments: { a: 1, b: 1 } }],
      usage: { input: 0, output: 0, total: 0 }, stopReason: 'tool_calls', raw: {},
    }));
    const blockingMcp = {
      inspect: async () => ({ tools: [{ name: 'add', inputSchema: {} }] }),
      call: async (_id: string, _tool: string, _args: Record<string, unknown>, options?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      }),
    };
    const controller = new AbortController();
    const updates: Array<{ type: string; reason?: string }> = [];
    const timer = expected === 'cancelled' ? setTimeout(() => controller.abort(new Error('user cancelled')), cancelAfterMs) : undefined;
    const result = await runAgent(
      { prompt: 'wait for tool', model: 'x', serverId: 'sample', limits: { maxTurns: 2, maxToolCalls: 1, timeoutMs } },
      { provider, mcp: blockingMcp },
      { signal: controller.signal, onUpdate: (update) => updates.push(update) },
    );
    if (timer) clearTimeout(timer);

    expect(result.stopReason).toBe(expected);
    expect(result.toolCalls).toEqual([]);
    expect(result.transcript).toEqual([]);
    expect(updates).toContainEqual(expect.objectContaining({ type: 'stop', reason: expected }));
  });

  test('propagates a concurrent tool failure that is unrelated to cancellation', async () => {
    const controller = new AbortController();
    const provider = scriptedAdapter(async () => ({
      text: '', toolCalls: [{ id: '1', name: 'add', arguments: { a: 1, b: 1 } }],
      usage: { input: 0, output: 0, total: 0 }, stopReason: 'tool_calls', raw: {},
    }));
    const failingMcp = {
      inspect: async () => ({ tools: [{ name: 'add', inputSchema: {} }] }),
      call: async () => {
        controller.abort(new Error('user cancelled'));
        throw new Error('backend failed');
      },
    };

    await expect(runAgent(
      { prompt: 'fail tool', model: 'x', serverId: 'sample', limits: { maxTurns: 2, maxToolCalls: 1, timeoutMs: 5000 } },
      { provider, mcp: failingMcp },
      { signal: controller.signal },
    )).rejects.toThrow('backend failed');
  });

  test('discards a tool result that resolves after cancellation', async () => {
    const controller = new AbortController();
    const provider = scriptedAdapter(async () => ({
      text: '', toolCalls: [{ id: '1', name: 'add', arguments: { a: 1, b: 1 } }],
      usage: { input: 0, output: 0, total: 0 }, stopReason: 'tool_calls', raw: {},
    }));
    const resolvingMcp = {
      inspect: async () => ({ tools: [{ name: 'add', inputSchema: {} }] }),
      call: async (_id: string, _tool: string, _args: Record<string, unknown>, options?: { signal?: AbortSignal }) => new Promise((resolveValue) => {
        options?.signal?.addEventListener('abort', () => resolveValue({ sum: 2 }), { once: true });
      }),
    };
    const updates: Array<{ type: string }> = [];
    const timer = setTimeout(() => controller.abort(new Error('user cancelled')), 10);
    const result = await runAgent(
      { prompt: 'cancel tool', model: 'x', serverId: 'sample', limits: { maxTurns: 2, maxToolCalls: 1, timeoutMs: 5000 } },
      { provider, mcp: resolvingMcp },
      { signal: controller.signal, onUpdate: (update) => updates.push(update) },
    );
    clearTimeout(timer);

    expect(result.stopReason).toBe('cancelled');
    expect(result.toolCalls).toEqual([]);
    expect(result.transcript.some((message) => message.role === 'tool')).toBe(false);
    expect(updates.some((update) => update.type === 'tool_call')).toBe(false);
  });

  test('preserves caller cancellation when timeout fires before an abort rejection settles', async () => {
    const controller = new AbortController();
    const provider = scriptedAdapter(async ({ signal }) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => setTimeout(() => reject(signal.reason), 20), { once: true });
    }));
    const timer = setTimeout(() => controller.abort(new Error('user cancelled')), 5);
    const result = await runAgent(
      { prompt: 'cancel first', model: 'x', serverId: 'sample', limits: { maxTurns: 1, maxToolCalls: 1, timeoutMs: 15 } },
      { provider, mcp: manager },
      { signal: controller.signal },
    );
    clearTimeout(timer);

    expect(result.stopReason).toBe('cancelled');
  });

  test('returns max_time when MCP inspection does not settle', async () => {
    const provider = scriptedAdapter(async () => ({
      text: 'unused', toolCalls: [], usage: { input: 0, output: 0, total: 0 }, stopReason: 'complete', raw: {},
    }));
    const hangingMcp = {
      inspect: async () => new Promise<never>(() => undefined),
      call: async () => undefined,
    };
    const updates: Array<{ type: string; reason?: string }> = [];
    const outcome = await Promise.race([
      runAgent(
        { prompt: 'inspect', model: 'x', serverId: 'sample', limits: { maxTurns: 1, maxToolCalls: 1, timeoutMs: 10 } },
        { provider, mcp: hangingMcp },
        { onUpdate: (update) => updates.push(update) },
      ),
      new Promise<'still-pending'>((resolvePending) => setTimeout(() => resolvePending('still-pending'), 50)),
    ]);

    expect(outcome).not.toBe('still-pending');
    expect(outcome).toEqual(expect.objectContaining({ stopReason: 'max_time' }));
    expect(updates).toContainEqual(expect.objectContaining({ type: 'stop', reason: 'max_time' }));
  });

  test('propagates an inspection failure when cancellation has already fired', async () => {
    const controller = new AbortController();
    controller.abort(new Error('user cancelled'));
    const provider = scriptedAdapter(async () => ({
      text: 'unused', toolCalls: [], usage: { input: 0, output: 0, total: 0 }, stopReason: 'complete', raw: {},
    }));
    const failingMcp = {
      inspect: async () => { throw new Error('inspection backend failed'); },
      call: async () => undefined,
    };

    await expect(runAgent(
      { prompt: 'inspect', model: 'x', serverId: 'sample', limits: { maxTurns: 1, maxToolCalls: 1, timeoutMs: 5000 } },
      { provider, mcp: failingMcp },
      { signal: controller.signal },
    )).rejects.toThrow('inspection backend failed');
  });

  test('continues scripted user turns with preserved provider history and cumulative trace scope', async () => {
    const messages: ProviderMessage[][] = [];
    const provider = scriptedAdapter(async (request) => {
      messages.push(request.messages);
      return { text: `answer:${request.messages.at(-1)?.content ?? ''}`, toolCalls: [], usage: { input: 2, output: 1, total: 3 }, stopReason: 'complete', raw: {} };
    });
    const result = await runScriptedConversation(
      { turns: [{ id: 'request', user: 'Book meeting' }, { id: 'time', user: 'Tomorrow at 3 PM' }], model: 'x', serverId: 'sample', limits: { maxTurns: 3, maxToolCalls: 2, timeoutMs: 5000 } },
      { provider, mcp: manager },
    );
    expect(messages).toHaveLength(2);
    expect(messages[1]?.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(result).toMatchObject({ output: 'answer:Tomorrow at 3 PM', stopReason: 'complete', tokens: { total: 6 } });
    expect(result.turns.map((turn) => turn.id)).toEqual(['request', 'time']);
    expect(result.events.filter((entry) => entry.type === 'user_turn').map((entry) => entry.userTurn)).toEqual([undefined, undefined]);
    expect(result.events.filter((entry) => entry.type === 'model_turn').map((entry) => entry.userTurn)).toEqual(['request', 'time']);
  });
});
