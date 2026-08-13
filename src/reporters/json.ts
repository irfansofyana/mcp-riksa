import { redact } from '../core/redaction.js';
import type { RunResult } from '../core/types.js';

export function reportJson(run: RunResult): string {
  return `${JSON.stringify(redact(run), null, 2)}\n`;
}
