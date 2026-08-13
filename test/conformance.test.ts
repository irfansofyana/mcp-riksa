import { describe, expect, test } from 'vitest';
import { conformanceStatus, conformanceSummary, normalizeConformanceChecks } from '../src/conformance/model.js';

describe('official conformance report model', () => {
  test('normalizes official statuses, spec references, warnings and harness errors', () => {
    const checks = normalizeConformanceChecks([{ scenario: 'server-initialize', value: [
      { id: 'initialize', name: 'Initialize', description: 'Negotiates protocol', status: 'SUCCESS', specReferences: [{ id: 'MCP-Lifecycle', url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle' }] },
      { id: 'optional', name: 'Optional metadata', description: 'Metadata absent', status: 'WARNING' },
      { id: 'wire-schema-harness-error', name: 'Harness wire schema', description: 'Harness emitted invalid fixture', status: 'FAILURE', errorMessage: 'Authorization: Bearer model-secret' },
      { id: 'note', name: 'Note', description: 'Informational', status: 'INFO' },
    ] }]);
    expect(checks.map((check) => check.status)).toEqual(['passed', 'warning', 'harness_error', 'skipped']);
    expect(checks[0]?.specReferences[0]).toMatchObject({ id: 'MCP-Lifecycle' });
    expect(JSON.stringify(checks)).not.toContain('model-secret');
    expect(conformanceSummary(checks)).toEqual({ total: 4, passed: 1, failed: 0, warnings: 1, skipped: 1, harnessErrors: 1 });
  });

  test('keeps runner failure distinct from tested scenario failure', () => {
    const failed = normalizeConformanceChecks([{ scenario: 'tools-list', value: [{ id: 'tools', name: 'Tools', description: '', status: 'FAILURE' }] }]);
    expect(conformanceStatus({ checks: failed, rawReport: {}, exitCode: 1, timedOut: false, cancelled: false })).toBe('failed');
    expect(conformanceStatus({ checks: [], rawReport: {}, exitCode: 1, timedOut: false, cancelled: false })).toBe('harness_error');
    expect(conformanceStatus({ checks: [], rawReport: {}, exitCode: null, timedOut: true, cancelled: false })).toBe('timed_out');
    expect(conformanceStatus({ checks: [], rawReport: {}, exitCode: null, timedOut: false, cancelled: true })).toBe('cancelled');
  });
});
