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
  const created = conversations.create({ serverId: 'sample', providerId: 'local', model: 'fast' });

  conversations.appendTurn(created.id, { role: 'user', content: 'Add 2 and 3' }, {
    role: 'assistant', content: '5', durationMs: 42,
    tokens: { input: 10, output: 2, total: 12 }, costUsd: 0.001,
    toolCalls: [{ name: 'add', arguments: { a: 2, b: 3 }, result: { sum: 5 }, durationMs: 3 }],
    events: [], stopReason: 'complete',
  });
  conversations.append(created.id, { role: 'user', content: 'Now add 4' });

  const detail = conversations.get(created.id);
  expect(detail).toMatchObject({
    id: created.id,
    title: 'Add 2 and 3',
    messageCount: 3,
    totals: { tokens: { input: 10, output: 2, total: 12 }, costUsd: 0.001, toolCalls: 1, durationMs: 42 },
  });
  expect(detail?.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
  expect(conversations.list()[0]).toMatchObject({ id: created.id, messageCount: 3 });
  database.close();
});
