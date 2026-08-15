import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EncryptedFileSecretBackend } from '../src/secrets/encrypted-file.js';
import { SecretStore } from '../src/secrets/store.js';
import { createSecretResolutionLease } from '../src/secrets/lease.js';
import { redact } from '../src/core/redaction.js';

const roots: string[] = [];
const execFileAsync = promisify(execFile);
const tsxCli = resolve('node_modules/tsx/dist/cli.mjs');
const vaultWriter = resolve('test/fixtures/vault-writer.ts');

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'mcp-riksa-vault-'));
  roots.push(root);
  const dataDirectory = join(root, 'data');
  const configDirectory = join(root, 'config');
  const backend = new EncryptedFileSecretBackend({ dataDirectory, configDirectory });
  return {
    root,
    dataDirectory,
    configDirectory,
    vaultPath: join(dataDirectory, 'secrets.vault'),
    keyPath: join(configDirectory, 'mcp-riksa', 'vault.key'),
    backend,
    store: new SecretStore({ vaultBackend: backend }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('EncryptedFileSecretBackend', () => {
  test('creates a separated owner-only key and encrypted vault on first persistent save', async () => {
    const { store, vaultPath, keyPath, dataDirectory, configDirectory } = harness();
    const secret = 'provider-real-secret-4f28';

    const metadata = await store.create({
      backend: 'vault',
      label: 'Provider key',
      purposes: ['provider-api-key'],
      value: secret,
    });

    expect(metadata).toMatchObject({ backend: 'encrypted-file', configured: true });
    expect(readFileSync(keyPath)).toHaveLength(32);
    expect(readFileSync(vaultPath, 'utf8')).not.toContain(secret);
    expect(readFileSync(keyPath).toString('utf8')).not.toContain(secret);
    expect(keyPath.startsWith(dataDirectory)).toBe(false);
    expect(vaultPath.startsWith(configDirectory)).toBe(false);
    if (process.platform !== 'win32') {
      expect(lstatSync(keyPath).mode & 0o777).toBe(0o600);
      expect(lstatSync(vaultPath).mode & 0o777).toBe(0o600);
      expect(lstatSync(dataDirectory).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(configDirectory, 'mcp-riksa')).mode & 0o777).toBe(0o700);
    }
  });

  test('automatically decrypts persisted secrets after backend restart', async () => {
    const { store, dataDirectory, configDirectory } = harness();
    const value = 'restart-secret-value-71cf';
    const metadata = await store.create({
      backend: 'vault',
      label: 'Restart key',
      purposes: ['mcp-header'],
      value,
    });
    const beforeResolve = readFileSync(join(dataDirectory, 'secrets.vault'));
    await store.close();

    const restarted = new SecretStore({
      vaultBackend: new EncryptedFileSecretBackend({ dataDirectory, configDirectory }),
    });

    await expect(
      restarted.resolve({ source: 'vault', id: metadata.id }, 'mcp-header'),
    ).resolves.toBe(value);
    expect(readFileSync(join(dataDirectory, 'secrets.vault'))).toEqual(beforeResolve);
  });

  test('refreshes redaction registration after another process rotates a secret', async () => {
    const fixture = harness();
    const original = 'cross-process-original-secret';
    const rotated = 'cross-process-rotated-secret';
    const metadata = await fixture.store.create({ backend: 'vault', label: 'Rotated key', purposes: ['provider-api-key'], value: original });
    await expect(fixture.store.resolve({ source: 'vault', id: metadata.id }, 'provider-api-key')).resolves.toBe(original);

    const external = new SecretStore({
      vaultBackend: new EncryptedFileSecretBackend({ dataDirectory: fixture.dataDirectory, configDirectory: fixture.configDirectory }),
    });
    await external.replace(metadata.id, rotated);
    await expect(fixture.store.resolve({ source: 'vault', id: metadata.id }, 'provider-api-key')).resolves.toBe(rotated);

    expect(JSON.stringify(redact({ reflected: rotated }))).not.toContain(rotated);
    expect(JSON.stringify(redact({ reflected: original }))).toContain(original);
    await external.close();
    await fixture.store.close();
  });

  test('retains an old rotated value only while an active consumer still uses it', async () => {
    const fixture = harness();
    const metadata = await fixture.store.create({ backend: 'vault', label: 'Rotating', purposes: ['provider-api-key'], value: 'old-active-secret' });
    const external = new EncryptedFileSecretBackend({ dataDirectory: fixture.dataDirectory, configDirectory: fixture.configDirectory });
    const lease = createSecretResolutionLease(fixture.store.resolve.bind(fixture.store));
    expect(await lease.resolve({ source: 'vault', id: metadata.id }, 'provider-api-key')).toBe('old-active-secret');

    await external.replace(metadata.id, 'new-active-secret');
    await fixture.store.resolve({ source: 'vault', id: metadata.id }, 'provider-api-key');
    expect(redact('old-active-secret new-active-secret')).toBe('[REDACTED] [REDACTED]');

    lease.release();
    expect(redact('old-active-secret new-active-secret')).toBe('old-active-secret [REDACTED]');
    await external.clear();
    await fixture.store.close();
  });

  test('serializes vault mutations across processes', async () => {
    const fixture = harness();
    const writers = 4;
    const entriesPerWriter = 6;
    await Promise.all(Array.from({ length: writers }, (_, index) => execFileAsync(
      process.execPath,
      [tsxCli, vaultWriter, fixture.dataDirectory, fixture.configDirectory, `writer-${index}`, String(entriesPerWriter)],
      { cwd: resolve('.') },
    )));

    await expect(fixture.store.list()).resolves.toHaveLength(writers * entriesPerWriter);
  }, 30_000);

  test('shares a concurrently initialized key across data directories', async () => {
    const fixture = harness();
    const otherDataDirectory = join(fixture.root, 'other-data');
    await Promise.all([
      execFileAsync(process.execPath, [tsxCli, vaultWriter, fixture.dataDirectory, fixture.configDirectory, 'first', '1'], { cwd: resolve('.') }),
      execFileAsync(process.execPath, [tsxCli, vaultWriter, otherDataDirectory, fixture.configDirectory, 'second', '1'], { cwd: resolve('.') }),
    ]);
    const otherStore = new SecretStore({ vaultBackend: new EncryptedFileSecretBackend({ dataDirectory: otherDataDirectory, configDirectory: fixture.configDirectory }) });
    await expect(fixture.store.list()).resolves.toHaveLength(1);
    await expect(otherStore.list()).resolves.toHaveLength(1);
    await otherStore.close();
  });

  test('fails closed without overwriting a vault whose key is missing', async () => {
    const { store, backend, vaultPath, keyPath } = harness();
    await store.create({
      backend: 'vault',
      label: 'Protected key',
      purposes: ['provider-api-key'],
      value: 'protected-secret-cad7',
    });
    const before = readFileSync(vaultPath);
    unlinkSync(keyPath);

    await expect(backend.list()).rejects.toMatchObject({ code: 'SECRET_VAULT_MISSING_KEY' });
    await expect(
      backend.create({
        label: 'Must not overwrite',
        purposes: ['provider-api-key'],
        value: 'replacement-secret-bdf4',
      }),
    ).rejects.toMatchObject({ code: 'SECRET_VAULT_MISSING_KEY' });
    expect(readFileSync(vaultPath)).toEqual(before);
  });

  test('detects changed keys and tampered ciphertext without overwriting evidence', async () => {
    const changedKey = harness();
    await changedKey.store.create({
      backend: 'vault',
      label: 'Changed-key case',
      purposes: ['provider-api-key'],
      value: 'changed-key-secret-512c',
    });
    writeFileSync(changedKey.keyPath, randomBytes(32), { mode: 0o600 });
    const changedBefore = readFileSync(changedKey.vaultPath);
    await expect(
      new EncryptedFileSecretBackend({
        dataDirectory: changedKey.dataDirectory,
        configDirectory: changedKey.configDirectory,
      }).list(),
    ).rejects.toMatchObject({ code: 'SECRET_VAULT_CORRUPT' });
    expect(readFileSync(changedKey.vaultPath)).toEqual(changedBefore);

    const tampered = harness();
    await tampered.store.create({
      backend: 'vault',
      label: 'Tamper case',
      purposes: ['provider-api-key'],
      value: 'tampered-secret-f89d',
    });
    const envelope = JSON.parse(readFileSync(tampered.vaultPath, 'utf8')) as { ciphertext: string };
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
    writeFileSync(tampered.vaultPath, JSON.stringify(envelope), { mode: 0o600 });
    const tamperedBefore = readFileSync(tampered.vaultPath);
    await expect(tampered.backend.list()).rejects.toMatchObject({ code: 'SECRET_VAULT_CORRUPT' });
    expect(readFileSync(tampered.vaultPath)).toEqual(tamperedBefore);
  });

  test('does not change permissions on an existing caller-selected data directory', async () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'mcp-riksa-existing-data-'));
    roots.push(root);
    const dataDirectory = join(root, 'shared-project');
    const configDirectory = join(root, 'config');
    mkdirSync(dataDirectory, { mode: 0o755 });
    const store = new SecretStore({ vaultBackend: new EncryptedFileSecretBackend({ dataDirectory, configDirectory }) });

    await store.create({ backend: 'vault', label: 'Existing directory', purposes: ['provider-api-key'], value: 'existing-directory-secret' });

    expect(lstatSync(dataDirectory).mode & 0o777).toBe(0o755);
    await store.close();
  });

  test('rejects an existing world-writable data directory without changing its mode', async () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'mcp-riksa-world-writable-'));
    roots.push(root);
    const dataDirectory = join(root, 'shared');
    const configDirectory = join(root, 'config');
    mkdirSync(dataDirectory);
    chmodSync(dataDirectory, 0o777);
    const store = new SecretStore({ vaultBackend: new EncryptedFileSecretBackend({ dataDirectory, configDirectory }) });

    await expect(store.create({ backend: 'vault', label: 'Unsafe directory', purposes: ['provider-api-key'], value: 'unsafe-directory-secret' }))
      .rejects.toMatchObject({ code: 'SECRET_VAULT_INSECURE_PERMISSIONS' });
    expect(lstatSync(dataDirectory).mode & 0o777).toBe(0o777);
    await store.close();
  });

  test('rejects a lock database symlink without modifying its target', async () => {
    if (process.platform === 'win32') return;
    const fixture = harness();
    mkdirSync(fixture.dataDirectory, { recursive: true, mode: 0o700 });
    const target = join(fixture.root, 'unrelated-file');
    writeFileSync(target, 'unrelated');
    chmodSync(target, 0o644);
    symlinkSync(target, fixture.backend.lockPath);

    await expect(fixture.store.create({ backend: 'vault', label: 'Symlink lock', purposes: ['provider-api-key'], value: 'symlink-lock-secret' }))
      .rejects.toMatchObject({ code: 'SECRET_VAULT_INSECURE_PERMISSIONS' });
    expect(lstatSync(target).mode & 0o777).toBe(0o644);
    expect(readFileSync(target, 'utf8')).toBe('unrelated');
  });

  test('rejects group-readable key material', async () => {
    if (process.platform === 'win32') return;
    const fixture = harness();
    await fixture.store.create({
      backend: 'vault',
      label: 'Permission case',
      purposes: ['provider-api-key'],
      value: 'permission-secret-872e',
    });
    await fixture.store.close();
    chmodSync(fixture.keyPath, 0o640);

    await expect(
      new EncryptedFileSecretBackend({
        dataDirectory: fixture.dataDirectory,
        configDirectory: fixture.configDirectory,
      }).list(),
    ).rejects.toMatchObject({ code: 'SECRET_VAULT_INSECURE_PERMISSIONS' });
  });

  test('reports insecure permissions distinctly from vault corruption', async () => {
    if (process.platform === 'win32') return;
    const fixture = harness();
    await fixture.store.create({
      backend: 'vault',
      label: 'Permission status',
      purposes: ['provider-api-key'],
      value: 'permission-status-secret',
    });
    await fixture.store.close();
    chmodSync(fixture.keyPath, 0o640);

    await expect(new EncryptedFileSecretBackend({
      dataDirectory: fixture.dataDirectory,
      configDirectory: fixture.configDirectory,
    }).status()).resolves.toEqual({ state: 'insecure-permissions' });
  });

  test('recovers explicitly from a malformed shared key', async () => {
    const fixture = harness();
    await fixture.store.create({ backend: 'vault', label: 'Malformed key', purposes: ['provider-api-key'], value: 'malformed-key-secret' });
    await fixture.store.close();
    writeFileSync(fixture.keyPath, randomBytes(7), { mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(fixture.keyPath, 0o600);
    const restarted = new EncryptedFileSecretBackend({ dataDirectory: fixture.dataDirectory, configDirectory: fixture.configDirectory });

    await expect(restarted.status()).resolves.toEqual({ state: 'invalid-key' });
    await expect(restarted.reset()).resolves.toBeUndefined();
    expect(existsSync(fixture.keyPath)).toBe(true);
    await expect(restarted.reset({ rotateInvalidKey: true })).resolves.toBeUndefined();
    expect(existsSync(fixture.keyPath)).toBe(false);
    expect(existsSync(fixture.vaultPath)).toBe(false);

    const recovered = new SecretStore({ vaultBackend: new EncryptedFileSecretBackend({ dataDirectory: fixture.dataDirectory, configDirectory: fixture.configDirectory }) });
    await expect(recovered.create({ backend: 'vault', label: 'Recovered', purposes: ['provider-api-key'], value: 'recovered-secret' })).resolves.toMatchObject({ configured: true });
    expect(readFileSync(fixture.keyPath)).toHaveLength(32);
    await recovered.close();
  });

  test('reset removes only its vault and preserves a key shared by other data directories', async () => {
    const first = harness();
    const secondDataDirectory = join(first.root, 'second-data');
    const secondBackend = new EncryptedFileSecretBackend({
      dataDirectory: secondDataDirectory,
      configDirectory: first.configDirectory,
    });
    const secondStore = new SecretStore({ vaultBackend: secondBackend });
    await first.store.create({
      backend: 'vault', label: 'First vault', purposes: ['provider-api-key'], value: 'first-vault-secret',
    });
    const second = await secondStore.create({
      backend: 'vault', label: 'Second vault', purposes: ['mcp-header'], value: 'second-vault-secret',
    });

    await first.backend.reset();

    expect(existsSync(first.vaultPath)).toBe(false);
    expect(existsSync(first.keyPath)).toBe(true);
    await expect(secondStore.resolve({ source: 'vault', id: second.id }, 'mcp-header')).resolves.toBe('second-vault-secret');
    await secondStore.close();
  });

  test('rejects key material not owned by the current OS user', async () => {
    if (process.platform === 'win32' || process.getuid === undefined) return;
    const fixture = harness();
    await fixture.store.create({
      backend: 'vault',
      label: 'Ownership case',
      purposes: ['provider-api-key'],
      value: 'ownership-secret-872e',
    });
    await fixture.store.close();
    const owner = process.getuid();
    const getuid = vi.spyOn(process, 'getuid').mockReturnValue(owner + 1);
    try {
      await expect(
        new EncryptedFileSecretBackend({
          dataDirectory: fixture.dataDirectory,
          configDirectory: fixture.configDirectory,
        }).list(),
      ).rejects.toMatchObject({ code: 'SECRET_VAULT_INSECURE_PERMISSIONS' });
    } finally {
      getuid.mockRestore();
    }
  });
});
