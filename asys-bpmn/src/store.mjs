import { makeDirectory, prepareFile } from '../../asys-runtime/javascript/permissions.mjs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

export class Store {
  constructor(directory) {
    this.listeners = new Set();
    if (directory !== ':memory:') makeDirectory(directory, { recursive: true, mode: 0o700 });
    try {
      if (directory !== ':memory:') {
        for (const name of ['owner.sqlite', 'workflow.sqlite']) prepareFile(join(directory, name));
      }
      // A separate SQLite transaction gives the runtime exclusive ownership of
      // its state. The OS releases this lock even after SIGKILL.
      this.owner = new DatabaseSync(directory === ':memory:' ? ':memory:' : join(directory, 'owner.sqlite'));
      this.owner.exec('CREATE TABLE IF NOT EXISTS owner (id INTEGER); BEGIN EXCLUSIVE');
      this.db = new DatabaseSync(directory === ':memory:' ? ':memory:' : join(directory, 'workflow.sqlite'));
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS workflows (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, artifact TEXT NOT NULL, loaded_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id),
          status TEXT NOT NULL, record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id),
          type TEXT NOT NULL, activity_id TEXT NOT NULL, time TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_run ON events(run_id, sequence);`);
    } catch (error) {
      this.db?.close(); this.owner?.close();
      throw new Error(`Cannot open workflow state: ${error.message}`, { cause: error });
    }
  }
  loadWorkflow(artifact) {
    this.db.prepare('INSERT OR IGNORE INTO workflows VALUES (?, ?, ?, ?)').run(
      artifact.id, artifact.name, JSON.stringify(artifact), new Date().toISOString());
    return artifact.id;
  }
  workflows() { return this.db.prepare('SELECT * FROM workflows ORDER BY loaded_at, id').all(); }
  workflow(id) {
    const row = this.db.prepare('SELECT artifact FROM workflows WHERE id = ?').get(id);
    return row && JSON.parse(row.artifact);
  }
  run(id) {
    const row = this.db.prepare('SELECT record FROM runs WHERE id = ?').get(id);
    return row && JSON.parse(row.record);
  }
  runs() { return this.db.prepare('SELECT record FROM runs ORDER BY rowid DESC').all().map(r => JSON.parse(r.record)); }
  save(record, events = []) {
    const serialized = JSON.stringify(record);
    commitRun(this.db, record, serialized, events);
    for (const listener of this.listeners) listener();
  }
  events(runId, after = 0, limit = 100) {
    return this.db.prepare('SELECT * FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?')
      .all(runId, Number(after), limit);
  }
  // Every run's events in commit order: the feed a host-facing bridge publishes.
  eventsAfter(after = 0, limit = 100) {
    return this.db.prepare('SELECT * FROM events WHERE sequence > ? ORDER BY sequence LIMIT ?').all(Number(after), limit);
  }
  // Called after each committed save. Listeners take no arguments: they read
  // whatever the store now holds, so a missed call costs nothing.
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  close() { this.db?.close(); this.owner?.close(); }
}

export function commitRun(db, record, serialized, events) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, record=excluded.record')
        .run(record.id, record.workflowId, record.status, serialized);
      const insert = db.prepare('INSERT INTO events (run_id, type, activity_id, time, data) VALUES (?, ?, ?, ?, ?)');
      for (const event of events) insert.run(record.id, event.type, event.activityId ?? '', event.time ?? new Date().toISOString(), JSON.stringify(event.data ?? {}));
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve the original write error. */ }
      throw error;
    }
}
