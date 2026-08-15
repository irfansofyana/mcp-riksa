import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { registerSecretValue, unregisterSecretValue } from '../core/redaction.js';
import { SecretStoreError } from './store-error.js';
import {
  secretMetadataSchema,
  type CreateSecretInput,
  type ManagedSecretBackend,
  type SecretMetadata,
  type SecretPurpose,
} from './types.js';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AAD = Buffer.from('mcp-riksa-vault:v1', 'utf8');
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

const envelopeSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal('aes-256-gcm'),
  nonce: z.string().min(1),
  tag: z.string().min(1),
  ciphertext: z.string().min(1),
}).strict();

const entrySchema = z.object({
  metadata: secretMetadataSchema,
  value: z.string().min(4),
}).strict();

const payloadSchema = z.object({
  version: z.literal(1),
  entries: z.array(entrySchema),
}).strict();

type VaultEntry = z.infer<typeof entrySchema>;

type EncryptedFileOptions = {
  dataDirectory: string;
  configDirectory: string;
};

export class EncryptedFileSecretBackend implements ManagedSecretBackend {
  readonly source = 'vault' as const;
  readonly vaultPath: string;
  readonly keyPath: string;
  readonly lockPath: string;
  private key?: Buffer;
  private readonly registeredValues = new Map<string, string>();

  constructor(private readonly options: EncryptedFileOptions) {
    this.vaultPath = join(options.dataDirectory, 'secrets.vault');
    this.keyPath = join(options.configDirectory, 'mcp-riksa', 'vault.key');
    this.lockPath = join(options.dataDirectory, 'secrets.vault.lock');
  }

  async create(input: Omit<CreateSecretInput, 'backend'>): Promise<SecretMetadata> {
    return this.withVaultLock(() => {
      const entries = this.readEntries();
      this.requireKey(true);
      const now = new Date().toISOString();
      const metadata: SecretMetadata = {
        id: `secret_${randomUUID()}`,
        label: input.label,
        backend: 'encrypted-file',
        purposes: [...input.purposes],
        configured: true,
        createdAt: now,
        updatedAt: now,
      };
      entries.push({ metadata, value: input.value });
      this.writeEntries(entries);
      return cloneMetadata(metadata);
    });
  }

  async list(): Promise<SecretMetadata[]> {
    return this.readEntries().map(({ metadata }) => cloneMetadata(metadata));
  }

  async replace(id: string, value: string): Promise<SecretMetadata> {
    return this.withVaultLock(() => {
      const entries = this.readEntries();
      const entry = requireEntry(entries, id);
      const registered = this.registeredValues.get(id);
      entry.value = value;
      entry.metadata.updatedAt = new Date().toISOString();
      this.writeEntries(entries);
      if (registered !== undefined) {
        unregisterSecretValue(registered);
        registerSecretValue(value);
        this.registeredValues.set(id, value);
      }
      return cloneMetadata(entry.metadata);
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.withVaultLock(() => {
      const entries = this.readEntries();
      const index = entries.findIndex((entry) => entry.metadata.id === id);
      if (index < 0) return false;
      const registered = this.registeredValues.get(id);
      entries.splice(index, 1);
      this.writeEntries(entries);
      if (registered !== undefined) {
        unregisterSecretValue(registered);
        this.registeredValues.delete(id);
      }
      return true;
    });
  }

  async resolve(id: string, purpose: SecretPurpose): Promise<string> {
    const entries = this.readEntries();
    const entry = requireEntry(entries, id);
    if (!entry.metadata.purposes.includes(purpose)) {
      throw new SecretStoreError('SECRET_PURPOSE_DENIED', `Secret ${id} cannot be used for ${purpose}`);
    }
    const registered = this.registeredValues.get(id);
    if (registered !== entry.value) {
      if (registered !== undefined) unregisterSecretValue(registered);
      registerSecretValue(entry.value);
      this.registeredValues.set(id, entry.value);
    }
    return entry.value;
  }

  async clear(): Promise<void> {
    for (const value of this.registeredValues.values()) unregisterSecretValue(value);
    this.registeredValues.clear();
    this.key?.fill(0);
    this.key = undefined;
  }

  async status(): Promise<{ state: 'empty' | 'ready' | 'missing-key' | 'invalid-key' | 'insecure-permissions' | 'corrupt' }> {
    const hasVault = existsSync(this.vaultPath);
    const hasKey = existsSync(this.keyPath);
    if (!hasVault && !hasKey) return { state: 'empty' };
    if (hasVault && !hasKey) return { state: 'missing-key' };
    try {
      if (hasVault) this.readEntries();
      else this.requireKey(false);
      return { state: 'ready' };
    } catch (error) {
      if (error instanceof SecretStoreError) {
        if (error.code === 'SECRET_VAULT_MISSING_KEY') return { state: 'missing-key' };
        if (error.code === 'SECRET_VAULT_INVALID_KEY') return { state: 'invalid-key' };
        if (error.code === 'SECRET_VAULT_INSECURE_PERMISSIONS') return { state: 'insecure-permissions' };
      }
      return { state: 'corrupt' };
    }
  }

  async reset(options: { rotateInvalidKey?: boolean } = {}): Promise<void> {
    await this.withVaultLock(() => {
      for (const value of this.registeredValues.values()) unregisterSecretValue(value);
      this.registeredValues.clear();
      this.key?.fill(0);
      this.key = undefined;
      let rotateKey = false;
      if (options.rotateInvalidKey && existsSync(this.keyPath)) {
        this.assertRegularSecureFile(this.keyPath, 'key');
        const persisted = readFileSync(this.keyPath);
        rotateKey = persisted.length !== KEY_BYTES;
        persisted.fill(0);
        if (!rotateKey) {
          throw new SecretStoreError('SECRET_INVALID', 'Refusing to replace a valid shared vault key');
        }
      }
      if (existsSync(this.vaultPath)) {
        this.assertRegularSecureFile(this.vaultPath, 'vault');
        unlinkSync(this.vaultPath);
        this.fsyncDirectory(dirname(this.vaultPath));
      }
      if (rotateKey) {
        unlinkSync(this.keyPath);
        this.fsyncDirectory(dirname(this.keyPath));
      }
    });
  }

  private prepareLockDatabase(): void {
    if (existsSync(this.lockPath)) {
      this.assertRegularSecureFile(this.lockPath, 'lock database');
      return;
    }
    try {
      this.writeExclusive(this.lockPath, Buffer.alloc(0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      this.assertRegularSecureFile(this.lockPath, 'lock database');
    }
  }

  private async withVaultLock<T>(operation: () => T): Promise<T> {
    this.ensureSecureDirectory(this.options.dataDirectory);
    let database: Database.Database | undefined;
    let transactionOpen = false;
    try {
      this.prepareLockDatabase();
      database = new Database(this.lockPath, { timeout: 10_000 });
      database.exec('BEGIN IMMEDIATE');
      transactionOpen = true;
      const result = operation();
      database.exec('COMMIT');
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) {
        try { database?.exec('ROLLBACK'); } catch { /* The connection may already have rolled back. */ }
      }
      if ((error as { code?: string }).code === 'SQLITE_BUSY') {
        throw new SecretStoreError('SECRET_BACKEND_UNAVAILABLE', 'The encrypted MCP Riksa vault is busy in another process', { cause: error });
      }
      throw error;
    } finally {
      database?.close();
    }
  }

  private readEntries(): VaultEntry[] {
    if (!existsSync(this.vaultPath)) return [];
    this.assertRegularSecureFile(this.vaultPath, 'vault');
    const key = this.requireKey(false);
    try {
      const envelope = envelopeSchema.parse(JSON.parse(readFileSync(this.vaultPath, 'utf8')));
      const nonce = Buffer.from(envelope.nonce, 'base64url');
      const tag = Buffer.from(envelope.tag, 'base64url');
      const ciphertext = Buffer.from(envelope.ciphertext, 'base64url');
      if (nonce.length !== NONCE_BYTES || tag.length !== 16 || ciphertext.length === 0) throw new Error('Invalid envelope lengths');
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(AAD);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      try {
        const payload = payloadSchema.parse(JSON.parse(plaintext.toString('utf8')));
        return payload.entries.map((entry) => ({
          metadata: cloneMetadata(entry.metadata),
          value: entry.value,
        }));
      } finally {
        plaintext.fill(0);
      }
    } catch (error) {
      if (error instanceof SecretStoreError) throw error;
      throw new SecretStoreError('SECRET_VAULT_CORRUPT', 'The encrypted MCP Riksa vault is corrupt or its key does not match', { cause: error });
    }
  }

  private writeEntries(entries: VaultEntry[]): void {
    const key = this.requireKey(true);
    this.ensureSecureDirectory(this.options.dataDirectory);
    if (existsSync(this.vaultPath)) this.assertRegularSecureFile(this.vaultPath, 'vault');

    const plaintext = Buffer.from(JSON.stringify({ version: 1, entries }), 'utf8');
    try {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(AAD);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const envelope = JSON.stringify({
        version: 1,
        algorithm: 'aes-256-gcm',
        nonce: nonce.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
      });
      this.atomicWrite(this.vaultPath, Buffer.from(envelope, 'utf8'));
    } finally {
      plaintext.fill(0);
    }
  }

  private requireKey(allowCreate: boolean): Buffer {
    if (this.key) {
      if (!existsSync(this.keyPath)) {
        this.key.fill(0);
        this.key = undefined;
        throw new SecretStoreError('SECRET_VAULT_MISSING_KEY', 'The MCP Riksa vault exists but its key is missing');
      }
      this.assertRegularSecureFile(this.keyPath, 'key');
      const persisted = readFileSync(this.keyPath);
      const matches = persisted.length === KEY_BYTES && timingSafeEqual(this.key, persisted);
      persisted.fill(0);
      if (!matches) {
        this.key.fill(0);
        this.key = undefined;
        throw new SecretStoreError('SECRET_VAULT_CORRUPT', 'The MCP Riksa vault key changed while the vault was in use');
      }
      return this.key;
    }
    if (existsSync(this.keyPath)) {
      this.assertRegularSecureFile(this.keyPath, 'key');
      const value = readFileSync(this.keyPath);
      if (value.length !== KEY_BYTES) {
        value.fill(0);
        throw new SecretStoreError('SECRET_VAULT_INVALID_KEY', 'The MCP Riksa vault key has an invalid length');
      }
      this.key = Buffer.from(value);
      value.fill(0);
      return this.key;
    }
    if (existsSync(this.vaultPath)) {
      throw new SecretStoreError('SECRET_VAULT_MISSING_KEY', 'The MCP Riksa vault exists but its key is missing');
    }
    if (!allowCreate) {
      throw new SecretStoreError('SECRET_VAULT_MISSING_KEY', 'The MCP Riksa vault key has not been created');
    }
    this.ensureSecureDirectory(join(this.options.configDirectory, 'mcp-riksa'));
    const key = randomBytes(KEY_BYTES);
    try {
      try {
        this.writeExclusive(this.keyPath, key);
        this.key = Buffer.from(key);
        return this.key;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const value = readFileSync(this.keyPath);
          if (value.length === KEY_BYTES) {
            this.assertRegularSecureFile(this.keyPath, 'key');
            this.fsyncDirectory(dirname(this.keyPath));
            this.key = Buffer.from(value);
            value.fill(0);
            return this.key;
          }
          value.fill(0);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
        throw new SecretStoreError('SECRET_VAULT_CORRUPT', 'The MCP Riksa vault key could not be initialized safely');
      }
    } finally {
      key.fill(0);
    }
  }

  private ensureSecureDirectory(path: string): void {
    const created: string[] = [];
    for (let candidate = path; !existsSync(candidate); candidate = dirname(candidate)) {
      created.push(candidate);
      if (dirname(candidate) === candidate) break;
    }
    mkdirSync(path, { recursive: true, mode: 0o700 });
    for (const directory of created) this.fsyncDirectory(dirname(directory));
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new SecretStoreError('SECRET_VAULT_INSECURE_PERMISSIONS', 'A vault directory is not a regular directory');
    }
    if (process.platform !== 'win32') {
      if (process.getuid !== undefined && stat.uid !== process.getuid()) {
        throw new SecretStoreError('SECRET_VAULT_INSECURE_PERMISSIONS', 'A vault directory is not owned by the current OS user');
      }
      if (created.includes(path)) chmodSync(path, 0o700);
      else if ((stat.mode & 0o022) !== 0) {
        throw new SecretStoreError('SECRET_VAULT_INSECURE_PERMISSIONS', 'An existing vault directory is writable by other users');
      }
    }
  }

  private assertRegularSecureFile(path: string, label: 'key' | 'vault' | 'lock database'): void {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new SecretStoreError('SECRET_VAULT_INSECURE_PERMISSIONS', `The MCP Riksa vault ${label} is not a regular file`);
    }
    if (process.platform !== 'win32') {
      if (process.getuid !== undefined && stat.uid !== process.getuid()) {
        throw new SecretStoreError('SECRET_VAULT_INSECURE_PERMISSIONS', `The MCP Riksa vault ${label} is not owned by the current OS user`);
      }
      if ((stat.mode & 0o077) !== 0) {
        throw new SecretStoreError('SECRET_VAULT_INSECURE_PERMISSIONS', `The MCP Riksa vault ${label} is readable by other users`);
      }
    }
  }

  private fsyncDirectory(path: string): void {
    if (process.platform === 'win32') return;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, constants.O_RDONLY | NOFOLLOW);
      fsyncSync(descriptor);
    } catch (error) {
      throw new SecretStoreError('SECRET_BACKEND_UNAVAILABLE', 'Unable to durably persist the MCP Riksa vault directory entry', { cause: error });
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  private writeExclusive(path: string, content: Buffer): void {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      writeFileSync(descriptor, content);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      this.fsyncDirectory(dirname(path));
    } catch (error) {
      if (error instanceof SecretStoreError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw error;
      throw new SecretStoreError('SECRET_VAULT_INSECURE_PERMISSIONS', 'Unable to create the MCP Riksa vault key securely', { cause: error });
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  private atomicWrite(path: string, content: Buffer): void {
    const temporary = `${path}.tmp-${randomUUID()}`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      writeFileSync(descriptor, content);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, path);
      this.fsyncDirectory(dirname(path));
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}

function requireEntry(entries: VaultEntry[], id: string): VaultEntry {
  const entry = entries.find((candidate) => candidate.metadata.id === id);
  if (!entry) throw new SecretStoreError('SECRET_NOT_FOUND', `Secret ${id} was not found`);
  return entry;
}

function cloneMetadata(metadata: SecretMetadata): SecretMetadata {
  return { ...metadata, purposes: [...metadata.purposes] };
}
