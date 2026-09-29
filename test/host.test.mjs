import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../tools/asys', import.meta.url));
const launcher = fileURLToPath(new URL('../tools/asys-run', import.meta.url));
const json = (path, value) => writeFile(path, JSON.stringify(value));

test('dashboard observes nested worlds, replays durable frames, and scopes controls', async () => {
  await exec('python3', [fileURLToPath(new URL('./dashboard.py', import.meta.url))]);
});

test('named workers share the ordinary queue, workspace, and host status', async () => {
  await exec('python3', [fileURLToPath(new URL('./run.py', import.meta.url))]);
});

test('host launchers provision isolated world components before workers and preserve saved views', async () => {
  await exec('python3', [fileURLToPath(new URL('./world_host.py', import.meta.url))]);
});

test('environment and worker authoring preserve validated configuration', async () => {
  await exec('python3', [fileURLToPath(new URL('./authoring.py', import.meta.url))]);
});

test('asys routes commands and preserves interspersed options', async () => {
  await exec('python3', [fileURLToPath(new URL('./cli.py', import.meta.url))]);
});

test('asys sets and lists model defaults in the selected state', async () => {
  await exec('python3', [fileURLToPath(new URL('./system_models.py', import.meta.url))]);
});

test('asys initializes private and shared state and a sourceable environment', async () => {
  await exec('python3', [fileURLToPath(new URL('./init.py', import.meta.url))]);
});

test('host lifecycle owns process groups, component cleanup, and diagnostics', async () => {
  await exec('python3', [fileURLToPath(new URL('./lifecycle.py', import.meta.url))]);
});

test('host health recovery is bounded and preserves running jobs and unrelated components', async () => {
  await exec('python3', [fileURLToPath(new URL('./health_recovery.py', import.meta.url))]);
});

test('workflow upgrades preserve outcomes and safely continue interrupted maintenance', async () => {
  await exec('python3', [fileURLToPath(new URL('./upgrade.py', import.meta.url))]);
});

test('update selects running shared services without changing workflow runs', async () => {
  await exec('python3', [fileURLToPath(new URL('./update.py', import.meta.url))]);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'asys-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = join(root, 'runs', 'script-run');
  const job = join(run, 'runtime/environments/shell/jobs/command-1');
  await mkdir(job, { recursive: true });
  await json(join(run, 'run.json'), { id: 'script-run', name: 'Build reports',
    environment: 'shell', status: 'completed', components: { controller: 'report-controller', workers: 'report-workers' },
    created_at: '2026-09-14T10:00:00Z', finished_at: '2026-09-14T10:01:00Z' });
  await json(join(job, 'request.json'), { id: 'command-1', type: 'program', directory: 'jobs/command-1', workspace: 'jobs/command-1/workspace', metadata: { name: 'compile' } });
  await json(join(job, 'state.json'), { id: 'command-1', type: 'program', directory: 'jobs/command-1', workspace: 'jobs/command-1/workspace', status: 'done', exit_code: 0 });
  await writeFile(join(job, 'stdout.log'), 'Report compiled.\n');
  await writeFile(join(run, 'run.log'), 'Starting report generation\nReport ready\n');
  return { root, run, job };
}

test('asys observes a non-BPMN producer using only saved run and job records', async t => {
  const { root, run } = await fixture(t);
  const before = await readFile(join(run, 'run.json'), 'utf8');
  const status = JSON.parse((await exec('python3', [cli, 'status', run, '--json'])).stdout);
  assert.equal(status.name, 'Build reports');
  assert.equal(status.jobs[0].name, 'compile');
  assert.equal(status.jobs[0].status, 'done');
  assert.equal(status.stages, undefined);
  assert.match((await exec('python3', [cli, '--root', root, 'ps'])).stdout, /Build reports/);
  assert.match((await exec('python3', [cli, 'logs', run, 'compile'])).stdout, /Report compiled/);
  assert.equal((await exec('python3', [cli, 'logs', run])).stdout, 'Starting report generation\nReport ready\n');
  assert.equal(await readFile(join(run, 'run.json'), 'utf8'), before);
});

test('asys ignores workflow definitions and stage semantics when reading status', async t => {
  const { run, job } = await fixture(t);
  const record = JSON.parse(await readFile(join(run, 'run.json')));
  const definition = join(run, 'workflow.bpmn');
  await writeFile(definition, '<definitions name="MUST NOT READ THIS"/>');
  await json(join(run, 'run.json'), { ...record, name: undefined, workflow: definition });
  await json(join(job, 'request.json'), { id: 'command-1', type: 'program', directory: 'jobs/command-1', workspace: 'jobs/command-1/workspace',
    metadata: { name: 'compile', bpmn: 'opaque producer metadata' } });
  await writeFile(join(run, 'events.jsonl'), '{"type":"activity.start","sequence":"not-an-event-number"}\n');
  const status = JSON.parse((await exec('python3', [cli, 'status', run, '--json'])).stdout);
  assert.equal(status.name, 'script-run');
  assert.equal(status.jobs[0].name, 'compile');
  assert.equal(status.stages, undefined);
});

test('asys ignores a previous terminal result when a run has been resumed', async t => {
  const { run } = await fixture(t);
  const record = JSON.parse(await readFile(join(run, 'run.json')));
  const out = join(run, 'runtime/channels/controller/out');
  await mkdir(out, { recursive: true });
  await json(join(out, '000000001.json'), { sequence: 1, type: 'run.result', data: { runId: record.id, status: 'failed', error: 'Old failure' } });
  await json(join(run, 'run.json'), { ...record, status: 'running', finished_at: undefined,
    channel: 'runtime/channels/controller', channel_after: 1 });
  const status = () => exec('python3', [cli, 'status', run, '--json']).then(result => JSON.parse(result.stdout));
  assert.equal((await status()).status, 'running');
  await json(join(out, '000000002.json'), { sequence: 2, type: 'run.result', data: { runId: record.id, status: 'completed' } });
  assert.equal((await status()).status, 'completed');
});

test('asys-run executes workflows and keeps readable output as ordinary run logs', async t => {
  const { run } = await fixture(t);
  const help = (await exec('python3', [launcher, '--help'])).stdout;
  assert.match(help, /run/);
  assert.match(help, /resume/);
  assert.doesNotMatch(help, /^\s+(?:top|logs|status)\s/m);
  for (const command of ['top', 'logs', 'status']) {
    await assert.rejects(exec('python3', [launcher, command]), error => error.code===2 && /ENVIRONMENT and WORKER/.test(error.stderr));
  }
  await exec('python3', ['-c', `
import runpy, sys
from pathlib import Path
module = runpy.run_path(sys.argv[1])
from asys.run import arguments
from asys.workflow import Launcher
launcher = Launcher(arguments(['env', 'workflow.bpmn']))
launcher.directory = Path(sys.argv[2])
launcher.say('FINISHED  Generate reports')
`, launcher, run]);
  assert.match((await exec('python3', [cli, 'logs', run])).stdout, /FINISHED  Generate reports/);
});
