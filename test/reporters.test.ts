import { describe, expect, test } from 'vitest';
import type { RunResult } from '../src/core/types.js';
import { reportJson } from '../src/reporters/json.js';
import { reportHtml } from '../src/reporters/html.js';
import { reportJunit } from '../src/reporters/junit.js';

const run: RunResult = {
  id: 'run-1',
  suite: 'weather & tools',
  status: 'failed',
  startedAt: '2026-08-13T00:00:00.000Z',
  completedAt: '2026-08-13T00:00:01.000Z',
  summary: { total: 1, passed: 0, failed: 1, passRate: 0 },
  cases: [{
    id: 'case <one>',
    kind: 'direct',
    status: 'failed',
    error: 'Authorization: Bearer export-secret',
    observation: {
      output: { token: 'export-secret' },
      toolCalls: [], durationMs: 20,
      tokens: { input: 2, output: 3, total: 5 }, costUsd: 0.01, events: [],
    },
    assertions: [{
      assertion: { type: 'contains', value: 'expected' },
      passed: false, message: 'Contains text', expected: 'expected', actual: 'actual',
    }],
  }],
  events: [],
};

describe('reporters', () => {
  test('emits parseable sanitized JSON', () => {
    const output = reportJson(run);
    expect(JSON.parse(output)).toMatchObject({ id: 'run-1', summary: { failed: 1 } });
    expect(output).not.toContain('export-secret');
    expect(output).toContain('[REDACTED]');
  });

  test('emits standalone sanitized HTML with run and assertion detail', () => {
    const output = reportHtml(run);
    expect(output).toMatch(/^<!doctype html>/i);
    expect(output).toContain('MCP Local Workbench');
    expect(output).toContain('case &lt;one&gt;');
    expect(output).toContain('Contains text');
    expect(output).not.toContain('export-secret');
    expect(output).not.toMatch(/<script[^>]+src=/i);
  });

  test('emits escaped JUnit XML with failures and no secrets', () => {
    const output = reportJunit(run);
    expect(output).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
    expect(output).toContain('<testsuite name="weather &amp; tools" tests="1" failures="1"');
    expect(output).toContain('<testcase name="case &lt;one&gt;"');
    expect(output).toContain('<failure');
    expect(output).not.toContain('export-secret');
  });
});
