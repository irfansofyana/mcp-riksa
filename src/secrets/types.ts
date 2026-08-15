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

export const SECRET_VALUE_MIN_LENGTH = 4;
export const SECRET_VALUE_TOO_SHORT_MESSAGE = `Secret values must contain at least ${SECRET_VALUE_MIN_LENGTH} characters`;

const HEADER_SECRET_PURPOSES = new Set<SecretPurpose>(['provider-api-key', 'provider-header', 'mcp-header']);
const ENV_SECRET_PURPOSE = 'stdio-env' satisfies SecretPurpose;
const HEADER_FORBIDDEN = /[\r\n\0]/;
const ENV_FORBIDDEN = /\0/;

// Validate a candidate secret value against every declared purpose. A value that is
// structurally invalid for one of its purposes would be persisted but guaranteed to
// fail at runtime (Fetch rejects CR/LF/NUL in header values; child_process rejects
// NUL in environment values), so reject it at create/replace time instead.
export function assertSecretValueForPurposes(value: string, purposes: readonly SecretPurpose[]): void {
  if (purposes.some((purpose) => HEADER_SECRET_PURPOSES.has(purpose)) && HEADER_FORBIDDEN.test(value)) {
    throw new Error('Secret values used for HTTP headers must not contain CR, LF, or NUL characters');
  }
  if (purposes.includes(ENV_SECRET_PURPOSE) && ENV_FORBIDDEN.test(value)) {
    throw new Error('Secret values used for stdio environment variables must not contain NUL characters');
  }
}

export function assertResolvedSecretValue(value: string): string {
  if (value.length < SECRET_VALUE_MIN_LENGTH) throw new Error(SECRET_VALUE_TOO_SHORT_MESSAGE);
  return value;
}

export const createSecretSchema = z.object({
  backend: z.enum(['vault', 'session']),
  label: z.string().trim().min(1).max(120),
  purposes: z.array(secretPurposeSchema).min(1).refine((items) => new Set(items).size === items.length, 'Duplicate secret purposes are not allowed'),
  value: z.string().min(SECRET_VALUE_MIN_LENGTH, SECRET_VALUE_TOO_SHORT_MESSAGE),
}).strict().superRefine((input, context) => {
  try {
    assertSecretValueForPurposes(input.value, input.purposes);
  } catch (error) {
    context.addIssue({ code: 'custom', path: ['value'], message: error instanceof Error ? error.message : String(error) });
  }
});

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
