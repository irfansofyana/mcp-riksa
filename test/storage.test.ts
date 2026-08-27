import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { event } from '../src/core/events.js';
import type { RunResult } from '../src/core/types.js';
import { openDatabase } from '../src/storage/database.js';
import { ConformanceRepository } from '../src/storage/conformance.js';
import { RunRepository } from '../src/storage/runs.js';

const directories: string[] = [];

function createRepository() {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-riksa-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'runs.db'));
  return { database, repository: new RunRepository(database) };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function run(id: string, passRate: number, factor: number): RunResult {
  const passed = Math.round(2 * passRate);
  return {
    id,
    suite: 'sample',
    status: passRate === 1 ? 'passed' : 'failed',
    startedAt: '2026-08-13T00:00:00.000Z',
    completedAt: '2026-08-13T00:00:01.000Z',
    summary: { total: 2, passed, failed: 2 - passed, passRate },
    cases: [{
      id: 'case-1',
      kind: 'direct',
      status: passRate === 1 ? 'passed' : 'failed',
      observation: {
        output: { authorization: 'Bearer database-secret' },
        toolCalls: Array.from({ length: factor }, () => ({ name: 'add', arguments: {} })),
        durationMs: factor * 100,
        tokens: { input: factor * 10, output: factor * 5, total: factor * 15 },
        costUsd: factor * 0.01,
        events: [],
      },
      assertions: [],
    }],
    events: [event('case-1', 'tool_call', { accessToken: 'event-secret', safe: 'yes' })],
  };
}

describe('SQLite run repository', () => {
  test('runs migrations in WAL mode', () => {
    const { database } = createRepository();
    expect(database.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(database.prepare('select max(version) as version from migrations').get()).toEqual({ version: 8 });
    database.close();
  });

  test('stores sanitized historical conformance reports and recovers interrupted executions', () => {
    const { database } = createRepository();
    const repository = new ConformanceRepository(database);
    repository.start({ id: 'report', serverId: 'http-server', endpoint: 'http://127.0.0.1:3000/mcp', selection: { kind: 'suite', suite: 'active' }, startedAt: '2026-08-13T00:00:00.000Z', runnerVersion: '0.1.10' });
    repository.complete('report', {
      status: 'failed', completedAt: '2026-08-13T00:00:01.000Z',
      checks: [{ sequence: 0, scenario: 'tools-list', id: 'tools', name: 'Tools', description: 'Lists tools', status: 'failed', specReferences: [], error: 'Bearer stored-secret' }],
      rawReport: { authorization: 'Bearer raw-secret' },
    });
    expect(repository.get('report')).toMatchObject({ status: 'failed', summary: { total: 1, failed: 1 }, checks: [{ scenario: 'tools-list' }] });
    expect(JSON.stringify(repository.get('report'))).not.toContain('stored-secret');
    expect(JSON.stringify(repository.get('report'))).not.toContain('raw-secret');
    repository.start({ id: 'stale-report', serverId: 'http-server', endpoint: 'http://127.0.0.1:3000/mcp', selection: { kind: 'scenario', scenario: 'server-initialize' }, startedAt: '2026-08-13T00:00:02.000Z', runnerVersion: '0.1.10' });
    expect(repository.recoverInterrupted()).toBe(1);
    expect(repository.get('stale-report')?.status).toBe('interrupted');
    database.close();
  });

  test('backfills version-3 conversation trace JSON into canonical events', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-riksa-v3-'));
    directories.push(directory);
    const path = join(directory, 'runs.db');
    const legacy = openDatabase(path);
    const now = new Date().toISOString();
    legacy.prepare('INSERT INTO playground_conversations(id, title, server_id, provider_id, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('conversation', 'Legacy', 'server', 'provider', 'model', now, now);
    legacy.prepare('INSERT INTO playground_messages(id, conversation_id, sequence, role, content, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('assistant', 'conversation', 1, 'assistant', 'done', JSON.stringify({ events: [{ id: 'legacy-event', caseId: 'server', type: 'model_turn', timestamp: now, durationMs: 9, data: { turn: 1 }, sanitized: true }] }), now);
    legacy.exec('DROP TRIGGER playground_events_immutable_update; DROP TRIGGER playground_events_immutable_delete; DROP TABLE playground_events; DROP TABLE configuration_tombstones; DELETE FROM migrations WHERE version >= 4;');
    legacy.close();

    const migrated = openDatabase(path);
    expect(migrated.prepare('SELECT id, message_id, duration_ms FROM playground_events').all()).toEqual([{ id: 'legacy-event', message_id: 'assistant', duration_ms: 9 }]);
    migrated.close();
  });

  test('completes runs transactionally, redacts before persistence, and keeps events immutable', () => {
    const { database, repository } = createRepository();
    const value = run('run-a', 1, 1);
    value.events[0] = { ...value.events[0]!, iteration: 2, userTurn: 'follow-up', modelTurn: 3 };
    repository.start(value.id, value.suite, value.startedAt);
    repository.complete(value);

    const loaded = repository.get('run-a');
    expect(JSON.stringify(loaded)).not.toContain('database-secret');
    expect(JSON.stringify(loaded)).not.toContain('event-secret');
    expect(JSON.stringify(loaded)).toContain('[REDACTED]');
    expect(loaded?.events[0]).toMatchObject({ iteration: 2, userTurn: 'follow-up', modelTurn: 3 });
    expect(() => database.prepare('update events set type = ?').run('error')).toThrow(/immutable/i);
    database.close();
  });

  test('rolls back all completion writes if an event insert fails', () => {
    const { database, repository } = createRepository();
    const value = run('run-rollback', 1, 1);
    value.events.push(value.events[0]!);
    repository.start(value.id, value.suite, value.startedAt);

    expect(() => repository.complete(value)).toThrow();
    expect(database.prepare('select status from runs where id = ?').get(value.id)).toEqual({ status: 'running' });
    expect(database.prepare('select count(*) as count from cases where run_id = ?').get(value.id)).toEqual({ count: 0 });
    expect(database.prepare('select count(*) as count from events where run_id = ?').get(value.id)).toEqual({ count: 0 });
    database.close();
  });

  test('recovers stale running records as interrupted', () => {
    const { database, repository } = createRepository();
    repository.start('stale', 'sample', '2026-08-13T00:00:00.000Z');
    expect(repository.recoverInterrupted()).toBe(1);
    expect(repository.get('stale')?.status).toBe('interrupted');
    database.close();
  });

  test('terminally fails an active run with a sanitized diagnostic', () => {
    const { database, repository } = createRepository();
    repository.start('broken', 'sample', '2026-08-13T00:00:00.000Z');
    repository.fail('broken', new Error('Authorization: Bearer background-secret'));

    const loaded = repository.get('broken');
    expect(loaded?.status).toBe('failed');
    expect(loaded?.events).toHaveLength(1);
    expect(JSON.stringify(loaded)).not.toContain('background-secret');
    expect(JSON.stringify(loaded)).toContain('[REDACTED]');
    database.close();
  });

  test('compares pass rate, latency, tool calls, tokens, and cost as run B minus run A', () => {
    const { database, repository } = createRepository();
    const first = run('first', 0.5, 1);
    const second = run('second', 1, 3);
    repository.start(first.id, first.suite, first.startedAt);
    repository.complete(first);
    repository.start(second.id, second.suite, second.startedAt);
    repository.complete(second);

    expect(repository.compare('first', 'second')).toEqual({
      runA: 'first',
      runB: 'second',
      passRateDelta: 0.5,
      latencyMsDelta: 200,
      toolCallDelta: 2,
      tokenDelta: 30,
      costUsdDelta: 0.019999999999999997,
    });
    database.close();
  });
});
