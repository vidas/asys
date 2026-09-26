// Durable writes run on a separate thread so filesystem stalls do not block
// workflow RPCs, cancellation requests or the engine's heartbeat.
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { commitRun } from './store.mjs';

const db = new DatabaseSync(workerData.path);
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=30000;');
let failure;
parentPort.on('message', ({ id, type, data }) => {
  try {
    if (failure) throw failure;
    if (type === 'save') commitRun(db, data.record, data.serialized, data.events);
    else if (type === 'workflow') {
      db.prepare('INSERT OR IGNORE INTO workflows VALUES (?, ?, ?, ?)').run(...data);
    } else if (type === 'close') db.close();
    else throw new Error(`Unknown persistence operation ${type}`);
    parentPort.postMessage({ id });
    if (type === 'close') parentPort.close();
  } catch (error) {
    // Never commit a newer snapshot after a failed checkpoint: its events may
    // depend on the missing transaction. The component must recover instead.
    failure = error;
    parentPort.postMessage({ id, error: { message: error.message, stack: error.stack } });
  }
});
