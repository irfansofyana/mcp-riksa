import { z } from 'zod';

export const httpHeaderNameSchema = z.string().regex(
  /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/,
  'Invalid HTTP header name',
);

export function findDuplicateHttpHeaderName(...maps: ReadonlyArray<Record<string, unknown>>): string | undefined {
  const seen = new Set<string>();
  for (const map of maps) {
    for (const name of Object.keys(map)) {
      const normalized = name.toLowerCase();
      if (seen.has(normalized)) return name;
      seen.add(normalized);
    }
  }
  return undefined;
}
