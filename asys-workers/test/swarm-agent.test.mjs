import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { Code, ConnectError } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { Provider } from '@cyclo/provider/contract';
import { createResourceExhaustedError } from '@cyclo/provider/errors';
import { swarmAgent } from '../src/swarm-agent.mjs';
import { assistant, model } from './helpers.mjs';

const actionSchema = { type: 'object', properties: {
  type: { enum: ['move', 'rest'] }, dx: { type: 'integer', minimum: -1, maximum: 1 },
}, required: ['type'], additionalProperties: false };
const plan = { actions: [{ type: 'move', dx: 1 }], memory: { visited: [1, 2] } };
const finish = message => ({ payload: JSON.stringify({ type: 'done', reason: message.stopReason, message }) });
const toolResponse = value => assistant([{ type: 'toolCall', name: 'submit_plan', id: 'plan-1', arguments: value }], 'toolUse');

async function fixture(t, { input = {}, response = toolResponse(plan), models = [model] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'asys-swarm-worker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environment = join(directory, 'environment');
  const workers = join(directory, 'workers');
  const workspace = join(directory, 'workspace');
  await Promise.all([mkdir(join(workers, 'agents', 'forager'), { recursive: true }),
    mkdir(environment), mkdir(workspace)]);
  const definition = join(workers, 'agents', 'forager');
  await writeFile(join(definition, 'prompt.md'), 'FORAGER_PROMPT: Share evidence with your neighbours.');
  await writeFile(join(environment, 'tools.md'), 'WORLD_RULES: Movement is local.');
  const requests = [], events = [];
  const provider = {
    async listModels() { return { models }; },
    async *infer(request, options) {
      requests.push({ request, frame: JSON.parse(request.payload), options });
      yield finish(response);
    },
  };
  const job = { id: 'decision-1', directory, workspace, result: join(directory, 'result.json'),
    input: { mission: 'Create a resilient settlement.', agent: 'a-4', turn: 3, observation: { x: 1, neighbours: [] },
      memory: null, actionSchema, maxActions: 2, memoryBytes: 512, timeoutSeconds: 30, ...input } };
  const env = { ...process.env, ASYS_ENVIRONMENT_DIR: environment, ASYS_WORKERS_DIR: workers,
    ASYS_SYSTEM_MODELS: join(directory, 'system-models.json') };
  const controller = new AbortController();
  const args = { job, argv: ['--agent', 'forager', '--model', 'fixture/model'], env, signal: controller.signal };
  return { directory, environment, workers, definition, job, env, requests, events, provider, controller, args,
    run: overrides => swarmAgent({ ...args, ...overrides }, { provider, event: (type, data) => events.push({ type, ...data }) }),
    saved: async () => JSON.parse(await readFile(join(directory, 'agent.json'), 'utf8')) };
}

test('catalogue socket reset at swarm startup recovers before its bounded inference', async t => {
  const f = await fixture(t);
  let calls = 0;
  f.provider.listModels = async () => {
    if (++calls === 1) throw new ConnectError('socket hang up', Code.Aborted);
    return { models: [model] };
  };
  assert.deepEqual((await f.run()).actions, plan.actions);
  assert.equal(calls, 2);
  assert.equal(f.requests.length, 1);
  assert.ok(f.events.some(event => event.type === 'agent.provider_retrying' && event.operation === 'list_models'));
});

test('permanent swarm catalogue failure never starts inference', async t => {
  const f = await fixture(t);
  const failure = new ConnectError('catalogue access denied', Code.PermissionDenied);
  let calls = 0;
  f.provider.listModels = async () => { calls++; throw failure; };
  await assert.rejects(f.run(), error => error === failure);
  assert.equal(calls, 1);
  assert.equal(f.requests.length, 0);
});

test('swarm cancellation during catalogue backoff prevents another RPC or inference', async t => {
  const f = await fixture(t);
  let calls = 0;
  f.provider.listModels = async () => { calls++; throw new ConnectError('socket hang up', Code.Aborted); };
  await assert.rejects(swarmAgent(f.args, { provider: f.provider, event(type, data) {
    if (type === 'agent.provider_retrying' && data.operation === 'list_models') {
      queueMicrotask(() => f.controller.abort(new Error('Cancelled during catalogue retry')));
    }
  } }), /Cancelled during catalogue retry/);
  assert.equal(calls, 1);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.saved()).agent.status, 'cancelled');
});

test('swarm catalogue retry stays inside the decision deadline', async t => {
  const f = await fixture(t, { input: { timeoutSeconds: 0.1 } });
  let calls = 0;
  f.provider.listModels = async () => { calls++; throw new ConnectError('socket hang up', Code.Aborted); };
  await assert.rejects(f.run(), { name: 'TimeoutError' });
  assert.equal(calls, 1);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.saved()).agent.status, 'failed');
});

test('swarm catalogue exhaustion returns to its controller without inference or retry', async t => {
  const f = await fixture(t);
  let calls = 0;
  f.provider.listModels = async () => {
    calls++;
    throw createResourceExhaustedError(new Date(Date.now() + 86400000));
  };
  await assert.rejects(f.run(), /Provider exhausted; swarm decision was not retried/);
  assert.equal(calls, 1);
  assert.equal(f.requests.length, 0);
});

test('a swarm decision uses only submit_plan, selected prompt, actual usage and an observer transcript', async t => {
  const f = await fixture(t, { input: { objective: { gardens: 6, survivingTurns: 12 },
    options: { temperature: 0.3, maxTokens: 700 } } });
  await mkdir(join(f.environment, 'extensions'));
  await writeFile(join(f.environment, 'extensions', 'forbidden.mjs'), 'throw new Error("Extension must never run");');
  await writeFile(join(f.job.workspace, 'AGENTS.md'), 'WORKSPACE_INJECTION');
  const result = await f.run();
  assert.deepEqual(result, { ...plan, usage: assistant([]).usage });
  assert.equal(f.requests.length, 1);
  const { request, frame, options } = f.requests[0];
  assert.equal(request.model, 'fixture/model');
  assert.deepEqual(frame.context.tools.map(tool => tool.name), ['submit_plan']);
  assert.match(frame.context.systemPrompt, /FORAGER_PROMPT/);
  assert.match(frame.context.systemPrompt, /WORLD_RULES/);
  assert.doesNotMatch(frame.context.systemPrompt, /WORKSPACE_INJECTION/);
  assert.equal(frame.options.temperature, 0.3);
  assert.equal(frame.options.maxTokens, 700);
  assert.equal(frame.options.signal, undefined);
  assert.ok(options.signal instanceof AbortSignal);
  const observation = JSON.parse(frame.context.messages[0].content[0].text);
  assert.equal(observation.mission, f.job.input.mission);
  assert.deepEqual(observation.objective, { gardens: 6, survivingTurns: 12 });
  assert.equal(observation.agent, 'a-4');
  assert.equal(observation.turn, 3);
  assert.deepEqual(observation.observation, { x: 1, neighbours: [] });
  const saved = (await f.saved()).agent;
  assert.equal(saved.kind, 'swarm');
  assert.equal(saved.steps, 1);
  assert.equal(saved.status, 'done');
  assert.deepEqual(saved.session.entries.map(entry => entry.message.role), ['user', 'assistant']);
  assert.deepEqual(saved.session.entries[1].message.content, toolResponse(plan).content);
  assert.equal(saved.session.leafId, saved.session.entries[1].id);
  assert.equal(f.events.at(-1).status, 'done');
});

test('models without function tools receive a schema and return strict JSON', async t => {
  const f = await fixture(t, { models: [{ ...model, capabilities: { ...model.capabilities, functionTools: false } }],
    response: assistant([{ type: 'text', text: JSON.stringify(plan) }]) });
  assert.deepEqual((await f.run()).actions, plan.actions);
  assert.deepEqual(f.requests[0].frame.context.tools, []);
  assert.match(f.requests[0].frame.context.systemPrompt, /"maxItems":2/);
  assert.match(f.requests[0].frame.context.systemPrompt, /"enum":\["move","rest"\]/);
  assert.equal(JSON.parse(f.requests[0].frame.context.messages[0].content[0].text).objective, null);
});

test('effective reasoning options are saved before inference and explicit settings win', async t => {
  for (const [name, capable, options, reasoning] of [
    ['default', true, {}, 'medium'],
    ['override', true, { reasoning: 'high', maxTokens: 900 }, 'high'],
    ['off', true, { reasoning: 'off' }, 'off'],
    ['nonreasoning', false, {}, undefined],
  ]) await t.test(name, async t => {
    const f = await fixture(t, { input: { options },
      models: [{ ...model, capabilities: { ...model.capabilities, reasoning: capable } }] });
    const expected = { ...options, maxTokens: options.maxTokens ?? 4096 };
    if (reasoning !== undefined) expected.reasoning = reasoning;
    f.provider.infer = async function* (request) {
      assert.deepEqual(JSON.parse(request.payload).options, expected);
      const saved = (await f.saved()).agent;
      assert.deepEqual(saved.inferenceOptions, expected);
      assert.equal(saved.session.entries.length, 1, 'settings are durable before the response');
      yield finish(toolResponse(plan));
    };
    await f.run();
    assert.deepEqual((await f.saved()).agent.inferenceOptions, expected);
  });
});

test('shared and selected-agent skill instructions reach Provider without resources or unrelated agents', async t => {
  const f = await fixture(t);
  for (const [root, name, text] of [
    [f.environment, 'evidence', 'SHARED_SKILL: Compare evidence before revising a plan.'],
    [f.workers, 'coordination', 'WORKER_SKILL: Coordinate through observed artifacts.'],
    [f.definition, 'local', 'SELECTED_SKILL: Preserve useful private memory.'],
    [join(f.workers, 'agents', 'unselected'), 'secret', 'UNRELATED_AGENT_SKILL'],
    [f.job.workspace, 'project', 'WORKSPACE_SKILL'],
  ]) {
    const path = join(root, 'skills', name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'SKILL.md'), text);
    await writeFile(join(path, 'resource.txt'), 'RESOURCE_CONTENT_MUST_NOT_LOAD');
  }
  await f.run();
  const prompt = f.requests[0].frame.context.systemPrompt;
  assert.match(prompt, /SHARED_SKILL/);
  assert.match(prompt, /WORKER_SKILL/);
  assert.match(prompt, /SELECTED_SKILL/);
  assert.doesNotMatch(prompt, /UNRELATED_AGENT_SKILL|WORKSPACE_SKILL|RESOURCE_CONTENT_MUST_NOT_LOAD/);
  assert.deepEqual(f.requests[0].frame.context.tools.map(tool => tool.name), ['submit_plan']);
  assert.equal((await f.saved()).agent.skills.length, 3);
});

test('oversized or escaping skill instructions fail before inference', async t => {
  for (const problem of ['oversize', 'symlink']) await t.test(problem, async t => {
    const f = await fixture(t);
    const directory = join(f.definition, 'skills', 'bounded');
    await mkdir(directory, { recursive: true });
    if (problem === 'oversize') await writeFile(join(directory, 'SKILL.md'), 'x'.repeat(16385));
    else {
      const outside = join(f.job.workspace, 'instructions.md');
      await writeFile(outside, 'PRIVATE_WORKSPACE');
      await symlink(outside, join(directory, 'SKILL.md'));
    }
    await assert.rejects(f.run(), /Swarm instruction/);
    assert.equal(f.requests.length, 0);
  });
});

test('aggregate skill instructions and file count are bounded', async t => {
  for (const problem of ['bytes', 'count']) await t.test(problem, async t => {
    const f = await fixture(t);
    for (let i = 0; i < (problem === 'bytes' ? 5 : 17); i++) {
      const path = join(f.definition, 'skills', `skill-${i}`);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'SKILL.md'), problem === 'bytes' ? 'x'.repeat(16384) : 'small');
    }
    await assert.rejects(f.run(), problem === 'bytes' ? /exceed 65536 bytes/ : /at most 16 skills/);
    assert.equal(f.requests.length, 0);
  });
});

test('local action schema references keep their meaning inside the function tool schema', async t => {
  const schema = { definitions: { action: actionSchema }, $ref: '#/definitions/action' };
  const f = await fixture(t, { input: { actionSchema: schema } });
  await f.run();
  const validate = new Ajv().compile(f.requests[0].frame.context.tools[0].parameters);
  assert.equal(validate(plan), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...plan, actions: [{ type: 'shell' }] }), false);
});

test('literal JSON action values are unchanged when embedding an action schema', async t => {
  const action = { $ref: '#/literal', default: { $ref: '#/also-literal' } };
  const decision = { actions: [action], memory: null };
  const f = await fixture(t, { input: { actionSchema: { enum: [action] } }, response: toolResponse(decision) });
  await f.run();
  const validate = new Ajv().compile(f.requests[0].frame.context.tools[0].parameters);
  assert.equal(validate(decision), true, JSON.stringify(validate.errors));
});

test('model selection inherits simple and explicit CLI model overrides it', async t => {
  const f = await fixture(t);
  await writeFile(f.env.ASYS_SYSTEM_MODELS, JSON.stringify({ simple: 'fixture/model' }));
  await f.run({ argv: ['--agent', 'forager'] });
  assert.equal(f.requests[0].request.model, 'fixture/model');
  await writeFile(f.env.ASYS_SYSTEM_MODELS, JSON.stringify({ simple: 'missing/model' }));
  await f.run();
  assert.equal(f.requests[1].request.model, 'fixture/model');
  await assert.rejects(f.run({ argv: ['--agent', 'forager'] }), /no usable model missing\/model/);
});

test('a missing model has actionable configuration instructions and makes no inference', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({ argv: ['--agent', 'forager'] }), /asys system-model set simple MODEL/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.events.at(-1).status, 'failed');
});

test('invalid plans fail explicitly and preserve the actual response, without retries', async t => {
  const cases = [
    ['malformed JSON', assistant([{ type: 'text', text: '```json\n{}\n```' }]), /one JSON object/],
    ['extra fields', toolResponse({ ...plan, achieved: true }), /only actions and memory/],
    ['wrong action', toolResponse({ ...plan, actions: [{ type: 'bash', command: 'touch bad' }] }), /violates actionSchema/],
    ['out of range action', toolResponse({ ...plan, actions: [{ type: 'move', dx: 20 }] }), /violates actionSchema/],
    ['too many actions', toolResponse({ ...plan, actions: Array(3).fill({ type: 'rest' }) }), /at most 2 actions/],
    ['no actions', toolResponse({ memory: null }), /at most 2 actions/],
    ['no memory', toolResponse({ actions: [] }), /must include memory/],
    ['wrong tool', assistant([{ type: 'toolCall', id: 'exec', name: 'bash', arguments: { command: 'exit 0' } }], 'toolUse'), /only submit_plan/],
    ['multiple calls', assistant([...toolResponse(plan).content, ...toolResponse(plan).content], 'toolUse'), /exactly once/],
    ['truncated', { ...toolResponse(plan), stopReason: 'length' }, /did not finish \(length\)/],
    ['bad usage', { ...toolResponse(plan), usage: { input: 1, output: 1, totalTokens: -1 } }, /invalid usage.totalTokens/],
  ];
  for (const [name, response, expected] of cases) await t.test(name, async t => {
    const f = await fixture(t, { response });
    await assert.rejects(f.run(), expected);
    assert.equal(f.requests.length, 1);
    const saved = (await f.saved()).agent;
    assert.equal(saved.status, 'failed');
    assert.deepEqual(saved.session.entries.at(-1).message.content, response.content);
    assert.equal(f.events.at(-1).status, 'failed');
  });
});

test('memory limits count UTF-8 bytes, with null and empty plans accepted', async t => {
  const f = await fixture(t, { input: { memoryBytes: 6 }, response: toolResponse({ actions: [], memory: 'éé' }) });
  assert.deepEqual((await f.run()).memory, 'éé');
  f.job.input.memoryBytes = 5;
  await assert.rejects(f.run(), /memory exceeds memoryBytes \(5\)/);
  f.job.input.memory = 'éé';
  await assert.rejects(f.run(), /memory exceeds memoryBytes \(5\)/);
  assert.equal(f.requests.length, 2, 'oversized input memory is rejected before inference');
});

test('schema and local control options are rejected before inference', async t => {
  for (const [input, expected] of [
    [{ actionSchema: { type: 'not-a-type' } }, /Invalid actionSchema/],
    [{ actionSchema: { $async: true, type: 'object' } }, /Asynchronous schemas/],
    [{ actionSchema: { $ref: 'https://example.invalid/schema.json' } }, /Invalid actionSchema/],
    [{ options: { tools: [{ name: 'bash' }] } }, /options.tools/],
    [{ options: { env: { TOKEN: 'untrusted' } } }, /options.env/],
    [{ options: { apiKey: 'untrusted' } }, /options.apiKey/],
    [{ options: { headers: { authorization: 'untrusted' } } }, /options.headers/],
    [{ options: { signal: {} } }, /options.signal/],
    [{ options: { samplingParams: { model: 'unselected-model' } } }, /options.samplingParams/],
    [{ timeoutSeconds: 0 }, /timeoutSeconds/],
    [{ objective: 'A text claim is not a machine-checkable objective' }, /objective must be a JSON object/],
  ]) await t.test(JSON.stringify(input), async t => {
    const f = await fixture(t, { input });
    await assert.rejects(f.run(), expected);
    assert.equal(f.requests.length, 0);
  });
});

test('provider exhaustion fails one decision without replay or waiting', async t => {
  const f = await fixture(t);
  let calls = 0;
  f.provider.infer = async function* () {
    calls++;
    throw createResourceExhaustedError(new Date(Date.now() + 86400000));
  };
  await assert.rejects(f.run(), /Provider exhausted; swarm decision was not retried/);
  assert.equal(calls, 1);
});

async function waitForAbort(signal) {
  signal.throwIfAborted();
  const keepAlive = setInterval(() => {}, 1000);
  try { await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
  finally { clearInterval(keepAlive); }
}

test('a stalled inference times out and CLI timeout overrides input', async t => {
  const f = await fixture(t, { input: { timeoutSeconds: 10 } });
  let calls = 0;
  f.provider.infer = async function* (_request, { signal }) { calls++; await waitForAbort(signal); };
  await assert.rejects(f.run({ argv: [...f.args.argv, '--timeout', '0.02'] }), /timed out after 0.02 seconds/);
  assert.equal(calls, 1);
  assert.equal((await f.saved()).agent.status, 'failed');
});

test('job cancellation reaches Provider and produces a cancelled transcript', async t => {
  const f = await fixture(t);
  let providerSignal;
  f.provider.infer = async function* (_request, { signal }) {
    providerSignal = signal;
    f.controller.abort(new Error('Operator stopped the run'));
    await waitForAbort(signal);
  };
  await assert.rejects(f.run(), /Operator stopped the run/);
  assert.equal(providerSignal.aborted, true);
  assert.equal((await f.saved()).agent.status, 'cancelled');
  assert.equal(f.events.at(-1).status, 'cancelled');
});

test('streaming emits actual text before the terminal transcript entry', async t => {
  const f = await fixture(t);
  const release = Promise.withResolvers(), visible = Promise.withResolvers();
  f.provider.infer = async function* () {
    yield { payload: JSON.stringify({ type: 'text_delta', contentIndex: 0, delta: 'Considering local conditions.', partial: assistant([]) }) };
    visible.resolve();
    await release.promise;
    yield finish(toolResponse(plan));
  };
  const running = f.run();
  try {
    await visible.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.events.some(event => event.type === 'agent.message_delta' && event.delta === 'Considering local conditions.'));
    assert.equal((await f.saved()).agent.session.entries.length, 1);
  } finally { release.resolve(); }
  await running;
  assert.equal((await f.saved()).agent.session.entries.length, 2);
});

test('readable thinking streams and the entire response survives valid or invalid plans', async t => {
  for (const valid of [true, false]) await t.test(valid ? 'valid' : 'invalid', async t => {
    const thinking = { type: 'thinking', thinking: 'Compare the observed alternatives.', thinkingSignature: 'test-signature' };
    const response = toolResponse(valid ? plan : { ...plan, actions: [{ type: 'invalid' }] });
    response.content.unshift(thinking);
    const f = await fixture(t);
    const visible = Promise.withResolvers(), release = Promise.withResolvers();
    f.provider.infer = async function* () {
      yield { payload: JSON.stringify({ type: 'thinking_delta', contentIndex: 0,
        delta: thinking.thinking, partial: assistant([thinking], 'pending') }) };
      visible.resolve();
      await release.promise;
      yield finish(response);
    };
    const running = f.run();
    try {
      await visible.promise;
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(f.events.some(event => event.type === 'agent.message_delta'
        && event.kind === 'thinking' && event.delta === thinking.thinking));
      assert.equal((await f.saved()).agent.session.entries.length, 1);
    } finally { release.resolve(); }
    if (valid) await running;
    else await assert.rejects(running, /violates actionSchema/);
    const saved = (await f.saved()).agent;
    assert.equal(saved.status, valid ? 'done' : 'failed');
    assert.deepEqual(saved.session.entries.at(-1).message, response);
  });
});

test('an interrupted proposal preserves thinking but produces no plan result', async t => {
  for (const aborted of [false, true]) await t.test(aborted ? 'abort' : 'transport', async t => {
    const partial = toolResponse(plan);
    partial.content.unshift({ type: 'thinking', thinking: 'Unfinished comparison.', thinkingSignature: 'test-signature' });
    const f = await fixture(t);
    f.provider.infer = async function* () {
      yield { payload: JSON.stringify({ type: 'thinking_delta', contentIndex: 0,
        delta: partial.content[0].thinking, partial }) };
      if (aborted) f.controller.abort(new Error('Operator stopped the run'));
      throw new Error('Fixture transport failure');
    };
    await assert.rejects(f.run(), aborted ? /Operator stopped/ : /Fixture transport failure/);
    const saved = (await f.saved()).agent;
    assert.equal(saved.status, aborted ? 'cancelled' : 'failed');
    assert.equal(saved.result, undefined);
    assert.equal(saved.session.entries.at(-1).message.stopReason, aborted ? 'aborted' : 'error');
    assert.deepEqual(saved.session.entries.at(-1).message.content, partial.content);
  });
});

test('the executable writes a runtime result through the real Provider socket protocol', async t => {
  const f = await fixture(t);
  const inputPath = join(f.directory, 'input.json');
  await writeFile(inputPath, JSON.stringify(f.job.input));
  const server = createServer(connectNodeAdapter({ routes(router) { router.service(Provider, f.provider); } }));
  const socket = join(f.directory, 'provider.sock');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const executable = fileURLToPath(new URL('../tools/asys-swarm-agent', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [executable, ...f.args.argv], {
    env: { ...f.env, DCOMP_IN_INFERENCE: `unix://${socket}`, ASYS_JOB_ID: f.job.id,
      ASYS_JOB_DIR: f.job.directory, ASYS_WORKSPACE: f.job.workspace, ASYS_INPUT: inputPath, ASYS_RESULT: f.job.result },
  });
  const result = JSON.parse(await readFile(f.job.result, 'utf8'));
  assert.deepEqual(result.actions, plan.actions);
  assert.equal(result.usage.totalTokens, 110);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].request.model, 'fixture/model');
  assert.match(stdout, /"type":"swarm.decision_finished"/);
});
