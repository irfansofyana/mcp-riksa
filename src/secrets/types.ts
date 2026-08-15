import { z } from 'zod';
import { environmentVariableNameSchema } from '../core/environment.js';

export const secretPurposeSchema = z.enum([
  'provider-api-key',
  'provider-header',
  'mcp-header',
  'oauth-client-secret',
  'oauth-token',
  'stdio-env',
]);

const managedSecretIdSchema = z.string().regex(/^secret_[0-9a-f-]{36}$/i, 'Expected an opaque secret ID');

export const secretReferenceSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('env'), name: environmentVariableNameSchema }).strict(),
  z.object({ source: z.literal('vault'), id: managedSecretIdSchema }).strict(),
  z.object({ source: z.literal('session'), id: managedSecretIdSchema }).strict(),
]);

export const secretBackendSchema = z.enum(['encrypted-file', 'session']);

export const secretMetadataSchema = z.object({
  id: managedSecretIdSchema,
  label: z.string().trim().min(1).max(120),
  backend: secretBackendSchema,
  purposes: z.array(secretPurposeSchema).min(1).refine((items) => new Set(items).size === items.length, 'Duplicate secret purposes are not allowed'),
  configured: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const createSecretSchema = z.object({
  backend: z.enum(['vault', 'session']),
  label: z.string().trim().min(1).max(120),
  purposes: z.array(secretPurposeSchema).min(1).refine((items) => new Set(items).size === items.length, 'Duplicate secret purposes are not allowed'),
  value: z.string().min(4, 'Secret values must contain at least 4 characters'),
}).strict();

export type SecretPurpose = z.infer<typeof secretPurposeSchema>;
export type SecretReference = z.infer<typeof secretReferenceSchema>;
export type SecretRef = SecretReference;
export type SecretMetadata = z.infer<typeof secretMetadataSchema>;
export type CreateSecretInput = z.infer<typeof createSecretSchema>;
export type SecretResolver = (reference: SecretReference, purpose: SecretPurpose) => Promise<string>;

export interface ManagedSecretBackend {
  readonly source: 'vault' | 'session';
  create(input: Omit<CreateSecretInput, 'backend'>): Promise<SecretMetadata>;
  list(): Promise<SecretMetadata[]>;
  replace(id: string, value: string): Promise<SecretMetadata>;
  delete(id: string): Promise<boolean>;
  resolve(id: string, purpose: SecretPurpose): Promise<string>;
  clear?(): Promise<void>;
}
