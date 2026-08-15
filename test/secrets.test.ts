import { afterEach, describe, expect, test } from 'vitest';
import { redact } from '../src/core/redaction.js';
import { SecretStore, SecretStoreError } from '../src/secrets/store.js';

const TEST_ENV = 'MCP_RIKSA_SECRET_TEST_VALUE';
const secretValue = 'vault-test-value-7c3f';

afterEach(() => {
  delete process.env[TEST_ENV];
});

describe('SecretStore', () => {
  test('resolves an environment reference at use time and registers it for redaction', async () => {
    process.env[TEST_ENV] = secretValue;
    const store = new SecretStore();

    const resolved = await store.resolve(
      { source: 'env', name: TEST_ENV },
      'provider-api-key',
    );

    expect(resolved).toBe(secretValue);
    expect(redact({ arbitrary: `upstream returned ${secretValue}` })).toEqual({
      arbitrary: 'upstream returned [REDACTED]',
    });
  });

  test('fails with an actionable error when an environment reference is missing', async () => {
    const store = new SecretStore();

    await expect(
      store.resolve({ source: 'env', name: TEST_ENV }, 'provider-api-key'),
    ).rejects.toMatchObject({
      code: 'SECRET_ENV_MISSING',
      message: `Environment variable ${TEST_ENV} is not set`,
    });
  });

  test('stores a session secret behind write-only metadata', async () => {
    const store = new SecretStore();

    const metadata = await store.create({
      backend: 'session',
      label: 'Development provider key',
      purposes: ['provider-api-key'],
      value: secretValue,
    });

    expect(metadata).toMatchObject({
      label: 'Development provider key',
      backend: 'session',
      configured: true,
      purposes: ['provider-api-key'],
    });
    expect(metadata.id).toMatch(/^secret_/);
    expect(JSON.stringify(metadata)).not.toContain(secretValue);
    expect(JSON.stringify(await store.list())).not.toContain(secretValue);

    const resolved = await store.resolve(
      { source: 'session', id: metadata.id },
      'provider-api-key',
    );
    expect(resolved).toBe(secretValue);
  });

  test('replaces a session value without returning either value', async () => {
    const store = new SecretStore();
    const metadata = await store.create({
      backend: 'session',
      label: 'Rotated key',
      purposes: ['provider-api-key'],
      value: secretValue,
    });

    const replacement = 'replacement-value-91ad';
    const updated = await store.replace(metadata.id, replacement);

    expect(JSON.stringify(updated)).not.toContain(secretValue);
    expect(JSON.stringify(updated)).not.toContain(replacement);
    await expect(
      store.resolve({ source: 'session', id: metadata.id }, 'provider-api-key'),
    ).resolves.toBe(replacement);
  });

  test('enforces purpose binding and clears session secrets', async () => {
    const store = new SecretStore();
    const clearableValue = 'session-clear-lifecycle-61f4';
    const metadata = await store.create({
      backend: 'session',
      label: 'Provider only',
      purposes: ['provider-api-key'],
      value: clearableValue,
    });

    await expect(
      store.resolve({ source: 'session', id: metadata.id }, 'mcp-header'),
    ).rejects.toMatchObject({ code: 'SECRET_PURPOSE_DENIED' });

    expect(redact({ arbitrary: clearableValue })).toEqual({ arbitrary: '[REDACTED]' });
    await store.clearSession();
    expect(redact({ arbitrary: clearableValue })).toEqual({ arbitrary: clearableValue });
    await expect(
      store.resolve({ source: 'session', id: metadata.id }, 'provider-api-key'),
    ).rejects.toMatchObject({ code: 'SECRET_NOT_FOUND' });
  });

  test('rejects malformed references before resolution', async () => {
    const store = new SecretStore();

    await expect(
      store.resolve({ source: 'env', name: 'not valid' }, 'provider-api-key'),
    ).rejects.toBeInstanceOf(SecretStoreError);
  });
});
