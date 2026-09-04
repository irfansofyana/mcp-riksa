import { describe, expect, test } from 'vitest';
import { canCancelRun, formatRunElapsed, runProgressView, shouldPollRun } from '../web/src/run-progress.js';
import type { Run } from '../web/src/types.js';

const running: Run = {
  id: 'run-1',
  suite: 'sample',
  status: 'running',
  startedAt: '2026-09-03T10:00:00.000Z',
  completedAt: '2026-09-03T10:00:00.000Z',
  summary: { total: 0, passed: 0, failed: 0, passRate: 0 },
  cases: [],
  events: [],
  progress: {
    phase: 'iteration_started',
    totalCases: 4,
    completedCases: 1,
    passedCases: 1,
    failedCases: 0,
    currentCaseId: 'agent-search',
    currentCaseIndex: 2,
    currentCaseKind: 'agent',
    currentIteration: 2,
    totalIterations: 3,
    updatedAt: '2026-09-03T10:00:04.000Z',
  },
};

describe('run progress presentation', () => {
  test('derives determinate live metrics and current activity', () => {
    expect(runProgressView(running, Date.parse('2026-09-03T10:00:05.500Z'))).toEqual({
      total: 4,
      completed: 1,
      passed: 1,
      failed: 0,
      remaining: 3,
      percent: 25,
      activity: 'Case 2 of 4 · agent-search · iteration 2 of 3',
      elapsedMs: 5_500,
    });
    expect(shouldPollRun(running)).toBe(true);
    expect(canCancelRun(running, 'run-1')).toBe(true);
    expect(canCancelRun(running, 'run-2')).toBe(false);
  });

  test('uses final summary and completion time after execution', () => {
    const complete: Run = {
      ...running,
      status: 'passed',
      completedAt: '2026-09-03T10:01:02.000Z',
      summary: { total: 4, passed: 4, failed: 0, passRate: 1 },
      cases: [{ id: 'one' } as Run['cases'][number], { id: 'two' } as Run['cases'][number], { id: 'three' } as Run['cases'][number], { id: 'four' } as Run['cases'][number]],
      progress: undefined,
    };
    expect(runProgressView(complete, Date.parse('2026-09-03T11:00:00.000Z'))).toMatchObject({ total: 4, completed: 4, percent: 100, elapsedMs: 62_000 });
    expect(shouldPollRun(complete)).toBe(false);
    expect(formatRunElapsed(62_000)).toBe('1m 02s');
  });
});
