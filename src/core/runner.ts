import { randomUUID } from 'node:crypto';
import { evaluateAssertions } from './assertions.js';
import { event } from './events.js';
import { redact } from './redaction.js';
import type { AgentCase, CaseResult, DirectCase, IterationResult, Observation, RunResult, Suite, TurnResult, V2AgentCase } from './types.js';

export type RunnerDependencies = {
  direct: (entry: DirectCase, signal: AbortSignal) => Promise<Observation>;
  agent: (entry: AgentCase, signal: AbortSignal) => Promise<Observation>;
};

type ConversationObservation = Observation & {
  turns?: Array<{ id: string; user: string; observation: Observation }>;
};

const emptyObservation = (): Observation => ({
  output: null,
  toolCalls: [],
  durationMs: 0,
  tokens: { input: 0, output: 0, total: 0 },
  costUsd: 0,
  events: [],
});

function scopedObservation(raw: Observation, caseId: string, iteration?: number): Observation {
  return redact({
    ...raw,
    events: raw.events.map((entryEvent) => ({
      ...entryEvent,
      caseId,
      ...(iteration === undefined ? {} : { iteration }),
    })),
  });
}

function caseVerdict(entry: DirectCase | AgentCase, observation: Observation) {
  const assertions = evaluateAssertions(entry.assertions, observation);
  const incompleteAgent = entry.kind === 'agent' && observation.stopReason !== 'complete';
  const passed = !incompleteAgent && assertions.every((assertion) => assertion.passed);
  return {
    assertions,
    passed,
    ...(incompleteAgent ? { error: `Agent stopped before completion: ${observation.stopReason}` } : {}),
  };
}

function emptyTurnResult(turn: V2AgentCase['turns'][number]): TurnResult {
  return {
    id: turn.id,
    user: turn.user,
    status: 'failed',
    observation: emptyObservation(),
    assertions: [],
    error: 'Agent did not reach this user turn',
  };
}

function iterationVerdict(entry: V2AgentCase, raw: ConversationObservation, caseId: string, index: number): IterationResult {
  const observation = scopedObservation(raw, caseId, index);
  const actualTurns = raw.turns ?? [];
  const turns = entry.turns.map((turn, turnIndex): TurnResult => {
    const actual = actualTurns[turnIndex];
    if (actual === undefined) return emptyTurnResult(turn);
    const turnObservation = scopedObservation(actual.observation, caseId, index);
    const assertions = evaluateAssertions(turn.assertions, turnObservation);
    const complete = turnObservation.stopReason === 'complete';
    return {
      id: turn.id,
      user: turn.user,
      status: complete && assertions.every((assertion) => assertion.passed) ? 'passed' : 'failed',
      observation: turnObservation,
      assertions,
      ...(complete ? {} : { error: `Agent stopped before completion: ${turnObservation.stopReason}` }),
    };
  });
  const verdict = caseVerdict(entry, observation);
  const cancelled = observation.stopReason === 'cancelled';
  const passed = !cancelled && verdict.passed && turns.every((turn) => turn.status === 'passed');
  return {
    index,
    status: cancelled ? 'cancelled' : passed ? 'passed' : 'failed',
    observation,
    assertions: verdict.assertions,
    turns,
    ...(verdict.error === undefined ? {} : { error: verdict.error }),
  };
}

async function runScriptedCase(
  entry: V2AgentCase,
  dependencies: RunnerDependencies,
  signal: AbortSignal,
): Promise<CaseResult> {
  const iterations: IterationResult[] = [];
  for (let index = 1; index <= entry.iterations.count; index += 1) {
    if (signal.aborted) break;
    try {
      const raw = await dependencies.agent(entry, signal) as ConversationObservation;
      iterations.push(iterationVerdict(entry, raw, entry.id, index));
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error));
      iterations.push({
        index,
        status: signal.aborted ? 'cancelled' : 'failed',
        observation: emptyObservation(),
        assertions: [],
        turns: entry.turns.map(emptyTurnResult),
        error: message,
      });
    }
  }
  const passed = iterations.filter((iteration) => iteration.status === 'passed').length;
  const failed = iterations.length - passed;
  const latest = iterations.at(-1);
  const status = signal.aborted ? 'cancelled' : passed >= entry.iterations.minPasses ? 'passed' : 'failed';
  const latestFailure = latest?.error ?? latest?.turns.find((turn) => turn.error !== undefined)?.error;
  return {
    id: entry.id,
    kind: entry.kind,
    status,
    observation: latest?.observation ?? emptyObservation(),
    assertions: latest?.assertions ?? [],
    evaluation: {
      count: entry.iterations.count,
      minPasses: entry.iterations.minPasses,
      passed,
      failed,
      passRate: entry.iterations.count === 0 ? 0 : passed / entry.iterations.count,
    },
    iterations,
    ...(status === 'passed' ? {} : { error: latestFailure ?? `Only ${passed}/${entry.iterations.count} iteration(s) passed; need ${entry.iterations.minPasses}` }),
  };
}

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
      if (entry.kind === 'agent' && 'turns' in entry) {
        const result = await runScriptedCase(entry, dependencies, controller.signal);
        cases.push(result);
        events.push(...result.iterations!.flatMap((iteration) => iteration.observation.events), event(entry.id, 'case_completed', { status: result.status }, result.observation.durationMs));
        continue;
      }
      try {
        const raw = entry.kind === 'direct'
          ? await dependencies.direct(entry, controller.signal)
          : await dependencies.agent(entry, controller.signal);
        const observation = scopedObservation(raw, entry.id);
        const verdict = caseVerdict(entry, observation);
        const status = verdict.passed ? 'passed' : 'failed';
        cases.push({ id: entry.id, kind: entry.kind, status, observation, assertions: verdict.assertions, ...(verdict.error === undefined ? {} : { error: verdict.error }) });
        events.push(...observation.events, event(entry.id, 'case_completed', { status }, observation.durationMs));
      } catch (error) {
        const cancelled = controller.signal.aborted;
        const message = error instanceof Error ? error.message : String(error);
        cases.push({ id: entry.id, kind: entry.kind, status: cancelled ? 'cancelled' : 'failed', observation: emptyObservation(), assertions: [], error: redact(message) });
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
    id: options.id ?? randomUUID(), suite: suite.name, status: cancelled ? 'cancelled' : failed === 0 ? 'passed' : 'failed',
    startedAt, completedAt: new Date().toISOString(),
    summary: { total: cases.length, passed, failed, passRate: cases.length === 0 ? 0 : passed / cases.length },
    cases, events,
  };
}
