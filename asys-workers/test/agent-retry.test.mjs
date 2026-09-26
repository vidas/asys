import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Code, ConnectError } from '@connectrpc/connect';
import { runTestAgent as runAgent } from './helpers.mjs';
import { assistant, model } from './helpers.mjs';

const response = event => ({ payload: JSON.stringify(event) });
const failure = () => ({ ...assistant([{ type: 'thinking', thinking: 'Integrating the circuit.' }], 'error'), errorMessage: 'terminated' });

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'asys-agent-retry-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const f = { workspace, calls: 0, events: [], controller: new AbortController(), job: { id: 'integrate' }, onEvent() {} };
  const provider = {
    async listModels() { return { models: [model] }; },
    async *infer(request) { yield* f.infer(JSON.parse(request.payload), ++f.calls); },
  };
  f.provider = provider;
  f.run = ({ maxSteps = 8 } = {}) => runAgent({
    config: { model: 'fixture/model', prompt: 'Integrate the circuit.', maxSteps, options: {} },
    job: f.job, workspace, signal: f.controller.signal,
    provider, save() {},
    event(type, data) { f.events.push({ type, ...data }); f.onEvent(type, data); },
    customTools: [{ name: 'prepare', label: 'Prepare', description: 'Prepare the input once',
      parameters: { type: 'object', properties: {} },
      async execute() {
        await appendFile(join(workspace, 'prepared.txt'), 'prepared\n');
        return { content: [{ type: 'text', text: 'Input prepared.' }] };
      },
    }],
  });
  return f;
}

test('catalogue socket reset at agent startup recovers before the first inference', async t => {
  const f = await fixture(t);
  let calls = 0;
  f.provider.listModels = async (_request, { signal, timeoutMs }) => {
    assert.equal(signal, f.controller.signal);
    assert.equal(timeoutMs, 10000);
    if (++calls === 1) throw new ConnectError('socket hang up', Code.Aborted);
    return { models: [model] };
  };
  f.infer = async function* () {
    yield response({ type: 'done', reason: 'stop', message: assistant([
      { type: 'text', text: JSON.stringify({ final: 'Catalogue recovered.', exception: null }) },
    ]) });
  };
  assert.equal((await f.run({ maxSteps: 1 })).final, 'Catalogue recovered.');
  assert.equal(calls, 2);
  assert.equal(f.calls, 1);
  const retry = f.events.find(event => event.type === 'agent.provider_retrying');
  assert.equal(retry.operation, 'list_models');
  assert.equal(retry.attempt, 1);
  assert.match(retry.errorMessage, /socket hang up/);
  assert.ok(Number.isFinite(Date.parse(retry.retryAt)));
});

test('permanent catalogue failure never starts inference', async t => {
  const f = await fixture(t);
  const failure = new ConnectError('catalogue access denied', Code.PermissionDenied);
  let calls = 0;
  f.provider.listModels = async () => { calls++; throw failure; };
  await assert.rejects(f.run(), error => error === failure);
  assert.equal(calls, 1);
  assert.equal(f.calls, 0);
  assert.ok(!f.events.some(event => event.type === 'agent.provider_retrying'));
});

test('cancellation during catalogue retry backoff prevents another RPC or inference', async t => {
  const f = await fixture(t);
  let calls = 0;
  f.provider.listModels = async () => { calls++; throw new ConnectError('socket hang up', Code.Aborted); };
  f.onEvent = (type, data) => {
    if (type === 'agent.provider_retrying' && data.operation === 'list_models') {
      queueMicrotask(() => f.controller.abort(new Error('Cancelled during catalogue retry')));
    }
  };
  await assert.rejects(f.run(), /Cancelled during catalogue retry/);
  assert.equal(calls, 1);
  assert.equal(f.calls, 0);
});

test('the inference client retries a terminated response after partial output without repeating completed tools', async t => {
  const f = await fixture(t);
  f.infer = async function* (frame, attempt) {
    if (attempt === 1) {
      yield response({ type: 'done', reason: 'toolUse', message: assistant([
        { type: 'toolCall', id: 'prepare-once', name: 'prepare', arguments: {} },
      ], 'toolUse') });
    } else if (attempt === 2) {
      const partial = assistant([{ type: 'thinking', thinking: 'Integrating the circuit.' }]);
      yield response({ type: 'start', partial });
      yield response({ type: 'thinking_delta', contentIndex: 0, delta: 'Integrating the circuit.', partial });
      yield response({ type: 'error', reason: 'error', error: failure() });
    } else {
      assert.equal(attempt, 3);
      assert.equal(frame.context.messages.filter(m => m.role === 'toolResult' && m.toolCallId === 'prepare-once').length, 1);
      assert.ok(!frame.context.messages.some(m => m.role === 'assistant' && m.stopReason === 'error'));
      yield response({ type: 'done', reason: 'stop', message: assistant([{ type: 'text', text: JSON.stringify({ final: 'Integration completed.', exception: null }) }]) });
    }
  };
  const result = await f.run();
  assert.equal(result.final, 'Integration completed.');
  assert.equal(f.job.agent.steps, 2);
  assert.equal(f.calls, 3);
  assert.equal(await readFile(join(f.workspace, 'prepared.txt'), 'utf8'), 'prepared\n');
  assert.ok(f.events.some(e => e.type === 'agent.message_delta' && e.kind === 'thinking'));
  const retry = f.events.find(e => e.type === 'agent.provider_retrying');
  assert.equal(retry?.attempt, 1);
  assert.equal(retry.maxAttempts, undefined);
  assert.ok(retry.delayMs >= 500 && retry.delayMs <= 1000);
  assert.match(retry.errorMessage, /terminated/);
});

test('persistent transient failures keep the logical call pending until cancellation', async t => {
  const f = await fixture(t);
  f.infer = async function* () { yield response({ type: 'error', reason: 'error', error: failure() }); };
  f.onEvent = (type, data) => {
    if (type === 'agent.provider_retrying' && data.attempt === 4) f.controller.abort(new Error('Stop repeated retries'));
  };
  await assert.rejects(f.run({ maxSteps: 1 }), /Stop repeated retries/);
  assert.equal(f.calls, 4);
  assert.equal(f.job.agent.steps, 1);
});

test('cancelling a job interrupts inference retry backoff without another inference call', async t => {
  const f = await fixture(t);
  f.infer = async function* () { yield response({ type: 'error', reason: 'error', error: failure() }); };
  f.onEvent = type => {
    if (type === 'agent.provider_retrying') queueMicrotask(() => f.controller.abort(new Error('Job cancelled during retry')));
  };
  await assert.rejects(f.run(), /Job cancelled during retry/);
  assert.equal(f.calls, 1);
});

test('completion correction preserves a reported blocker and task-specific fields', async t => {
  const f = await fixture(t);
  const blocked = { exception: 'Missing board specification', question: 'Which board revision should I use?' };
  f.infer = async function* (_frame, attempt) {
    const result = attempt === 1 ? blocked : { ...blocked, final: 'Inspected the inputs; the board revision is unspecified.' };
    yield response({ type: 'done', reason: 'stop', message: assistant([{ type: 'text', text: JSON.stringify(result) }]) });
  };
  const result = await f.run();
  assert.equal(result.exception, blocked.exception);
  assert.equal(result.question, blocked.question);
  assert.equal(f.calls, 2);
  assert.equal(f.events.filter(e => e.type === 'agent.result_correcting').length, 1);
});

test('completion correction stops after one unsuccessful retry', async t => {
  const f = await fixture(t);
  f.infer = async function* () {
    yield response({ type: 'done', reason: 'stop', message: assistant([{ type: 'text', text: '{invalid' }]) });
  };
  await assert.rejects(f.run(), /Agent final response must be a JSON object/);
  assert.equal(f.calls, 2);
  assert.equal(f.events.filter(e => e.type === 'agent.result_correcting').length, 1);
});

test('completion correction respects the inference step budget', async t => {
  const f = await fixture(t);
  f.infer = async function* () {
    yield response({ type: 'done', reason: 'stop', message: assistant([{ type: 'text', text: '{}' }]) });
  };
  await assert.rejects(f.run({ maxSteps: 1 }), /exceeded 1 inference steps/);
  assert.equal(f.calls, 1);
});

test('cancellation before completion correction prevents another inference call', async t => {
  const f = await fixture(t);
  f.infer = async function* () {
    yield response({ type: 'done', reason: 'stop', message: assistant([{ type: 'text', text: '{}' }]) });
  };
  f.onEvent = type => {
    if (type === 'agent.result_correcting') f.controller.abort(new Error('Cancelled before correction'));
  };
  await assert.rejects(f.run(), /Cancelled before correction/);
  assert.equal(f.calls, 1);
});

test('execution errors are not treated as completion format errors', async t => {
  const f = await fixture(t);
  f.infer = async function* () {
    const error = { ...assistant([{ type: 'text', text: '{invalid' }], 'error'), errorMessage: 'Model does not support this request' };
    yield response({ type: 'error', reason: 'error', error });
  };
  await assert.rejects(f.run(), /Model does not support this request/);
  assert.equal(f.calls, 1);
  assert.equal(f.events.filter(e => e.type === 'agent.result_correcting').length, 0);
});
