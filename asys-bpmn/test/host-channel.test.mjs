import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Environments } from '../../asys-runtime/javascript/environments.mjs';
import { Reader, Writer, directionRoot } from '../../asys-runtime/javascript/channel.mjs';
import { Store } from '../src/store.mjs';
import { AsyncStore } from '../src/async-store.mjs';
import { WorkflowRuntime } from '../src/runtime.mjs';
import { serveHostChannel } from '../src/host-channel.mjs';
import { workflow, flow, until } from './helpers.mjs';

const executor = fileURLToPath(new URL('../../asys-runtime/tools/asys-runtime', import.meta.url));
const binding = '<bpmn:extensionElements><asys:job type="program"/></bpmn:extensionElements>';
const command = ['python3', '-c', 'import json,os; json.dump({"answer": 42}, open(os.environ["ASYS_RESULT"], "w"))'];

async function fixture(t, workerCommand = command) {
  const root = await mkdtemp(join(tmpdir(), 'asys-host-channel-'));
  await mkdir(join(root, 'workspace'));
  const runtimeRoot = join(root, 'runtime');
  const environments = new Environments(runtimeRoot);
  const directory = join(root, 'env', 'test');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'workers.json'), JSON.stringify({ version: 1, name: 'test', types: { program: { command: workerCommand } } }));
  const child = spawn('python3', [executor, 'run', directory, '--root', runtimeRoot], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  await until(async () => (await environments.list()).some(environment => environment.name === 'test'));
  const f = { root, runtimeRoot, environments, state: join(root, 'workflow'), served: [],
    host: { send: await new Writer(directionRoot(runtimeRoot, 'workflow', 'in')).ready(),
      read: await new Reader(directionRoot(runtimeRoot, 'workflow', 'out')).ready() },
    serve({ recover = true } = {}) {
      const controller = new AbortController();
      const runtime = new WorkflowRuntime({ store: new AsyncStore(this.state), environments });
      const running = (recover ? runtime.recover() : Promise.resolve()).then(() => serveHostChannel(runtime, { root: runtimeRoot, signal: controller.signal }));
      const entry = { runtime, controller, running, async stop() { controller.abort(new Error('test stop')); await running; await runtime.close(); } };
      this.served.push(entry);
      return entry;
    },
    async collect(predicate, { after = 0 } = {}) {
      return until(async () => { const events = await this.host.read.read(after); return events.some(predicate) && events; });
    } };
  t.after(async () => {
    for (const entry of f.served) await entry.stop().catch(() => {});
    child.kill('SIGTERM');
    await exited;
    await rm(root, { recursive: true, force: true });
  });
  return f;
}

test('status distinguishes an active workflow from preserved state in an await-resume component without changing it', async t => {
  const f = await fixture(t);
  let engine = f.serve();
  await f.host.send.send('start', { id: 'waiting', bpmnXml: workflow('<bpmn:receiveTask id="pause"/>'), environment: 'test' });
  await f.collect(event => event.type === 'activity.wait');
  let request = await f.host.send.send('status', { id: 'waiting' });
  let replies = await f.collect(event => event.type === 'accepted' && event.data.request === request.sequence);
  let reply = replies.find(event => event.type === 'accepted' && event.data.request === request.sequence);
  assert.equal(reply.data.runId, 'waiting');
  assert.equal(reply.data.status, 'waiting');
  assert.equal(reply.data.active, true);
  await engine.stop();
  engine = f.serve({ recover: false });
  const record = engine.runtime.store.run('waiting');
  const events = engine.runtime.store.events('waiting');
  request = await f.host.send.send('status', { id: 'waiting' });
  replies = await f.collect(event => event.type === 'accepted' && event.data.request === request.sequence);
  reply = replies.find(event => event.type === 'accepted' && event.data.request === request.sequence);
  assert.equal(reply.data.workflowId, record.workflowId);
  assert.equal(reply.data.status, 'waiting');
  assert.equal(reply.data.active, false);
  assert.deepEqual(engine.runtime.store.run('waiting'), record);
  assert.deepEqual(engine.runtime.store.events('waiting'), events);
  await engine.stop();
});

test('recover reattaches an inactive workflow to its still-running job without cancellation or replacement', async t => {
  const f = await fixture(t, ['python3', '-c', `import json,os,pathlib,signal,time
with open('starts', 'a') as log: log.write(os.environ['ASYS_JOB_ID'] + '\\n')
def cancelled(*args):
    pathlib.Path('cancelled').write_text('cancelled')
    raise SystemExit(1)
signal.signal(signal.SIGTERM, cancelled)
while not pathlib.Path('release').exists(): time.sleep(0.01)
json.dump({'answer':42}, open(os.environ['ASYS_RESULT'], 'w'))`]);
  let engine = f.serve();
  await f.host.send.send('start', { id: 'running', bpmnXml: workflow(`<bpmn:task id="work">${binding}</bpmn:task>`), environment: 'test' });
  await f.collect(event => event.type === 'job.created');
  const job = await until(() => Object.values(engine.runtime.store.run('running')?.jobs ?? {}).find(job => job.status === 'submitted'));
  const queue = f.environments.queue('test');
  await until(async () => (await queue.state(job.id)).status === 'running');
  await until(async () => { try { return await readFile(join(f.root, 'workspace', 'starts'), 'utf8'); } catch { return false; } });
  await engine.stop();
  assert.equal((await queue.state(job.id)).status, 'running');
  engine = f.serve({ recover: false });
  for (let attempt = 0; attempt < 2; attempt++) {
    const request = await f.host.send.send('recover', { id: 'running' });
    const replies = await f.collect(event => event.type === 'accepted' && event.data.request === request.sequence);
    assert.equal(replies.find(event => event.type === 'accepted' && event.data.request === request.sequence).data.active, true);
  }
  assert.equal(Object.values(engine.runtime.store.run('running').jobs)[0].id, job.id);
  assert.equal((await queue.state(job.id)).status, 'running');
  await writeFile(join(f.root, 'workspace', 'release'), 'go');
  const events = await f.collect(event => event.type === 'run.result');
  assert.equal(events.at(-1).data.status, 'completed');
  assert.equal(events.filter(event => event.type === 'run.recovered').length, 1);
  assert.equal(events.filter(event => event.type === 'job.created').length, 1);
  assert.equal(events.filter(event => event.type === 'job.completed').length, 1);
  assert.equal(await readFile(join(f.root, 'workspace', 'starts'), 'utf8'), `${job.id}\n`);
  await assert.rejects(readFile(join(f.root, 'workspace', 'cancelled')), { code: 'ENOENT' });
  await engine.stop();
});

test('terminal status and recovery include the durable result after the previous result event was pruned', async t => {
  const f = await fixture(t);
  const engine = f.serve();
  await f.host.send.send('start', { id: 'finished', bpmnXml: workflow(`<bpmn:task id="work">${binding}</bpmn:task>`),
    environment: 'test', variables: { request: 'retained' } });
  const events = await f.collect(event => event.type === 'run.result');
  const previous = events.find(event => event.type === 'run.result');
  const { store: _watermark, ...expected } = previous.data;
  const barrier = await f.host.send.send('status', { id: 'finished' });
  const acknowledged = await f.collect(event => event.type === 'accepted' && event.data.request === barrier.sequence);
  const after = acknowledged.find(event => event.type === 'accepted' && event.data.request === barrier.sequence).sequence;
  await f.host.read.advance(after);
  await f.host.read.prune();
  assert.ok(!(await f.host.read.read(0)).some(event => event.type === 'run.result'));
  const before = engine.runtime.store.events('finished', 0, 1000);
  for (const kind of ['status', 'recover']) {
    const request = await f.host.send.send(kind, { id: 'finished' });
    const replies = await f.collect(event => event.type === 'accepted' && event.data.request === request.sequence,
      { after });
    const reply = replies.find(event => event.type === 'accepted' && event.data.request === request.sequence);
    assert.equal(reply.data.status, 'completed');
    assert.deepEqual(reply.data.result, expected);
  }
  assert.deepEqual(engine.runtime.store.events('finished', 0, 1000), before);
  await engine.stop();
});

test('a run started over the channel reports every event and a result, and a bad request is rejected in place', async t => {
  const f = await fixture(t);
  const engine = f.serve();
  const bpmnXml = workflow(`<bpmn:task id="work" name="Prepare design">${binding}</bpmn:task>`);
  const start = await f.host.send.send('start', { id: 'one', bpmnXml, environment: 'test', variables: { question: 'x' } });
  const events = await f.collect(e => e.type === 'run.result' && e.data.runId === 'one');
  const accepted = events.find(e => e.type === 'accepted');
  assert.deepEqual([accepted.data.request, accepted.data.runId], [start.sequence, 'one']);
  const types = events.filter(e => e.data.runId === 'one' && 'activityId' in e.data).map(e => e.type);
  assert.deepEqual(types.slice(0, 2), ['run.created', 'activity.start']);
  assert.ok(types.includes('job.created') && types.includes('run.completed'));
  const started = events.find(e => e.type === 'activity.start' && e.data.activityId === 'work');
  const finished = events.find(e => e.type === 'activity.end' && e.data.activityId === 'work');
  assert.equal(started.data.data.name, 'Prepare design');
  assert.equal(started.data.data.activityType, 'bpmn:Task');
  assert.equal(finished.data.data.executionId, started.data.data.executionId);
  const result = events.at(-1);
  assert.equal(result.type, 'run.result');
  assert.equal(result.data.status, 'completed');
  assert.deepEqual(result.data.output, { work: { answer: 42 } });
  const stores = events.filter(e => e.data.runId === 'one' && 'activityId' in e.data).map(e => e.data.store);
  assert.deepEqual(stores, [...stores].sort((a, b) => a - b), 'store sequences are published in commit order');
  const bad = await f.host.send.send('start', { id: 'two', bpmnXml: '<not-bpmn/>', environment: 'test' });
  const [rejected] = await f.collect(e => e.type === 'rejected' && e.data.request === bad.sequence, { after: result.sequence });
  assert.equal(rejected.type, 'rejected');
  assert.ok(rejected.data.message);
  assert.equal((await f.host.send.send('nonsense', {})).sequence, 3);
  const [unknown] = await f.collect(e => e.type === 'rejected' && e.data.request === 3, { after: rejected.sequence });
  assert.match(unknown.data.message, /Unknown request/);
  await engine.stop();
});

test('cancel over the channel ends a waiting run, and a restarted component neither repeats nor loses events', async t => {
  const f = await fixture(t);
  let engine = f.serve();
  const bpmnXml = workflow(`<bpmn:task id="first">${binding}</bpmn:task><bpmn:receiveTask id="pause" name="Wait for approval"/>${flow('one', 'first', 'pause')}`);
  await f.host.send.send('start', { id: 'waiting', bpmnXml, environment: 'test' });
  const before = await f.collect(e => e.type === 'activity.wait' && e.data.activityId === 'pause');
  assert.equal(before.find(e => e.type === 'activity.wait').data.data.name, 'Wait for approval');
  await engine.stop();
  const published = (await f.host.read.read(0)).length;
  engine = f.serve();
  await new Promise(resolve => setTimeout(resolve, 200));
  const resumed = (await f.host.read.read(0)).slice(published);
  assert.deepEqual(resumed.map(event => event.type).sort(), ['activity.wait', 'run.recovered'],
    'a restart announces recovery and the current wait without replaying stage starts or ends');
  const cancel = await f.host.send.send('cancel', { id: 'waiting' });
  const events = await f.collect(e => e.type === 'run.result' && e.data.runId === 'waiting', { after: before.at(-1).sequence });
  assert.ok(events.some(e => e.type === 'accepted' && e.data.request === cancel.sequence && e.data.status === 'cancelled'));
  assert.ok(events.some(e => e.type === 'run.cancelled'));
  assert.equal(events.at(-1).data.status, 'cancelled');
  await engine.stop();
});

test('resume over the channel uses saved BPMN and creates a new job and preserves the workspace', async t => {
  const f = await fixture(t, ['python3', '-c', `import json,os,pathlib
p = pathlib.Path('saved.txt')
if not p.exists():
    p.write_text('partial work')
    raise SystemExit(17)
assert p.read_text() == 'partial work'
json.dump({'answer': 42}, open(os.environ['ASYS_RESULT'], 'w'))`]);
  let engine = f.serve();
  await f.host.send.send('start', { id: 'retry', bpmnXml: workflow(`<bpmn:task id="work">${binding}</bpmn:task>`), environment: 'test' });
  const failed = await f.collect(e => e.type === 'run.result');
  assert.equal(failed.at(-1).data.status, 'failed');
  const job = Object.values(engine.runtime.record('retry').jobs)[0];
  await engine.stop();
  engine = f.serve();
  const request = await f.host.send.send('resume', { id: 'retry' });
  const events = await f.collect(e => e.type === 'run.result' || e.type === 'rejected', { after: failed.at(-1).sequence });
  assert.equal(events.at(-1).type, 'run.result', JSON.stringify(events));
  assert.equal(events.at(-1).data.status, 'completed');
  assert.deepEqual(events.at(-1).data.output, { work: { answer: 42 } });
  assert.ok(events.some(e => e.type === 'accepted' && e.data.request === request.sequence));
  assert.equal(events.filter(e => e.type === 'run.recovered').length, 1);
  assert.equal(events.filter(e => e.type === 'job.created').length, 1);
  const queue = f.environments.queue('test');
  const replacement = Object.values(engine.runtime.record('retry').jobs)[0];
  assert.notEqual(replacement.id, job.id);
  assert.equal((await queue.state(job.id)).status, 'failed');
  assert.equal((await queue.state(replacement.id)).status, 'done');
  assert.equal((await queue.paths(job.id)).workspace, (await queue.paths(replacement.id)).workspace);
  await engine.stop();
});

test('a result missing after a crash between the terminal event and run.result is published on restart', async t => {
  const f = await fixture(t);
  const engine = f.serve();
  const bpmnXml = workflow(`<bpmn:task id="work">${binding}</bpmn:task>`);
  await f.host.send.send('start', { id: 'crashy', bpmnXml, environment: 'test' });
  const events = await f.collect(e => e.type === 'run.result' && e.data.runId === 'crashy');
  await engine.stop();
  // Simulate the crash window: the channel ends with the terminal event only.
  const outbound = directionRoot(f.runtimeRoot, 'workflow', 'out');
  const last = events.at(-1);
  await rm(join(outbound, `${String(last.sequence).padStart(9, '0')}.json`));
  assert.equal((await f.host.read.read(0)).at(-1).type, 'run.completed');
  const again = f.serve();
  const restored = await f.collect(e => e.sequence === last.sequence);
  assert.equal(restored.at(-1).type, 'run.result');
  assert.equal(restored.at(-1).data.status, 'completed');
  assert.equal(restored.filter(e => e.type === 'run.result').length, 1);
  await again.stop();
});

async function savedTerminal(t) {
  const root = await mkdtemp(join(tmpdir(), 'asys-channel-recovery-'));
  const store = new Store(':memory:');
  store.loadWorkflow({ id: 'workflow', name: 'Workflow' });
  store.save({ id: 'one', workflowId: 'workflow', status: 'completed', output: { answer: 42 }, variables: {}, environment: 'test' },
    [{ type: 'run.completed' }]);
  const controller = new AbortController();
  const writer = await new Writer(directionRoot(root, 'workflow', 'out')).ready();
  const reader = await new Reader(writer.directory).ready();
  let running;
  t.after(async () => {
    controller.abort();
    await running?.catch(() => {});
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, writer, reader, controller,
    start() {
      running = serveHostChannel({ store }, { root, signal: controller.signal });
      running.catch(() => {});
      return running;
    },
  };
}

test('recovery supplies a missing result even when an acknowledgement follows the terminal event', async t => {
  const f = await savedTerminal(t);
  await f.writer.send('run.completed', { store: 1, runId: 'one', activityId: '', time: '', data: {} });
  await f.writer.send('accepted', { store: 1, request: 1, runId: 'one', status: 'completed' });
  f.start();
  const events = await until(async () => {
    const events = await f.reader.read(0);
    return events.some(e => e.type === 'run.result') && events;
  }, { timeout: 500 });
  assert.equal(events.filter(e => e.type === 'run.completed').length, 1);
  assert.deepEqual(events.find(e => e.type === 'run.result').data.output, { answer: 42 });
});

test('a stale store watermark in a reply does not replay already published run events', async t => {
  const f = await savedTerminal(t);
  await f.writer.send('run.completed', { store: 1, runId: 'one', activityId: '', time: '', data: {} });
  await f.writer.send('run.result', { store: 1, runId: 'one', status: 'completed', output: { answer: 42 } });
  await f.writer.send('accepted', { store: 0, request: 1, runId: 'one', status: 'completed' });
  f.start();
  // A subsequent request proves startup recovery has finished.
  await new Writer(directionRoot(f.root, 'workflow', 'in')).send('unknown', {});
  const events = await until(async () => {
    const events = await f.reader.read(0);
    return events.some(e => e.type === 'rejected') && events;
  });
  assert.equal(events.filter(e => e.type === 'run.completed').length, 1);
  assert.equal(events.filter(e => e.type === 'run.result').length, 1);
});

test('a result publication error fails the channel instead of leaving a healthy silent service', async t => {
  const f = await savedTerminal(t);
  const original = Writer.prototype.send;
  t.mock.method(Writer.prototype, 'send', async function(type, data) {
    if (type === 'run.result') throw Object.assign(new Error('result publication failed'), { code: 'EIO' });
    return original.call(this, type, data);
  });
  const outcome = await Promise.race([
    f.start().then(() => 'stopped', error => error.message),
    new Promise(resolve => setTimeout(() => resolve('still waiting'), 500)),
  ]);
  assert.match(outcome, /result publication failed/);
});

test('a publication error after startup interrupts the request watcher and fails the channel', async t => {
  const f = await savedTerminal(t);
  const running = f.start();
  await until(async () => (await f.reader.read(0)).some(e => e.type === 'run.result'));
  const original = Writer.prototype.send;
  t.mock.method(Writer.prototype, 'send', async function(type, data) {
    if (type === 'run.completed') throw Object.assign(new Error('later publication failed'), { code: 'EIO' });
    return original.call(this, type, data);
  });
  f.store.save({ ...f.store.run('one'), id: 'two' }, [{ type: 'run.completed' }]);
  const outcome = await Promise.race([
    running.then(() => 'stopped', error => error.message),
    new Promise(resolve => setTimeout(() => resolve('still waiting'), 500)),
  ]);
  assert.match(outcome, /later publication failed/);
});

test('the component rejects a start against a different environment definition', async t => {
  const f = await fixture(t);
  const engine = f.serve();
  const bpmnXml = workflow(`<bpmn:task id="work">${binding}</bpmn:task>`);
  const request = await f.host.send.send('start', { id: 'mismatch', bpmnXml, environment: 'test', environmentDefinition: '0'.repeat(64) });
  const events = await f.collect(e => e.type === 'rejected' && e.data.request === request.sequence);
  assert.match(events.find(e => e.type === 'rejected').data.message, /workers.json differs/);
  assert.deepEqual(engine.runtime.store.runs(), []);
});
