import { describe, expect, test } from 'vitest';
import { evaluateAssertions } from '../src/core/assertions.js';
import { event } from '../src/core/events.js';
import { runSuite } from '../src/core/runner.js';
import type { Assertion, Suite } from '../src/core/types.js';

const observation = {
  output: { message: 'Weather is Sunny', nested: { value: 42 } },
  toolCalls: [
    { name: 'lookup', arguments: { city: 'Jakarta', unit: 'c' }, result: { temperature: 31 }, outcome: 'success' as const },
    { name: 'format', arguments: { style: 'short' }, result: 'Sunny', outcome: 'success' as const },
    { name: 'lookup', arguments: { city: 'Bandung', unit: 'c' }, result: { temperature: 24 }, outcome: 'error' as const, error: 'upstream rejected request' },
  ],
  durationMs: 920,
  tokens: { input: 30, output: 20, total: 50 },
  costUsd: 0.004,
  events: [],
};

describe('assertion evaluator', () => {
  test.each<[string, Assertion]>([
    ['called', { type: 'tool_called', tool: 'format' }],
    ['not called', { type: 'tool_not_called', tool: 'delete' }],
    ['count', { type: 'tool_count', tool: 'lookup', count: 2 }],
    ['order', { type: 'tool_order', tools: ['lookup', 'format', 'lookup'] }],
    ['arguments', { type: 'args', tool: 'lookup', path: '$.city', equals: 'Jakarta' }],
    ['JSONPath', { type: 'jsonpath', path: '$.nested.value', equals: 42 }],
    ['contains', { type: 'contains', path: '$.message', value: 'Sunny' }],
    ['regex', { type: 'regex', path: '$.message', pattern: '^Weather is [A-Z]' }],
    ['duration', { type: 'duration', maxMs: 1000 }],
    ['tokens', { type: 'tokens', max: 50 }],
    ['cost', { type: 'cost', maxUsd: 0.01 }],
  ])('passes %s assertions', (_label, assertion) => {
    expect(evaluateAssertions([assertion], observation)[0]).toMatchObject({ passed: true });
  });

  test('matches selected named tool arguments, result, and outcome', () => {
    const [result] = evaluateAssertions([{
      type: 'tool',
      tool: 'lookup',
      occurrence: 2,
      arguments: { path: '$.city', equals: 'Bandung' },
      result: { path: '$.temperature', equals: 24 },
      success: false,
    }], observation);
    expect(result).toMatchObject({ passed: true });
  });

  test('fails tool assertion when selected call does not meet expected outcome', () => {
    const [result] = evaluateAssertions([{
      type: 'tool', tool: 'lookup', occurrence: 2, success: true,
    }], observation);
    expect(result).toMatchObject({ passed: false, expected: true, actual: false });
  });

  test('returns useful expected and actual values for failures', () => {
    const [result] = evaluateAssertions([{ type: 'tool_called', tool: 'missing' }], observation);
    expect(result).toMatchObject({
      passed: false,
      expected: 'missing',
      actual: ['lookup', 'format', 'lookup'],
    });
  });
});

describe('suite runner', () => {
  test('fails an agent case that hits a stop boundary even when its assertions pass', async () => {
    const suite: Suite = {
      version: 1,
      name: 'incomplete-agent',
      cases: [{
        id: 'budget-stop', kind: 'agent', server: 'sample', provider: 'local', model: 'test', prompt: 'finish',
        limits: { maxTurns: 2, maxToolCalls: 2, timeoutMs: 1000 },
        assertions: [{ type: 'contains', value: 'partial' }],
      }],
    };
    const run = await runSuite(suite, {
      direct: async () => observation,
      agent: async () => ({ ...observation, output: 'partial', stopReason: 'max_cost' }),
    });
    expect(run.status).toBe('failed');
    expect(run.cases[0]).toMatchObject({ status: 'failed', error: 'Agent stopped before completion: max_cost' });
  });

  test('runs direct and agent cases through injected executors and aggregates pass rate', async () => {
    const suite: Suite = {
      version: 1,
      name: 'mixed',
      cases: [
        {
          id: 'direct',
          kind: 'direct',
          server: 'sample',
          call: { tool: 'lookup', arguments: {} },
          assertions: [{ type: 'tool_called', tool: 'lookup' }],
        },
        {
          id: 'agent',
          kind: 'agent',
          server: 'sample',
          provider: 'local',
          model: 'test',
          prompt: 'look up',
          limits: { maxTurns: 2, maxToolCalls: 2, timeoutMs: 1000 },
          assertions: [{ type: 'contains', value: 'missing' }],
        },
      ],
    };

    const run = await runSuite(suite, {
      direct: async () => ({ ...observation, events: [event('server-correlation-id', 'tool_call', {})] }),
      agent: async () => ({ ...observation, events: [event('server-correlation-id', 'model_turn', {})] }),
    });

    expect(run.status).toBe('failed');
    expect(run.summary).toMatchObject({ total: 2, passed: 1, failed: 1, passRate: 0.5 });
    expect(run.cases.map((entry) => entry.status)).toEqual(['passed', 'failed']);
    expect(run.events.every((event) => event.sanitized)).toBe(true);
    expect(run.events.map((entry) => entry.caseId)).not.toContain('server-correlation-id');
  });
});
