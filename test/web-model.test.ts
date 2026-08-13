import { describe, expect, test } from 'vitest';
import {
  buildProviderPayload,
  buildServerPayload,
  buildSuiteFromPlayground,
  groupTrace,
  normalizePage,
  signedDelta,
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
      oauthScopes: 'mcp:read mcp:write', oauthClientId: 'static-client', oauthClientSecretEnv: 'MCP_OAUTH_SECRET',
    })).toMatchObject({
      id: 'remote', transport: 'http', url: 'http://127.0.0.1:3000/mcp', headerEnv: { Authorization: 'MCP_TOKEN' },
      oauth: { scopes: ['mcp:read', 'mcp:write'], clientId: 'static-client', clientSecretEnv: 'MCP_OAUTH_SECRET' },
    });
  });

  test('builds generic model provider payloads with aliases and env references', () => {
    expect(buildProviderPayload({
      id: 'local', name: 'Local', type: 'anthropic-compatible', baseUrl: 'http://127.0.0.1:4000/v1',
      alias: 'fast', model: 'test-model', apiKeyEnv: 'PROVIDER_KEY', headerEnv: 'x-team=TEAM_TOKEN',
      inputPrice: '1.5', outputPrice: '2.5',
    })).toMatchObject({ models: { fast: 'test-model' }, apiKeyEnv: 'PROVIDER_KEY', headerEnv: { 'x-team': 'TEAM_TOKEN' }, pricing: { inputPerMillion: 1.5, outputPerMillion: 2.5 } });
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
