import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../tools/asys', import.meta.url));
const python = fileURLToPath(new URL('./monitor.py', import.meta.url));
const runId = 'abcdef0123456789abcdef0123456789';
const jobId = 'wf-0123456789abcdef';
const json = (path, value) => writeFile(path, JSON.stringify(value));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-observe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = join(root, 'runs', runId);
  const job = join(run, 'runtime/environments/kicad/jobs', jobId);
  const execution = join(run, 'jobs', jobId), workspace = join(run, 'workspaces', jobId);
  await mkdir(job, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(execution, { recursive: true });
  await json(join(run, 'run.json'), { id: runId, name: 'pcb-engineer', channel: 'runtime/channels/control',
    environment: 'kicad', status: 'failed', error: 'Program exited with status 1', components_removed: true,
    created_at: '2026-09-14T10:00:00Z', finished_at: '2026-09-14T10:01:00Z' });
  await json(join(job, 'request.json'), { id: jobId, type: 'agent', directory: '../../../jobs/' + jobId, workspace: '../../../workspaces/' + jobId,
    metadata: { name: 'design_module' } });
  await json(join(job, 'state.json'), { id: jobId, type: 'agent', status: 'failed',
    started_at: '2026-09-14T10:00:30Z', finished_at: '2026-09-14T10:01:00Z', error: 'Program exited with status 1', exit_code: 1 });
  await writeFile(join(execution, 'stderr.log'), 'Agent prompt must be a nonempty string\n');
  await writeFile(join(execution, 'stdout.log'), 'initial output\n');
  await writeFile(join(run, 'run.log'), 'FINISHED  Prepare inputs\nFAILED  design_module — Agent prompt must be a nonempty string\n');
  return { root, run, job, execution, workspace };
}

test('status reads archived jobs and their actual error without Docker or a workflow definition', async t => {
  const { root } = await fixture(t);
  const { stdout } = await exec('python3', [cli, '--root', root, 'status', runId.slice(0, 8), '--json'],
    { env: { ...process.env, DCOMP_BINARY: '/not-installed/dcomp' } });
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'failed');
  assert.equal(result.name, 'pcb-engineer');
  assert.equal(result.jobs[0].name, 'design_module');
  assert.match(result.jobs[0].detail, /Agent prompt must be a nonempty string/);
  assert.match(result.error, /Agent prompt must be a nonempty string/);
  const table = await exec('python3', [cli, 'ps', '--root', root]);
  assert.match(table.stdout, /pcb-engineer/);
  assert.match(table.stdout, /failed/);
});

test('logs selects a job by name from an existing run directory and shows stderr', async t => {
  const { run } = await fixture(t);
  const { stdout } = await exec('python3', [cli, 'logs', run, '--stream', 'stderr', 'design_module']);
  assert.match(stdout, /design_module/);
  assert.match(stdout, /Agent prompt must be a nonempty string/);
  assert.doesNotMatch(stdout, /initial output/);
});

test('status resolves caller-selected job and workspace directories', async t => {
  const { run, execution, workspace } = await fixture(t);
  const { stdout } = await exec('python3', [cli, 'status', run, '--json']);
  const saved = JSON.parse(stdout).jobs[0];
  assert.equal(saved.directory, execution);
  assert.equal(saved.workspace, workspace);
  assert.equal(saved.input_directory, undefined);
});

test('run prefixes must be unambiguous and nonexistent state stays nonexistent', async t => {
  const { root, run } = await fixture(t);
  const other = join(root, 'runs', 'abcd9999999999999999999999999999');
  await mkdir(other);
  const record = JSON.parse(await readFile(join(run, 'run.json')));
  await json(join(other, 'run.json'), { ...record, id: 'abcd9999999999999999999999999999' });
  await assert.rejects(exec('python3', [cli, 'status', 'abcd', '--root', root]), error => /ambiguous/i.test(error.stderr));
  const absent = join(root, 'absent');
  const { stdout } = await exec('python3', [cli, 'ps', '--root', absent, '--json']);
  assert.deepEqual(JSON.parse(stdout), []);
  await exec('python3', [cli, 'status', '--root', absent, '--json'], { env: { ...process.env, DCOMP_BINARY: '/not-installed/dcomp' } });
  await assert.rejects(readFile(absent), { code: 'ENOENT' });
});

test('following logs discovers new jobs created after the command starts', { timeout: 10000 }, async t => {
  const { root, run, job, execution } = await fixture(t);
  const record = JSON.parse(await readFile(join(run, 'run.json')));
  await json(join(run, 'run.json'), { ...record, status: 'running', error: '', finished_at: undefined });
  const child = spawn('python3', [cli, 'logs', '--root', root, runId, '--source', 'jobs', '-f', '--lines', '1']);
  t.after(() => child.kill('SIGTERM'));
  const closed = once(child, 'close');
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  async function until(text) {
    const deadline = Date.now() + 3000;
    while (!stdout.includes(text)) {
      assert.equal(child.exitCode, null, stderr);
      if (Date.now() > deadline) throw new Error(`Missing ${text}: ${stdout} ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  await until('initial output');
  await appendFile(join(execution, 'stdout.log'), 'a split');
  await appendFile(join(execution, 'stdout.log'), ' line\n');
  await until('a split line');
  for (const [id, name, type, text] of [['wf-retry', 'design_module', 'agent', 'retry output'], ['wf-another', 'check', 'program', 'check output']]) {
    const entry = join(run, 'runtime/environments/kicad/jobs', id);
    const execution = join(run, 'jobs', id);
    await mkdir(entry, { recursive: true });
    await mkdir(execution, { recursive: true });
    await json(join(entry, 'request.json'), { id, type, directory: '../../../jobs/' + id,
      workspace: '../../../workspaces/' + jobId, metadata: { name } });
    await writeFile(join(execution, 'stdout.log'), text + '\n');
    await json(join(entry, 'state.json'), { id, type, status: 'done' });
    await until(text);
  }
  child.kill('SIGINT');
  assert.equal((await closed)[0], 0, stderr);
  assert.equal(stdout.match(/a split line/g)?.length, 1);
});

test('terminal monitor shows saved job errors and restores the terminal on quit', { timeout: 10000 }, async t => {
  const { root, run, execution } = await fixture(t);
  await writeFile(join(execution, 'stdout.log'), '{"type":"agent.tool_started","name":"bash"}\n');
  await exec('python3', [python, cli, root]);
});

test('terminal output renders and follows the agent transcript with scrollback', { timeout: 15000 }, async t => {
  const { root, run, job, execution } = await fixture(t);
  await writeFile(join(execution, 'stdout.log'), '{"type":"agent.tool_started","name":"bash"}\n');
  const checkpoint = join(execution, 'agent.json');
  const message = (id, parentId, role, content, extra = {}) => ({ type: 'message', id, parentId, message: { role, content, ...extra } });
  await json(checkpoint, { agent: { session: { leafId: 'final', entries: [
    message('prompt', null, 'user', 'TRANSCRIPT PROMPT'),
    message('inspect', 'prompt', 'assistant', [
      { type: 'text', text: 'I will inspect the board.' },
      { type: 'toolCall', name: 'bash', arguments: { command: 'printf BOARD_CHECK' } },
    ]),
    message('result', 'inspect', 'toolResult', [{ type: 'text', text: 'BOARD CHECK SUCCEEDED' }], { toolName: 'bash' }),
    { type: 'compaction', id: 'compact', parentId: 'result', summary: 'The board has been checked.' },
    message('final', 'compact', 'assistant', [{ type: 'text', text: JSON.stringify({
      final: Array.from({ length: 70 }, (_, i) => `Transcript line ${i + 1}`).join('\n') + '\nLAST SAVED ANSWER',
      exception: null, goal_status: 'review',
    }) }]),
    message('discarded', 'result', 'assistant', [{ type: 'text', text: 'UNSELECTED BRANCH' }]),
  ] } } });
  const before = await readFile(checkpoint, 'utf8');
  await exec('python3', [python, cli, root, checkpoint]);
  // The only write is the fixture's simulated worker checkpoint update.
  const after = JSON.parse(await readFile(checkpoint, 'utf8'));
  assert.equal(after.agent.session.entries.length, JSON.parse(before).agent.session.entries.length + 1);
});

test('live transcript follows streamed text and thinking before checkpoint completion', async () => {
  await exec('python3', [fileURLToPath(new URL('./transcript.py', import.meta.url))]);
});

test('old completed runs have fixed elapsed times and observation leaves channels untouched', async t => {
  const { root, run } = await fixture(t);
  const record = JSON.parse(await readFile(join(run, 'run.json')));
  delete record.created_at;
  delete record.finished_at;
  await json(join(run, 'run.json'), record);
  await writeFile(join(run, 'events.jsonl'), [
    { type: 'run.created', time: '2026-09-14T10:00:00Z' },
    { type: 'run.failed', time: '2026-09-14T10:01:00Z' },
  ].map(JSON.stringify).join('\n') + '\n');
  const channel = join(run, 'runtime/channels/control/out');
  await mkdir(channel, { recursive: true });
  await json(join(channel, 'cursor.json'), { version: 1, after: 12 });
  const before = await readFile(join(channel, 'cursor.json'), 'utf8');
  const { stdout } = await exec('python3', [cli, 'status', '--root', root, 'latest', '--json']);
  assert.equal(JSON.parse(stdout).elapsed, '1m 0s');
  assert.equal(await readFile(join(channel, 'cursor.json'), 'utf8'), before);
});

test('an exited launcher is distinguished from a workflow that has published completion', async t => {
  const { root, run } = await fixture(t);
  const record = JSON.parse(await readFile(join(run, 'run.json')));
  await json(join(run, 'run.json'), { ...record, status: 'running', error: '' });
  await writeFile(join(run, 'launcher.lock'), '');
  const read = async () => JSON.parse((await exec('python3', [cli, 'status', '--root', root, 'latest', '--json'])).stdout);
  assert.equal((await read()).status, 'detached');
  const channel = join(run, 'runtime/channels/control/out');
  await mkdir(channel, { recursive: true });
  await json(join(channel, '000000001.json'), { type: 'run.result', time: '2026-09-14T10:01:00Z',
    data: { runId, status: 'completed' } });
  assert.equal((await read()).status, 'completed');
  assert.equal(JSON.parse(await readFile(join(run, 'run.json'))).status, 'running');
});

test('agent exhaustion and retry status are visible without workflow stages', async t => {
  const { run, job, execution } = await fixture(t);
  const record = JSON.parse(await readFile(join(run, 'run.json')));
  await json(join(run, 'run.json'), { ...record, status: 'running', error: '', finished_at: undefined });
  await json(join(job, 'state.json'), { id: jobId, type: 'agent', status: 'running' });
  await writeFile(join(execution, 'stdout.log'), [
    { type: 'agent.tool_started', name: 'bash' },
    { type: 'agent.provider_exhausted', time: '2026-09-14T10:01:40Z', retryAt: '2026-09-14T11:00:00Z', delayMs: 3500000 },
  ].map(JSON.stringify).join('\n') + '\n');
  const read = async () => JSON.parse((await exec('python3', [cli, 'status', run, '--json'])).stdout);
  const exhausted = await read();
  assert.equal(exhausted.jobs[0].agent.status, 'exhausted');
  assert.equal(exhausted.jobs[0].status, 'running');
  assert.match(exhausted.jobs[0].detail, /provider exhausted.*11:00:00Z/);
  assert.equal(exhausted.stages, undefined);
  await appendFile(join(execution, 'stdout.log'), JSON.stringify({ type: 'agent.provider_retrying', time: '2026-09-14T11:00:00Z' }) + '\n');
  assert.equal((await read()).jobs[0].agent.status, 'retrying');
});
