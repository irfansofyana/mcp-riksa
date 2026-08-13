import type { WorkbenchDatabase } from './database.js';

export class ConfigurationRepository {
  constructor(private readonly database: WorkbenchDatabase) {}

  insert(kind: 'provider' | 'server', id: string, config: unknown): void {
    this.database.transaction(() => {
      this.database.prepare('DELETE FROM configuration_tombstones WHERE kind = ? AND id = ?').run(kind, id);
      this.database.prepare('INSERT INTO configurations(kind, id, config_json, updated_at) VALUES (?, ?, ?, ?)')
        .run(kind, id, JSON.stringify(config), new Date().toISOString());
    })();
  }

  seed(kind: 'provider' | 'server', id: string, config: unknown): boolean {
    if (!this.canSeed(kind, id)) return false;
    this.insert(kind, id, config);
    return true;
  }

  canSeed(kind: 'provider' | 'server', id: string): boolean {
    return !this.has(kind, id)
      && this.database.prepare('SELECT 1 FROM configuration_tombstones WHERE kind = ? AND id = ?').get(kind, id) === undefined;
  }

  update(kind: 'provider' | 'server', id: string, config: unknown): boolean {
    return this.database.prepare('UPDATE configurations SET config_json = ?, updated_at = ? WHERE kind = ? AND id = ?')
      .run(JSON.stringify(config), new Date().toISOString(), kind, id).changes > 0;
  }

  delete(kind: 'provider' | 'server', id: string): boolean {
    return this.database.transaction(() => {
      const deleted = this.database.prepare('DELETE FROM configurations WHERE kind = ? AND id = ?').run(kind, id).changes > 0;
      if (deleted) this.database.prepare('INSERT OR REPLACE INTO configuration_tombstones(kind, id, deleted_at) VALUES (?, ?, ?)').run(kind, id, new Date().toISOString());
      return deleted;
    })();
  }

  has(kind: 'provider' | 'server', id: string): boolean {
    return this.database.prepare('SELECT 1 FROM configurations WHERE kind = ? AND id = ?').get(kind, id) !== undefined;
  }

  upsert(kind: 'provider' | 'server', id: string, config: unknown): void {
    this.database.transaction(() => {
      this.database.prepare('DELETE FROM configuration_tombstones WHERE kind = ? AND id = ?').run(kind, id);
      this.database.prepare(`
        INSERT INTO configurations(kind, id, config_json, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(kind, id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at
      `).run(kind, id, JSON.stringify(config), new Date().toISOString());
    })();
  }

  list<T>(kind: 'provider' | 'server'): T[] {
    const rows = this.database.prepare('SELECT config_json FROM configurations WHERE kind = ? ORDER BY id').all(kind) as Array<{ config_json: string }>;
    return rows.map((row) => JSON.parse(row.config_json) as T);
  }
}
