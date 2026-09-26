import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runTestAgent as runAgent } from './helpers.mjs';
import { groupModels, listProviderModels, streamProvider } from '../src/provider-adapter.mjs';
import { Code, ConnectError } from '@connectrpc/connect';
import { createResourceExhaustedError } from '@cyclo/provider/errors';
import { assistant, model } from './helpers.mjs';

test('catalogue capacity waits reuse capped reset timing and report the operation', async () => {
  let clock = 1_700_000_000_000, calls = 0;
  const events = [], delays = [], catalogue = { models: [model] };
  const provider = { async listModels() {
    if (++calls === 1) throw createResourceExhaustedError(new Date(clock + 86400000));
    if (calls === 2) throw new ConnectError('capacity unavailable', Code.ResourceExhausted);
    return catalogue;
  } };
  assert.equal(await listProviderModels(provider, {}, {
    now: () => clock, random: () => 1,
    async sleep(ms) { delays.push(ms); clock += ms; },
    onExhaustion: detail => events.push(['exhausted', detail]),
    onRetry: detail => events.push(['retrying', detail]),
  }), catalogue);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [600000, 2000]);
  assert.deepEqual(events.map(([type, detail]) => [type, detail.operation, detail.delayMs]), [
    ['exhausted', 'list_models', 600000], ['retrying', 'list_models', 0],
    ['exhausted', 'list_models', 2000], ['retrying', 'list_models', 0],
  ]);
});

test('catalogue transport backoff stays capped while native socket failures persist', async () => {
  let calls = 0;
  const delays = [];
  const provider = { async listModels() {
    if (++calls <= 8) throw new Error('transport failed', { cause: Object.assign(new Error('broken pipe'), { code: 'EPIPE' }) });
    return { models: [model] };
  } };
  await listProviderModels(provider, {}, { random: () => 1, sleep: async ms => delays.push(ms) });
  assert.equal(calls, 9);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test('catalogue cancellation before lookup and during an RPC never retries', async t => {
  for (const before of [true, false]) await t.test(before ? 'before lookup' : 'in flight', async () => {
    const controller = new AbortController(), cancellation = new Error('Catalogue cancelled');
    let calls = 0;
    if (before) controller.abort(cancellation);
    const provider = { async listModels(_request, { signal }) {
      calls++;
      controller.abort(cancellation);
      signal.throwIfAborted();
    } };
    await assert.rejects(listProviderModels(provider, { signal: controller.signal }), error => error === cancellation);
    assert.equal(calls, before ? 0 : 1);
  });
});

test('the worker publishes actual text and thinking before the message finishes', { timeout: 10000 }, async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'asys-live-transcript-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const release = Promise.withResolvers(), visible = Promise.withResolvers();
  const controller = new AbortController(), events = [];
  let saved;
  const provider = {
    async listModels() { return { models: [{ ...model, capabilities: { ...model.capabilities, reasoning: true } }] }; },
    async *infer(request) {
      assert.equal(JSON.parse(request.payload).options.reasoning, 'medium');
      const partial = assistant([], 'pending');
      const send = event => ({ payload: JSON.stringify(event) });
      yield send({ type: 'start', partial });
      partial.content.push({ type: 'thinking', thinking: '' });
      yield send({ type: 'thinking_start', contentIndex: 0, partial });
      partial.content[0].thinking = 'I need to check the board connections.';
      partial.content[0].thinkingSignature = 'fixture-thinking-signature';
      yield send({ type: 'thinking_delta', contentIndex: 0, delta: partial.content[0].thinking, partial });
      partial.content.push({ type: 'text', text: '' });
      yield send({ type: 'text_start', contentIndex: 1, partial });
      partial.content[1].text = 'I am inspecting the board now.';
      yield send({ type: 'text_delta', contentIndex: 1, delta: partial.content[1].text, partial });
      await release.promise;
      partial.content[1].text = JSON.stringify({ final: 'I am inspecting the board now.', exception: null });
      partial.stopReason = 'stop';
      yield send({ type: 'done', reason: 'stop', message: partial });
    },
  };
  const job = { id: 'live' };
  const running = runAgent({ config: { model: 'fixture/model', prompt: 'Check the board.', maxSteps: 3, options: {} },
    job, workspace, signal: controller.signal, provider,
    save() { saved = structuredClone(job); },
    event(type, data) { events.push({ type, ...data }); if (type === 'agent.message_delta' && data.kind === 'text') visible.resolve(); },
  });
  let timer, result;
  try {
    await Promise.race([visible.promise, running.then(() => { throw new Error('No live transcript before completion'); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Missing live agent text')), 2000); })]);
    assert.ok(events.some(e => e.type === 'agent.message_delta' && e.kind === 'thinking' && e.delta === 'I need to check the board connections.'));
    assert.ok(events.some(e => e.type === 'agent.message_delta' && e.kind === 'text' && e.delta === 'I am inspecting the board now.'));
    assert.ok(!saved.agent.session.entries.some(e => e.message?.role === 'assistant'), 'message is still streaming');
  } finally { clearTimeout(timer); release.resolve(); result = await running; }
  assert.equal(result.final, 'I am inspecting the board now.');
  assert.deepEqual(saved.agent.session.entries.at(-1).message.content[0], {
    type: 'thinking', thinking: 'I need to check the board connections.', thinkingSignature: 'fixture-thinking-signature',
  });
});

test('interrupted ordinary agent responses retain evidence without executing partial tools', async t => {
  for (const aborted of [false, true]) await t.test(aborted ? 'abort' : 'transport', async t => {
    const workspace = await mkdtemp(join(tmpdir(), 'asys-interrupted-transcript-'));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const controller = new AbortController(), job = { id: 'interrupted' };
    const content = [
      { type: 'thinking', thinking: 'This response is still incomplete.', thinkingSignature: 'fixture-signature' },
      { type: 'toolCall', id: 'partial-call', name: 'do_not_run', arguments: {} },
    ];
    let executions = 0;
    const provider = {
      async listModels() { return { models: [model] }; },
      async *infer() {
        const partial = assistant(content, 'pending');
        yield { payload: JSON.stringify({ type: 'start', partial }) };
        yield { payload: JSON.stringify({ type: 'thinking_delta', contentIndex: 0, delta: content[0].thinking, partial }) };
        if (aborted) controller.abort(new Error('Fixture operator cancellation'));
        throw new ConnectError('Fixture failed stream', Code.DataLoss);
      },
    };
    await assert.rejects(runAgent({
      config: { model: 'fixture/model', prompt: 'Observe the failure.', maxSteps: 1, options: {} },
      job, workspace, provider, signal: controller.signal, save() {}, event() {},
      customTools: [{ name: 'do_not_run', label: 'Do not run', description: 'Must never execute',
        parameters: { type: 'object', properties: {} }, async execute() { executions++; return { content: [] }; } }],
    }), aborted ? /Fixture operator cancellation/ : /Fixture failed stream/);
    assert.equal(executions, 0);
    const saved = job.agent.session.entries.at(-1).message;
    assert.equal(saved.stopReason, aborted ? 'aborted' : 'error');
    assert.deepEqual(saved.content, content);
  });
});

test('terminal transport failures preserve the latest native partial, or remain empty before output', async t => {
  for (const withOutput of [false, true]) for (const aborted of [false, true]) {
    await t.test(`${withOutput ? 'partial' : 'no output'} ${aborted ? 'abort' : 'failure'}`, async () => {
      const route = groupModels([model]).get('fixture')[0];
      const controller = new AbortController();
      const partial = { ...assistant([
        { type: 'thinking', thinking: 'Received summary.', thinkingSignature: 'fixture-native-signature' },
        { type: 'text', text: 'Received text.' },
      ], 'pending'), api: 'openai-codex-responses', provider: 'openai-codex', model: 'backend' };
      const provider = { async *infer() {
        if (withOutput) yield { payload: JSON.stringify({ type: 'thinking_delta', contentIndex: 0,
          delta: partial.content[0].thinking, partial }) };
        if (aborted) controller.abort();
        throw new ConnectError('Fixture failed stream', Code.DataLoss);
      } };
      const result = await streamProvider(provider, model.id, route.model, { messages: [] },
        { signal: controller.signal }, { sleep: async () => assert.fail('terminal failure must not retry') }).result();
      assert.equal(result.stopReason, aborted ? 'aborted' : 'error');
      assert.deepEqual(result.content, withOutput ? partial.content : []);
      if (withOutput) assert.deepEqual(result.asysNativeIdentity,
        { api: partial.api, provider: partial.provider, model: partial.model });
      assert.equal(partial.stopReason, 'pending');
    });
  }
});

test('retry interruption retains native error content or preceding content if the error is empty', async t => {
  for (const errorHasContent of [false, true]) await t.test(errorHasContent ? 'error content' : 'earlier content', async () => {
    const route = groupModels([model]).get('fixture')[0];
    const content = [
      { type: 'thinking', thinking: 'Received summary.', thinkingSignature: 'fixture-signature' },
      { type: 'toolCall', id: 'incomplete', name: 'unused', arguments: { input: 'parsed so far' },
        partialJson: '{"input":"parsed so far', customInput: { property: 'input', jsonBuffer: {} } },
    ];
    const expected = structuredClone(content);
    delete expected[1].partialJson;
    delete expected[1].customInput;
    const provider = { async *infer() {
      if (!errorHasContent) yield { payload: JSON.stringify({ type: 'start', partial: assistant(content, 'pending') }) };
      yield { payload: JSON.stringify({ type: 'error', reason: 'error',
        error: { ...assistant(errorHasContent ? content : [], 'error'), errorMessage: 'terminated' } }) };
    } };
    const result = await streamProvider(provider, model.id, route.model, { messages: [] }, {}, {
      onRetry() { throw new Error('Fixture stopped recovery'); },
      sleep: async () => assert.fail('recovery was interrupted'),
    }).result();
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage, /Fixture stopped recovery/);
    assert.deepEqual(result.content, expected);
    assert.equal(content[1].partialJson, '{"input":"parsed so far', 'received evidence is not mutated');
  });
});

test('Pi discovers and reads skills supplied by the selected environment', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'asys-environment-skills-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environmentDirectory = join(directory, 'env');
  const skill = join(environmentDirectory, 'skills', 'fixture', 'SKILL.md');
  await mkdir(join(environmentDirectory, 'skills', 'fixture'), { recursive: true });
  await writeFile(skill, '---\nname: fixture\ndescription: Environment-specific synthesis instructions.\n---\nUse the ENVIRONMENT_SKILL_MARKER command.\n');
  const workspace = join(directory, 'workspace');
  await mkdir(join(workspace, '.pi'), { recursive: true });
  await writeFile(join(workspace, 'AGENTS.md'), 'PROJECT_INSTRUCTIONS_MARKER');
  await writeFile(join(workspace, '.pi/SYSTEM.md'), 'PROJECT_SYSTEM_MARKER');
  await writeFile(join(workspace, '.pi/APPEND_SYSTEM.md'), 'PROJECT_APPEND_SYSTEM_MARKER');
  const requests = [];
  const provider = {
    async listModels() { return { models: [model] }; },
    async *infer(request) {
      const frame = JSON.parse(request.payload);
      requests.push(frame);
      const message = requests.length === 1
        ? assistant([{ type: 'toolCall', id: 'read-skill', name: 'read', arguments: { path: skill } }], 'toolUse')
        : assistant([{ type: 'text', text: JSON.stringify({ final: 'Read the environment instructions.', exception: null }) }]);
      yield { payload: JSON.stringify({ type: 'done', reason: message.stopReason, message }) };
    },
  };
  await runAgent({ config: { model: 'fixture/model', prompt: 'Read the synthesis skill.', maxSteps: 3, options: {} },
    job: { id: 'skills' }, workspace, environmentDirectory,
    signal: new AbortController().signal, provider, save() {}, event() {} });
  assert.match(requests[0].context.systemPrompt, /Environment-specific synthesis instructions/);
  for (const { context } of requests) {
    assert.match(context.systemPrompt, /^You are a Renaissance man:/);
    assert.doesNotMatch(context.systemPrompt, /operating inside pi|Pi documentation|approved|success\s*[:=]/);
    assert.doesNotMatch(context.systemPrompt, /PROJECT_(?:INSTRUCTIONS|SYSTEM|APPEND_SYSTEM)_MARKER/);
    assert.doesNotMatch(context.systemPrompt, /ASYS_RESULT/);
    assert.match(context.systemPrompt, /"exception"/);
    for (const name of ['read', 'bash', 'edit', 'write']) {
      assert.ok(context.tools.some(tool => tool.name === name && tool.parameters));
      assert.match(context.systemPrompt, new RegExp(`^- ${name}: .+`, 'm'));
    }
  }
  assert.equal(await readFile(join(workspace, 'test-job/.pi/system-prompt.txt'), 'utf8'), requests.at(-1).context.systemPrompt);
  assert.ok(requests[1].context.messages.some(message => message.role === 'toolResult' && JSON.stringify(message.content).includes('ENVIRONMENT_SKILL_MARKER')));
});

test('Pi loads and executes tools from the selected environment extensions directory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'asys-environment-extensions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environmentDirectory = join(directory, 'env');
  await mkdir(join(environmentDirectory, 'extensions'), { recursive: true });
  await writeFile(join(environmentDirectory, 'extensions', 'lookup.ts'), `
    export default function (pi) {
      pi.registerTool({ name: 'environment_lookup', label: 'Lookup', description: 'Look up environment reference data.',
        promptGuidelines: ['Verify the returned reference version.'],
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        async execute(_id, { query }) { return { content: [{ type: 'text', text: 'REFERENCE: ' + query }], details: {} }; }
      });
      pi.on('before_agent_start', event => {
        pi.setActiveTools(pi.getActiveTools().filter(name => name !== 'edit'));
        return { systemPrompt: event.systemPrompt + '\\nENVIRONMENT_PROMPT_MARKER' };
      });
    }
  `);
  const requests = [];
  const provider = {
    async listModels() { return { models: [model] }; },
    async *infer(request) {
      const frame = JSON.parse(request.payload);
      requests.push(frame);
      assert.ok(frame.context.tools.some(tool => tool.name === 'environment_lookup'));
      assert.match(frame.context.systemPrompt, /^- environment_lookup: Look up environment reference data\./m);
      assert.match(frame.context.systemPrompt, /Verify the returned reference version/);
      assert.match(frame.context.systemPrompt, /ENVIRONMENT_PROMPT_MARKER/);
      assert.doesNotMatch(frame.context.systemPrompt, /^- edit:|edits\[\]/m);
      assert.ok(!frame.context.tools.some(tool => tool.name === 'edit'));
      const message = requests.length === 1
        ? assistant([{ type: 'toolCall', id: 'lookup', name: 'environment_lookup', arguments: { query: 'timer' } }], 'toolUse')
        : assistant([{ type: 'text', text: JSON.stringify({ final: 'Looked up the reference.', exception: null }) }]);
      yield { payload: JSON.stringify({ type: 'done', reason: message.stopReason, message }) };
    },
  };
  await runAgent({ config: { model: 'fixture/model', prompt: 'Look up the timer.', maxSteps: 3, options: {} },
    job: { id: 'extensions' }, workspace: join(directory, 'workspace'), environmentDirectory,
    signal: new AbortController().signal, provider, save() {}, event() {} });
  assert.equal(requests.length, 2);
  assert.ok(requests[1].context.messages.some(message => message.role === 'toolResult' && JSON.stringify(message.content).includes('REFERENCE: timer')));
});

test('a broken environment extension fails the job instead of silently omitting its tools', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'asys-broken-extension-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environmentDirectory = join(directory, 'env');
  await mkdir(join(environmentDirectory, 'extensions'), { recursive: true });
  await writeFile(join(environmentDirectory, 'extensions', 'broken.ts'), 'export default () => { throw new Error("Reference tool unavailable"); };');
  const provider = {
    async listModels() { return { models: [model] }; },
    async *infer() { assert.fail('Inference must not start with missing environment tools'); },
  };
  await assert.rejects(runAgent({ config: { model: 'fixture/model', prompt: 'Look up a reference.', maxSteps: 1, options: {} },
    job: { id: 'broken' }, workspace: join(directory, 'workspace'), environmentDirectory,
    signal: new AbortController().signal, provider, save() {}, event() {} }), /Reference tool unavailable/);
});

test('Pi SDK runs its real shell tool and sends native frames through Provider', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'asys-bpmn-pi-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests = [], events = [];
  const provider = {
    async listModels() { return { models: [model] }; },
    async *infer(request) {
      assert.equal(request.model, 'fixture/model');
      const frame = JSON.parse(request.payload);
      requests.push(frame);
      assert.ok(frame.context.tools.some(tool => tool.name === 'bash'));
      const message = requests.length === 1
        ? assistant([{ type: 'toolCall', id: 'write-file', name: 'bash', arguments: { command: 'printf "from Pi\\n" > proof.txt' } }], 'toolUse')
        : assistant([{ type: 'text', text: JSON.stringify({ final: 'Created proof.txt', exception: null }) }]);
      yield { payload: JSON.stringify({ type: 'done', reason: message.stopReason, message }) };
    },
  };
  const job = { id: 'agent-execution' };
  let saves = 0;
  const result = await runAgent({
    config: { model: 'fixture/model', prompt: 'Create proof.txt', maxSteps: 4, options: {} },
    job,
    signal: new AbortController().signal, provider, workspace: directory,
    save: () => saves++, event: (type, data) => events.push({ type, data }),
  });
  assert.equal(await readFile(join(directory, 'proof.txt'), 'utf8'), 'from Pi\n');
  assert.equal(requests.length, 2);
  assert.equal(result.final, 'Created proof.txt');
  assert.ok(requests[1].context.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'write-file'));
  assert.ok(events.some(event => event.type === 'agent.tool_completed'));
  assert.ok(job.agent.session.entries.some(entry => entry.type === 'message' && entry.message.role === 'toolResult'));
  assert.ok(saves > 1);
});

test('incomplete streams retry beyond the old retry limit with capped backoff', async () => {
  const route = groupModels([model]).get('fixture')[0];
  const requests = [], delays = [];
  const provider = { async *infer(request) {
    requests.push(request);
    if (requests.length <= 8) return;
    yield { payload: JSON.stringify({ type: 'done', reason: 'stop', message: assistant([]) }) };
  } };
  const result = await streamProvider(provider, model.id, route.model, { messages: [] }, {}, {
    random: () => 1, sleep: async ms => delays.push(ms),
  }).result();
  assert.equal(result.stopReason, 'stop');
  assert.equal(requests.length, 9);
  assert.ok(requests.every(request => request === requests[0]));
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test('the Provider RPC iterator is released when its terminal Pi event arrives', async () => {
  const route = groupModels([model]).get('fixture')[0];
  let closed = false;
  const message = assistant([{ type: 'text', text: JSON.stringify({ final: 'Finished', exception: null }) }]);
  const provider = { async *infer() {
    try {
      yield { payload: JSON.stringify({ type: 'done', reason: 'stop', message }) };
      throw new Error('Consumer continued after the terminal frame');
    } finally { closed = true; }
  } };
  const stream = streamProvider(provider, model.id, route.model, { messages: [] });
  assert.equal((await stream.result()).stopReason, 'stop');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, true);
});

for (const [resetAfterMs, expectedDelayMs] of [[500, 1000], [60_000, 60_000], [3 * 60 * 60 * 1000, 600_000]]) {
test(`provider reset in ${resetAfterMs} ms is rechecked after ${expectedDelayMs} ms`, async () => {
  const route = groupModels([model]).get('fixture')[0];
  const start = 1_700_000_000_000;
  let clock = start, calls = 0;
  const sleeps = [], waits = [];
  const provider = { async *infer(_request, { signal }) {
    assert.equal(signal.aborted, false);
    if (++calls === 1) throw createResourceExhaustedError(new Date(start + resetAfterMs));
    yield { payload: JSON.stringify({ type: 'done', reason: 'stop', message: assistant([{ type: 'text', text: JSON.stringify({ final: 'Back', exception: null }) }]) }) };
  } };
  const stream = streamProvider(provider, model.id, route.model, { messages: [] }, { signal: new AbortController().signal }, {
    now: () => clock,
    async sleep(delayMs, signal) { sleeps.push(delayMs); signal?.throwIfAborted(); clock += delayMs; },
    onExhaustion: wait => waits.push(wait),
  });
  const result = await stream.result();
  assert.equal(result.stopReason, 'stop');
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [expectedDelayMs]);
  assert.equal(waits.length, 1);
  assert.equal(waits[0].retryAt.getTime(), start + expectedDelayMs);
  assert.equal(waits[0].delayMs, expectedDelayMs);
});
}

test('cancelling the default exhaustion wait aborts before another request', async () => {
  const route = groupModels([model]).get('fixture')[0];
  const controller = new AbortController();
  let calls = 0;
  const provider = { async *infer() {
    calls++;
    throw createResourceExhaustedError(new Date(Date.now() + 24 * 60 * 60 * 1000));
  } };
  const stream = streamProvider(provider, model.id, route.model, { messages: [] },
    { signal: controller.signal }, {
      onExhaustion() { queueMicrotask(() => controller.abort()); },
    });
  const result = await stream.result();
  assert.equal(result.stopReason, 'aborted');
  assert.equal(calls, 1, 'no replay after cancellation');
});


// A fake in-flight request: a real one holds a socket open, so the event loop
// stays alive while the attempt waits for its signal.
async function stallUntilAborted(signal) {
  signal.throwIfAborted();
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } finally { clearInterval(keepAlive); }
}

for (const partial of [false, true]) {
  test(`inference keeps waiting ${partial ? 'after partial output' : 'before the first response'} without a worker deadline`, async () => {
    const route = groupModels([model]).get('fixture')[0];
    const controller = new AbortController();
    const message = assistant([{ type: 'text', text: JSON.stringify({ final: 'Finished', exception: null }) }]);
    let calls = 0;
    const provider = { async *infer(_request, options) {
      calls++;
      assert.deepEqual(Object.keys(options), ['signal']);
      assert.equal(options.signal.aborted, false);
      if (partial) yield { payload: JSON.stringify({ type: 'start', partial: assistant([], 'pending') }) };
      // Native timeout options must not become a worker deadline.
      await delay(60, undefined, { signal: options.signal });
      yield { payload: JSON.stringify({ type: 'done', reason: 'stop', message }) };
    } };
    const stream = streamProvider(provider, model.id, route.model, { messages: [] },
      { signal: controller.signal, timeoutMs: 20 });
    assert.equal((await stream.result()).stopReason, 'stop');
    assert.equal(calls, 1, 'the worker keeps the original request open');
  });

  test(`operator cancellation stops inference ${partial ? 'after partial output' : 'before the first response'}`, async () => {
    const route = groupModels([model]).get('fixture')[0];
    const controller = new AbortController(), waiting = Promise.withResolvers();
    let calls = 0;
    const provider = { async *infer(_request, { signal }) {
      calls++;
      if (partial) yield { payload: JSON.stringify({ type: 'start', partial: assistant([], 'pending') }) };
      waiting.resolve();
      await stallUntilAborted(signal);
    } };
    const stream = streamProvider(provider, model.id, route.model, { messages: [] }, { signal: controller.signal });
    await waiting.promise;
    controller.abort();
    assert.equal((await stream.result()).stopReason, 'aborted');
    assert.equal(calls, 1, 'no replay after cancellation');
  });
}

test('native timeout options never enter the Provider payload or RPC options', async () => {
  const route = groupModels([model]).get('fixture')[0];
  let frame;
  const provider = { async *infer(request, options) {
    assert.deepEqual(Object.keys(options), ['signal']);
    frame = JSON.parse(request.payload);
    yield { payload: JSON.stringify({ type: 'done', reason: 'stop', message: assistant([{ type: 'text', text: JSON.stringify({ final: 'ok', exception: null }) }]) }) };
  } };
  const result = await streamProvider(provider, model.id, route.model, { messages: [] },
    { timeoutMs: 1000, temperature: 0.2 }).result();
  assert.equal(result.stopReason, 'stop');
  assert.equal(frame.options.timeoutMs, undefined);
  assert.equal(frame.options.temperature, 0.2);
});

for (const partial of [false, true]) {
  test(`an idle ${partial ? 'partial stream' : 'first response'} retries only the RPC, even if its iterator ignores abort`, { timeout: 2000 }, async () => {
    const route = groupModels([model]).get('fixture')[0];
    const requests = [], signals = [], retries = [];
    const done = { type: 'done', reason: 'stop', message: assistant([{ type: 'text', text: 'Recovered' }]) };
    const provider = { async *infer(request, { signal }) {
      requests.push(request);
      signals.push(signal);
      if (requests.length === 1) {
        if (partial) yield { payload: JSON.stringify({ type: 'start', partial: assistant([], 'pending') }) };
        await new Promise(() => {});
      }
      yield { payload: JSON.stringify({ type: 'start', partial: assistant([], 'pending') }) };
      yield { payload: JSON.stringify(done) };
    } };
    const context = { messages: [{ role: 'toolResult', content: 'already done' }] };
    const stream = streamProvider(provider, model.id, route.model, context, {}, {
      idleTimeoutMs: 20, sleep: async () => {}, onRetry: event => retries.push(event),
    });
    const events = [];
    for await (const event of stream) events.push(event);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], requests[1]);
    assert.ok(signals[0].aborted);
    assert.deepEqual(events.map(event => event.type), ['start', 'done']);
    assert.equal(events.at(-1).message.content[0].text, 'Recovered');
    assert.match(retries[0].errorMessage, partial ? /stream inactivity/ : /first response timeout/);
  });
}

test('progress refreshes the inactivity timer without an absolute deadline', { timeout: 2000 }, async () => {
  const route = groupModels([model]).get('fixture')[0];
  let calls = 0;
  const provider = { async *infer() {
    calls++;
    for (let i = 0; i < 6; i++) {
      await delay(25);
      yield { payload: JSON.stringify({ type: 'text_delta', delta: 'progress', partial: assistant([]) }) };
    }
    yield { payload: JSON.stringify({ type: 'done', reason: 'stop', message: assistant([]) }) };
  } };
  const result = await streamProvider(provider, model.id, route.model, { messages: [] }, {}, {
    idleTimeoutMs: 100, sleep: async () => assert.fail('progress must not retry'),
  }).result();
  assert.equal(result.stopReason, 'stop');
  assert.equal(calls, 1);
});

for (const code of [Code.Unavailable, Code.DeadlineExceeded, Code.Aborted, Code.Canceled]) {
  test(`RPC ${Code[code]} is retried while the caller remains active`, async () => {
    const route = groupModels([model]).get('fixture')[0];
    let calls = 0;
    const provider = { async *infer() {
      if (++calls === 1) throw new ConnectError('upstream stopped', code);
      yield { payload: JSON.stringify({ type: 'done', reason: 'stop', message: assistant([]) }) };
    } };
    const result = await streamProvider(provider, model.id, route.model, { messages: [] }, {}, { sleep: async () => {} }).result();
    assert.equal(result.stopReason, 'stop');
    assert.equal(calls, 2);
  });
}

for (const code of [Code.InvalidArgument, Code.Unauthenticated, Code.PermissionDenied, Code.FailedPrecondition, Code.Internal, Code.DataLoss]) {
  test(`RPC ${Code[code]} fails promptly even if its message mentions a timeout`, async () => {
    const route = groupModels([model]).get('fixture')[0];
    let calls = 0;
    const provider = { async *infer() { calls++; throw new ConnectError('invalid timeout setting', code); } };
    const result = await streamProvider(provider, model.id, route.model, { messages: [] }, {}, {
      sleep: async () => assert.fail('nonretryable error'),
    }).result();
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage, /invalid timeout setting/);
    assert.equal(calls, 1);
  });
}

test('partial output followed by repeated capacity limits waits outside cancelled RPCs', async () => {
  const route = groupModels([model]).get('fixture')[0];
  let clock = 1_700_000_000_000, calls = 0, lastSignal;
  const waits = [], delays = [];
  const provider = { async *infer(_request, { signal }) {
    calls++;
    lastSignal = signal;
    yield { payload: JSON.stringify({ type: 'start', partial: assistant([], 'pending') }) };
    if (calls <= 2) throw createResourceExhaustedError(new Date(clock + 5 * 60 * 60 * 1000));
    yield { payload: JSON.stringify({ type: 'done', reason: 'stop', message: assistant([]) }) };
  } };
  const stream = streamProvider(provider, model.id, route.model, { messages: [] }, {}, {
    idleTimeoutMs: 10, now: () => clock, onExhaustion: event => waits.push(event),
    async sleep(ms) { assert.ok(lastSignal.aborted); delays.push(ms); await delay(30); clock += ms; },
  });
  const events = [];
  for await (const event of stream) events.push(event);
  assert.deepEqual(events.map(event => event.type), ['start', 'done']);
  assert.deepEqual(delays, [600_000, 600_000]);
  assert.equal(waits.length, 2);
  assert.equal(calls, 3);
});

test('capacity without reset details is rechecked with bounded backoff', async () => {
  const route = groupModels([model]).get('fixture')[0];
  const delays = [];
  let calls = 0;
  const provider = { async *infer() {
    if (++calls < 4) throw new ConnectError('capacity unavailable', Code.ResourceExhausted);
    yield { payload: JSON.stringify({ type: 'done', reason: 'stop', message: assistant([]) }) };
  } };
  const result = await streamProvider(provider, model.id, route.model, { messages: [] }, {}, {
    random: () => 1, sleep: async ms => delays.push(ms),
  }).result();
  assert.equal(result.stopReason, 'stop');
  assert.deepEqual(delays, [1000, 2000, 4000]);
});

test('cancellation interrupts retry backoff without starting another attempt', async () => {
  const route = groupModels([model]).get('fixture')[0];
  const controller = new AbortController();
  let calls = 0;
  const provider = { async *infer() { calls++; throw new ConnectError('connection lost', Code.Unavailable); } };
  const result = await streamProvider(provider, model.id, route.model, { messages: [] }, { signal: controller.signal }, {
    onRetry: () => controller.abort(new Error('operator cancelled')),
  }).result();
  assert.equal(result.stopReason, 'aborted');
  assert.equal(calls, 1);
});
