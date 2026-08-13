import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openDatabase } from '../src/storage/database.js';
import { ConversationRepository } from '../src/storage/conversations.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('persists sanitized multi-turn playground conversations and cumulative stats', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-conversations-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'workbench.db'));
  const conversations = new ConversationRepository(database);
  const created = conversations.create({ serverId: 'sample', providerId: 'local', model: 'fast', systemPrompt: 'Use MCP tools when useful.' });

  conversations.appendTurn(created.id, { role: 'user', content: 'Add 2 and 3' }, {
    role: 'assistant', content: '5', durationMs: 42,
    tokens: { input: 10, output: 2, total: 12 }, costUsd: 0.001,
    toolCalls: [{ name: 'add', arguments: { a: 2, b: 3 }, result: { sum: 5 }, durationMs: 3 }],
    events: [], stopReason: 'complete', providerTranscript: [
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'add', arguments: { a: 2, b: 3 } }] },
      { role: 'tool', toolCallId: 'call-1', name: 'add', content: '{"sum":5}' },
      { role: 'assistant', content: '5', toolCalls: [] },
    ],
  });
  conversations.append(created.id, { role: 'user', content: 'Now add 4' });

  const detail = conversations.get(created.id);
  expect(detail).toMatchObject({
    id: created.id,
    title: 'Add 2 and 3',
    systemPrompt: 'Use MCP tools when useful.',
    messageCount: 3,
    totals: { tokens: { input: 10, output: 2, total: 12 }, costUsd: 0.001, toolCalls: 1, durationMs: 42 },
  });
  expect(detail?.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
  expect(detail?.messages[1]?.providerTranscript).toHaveLength(3);
  expect(conversations.list()[0]).toMatchObject({ id: created.id, messageCount: 3 });
  const redactedConversation = conversations.create({ serverId: 'sample', providerId: 'local', model: 'fast', systemPrompt: 'Authorization: Bearer raw-system-secret' });
  expect(conversations.get(redactedConversation.id)?.systemPrompt).toContain('[REDACTED]');
  expect(JSON.stringify(conversations.get(redactedConversation.id))).not.toContain('raw-system-secret');
  expect(conversations.events(created.id)).toHaveLength(0);
  database.close();
});

test('persists immutable sanitized playground trace events with assistant turn', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-traces-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'workbench.db'));
  const conversations = new ConversationRepository(database);
  const created = conversations.create({ serverId: 'sample', providerId: 'local', model: 'fast' });
  conversations.appendTurn(created.id, { role: 'user', content: 'Run tool' }, {
    role: 'assistant', content: '**Done**', tokens: { input: 1, output: 1, total: 2 }, costUsd: 0,
    toolCalls: [], stopReason: 'complete', events: [{
      id: 'trace-event-1', caseId: 'sample', type: 'model_turn', timestamp: new Date().toISOString(),
      durationMs: 12, data: { secret: 'safe trace' }, sanitized: true,
    }],
  });
  expect(conversations.events(created.id)).toMatchObject([{ id: 'trace-event-1', type: 'model_turn', durationMs: 12, sanitized: true }]);
  database.prepare('UPDATE playground_messages SET detail_json = ? WHERE conversation_id = ? AND role = ?').run(JSON.stringify({ events: [{ id: 'tampered', type: 'error' }] }), created.id, 'assistant');
  expect(conversations.get(created.id)?.messages.find((entry) => entry.role === 'assistant')?.events).toMatchObject([{ id: 'trace-event-1', type: 'model_turn' }]);
  expect(() => database.prepare('UPDATE playground_events SET type = ? WHERE id = ?').run('changed', 'trace-event-1')).toThrow(/immutable/i);
  expect(() => database.prepare('DELETE FROM playground_events WHERE id = ?').run('trace-event-1')).toThrow(/immutable/i);
  expect(conversations.delete(created.id)).toBe(true);
  expect(conversations.events(created.id)).toEqual([]);
  database.close();
});
