export const REDACTED = '[REDACTED]';

const SECRET_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|client[-_]?secret|password|secret)$/i;
const SECRET_QUERY = /^(?:access_token|refresh_token|id_token|token|api_key|apikey|key|code|client_secret)$/i;
const AUTHORIZATION_VALUE = /(authorization\s*:\s*(?:bearer|basic)\s+)([^\s,;]+)/gi;
const BEARER_VALUE = /(^|\s)(bearer\s+)([A-Za-z0-9._~+/=-]+)/gi;
const KNOWN_SECRET_VALUES = new Set<string>();

export function registerSecretValue(value: string | undefined): void {
  if (value && value.length >= 4) KNOWN_SECRET_VALUES.add(value);
}

function redactString(value: string): string {
  let next = value.replace(AUTHORIZATION_VALUE, `$1${REDACTED}`);
  next = next.replace(BEARER_VALUE, `$1$2${REDACTED}`);
  for (const secret of KNOWN_SECRET_VALUES) next = next.replaceAll(secret, REDACTED);

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

function visit(value: unknown, seen: WeakMap<object, unknown>, key?: string): unknown {
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
