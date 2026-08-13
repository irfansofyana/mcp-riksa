import { redact } from '../core/redaction.js';
import { conformanceSummary } from '../conformance/model.js';
import type { ConformanceCheck, ConformanceReport, ConformanceReportStatus, ConformanceSelection } from '../conformance/types.js';
import type { WorkbenchDatabase } from './database.js';

type ReportRow = {
  id: string; server_id: string; endpoint: string; selection_json: string; status: ConformanceReportStatus;
  started_at: string; completed_at: string | null; runner_version: string; summary_json: string;
  raw_report_json: string | null; diagnostic: string | null;
};
type CheckRow = { check_json: string };

export class ConformanceRepository {
  constructor(private readonly database: WorkbenchDatabase) {}

  start(input: { id: string; serverId: string; endpoint: string; selection: ConformanceSelection; startedAt: string; runnerVersion: string }): void {
    this.database.prepare(`
      INSERT INTO conformance_reports(id, server_id, endpoint, selection_json, status, started_at, runner_version, summary_json)
      VALUES (?, ?, ?, ?, 'running', ?, ?, ?)
    `).run(input.id, input.serverId, input.endpoint, JSON.stringify(input.selection), input.startedAt, input.runnerVersion, JSON.stringify(conformanceSummary([])));
  }

  complete(id: string, input: { status: ConformanceReportStatus; completedAt: string; checks: ConformanceCheck[]; rawReport: unknown; diagnostic?: string }): void {
    const safe = redact(input);
    this.database.transaction(() => {
      const updated = this.database.prepare(`
        UPDATE conformance_reports SET status = ?, completed_at = ?, summary_json = ?, raw_report_json = ?, diagnostic = ?
        WHERE id = ? AND status = 'running'
      `).run(safe.status, safe.completedAt, JSON.stringify(conformanceSummary(safe.checks)), JSON.stringify(safe.rawReport), safe.diagnostic ?? null, id);
      if (updated.changes !== 1) throw new Error(`Conformance report ${id} is not active`);
      const insert = this.database.prepare(`
        INSERT INTO conformance_checks(report_id, sequence, scenario, check_id, status, check_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const check of safe.checks) insert.run(id, check.sequence, check.scenario, check.id, check.status, JSON.stringify(check));
    })();
  }

  recoverInterrupted(completedAt = new Date().toISOString()): number {
    return this.database.prepare(`
      UPDATE conformance_reports SET status = 'interrupted', completed_at = ?, diagnostic = 'Workbench stopped before conformance execution completed'
      WHERE status = 'running'
    `).run(completedAt).changes;
  }

  get(id: string): ConformanceReport | undefined {
    const row = this.database.prepare('SELECT * FROM conformance_reports WHERE id = ?').get(id) as ReportRow | undefined;
    if (!row) return undefined;
    const checks = this.database.prepare('SELECT check_json FROM conformance_checks WHERE report_id = ? ORDER BY sequence').all(id) as CheckRow[];
    return {
      id: row.id,
      serverId: row.server_id,
      endpoint: row.endpoint,
      selection: JSON.parse(row.selection_json) as ConformanceSelection,
      status: row.status,
      startedAt: row.started_at,
      ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
      runnerVersion: row.runner_version,
      summary: JSON.parse(row.summary_json) as ConformanceReport['summary'],
      checks: checks.map((entry) => JSON.parse(entry.check_json) as ConformanceCheck),
      ...(row.raw_report_json === null ? {} : { rawReport: JSON.parse(row.raw_report_json) as unknown }),
      ...(row.diagnostic === null ? {} : { diagnostic: row.diagnostic }),
    };
  }

  list(serverId?: string): ConformanceReport[] {
    const rows = (serverId
      ? this.database.prepare('SELECT id FROM conformance_reports WHERE server_id = ? ORDER BY started_at DESC').all(serverId)
      : this.database.prepare('SELECT id FROM conformance_reports ORDER BY started_at DESC').all()) as Array<{ id: string }>;
    return rows.map(({ id }) => this.get(id)!).filter(Boolean);
  }
}
