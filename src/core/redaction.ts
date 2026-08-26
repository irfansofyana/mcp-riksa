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

// Protocol-issued credentials (OAuth tokens, dynamically registered client secrets,
// PKCE verifiers) are valid regardless of length, but registering a 1-3 character
// value globally would redact ordinary text (e.g. the article "a"). Only register
// these for global redaction when they are long enough to be unambiguous.
export function registerProtocolSecretValue(value: string | undefined): void {
  if (value === undefined || value.length < 4) return;
  registerSecretValue(value);
}

export function unregisterProtocolSecretValue(value: string | undefined): void {
  if (value === undefined || value.length < 4) return;
  unregisterSecretValue(value);
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

type TextRange = { start: number; end: number };

function crossingRanges(combined: string, boundaries: number[]): TextRange[] {
  const crossesBoundary = (range: TextRange) => boundaries.some((boundary) => range.start < boundary && boundary < range.end);
  const registered = [...KNOWN_SECRET_VALUES.keys()].flatMap((secret) => {
    const matches: TextRange[] = [];
    for (let start = combined.indexOf(secret); start >= 0; start = combined.indexOf(secret, start + Math.max(secret.length, 1))) {
      matches.push({ start, end: start + secret.length });
    }
    return matches;
  });
  const credentialPatterns = [
    { pattern: AUTHORIZATION_VALUE, prefixLength: (match: RegExpExecArray) => match[1]?.length ?? 0 },
    { pattern: BEARER_VALUE, prefixLength: (match: RegExpExecArray) => (match[1]?.length ?? 0) + (match[2]?.length ?? 0) },
  ].flatMap(({ pattern, prefixLength }) => {
    const matcher = new RegExp(pattern.source, pattern.flags);
    const matches: TextRange[] = [];
    for (let match = matcher.exec(combined); match !== null; match = matcher.exec(combined)) {
      const fullMatch = { start: match.index, end: match.index + match[0].length };
      if (crossesBoundary(fullMatch)) matches.push({ start: match.index + prefixLength(match), end: fullMatch.end });
    }
    return matches;
  });
  return [...registered.filter(crossesBoundary), ...credentialPatterns]
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .reduce<TextRange[]>((accepted, range) => {
      const previous = accepted.at(-1);
      if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
      else accepted.push({ ...range });
      return accepted;
    }, []);
}

export function redactTextSequence(parts: readonly string[]): { parts: string[]; crossesBoundary: boolean } {
  const combined = parts.join('');
  const individuallyRedacted = parts.map(redactString);
  const fullyRedacted = redactString(combined);
  const boundaries = parts.reduce<number[]>((ends, part) => [...ends, (ends.at(-1) ?? 0) + part.length], []);
  const ranges = crossingRanges(combined, boundaries);

  if (ranges.length === 0) {
    const crossesBoundary = fullyRedacted !== individuallyRedacted.join('');
    return crossesBoundary
      ? { parts: parts.map((_, index) => index === parts.length - 1 ? fullyRedacted : ''), crossesBoundary }
      : { parts: individuallyRedacted, crossesBoundary: false };
  }

  const projected = parts.map((part, index) => {
    const start = index === 0 ? 0 : boundaries[index - 1]!;
    const end = boundaries[index]!;
    let cursor = start;
    let output = '';
    for (const range of ranges) {
      if (range.end <= start || range.start >= end) continue;
      output += combined.slice(cursor, Math.max(cursor, range.start));
      if (range.start >= start && range.start < end) output += REDACTED;
      cursor = Math.max(cursor, range.end);
    }
    return redactString(output + combined.slice(cursor, end));
  });
  return { parts: projected, crossesBoundary: true };
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
