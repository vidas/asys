import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTestAgent as runAgent, toolsOf } from './helpers.mjs';
import { assistant, model } from './helpers.mjs';
import { createResourceExhaustedError } from '@cyclo/provider/errors';

async function fixture(t, { stopReason = 'length', rounds = 1, maxSteps = 12 } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'asys-agent-recovery-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const f = { job: { id: 'recover' }, requests: [], events: [], toolCalls: 0, agentCalls: 0,
    summaryError: false, onSummary() {}, onEvent() {}, controller: new AbortController() };
  function message(content, reason = 'stop') {
    return { ...assistant(content, reason), api: 'openai-codex-responses',
      provider: 'openai-codex', model: 'backend-model' };
  }
  const provider = {
    async listModels() { return { models: [{ ...model, id: 'account/alias' }] }; },
    async *infer(request, { signal }) {
      assert.equal(request.model, 'account/alias');
      const frame = JSON.parse(request.payload);
      f.requests.push(frame);
      let reply;
      if (!toolsOf(frame.context).length) {
        f.onSummary();
        signal.throwIfAborted();
        reply = message([{ type: 'text', text: JSON.stringify({ final: 'The large tool output has been inspected. Continue the task.', exception: null }) }]);
        if (f.summaryError) { reply.stopReason = 'error'; reply.errorMessage = typeof f.summaryError === 'string' ? f.summaryError : 'Summary provider unavailable'; }
      } else {
        f.agentCalls++;
        if (f.agentCalls > rounds * 2) reply = message([{ type: 'text', text: JSON.stringify({ final: 'Finished after recovery', exception: null }) }]);
        else if (f.agentCalls % 2) reply = message([{ type: 'toolCall', id: `context-${f.agentCalls}`, name: 'produce_context', arguments: {} }], 'toolUse');
        else {
          reply = message([], stopReason);
          reply.usage = { ...reply.usage, input: 99000, totalTokens: 99010 };
          if (stopReason === 'error') reply.errorMessage = 'maximum context length exceeded';
        }
      }
      yield { payload: JSON.stringify(reply.stopReason === 'error'
        ? { type: 'error', reason: 'error', error: reply }
        : { type: 'done', reason: reply.stopReason, message: reply }) };
    },
  };
  f.run = () => runAgent({ config: { model: 'account/alias', prompt: 'Perform the task.', maxSteps, options: {} },
    job: f.job, workspace, signal: f.controller.signal, provider,
    save() { f.saved = structuredClone(f.job); },
    event(type, data) { f.events.push({ type, ...data }); f.onEvent(type, data); },
    customTools: [{ name: 'produce_context', label: 'Produce context', description: 'Test context producer',
      parameters: { type: 'object', properties: {} },
      async execute() { f.toolCalls++; return { content: [{ type: 'text', text: 'Test data '.repeat(12000) }] }; },
    }],
  });
  return f;
}

for (const stopReason of ['length', 'error']) {
  test(`an aliased provider recovers from ${stopReason} using Pi's built-in compaction`, async t => {
    const f = await fixture(t, { stopReason, rounds: 2 });
    const result = await f.run();
    assert.equal(result.final, 'Finished after recovery');
    assert.equal(f.saved.agent.steps, 7);
    assert.equal(f.toolCalls, 2, 'completed tools must not be replayed');
    assert.equal(f.saved.agent.session.entries.filter(e => e.type === 'compaction').length, 2);
    const compactions = f.events.filter(e => e.type === 'agent.compaction_ended');
    assert.equal(compactions.length, 2);
    assert.ok(compactions.every(e => e.willRetry && !e.aborted && !e.errorMessage));
    for (const frame of f.requests) {
      for (const message of frame.context.messages.filter(m => m.role === 'assistant')) {
        assert.equal(message.provider, 'openai-codex');
        assert.equal(message.model, 'backend-model');
        assert.equal(message.api, 'openai-codex-responses');
      }
    }
  });
}

test('a failed compaction cannot turn the preceding tool call into a successful job result', async t => {
  const f = await fixture(t);
  f.summaryError = true;
  await assert.rejects(f.run(), /Summary provider unavailable/);
  assert.equal(f.agentCalls, 2);
  assert.ok(f.events.some(e => e.type === 'agent.compaction_ended' && e.errorMessage));
});

test('the inference client retries a terminated compaction and continues the agent with completed tools intact', async t => {
  const f = await fixture(t);
  let summaries = 0;
  f.onSummary = () => { f.summaryError = ++summaries === 1 ? 'terminated' : false; };
  const result = await f.run();
  assert.equal(result.final, 'Finished after recovery');
  assert.equal(f.saved.agent.steps, 4);
  assert.equal(summaries, 2);
  assert.equal(f.toolCalls, 1);
  assert.ok(f.events.some(e => e.type === 'agent.provider_retrying' && /terminated/.test(e.errorMessage)));
  assert.ok(f.events.some(e => e.type === 'agent.compaction_ended' && e.willRetry && !e.errorMessage));
});

test('compaction recovery respects the inference step budget', async t => {
  const f = await fixture(t, { maxSteps: 3 });
  await assert.rejects(f.run(), /exceeded 3 inference steps/);
  assert.equal(f.requests.length, 3);
});

test('cancellation during compaction stops the job without declaring success', async t => {
  const f = await fixture(t);
  f.onSummary = () => f.controller.abort(new Error('Stopped during compaction'));
  await assert.rejects(f.run(), /Stopped during compaction/);
  assert.equal(f.agentCalls, 2);
  assert.ok(!f.saved.agent.session.entries.some(e => e.type === 'compaction'));
});

test('the agent waits through provider exhaustion and then finishes', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'asys-agent-exhausted-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const events = [];
  let calls = 0;
  const provider = {
    async listModels() { return { models: [model] }; },
    async *infer(_request, { signal }) {
      calls++;
      assert.equal(signal.aborted, false);
      if (calls === 1) throw createResourceExhaustedError(new Date(Date.now() + 1_100));
      yield { payload: JSON.stringify({ type: 'done', reason: 'stop', message: assistant([{ type: 'text', text: JSON.stringify({ final: 'Finished after the limit reset', exception: null }) }]) }) };
    },
  };
  const result = await runAgent({
    config: { model: 'fixture/model', prompt: 'Perform the task.', maxSteps: 3, options: {} },
    job: { id: 'exhausted' }, workspace, signal: new AbortController().signal,
    provider, save() {}, event(type, data) { events.push({ type, ...data }); },
  });
  assert.equal(result.final, 'Finished after the limit reset');
  assert.equal(calls, 2, 'the provider replay succeeds');
  const waits = events.filter(e => e.type === 'agent.provider_exhausted');
  assert.equal(waits.length, 1);
  assert.ok(Date.parse(waits[0].retryAt) > Date.now() - 5_000);
  assert.ok(waits[0].delayMs >= 1_000);
  const retry = events.findIndex(e => e.type === 'agent.provider_retrying');
  assert.ok(retry > events.findIndex(e => e.type === 'agent.provider_exhausted'),
    'observers must see the agent leave exhaustion when the provider request is retried');
});
