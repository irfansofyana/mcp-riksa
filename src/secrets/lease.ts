import { registerSecretValue, unregisterSecretValue } from '../core/redaction.js';
import type { SecretResolver } from './types.js';

export type SecretResolutionLease = {
  resolve: SecretResolver;
  release(): void;
};

export function createSecretResolutionLease(resolveSecret: SecretResolver): SecretResolutionLease {
  const values: string[] = [];
  let released = false;
  return {
    resolve: async (reference, purpose) => {
      if (released) throw new Error('Secret resolution lease has been released');
      const value = await resolveSecret(reference, purpose);
      registerSecretValue(value);
      values.push(value);
      return value;
    },
    release: () => {
      if (released) return;
      released = true;
      for (const value of values) unregisterSecretValue(value);
      values.length = 0;
    },
  };
}

export async function withSecretResolutionLease<T>(
  resolveSecret: SecretResolver,
  operation: (activeResolver: SecretResolver) => Promise<T>,
): Promise<T> {
  const lease = createSecretResolutionLease(resolveSecret);
  try {
    return await operation(lease.resolve);
  } finally {
    lease.release();
  }
}
