import { registerSecretValue, unregisterSecretValue } from '../core/redaction.js';
import { SessionSecretBackend } from './session.js';
import { SecretStoreError } from './store-error.js';
import {
  createSecretSchema,
  secretPurposeSchema,
  secretReferenceSchema,
  type CreateSecretInput,
  type ManagedSecretBackend,
  type SecretMetadata,
  type SecretPurpose,
  type SecretReference,
} from './types.js';

export { SecretStoreError } from './store-error.js';
export type { CreateSecretInput, SecretMetadata, SecretPurpose, SecretReference } from './types.js';

type SecretStoreOptions = {
  environment?: NodeJS.ProcessEnv;
  sessionBackend?: ManagedSecretBackend;
  vaultBackend?: ManagedSecretBackend;
};

export class SecretStore {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly session: ManagedSecretBackend;
  private readonly vault?: ManagedSecretBackend;
  private readonly registeredEnvironmentValues = new Set<string>();

  constructor(options: SecretStoreOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.session = options.sessionBackend ?? new SessionSecretBackend();
    this.vault = options.vaultBackend;
  }

  async create(input: CreateSecretInput): Promise<SecretMetadata> {
    const parsed = this.parseCreate(input);
    return this.backend(parsed.backend).create({
      label: parsed.label,
      purposes: parsed.purposes,
      value: parsed.value,
    });
  }

  async list(): Promise<SecretMetadata[]> {
    const [session, vault] = await Promise.all([
      this.session.list(),
      this.vault?.list() ?? Promise.resolve([]),
    ]);
    return [...vault, ...session].sort((left, right) => left.label.localeCompare(right.label));
  }

  async replace(id: string, value: string): Promise<SecretMetadata> {
    if (value.length < 4) throw new SecretStoreError('SECRET_INVALID', 'Secret values must contain at least 4 characters');
    const backend = await this.findBackend(id);
    return backend.replace(id, value);
  }

  async delete(id: string): Promise<boolean> {
    const backend = await this.findBackend(id);
    return backend.delete(id);
  }

  async resolve(reference: SecretReference, purpose: SecretPurpose): Promise<string> {
    const parsedReference = this.parseReference(reference);
    const parsedPurpose = this.parsePurpose(purpose);
    if (parsedReference.source === 'env') {
      const value = this.environment[parsedReference.name];
      if (value === undefined) {
        throw new SecretStoreError('SECRET_ENV_MISSING', `Environment variable ${parsedReference.name} is not set`);
      }
      if (!this.registeredEnvironmentValues.has(value)) {
        registerSecretValue(value);
        this.registeredEnvironmentValues.add(value);
      }
      return value;
    }
    return this.backend(parsedReference.source).resolve(parsedReference.id, parsedPurpose);
  }

  async isConfigured(reference: SecretReference): Promise<boolean> {
    const parsed = this.parseReference(reference);
    if (parsed.source === 'env') return this.environment[parsed.name] !== undefined;
    const backend = parsed.source === 'session' ? this.session : this.vault;
    if (!backend) return false;
    try {
      return (await backend.list()).some((entry) => entry.id === parsed.id && entry.configured);
    } catch (error) {
      if (parsed.source === 'vault' && error instanceof SecretStoreError) return false;
      throw error;
    }
  }

  async clearSession(): Promise<void> {
    await this.session.clear?.();
  }

  async close(): Promise<void> {
    await Promise.all([this.session.clear?.(), this.vault?.clear?.()]);
    for (const value of this.registeredEnvironmentValues) unregisterSecretValue(value);
    this.registeredEnvironmentValues.clear();
  }

  private backend(source: 'vault' | 'session'): ManagedSecretBackend {
    if (source === 'session') return this.session;
    if (this.vault) return this.vault;
    throw new SecretStoreError('SECRET_BACKEND_UNAVAILABLE', 'The encrypted MCP Riksa vault is unavailable');
  }

  private async findBackend(id: string): Promise<ManagedSecretBackend> {
    if ((await this.session.list()).some((entry) => entry.id === id)) return this.session;
    if (this.vault && (await this.vault.list()).some((entry) => entry.id === id)) return this.vault;
    throw new SecretStoreError('SECRET_NOT_FOUND', `Secret ${id} was not found`);
  }

  private parseReference(reference: SecretReference): SecretReference {
    const result = secretReferenceSchema.safeParse(reference);
    if (!result.success) throw new SecretStoreError('SECRET_INVALID', result.error.issues[0]?.message ?? 'Invalid secret reference', { cause: result.error });
    return result.data;
  }

  private parsePurpose(purpose: SecretPurpose): SecretPurpose {
    const result = secretPurposeSchema.safeParse(purpose);
    if (!result.success) throw new SecretStoreError('SECRET_INVALID', result.error.issues[0]?.message ?? 'Invalid secret purpose', { cause: result.error });
    return result.data;
  }

  private parseCreate(input: CreateSecretInput): CreateSecretInput {
    const result = createSecretSchema.safeParse(input);
    if (!result.success) throw new SecretStoreError('SECRET_INVALID', result.error.issues[0]?.message ?? 'Invalid secret input', { cause: result.error });
    return result.data;
  }
}
