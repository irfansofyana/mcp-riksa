import { describe, expect, test } from 'vitest';
import {
  buildProviderPayload,
  providerToForm,
  serverToForm,
  buildTraceRows,
  buildServerPayload,
  buildSuiteFromPlayground,
  buildToolArguments,
  buildToolFields,
  groupTrace,
  normalizeMcpContent,
  normalizePage,
  signedDelta,
  traceWindowMs,
} from '../web/src/model.js';

describe('workbench browser view model', () => {
  test('normalizes hash navigation to the six supported pages', () => {
    expect(normalizePage('#/playground')).toBe('Playground');
    expect(normalizePage('#/not-real')).toBe('Servers');
    expect(normalizePage('')).toBe('Servers');
  });

  test('builds stdio and HTTP server payloads without shell strings or resolved secrets', () => {
    expect(buildServerPayload({ id: 'sample', name: 'Sample', transport: 'stdio', command: 'node', args: '--flag value', url: '', headerEnv: '' })).toEqual({
      id: 'sample', name: 'Sample', transport: 'stdio', command: 'node', args: ['--flag', 'value'], envRefs: {},
    });
    expect(buildServerPayload({
      id: 'remote', name: 'Remote', transport: 'http', command: '', args: '',
      url: 'http://127.0.0.1:3000/mcp', headerEnv: 'Authorization=MCP_TOKEN',
      oauthEnabled: true, oauthScopes: 'mcp:read mcp:write', oauthClientId: 'static-client', oauthClientSecretEnv: 'MCP_OAUTH_SECRET', oauthTimeoutMs: '90000',
    })).toMatchObject({
      id: 'remote', transport: 'http', url: 'http://127.0.0.1:3000/mcp', headerEnv: { Authorization: 'MCP_TOKEN' },
      oauth: { scopes: ['mcp:read', 'mcp:write'], clientId: 'static-client', clientSecretEnv: 'MCP_OAUTH_SECRET', timeoutMs: 90000 },
    });
  });

  test('builds generic model provider payloads with aliases and env references', () => {
    expect(buildProviderPayload({
      id: 'local', name: 'Local', type: 'anthropic-compatible', baseUrl: 'http://127.0.0.1:4000/v1',
      models: [{ alias: 'fast', model: 'test-model' }, { alias: 'quality', model: 'large-model' }], apiKeyEnv: 'PROVIDER_KEY', headerEnv: 'x-team=TEAM_TOKEN',
      inputPrice: '1.5', outputPrice: '2.5',
    })).toMatchObject({ models: { fast: 'test-model', quality: 'large-model' }, apiKeyEnv: 'PROVIDER_KEY', headerEnv: { 'x-team': 'TEAM_TOKEN' }, pricing: { inputPerMillion: 1.5, outputPerMillion: 2.5 } });
    expect(() => buildProviderPayload({
      id: 'local', name: 'Local', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:4000/v1',
      models: [{ alias: 'same', model: 'one' }, { alias: 'same', model: 'two' }], apiKeyEnv: '', headerEnv: '', inputPrice: '0', outputPrice: '0',
    })).toThrow(/duplicate model alias/i);
  });

  test('round-trips provider and server configs into editable forms', () => {
    expect(providerToForm({
      id: 'gateway', name: 'Gateway', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:4000/v1',
      models: { fast: 'small', quality: 'large' }, apiKeyEnv: 'KEY', headerEnv: { 'x-team': 'TEAM' }, pricing: { inputPerMillion: 1, outputPerMillion: 2 },
    })).toMatchObject({ models: [{ alias: 'fast', model: 'small' }, { alias: 'quality', model: 'large' }], headerEnv: 'x-team=TEAM' });
    const remote = { id: 'remote', name: 'Remote', transport: 'http' as const, url: 'https://example.test/mcp', headerEnv: { Authorization: 'MCP_TOKEN' }, allowUnsafeEndpoint: false, oauth: { scopes: ['read', 'write'], timeoutMs: 45000 } };
    expect(serverToForm(remote)).toMatchObject({ id: 'remote', transport: 'http', headerEnv: 'Authorization=MCP_TOKEN', oauthEnabled: true, oauthScopes: 'read write', oauthTimeoutMs: '45000' });
    expect(buildServerPayload(serverToForm(remote))).toEqual(remote);
    const stdio = { id: 'stdio', name: 'Stdio', transport: 'stdio' as const, command: 'node', args: ['--prompt', 'hello world'], cwd: '/tmp', envRefs: { TOKEN: 'TOKEN_ENV' } };
    expect(buildServerPayload(serverToForm(stdio))).toEqual(stdio);
  });

  test('groups trace events by case and type while preserving event order', () => {
    const groups = groupTrace([
      { id: '1', caseId: 'a', type: 'model_turn' },
      { id: '2', caseId: 'a', type: 'tool_call' },
      { id: '3', caseId: 'b', type: 'assertion' },
    ]);
    expect(groups.a?.map((event) => event.id)).toEqual(['1', '2']);
    expect(groups.b?.[0]?.type).toBe('assertion');
  });

  test('builds observability trace rows with relative waterfall positions', () => {
    const rows = buildTraceRows([
      { id: 'model', caseId: 'sample', type: 'model_turn', timestamp: '2026-08-13T10:00:00.100Z', durationMs: 100, data: { turn: 1, usage: { total: 12 } }, sanitized: true },
      { id: 'tool', caseId: 'sample', type: 'tool_call', timestamp: '2026-08-13T10:00:00.160Z', durationMs: 40, data: { name: 'calendar' }, sanitized: true },
      { id: 'stop', caseId: 'sample', type: 'stop', timestamp: '2026-08-13T10:00:00.180Z', data: { reason: 'complete' }, sanitized: true },
    ], 180);
    expect(rows.map((row) => row.kind)).toEqual(['model', 'tool', 'agent']);
    expect(rows[0]).toMatchObject({ name: 'Model turn 1', durationMs: 100, offsetPct: 0 });
    expect(rows[1]!.offsetPct).toBeGreaterThan(rows[0]!.offsetPct);
    expect(rows[1]!.widthPct).toBeGreaterThan(0);
    expect(traceWindowMs([
      { id: 'first', caseId: 'a', type: 'model_turn', timestamp: '2026-08-13T10:00:00.100Z', durationMs: 100 },
      { id: 'second', caseId: 'a', type: 'model_turn', timestamp: '2026-08-13T10:00:10.100Z', durationMs: 100 },
    ], 200)).toBe(10_100);
  });

  test('normalizes rich MCP result content without accepting unsafe image types', () => {
    const blocks = normalizeMcpContent({ content: [
      { type: 'text', text: '**done**' },
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      { type: 'image', mimeType: 'text/html', data: 'bad' },
      { type: 'resource_link', uri: 'https://example.test/report', name: 'Report' },
      { type: 'resource', resource: { uri: 'file:///tmp/result.md', mimeType: 'text/markdown', text: '# Result' } },
    ], structuredContent: { ok: true } });
    expect(blocks.map((block) => block.type)).toEqual(['text', 'image', 'unsupported', 'resource_link', 'resource', 'structured']);
    expect(blocks[2]).toMatchObject({ type: 'unsupported' });
  });

  test('builds schema-driven tool fields and typed nested arguments', () => {
    const fields = buildToolFields({
      type: 'object',
      required: ['query', 'limit'],
      properties: {
        query: { type: 'string', title: 'Search query', description: 'Words to search' },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
        mode: { type: 'string', enum: ['fast', 'deep'], default: 'fast' },
        includeArchived: { type: 'boolean' },
        filters: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } },
      },
    });
    expect(fields.map((field) => field.key)).toEqual(['query', 'limit', 'mode', 'includeArchived', 'filters']);
    expect(fields[0]).toMatchObject({ label: 'Search query', required: true, kind: 'string' });
    expect(buildToolArguments(fields, {
      query: 'MCP', limit: '3', mode: 'enum:1', includeArchived: 'true', filters: '{"tags":["tools","ai"]}',
    })).toEqual({ query: 'MCP', limit: 3, mode: 'deep', includeArchived: true, filters: { tags: ['tools', 'ai'] } });
    expect(buildToolArguments(fields, { query: 'MCP', limit: '3', mode: 'enum:0', includeArchived: '', filters: '' })).toEqual({ query: 'MCP', limit: 3, mode: 'fast' });
    expect(buildToolArguments(fields, { query: 'MCP', limit: '3', mode: 'enum:0', includeArchived: 'false', filters: '' })).toEqual({ query: 'MCP', limit: 3, mode: 'fast', includeArchived: false });
    expect(() => buildToolArguments(fields, { query: '', limit: '', mode: 'enum:0', includeArchived: '', filters: '' })).toThrow(/query.*required/i);
  });

  test('supports root map arguments and RFC 3339 date-time values', () => {
    const mapFields = buildToolFields({ type: 'object', additionalProperties: { type: 'string' } });
    expect(mapFields).toMatchObject([{ key: '$', kind: 'object', required: true }]);
    expect(buildToolArguments(mapFields, { $: '{"x-team":"platform"}' })).toEqual({ 'x-team': 'platform' });

    const dateFields = buildToolFields({ type: 'object', required: ['startsAt'], properties: { startsAt: { type: 'string', format: 'date-time' } } });
    expect(buildToolArguments(dateFields, { startsAt: '2026-08-13T10:30:00Z' })).toEqual({ startsAt: '2026-08-13T10:30:00.000Z' });
    expect(() => buildToolArguments(dateFields, { startsAt: 'not-a-date' })).toThrow(/valid date-time/i);
  });

  test('creates a versioned agent suite from a playground interaction', () => {
    const source = buildSuiteFromPlayground({ name: 'saved-playground', server: 'sample', provider: 'local', model: 'fast', prompt: 'Add 2 and 3', expectedText: '5' });
    expect(source).toContain('version: 1');
    expect(source).toContain('kind: agent');
    expect(source).toContain('provider: local');
    expect(source).not.toMatch(/api[_-]?key|token:/i);
  });

  test('formats signed comparison deltas', () => {
    expect(signedDelta(0.5, '%')).toBe('+0.50%');
    expect(signedDelta(-12, ' ms')).toBe('-12.00 ms');
  });
});
