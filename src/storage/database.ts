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

const conversationMigration = `
CREATE TABLE IF NOT EXISTS playground_conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  server_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playground_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES playground_conversations(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(conversation_id, sequence)
);

CREATE INDEX IF NOT EXISTS playground_messages_conversation
ON playground_messages(conversation_id, sequence);
`;

const playgroundTraceMigration = `
CREATE TABLE IF NOT EXISTS playground_events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES playground_conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES playground_messages(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  duration_ms REAL,
  data_json TEXT NOT NULL,
  sanitized INTEGER NOT NULL CHECK(sanitized = 1),
  UNIQUE(conversation_id, sequence)
);

CREATE INDEX IF NOT EXISTS playground_events_conversation
ON playground_events(conversation_id, sequence);

CREATE TRIGGER IF NOT EXISTS playground_events_immutable_update
BEFORE UPDATE ON playground_events BEGIN
  SELECT RAISE(ABORT, 'playground event rows are immutable');
END;

CREATE TRIGGER IF NOT EXISTS playground_events_immutable_delete
BEFORE DELETE ON playground_events
WHEN EXISTS (SELECT 1 FROM playground_conversations WHERE id = OLD.conversation_id)
BEGIN
  SELECT RAISE(ABORT, 'playground event rows are immutable');
END;
`;

const configurationTombstoneMigration = `
CREATE TABLE IF NOT EXISTS configuration_tombstones (
  kind TEXT NOT NULL CHECK(kind IN ('provider', 'server')),
  id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
`;

const conformanceMigration = `
CREATE TABLE IF NOT EXISTS conformance_reports (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  selection_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'passed', 'failed', 'warning', 'harness_error', 'cancelled', 'timed_out', 'interrupted')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  runner_version TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  raw_report_json TEXT,
  diagnostic TEXT
);

CREATE TABLE IF NOT EXISTS conformance_checks (
  report_id TEXT NOT NULL REFERENCES conformance_reports(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  scenario TEXT NOT NULL,
  check_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('passed', 'failed', 'warning', 'skipped', 'harness_error')),
  check_json TEXT NOT NULL,
  PRIMARY KEY (report_id, sequence)
);

CREATE INDEX IF NOT EXISTS conformance_reports_server_started
ON conformance_reports(server_id, started_at DESC);
`;

export type WorkbenchDatabase = Database.Database;

function backfillPlaygroundEvents(database: WorkbenchDatabase): void {
  const rows = database.prepare(`
    SELECT id, conversation_id, detail_json
    FROM playground_messages ORDER BY conversation_id, sequence
  `).all() as Array<{ id: string; conversation_id: string; detail_json: string }>;
  const sequences = new Map<string, number>();
  const insert = database.prepare(`
    INSERT OR IGNORE INTO playground_events(id, conversation_id, message_id, sequence, type, timestamp, duration_ms, data_json, sanitized)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  for (const row of rows) {
    let detail: { events?: unknown[] };
    try { detail = JSON.parse(row.detail_json) as { events?: unknown[] }; }
    catch { continue; }
    for (const raw of detail.events ?? []) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as Record<string, unknown>;
      if (typeof entry.id !== 'string' || typeof entry.type !== 'string' || typeof entry.timestamp !== 'string') continue;
      const sequence = (sequences.get(row.conversation_id) ?? 0) + 1;
      sequences.set(row.conversation_id, sequence);
      insert.run(entry.id, row.conversation_id, row.id, sequence, entry.type, entry.timestamp, typeof entry.durationMs === 'number' ? entry.durationMs : null, JSON.stringify(entry.data ?? null));
    }
  }
}

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
    version = 2;
  }
  if (version < 3) {
    database.transaction(() => {
      database.exec(conversationMigration);
      database.prepare('INSERT INTO migrations(version, applied_at) VALUES (?, ?)').run(3, new Date().toISOString());
    })();
    version = 3;
  }
  if (version < 4) {
    database.transaction(() => {
      database.exec(playgroundTraceMigration);
      backfillPlaygroundEvents(database);
      database.prepare('INSERT INTO migrations(version, applied_at) VALUES (?, ?)').run(4, new Date().toISOString());
    })();
    version = 4;
  }
  if (version < 5) {
    database.transaction(() => {
      database.exec(configurationTombstoneMigration);
      database.prepare('INSERT INTO migrations(version, applied_at) VALUES (?, ?)').run(5, new Date().toISOString());
    })();
    version = 5;
  }
  if (version < 6) {
    database.transaction(() => {
      const columns = database.pragma('table_info(playground_conversations)') as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'system_prompt')) {
        database.exec("ALTER TABLE playground_conversations ADD COLUMN system_prompt TEXT NOT NULL DEFAULT ''");
      }
      database.prepare('INSERT INTO migrations(version, applied_at) VALUES (?, ?)').run(6, new Date().toISOString());
    })();
    version = 6;
  }
  if (version < 7) {
    database.transaction(() => {
      database.exec(conformanceMigration);
      database.prepare('INSERT INTO migrations(version, applied_at) VALUES (?, ?)').run(7, new Date().toISOString());
    })();
    version = 7;
  }
  if (version < 8) {
    database.transaction(() => {
      const columns = database.pragma('table_info(events)') as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'iteration')) database.exec('ALTER TABLE events ADD COLUMN iteration INTEGER');
      if (!columns.some((column) => column.name === 'user_turn_id')) database.exec('ALTER TABLE events ADD COLUMN user_turn_id TEXT');
      if (!columns.some((column) => column.name === 'model_turn')) database.exec('ALTER TABLE events ADD COLUMN model_turn INTEGER');
      database.prepare('INSERT INTO migrations(version, applied_at) VALUES (?, ?)').run(8, new Date().toISOString());
    })();
  }
  return database;
}
