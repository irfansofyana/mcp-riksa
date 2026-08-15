export const REDACTED = '[REDACTED]';

const SECRET_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|client[-_]?secret|password|secret)$/i;
const SECRET_QUERY = /^(?:access_token|refresh_token|id_token|token|api_key|apikey|key|code|client_secret)$/i;
const AUTHORIZATION_VALUE = /(authorization\s*:\s*(?:bearer|basic)\s+)([^\s,;]+)/gi;
const BEARER_VALUE = /(^|\s)(bearer\s+)([A-Za-z0-9._~+/=-]+)/gi;
const KNOWN_SECRET_VALUES = new Map<string, number>();
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OPAQUE_SECRET_ID = /^secret_[0-9a-f-]{36}$/i;

export function registerSecretValue(value: string | undefined): void {
  if (value) KNOWN_SECRET_VALUES.set(value, (KNOWN_SECRET_VALUES.get(value) ?? 0) + 1);
}

export function unregisterSecretValue(value: string | undefined): void {
  if (!value) return;
  const next = (KNOWN_SECRET_VALUES.get(value) ?? 0) - 1;
  if (next <= 0) KNOWN_SECRET_VALUES.delete(value); else KNOWN_SECRET_VALUES.set(value, next);
}

function redactString(value: string): string {
  let next = value.replace(AUTHORIZATION_VALUE, `$1${REDACTED}`);
  next = next.replace(BEARER_VALUE, `$1$2${REDACTED}`);
  for (const secret of KNOWN_SECRET_VALUES.keys()) {
    if (secret.length >= 4) {
      next = next.replaceAll(secret, REDACTED);
      continue;
    }
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    next = next.replace(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'g'), REDACTED);
  }

  try {
    const url = new URL(next);
    let changed = false;
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_QUERY.test(key)) {
        url.searchParams.set(key, REDACTED);
        changed = true;
      }
    }
    return changed ? url.toString() : next;
  } catch {
    return next;
  }
}

function isSecretReference(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (record.source === 'env') {
    return keys.length === 2 && keys[0] === 'name' && keys[1] === 'source'
      && typeof record.name === 'string' && ENVIRONMENT_NAME.test(record.name);
  }
  return (record.source === 'vault' || record.source === 'session')
    && keys.length === 2 && keys[0] === 'id' && keys[1] === 'source'
    && typeof record.id === 'string' && OPAQUE_SECRET_ID.test(record.id);
}

function visit(value: unknown, seen: WeakMap<object, unknown>, key?: string): unknown {
  if (key && SECRET_KEY.test(key) && isSecretReference(value)) return visit(value, seen);
  if (key && SECRET_KEY.test(key)) return REDACTED;
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    for (const item of value) output.push(visit(item, seen));
    return output;
  }

  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const [entryKey, entryValue] of Object.entries(value)) {
    output[entryKey] = visit(entryValue, seen, entryKey);
  }
  return output;
}

export function redact<T>(value: T): T {
  return visit(value, new WeakMap()) as T;
}

export function containsPotentialSecret(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsPotentialSecret);
  return Object.entries(value).some(
    ([key, entry]) => SECRET_KEY.test(key) || containsPotentialSecret(entry),
  );
}
