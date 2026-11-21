import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface SqliteQueuedPulseRow {
  id: number;
  event_uid: string;
  station_id: string;
  mm: number;
  timestamp_unix: number;
  queued_at_unix: number;
  source: string;
  attempts: number;
}

export interface SqlitePulseInsert {
  stationId: string;
  eventUid: string;
  mm: number;
  timestampUnix: number;
  queuedAtUnix: number;
  source: string;
}

let sqliteDb: DatabaseSync | null = null;

function getQueueDbPath(): string {
  const configured = process.env.SQLITE_QUEUE_PATH?.trim();
  const target = configured
    ? path.resolve(process.cwd(), configured)
    : path.resolve(process.cwd(), 'prisma', 'queue.db');
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return target;
}

export function getSqliteQueueDb(): DatabaseSync {
  if (sqliteDb) return sqliteDb;

  const dbPath = getQueueDbPath();
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pulse_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_uid TEXT NOT NULL UNIQUE,
      station_id TEXT NOT NULL DEFAULT 'default',
      mm REAL NOT NULL,
      timestamp_unix INTEGER NOT NULL,
      queued_at_unix INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'raspberry',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_pulse_queue_id ON pulse_queue(id);');

  sqliteDb = db;
  return db;
}

export function enqueueToSqlite(items: SqlitePulseInsert[]): number {
  if (items.length === 0) return 0;
  const db = getSqliteQueueDb();
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO pulse_queue (
      event_uid, station_id, mm, timestamp_unix, queued_at_unix, source
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  db.exec('BEGIN IMMEDIATE;');
  try {
    for (const item of items) {
      const res = insertStmt.run(
        item.eventUid,
        item.stationId,
        item.mm,
        item.timestampUnix,
        item.queuedAtUnix,
        item.source,
      );
      inserted += Number(res.changes ?? 0);
    }
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return inserted;
}

export function peekPendingFromSqlite(limit = 200): SqliteQueuedPulseRow[] {
  const db = getSqliteQueueDb();
  const stmt = db.prepare(`
    SELECT id, event_uid, station_id, mm, timestamp_unix, queued_at_unix, source, attempts
    FROM pulse_queue
    ORDER BY id ASC
    LIMIT ?
  `);
  return stmt.all(limit) as unknown as SqliteQueuedPulseRow[];
}

export function removeSyncedFromSqlite(ids: number[]): void {
  if (ids.length === 0) return;
  const db = getSqliteQueueDb();
  const placeholders = ids.map(() => '?').join(',');
  const stmt = db.prepare(`DELETE FROM pulse_queue WHERE id IN (${placeholders})`);
  stmt.run(...ids);
}

export function markBatchFailedInSqlite(ids: number[], errorMessage: string): void {
  if (ids.length === 0) return;
  const db = getSqliteQueueDb();
  const placeholders = ids.map(() => '?').join(',');
  const stmt = db.prepare(`
    UPDATE pulse_queue
    SET attempts = attempts + 1,
        last_error = ?
    WHERE id IN (${placeholders})
  `);
  stmt.run(errorMessage.slice(0, 240), ...ids);
}

export function getSqliteQueueCount(): number {
  const db = getSqliteQueueDb();
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM pulse_queue').get() as
    | { cnt: number }
    | undefined;
  return Number(row?.cnt ?? 0);
}

export function clearSqliteQueue(): void {
  const db = getSqliteQueueDb();
  db.exec('DELETE FROM pulse_queue;');
}
