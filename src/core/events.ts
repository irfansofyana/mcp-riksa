import { randomUUID } from 'node:crypto';
import { redact } from './redaction.js';
import type { NormalizedEvent } from './types.js';

export function event(
  caseId: string,
  type: NormalizedEvent['type'],
  data: unknown,
  durationMs?: number,
): NormalizedEvent {
  return {
    id: randomUUID(),
    caseId,
    type,
    timestamp: new Date().toISOString(),
    ...(durationMs === undefined ? {} : { durationMs }),
    data: redact(data),
    sanitized: true,
  };
}
