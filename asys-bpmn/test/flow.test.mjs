// The workflow/1 interpreter, through the same runtime, store and filesystem
// queue as BPMN runs. Documents are given in the resolved form the host sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Environments } from '../../asys-runtime/javascript/environments.mjs';
import { AsyncStore as Store } from '../src/async-store.mjs';
import { WorkflowRuntime } from '../src/runtime.mjs';
import { FLOW_ENGINE } from '../src/flow.mjs';
import { until } from './helpers.mjs';

const executor = fileURLToPath(new URL('../../asys-runtime/tools/asys-runtime', import.meta.url));
const worker = fileURLToPath(new URL('./job-worker.py', import.meta.url));
const coordinator = fileURLToPath(new URL('./coordinator.py', import.meta.url));

const document = (steps, extra = {}, files = {}) => ({ root: 'main.yaml', files: {
  'main.yaml': { data: { asys: 'workflow/1', name: 'Test', start: Object.keys(steps)[0], steps, ...extra }, calls: extra.calls ?? {} },
  ...files } });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'asys-flow-'));
  await mkdir(join(root, 'workspace'));
  const environments = new Environments(join(root, 'runtime'));
  const state = join(root, 'workflow');
  const directory = join(root, 'env', 'test');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'workers.json'), JSON.stringify({ version: 1, name: 'test', types: {
    program: { command: ['python3', worker] }, coordinator: { command: ['python3', coordinator] } } }));
  const child = spawn('python3', [executor, 'run', directory, '--root', environments.root], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const exited = once(child, 'exit');
  const f = { root, state, queue: environments.queue('test'), runtime: new WorkflowRuntime({ store: new Store(state), environments }),
    async start(workflow, variables = {}, id = 'run') {
      const { workflowId } = await this.runtime.loadWorkflow({ workflow });
      await this.runtime.startRun({ environment: 'test', id, workflowId, variablesJson: JSON.stringify(variables) });
      return workflowId;
    },
    jobs(id = 'run') { return Object.values(this.runtime.record(id).jobs); },
    async restart() {
      await this.runtime.close();
      this.runtime = new WorkflowRuntime({ store: new Store(state), environments });
      await this.runtime.recover();
    } };
  t.after(async () => {
    await f.runtime.close();
    child.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 0, errors);
    await rm(root, { recursive: true, force: true });
  });
  await until(async () => (await environments.list()).some(environment => environment.name === 'test'));
  return f;
}

async function settled(f, id = 'run') {
  return until(() => {
    const run = f.runtime.getRun({ id }).run;
    return ['completed', 'failed', 'cancelled'].includes(run.status) && run;
  }, { timeout: 20000 });
}

async function finished(f, id = 'run') {
  const run = await settled(f, id);
  assert.equal(run.status, 'completed', run.error);
  return { ...run, output: JSON.parse(run.outputJson), variables: JSON.parse(run.variablesJson) };
}

test('steps run in sequence, a switch chooses, and the file output is the result', async t => {
  const f = await fixture(t);
  await f.start(document({
    review: { run: 'program', input: { approved: true, topic: '${topic}', note: 'About ${topic}: ${count([1, 2])}' }, next: 'decide' },
    decide: { switch: [{ when: 'review.approved = false', next: 'rejected' }], default: 'accept' },
    accept: { run: 'program', input: { accepted: '${review.approved}' }, next: 'done' },
    rejected: { end: 'Rejected' },
    done: { end: 'Accepted' },
  }, { output: '${{topic: review.topic, accepted: accept.accepted}}' }), { topic: 'routes' });
  const run = await finished(f);
  assert.deepEqual(run.output, { topic: 'routes', accepted: true });
  assert.equal(run.variables.review.note, 'About routes: 2');
  assert.equal(f.runtime.record('run').engine, FLOW_ENGINE);
  assert.deepEqual(f.jobs().map(job => job.activityId), ['review', 'accept']);
});

test('a malformed expression is rejected when the workflow loads', async t => {
  const f = await fixture(t);
  await assert.rejects(f.runtime.loadWorkflow({ workflow: document({
    first: { run: 'program', input: { n: '${count(}' }, next: 'done' }, done: { end: 'Done' } }) }),
  /main\.yaml: steps\.first\.input: invalid FEEL/);
  await assert.rejects(f.runtime.loadWorkflow({ workflow: document({
    first: { repeat: { step: { run: 'program' }, until: 'step.n >' }, next: 'done' }, done: { end: 'Done' } }) }),
  /steps\.first\.repeat\.until/);
});

test('parallel branches join, and a group returns its steps results', async t => {
  const f = await fixture(t);
  await f.start(document({
    work: { parallel: ['search', 'implement'], join: 'evidence' },
    search: { group: { start: 'global', steps: {
      global: { run: 'program', input: { route: 'A' }, next: 'local' },
      local: { run: 'program', input: { route: '${global.route}B' } } } } },
    implement: { run: 'program', input: { code: 'route.py' } },
    evidence: { run: 'program', input: { route: '${search.local.route}', code: '${implement.code}' }, next: 'done' },
    done: { end: 'Done' },
  }));
  const run = await finished(f);
  assert.deepEqual(run.output, { route: 'AB', code: 'route.py' });
  assert.deepEqual(run.variables.search, { global: { route: 'A' }, local: { route: 'AB' } });
  assert.deepEqual(f.jobs().map(job => job.activityId).sort(), ['evidence', 'implement', 'search/global', 'search/local']);
});

test('for_each runs items in order or together, and until stops the rest', async t => {
  const f = await fixture(t);
  const hold = join(f.root, 'never');
  await f.start(document({
    each: { run: 'program', for_each: '${parts}', as: 'part', input: { part: '${part}', index: '${index}' }, next: 'ordered' },
    ordered: { run: 'program', for_each: '${parts}', sequential: true, input: { ok: '${item != "b"}' },
      until: '${count(ordered[ok = false]) > 0}', next: 'first' },
    first: { run: 'program', for_each: '${[1, 2, 3]}', input: { n: '${item}', wait: '${if item = 1 then null else hold}' },
      until: '${count(first) >= 1}', next: 'grouped' },
    grouped: { group: { start: 'square', steps: { square: { run: 'program', input: { n: '${item * item}' } } } }, for_each: '${[2, 3]}', next: 'done' },
    done: { end: 'Done' },
  }), { parts: ['a', 'b', 'c'], hold });
  const run = await finished(f);
  assert.deepEqual(run.variables.each, [{ part: 'a', index: 1 }, { part: 'b', index: 2 }, { part: 'c', index: 3 }]);
  assert.deepEqual(run.variables.ordered, [{ ok: true }, { ok: false }]);
  assert.deepEqual(run.variables.first, [{ n: 1, wait: null }]);
  assert.deepEqual(run.variables.grouped, [{ square: { n: 4 } }, { square: { n: 9 } }]);
  const stopped = f.jobs().filter(job => job.activityId === 'first' && job.input.n > 1);
  assert.equal(stopped.length, 2);
  for (const job of stopped) assert.equal((await f.queue.wait(job.id, { timeoutMs: 3000 })).status, 'cancelled');
});

test('a call runs another file with its inputs and returns its output', async t => {
  const f = await fixture(t);
  await f.start(document({
    review: { call: 'review.yaml', input: { request: 'Review ${topic}.' }, next: 'after' },
    after: { run: 'program', input: { verdict: '${review}' }, next: 'done' },
    done: { end: 'Done' },
  }, { calls: { 'review.yaml': 'review.yaml' } }, {
    'review.yaml': { calls: {}, data: { asys: 'workflow/1', start: 'check', output: '${check.request}', steps: {
      check: { run: 'program', input: { request: '${request}', secret: '${if topic = null then "hidden" else "leaked"}' }, next: 'end' },
      end: { end: 'Reviewed' } } } },
  }), { topic: 'routes' });
  const run = await finished(f);
  assert.equal(run.variables.after.verdict, 'Review routes.');
  // A called file sees its inputs, not the caller's variables.
  assert.equal(f.jobs().find(job => job.activityId === 'check').input.secret, 'hidden');
});

test('repeat runs its step until the condition holds, or max times', async t => {
  const f = await fixture(t);
  await f.start(document({
    polish: { repeat: { step: { run: 'program', input: { version: '${if polish = null then 1 else polish.version + 1}' } },
      until: '${step.version >= 3}' }, next: 'bounded' },
    bounded: { repeat: { step: { run: 'program', input: { n: 1 } }, max: 2 }, next: 'done' },
    done: { end: 'Done' },
  }));
  const run = await finished(f);
  assert.equal(f.jobs().filter(job => job.activityId === 'polish/step').length, 3);
  assert.deepEqual(run.variables.polish, { version: 3 });
  assert.equal(f.jobs().filter(job => job.activityId === 'bounded/step').length, 2);
});

test('a revision loop runs a step again as new work and sees the latest results', async t => {
  const f = await fixture(t);
  await f.start(document({
    draft: { run: 'program', input: { version: '${if draft = null then 1 else draft.version + 1}' }, next: 'check' },
    check: { switch: [{ when: 'draft.version < 2', next: 'draft' }], default: 'done' },
    done: { end: 'Done' },
  }));
  const run = await finished(f);
  assert.deepEqual(run.variables.draft, { version: 2 });
  assert.equal(new Set(f.jobs().map(job => job.id)).size, 2);
});

test('steps sharing a result name update one ledger, as BPMN result variables do', async t => {
  const f = await fixture(t);
  // Two steps write ledger; the loop reads whichever wrote last.
  const workflowId = (await f.runtime.loadWorkflow({ workflowJson: JSON.stringify(document({
    open: { run: 'program', result: 'ledger', input: { count: 1 }, next: 'bump' },
    bump: { run: 'program', result: 'ledger', input: { count: '${ledger.count + 1}' }, next: 'enough' },
    enough: { switch: [{ when: 'ledger.count < 3', next: 'bump' }], default: 'done' },
    done: { end: 'Counted' },
  })) })).workflowId;
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId, variablesJson: '{}' });
  const run = await finished(f);
  assert.deepEqual(run.variables.ledger, { count: 3 });
  assert.deepEqual(run.variables.open, { count: 1 });
  assert.equal(f.jobs().filter(job => job.activityId === 'bump').length, 2);
});

test('on_error continues with the failure, and on_timeout cancels the work', async t => {
  const f = await fixture(t);
  await f.start(document({
    risky: { run: 'program', input: { fail: true }, on_error: 'report' },
    report: { run: 'program', input: { saw: '${risky.exception}' }, next: 'slow' },
    slow: { run: 'program', input: { wait: '${hold}' }, timeout: 'PT0.3S', on_timeout: 'done', next: 'done' },
    done: { end: 'Done' },
  }), { hold: join(f.root, 'never') });
  const run = await finished(f);
  assert.match(run.variables.report.saw, /17|failed/);
  assert.match(run.variables.slow.exception, /timed out/);
  const slow = f.jobs().find(job => job.activityId === 'slow');
  assert.equal((await f.queue.wait(slow.id, { timeoutMs: 3000 })).status, 'cancelled');
});

test('a failure fails the run, and resume reruns only the failed job', async t => {
  const f = await fixture(t);
  await f.start(document({
    first: { run: 'program', input: { step: 'first' }, next: 'flaky' },
    flaky: { run: 'program', input: { failOnce: true }, next: 'done' },
    done: { end: 'Done' },
  }));
  const failed = await settled(f);
  assert.equal(failed.status, 'failed');
  const [first] = f.jobs().filter(job => job.activityId === 'first');
  await f.runtime.resumeRun({ id: 'run' });
  await finished(f);
  assert.deepEqual(f.jobs().filter(job => job.activityId === 'first').map(job => job.id), [first.id]);
  assert.ok(f.jobs().find(job => job.activityId === 'flaky').metadata.retry_of);
});

test('a wait takes a message sent before or after it starts, across a restart', async t => {
  const f = await fixture(t);
  await f.start(document({
    early: { wait: 'go', next: 'approval' },
    approval: { wait: 'approved', next: 'done' },
    done: { end: 'Done' },
  }));
  await f.runtime.sendMessage({ runId: 'run', target: 'approved', id: 'm2', payloadJson: '{"by":"me"}' });
  await f.runtime.sendMessage({ runId: 'run', target: 'go', id: 'm1', payloadJson: '{"n":1}' });
  const run = await finished(f);
  assert.deepEqual([run.variables.early, run.variables.approval], [{ n: 1 }, { by: 'me' }]);

  await f.start(document({ approval: { wait: 'approved', next: 'done' }, done: { end: 'Done' } }), {}, 'later');
  await until(() => f.runtime.getRun({ id: 'later' }).run.status === 'waiting');
  await f.restart();
  await assert.rejects(f.runtime.sendMessage({ runId: 'later', target: 'unknown', id: 'x', payloadJson: '{}' }), /wait step/);
  await f.runtime.sendMessage({ runId: 'later', target: 'approved', id: 'm', payloadJson: '{"ok":true}' });
  assert.deepEqual((await finished(f, 'later')).variables.approval, { ok: true });
});

test('a delay survives a restart and compensate undoes completed steps latest first', async t => {
  const f = await fixture(t);
  await f.start(document({
    reserve: { run: 'program', input: { step: 'reserve' }, undo: 'release', next: 'charge' },
    charge: { run: 'program', input: { step: 'charge' }, undo: 'refund', next: 'pause' },
    pause: { delay: 'PT0.5S', next: 'rollback' },
    rollback: { compensate: 'all', next: 'done' },
    release: { run: 'program', input: { undone: 'reserve' } },
    refund: { run: 'program', input: { undone: 'charge' } },
    done: { end: 'Rolled back' },
  }));
  await until(() => f.runtime.getRun({ id: 'run' }).run.status === 'waiting');
  await f.restart();
  const run = await finished(f);
  assert.deepEqual(f.jobs().map(job => job.activityId), ['reserve', 'charge', 'refund', 'release']);
  assert.deepEqual(run.variables.refund, { undone: 'charge' });
});

test('a coordinator chooses actions, which read its request as message', async t => {
  const f = await fixture(t);
  await f.start(document({
    build: { choose: { coordinator: 'coordinator', actions: ['module', 'unused'],
      input: { select: [{ action: 'module', input: { name: 'a' } }, { action: 'module', input: { name: 'b' } }] } }, next: 'done' },
    module: { run: 'program', input: { built: '${message.name}' }, description: 'Build one module.' },
    unused: { run: 'program', input: {} },
    done: { end: 'Done' },
  }));
  const run = await finished(f);
  assert.deepEqual(run.variables.build.module, [{ built: 'a' }, { built: 'b' }]);
  assert.deepEqual(run.variables.build.unused, []);
  assert.deepEqual(run.variables.build.report, [{ built: 'a' }, { built: 'b' }]);
  const job = f.jobs().find(job => job.activityId === 'build');
  assert.deepEqual(job.metadata.actions.entries[0], { id: 'module', name: 'module', description: 'Build one module.', inputPaths: ['message.name'] });
});

test('recovery resumes nested frames without running finished or submitted jobs again', async t => {
  const f = await fixture(t);
  const release = join(f.root, 'release');
  await f.start(document({
    work: { parallel: ['left', 'right'], join: 'after' },
    left: { group: { start: 'one', steps: { one: { run: 'program', input: { n: 1 }, next: 'two' },
      two: { run: 'program', input: { wait: release } } } } },
    right: { run: 'program', input: { side: 'right' } },
    after: { run: 'program', input: { both: '${[left.two.wait, right.side]}' }, next: 'done' },
    done: { end: 'Done' },
  }));
  await until(() => f.jobs().some(job => job.activityId === 'left/two' && job.status === 'submitted')
    && f.jobs().some(job => job.activityId === 'right' && job.status === 'completed'));
  const before = f.jobs().map(job => job.id);
  await f.restart();
  await writeFile(release, 'go');
  const run = await finished(f);
  assert.deepEqual(run.variables.after.both, [release, 'right']);
  assert.equal(f.jobs().length, 4);
  assert.ok(before.every(id => f.jobs().some(job => job.id === id)));
});
