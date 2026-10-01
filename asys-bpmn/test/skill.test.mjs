import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Environments } from '../../asys-runtime/javascript/environments.mjs';
import { parseWorkflow, validateExecutable } from '../src/bpmn.mjs';
import { Store } from '../src/store.mjs';
import { WorkflowRuntime } from '../src/runtime.mjs';
import { until } from './helpers.mjs';

const project = fileURLToPath(new URL('../..', import.meta.url));
const assets = join(project, 'skills/asys-authoring/assets');

test('the bundled goal template is executable and leaves the goal attempt limit unset', async () => {
  const definition = validateExecutable(await parseWorkflow(await readFile(join(assets, 'goal.bpmn'), 'utf8')));
  assert.deepEqual(definition.bindings.deliver, { type: 'goal', input: '= {request: request}', args: '= []', result: 'deliver' });
  assert.equal(definition.document.diagrams.length, 1);
});

// The team starter, run with its deterministic environment's real programs.
// LOAD returns the loaded workflow's ID.
async function teamRun(t, load) {
  const root = await mkdtemp(join(tmpdir(), 'asys-skill-team-'));
  const environment = join(root, 'environment');
  const workspace = join(root, 'workspace');
  const environments = new Environments(join(root, 'runtime'));
  const runtime = new WorkflowRuntime({ store: new Store(join(root, 'workflow')), environments, workspace });
  let child;
  let exited;
  let stderr = '';
  t.after(async () => {
    await runtime.close();
    if (child) {
      child.kill('SIGTERM');
      const [code] = await exited;
      assert.equal(code, 0, stderr);
    }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(workspace);
  await cp(join(assets, 'team/env/dummy'), environment, { recursive: true });
  const config = JSON.parse(await readFile(join(environment, 'workers.json'), 'utf8'));
  // Map only container installation paths; run the shipped workflow and programs unchanged.
  for (const spec of Object.values(config.types)) {
    spec.command = spec.command.map(arg => arg.replace('/opt/asys/environment/', `${environment}/`)
      .replace('/opt/asys/asys-workers/', `${project}/asys-workers/`));
  }
  await writeFile(join(environment, 'workers.json'), JSON.stringify(config));
  child = spawn('python3', [join(project, 'asys-runtime/tools/asys-runtime'), 'run', environment,
    '--root', environments.root], { stdio: ['ignore', 'pipe', 'pipe'] });
  exited = once(child, 'exit');
  child.stdout.resume();
  child.stderr.on('data', chunk => { stderr += chunk; });
  await until(async () => (await environments.list()).some(item => item.name === config.name));
  const workflowId = await load(runtime);
  await runtime.startRun({ id: 'skill-team', workflowId, environment: config.name,
    variablesJson: JSON.stringify({ request: await readFile(join(assets, 'team/request.md'), 'utf8') }) });
  const run = await until(() => {
    const value = runtime.getRun({ id: 'skill-team' }).run;
    return ['completed', 'failed'].includes(value.status) && value;
  });
  assert.equal(run.status, 'completed', run.error);
  const report = await readFile(join(workspace, 'deliverables/report.md'), 'utf8');
  assert.match(report, /## Evidence/);

  const queue = environments.queue(config.name);
  const states = await Promise.all((await readdir(queue.jobs)).filter(id => !id.startsWith('.')).map(id => queue.state(id)));
  assert.equal(states.length, 6);
  assert.ok(states.every(state => state.status === 'done'));
  const reviews = states.filter(state => state.type === 'reviewer');
  assert.deepEqual(reviews.map(state => state.result.approved).sort(), [false, true]);
  const implementations = states.filter(state => state.type === 'implementer');
  const inputs = await Promise.all(implementations.map(async state => JSON.parse(await readFile(
    join((await queue.paths(state.id)).directory, 'input.json'), 'utf8'))));
  assert.equal(inputs.length, 2);
  assert.ok(inputs.some(input => input.request.includes('First pass; no earlier review.')));
  assert.ok(inputs.some(input => input.request.includes('Add the missing Evidence section.')));
  return { run, report };
}

test('the skill team starter runs real programs through a rejected review, revision, and acceptance', async t => {
  const { run, report } = await teamRun(t, async runtime => (await runtime.loadWorkflow({
    bpmnXml: await readFile(join(assets, 'team/workflow.bpmn'), 'utf8') })).workflowId);
  const output = JSON.parse(run.outputJson);
  assert.equal(output.review.approved, true);
  assert.equal(output.check.bytes, Buffer.byteLength(report));
});

test('the YAML team starter runs the same loop with the check program its environment declares', async t => {
  // The host resolves workflow files; this is what asys-run sends.
  const resolved = execFileSync('python3', ['-c', `import json, sys
sys.path[:0] = ${JSON.stringify([join(project, '.host-deps'), join(project, 'python'), join(project, 'asys-runtime')])}
from asys import flow
print(json.dumps(flow.resolved(flow.load_all(sys.argv[1]))))`, join(assets, 'team/workflow.yaml')], { encoding: 'utf8' });
  const { run, report } = await teamRun(t, async runtime => (await runtime.loadWorkflow({ workflow: JSON.parse(resolved) })).workflowId);
  const variables = JSON.parse(run.variablesJson);
  assert.equal(variables.review.approved, true);
  assert.equal(variables.check.bytes, Buffer.byteLength(report));
});
