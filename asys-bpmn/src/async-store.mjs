import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { Store } from './store.mjs';

export class AsyncStore extends Store {
  constructor(directory) {
    if (directory === ':memory:') throw new Error('AsyncStore requires durable storage');
    super(directory);
    this.requests = new Map();
    this.sequence = 0;
    this.failed = new Promise((_, reject) => { this.rejectFailure = reject; });
    // Failure may precede main's startup/recovery. Keep it observable without
    // turning that interval into an unhandled promise rejection.
    this.failed.catch(() => {});
    this.writer = new Worker(new URL('./store-writer.mjs', import.meta.url), {
      workerData: { path: join(directory, 'workflow.sqlite') },
    });
    this.writer.on('message', ({ id, error }) => {
      const pending = this.requests.get(id);
      if (!pending) return;
      if (error) this.fail(Object.assign(new Error(error.message), { stack: error.stack }));
      else { this.requests.delete(id); pending.resolve(); }
    });
    this.writer.on('error', error => this.fail(error));
    this.writer.on('exit', code => {
      if (!this.closing || this.requests.size) this.fail(new Error(`Workflow persistence thread exited (${code})`));
    });
  }
  fail(error) {
    if (this.failure) return;
    this.failure = error;
    this.rejectFailure(error);
    for (const pending of this.requests.values()) pending.reject(error);
    this.requests.clear();
  }
  request(type, data) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing && type !== 'close') return Promise.reject(new Error('Workflow persistence is closing'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject, started: Date.now() });
      try { this.writer.postMessage({ id, type, data }); }
      catch (error) { this.fail(error); }
    });
  }
  healthy() {
    if (this.failure) return false;
    const oldest = this.requests.values().next().value;
    return !oldest || Date.now() - oldest.started < 60_000;
  }
  async loadWorkflow(artifact) {
    await this.request('workflow', [artifact.id, artifact.name, JSON.stringify(artifact), new Date().toISOString()]);
    return artifact.id;
  }
  async save(record, events = []) {
    await this.request('save', {
      record: { id: record.id, workflowId: record.workflowId, status: record.status },
      serialized: JSON.stringify(record), events,
    });
    for (const listener of this.listeners) listener();
  }
  close() {
    if (!this.closed) {
      this.closing = true;
      this.closed = (async () => {
        try { if (!this.failure) await this.request('close'); }
        finally { await this.writer.terminate(); super.close(); }
      })();
    }
    return this.closed;
  }
}
