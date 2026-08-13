export const CONFORMANCE_RUNNER_VERSION = '0.1.10';

export type ConformanceCheckStatus = 'passed' | 'failed' | 'warning' | 'skipped' | 'harness_error';
export type ConformanceReportStatus = 'running' | 'passed' | 'failed' | 'warning' | 'harness_error' | 'cancelled' | 'timed_out' | 'interrupted';

export type ConformanceSpecReference = { id: string; url?: string };

export type ConformanceCheck = {
  sequence: number;
  scenario: string;
  id: string;
  name: string;
  description: string;
  status: ConformanceCheckStatus;
  timestamp?: string;
  specReferences: ConformanceSpecReference[];
  error?: string;
  details?: unknown;
};

export type ConformanceSelection =
  | { kind: 'suite'; suite: 'active' }
  | { kind: 'scenario'; scenario: string };

export type ConformanceSummary = {
  total: number;
  passed: number;
  failed: number;
  warnings: number;
  skipped: number;
  harnessErrors: number;
};

export type ConformanceReport = {
  id: string;
  serverId: string;
  endpoint: string;
  selection: ConformanceSelection;
  status: ConformanceReportStatus;
  startedAt: string;
  completedAt?: string;
  runnerVersion: string;
  summary: ConformanceSummary;
  checks: ConformanceCheck[];
  rawReport?: unknown;
  diagnostic?: string;
};

export type ConformanceExecution = {
  checks: ConformanceCheck[];
  rawReport: unknown;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  diagnostic?: string;
};

export interface ConformanceRunner {
  run(input: { endpoint: string; selection: ConformanceSelection; timeoutMs: number }, signal: AbortSignal): Promise<ConformanceExecution>;
}
