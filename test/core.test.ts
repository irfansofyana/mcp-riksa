import { describe, expect, test } from 'vitest';
import { redact, REDACTED, registerSecretValue, unregisterSecretValue } from '../src/core/redaction.js';
import { parseSuite } from '../src/core/suite.js';

describe('redaction', () => {
  test('redacts short credentials and releases scoped registrations', () => {
    registerSecretValue('q7');
    expect(redact({ arbitrary: 'echo q7' })).toEqual({ arbitrary: `echo ${REDACTED}` });
    unregisterSecretValue('q7');
    expect(redact({ arbitrary: 'echo q7' })).toEqual({ arbitrary: 'echo q7' });
  });

  test('redacts resolved environment secrets even when reflected under arbitrary keys or text', () => {
    registerSecretValue('company-gateway-secret');
    const output = redact({ debug: 'company-gateway-secret', message: 'upstream echoed company-gateway-secret unexpectedly' });
    expect(JSON.stringify(output)).not.toContain('company-gateway-secret');
    expect(output).toEqual({ debug: REDACTED, message: `upstream echoed ${REDACTED} unexpectedly` });
  });
  test('preserves validated opaque secret references while redacting plaintext secret fields', () => {
    const references = {
      apiKey: { source: 'vault', id: 'secret_00000000-0000-4000-8000-000000000001' },
      headers: { Authorization: { source: 'env', name: 'MCP_SERVER_TOKEN' } },
      env: { TOKEN: { source: 'session', id: 'secret_00000000-0000-4000-8000-000000000002' } },
    };

    expect(redact(references)).toEqual(references);
    expect(redact({ apiKey: 'plaintext', Authorization: 'Bearer plaintext' })).toEqual({
      apiKey: REDACTED,
      Authorization: REDACTED,
    });
  });

  test('redacts authorization headers, cookies, token fields, query secrets, and nested payloads immutably', () => {
    const input = {
      headers: {
        Authorization: 'Bearer top-secret',
        cookie: 'session=super-secret',
        'x-request-id': 'safe-id',
      },
      url: 'https://example.test/mcp?token=query-secret&view=tools&api_key=other-secret',
      nested: [{ accessToken: 'nested-secret', safe: 'visible' }],
      message: 'Authorization: Bearer embedded-secret',
    };

    const output = redact(input);

    expect(output).toEqual({
      headers: {
        Authorization: REDACTED,
        cookie: REDACTED,
        'x-request-id': 'safe-id',
      },
      url: `https://example.test/mcp?token=${encodeURIComponent(REDACTED)}&view=tools&api_key=${encodeURIComponent(REDACTED)}`,
      nested: [{ accessToken: REDACTED, safe: 'visible' }],
      message: `Authorization: Bearer ${REDACTED}`,
    });
    expect(input.headers.Authorization).toBe('Bearer top-secret');
  });
});

const validSuite = `
version: 1
name: sample-suite
cases:
  - id: direct-add
    kind: direct
    server: sample
    call:
      tool: add
      arguments:
        a: 2
        b: 3
    assertions:
      - type: tool_called
        tool: add
  - id: agent-add
    kind: agent
    server: sample
    provider: local-openai
    model: test-model
    prompt: Add two and three
    limits:
      maxTurns: 4
      maxToolCalls: 2
      timeoutMs: 5000
      maxCostUsd: 0.02
    assertions:
      - type: contains
        value: "5"
`;

describe('suite parsing', () => {
  test('parses a versioned direct and agent suite', () => {
    const suite = parseSuite(validSuite);
    expect(suite.name).toBe('sample-suite');
    expect(suite.cases.map((entry) => entry.kind)).toEqual(['direct', 'agent']);
  });

  test.each([
    ['unknown top-level keys', `${validSuite}\nunexpected: true`],
    ['malformed direct calls', validSuite.replace('tool: add', 'tool: ""')],
    ['invalid limits', validSuite.replace('maxTurns: 4', 'maxTurns: 0')],
    ['duplicate case IDs', validSuite.replace('id: agent-add', 'id: direct-add')],
    ['inline secrets', validSuite.replace('provider: local-openai', 'provider: local-openai\n    apiKey: raw-secret')],
    ['nested inline secrets', validSuite.replace('a: 2', 'a: 2\n        authorization: Bearer secret')],
  ])('rejects %s', (_label, source) => {
    expect(() => parseSuite(source)).toThrow();
  });
});
