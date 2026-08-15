import { randomUUID } from 'node:crypto';
import { registerSecretValue, unregisterSecretValue } from '../core/redaction.js';
import type { CreateSecretInput, ManagedSecretBackend, SecretMetadata, SecretPurpose } from './types.js';
import { SecretStoreError } from './store-error.js';

type SessionEntry = {
  metadata: SecretMetadata;
  value: string;
};

export class SessionSecretBackend implements ManagedSecretBackend {
  readonly source = 'session' as const;
  private readonly entries = new Map<string, SessionEntry>();

  async create(input: Omit<CreateSecretInput, 'backend'>): Promise<SecretMetadata> {
    const now = new Date().toISOString();
    const metadata: SecretMetadata = {
      id: `secret_${randomUUID()}`,
      label: input.label,
      backend: 'session',
      purposes: [...input.purposes],
      configured: true,
      createdAt: now,
      updatedAt: now,
    };
    this.entries.set(metadata.id, { metadata, value: input.value });
    registerSecretValue(input.value);
    return cloneMetadata(metadata);
  }

  async list(): Promise<SecretMetadata[]> {
    return [...this.entries.values()].map(({ metadata }) => cloneMetadata(metadata));
  }

  async replace(id: string, value: string): Promise<SecretMetadata> {
    const entry = this.requireEntry(id);
    unregisterSecretValue(entry.value);
    entry.value = value;
    registerSecretValue(value);
    entry.metadata.updatedAt = new Date().toISOString();
    return cloneMetadata(entry.metadata);
  }

  async delete(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;
    unregisterSecretValue(entry.value);
    return this.entries.delete(id);
  }

  async resolve(id: string, purpose: SecretPurpose): Promise<string> {
    const entry = this.requireEntry(id);
    if (!entry.metadata.purposes.includes(purpose)) {
      throw new SecretStoreError('SECRET_PURPOSE_DENIED', `Secret ${id} cannot be used for ${purpose}`);
    }
    entry.metadata.lastUsedAt = new Date().toISOString();
    return entry.value;
  }

  async clear(): Promise<void> {
    for (const entry of this.entries.values()) unregisterSecretValue(entry.value);
    this.entries.clear();
  }

  private requireEntry(id: string): SessionEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new SecretStoreError('SECRET_NOT_FOUND', `Secret ${id} was not found`);
    return entry;
  }
}

function cloneMetadata(metadata: SecretMetadata): SecretMetadata {
  return { ...metadata, purposes: [...metadata.purposes] };
}
