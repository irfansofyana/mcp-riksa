import { afterEach, describe, expect, test } from 'vitest';
import { redact } from '../src/core/redaction.js';
import { SecretStore, SecretStoreError } from '../src/secrets/store.js';
import type { ManagedSecretBackend } from '../src/secrets/types.js';

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

  test('rejects short environment values before registering them for redaction', async () => {
    process.env[TEST_ENV] = 'a';
    const store = new SecretStore();

    await expect(store.resolve({ source: 'env', name: TEST_ENV }, 'provider-api-key')).rejects.toMatchObject({
      code: 'SECRET_INVALID',
      message: 'Secret values must contain at least 4 characters',
    });
    expect(redact('a normal sentence')).toBe('a normal sentence');
    await store.close();
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

  test('rejects secret values that are invalid for their declared header purposes', async () => {
    const store = new SecretStore();
    for (const purposes of [['provider-api-key'], ['provider-header'], ['mcp-header']] as const) {
      for (const value of ['with\rcarriage', 'with\nnewline', 'with\0nul']) {
        await expect(
          store.create({ backend: 'session', label: 'Bad header secret', purposes: [...purposes], value }),
        ).rejects.toMatchObject({ code: 'SECRET_INVALID', message: /must not contain CR, LF, or NUL/i });
      }
    }
    await store.close();
  });

  test('rejects stdio-env secret values containing NUL', async () => {
    const store = new SecretStore();
    await expect(
      store.create({ backend: 'session', label: 'Bad env secret', purposes: ['stdio-env'], value: 'with\0nul' }),
    ).rejects.toMatchObject({ code: 'SECRET_INVALID', message: /must not contain NUL/i });
    // CR/LF are structurally valid for environment values, so only NUL is rejected.
    await expect(
      store.create({ backend: 'session', label: 'Multiline env', purposes: ['stdio-env'], value: 'line-one\nline-two' }),
    ).resolves.toMatchObject({ configured: true });
    await store.close();
  });

  test('rejects a replacement value that is invalid for the existing purposes', async () => {
    const store = new SecretStore();
    const metadata = await store.create({
      backend: 'session',
      label: 'Header secret',
      purposes: ['mcp-header'],
      value: secretValue,
    });

    await expect(
      store.replace(metadata.id, 'bad\nheader-value'),
    ).rejects.toMatchObject({ code: 'SECRET_INVALID', message: /must not contain CR, LF, or NUL/i });
    await expect(
      store.resolve({ source: 'session', id: metadata.id }, 'mcp-header'),
    ).resolves.toBe(secretValue);
    await store.close();
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

    expect(await store.isConfigured({ source: 'session', id: metadata.id }, 'provider-api-key')).toBe(true);
    expect(await store.isConfigured({ source: 'session', id: metadata.id }, 'mcp-header')).toBe(false);
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

  test('keeps session secrets manageable when the vault is unavailable', async () => {
    const vaultError = () => new SecretStoreError('SECRET_VAULT_CORRUPT', 'Vault unavailable');
    const unavailableVault: ManagedSecretBackend = {
      source: 'vault',
      create: async () => { throw vaultError(); },
      list: async () => { throw vaultError(); },
      replace: async () => { throw vaultError(); },
      delete: async () => { throw vaultError(); },
      resolve: async () => { throw vaultError(); },
    };
    const store = new SecretStore({ vaultBackend: unavailableVault });
    const metadata = await store.create({ backend: 'session', label: 'Still manageable', purposes: ['provider-api-key'], value: 'session-survives-vault' });

    await expect(store.list()).resolves.toEqual([expect.objectContaining({ id: metadata.id, backend: 'session' })]);
    await store.close();
  });

  test('rejects malformed references before resolution', async () => {
    const store = new SecretStore();

    await expect(
      store.resolve({ source: 'env', name: 'not valid' }, 'provider-api-key'),
    ).rejects.toBeInstanceOf(SecretStoreError);
  });
});
