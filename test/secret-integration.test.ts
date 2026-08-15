import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createProviderAdapter } from '../src/agent/providers.js';
import { resolveHttpHeaders, resolveReferenceMap, serverConfigSchema } from '../src/mcp/manager.js';
import type { SecretPurpose, SecretRef } from '../src/secrets/types.js';

let baseUrl = '';
let receivedAuthorization = '';
let receivedTeamHeader = '';
let providerServer: ReturnType<typeof createServer>;

const providerKeyId = 'secret_00000000-0000-4000-8000-000000000001';
const providerHeaderId = 'secret_00000000-0000-4000-8000-000000000002';
const mcpTokenId = 'secret_00000000-0000-4000-8000-000000000003';
const stdioTokenId = 'secret_00000000-0000-4000-8000-000000000004';
const values = new Map([
  [providerKeyId, 'provider-vault-value'],
  [providerHeaderId, 'team-session-value'],
  [mcpTokenId, 'mcp-static-token'],
  [stdioTokenId, 'stdio-secret-value'],
]);
const resolveSecret = async (reference: SecretRef, purpose: SecretPurpose) => {
  if (reference.source === 'env') return `env:${reference.name}:${purpose}`;
  const value = values.get(reference.id);
  if (!value) throw new Error('missing test secret');
  return value;
};

beforeAll(async () => {
  providerServer = createServer(async (request, response) => {
    receivedAuthorization = request.headers.authorization ?? '';
    receivedTeamHeader = request.headers['x-team'] as string ?? '';
    for await (const _chunk of request) { /* drain */ }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: 'secret-test', object: 'chat.completion', created: 1, model: 'upstream-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }));
  });
  await new Promise<void>((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  const address = providerServer.address();
  if (!address || typeof address === 'string') throw new Error('provider did not bind');
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => providerServer.close((error) => error ? reject(error) : resolve()));
});

describe('secret reference integration', () => {
  test('resolves provider vault and session references only when the provider is used', async () => {
    const adapter = createProviderAdapter({
      id: 'private', name: 'Private', type: 'openai-compatible', baseUrl,
      models: { fast: { id: 'upstream-model', pricing: { inputPerMillion: 0.15, outputPerMillion: 0.6 } } },
      apiKey: { source: 'vault', id: providerKeyId },
      headers: { 'x-team': { source: 'session', id: providerHeaderId } },
    }, resolveSecret);

    expect(receivedAuthorization).toBe('');
    const result = await adapter.complete({ model: 'fast', messages: [{ role: 'user', content: 'hello' }], tools: [] });
    expect(result.text).toBe('ok');
    expect(receivedAuthorization).toBe('Bearer provider-vault-value');
    expect(receivedTeamHeader).toBe('team-session-value');
    expect(adapter.pricingFor('fast')).toEqual({ inputPerMillion: 0.15, outputPerMillion: 0.6 });
    await adapter.close?.();
  });

  test('assembles static HTTP authorization in the backend and resolves stdio mappings', async () => {
    const config = serverConfigSchema.parse({
      id: 'remote', name: 'Remote', transport: 'http', url: 'https://example.test/mcp',
      headers: { 'x-tenant': { source: 'env', name: 'TENANT_TOKEN' } },
      staticAuth: { header: 'Authorization', scheme: 'Bearer', credential: { source: 'vault', id: mcpTokenId } },
      allowUnsafeEndpoint: false,
    });
    if (config.transport !== 'http') throw new Error('expected HTTP config');
    await expect(resolveHttpHeaders(config, resolveSecret)).resolves.toEqual({
      'x-tenant': 'env:TENANT_TOKEN:mcp-header',
      Authorization: 'Bearer mcp-static-token',
    });

    await expect(resolveReferenceMap(
      { TOKEN: { source: 'session', id: stdioTokenId } },
      'stdio-env',
      resolveSecret,
    )).resolves.toEqual({ TOKEN: 'stdio-secret-value' });
  });

  test('rejects ambiguous OAuth and static authorization combinations', () => {
    expect(() => serverConfigSchema.parse({
      id: 'ambiguous', name: 'Ambiguous', transport: 'http', url: 'https://example.test/mcp', headers: {},
      staticAuth: { header: 'Authorization', scheme: 'Bearer', credential: { source: 'env', name: 'MCP_TOKEN' } },
      oauth: { scopes: [], timeoutMs: 120_000 }, allowUnsafeEndpoint: false,
    })).toThrow(/mutually exclusive/i);
  });
});
