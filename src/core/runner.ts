import { randomUUID } from 'node:crypto';
import { evaluateAssertions } from './assertions.js';
import { event } from './events.js';
import { redact } from './redaction.js';
import type { AgentCase, CaseResult, DirectCase, Observation, RunResult, Suite } from './types.js';

export type RunnerDependencies = {
  direct: (entry: DirectCase, signal: AbortSignal) => Promise<Observation>;
  agent: (entry: AgentCase, signal: AbortSignal) => Promise<Observation>;
};

const emptyObservation = (): Observation => ({
  output: null,
  toolCalls: [],
  durationMs: 0,
  tokens: { input: 0, output: 0, total: 0 },
  costUsd: 0,
  events: [],
});

export async function runSuite(
  suite: Suite,
  dependencies: RunnerDependencies,
  options: { signal?: AbortSignal; id?: string } = {},
): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const cases: CaseResult[] = [];
  const events = [];

  try {
    for (const entry of suite.cases) {
      if (controller.signal.aborted) break;
      events.push(event(entry.id, 'case_started', { kind: entry.kind }));
      try {
        const raw = entry.kind === 'direct'
          ? await dependencies.direct(entry, controller.signal)
          : await dependencies.agent(entry, controller.signal);
        const observation = redact({
          ...raw,
          events: raw.events.map((entryEvent) => ({ ...entryEvent, caseId: entry.id })),
        });
        const assertions = evaluateAssertions(entry.assertions, observation);
        const incompleteAgent = entry.kind === 'agent' && observation.stopReason !== 'complete';
        const status = !incompleteAgent && assertions.every((assertion) => assertion.passed) ? 'passed' : 'failed';
        cases.push({
          id: entry.id,
          kind: entry.kind,
          status,
          observation,
          assertions,
          ...(incompleteAgent ? { error: `Agent stopped before completion: ${observation.stopReason}` } : {}),
        });
        events.push(...observation.events, event(entry.id, 'case_completed', { status }, observation.durationMs));
      } catch (error) {
        const cancelled = controller.signal.aborted;
        const message = error instanceof Error ? error.message : String(error);
        cases.push({
          id: entry.id,
          kind: entry.kind,
          status: cancelled ? 'cancelled' : 'failed',
          observation: emptyObservation(),
          assertions: [],
          error: redact(message),
        });
        events.push(event(entry.id, cancelled ? 'stop' : 'error', { message }));
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }

  const passed = cases.filter((entry) => entry.status === 'passed').length;
  const failed = cases.length - passed;
  const cancelled = controller.signal.aborted;
  return {
    id: options.id ?? randomUUID(),
    suite: suite.name,
    status: cancelled ? 'cancelled' : failed === 0 ? 'passed' : 'failed',
    startedAt,
    completedAt: new Date().toISOString(),
    summary: { total: cases.length, passed, failed, passRate: cases.length === 0 ? 0 : passed / cases.length },
    cases,
    events,
  };
}
