import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { AsyncStore } from '../src/async-store.mjs';
import { WorkflowRuntime } from '../src/runtime.mjs';
import { heartbeat } from '../../asys-runtime/javascript/health.mjs';
import { workflow, flow, until } from './helpers.mjs';

const binding = '<bpmn:extensionElements><asys:job type="program"/></bpmn:extensionElements>';
const oneJob = workflow(`<bpmn:task id="first">${binding}</bpmn:task>`);
const twoJobs = workflow(`<bpmn:task id="first">${binding}</bpmn:task><bpmn:task id="second">${binding}</bpmn:task>${flow('next', 'first', 'second')}`);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'asys-async-store-'));
  await mkdir(join(root, 'workspace'));
  const state = join(root, 'state');
  const store = new AsyncStore(state);
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, state, store };
}

function runtimeFor(root, store, queue) {
  const environments = { root: join(root, 'runtime'), queue: () => queue,
    get: async () => ({ types: ['program'] }) };
  return new WorkflowRuntime({ store, environments });
}

function lock(store, state) {
  const db = new DatabaseSync(join(state, 'workflow.sqlite'));
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 2);
  db.exec('BEGIN IMMEDIATE');
  let held = true;
  return () => { if (held) { held = false; db.exec('ROLLBACK'); db.close(); } };
}

test('a real SQLite write lock leaves timers and heartbeat responsive and acknowledgements wait for ordered commits', async t => {
  const { root, state, store } = await fixture(t);
  await store.loadWorkflow({ id: 'workflow', name: 'Test' });
  const release = lock(store, state);
  t.after(release);
  const health = join(root, 'heartbeat');
  const stop = heartbeat(health, { ready: () => store.healthy() });
  t.after(stop);
  const before = (await stat(health)).mtimeMs;
  let ticks = 0, acknowledged = 0, notifications = 0;
  const timer = setInterval(() => ticks++, 10);
  t.after(() => clearInterval(timer));
  store.subscribe(() => notifications++);
  const record = { id: 'run', workflowId: 'workflow', status: 'running', value: 1 };
  const first = store.save(record, [{ type: 'first' }]).then(() => acknowledged++);
  record.value = 2;
  const second = store.save(record, [{ type: 'second' }]).then(() => acknowledged++);
  await delay(2200);
  assert.ok(ticks > 50, `only ${ticks} event-loop ticks while SQLite was locked`);
  assert.ok((await stat(health)).mtimeMs > before, 'the production heartbeat continues ticking');
  assert.equal(store.run('run'), undefined);
  assert.equal(acknowledged, 0);
  assert.equal(notifications, 0);
  release();
  await Promise.all([first, second]);
  assert.equal(acknowledged, 2);
  assert.equal(notifications, 2);
  assert.equal(store.run('run').value, 2);
  assert.deepEqual(store.events('run').map(event => event.type), ['first', 'second']);
  await store.close();
  const reopened = new AsyncStore(state);
  try {
    assert.equal(reopened.run('run').value, 2);
    assert.deepEqual(reopened.events('run').map(event => event.type), ['first', 'second']);
  } finally { await reopened.close(); }
});

test('run creation, duplicate requests, job dispatch and callbacks wait for their durable checkpoints', async t => {
  const { root, state, store } = await fixture(t);
  let releaseOutcome, outcomeLocked = false;
  const submissions = [];
  const queue = {
    async submit(type, id, options) {
      const saved = store.run('run');
      assert.ok(Object.values(saved.jobs).some(job => job.id === id), 'job identity is durable before dispatch');
      if (options.metadata.activity_id === 'second') {
        assert.equal(Object.values(saved.jobs).find(job => job.activityId === 'first').status, 'completed',
          'the first outcome is durable before its callback can start the second task');
      }
      submissions.push(id);
    },
    async wait(id) {
      if (id === submissions[0]) { releaseOutcome = lock(store, state); outcomeLocked = true; }
      return { status: 'done', result: { answer: 42 } };
    },
    async cancel() {},
  };
  const runtime = runtimeFor(root, store, queue);
  t.after(async () => { releaseOutcome?.(); await runtime.close(); });
  const { workflowId } = await runtime.loadWorkflow({ bpmnXml: twoJobs });
  const releaseStart = lock(store, state);
  t.after(releaseStart);
  const request = { id: 'run', workflowId, environment: 'test' };
  let acknowledged = 0;
  const first = runtime.startRun(request).then(value => { acknowledged++; return value; });
  const duplicate = runtime.startRun(request).then(value => { acknowledged++; return value; });
  const different = assert.rejects(runtime.startRun({ ...request, variablesJson: '{"different":true}' }), /different input/);
  await delay(100);
  assert.equal(acknowledged, 0);
  assert.deepEqual(submissions, []);
  releaseStart();
  await until(() => outcomeLocked);
  await delay(100);
  assert.equal(submissions.length, 1, 'a blocked outcome checkpoint cannot call the successor');
  assert.equal(Object.values(store.run('run').jobs)[0].status, 'submitted');
  releaseOutcome();
  await Promise.all([first, duplicate, different]);
  await until(() => store.run('run')?.status === 'completed');
  assert.equal(submissions.length, 2);
  const events = store.events('run', 0, 1000);
  assert.equal(events.filter(event => event.type === 'run.created').length, 1);
  assert.equal(events.filter(event => event.type === 'job.created').length, 2);
  assert.equal(events.filter(event => event.type === 'job.completed').length, 2);
  await runtime.close();
  const reopened = new AsyncStore(state);
  const restarted = runtimeFor(root, reopened, queue);
  try {
    await restarted.recover();
    assert.equal(submissions.length, 2);
    assert.deepEqual(reopened.events('run', 0, 1000), events);
  } finally { await restarted.close(); }
});

for (const checkpoint of ['job.created', 'job.completed']) {
  test(`SIGKILL after ${checkpoint} commit preserves job identity and consumes the outcome once on recovery`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'asys-checkpoint-crash-'));
    await mkdir(join(root, 'workspace'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const state = join(root, 'state');
    const source = `
      import { AsyncStore } from ${JSON.stringify(new URL('../src/async-store.mjs', import.meta.url).href)};
      import { WorkflowRuntime } from ${JSON.stringify(new URL('../src/runtime.mjs', import.meta.url).href)};
      const store = new AsyncStore(${JSON.stringify(state)});
      const queue = { async submit(type, id) { console.log('submit:' + id); },
        async wait() { return {status:'done', result:{answer:42}}; }, async cancel() {} };
      const runtime = new WorkflowRuntime({store, workspace:${JSON.stringify(join(root, 'workspace'))},
        environments:{root:${JSON.stringify(join(root, 'runtime'))}, queue:()=>queue, get:async()=>({types:['program']})}});
      const {workflowId} = await runtime.loadWorkflow({bpmnXml:${JSON.stringify(oneJob)}});
      store.subscribe(() => {
        if (store.events('run').some(event => event.type === ${JSON.stringify(checkpoint)})) process.kill(process.pid, 'SIGKILL');
      });
      await runtime.startRun({id:'run', workflowId, environment:'test'});
    `;
    const script = join(root, 'crash.mjs');
    await writeFile(script, source);
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { errors += data; });
    const [, signal] = await once(child, 'exit');
    assert.equal(signal, 'SIGKILL', errors);
    const store = new AsyncStore(state);
    const saved = Object.values(store.run('run').jobs)[0];
    const submissions = output.trim().split('\n').filter(line => line.startsWith('submit:')).map(line => line.slice(7));
    const queue = { async submit(type, id) { submissions.push(id); },
      async wait() { return { status: 'done', result: { answer: 42 } }; }, async cancel() {} };
    const runtime = runtimeFor(root, store, queue);
    try {
      await runtime.recover();
      await until(() => store.run('run').status === 'completed');
      assert.deepEqual(submissions, [saved.id]);
      assert.deepEqual(store.run('run').output, { first: { answer: 42 } });
      const events = store.events('run', 0, 1000);
      for (const type of ['job.created', 'job.completed', 'run.completed']) {
        assert.equal(events.filter(event => event.type === type).length, 1, type);
      }
    } finally { await runtime.close(); }
  });
}

test('public terminal status and cancellation acknowledgement remain behind a blocked terminal checkpoint', async t => {
  const { root, state, store } = await fixture(t);
  let release;
  const runtime = runtimeFor(root, store, { async submit() {}, async cancel() {},
    async wait() { return { status: 'done', result: { answer: 42 } }; } });
  t.after(async () => { release?.(); await runtime.close(); });
  const { workflowId } = await runtime.loadWorkflow({ bpmnXml: oneJob });
  store.subscribe(() => {
    if (!release && store.events('run').some(event => event.type === 'job.completed')) release = lock(store, state);
  });
  const starting = runtime.startRun({ id: 'run', workflowId, environment: 'test' });
  await until(() => runtime.active.get('run')?.record.status === 'completed');
  assert.notEqual(runtime.getRun({ id: 'run' }).run.status, 'completed');
  let acknowledged = false;
  const cancelling = runtime.cancelRun({ id: 'run' }).then(result => { acknowledged = true; return result; });
  await delay(100);
  assert.equal(acknowledged, false);
  release();
  await starting;
  assert.equal((await cancelling).run.status, 'completed');
  assert.equal(runtime.getRun({ id: 'run' }).run.status, 'completed');
});

test('a SQL commit failure rejects pending requests, fails health and closes without unhandled rejections', async t => {
  const { root, store } = await fixture(t);
  let submissions = 0;
  const runtime = runtimeFor(root, store, { async submit() { submissions++; } });
  const { workflowId } = await runtime.loadWorkflow({ bpmnXml: oneJob });
  store.db.exec("CREATE TRIGGER fail_save BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'checkpoint write failed'); END;");
  const failure = assert.rejects(store.failed, /checkpoint write failed/);
  const request = { id: 'run', workflowId, environment: 'test' };
  await Promise.all([
    assert.rejects(runtime.startRun(request), /checkpoint write failed/),
    assert.rejects(runtime.startRun(request), /checkpoint write failed/),
    failure,
  ]);
  assert.equal(submissions, 0);
  assert.equal(store.healthy(), false);
  await runtime.close();
});
