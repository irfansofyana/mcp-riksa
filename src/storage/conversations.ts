import { randomUUID } from 'node:crypto';
import { redact } from '../core/redaction.js';
import type { NormalizedEvent, ToolCallObservation } from '../core/types.js';
import type { WorkbenchDatabase } from './database.js';

export type ConversationMessageInput = {
  role: 'user' | 'assistant';
  content: string;
  durationMs?: number;
  tokens?: { input: number; output: number; total: number };
  costUsd?: number;
  toolCalls?: ToolCallObservation[];
  events?: NormalizedEvent[];
  stopReason?: string;
};

export type ConversationMessage = ConversationMessageInput & {
  id: string;
  sequence: number;
  createdAt: string;
};

export type ConversationSummary = {
  id: string;
  title: string;
  serverId: string;
  providerId: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  totals: {
    tokens: { input: number; output: number; total: number };
    costUsd: number;
    toolCalls: number;
    durationMs: number;
  };
};

export type ConversationDetail = ConversationSummary & { messages: ConversationMessage[] };

type ConversationRow = {
  id: string; title: string; server_id: string; provider_id: string; model: string;
  created_at: string; updated_at: string; message_count: number;
};

type MessageRow = {
  id: string; sequence: number; role: 'user' | 'assistant'; content: string;
  detail_json: string; created_at: string;
};

const emptyTotals = () => ({
  tokens: { input: 0, output: 0, total: 0 }, costUsd: 0, toolCalls: 0, durationMs: 0,
});

export class ConversationRepository {
  constructor(private readonly database: WorkbenchDatabase) {}

  create(input: { serverId: string; providerId: string; model: string }): ConversationDetail {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO playground_conversations(id, title, server_id, provider_id, model, created_at, updated_at)
      VALUES (?, 'New conversation', ?, ?, ?, ?, ?)
    `).run(id, input.serverId, input.providerId, input.model, now, now);
    return this.get(id)!;
  }

  appendTurn(conversationId: string, user: ConversationMessageInput, assistant: ConversationMessageInput): [ConversationMessage, ConversationMessage] {
    return this.database.transaction((): [ConversationMessage, ConversationMessage] => {
      const userMessage = this.append(conversationId, user);
      const assistantMessage = this.append(conversationId, assistant);
      this.persistEvents(conversationId, assistantMessage.id, assistant.events ?? []);
      return [userMessage, assistantMessage];
    })();
  }

  append(conversationId: string, input: ConversationMessageInput): ConversationMessage {
    const conversation = this.database.prepare('SELECT id, title FROM playground_conversations WHERE id = ?').get(conversationId) as { id: string; title: string } | undefined;
    if (!conversation) throw new Error(`Playground conversation ${conversationId} not found`);
    const sequence = ((this.database.prepare('SELECT max(sequence) AS value FROM playground_messages WHERE conversation_id = ?').get(conversationId) as { value: number | null }).value ?? 0) + 1;
    const id = randomUUID();
    const now = new Date().toISOString();
    const clean = redact(input);
    const detail = {
      ...(clean.durationMs === undefined ? {} : { durationMs: clean.durationMs }),
      ...(clean.tokens === undefined ? {} : { tokens: clean.tokens }),
      ...(clean.costUsd === undefined ? {} : { costUsd: clean.costUsd }),
      ...(clean.toolCalls === undefined ? {} : { toolCalls: clean.toolCalls }),
      ...(clean.events === undefined ? {} : { events: clean.events }),
      ...(clean.stopReason === undefined ? {} : { stopReason: clean.stopReason }),
    };
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO playground_messages(id, conversation_id, sequence, role, content, detail_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, conversationId, sequence, clean.role, clean.content, JSON.stringify(detail), now);
      const title = conversation.title === 'New conversation' && clean.role === 'user'
        ? clean.content.replace(/\s+/g, ' ').trim().slice(0, 64) || 'New conversation'
        : conversation.title;
      this.database.prepare('UPDATE playground_conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, now, conversationId);
    })();
    return { id, sequence, createdAt: now, ...clean };
  }

  list(): ConversationSummary[] {
    const rows = this.database.prepare(`
      SELECT c.*, count(m.id) AS message_count
      FROM playground_conversations c
      LEFT JOIN playground_messages m ON m.conversation_id = c.id
      GROUP BY c.id
      ORDER BY c.updated_at DESC
    `).all() as ConversationRow[];
    return rows.map((row) => this.summary(row, this.messages(row.id)));
  }

  get(id: string): ConversationDetail | undefined {
    const row = this.database.prepare(`
      SELECT c.*, count(m.id) AS message_count
      FROM playground_conversations c
      LEFT JOIN playground_messages m ON m.conversation_id = c.id
      WHERE c.id = ? GROUP BY c.id
    `).get(id) as ConversationRow | undefined;
    if (!row) return undefined;
    const messages = this.messages(id);
    return { ...this.summary(row, messages), messages };
  }

  delete(id: string): boolean {
    return this.database.prepare('DELETE FROM playground_conversations WHERE id = ?').run(id).changes > 0;
  }

  events(conversationId: string): NormalizedEvent[] {
    return [...this.eventMap(conversationId).values()].flat();
  }

  private persistEvents(conversationId: string, messageId: string, events: NormalizedEvent[]): void {
    if (events.length === 0) return;
    const next = ((this.database.prepare('SELECT max(sequence) AS value FROM playground_events WHERE conversation_id = ?').get(conversationId) as { value: number | null }).value ?? 0) + 1;
    const insert = this.database.prepare(`
      INSERT INTO playground_events(id, conversation_id, message_id, sequence, type, timestamp, duration_ms, data_json, sanitized)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    events.forEach((entry, index) => {
      const clean = redact(entry);
      insert.run(clean.id, conversationId, messageId, next + index, clean.type, clean.timestamp, clean.durationMs ?? null, JSON.stringify(clean.data));
    });
  }

  private eventMap(conversationId: string): Map<string, NormalizedEvent[]> {
    const rows = this.database.prepare(`
      SELECT id, message_id, type, timestamp, duration_ms, data_json
      FROM playground_events WHERE conversation_id = ? ORDER BY sequence
    `).all(conversationId) as Array<{ id: string; message_id: string; type: NormalizedEvent['type']; timestamp: string; duration_ms: number | null; data_json: string }>;
    const output = new Map<string, NormalizedEvent[]>();
    for (const row of rows) {
      const entries = output.get(row.message_id) ?? [];
      entries.push({
        id: row.id,
        caseId: conversationId,
        type: row.type,
        timestamp: row.timestamp,
        ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
        data: JSON.parse(row.data_json) as unknown,
        sanitized: true,
      });
      output.set(row.message_id, entries);
    }
    return output;
  }

  private messages(conversationId: string): ConversationMessage[] {
    const rows = this.database.prepare(`
      SELECT id, sequence, role, content, detail_json, created_at
      FROM playground_messages WHERE conversation_id = ? ORDER BY sequence
    `).all(conversationId) as MessageRow[];
    const canonicalEvents = this.eventMap(conversationId);
    return rows.map((row) => {
      const detail = JSON.parse(row.detail_json) as Omit<ConversationMessageInput, 'role' | 'content'>;
      const persisted = canonicalEvents.get(row.id);
      return {
        id: row.id,
        sequence: row.sequence,
        role: row.role,
        content: row.content,
        createdAt: row.created_at,
        ...detail,
        ...(persisted === undefined ? {} : { events: persisted }),
      };
    });
  }

  private summary(row: ConversationRow, messages: ConversationMessage[]): ConversationSummary {
    const totals = messages.reduce((value, message) => {
      value.tokens.input += message.tokens?.input ?? 0;
      value.tokens.output += message.tokens?.output ?? 0;
      value.tokens.total += message.tokens?.total ?? 0;
      value.costUsd += message.costUsd ?? 0;
      value.toolCalls += message.toolCalls?.length ?? 0;
      value.durationMs += message.durationMs ?? 0;
      return value;
    }, emptyTotals());
    return {
      id: row.id,
      title: row.title,
      serverId: row.server_id,
      providerId: row.provider_id,
      model: row.model,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: row.message_count,
      totals,
    };
  }
}
