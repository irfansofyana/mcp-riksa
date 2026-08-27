import { redact } from '../core/redaction.js';
import { event } from '../core/events.js';
import type { CaseResult, NormalizedEvent, RunResult } from '../core/types.js';
import type { WorkbenchDatabase } from './database.js';

type RunRow = {
  id: string;
  suite: string;
  status: RunResult['status'] | 'running';
  started_at: string;
  completed_at: string | null;
  summary_json: string | null;
};

type CaseRow = { result_json: string };
type EventRow = {
  id: string;
  case_id: string;
  type: NormalizedEvent['type'];
  timestamp: string;
  duration_ms: number | null;
  data_json: string;
  iteration: number | null;
  user_turn_id: string | null;
  model_turn: number | null;
};

export type StoredRun = Omit<RunResult, 'status'> & { status: RunResult['status'] | 'running' };

export class RunRepository {
  constructor(private readonly database: WorkbenchDatabase) {}

  start(id: string, suite: string, startedAt = new Date().toISOString()): void {
    this.database.prepare(
      'INSERT INTO runs(id, suite, status, started_at) VALUES (?, ?, ?, ?)',
    ).run(id, suite, 'running', startedAt);
  }

  complete(input: RunResult): void {
    const run = redact(input);
    this.database.transaction(() => {
      const update = this.database.prepare(
        `UPDATE runs SET status = ?, completed_at = ?, summary_json = ?
         WHERE id = ? AND status = 'running'`,
      ).run(run.status, run.completedAt, JSON.stringify(run.summary), run.id);
      if (update.changes !== 1) throw new Error(`Run ${run.id} is not active`);

      const insertCase = this.database.prepare(
        'INSERT INTO cases(run_id, id, kind, status, result_json) VALUES (?, ?, ?, ?, ?)',
      );
      for (const entry of run.cases) {
        insertCase.run(run.id, entry.id, entry.kind, entry.status, JSON.stringify(entry));
      }

      const insertEvent = this.database.prepare(
        `INSERT INTO events(id, run_id, case_id, type, timestamp, duration_ms, data_json, sanitized, iteration, user_turn_id, model_turn)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      );
      for (const entry of run.events) {
        insertEvent.run(
          entry.id,
          run.id,
          entry.caseId,
          entry.type,
          entry.timestamp,
          entry.durationMs ?? null,
          JSON.stringify(redact(entry.data)),
          entry.iteration ?? null,
          entry.userTurn ?? null,
          entry.modelTurn ?? null,
        );
      }
    })();
  }

  fail(id: string, error: unknown, completedAt = new Date().toISOString()): void {
    const diagnostic = redact({ message: error instanceof Error ? error.message : String(error) });
    this.database.transaction(() => {
      const update = this.database.prepare(
        `UPDATE runs SET status = 'failed', completed_at = ?,
         summary_json = '{"total":0,"passed":0,"failed":1,"passRate":0}'
         WHERE id = ? AND status = 'running'`,
      ).run(completedAt, id);
      if (update.changes !== 1) return;
      const entry = event(id, 'error', diagnostic);
      this.database.prepare(
        `INSERT INTO events(id, run_id, case_id, type, timestamp, duration_ms, data_json, sanitized)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(entry.id, id, id, entry.type, entry.timestamp, null, JSON.stringify(entry.data));
    })();
  }

  recoverInterrupted(completedAt = new Date().toISOString()): number {
    return this.database.prepare(
      `UPDATE runs SET status = 'interrupted', completed_at = ?,
       summary_json = COALESCE(summary_json, '{"total":0,"passed":0,"failed":0,"passRate":0}')
       WHERE status = 'running'`,
    ).run(completedAt).changes;
  }

  get(id: string): StoredRun | undefined {
    const row = this.database.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    if (!row) return undefined;
    const cases = this.database.prepare('SELECT result_json FROM cases WHERE run_id = ? ORDER BY rowid').all(id) as CaseRow[];
    const events = this.database.prepare('SELECT * FROM events WHERE run_id = ? ORDER BY rowid').all(id) as EventRow[];
    const summary = row.summary_json === null
      ? { total: 0, passed: 0, failed: 0, passRate: 0 }
      : JSON.parse(row.summary_json) as RunResult['summary'];
    return {
      id: row.id,
      suite: row.suite,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? row.started_at,
      summary,
      cases: cases.map((entry) => JSON.parse(entry.result_json) as CaseResult),
      events: events.map((entry) => ({
        id: entry.id,
        caseId: entry.case_id,
        type: entry.type,
        timestamp: entry.timestamp,
        ...(entry.duration_ms === null ? {} : { durationMs: entry.duration_ms }),
        ...(entry.iteration === null ? {} : { iteration: entry.iteration }),
        ...(entry.user_turn_id === null ? {} : { userTurn: entry.user_turn_id }),
        ...(entry.model_turn === null ? {} : { modelTurn: entry.model_turn }),
        data: JSON.parse(entry.data_json) as unknown,
        sanitized: true,
      })),
    };
  }

  list(): StoredRun[] {
    const rows = this.database.prepare('SELECT id FROM runs ORDER BY started_at DESC').all() as Array<{ id: string }>;
    return rows.map(({ id }) => this.get(id)!).filter(Boolean);
  }

  compare(runA: string, runB: string) {
    const first = this.metrics(runA);
    const second = this.metrics(runB);
    return {
      runA,
      runB,
      passRateDelta: second.passRate - first.passRate,
      latencyMsDelta: second.latencyMs - first.latencyMs,
      toolCallDelta: second.toolCalls - first.toolCalls,
      tokenDelta: second.tokens - first.tokens,
      costUsdDelta: second.costUsd - first.costUsd,
    };
  }

  private metrics(id: string) {
    const run = this.get(id);
    if (!run) throw new Error(`Run ${id} not found`);
    const observations = run.cases.flatMap((entry) => entry.iterations?.map((iteration) => iteration.observation) ?? [entry.observation]);
    return observations.reduce(
      (metrics, observation) => ({
        passRate: run.summary.passRate,
        latencyMs: metrics.latencyMs + observation.durationMs,
        toolCalls: metrics.toolCalls + observation.toolCalls.length,
        tokens: metrics.tokens + observation.tokens.total,
        costUsd: metrics.costUsd + observation.costUsd,
      }),
      { passRate: run.summary.passRate, latencyMs: 0, toolCalls: 0, tokens: 0, costUsd: 0 },
    );
  }
}
