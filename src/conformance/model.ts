import { redact } from '../core/redaction.js';
import type { ConformanceCheck, ConformanceCheckStatus, ConformanceExecution, ConformanceReportStatus, ConformanceSummary } from './types.js';

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function status(value: unknown, id: string): ConformanceCheckStatus {
  if (id === 'wire-schema-harness-error') return 'harness_error';
  switch (String(value).toUpperCase()) {
    case 'SUCCESS': return 'passed';
    case 'FAILURE': return 'failed';
    case 'WARNING': return 'warning';
    case 'INFO':
    case 'SKIPPED': return 'skipped';
    default: return 'harness_error';
  }
}

export function normalizeConformanceChecks(files: Array<{ scenario: string; value: unknown }>): ConformanceCheck[] {
  let sequence = 0;
  const checks: ConformanceCheck[] = [];
  for (const file of files) {
    if (!Array.isArray(file.value)) continue;
    for (const raw of file.value) {
      const entry = object(raw);
      if (!entry) continue;
      const id = typeof entry.id === 'string' ? entry.id : `unknown-${sequence + 1}`;
      const references = Array.isArray(entry.specReferences) ? entry.specReferences.flatMap((rawReference) => {
        const reference = object(rawReference);
        return reference && typeof reference.id === 'string' ? [{ id: reference.id, ...(typeof reference.url === 'string' ? { url: reference.url } : {}) }] : [];
      }) : [];
      checks.push(redact({
        sequence: sequence++,
        scenario: file.scenario,
        id,
        name: typeof entry.name === 'string' ? entry.name : id,
        description: typeof entry.description === 'string' ? entry.description : '',
        status: status(entry.status, id),
        ...(typeof entry.timestamp === 'string' ? { timestamp: entry.timestamp } : {}),
        specReferences: references,
        ...(typeof entry.errorMessage === 'string' ? { error: entry.errorMessage } : {}),
        ...(entry.details === undefined ? {} : { details: entry.details }),
      }));
    }
  }
  return checks;
}

export function conformanceSummary(checks: ConformanceCheck[]): ConformanceSummary {
  return {
    total: checks.length,
    passed: checks.filter((entry) => entry.status === 'passed').length,
    failed: checks.filter((entry) => entry.status === 'failed').length,
    warnings: checks.filter((entry) => entry.status === 'warning').length,
    skipped: checks.filter((entry) => entry.status === 'skipped').length,
    harnessErrors: checks.filter((entry) => entry.status === 'harness_error').length,
  };
}

export function conformanceStatus(execution: ConformanceExecution): ConformanceReportStatus {
  if (execution.cancelled) return 'cancelled';
  if (execution.timedOut) return 'timed_out';
  const summary = conformanceSummary(execution.checks);
  if (summary.harnessErrors > 0 || execution.checks.length === 0) return 'harness_error';
  if (summary.failed > 0) return 'failed';
  if (summary.warnings > 0) return 'warning';
  return execution.exitCode === 0 ? 'passed' : 'harness_error';
}
