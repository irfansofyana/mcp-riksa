export type SecretStoreErrorCode =
  | 'SECRET_INVALID'
  | 'SECRET_ENV_MISSING'
  | 'SECRET_NOT_FOUND'
  | 'SECRET_PURPOSE_DENIED'
  | 'SECRET_BACKEND_UNAVAILABLE'
  | 'SECRET_VAULT_MISSING_KEY'
  | 'SECRET_VAULT_CORRUPT'
  | 'SECRET_VAULT_INVALID_KEY'
  | 'SECRET_VAULT_INSECURE_PERMISSIONS';

export class SecretStoreError extends Error {
  constructor(
    readonly code: SecretStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SecretStoreError';
  }
}
