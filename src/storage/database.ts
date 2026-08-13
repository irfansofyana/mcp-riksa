import Database from 'better-sqlite3';

const migration = `
CREATE TABLE IF NOT EXISTS migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  suite TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'passed', 'failed', 'cancelled', 'interrupted')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  summary_json TEXT
);

CREATE TABLE IF NOT EXISTS cases (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY (run_id, id)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  duration_ms REAL,
  data_json TEXT NOT NULL,
  sanitized INTEGER NOT NULL CHECK(sanitized = 1)
);

CREATE TRIGGER IF NOT EXISTS events_immutable_update
BEFORE UPDATE ON events BEGIN
  SELECT RAISE(ABORT, 'event rows are immutable');
END;

CREATE TRIGGER IF NOT EXISTS events_immutable_delete
BEFORE DELETE ON events BEGIN
  SELECT RAISE(ABORT, 'event rows are immutable');
END;
`;

const configurationMigration = `
CREATE TABLE IF NOT EXISTS configurations (
  kind TEXT NOT NULL CHECK(kind IN ('provider', 'server')),
  id TEXT NOT NULL,
  config_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
`;

export type WorkbenchDatabase = Database.Database;

export function openDatabase(path: string): WorkbenchDatabase {
  const database = new Database(path);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  const hasMigration = database.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'migrations');
  let version = hasMigration
    ? (database.prepare('SELECT max(version) AS version FROM migrations').get() as { version: number | null }).version ?? 0
    : 0;
  if (version < 1) {
    database.transaction(() => {
      database.exec(migration);
      database.prepare('INSERT INTO migrations(version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
    })();
    version = 1;
  }
  if (version < 2) {
    database.transaction(() => {
      database.exec(configurationMigration);
      database.prepare('INSERT INTO migrations(version, applied_at) VALUES (?, ?)').run(2, new Date().toISOString());
    })();
  }
  return database;
}
