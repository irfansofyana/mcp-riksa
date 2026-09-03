import type { Run } from './types.js';

export type RunProgressView = {
  total: number;
  completed: number;
  passed: number;
  failed: number;
  remaining: number;
  percent: number;
  activity: string;
  elapsedMs: number;
};

export function shouldPollRun(run: Pick<Run, 'status'> | undefined): boolean {
  return run?.status === 'running';
}

export function canCancelRun(
  run: Pick<Run, 'id' | 'status'> | undefined,
  selectedId: string,
): run is Pick<Run, 'id' | 'status'> & { status: 'running' } {
  return run?.status === 'running' && run.id === selectedId;
}

export function runProgressView(run: Run, now = Date.now()): RunProgressView {
  const progress = run.progress;
  const total = progress?.totalCases ?? run.summary.total;
  const completed = progress?.completedCases ?? run.cases.length;
  const passed = progress?.passedCases ?? run.summary.passed;
  const failed = progress?.failedCases ?? run.summary.failed;
  const percent = total === 0 ? (run.status === 'running' ? 0 : 100) : Math.min(100, Math.round((completed / total) * 100));
  const startedAt = Date.parse(run.startedAt);
  const completedAt = run.status === 'running' ? now : Date.parse(run.completedAt);
  const elapsedMs = Number.isFinite(startedAt) && Number.isFinite(completedAt) ? Math.max(0, completedAt - startedAt) : 0;

  let activity = run.status === 'running' ? 'Preparing run…' : `Run ${run.status}`;
  if (progress?.currentCaseId) {
    const position = progress.currentCaseIndex === undefined ? '' : `Case ${progress.currentCaseIndex} of ${total} · `;
    const iteration = progress.currentIteration === undefined
      ? ''
      : ` · iteration ${progress.currentIteration} of ${progress.totalIterations ?? progress.currentIteration}`;
    activity = progress.phase === 'case_completed'
      ? `${position}${progress.currentCaseId} completed`
      : `${position}${progress.currentCaseId}${iteration}`;
  }

  return {
    total,
    completed,
    passed,
    failed,
    remaining: Math.max(0, total - completed),
    percent,
    activity,
    elapsedMs,
  };
}

export function formatRunElapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes === 0 ? `${remainder}s` : `${minutes}m ${String(remainder).padStart(2, '0')}s`;
}
