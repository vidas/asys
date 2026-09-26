import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { Provider } from '../../asys-inference/components/protocol/provider/gen/cyclo/provider/v1/provider_pb.js';
import { Environments } from '../../asys-runtime/javascript/environments.mjs';
import { AsyncStore as Store } from '../src/async-store.mjs';
import { WorkflowRuntime } from '../src/runtime.mjs';
import { ENGINE } from '../src/engine.mjs';
import { Actions } from '../../asys-workers/src/actions.mjs';
import { assistant, model } from '../../asys-workers/test/helpers.mjs';
import { workflow, flow, until } from './helpers.mjs';

const executor = fileURLToPath(new URL('../../asys-runtime/tools/asys-runtime', import.meta.url));
const worker = fileURLToPath(new URL('./job-worker.py', import.meta.url));
const coordinator = fileURLToPath(new URL('./coordinator.py', import.meta.url));
const binding = (type = 'program', attrs = '') => `<bpmn:extensionElements><asys:job type="${type}" ${attrs}/></bpmn:extensionElements>`;
const programTask = (id, extra = '') => `<bpmn:task id="${id}">${binding('program', `input="= {step: &quot;${id}&quot;${extra}}"`)}</bpmn:task>`;

test('bundled report team uses common requests and completes a checked revision', async t => {
  const f = await fixture(t);
  const dummy = fileURLToPath(new URL('../../skills/asys-authoring/assets/team/env/dummy/programs/dummy.py', import.meta.url));
  const program = fileURLToPath(new URL('../../asys-workers/tools/asys-program', import.meta.url));
  const queue = await f.addEnvironment('report-team', {
    implementer: { command: ['python3', dummy, 'implementer'] },
    reviewer: { command: ['python3', dummy, 'reviewer'] },
    program: { command: ['python3', program] },
  });
  const xml = await readFile(new URL('../../skills/asys-authoring/assets/team/workflow.bpmn', import.meta.url), 'utf8');
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: xml });
  await f.runtime.startRun({ environment: 'report-team', id: 'run', workflowId,
    variablesJson: JSON.stringify({ request: 'Write a report with evidence.', review: null }) });
  await finished(f, 'run');
  const jobs = Object.values(f.runtime.record('run').jobs);
  assert.equal(jobs.length, 6, 'implementation, artifact check, and review run twice');
  const reviews = [];
  for (const job of jobs) {
    if (job.type === 'program') continue;
    const assignment = (await queue.request(job.id)).input;
    assert.deepEqual(Object.keys(assignment), ['request']);
    assert.equal(typeof assignment.request, 'string');
    if (job.type === 'reviewer') reviews.push((await queue.state(job.id)).result.approved);
  }
  assert.deepEqual(reviews, [false, true]);
  assert.match(await readFile(join(f.root, 'workspace/deliverables/report.md'), 'utf8'), /## Evidence/);
});

test('BPMN runs a named swarm as one job and branches on its independently measured result', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const workers = fileURLToPath(new URL('../../asys-workers/', import.meta.url));
  const definition = JSON.parse(await readFile(join(workers, 'worlds/samples/route/env/workers/route-global.json'), 'utf8'));
  const worldRoot = join(f.environments.root, 'worlds/routes');
  await mkdir(worldRoot, { recursive: true });
  const bindings = join(f.root, 'world-bindings.json');
  await writeFile(bindings, JSON.stringify({ version: 1,
    packages: { [definition.config.world.package]: { runtime: 'worlds/routes' } } }));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  await f.addWorld(['-c', `from worlds.common import serve\nserve('leaderboard', ['python3', ${JSON.stringify(join(workers, 'worlds/samples/route/evaluate.py'))}])`], {
    PYTHONPATH: [join(root, 'python'), join(root, 'asys-runtime'), workers].join(':'),
    ASYS_WORLD_ROOT: worldRoot, ASYS_WORLD_HEALTH_FILE: join(f.root, 'world-health'),
  });
  await until(async () => readFile(join(worldRoot, 'ready.json')).then(() => true, () => false));
  const directory = join(f.root, 'env/routes');
  await mkdir(join(directory, 'workers'), { recursive: true });
  const path = join(directory, 'workers/route-global.json');
  await writeFile(path, JSON.stringify(definition));
  const queue = await f.addEnvironment('routes', {
    'route-global': { command: ['python3', join(workers, 'tools/asys-worker'), '--definition', path] },
    'route-member': { command: ['python3', join(workers, 'worlds/samples/route/participant.py')] },
  }, { ASYS_WORLD_BINDINGS: bindings });
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: await readFile(new URL('./fixtures/named-swarm.bpmn', import.meta.url), 'utf8') });
  const request = 'Find the shortest valid delivery loop.';
  await f.runtime.startRun({ environment: 'routes', id: 'run', workflowId,
    variablesJson: JSON.stringify({ request }) });
  const run = await finished(f, 'run', { timeout: 25000 });
  const result = JSON.parse(run.outputJson).searchResult;
  assert.equal(result.exception, null);
  assert.equal(result.output.mission, request);
  assert.equal(result.output.achieved, true);
  assert.equal(result.output.metrics.baselineScore, 44);
  assert.equal(result.output.metrics.bestScore, 16);
  assert.equal(result.output.usage.totalTokens, 0);
  const jobs = Object.values(f.runtime.record('run').jobs);
  assert.equal(jobs.length, 1, 'member attempts are internal to one runtime job');
  const job = jobs[0], directoryPath = join(f.root, 'jobs', job.id);
  assert.equal(job.type, 'route-global');
  assert.deepEqual((await queue.request(job.id)).input, { request });
  const queueState = await queue.state(job.id);
  assert.equal(queueState.status, 'done');
  assert.deepEqual(queueState.result, result);
  assert.deepEqual(await readdir(join(f.environments.directory('routes'), 'jobs')), [job.id]);
  const metadata = JSON.parse(await readFile(join(directoryPath, 'worker.json'), 'utf8'));
  assert.equal(metadata.control_channel, `swarm-${job.id}`);
  assert.equal(metadata.world_channel, `world-${job.id}`);
  const cache = JSON.parse(await readFile(join(worldRoot, 'channels', metadata.world_channel, '.world-response.json'), 'utf8'));
  assert.equal(cache.correlation.runId, job.id);
  assert.ok(!(await readdir(join(directoryPath, 'swarm'))).includes('world'));
});

for (const verified of [true, false]) {
  test(`BPMN runs the goal worker as one ordinary job with verified=${verified}`, async t => {
    const f = await fixture(t);
    const models = join(f.root, 'models.json');
    await writeFile(models, JSON.stringify({ simple: model.id }));
    const phases = [];
    const server = createServer(connectNodeAdapter({ routes(router) { router.service(Provider, {
      listModels() { return { models: [model] }; },
      async *infer(request) {
        assert.equal(request.model, model.id);
        const { context } = JSON.parse(request.payload);
        assert.equal(context.messages.length, 1);
        const { phase } = JSON.parse(context.messages[0].content[0].text.split('Assignment data:\n')[1]);
        phases.push(phase);
        const result = {
          implement: { final: 'Implementation finished.', exception: null, goal_status: 'review' },
          verify: { final: verified ? 'Artifact exists.' : 'Artifact missing.', exception: null, coverage: 'complete',
            criteria: [{ id: 'C1', requirement: 'Produce an artifact', basis: 'User request',
              status: verified ? 'satisfied' : 'unmet',
              evidence: [{ source: 'artifact.txt', observation: verified ? 'Inspected the file.' : 'File does not exist.' }] }] },
        }[phase];
        yield { payload: JSON.stringify({ type: 'done', reason: 'stop', message: assistant([{ type: 'text', text: JSON.stringify(result) }]) }) };
      },
    }); } }));
    const socket = join(f.root, 'goal-provider.sock');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const goal = fileURLToPath(new URL('../../asys-workers/tools/asys-goal', import.meta.url));
    const queue = await f.addEnvironment('goals', { goal: { command: [process.execPath, goal] } },
      { DCOMP_IN_INFERENCE: `unix://${socket}`, ASYS_SYSTEM_MODELS: models });
    const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: workflow(
      `<bpmn:task id="deliver">${binding('goal', 'input="= {goal: &quot;Produce an artifact&quot;, maxAttempts: 1}"')}</bpmn:task>`) });
    await f.runtime.startRun({ environment: 'goals', id: 'run', workflowId });
    await until(() => ['completed', 'failed'].includes(f.runtime.record('run').status));
    assert.equal(f.runtime.record('run').status, verified ? 'completed' : 'failed');
    const jobs = Object.values(f.runtime.record('run').jobs);
    assert.equal(jobs.length, 1);
    const state = await queue.state(jobs[0].id);
    assert.equal(state.result.verified, verified);
    assert.equal(state.result.criteria[0].status, verified ? 'satisfied' : 'unmet');
    assert.deepEqual(phases, ['implement', 'verify']);
  });
}

for (const approved of [true, false]) {
  test(`a Senate structured result selects the BPMN gateway branch with approved=${approved}`, async t => {
    const report = { final: 'Committee review complete.', exception: null, approved,
      reason: approved ? 'The numerical method is correct.' : 'The uncertainty calculation is incorrect.',
      evidence: { checks: [{ name: 'weighted fit', passed: approved }], source: 'fit.py' } };
    const f = await senateFixture(t, data => data.phase === 'assess' ? { ...report, consensus: true } : null);
    const source = workflow(`<bpmn:serviceTask id="committee">${binding('senate', 'result="review" input="= {topic: &quot;Review the weighted fit.&quot;, senate: senate}"')}</bpmn:serviceTask>
      <bpmn:exclusiveGateway id="choose" default="no"/>
      <bpmn:task id="accept">${binding('program', 'input="= {approved: review.approved, reason: review.reason, evidence: review.evidence}"')}</bpmn:task>
      <bpmn:task id="reject">${binding('program', 'input="= {approved: review.approved, reason: review.reason, evidence: review.evidence}"')}</bpmn:task>
      ${flow('choose_next', 'committee', 'choose')}${flow('yes', 'choose', 'accept', 'review.approved = true')}${flow('no', 'choose', 'reject')}`);
    const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: source });
    await f.runtime.startRun({ environment: 'senates', id: 'run', workflowId, variablesJson: JSON.stringify({ senate: f.senate }) });
    const run = await finished(f);
    const variables = JSON.parse(run.variablesJson);
    const selected = approved ? 'accept' : 'reject';
    assert.deepEqual(variables.review, { ...report, consensus: true, rounds: 1, decision: 'consensus' });
    assert.deepEqual(variables[selected], { approved, reason: report.reason, evidence: report.evidence });
    assert.equal(variables[approved ? 'reject' : 'accept'], undefined);
    const jobs = Object.values(f.runtime.record('run').jobs);
    assert.deepEqual(jobs.map(job => job.activityId).sort(), ['committee', selected].sort());
    const committee = jobs.find(job => job.activityId === 'committee');
    const state = await f.senateQueue.state(committee.id);
    assert.equal(state.status, 'done');
    assert.equal(state.exit_code, 0, 'a rejected review is a successful deliberation');
    assert.deepEqual(state.result, variables.review);
    assert.deepEqual(f.senatePhases, ['introduce:Princeps', 'intervene:Engineer', 'intervene:Scientist', 'assess:Princeps']);
  });
}

test('a Senate participant exception reaches the BPMN boundary with its structured diagnostic', async t => {
  const report = { final: 'The uncertainty calculation cannot be checked.', exception: 'Measurement uncertainties are missing',
    diagnostic: { file: 'observations.csv', missing: ['sigma'] } };
  const f = await senateFixture(t, data => data.phase === 'intervene' ? report : null);
  const source = workflow(`<bpmn:serviceTask id="committee">${binding('senate', 'result="review" input="= {topic: &quot;Review the weighted fit.&quot;, senate: senate}"')}</bpmn:serviceTask>
    <bpmn:task id="after">${binding('program')}</bpmn:task>${flow('next', 'committee', 'after')}
    <bpmn:boundaryEvent id="caught" attachedToRef="committee"><bpmn:errorEventDefinition errorRef="SenateFailure"/></bpmn:boundaryEvent>
    <bpmn:task id="recover">${binding('program', 'input="= {reason: review.exception, diagnostic: review.diagnostic}"')}</bpmn:task>
    ${flow('handled', 'caught', 'recover')}`)
    .replace('<bpmn:process', '<bpmn:error id="SenateFailure" errorCode="1"/><bpmn:process');
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: source });
  await f.runtime.startRun({ environment: 'senates', id: 'run', workflowId, variablesJson: JSON.stringify({ senate: f.senate }) });
  const run = await finished(f);
  assert.deepEqual(JSON.parse(run.outputJson).recover, { reason: report.exception, diagnostic: report.diagnostic });
  const jobs = Object.values(f.runtime.record('run').jobs);
  assert.deepEqual(jobs.map(job => job.activityId).sort(), ['committee', 'recover']);
  const committee = jobs.find(job => job.activityId === 'committee');
  assert.equal(committee.error.message, report.exception);
  const state = await f.senateQueue.state(committee.id);
  assert.equal(state.status, 'failed');
  assert.equal(state.exit_code, 1);
  assert.deepEqual(state.result, { ...report, consensus: false, rounds: 1, decision: null });
  assert.deepEqual(f.senatePhases, ['introduce:Princeps', 'intervene:Engineer']);
});

for (const hasCheckpoint of [true, false]) {
  test(hasCheckpoint ? 'resuming a failed workflow preserves completed work and retries only the failed job'
    : 'resume rejects a missing failure checkpoint without replaying or changing saved work', async t => {
    const f = await fixture(t);
    const source = workflow(`${programTask('before')}${programTask('broken', ', failOnce: true')}${programTask('after')}
      ${flow('one', 'before', 'broken')}${flow('two', 'broken', 'after')}`);
    const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: source });
    await f.runtime.startRun({ environment: 'test', id: 'run', workflowId, variablesJson: '{"request":"Keep this request"}' });
    await until(() => f.runtime.record('run').status === 'failed' && !f.runtime.active.has('run'));
    const original = f.runtime.record('run');
    assert.ok(original.recovery?.definition);
    if (!hasCheckpoint) { delete original.recovery; await f.runtime.store.save(original); }
    const before = Object.values(original.jobs).find(job => job.activityId === 'before');
    const broken = Object.values(original.jobs).find(job => job.activityId === 'broken');
    await f.restart();
    if (!hasCheckpoint) {
      const events = f.runtime.getEvents({ runId: 'run', limit: 1000 });
      await assert.rejects(f.runtime.resumeRun({ id: 'run' }), /no saved failure checkpoint/);
      assert.deepEqual(f.runtime.record('run'), original);
      assert.deepEqual(f.runtime.getEvents({ runId: 'run', limit: 1000 }), events);
      assert.equal((await f.queue.state(before.id)).status, 'done');
      assert.equal((await f.queue.state(broken.id)).status, 'failed');
      assert.equal((await readdir(f.queue.jobs)).length, 2);
      return;
    }
    await f.runtime.resumeRun({ id: 'run' });
    const run = await finished(f);
    assert.deepEqual(Object.keys(JSON.parse(run.outputJson)), ['before', 'broken', 'after']);
    const queue = f.environments.queue('test');
    assert.equal((await queue.state(before.id)).status, 'done');
    assert.equal((await queue.state(broken.id)).status, 'failed');
    const replacement = Object.values(f.runtime.record('run').jobs).find(job => job.activityId === 'broken');
    assert.notEqual(replacement.id, broken.id);
    assert.equal((await queue.state(replacement.id)).status, 'done');
    assert.equal(replacement.metadata.retry_of, broken.id);
    assert.equal(Object.values(f.runtime.record('run').jobs).find(job => job.activityId === 'before').id, before.id);
    assert.equal(await readFile(join((await queue.paths(broken.id)).workspace, 'executions'), 'utf8'), '1\n2\n3\n4\n');
    const creation = f.runtime.getEvents({ runId: 'run', limit: 1000 }).events.find(event => event.type === 'job.created' && JSON.parse(event.dataJson).jobId === replacement.id);
    assert.equal(JSON.parse(creation.dataJson).retryOf, broken.id);
    assert.equal(JSON.parse(run.variablesJson).request, 'Keep this request');
    assert.equal(f.runtime.getEvents({ runId: 'run', limit: 1000 }).events.filter(event => event.type === 'run.recovered').length, 1);
    await assert.rejects(f.runtime.resumeRun({ id: 'run' }), /completed/);
  });
}

test('resume retries an interrupted stage when the engine never recorded its failure', async t => {
  const f = await fixture(t);
  const release = join(f.root, 'release');
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: workflow(`${programTask('before')}
    ${programTask('interrupted', `, wait: &quot;${release}&quot;`)}${programTask('after')}
    ${flow('one', 'before', 'interrupted')}${flow('two', 'interrupted', 'after')}`) });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId });
  const job = await until(async () => {
    const job = Object.values(f.runtime.record('run').jobs).find(job => job.activityId === 'interrupted');
    return job?.status === 'submitted' && (await f.queue.state(job.id)).status === 'running' && job;
  });
  const before = Object.values(f.runtime.record('run').jobs).find(job => job.activityId === 'before');
  await f.runtime.close();
  f.runtime = new WorkflowRuntime({ store: new Store(f.state), environments: f.environments });
  assert.equal(f.runtime.record('run').recovery, undefined);
  await f.queue.cancel(job.id);
  await f.queue.wait(job.id);
  await writeFile(release, 'ready');
  await f.runtime.resumeRun({ id: 'run' });
  await finished(f);
  const jobs = Object.fromEntries(Object.values(f.runtime.record('run').jobs).map(job => [job.activityId, job]));
  assert.equal(jobs.before.id, before.id);
  assert.notEqual(jobs.interrupted.id, job.id);
  assert.equal(jobs.interrupted.metadata.retry_of, job.id);
  assert.equal((await f.queue.state(job.id)).status, 'cancelled');
});

test('the new adapter rejects old-engine resume and recovery before changing saved jobs', async t => {
  const f = await fixture(t);
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: workflow(programTask('fails', ', fail: true')) });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId });
  await until(() => f.runtime.record('run').status === 'failed' && !f.runtime.active.has('run'));
  assert.equal(f.runtime.record('run').engine, ENGINE);
  assert.equal(ENGINE, 'bpmn-elements@17.3.0+asys.2');
  await f.runtime.close();
  f.runtime = new WorkflowRuntime({ store: new Store(f.state), environments: f.environments });
  const record = f.runtime.record('run');
  record.engine = 'bpmn-elements@17.3.0';
  await f.runtime.store.save(record);
  const jobs = await readdir(f.queue.jobs);
  const events = f.runtime.getEvents({ runId: 'run', limit: 1000 });
  await assert.rejects(f.runtime.resumeRun({ id: 'run' }), /requires workflow engine bpmn-elements@17\.3\.0/);
  assert.deepEqual(f.runtime.record('run'), record);
  record.status = 'running';
  await f.runtime.store.save(record);
  await assert.rejects(f.runtime.recover(), /requires workflow engine bpmn-elements@17\.3\.0/);
  assert.deepEqual(f.runtime.record('run'), record);
  assert.deepEqual(await readdir(f.queue.jobs), jobs);
  assert.deepEqual(f.runtime.getEvents({ runId: 'run', limit: 1000 }), events);
});

test('resume reruns the failed agent stage without rerunning its completed predecessor', async t => {
  const f = await fixture(t);
  const requests = [];
  const server = createServer(connectNodeAdapter({ routes(router) { router.service(Provider, {
    listModels() { return { models: [model] }; },
    async *infer(request) {
      const { context } = JSON.parse(request.payload);
      requests.push(context);
      const message = assistant([{ type: 'text', text: JSON.stringify(requests.length === 1
        ? { final: 'Stage failed.', exception: 'Stage failed' }
        : { final: 'Stage completed.', exception: null }) }]);
      yield { payload: JSON.stringify({ type: 'done', reason: message.stopReason, message }) };
    },
  }); } }));
  const socket = join(f.root, 'provider.sock');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const agent = fileURLToPath(new URL('../../asys-workers/tools/asys-agent', import.meta.url));
  const queue = await f.addEnvironment('agents', {
    agent: { command: [process.execPath, agent, '--agent', 'test', '--model', 'fixture/model', '--extension', fileURLToPath(new URL('../../asys-workers/extensions/bpmn.mjs', import.meta.url))] },
    program: { command: ['python3', worker] },
  }, { DCOMP_IN_INFERENCE: `unix://${socket}` });
  const source = workflow(`${programTask('before')}
    <bpmn:task id="design">${binding('agent', 'input="= {prompt: &quot;Design the board.&quot;, maxSteps: 2}"')}</bpmn:task>
    ${programTask('after')}${flow('one', 'before', 'design')}${flow('two', 'design', 'after')}`);
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: source });
  await f.runtime.startRun({ environment: 'agents', id: 'run', workflowId });
  await until(() => f.runtime.record('run').status === 'failed' && !f.runtime.active.has('run'));
  const jobs = Object.fromEntries(Object.values(f.runtime.record('run').jobs).map(job => [job.activityId, job]));
  assert.equal(jobs.after, undefined);
  const failedInput = await readFile(join((await queue.paths(jobs.design.id)).directory, 'input.json'), 'utf8');
  await f.restart();
  await f.runtime.resumeRun({ id: 'run' });
  await finished(f);
  assert.equal((await queue.state(jobs.before.id)).status, 'done');
  assert.equal((await queue.state(jobs.design.id)).status, 'failed');
  const replacement = Object.values(f.runtime.record('run').jobs).find(job => job.activityId === 'design');
  assert.notEqual(replacement.id, jobs.design.id);
  assert.equal(await readFile(join((await queue.paths(replacement.id)).directory, 'input.json'), 'utf8'), failedInput);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.length, 1);
  assert.match(requests[1].messages[0].content[0].text, /^Design the board\./);
  assert.equal(Object.values(f.runtime.record('run').jobs).find(job => job.activityId === 'after').status, 'completed');
});

test('resume restores parallel execution, retaining a completed branch and retrying a cancelled sibling', async t => {
  const f = await fixture(t);
  const release = join(f.root, 'release');
  const source = workflow(`<bpmn:parallelGateway id="fork"/>
    ${programTask('done')}${programTask('broken', `, failOnce: true, wait: &quot;${release}&quot;`)}
    ${programTask('waiting', `, wait: &quot;${release}-sibling&quot;`)}
    <bpmn:parallelGateway id="join"/>${programTask('after')}
    ${['done', 'broken', 'waiting'].map(id => flow(`start_${id}`, 'fork', id) + flow(`end_${id}`, id, 'join')).join('')}
    ${flow('finish', 'join', 'after')}`);
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: source });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId });
  await until(() => Object.values(f.runtime.record('run').jobs).some(j => j.activityId === 'done' && j.status === 'completed'));
  await writeFile(release, 'fail now');
  await until(() => f.runtime.record('run').status === 'failed' && !f.runtime.active.has('run'));
  const jobs = Object.fromEntries(Object.values(f.runtime.record('run').jobs).map(j => [j.activityId, j]));
  await f.restart();
  await Promise.all([f.runtime.resumeRun({ id: 'run' }), f.runtime.resumeRun({ id: 'run' })]);
  await writeFile(`${release}-sibling`, 'continue');
  await finished(f);
  const current = Object.fromEntries(Object.values(f.runtime.record('run').jobs).map(job => [job.activityId, job]));
  assert.equal(current.done.id, jobs.done.id);
  for (const name of ['broken', 'waiting']) {
    assert.notEqual(current[name].id, jobs[name].id);
    assert.equal(current[name].metadata.retry_of, jobs[name].id);
    assert.equal((await f.queue.state(current[name].id)).status, 'done');
  }
});

test('resume rejects an environment missing required types without dispatching new jobs', async t => {
  const f = await fixture(t);
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: workflow(programTask('broken', ', failOnce: true')) });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId });
  await until(() => f.runtime.record('run').status === 'failed' && !f.runtime.active.has('run'));
  const saved = f.runtime.record('run');
  const descriptor = await f.environments.get('test');
  t.mock.method(f.environments, 'get', async () => ({ ...descriptor, types: ['other'] }));
  await assert.rejects(f.runtime.resumeRun({ id: 'run' }), /does not define job types: program/);
  assert.deepEqual(f.runtime.record('run'), saved);
  assert.equal((await readdir(f.queue.jobs)).length, 1);
});

test('a crash after recording replacement IDs reuses them on recovery', async t => {
  const f = await fixture(t);
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: workflow(programTask('broken', ', failOnce: true')) });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId });
  await until(() => f.runtime.record('run').status === 'failed' && !f.runtime.active.has('run'));
  const failed = Object.values(f.runtime.record('run').jobs)[0];
  t.mock.method(f.runtime, 'continueRun', async () => { throw new Error('Engine stopped before dispatch'); });
  await assert.rejects(f.runtime.resumeRun({ id: 'run' }), /before dispatch/);
  const recorded = Object.values(f.runtime.store.run('run').jobs)[0];
  assert.notEqual(recorded.id, failed.id);
  await f.restart();
  await finished(f);
  assert.equal(Object.values(f.runtime.record('run').jobs)[0].id, recorded.id);
  assert.equal((await readdir(f.queue.jobs)).length, 2);
  assert.equal((await f.queue.state(failed.id)).status, 'failed');
  assert.equal((await f.queue.state(recorded.id)).status, 'done');
});

test('successive jobs edit the same project without input or output scaffolding', async t => {
  const f = await fixture(t);
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: workflow(`${programTask('first')}${programTask('second')}${flow('next', 'first', 'second')}`) });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId });
  await finished(f);
  const jobs = Object.values(f.runtime.record('run').jobs);
  const paths = await Promise.all(jobs.map(job => f.queue.paths(job.id)));
  assert.equal(paths[0].workspace, paths[1].workspace);
  assert.notEqual(paths[0].directory, paths[1].directory);
  assert.equal(await readFile(join(paths[0].workspace, 'first.txt'), 'utf8'), 'first');
  assert.equal(await readFile(join(paths[1].workspace, 'second.txt'), 'utf8'), 'second');
  assert.deepEqual((await readdir(paths[0].workspace)).sort(), ['executions', 'first.txt', 'second.txt']);
});

test('the same workflow runs in two selected environments and retains each binding after recovery', async t => {
  const f = await fixture(t);
  const command = ['python3', '-c', 'import json,os; json.dump({"environment":os.environ["ASYS_ENVIRONMENT"]},open(os.environ["ASYS_RESULT"],"w"))'];
  const alpha = await f.addEnvironment('alpha', { program: { command } });
  const beta = await f.addEnvironment('beta', { program: { command } });
  const source = workflow(`<bpmn:task id="first">${binding()}</bpmn:task><bpmn:receiveTask id="pause"/>
    <bpmn:task id="last">${binding()}</bpmn:task>${flow('one', 'first', 'pause')}${flow('two', 'pause', 'last')}`);
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: source });
  await Promise.all(['alpha', 'beta'].map(environment => f.runtime.startRun({ id: environment, workflowId, environment })));
  await until(() => ['alpha', 'beta'].every(id => f.runtime.active.get(id)?.waiters.size === 1));
  await f.restart();
  for (const environment of ['alpha', 'beta']) {
    const target = [...f.runtime.active.get(environment).waiters.keys()][0];
    await f.runtime.sendMessage({ runId: environment, target, id: 'continue' });
    const run = await finished(f, environment);
    assert.equal(run.environment, environment);
    assert.equal(JSON.parse(run.outputJson).first.environment, environment);
    assert.equal(JSON.parse(run.outputJson).last.environment, environment);
  }
  for (const [name, queue] of [['alpha', alpha], ['beta', beta]]) {
    const jobs = await readdir(queue.jobs);
    assert.equal(jobs.length, 2);
    for (const id of jobs) assert.equal((await queue.request(id)).metadata.environment, name);
  }
  assert.deepEqual(await readdir(f.queue.jobs), []);
  await assert.rejects(f.runtime.startRun({ id: 'alpha', workflowId, environment: 'beta' }), /different input/);
  assert.equal((await f.runtime.startRun({ id: 'alpha', workflowId, environment: 'alpha' })).run.status, 'completed');
});

test('compatibility includes called subprocesses and rejects missing types before creating a run', async t => {
  const f = await fixture(t);
  const source = workflow('<bpmn:callActivity id="call" calledElement="sub"/>').replace('</bpmn:definitions>', `
    <bpmn:process id="sub"><bpmn:adHocSubProcess id="group">${binding('coordinator')}
      <bpmn:task id="approval">${binding('human')}</bpmn:task></bpmn:adHocSubProcess></bpmn:process>
    <bpmn:process id="unrelated" isExecutable="true"><bpmn:task id="other">${binding('unrelated-type')}</bpmn:task></bpmn:process>
    </bpmn:definitions>`);
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: source });
  assert.deepEqual(await f.runtime.checkWorkflow({ workflowId, processId: 'test', environment: 'test' }), {
    compatible: false, requiredTypes: ['coordinator', 'human'], missingTypes: ['human'],
  });
  await assert.rejects(f.runtime.startRun({ id: 'rejected', workflowId, processId: 'test', environment: 'test' }), /does not define job types: human/);
  assert.deepEqual(f.runtime.listRuns().runs, []);
  assert.deepEqual(await readdir(f.queue.jobs), []);
  await assert.rejects(f.runtime.startRun({ id: 'missing-env', workflowId, processId: 'test', environment: 'absent' }), /not registered/);
  await assert.rejects(f.runtime.startRun({ id: 'no-env', workflowId, processId: 'test' }), /Environment name/);
});

test('compatibility only checks declarations, even when a declared program cannot execute', async t => {
  const f = await fixture(t);
  const queue = await f.addEnvironment('broken-tool', { program: { command: ['/no/such/asys-test-program'] } });
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: workflow(`<bpmn:task id="work">${binding()}</bpmn:task>`) });
  assert.deepEqual(await f.runtime.checkWorkflow({ workflowId, environment: 'broken-tool' }), {
    compatible: true, requiredTypes: ['program'], missingTypes: [],
  });
  assert.deepEqual(await readdir(queue.jobs), []);
  await f.runtime.startRun({ id: 'broken', workflowId, environment: 'broken-tool' });
  const run = await until(() => { const run = f.runtime.getRun({ id: 'broken' }).run; return run.status === 'failed' && run; });
  assert.match(run.error, /No such file/);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'asys-bpmn-integration-'));
  await mkdir(join(root, 'workspace'));
  const environments = new Environments(join(root, 'runtime'));
  const queue = environments.queue('test');
  const state = join(root, 'workflow');
  const children = [];
  const f = { root, queue, state, environments, runtime: new WorkflowRuntime({ store: new Store(state), environments }),
    async addWorld(args, env) {
      const child = spawn('python3', args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let errors = '';
      child.stderr.on('data', chunk => { errors += chunk; });
      children.push({ child, exited: once(child, 'exit'), errors: () => errors });
    },
    async addEnvironment(name, types, env = {}) {
      const directory = join(root, 'env', name);
      await mkdir(join(directory, 'agents/test'), { recursive: true });
      await writeFile(join(directory, 'workers.json'), JSON.stringify({ version: 1, name, types }));
      const child = spawn('python3', [executor, 'run', directory, '--root', environments.root], {
        env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let errors = '';
      child.stderr.on('data', chunk => { errors += chunk; });
      const exited = once(child, 'exit');
      children.push({ child, exited, errors: () => errors });
      await until(async () => (await environments.list()).some(environment => environment.name === name));
      return environments.queue(name);
    },
    async restart() {
      await this.runtime.close();
      this.runtime = new WorkflowRuntime({ store: new Store(state), environments });
      await this.runtime.recover();
    } };
  t.after(async () => {
    await f.runtime.close();
    for (const { child, exited, errors } of children) {
      child.kill('SIGTERM');
      const [code] = await exited;
      assert.equal(code, 0, errors());
    }
    await rm(root, { recursive: true, force: true });
  });
  await f.addEnvironment('test', {
    program: { command: ['python3', worker] }, coordinator: { command: ['python3', coordinator] },
  });
  return f;
}

async function senateFixture(t, response) {
  const f = await fixture(t);
  f.senate = { version: 1, princeps: { name: 'Princeps' }, senators: [{ name: 'Engineer' }, { name: 'Scientist' }] };
  f.senatePhases = [];
  const server = createServer(connectNodeAdapter({ routes(router) { router.service(Provider, {
    listModels() { return { models: [model] }; },
    async *infer(request) {
      assert.equal(request.model, model.id);
      const { context } = JSON.parse(request.payload);
      const users = context.messages.filter(message => message.role === 'user');
      const data = JSON.parse(users.at(-1).content[0].text.split('Assignment data:\n')[1]);
      assert.equal(users.length, data.phase === 'assess' ? 2 : 1, 'the Princeps assessment continues its introduction session');
      f.senatePhases.push(`${data.phase}:${data.participant}`);
      const result = response(data) ?? { final: `${data.participant}: ${data.phase}.`, exception: null };
      const message = assistant([{ type: 'text', text: JSON.stringify(result) }]);
      yield { payload: JSON.stringify({ type: 'done', reason: message.stopReason, message }) };
    },
  }); } }));
  const socket = join(f.root, 'senate-provider.sock');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const senate = fileURLToPath(new URL('../../asys-workers/tools/asys-senate', import.meta.url));
  f.senateQueue = await f.addEnvironment('senates', {
    senate: { command: [process.execPath, senate, '--model', model.id] },
    program: { command: ['python3', worker] },
  }, { DCOMP_IN_INFERENCE: `unix://${socket}` });
  return f;
}

async function finished(f, id = 'run', options) {
  const run = await until(() => {
    const run = f.runtime.getRun({ id }).run;
    return ['completed', 'failed', 'cancelled'].includes(run.status) && run;
  }, options);
  assert.equal(run.status, 'completed', run.error);
  return run;
}

test('a BPMN task issues a typed filesystem job and its result selects the gateway branch', async t => {
  const f = await fixture(t);
  const source = workflow(`<bpmn:startEvent id="start"/><bpmn:serviceTask id="review">${binding('program', 'input="= {approved: true, topic: topic}"')}</bpmn:serviceTask>
    <bpmn:exclusiveGateway id="choose" default="no"/><bpmn:scriptTask id="accept" scriptFormat="python">${binding('program', 'input="= {accepted: review.approved}"')}<bpmn:script>handled by its job type</bpmn:script></bpmn:scriptTask>
    <bpmn:userTask id="reject">${binding('program', 'input="= {rejected: true}"')}</bpmn:userTask><bpmn:endEvent id="end"/>
    ${flow('first', 'start', 'review')}${flow('choose_next', 'review', 'choose')}${flow('yes', 'choose', 'accept', 'review.approved = true')}${flow('no', 'choose', 'reject')}
    ${flow('accepted', 'accept', 'end')}${flow('rejected', 'reject', 'end')}`);
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: source });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId, variablesJson: '{"topic":"architecture"}' });
  const run = await finished(f);
  const vars = JSON.parse(run.variablesJson);
  assert.deepEqual(vars.review, { approved: true, topic: 'architecture' });
  assert.deepEqual(vars.accept, { accepted: true });
  assert.equal(vars.reject, undefined);
  assert.equal(vars.content, undefined);
  assert.equal(vars.fields, undefined);
  assert.deepEqual(Object.values(f.runtime.record('run').jobs).map(j => j.activityId).sort(), ['accept', 'review']);
});

test('workflow recovery reattaches an existing waiting job and consumes its result once', async t => {
  const f = await fixture(t);
  const release = join(f.root, 'decision');
  const source = workflow(`<bpmn:serviceTask id="first">${binding('program', 'input="= {first: true}"')}</bpmn:serviceTask>
    <bpmn:userTask id="approval">${binding('program', 'input="= {approved: true, wait: decisionFile}"')}</bpmn:userTask>
    <bpmn:task id="last">${binding('program', 'input="= {approved: approval.approved}"')}</bpmn:task>
    ${flow('one', 'first', 'approval')}${flow('two', 'approval', 'last')}`);
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: source });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId, variablesJson: JSON.stringify({ decisionFile: release }) });
  await until(() => Object.values(f.runtime.record('run').jobs).some(j => j.activityId === 'approval' && j.status === 'submitted'));
  const before = Object.values(f.runtime.record('run').jobs).map(j => j.id);
  await f.restart();
  await writeFile(release, 'approved');
  const run = await finished(f);
  assert.equal(JSON.parse(run.outputJson).last.approved, true);
  const jobs = Object.values(f.runtime.record('run').jobs);
  assert.equal(jobs.length, 3);
  assert.ok(before.every(id => jobs.some(j => j.id === id)));
  for (const job of jobs) {
    assert.equal(await readFile(join((await f.queue.paths(job.id)).directory, 'stdout.log'), 'utf8'), `executed ${job.id}\n`);
  }
});

test('called processes recover their waiting jobs before continuing the parent', async t => {
  const f = await fixture(t);
  const decision = join(f.root, 'decision');
  const source = workflow(`<bpmn:callActivity id="call" calledElement="child"/>
    <bpmn:task id="after">${binding('program', 'input="= {finished: true}"')}</bpmn:task>${flow('next', 'call', 'after')}`)
    .replace('</bpmn:definitions>', `<bpmn:process id="child" isExecutable="false">
      <bpmn:task id="childWork">${binding('program', 'input="= {wait: decisionFile, child: true}"')}</bpmn:task>
    </bpmn:process></bpmn:definitions>`);
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: source });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId, variablesJson: JSON.stringify({ decisionFile: decision }) });
  const child = await until(() => Object.values(f.runtime.record('run').jobs).find(job => job.activityId === 'childWork' && job.status === 'submitted'));
  assert.equal(Object.keys(f.runtime.record('run').jobs).length, 1);
  await f.restart();
  await writeFile(decision, 'ready');
  assert.deepEqual(JSON.parse((await finished(f)).outputJson).after, { finished: true });
  assert.equal(Object.keys(f.runtime.record('run').jobs).length, 2);
  assert.equal(await readFile(join((await f.queue.paths(child.id)).directory, 'stdout.log'), 'utf8'), `executed ${child.id}\n`);
});

test('BPMN messages survive restart, map receive results, and reject changed idempotency keys', async t => {
  const f = await fixture(t);
  const source = workflow(`<bpmn:dataObject id="decision"/>
    <bpmn:receiveTask id="receive" messageRef="Decision">
      <bpmn:ioSpecification><bpmn:dataOutput id="received" name="approved"/><bpmn:inputSet/><bpmn:outputSet/></bpmn:ioSpecification>
      <bpmn:dataOutputAssociation><bpmn:sourceRef>received</bpmn:sourceRef><bpmn:targetRef>decision</bpmn:targetRef></bpmn:dataOutputAssociation>
    </bpmn:receiveTask>
    <bpmn:task id="after">${binding('program', 'input="= {approved: decision}"')}</bpmn:task>${flow('next', 'receive', 'after')}`)
    .replace('<bpmn:process', '<bpmn:message id="Decision"/><bpmn:process');
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: source });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId });
  await until(() => f.runtime.active.get('run').waiters.size === 1);
  await f.restart();
  const message = { runId: 'run', id: 'decision-1', target: 'Decision', payloadJson: '{"approved":true}' };
  await f.runtime.sendMessage(message);
  assert.deepEqual(JSON.parse((await finished(f)).outputJson).after, { approved: true });
  await f.runtime.sendMessage(message);
  await assert.rejects(f.runtime.sendMessage({ ...message, payloadJson: '{"approved":false}' }), /different input/);
  assert.equal(Object.keys(f.runtime.record('run').jobs).length, 1);
  assert.equal(f.runtime.getEvents({ runId: 'run' }).events.filter(event => event.type === 'message.received').length, 1);
});

test('parallel BPMN branches run independent jobs and join before continuation', async t => {
  const f = await fixture(t);
  const source = workflow(`<bpmn:parallelGateway id="fork"/><bpmn:task id="left">${binding('program', 'input="= {side: &quot;left&quot;}"')}</bpmn:task>
    <bpmn:task id="right">${binding('program', 'input="= {side: &quot;right&quot;}"')}</bpmn:task><bpmn:parallelGateway id="join"/>
    <bpmn:task id="final">${binding('program', 'input="= {sides: [left.side, right.side]}"')}</bpmn:task>
    ${flow('a', 'fork', 'left')}${flow('b', 'fork', 'right')}${flow('c', 'left', 'join')}${flow('d', 'right', 'join')}${flow('e', 'join', 'final')}`);
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: source });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId });
  assert.deepEqual(JSON.parse((await finished(f)).outputJson).final.sides, ['left', 'right']);
});

test('boundary timer cancels its program job and follows the timeout path', async t => {
  const f = await fixture(t);
  const source = workflow(`<bpmn:task id="slow">${binding('program', 'input="= {wait: missingFile}"')}</bpmn:task>
    <bpmn:boundaryEvent id="deadline" attachedToRef="slow"><bpmn:timerEventDefinition><bpmn:timeDuration xsi:type="bpmn:tFormalExpression">PT0.3S</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>
    <bpmn:task id="timeout">${binding('program', 'input="= {timedOut: true}"')}</bpmn:task><bpmn:endEvent id="normal"/>
    ${flow('elapsed', 'deadline', 'timeout')}${flow('not_elapsed', 'slow', 'normal')}`);
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: source });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId, variablesJson: JSON.stringify({ missingFile: join(f.root, 'never') }) });
  assert.equal(JSON.parse((await finished(f)).outputJson).timeout.timedOut, true);
  const slow = Object.values(f.runtime.record('run').jobs).find(j => j.activityId === 'slow');
  assert.equal((await f.queue.wait(slow.id, { timeoutMs: 3000 })).status, 'cancelled');
});

test('run cancellation reaches a submitted filesystem job', async t => {
  const f = await fixture(t);
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: workflow(`<bpmn:task id="wait">${binding('program', 'input="= {wait: missingFile}"')}</bpmn:task>`) });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId, variablesJson: JSON.stringify({ missingFile: join(f.root, 'never') }) });
  const job = await until(() => Object.values(f.runtime.record('run').jobs).find(j => j.status === 'submitted'));
  assert.equal((await f.runtime.cancelRun({ id: 'run' })).run.status, 'cancelled');
  assert.equal((await f.queue.wait(job.id, { timeoutMs: 3000 })).status, 'cancelled');
});

test('concurrent StartRun calls are idempotent, and changed input is rejected', async t => {
  const f = await fixture(t);
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: workflow(`<bpmn:task id="task">${binding('program', 'input="= {name: task.id, configured: variables.inputs}"')}</bpmn:task>`) });
  await Promise.all(Array.from({ length: 5 }, () => f.runtime.startRun({ environment: 'test', id: 'run', workflowId, variablesJson: '{"inputs":{"value":42}}' })));
  const run = await finished(f);
  assert.deepEqual(JSON.parse(run.variablesJson).task, { name: 'task', configured: { value: 42 } });
  assert.deepEqual(JSON.parse(run.variablesJson).inputs, { value: 42 });
  await assert.rejects(f.runtime.startRun({ environment: 'test', id: 'run', workflowId, variablesJson: '{"changed":true}' }), /different input/);
  assert.equal(Object.keys(f.runtime.record('run').jobs).length, 1);
});

test('ad-hoc work starts only selected activities and can select the same activity repeatedly', async t => {
  const f = await fixture(t);
  const source = workflow(`<bpmn:adHocSubProcess id="work" ordering="Sequential">${binding('coordinator', 'input="= {select: [{action: &quot;chosen&quot;, input: {n: 1}}, {action: &quot;chosen&quot;, input: {n: 2}}]}"')}
    <bpmn:task id="chosen">${binding('program', 'input="= message"')}</bpmn:task>
    <bpmn:task id="unused">${binding('program')}</bpmn:task>
    </bpmn:adHocSubProcess><bpmn:task id="after">${binding('program', 'input="= {finished: true}"')}</bpmn:task>${flow('next', 'work', 'after')}`);
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: source });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId });
  const run = await finished(f);
  const jobs = Object.values(f.runtime.record('run').jobs);
  assert.equal(jobs.filter(j => j.activityId === 'chosen').length, 2);
  assert.equal(jobs.filter(j => j.activityId === 'unused').length, 0);
  assert.deepEqual(JSON.parse(run.outputJson).work.result, [{ n: 1 }, { n: 2 }]);
  assert.equal(JSON.parse(run.outputJson).after.finished, true);
});

test('an invalid action input returns to its caller without starting or failing a BPMN activity', async t => {
  const f = await fixture(t);
  const hold = join(f.root, 'finish-coordinator');
  const source = workflow(`<bpmn:adHocSubProcess id="work" cancelRemainingInstances="false">${binding('coordinator', 'input="= {select: [], hold: hold}"')}
    <bpmn:task id="design_module">${binding('program', 'input="= {prompt: &quot;Design: &quot; + string(message.module)}"')}</bpmn:task>
    <bpmn:task id="optional">${binding('program', 'input="= {prompt: if message.module = null then &quot;Default&quot; else string(message.module)}"')}</bpmn:task>
    </bpmn:adHocSubProcess>`);
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: source });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId, variablesJson: JSON.stringify({ hold }) });
  const coordinatorJob = await until(() => Object.values(f.runtime.record('run').jobs).find(job => job.metadata?.actions && job.status === 'submitted'));
  const entries = coordinatorJob.metadata.actions.entries;
  assert.deepEqual(entries.find(entry => entry.id === 'design_module').inputPaths, ['message.module']);
  const actions = new Actions((await f.queue.paths(coordinatorJob.id)).directory, entries);
  await assert.rejects(actions.start('bad', 'design_module', { name: 'USB', pins: [] }), /design_module.*module/s);
  assert.ok(!['failed', 'cancelled'].includes(f.runtime.getRun({ id: 'run' }).run.status));
  assert.equal(Object.values(f.runtime.record('run').jobs).filter(job => job.activityId === 'design_module').length, 0);
  const accepted = await actions.start('good', 'design_module', { module: { name: 'USB', pins: [] } });
  const completed = await actions.wait(accepted.id);
  assert.match(completed.result.prompt, /Design: .*USB/);
  const optional = await actions.start('optional', 'optional', {});
  assert.deepEqual((await actions.wait(optional.id)).result, { prompt: 'Default' });
  await writeFile(hold, 'done');
  await finished(f);
  assert.equal(Object.values(f.runtime.record('run').jobs).filter(job => job.activityId === 'design_module').length, 1);
  assert.equal(f.runtime.getEvents({ runId: 'run', limit: 1000 }).events.filter(event => event.type === 'job.failed').length, 0);
});

test('ad-hoc sequence flows enable the next selection, which survives a workflow restart while waiting', async t => {
  const f = await fixture(t);
  const decision = join(f.root, 'decision');
  const source = workflow(`<bpmn:adHocSubProcess id="work" cancelRemainingInstances="false">${binding('coordinator', 'input="= {select: [{action: &quot;read&quot;}, {action: &quot;approval&quot;}]}"')}
    <bpmn:task id="read">${binding('program', 'input="= {document: &quot;ready&quot;}"')}</bpmn:task>
    <bpmn:userTask id="approval">${binding('program', 'input="= {approved: true, wait: decisionFile}"')}</bpmn:userTask>
    ${flow('review', 'read', 'approval')}
    </bpmn:adHocSubProcess>`);
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: source });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId, variablesJson: JSON.stringify({ decisionFile: decision }) });
  await until(() => Object.values(f.runtime.record('run').jobs).some(j => j.activityId === 'approval' && j.status === 'submitted'));
  const before = Object.keys(f.runtime.record('run').jobs).sort();
  await f.restart();
  await writeFile(decision, 'approved');
  const run = await finished(f);
  assert.equal(JSON.parse(run.outputJson).work.approval.approved, true);
  assert.deepEqual(Object.keys(f.runtime.record('run').jobs).sort(), before);
});

test('ad-hoc dependencies remain enabled but unselected across recovery, and false conditions stay disabled', async t => {
  const f = await fixture(t);
  const hold = join(f.root, 'finish-coordinator');
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: workflow(`<bpmn:adHocSubProcess id="work">${binding('coordinator', 'input="= {select: [], hold: hold}"')}
    ${programTask('first')}${programTask('enabled')}${programTask('disabled')}
    ${flow('yes', 'first', 'enabled', 'true')}${flow('no', 'first', 'disabled', 'false')}
    </bpmn:adHocSubProcess>`) });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId, variablesJson: JSON.stringify({ hold }) });
  const coordinatorJob = await until(() => Object.values(f.runtime.record('run').jobs).find(job => job.metadata?.actions && job.status === 'submitted'));
  const actions = new Actions((await f.queue.paths(coordinatorJob.id)).directory, coordinatorJob.metadata.actions.entries);
  const first = await actions.start('first', 'first', {});
  await actions.wait(first.id);
  await until(async () => (await actions.list()).entries.find(entry => entry.id === 'enabled').available);
  const before = f.runtime.record('run');
  const controller = Object.values(before.controllers)[0];
  assert.equal(controller.enabled.enabled.length, 1);
  assert.equal(controller.enabled.disabled, undefined);
  assert.equal(Object.values(before.jobs).filter(job => ['enabled', 'disabled'].includes(job.activityId)).length, 0);
  await f.restart();
  assert.deepEqual(Object.keys(f.runtime.record('run').jobs).sort(), Object.keys(before.jobs).sort());
  assert.equal(Object.values(f.runtime.record('run').controllers)[0].enabled.enabled.length, 1);
  await assert.rejects(actions.start('disabled', 'disabled', {}), /not enabled/);
  const enabled = await actions.start('enabled', 'enabled', {});
  await actions.wait(enabled.id);
  await writeFile(hold, 'done');
  await finished(f);
  const jobs = Object.values(f.runtime.record('run').jobs);
  assert.equal(jobs.filter(job => job.activityId === 'first').length, 1);
  assert.equal(jobs.filter(job => job.activityId === 'enabled').length, 1);
  assert.equal(jobs.filter(job => job.activityId === 'disabled').length, 0);
  const events = f.runtime.getEvents({ runId: 'run', limit: 1000 }).events;
  assert.equal(events.filter(event => event.type === 'activity.discard' && event.activityId === 'disabled').length, 0);
});

test('ad-hoc gateways and message events keep native tokens across recovery', async t => {
  const f = await fixture(t);
  const hold = join(f.root, 'finish-coordinator');
  const source = workflow(`<bpmn:adHocSubProcess id="work" cancelRemainingInstances="false">${binding('coordinator', 'input="= {select: [], hold: hold}"')}
    ${programTask('left')}${programTask('right')}<bpmn:parallelGateway id="join"/>
    <bpmn:exclusiveGateway id="choose" default="no"/>
    <bpmn:intermediateCatchEvent id="ready"><bpmn:messageEventDefinition messageRef="Ready"/></bpmn:intermediateCatchEvent>
    ${programTask('last')}${programTask('unused')}
    ${flow('leftDone', 'left', 'join')}${flow('rightDone', 'right', 'join')}${flow('joined', 'join', 'choose')}
    ${flow('yes', 'choose', 'ready', 'left.step = "left"')}${flow('no', 'choose', 'unused')}${flow('next', 'ready', 'last')}
    </bpmn:adHocSubProcess>`).replace('<bpmn:process', '<bpmn:message id="Ready"/><bpmn:process');
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: source });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId, variablesJson: JSON.stringify({ hold }) });
  const coordinatorJob = await until(() => Object.values(f.runtime.record('run').jobs).find(job => job.metadata?.actions && job.status === 'submitted'));
  assert.deepEqual(coordinatorJob.metadata.actions.entries.map(entry => entry.id), ['left', 'right', 'last', 'unused']);
  const actions = new Actions((await f.queue.paths(coordinatorJob.id)).directory, coordinatorJob.metadata.actions.entries);
  const waiting = () => [...f.runtime.active.get('run').waiters.values()].some(({ activity }) => activity.id === 'ready');
  const left = await actions.start('left', 'left', {}, { signal: AbortSignal.timeout(10000) });
  await actions.wait(left.id, { signal: AbortSignal.timeout(10000) });
  assert.equal(waiting(), false, 'The join must wait for both selections');
  await f.restart();
  const right = await actions.start('right', 'right', {}, { signal: AbortSignal.timeout(10000) });
  await actions.wait(right.id, { signal: AbortSignal.timeout(10000) });
  await until(waiting);
  assert.equal((await actions.list()).entries.find(entry => entry.id === 'last').available, false);
  await f.restart();
  await until(waiting);
  await f.runtime.sendMessage({ runId: 'run', target: 'Ready', id: 'ready' });
  await until(async () => (await actions.list()).entries.find(entry => entry.id === 'last').available);
  assert.equal(Object.values(f.runtime.record('run').jobs).some(job => job.activityId === 'last'), false);
  assert.equal((await actions.list()).entries.find(entry => entry.id === 'unused').available, false);
  const last = await actions.start('last', 'last', {}, { signal: AbortSignal.timeout(10000) });
  await actions.wait(last.id, { signal: AbortSignal.timeout(10000) });
  await writeFile(hold, 'done');
  await finished(f);
  assert.deepEqual(Object.values(f.runtime.record('run').jobs).filter(job => job.type === 'program').map(job => job.activityId).sort(), ['last', 'left', 'right']);
});

test('ad-hoc compensation waits for its trigger and survives recovery', async t => {
  const f = await fixture(t);
  const hold = join(f.root, 'finish-coordinator');
  const source = workflow(`<bpmn:adHocSubProcess id="work" cancelRemainingInstances="false">${binding('coordinator', 'input="= {select: [], hold: hold}"')}
    ${programTask('first')}
    <bpmn:boundaryEvent id="compensate" attachedToRef="first" cancelActivity="false"><bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
    <bpmn:task id="undo" isForCompensation="true">${binding('program', 'input="= {step: &quot;undo&quot;}"')}</bpmn:task>
    <bpmn:association id="handler" sourceRef="compensate" targetRef="undo" associationDirection="One"/>
    <bpmn:intermediateCatchEvent id="ready"><bpmn:messageEventDefinition messageRef="Rollback"/></bpmn:intermediateCatchEvent>
    <bpmn:intermediateThrowEvent id="rollback"><bpmn:compensateEventDefinition/></bpmn:intermediateThrowEvent>
    ${flow('done', 'first', 'ready')}${flow('next', 'ready', 'rollback')}
    </bpmn:adHocSubProcess>`).replace('<bpmn:process', '<bpmn:message id="Rollback"/><bpmn:process');
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: source });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId, variablesJson: JSON.stringify({ hold }) });
  const coordinatorJob = await until(() => Object.values(f.runtime.record('run').jobs).find(job => job.metadata?.actions && job.status === 'submitted'));
  assert.deepEqual(coordinatorJob.metadata.actions.entries.map(entry => entry.id), ['first']);
  const undoJobs = () => Object.values(f.runtime.record('run').jobs).filter(job => job.activityId === 'undo');
  assert.deepEqual(undoJobs(), []);
  const actions = new Actions((await f.queue.paths(coordinatorJob.id)).directory, coordinatorJob.metadata.actions.entries);
  const selected = await actions.start('first', 'first', {}, { signal: AbortSignal.timeout(10000) });
  await actions.wait(selected.id, { signal: AbortSignal.timeout(10000) });
  const waiting = () => [...f.runtime.active.get('run').waiters.values()].some(({ activity }) => activity.id === 'ready');
  await until(waiting);
  assert.deepEqual(undoJobs(), []);
  await f.restart();
  await until(waiting);
  assert.deepEqual(undoJobs(), []);
  await f.runtime.sendMessage({ runId: 'run', target: 'Rollback', id: 'rollback' });
  await until(() => undoJobs().some(job => job.status === 'completed'));
  await writeFile(hold, 'done');
  await finished(f);
  assert.equal(undoJobs().length, 1);
});

test('discarding selected ad-hoc work does not discard its successors', async t => {
  const f = await fixture(t);
  const hold = join(f.root, 'finish-coordinator');
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: workflow(`<bpmn:adHocSubProcess id="work">${binding('coordinator', 'input="= {select: [], hold: hold}"')}
    ${programTask('first', ', wait: never')}${programTask('second')}${flow('next', 'first', 'second')}
    </bpmn:adHocSubProcess>`) });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId, variablesJson: JSON.stringify({ hold, never: join(f.root, 'never') }) });
  const coordinatorJob = await until(() => Object.values(f.runtime.record('run').jobs).find(job => job.metadata?.actions && job.status === 'submitted'));
  const actions = new Actions((await f.queue.paths(coordinatorJob.id)).directory, coordinatorJob.metadata.actions.entries);
  const selected = await actions.start('first', 'first', {});
  const controller = [...f.runtime.active.get('run').controllers.values()][0];
  controller.children().find(child => child.id === 'first').getApi().discard();
  await assert.rejects(actions.wait(selected.id, { signal: AbortSignal.timeout(5000) }), /discarded/);
  assert.equal(controller.children().find(child => child.id === 'second').counters.discarded, 0);
  assert.equal(controller.record.enabled.second, undefined);
  assert.equal(controller.available('second'), false);
  await writeFile(hold, 'done');
  await finished(f);
  assert.equal(Object.values(f.runtime.record('run').jobs).filter(job => job.activityId === 'second').length, 0);
});

test('an ad-hoc scope boundary timer cancels selected work and its coordinator', async t => {
  const f = await fixture(t);
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: workflow(`<bpmn:adHocSubProcess id="work">${binding('coordinator', 'input="= {select: [{action: &quot;slow&quot;}]}"')}
    ${programTask('slow', ', wait: never')}${programTask('unused')}
    </bpmn:adHocSubProcess>
    <bpmn:boundaryEvent id="deadline" attachedToRef="work"><bpmn:timerEventDefinition><bpmn:timeDuration xsi:type="bpmn:tFormalExpression">PT1S</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>
    ${programTask('timeout')}${flow('elapsed', 'deadline', 'timeout')}`) });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId, variablesJson: JSON.stringify({ never: join(f.root, 'never') }) });
  await until(() => Object.values(f.runtime.record('run').jobs).some(job => job.activityId === 'slow' && job.status === 'submitted'));
  const run = await finished(f);
  assert.equal(JSON.parse(run.outputJson).timeout.step, 'timeout');
  const jobs = Object.values(f.runtime.record('run').jobs);
  assert.equal(jobs.filter(job => job.activityId === 'unused').length, 0);
  for (const job of jobs.filter(job => job.activityId === 'slow' || job.type === 'coordinator')) {
    assert.equal((await f.queue.wait(job.id, { timeoutMs: 3000 })).status, 'cancelled');
  }
});

test('standard loops repeat while true and stop without issuing work when a precondition is false', async t => {
  const f = await fixture(t);
  const source = workflow(`<bpmn:task id="step">${binding('program', 'input="= {n: loopCounter}"')}
    <bpmn:standardLoopCharacteristics testBefore="true" loopMaximum="10"><bpmn:loopCondition xsi:type="bpmn:tFormalExpression">loopCounter &lt; count</bpmn:loopCondition></bpmn:standardLoopCharacteristics>
    </bpmn:task>`);
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: source });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId, variablesJson: '{"count":3}' });
  assert.deepEqual(JSON.parse((await finished(f)).outputJson).step, { n: 3 });
  assert.equal(Object.keys(f.runtime.record('run').jobs).length, 3);
  await f.runtime.startRun({ environment: 'test', id: 'zero', workflowId, variablesJson: '{"count":0}' });
  assert.equal(JSON.parse((await finished(f, 'zero')).outputJson).step, null);
  assert.equal(Object.keys(f.runtime.record('zero').jobs).length, 0);
});

test('multi-instance completion counts stop sequential work at the requested threshold', async t => {
  const f = await fixture(t);
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: workflow(`<bpmn:task id="step">${binding('program', 'input="= {n: loopCounter}"')}
    <bpmn:multiInstanceLoopCharacteristics isSequential="true"><bpmn:loopCardinality xsi:type="bpmn:tFormalExpression">10</bpmn:loopCardinality>
    <bpmn:completionCondition xsi:type="bpmn:tFormalExpression">numberOfCompletedInstances = 2</bpmn:completionCondition></bpmn:multiInstanceLoopCharacteristics>
    </bpmn:task>`) });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId });
  assert.deepEqual(JSON.parse((await finished(f)).outputJson).step, [{ n: 1 }, { n: 2 }]);
  assert.equal(Object.keys(f.runtime.record('run').jobs).length, 2);
});

test('data associations transform multiple inputs and feed a later activity from an output data object', async t => {
  const f = await fixture(t);
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: workflow(`
    <bpmn:dataObject id="left"/><bpmn:dataObject id="right"/><bpmn:dataObject id="combined"/>
    <bpmn:task id="combine">${binding('program', 'input="= {sum: inputs.total}"')}
      <bpmn:ioSpecification><bpmn:dataInput id="total" name="total"/><bpmn:dataOutput id="sum" name="sum"/>
        <bpmn:inputSet/><bpmn:outputSet/></bpmn:ioSpecification>
      <bpmn:dataInputAssociation><bpmn:sourceRef>left</bpmn:sourceRef><bpmn:sourceRef>right</bpmn:sourceRef><bpmn:targetRef>total</bpmn:targetRef>
        <bpmn:transformation xsi:type="bpmn:tFormalExpression">left + right</bpmn:transformation></bpmn:dataInputAssociation>
      <bpmn:dataOutputAssociation><bpmn:sourceRef>sum</bpmn:sourceRef><bpmn:targetRef>combined</bpmn:targetRef></bpmn:dataOutputAssociation>
    </bpmn:task>
    <bpmn:task id="consume">${binding('program', 'input="= {value: inputs.subject}"')}
      <bpmn:ioSpecification><bpmn:dataInput id="subject"/><bpmn:inputSet/><bpmn:outputSet/></bpmn:ioSpecification>
      <bpmn:dataInputAssociation><bpmn:sourceRef>combined</bpmn:sourceRef><bpmn:targetRef>subject</bpmn:targetRef></bpmn:dataInputAssociation>
    </bpmn:task>${flow('next', 'combine', 'consume')}`) });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId, variablesJson: '{"left":7,"right":5}' });
  const run = await finished(f);
  assert.deepEqual(JSON.parse(run.outputJson).consume, { value: 12 });
  assert.equal(JSON.parse(run.variablesJson)._data, undefined);
});

test('multi-instance collections bind standard inputDataItem names and preserve result order', async t => {
  const f = await fixture(t);
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: workflow(`<bpmn:task id="each">${binding('program', 'input="= {item: part, n: loopCounter}"')}
    <bpmn:ioSpecification><bpmn:dataInput id="items" isCollection="true"/><bpmn:inputSet/><bpmn:outputSet/></bpmn:ioSpecification>
    <bpmn:multiInstanceLoopCharacteristics isSequential="false"><bpmn:loopDataInputRef>items</bpmn:loopDataInputRef><bpmn:inputDataItem id="part" name="part"/></bpmn:multiInstanceLoopCharacteristics>
    </bpmn:task>`) });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId, variablesJson: '{"items":["a","b","c"]}' });
  assert.deepEqual(JSON.parse((await finished(f)).outputJson).each, [{ item: 'a', n: 1 }, { item: 'b', n: 2 }, { item: 'c', n: 3 }]);
});

test('program exit codes follow a matching BPMN boundary error path', async t => {
  const f = await fixture(t);
  const source = workflow(`<bpmn:task id="fails">${binding('program', 'input="= {fail: true}"')}</bpmn:task>
    <bpmn:boundaryEvent id="caught" attachedToRef="fails"><bpmn:errorEventDefinition errorRef="ProgramFailure"/></bpmn:boundaryEvent>
    <bpmn:task id="recover">${binding('program', 'input="= {recovered: true}"')}</bpmn:task>${flow('handled', 'caught', 'recover')}`)
    .replace('<bpmn:process', '<bpmn:error id="ProgramFailure" errorCode="17"/><bpmn:process');
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: source });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId });
  assert.equal(JSON.parse((await finished(f)).outputJson).recover.recovered, true);
});

test('a BPMN error handler receives the failed task result and exception reason', async t => {
  const f = await fixture(t);
  const source = workflow(`<bpmn:task id="fails">${binding('program', 'result="design" input="= {exception: &quot;Missing schematic&quot;, report: &quot;Only architecture.json was supplied&quot;}"')}</bpmn:task>
    <bpmn:boundaryEvent id="caught" attachedToRef="fails"><bpmn:errorEventDefinition errorRef="ProgramFailure"/></bpmn:boundaryEvent>
    <bpmn:task id="recover">${binding('program', 'input="= {reason: design.exception, report: design.report}"')}</bpmn:task>
    ${flow('handled', 'caught', 'recover')}`)
    .replace('<bpmn:process', '<bpmn:error id="ProgramFailure" errorCode="17"/><bpmn:process');
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: source });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId });
  const run = await finished(f);
  assert.deepEqual(JSON.parse(run.outputJson).recover, {
    reason: 'Missing schematic', report: 'Only architecture.json was supplied',
  });
  const failed = Object.values(f.runtime.record('run').jobs).find(job => job.activityId === 'fails');
  assert.equal(failed.error.message, 'Missing schematic');
  assert.equal(Object.hasOwn(failed.result, 'success'), false);
  assert.equal(failed.artifacts, undefined);
});

test('an unhandled job exception fails the run with its original reason', async t => {
  const f = await fixture(t);
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: workflow(
    `<bpmn:task id="fails">${binding('program', 'input="= {exception: &quot;Missing schematic&quot;}"')}</bpmn:task>
     <bpmn:task id="after">${binding('program')}</bpmn:task>${flow('next', 'fails', 'after')}`) });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId });
  const run = await until(() => { const run = f.runtime.getRun({ id: 'run' }).run; return run.status === 'failed' && run; });
  assert.match(run.error, /Missing schematic/);
  assert.deepEqual(Object.values(f.runtime.record('run').jobs).map(job => job.activityId), ['fails']);
});

for (const handled of [true, false]) {
  test(`a real agent exception ${handled ? 'starts the BPMN recovery agent' : 'fails an unhandled BPMN run'}`, async t => {
    const f = await fixture(t);
    const requests = [];
    const reason = 'Required schematic is missing';
    const server = createServer(connectNodeAdapter({ routes(router) { router.service(Provider, {
      listModels() { return { models: [model] }; },
      async *infer(request) {
        const { context } = JSON.parse(request.payload);
        requests.push(context);
        assert.match(context.systemPrompt, /^You are a Renaissance man:/);
        const task = context.messages.find(message => message.role === 'user').content;
        const recovering = JSON.stringify(task).includes('Recover: ' + reason);
        const message = assistant([{ type: 'text', text: JSON.stringify({
          final: recovering ? 'Recovery inspected: ' + reason : 'Exception: ' + reason,
          exception: recovering ? null : reason,
        }) }]);
        yield { payload: JSON.stringify({ type: 'done', reason: message.stopReason, message }) };
      },
    }); } }));
    const socket = join(f.root, 'provider.sock');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const agent = fileURLToPath(new URL('../../asys-workers/tools/asys-agent', import.meta.url));
    const queue = await f.addEnvironment('agents', {
      agent: { command: [process.execPath, agent, '--agent', 'test', '--model', 'fixture/model', '--extension', fileURLToPath(new URL('../../asys-workers/extensions/bpmn.mjs', import.meta.url))] },
      program: { command: ['python3', worker] },
    }, { DCOMP_IN_INFERENCE: `unix://${socket}` });
    let source = workflow(`<bpmn:task id="design">${binding('agent', 'input="= {prompt: &quot;Inspect the required schematic.&quot;}"')}</bpmn:task>
      <bpmn:task id="after">${binding('program')}</bpmn:task>${flow('next', 'design', 'after')}
      ${handled ? `<bpmn:boundaryEvent id="caught" attachedToRef="design"><bpmn:errorEventDefinition errorRef="AgentFailure"/></bpmn:boundaryEvent>
        <bpmn:task id="recover">${binding('agent', 'input="= {prompt: &quot;Recover: &quot; + design.exception}"')}</bpmn:task>
        ${flow('handled', 'caught', 'recover')}` : ''}`);
    if (handled) source = source.replace('<bpmn:process', '<bpmn:error id="AgentFailure" errorCode="1"/><bpmn:process');
    const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: source });
    await f.runtime.startRun({ environment: 'agents', id: 'run', workflowId });
    const run = await until(() => {
      const run = f.runtime.getRun({ id: 'run' }).run;
      return ['completed', 'failed'].includes(run.status) && run;
    });
    assert.equal(run.status, handled ? 'completed' : 'failed', run.error);
    if (handled) assert.equal(JSON.parse(run.outputJson).recover.final, 'Recovery inspected: ' + reason);
    else assert.match(run.error, /Required schematic is missing/);
    const jobs = Object.values(f.runtime.record('run').jobs);
    assert.deepEqual(jobs.map(job => job.activityId).sort(), handled ? ['design', 'recover'] : ['design']);
    const failed = jobs.find(job => job.activityId === 'design');
    const state = await queue.state(failed.id);
    assert.equal(state.status, 'failed');
    assert.equal(state.exit_code, 1);
    assert.equal(state.result.exception, reason);
    assert.equal(Object.hasOwn(state.result, 'success'), false);
    assert.equal(state.artifacts, undefined);
    assert.equal(requests.length, handled ? 2 : 1);
    assert.equal(await readFile(join((await queue.paths(failed.id)).directory, '.pi/system-prompt.txt'), 'utf8'), requests[0].systemPrompt);
  });
}

test('an ad-hoc completion condition stops its coordinator after selected work completes', async t => {
  const f = await fixture(t);
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: workflow(`<bpmn:adHocSubProcess id="work">${binding('coordinator', 'input="= {select: [{action: &quot;chosen&quot;}], hold: neverFile}"')}
    <bpmn:task id="chosen">${binding('program', 'input="= {approved: true}"')}</bpmn:task>
    <bpmn:completionCondition xsi:type="bpmn:tFormalExpression">chosen.approved = true</bpmn:completionCondition>
    </bpmn:adHocSubProcess>`) });
  await f.runtime.startRun({ environment: 'test', id: 'run', workflowId, variablesJson: JSON.stringify({ neverFile: join(f.root, 'never') }) });
  assert.equal(JSON.parse((await finished(f)).outputJson).work.chosen.approved, true);
  const controller = Object.values(f.runtime.record('run').jobs).find(j => j.type === 'coordinator');
  assert.equal((await f.queue.wait(controller.id, { timeoutMs: 3000 })).status, 'cancelled');
});

test('an explicitly enabled BPMN extension gives a Pi coordinator its action tools', async t => {
  const f = await fixture(t), frames = [];
  const server = createServer(connectNodeAdapter({ routes(router) { router.service(Provider, {
    listModels() { return { models: [model] }; },
    async *infer(request) {
      const { context } = JSON.parse(request.payload);
      frames.push(context);
      assert.doesNotMatch(context.systemPrompt, /Job artifacts: input\//);
      assert.ok(context.tools.some(tool => tool.name === 'start_action'));
      const message = frames.length === 1
        ? assistant([{ type: 'toolCall', id: 'choose', name: 'start_action', arguments: { action: 'work' } }], 'toolUse')
        : frames.length === 2
          ? assistant([{ type: 'toolCall', id: 'wait', name: 'wait_action', arguments: { id: JSON.parse(context.messages.at(-1).content[0].text).id } }], 'toolUse')
          : assistant([{ type: 'text', text: '{"final":"Selected work completed","exception":null}' }]);
      yield { payload: JSON.stringify({ type: 'done', reason: message.stopReason, message }) };
    },
  }); } }));
  const socket = join(f.root, 'coordinator.sock');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await f.addEnvironment('agents', {
    coordinator: { command: [process.execPath, fileURLToPath(new URL('../../asys-workers/tools/asys-agent', import.meta.url)),
      '--agent', 'test', '--model', model.id, '--extension', fileURLToPath(new URL('../../asys-workers/extensions/bpmn.mjs', import.meta.url))] },
    program: { command: ['python3', worker] },
  }, { DCOMP_IN_INFERENCE: `unix://${socket}` });
  const { workflowId } = await f.runtime.loadWorkflow({ bpmnXml: workflow(`<bpmn:adHocSubProcess id="select">
    ${binding('coordinator', 'input="= {prompt: &quot;Select work, wait, and finish.&quot;}"')}
    ${programTask('work')}</bpmn:adHocSubProcess>`) });
  await f.runtime.startRun({ environment: 'agents', id: 'run', workflowId });
  await finished(f);
  assert.equal(frames.length, 3);
  assert.equal(Object.values(f.runtime.record('run').jobs).filter(job => job.activityId === 'work').length, 1);
});
