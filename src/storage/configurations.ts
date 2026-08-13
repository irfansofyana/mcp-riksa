import type { WorkbenchDatabase } from './database.js';

export class ConfigurationRepository {
  constructor(private readonly database: WorkbenchDatabase) {}

  upsert(kind: 'provider' | 'server', id: string, config: unknown): void {
    this.database.prepare(`
      INSERT INTO configurations(kind, id, config_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(kind, id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at
    `).run(kind, id, JSON.stringify(config), new Date().toISOString());
  }

  list<T>(kind: 'provider' | 'server'): T[] {
    const rows = this.database.prepare('SELECT config_json FROM configurations WHERE kind = ? ORDER BY id').all(kind) as Array<{ config_json: string }>;
    return rows.map((row) => JSON.parse(row.config_json) as T);
  }
}
