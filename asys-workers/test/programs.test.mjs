import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { Provider } from '@cyclo/provider/contract';
import { PreparedQueue as Queue } from '../../asys-runtime/test/fixtures.mjs';
import { HumanService } from '../../asys-human-interface/src/human-service.mjs';
import { humanServer } from '../../asys-human-interface/src/human-server.mjs';
import { assistant, conversationOf, model, systemPromptOf, toolsOf } from './helpers.mjs';
import { createPiAdapter } from '../../asys-inference/components/gateway/src/pi-adapter.mjs';
import { createPoolerServices } from '../../asys-inference/components/pooler/src/services.mjs';
import { parseArguments as poolArguments } from '../../asys-inference/components/pooler/src/config.mjs';
import { providerClient } from '../src/provider.mjs';

const executor = fileURLToPath(new URL('../../asys-runtime/tools/asys-runtime', import.meta.url));
const agentProgram = fileURLToPath(new URL('../tools/asys-agent', import.meta.url));
const humanProgram = fileURLToPath(new URL('../tools/asys-human', import.meta.url));
const goalProgram = fileURLToPath(new URL('../tools/asys-goal', import.meta.url));
const commandProgram = fileURLToPath(new URL('../tools/asys-program', import.meta.url));

async function until(fn) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() > deadline) throw new Error('Timed out waiting for worker');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function fixture(t, { agentArgs = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'asys-programs-'));
  const queue = new Queue(join(root, 'queue'));
  const environment = join(root, 'environment');
  await mkdir(join(environment, 'agents', 'test'), { recursive: true });
  const config = join(root, 'runtime.json');
  await writeFile(config, JSON.stringify({ version: 1, types: {
    agent: { command: [process.execPath, agentProgram, '--agent', 'test', ...agentArgs] },
    human: { command: [process.execPath, humanProgram] },
    goal: { command: [process.execPath, goalProgram] },
    program: { command: ['python3', commandProgram] },
  } }));
  let child, exited;
  const f = { root, queue, environment,
    start(env = {}) {
      child = spawn('python3', [executor, 'run', config, '--root', queue.root], { env: { ...process.env, ASYS_ENVIRONMENT_DIR: environment, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let errors = '';
      child.stderr.on('data', data => { errors += data; });
      exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal, errors }));
      });
    },
    async stop() {
      if (!child) return;
      child.kill('SIGTERM');
      const outcome = await exited;
      child = undefined;
      assert.equal(outcome.code, 0, outcome.errors);
    },
  };
  t.after(async () => { await f.stop(); await rm(root, { recursive: true, force: true }); });
  return f;
}

async function listen(t, server, path) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  t.after(async () => {
    server.closeConnections?.(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `unix://${path}`;
}

test('the worker configuration selects the Pi model and inference uses the unchanged Provider protocol', async t => {
  const f = await fixture(t, { agentArgs: ['--model', 'fixture/model'] });
  const requests = [];
  const server = createServer(connectNodeAdapter({ routes(router) { router.service(Provider, {
    listModels() { return { models: [model] }; },
    async *infer(request) {
      const frame = JSON.parse(request.payload);
      requests.push(frame);
      assert.equal(request.model, 'fixture/model');
      const message = requests.length === 1
        ? assistant([{ type: 'toolCall', id: 'proof', name: 'bash', arguments: { command: 'printf "executed by SDK" > proof.txt' } }], 'toolUse')
        : assistant([{ type: 'text', text: JSON.stringify({ final: 'Finished', exception: null }) }]);
      Object.assign(message, { provider: 'openai-codex', model: 'backend-model', api: 'openai-codex-responses' });
      yield { payload: JSON.stringify({ type: 'done', reason: message.stopReason, message }) };
    },
  }); } }));
  f.start({ DCOMP_IN_INFERENCE: await listen(t, server, join(f.root, 'provider.sock')) });
  await f.queue.submit('agent', 'research', { input: { prompt: 'Create the proof file' } });
  const state = await f.queue.wait('research', { timeoutMs: 10000 });
  assert.equal(state.status, 'done', state.error);
  assert.equal(state.result.final, 'Finished');
  assert.equal(Object.hasOwn(state.result, 'success'), false);
  assert.equal(await readFile(join(f.queue.workspace('research'), 'proof.txt'), 'utf8'), 'executed by SDK');
  assert.equal(requests.length, 2);
  assert.ok(requests[1].context.messages.some(m => m.role === 'toolResult' && m.toolCallId === 'proof'));
  assert.equal(requests[1].context.messages.find(m => m.role === 'assistant').provider, 'openai-codex');
});

test('the worker keeps inference pending through silence before and after partial output', async t => {
  const f = await fixture(t, { agentArgs: ['--model', 'fixture/model'] });
  let calls = 0;
  const server = createServer(connectNodeAdapter({ routes(router) { router.service(Provider, {
    listModels() { return { models: [model] }; },
    async *infer(_request, { signal }) {
      calls++;
      await delay(60, undefined, { signal });
      yield { payload: JSON.stringify({ type: 'start', partial: assistant([], 'pending') }) };
      await delay(60, undefined, { signal });
      yield { payload: JSON.stringify({ type: 'done', reason: 'stop',
        message: assistant([{ type: 'text', text: '{"final":"Finished waiting","exception":null}' }]) }) };
    },
  }); } }));
  f.start({ DCOMP_IN_INFERENCE: await listen(t, server, join(f.root, 'provider.sock')) });
  await f.queue.submit('agent', 'waiting', { input: { prompt: 'Wait for the result.' } });
  const state = await f.queue.wait('waiting', { timeoutMs: 10000 });
  assert.equal(state.status, 'done', state.error);
  assert.equal(state.result.final, 'Finished waiting');
  assert.equal(calls, 1);
});

for (const pooled of [false, true]) {
  for (const failure of ['silence', 'RPC disconnect', 'incomplete response', 'quota']) {
    test(`agent recovery through ${pooled ? 'a pooler' : 'a direct gateway'} survives ${failure} and preserves completed tools`, async t => {
      const selected = pooled ? 'pool/balanced' : model.id;
      const f = await fixture(t, { agentArgs: ['--model', selected] });
      const contexts = [], attempts = [];
      const adapter = createPiAdapter();
      let calls = 0;
      const route = {
        publicModel: model, provider: 'fixture', rawModel: { api: 'openai-responses' },
        credentialStore: { async read() { return { type: 'api_key', key: 'test-gateway-key' }; } },
        models: { async *streamSimple(_model, context, options) {
          contexts.push(structuredClone(context));
          attempts.push(options.signal);
          if (contexts.length === 2) {
            const partial = assistant([{ type: 'text', text: 'Abandoned partial response' }], 'pending');
            yield { type: 'start', partial };
            yield { type: 'text_delta', contentIndex: 0, delta: partial.content[0].text, partial };
            if (failure === 'incomplete response') {
              yield { type: 'error', reason: 'error', error: {
                ...assistant([{ type: 'toolCall', id: 'never-execute', name: 'bash', arguments: { command: 'printf BAD >> completed.txt' } }], 'error'),
                errorMessage: 'OpenAI Responses stream ended before a terminal response event',
              } };
              return;
            }
            if (failure === 'quota') {
              await options.onResponse({ status: 429, headers: { 'retry-after': '1' } });
              yield { type: 'error', reason: 'error', error: { ...assistant([], 'error'), errorMessage: 'rate limited' } };
              return;
            }
            await new Promise(() => {});
          }
          const message = contexts.length === 1
            ? assistant([{ type: 'toolCall', id: 'completed-once', name: 'bash', arguments: { command: 'printf x >> completed.txt' } }], 'toolUse')
            : assistant([{ type: 'text', text: '{"final":"Recovered at the caller","exception":null}' }]);
          yield { type: 'start', partial: assistant([], 'pending') };
          yield { type: 'done', reason: message.stopReason, message };
        } },
      };
      const handler = connectNodeAdapter({ routes(router) { router.service(Provider, {
        listModels() { return { models: [model, { ...model, id: 'other/model' }] }; },
        async *infer(request, { signal }) { yield* adapter.infer(route, request.payload, signal); },
      }); } });
      const server = createServer((request, response) => {
        if (request.url.endsWith('/Infer') && ++calls === 2 && failure === 'RPC disconnect') {
          const timer = setTimeout(() => response.destroy(), 50);
          response.once('close', () => clearTimeout(timer));
        }
        handler(request, response);
      });
      let endpoint = await listen(t, server, join(f.root, 'gateway.sock'));
      if (pooled) {
        const services = createPoolerServices({ componentName: 'pool',
          config: poolArguments([model.id, 'other/model', 'model=balanced']),
          upstream: { client: providerClient({ DCOMP_IN_INFERENCE: endpoint }),
            callOptions(signal, timeoutMs) { return { signal, ...(timeoutMs === undefined ? {} : { timeoutMs }) }; } },
        });
        const pool = createServer(connectNodeAdapter({ routes(router) { router.service(Provider, services.provider); } }));
        endpoint = await listen(t, pool, join(f.root, 'pool.sock'));
      }
      f.start({ DCOMP_IN_INFERENCE: endpoint, ASYS_INFERENCE_IDLE_TIMEOUT_MS: '150' });
      await f.queue.submit('agent', 'recovering', { input: { prompt: 'Perform the work and report the result.', maxSteps: 2 } });
      const state = await f.queue.wait('recovering', { timeoutMs: 10000 });
      assert.equal(state.status, 'done', state.error);
      assert.equal(state.result.final, 'Recovered at the caller');
      assert.equal(await readFile(join(f.queue.workspace('recovering'), 'completed.txt'), 'utf8'), 'x');
      assert.equal(calls, 3);
      assert.equal(contexts.length, 3);
      assert.deepEqual(contexts[1], contexts[2]);
      assert.ok(contexts[2].messages.some(message => message.role === 'toolResult' && message.toolCallId === 'completed-once'));
      assert.ok(attempts[1].aborted);
      const directory = f.queue.executionDirectory('recovering');
      const saved = JSON.parse(await readFile(join(directory, 'agent.json'), 'utf8'));
      assert.equal(saved.agent.steps, 2);
      const events = (await readFile(join(directory, 'stdout.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.ok(events.some(event => event.type === (failure === 'quota' ? 'agent.provider_exhausted' : 'agent.provider_retrying')));
    });
  }
}

test('the environment supplies agent memory; job data cannot replace the global system prompt', async t => {
  const f = await fixture(t, { agentArgs: ['--model', 'fixture/model'] });
  await writeFile(join(f.environment, 'agents/test/memory.md'), 'RETAINED_LESSON: Inspect the evidence.');
  const requests = [];
  const server = createServer(connectNodeAdapter({ routes(router) { router.service(Provider, {
    listModels() { return { models: [model] }; },
    async *infer(request) {
      requests.push(JSON.parse(request.payload));
      yield { payload: JSON.stringify({ type: 'done', reason: 'stop',
        message: assistant([{ type: 'text', text: '{"final":"Review finished","exception":null}' }]) }) };
    },
  }); } }));
  f.start({ DCOMP_IN_INFERENCE: await listen(t, server, join(f.root, 'provider.sock')) });
  const prompt = 'Inspect the deliverables.';
  await f.queue.submit('agent', 'review', { input: { prompt, system: 'JOB_DATA_MUST_NOT_CONFIGURE_SYSTEM_PROMPT', model: 'wrong/model' }, metadata: { actions: { version: 1, entries: [{ id: 'unexpected' }] } } });
  const state = await f.queue.wait('review', { timeoutMs: 10000 });
  assert.equal(state.status, 'done', state.error);
  const { context } = requests[0];
  assert.doesNotMatch(systemPromptOf(context), /JOB_DATA_MUST_NOT_CONFIGURE_SYSTEM_PROMPT|ASYS_RESULT/);
  assert.match(systemPromptOf(context), /RETAINED_LESSON/);
  assert.ok(!toolsOf(context).some(tool => ['list_actions', 'start_action', 'wait_action'].includes(tool.name)));
  const common = (await readFile(new URL('../src/system.md', import.meta.url), 'utf8')).trim();
  assert.ok(systemPromptOf(context).startsWith(common + '\n\n'));
  assert.deepEqual(conversationOf(context)[0].content, [{ type: 'text', text: prompt }]);
  assert.equal(await readFile(join(f.queue.executionDirectory('review'), '.pi/system-prompt.txt'), 'utf8'), systemPromptOf(context));
});

for (const limit of [undefined, 2]) {
  test(limit === undefined ? 'agents can finish after more than 32 steps without a configured limit'
    : 'an environment can explicitly limit agent inference steps', async t => {
    const f = await fixture(t, { agentArgs: ['--model', 'fixture/model',
      ...(limit === undefined ? [] : ['--max-steps', String(limit)])] });
    let requests = 0;
    const server = createServer(connectNodeAdapter({ routes(router) { router.service(Provider, {
      listModels() { return { models: [model] }; },
      async *infer() {
        requests++;
        const message = requests <= 33
          ? assistant([{ type: 'toolCall', id: `step-${requests}`, name: 'bash', arguments: { command: 'true' } }], 'toolUse')
          : assistant([{ type: 'text', text: '{"final":"Finished all steps","exception":null}' }]);
        yield { payload: JSON.stringify({ type: 'done', reason: message.stopReason, message }) };
      },
    }); } }));
    f.start({ DCOMP_IN_INFERENCE: await listen(t, server, join(f.root, 'provider.sock')) });
    await f.queue.submit('agent', 'long-job', { input: { prompt: 'Complete the assignment.' } });
    const state = await f.queue.wait('long-job', { timeoutMs: 20000 });
    if (limit === undefined) {
      assert.equal(state.status, 'done', state.error);
      assert.deepEqual(state.result, { final: 'Finished all steps', exception: null });
      assert.equal(requests, 34);
    } else {
      assert.equal(state.status, 'failed');
      assert.equal(requests, limit);
      assert.match(await readFile(join(f.queue.executionDirectory('long-job'), 'stderr.log'), 'utf8'), /exceeded 2 inference steps/);
    }
  });
}

for (const fields of [
  { approved: false, reason: 'Needs revision' },
  { success: false },
  { status: 'completed', artifacts: ['output/architecture.json'], exception: null },
  { exception: 'Required schematic is missing', report: 'Only architecture.json was supplied' },
]) {
  test(`final JSON preserves job-defined results: ${JSON.stringify(fields)}`, async t => {
    const f = await fixture(t, { agentArgs: ['--model', 'fixture/model'] });
    const result = { final: 'Review report.', exception: null, ...fields };
    const server = createServer(connectNodeAdapter({ routes(router) { router.service(Provider, {
      listModels() { return { models: [model] }; },
      async *infer(request) {
        assert.doesNotMatch(systemPromptOf(JSON.parse(request.payload).context), /approved|success\s*[:=]/);
        yield { payload: JSON.stringify({ type: 'done', reason: 'stop',
          message: assistant([{ type: 'text', text: JSON.stringify(result) }]) }) };
      },
    }); } }));
    f.start({ DCOMP_IN_INFERENCE: await listen(t, server, join(f.root, 'provider.sock')) });
    await f.queue.submit('agent', 'review', { input: { prompt: 'Review the supplied design.' } });
    const state = await f.queue.wait('review', { timeoutMs: 10000 });
    assert.equal(state.status, result.exception ? 'failed' : 'done', state.error);
    assert.equal(state.exit_code, result.exception ? 1 : 0);
    assert.deepEqual(state.result, result);
    if (result.exception) assert.equal(state.error, result.exception);
  });
}

test('retrying a failed agent starts the stage again with its original prompt and a fresh budget', async t => {
  const f = await fixture(t, { agentArgs: ['--model', 'fixture/model'] });
  const directory = f.queue.executionDirectory('layout');
  const firstResult = join(directory, 'result.json');
  const nextDirectory = f.queue.executionDirectory('layout-again');
  const nextResult = join(nextDirectory, 'result.json');
  const board = join(f.queue.workspace('layout'), 'partial-board.txt');
  const requests = [];
  const server = createServer(connectNodeAdapter({ routes(router) { router.service(Provider, {
    listModels() { return { models: [model] }; },
    async *infer(request) {
      const frame = JSON.parse(request.payload);
      requests.push(frame);
      const turn = requests.length;
      let message;
      if (turn === 1) message = assistant([
        { type: 'toolCall', id: 'board', name: 'write', arguments: { path: board, content: 'Partially routed board' } },
        { type: 'toolCall', id: 'failure', name: 'write', arguments: { path: firstResult, content: '{"exception":"Routing incomplete","old_field":"do not carry forward"}' } },
      ], 'toolUse');
      else if (turn === 2) message = assistant([{ type: 'text', text: '{"final":"Unable to finish routing","exception":"Routing incomplete","old_field":"do not carry forward"}' }]);
      else if (turn === 3) {
        assert.equal(conversationOf(frame.context).length, 1);
        assert.equal(conversationOf(frame.context)[0].role, 'user');
        assert.deepEqual(conversationOf(frame.context)[0].content, [{ type: 'text', text: 'Route the board.' }]);
        assert.doesNotMatch(systemPromptOf(frame.context), /ASYS_RESULT/);
        await assert.rejects(readFile(nextResult), { code: 'ENOENT' });
        message = assistant([{ type: 'toolCall', id: 'inspect', name: 'read', arguments: { path: board } }], 'toolUse');
      } else if (turn === 4) {
        assert.match(JSON.stringify(frame.context.messages.at(-1)), /Partially routed board/);
        message = assistant([{ type: 'toolCall', id: 'repaired', name: 'write', arguments: { path: nextResult, content: '{"exception":null,"report":"Routed"}' } }], 'toolUse');
      } else message = assistant([{ type: 'text', text: '{"final":"Routing finished","exception":null,"report":"Routed"}' }]);
      yield { payload: JSON.stringify({ type: 'done', reason: message.stopReason, message }) };
    },
  }); } }));
  f.start({ DCOMP_IN_INFERENCE: await listen(t, server, join(f.root, 'provider.sock')) });
  await f.queue.submit('agent', 'layout', { input: { prompt: 'Route the board.', maxSteps: 3 } });
  const failed = await f.queue.wait('layout', { timeoutMs: 10000 });
  assert.equal(failed.status, 'failed');
  const original = await readFile(firstResult, 'utf8');
  const transcript = join(directory, 'agent.json');
  const failedAgent = JSON.parse(await readFile(transcript, 'utf8'));
  await f.queue.resubmit('layout', 'layout-again');
  const retried = await f.queue.wait('layout-again', { timeoutMs: 10000 });
  assert.equal(retried.status, 'done', retried.error);
  assert.equal((await f.queue.state('layout')).status, 'failed');
  assert.equal(retried.result.report, 'Routed');
  assert.equal(retried.result.exception, null);
  assert.equal(retried.result.old_field, undefined);
  assert.equal(requests.length, 5);
  const restartedAgent = JSON.parse(await readFile(join(nextDirectory, 'agent.json'), 'utf8'));
  assert.equal(restartedAgent.agent.steps, 3);
  assert.notEqual(restartedAgent.agent.session.header.id, failedAgent.agent.session.header.id);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'agent.json'), 'utf8')), failedAgent);
  assert.equal(await readFile(firstResult, 'utf8'), original);
});

test('inference recovery discards an incomplete tool call without consuming an agent step', async t => {
  const f = await fixture(t, { agentArgs: ['--model', 'fixture/model'] });
  const directory = f.queue.executionDirectory('interrupted-write');
  const target = join(f.queue.workspace('interrupted-write'), 'unfinished.txt');
  const requests = [];
  const server = createServer(connectNodeAdapter({ routes(router) { router.service(Provider, {
    listModels() { return { models: [model] }; },
    async *infer(request) {
      const frame = JSON.parse(request.payload);
      requests.push(frame);
      if (requests.length === 1) {
        const message = { ...assistant([{ type: 'toolCall', id: 'unfinished-write', name: 'write',
          arguments: { path: target, content: 'Incomplete generation' } }], 'error'), errorMessage: 'terminated' };
        yield { payload: JSON.stringify({ type: 'error', reason: 'error', error: message }) };
      } else {
        assert.equal(conversationOf(frame.context).length, 1);
        assert.deepEqual(conversationOf(frame.context)[0].content, [{ type: 'text', text: 'Perform the original stage.' }]);
        yield { payload: JSON.stringify({ type: 'done', reason: 'stop', message: assistant([{ type: 'text', text: JSON.stringify({ final: 'Stage rerun.', exception: null }) }]) }) };
      }
    },
  }); } }));
  f.start({ DCOMP_IN_INFERENCE: await listen(t, server, join(f.root, 'provider.sock')) });
  await f.queue.submit('agent', 'interrupted-write', { input: { prompt: 'Perform the original stage.', maxSteps: 1 } });
  const result = await f.queue.wait('interrupted-write', { timeoutMs: 10000 });
  assert.equal(result.status, 'done', result.error);
  assert.equal(requests.length, 2);
  const saved = JSON.parse(await readFile(join(directory, 'agent.json'), 'utf8'));
  assert.equal(saved.agent.steps, 1);
  assert.ok(!saved.agent.session.entries.some(e => e.message?.role === 'assistant' && e.message.content.some(c => c.id === 'unfinished-write')));
  await assert.rejects(readFile(target), { code: 'ENOENT' });
});

test('an interrupted Pi job restarts the assignment without carrying its result forward', async t => {
  const f = await fixture(t, { agentArgs: ['--model', 'fixture/model'] });
  const resultPath = join(f.queue.executionDirectory('review'), 'result.json');
  const waiting = Promise.withResolvers();
  let requests = 0;
  const server = createServer(connectNodeAdapter({ routes(router) { router.service(Provider, {
    listModels() { return { models: [model] }; },
    async *infer(request, context) {
      if (++requests === 3) {
        const frame = JSON.parse(request.payload);
        assert.deepEqual(conversationOf(frame.context).map(m => m.content), [[{ type: 'text', text: 'Review the design.' }]]);
      }
      if (requests === 2) {
        waiting.resolve();
        await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
        return;
      }
      const message = requests === 1
        ? assistant([{ type: 'toolCall', id: 'decision', name: 'write', arguments: { path: resultPath, content: '{"approved":false}' } }], 'toolUse')
        : assistant([{ type: 'text', text: JSON.stringify({ final: 'The review requests revision.', exception: null }) }]);
      yield { payload: JSON.stringify({ type: 'done', reason: message.stopReason, message }) };
    },
  }); } }));
  const env = { DCOMP_IN_INFERENCE: await listen(t, server, join(f.root, 'provider.sock')) };
  f.start(env);
  await f.queue.submit('agent', 'review', { input: { prompt: 'Review the design.' } });
  await waiting.promise;
  await f.stop();
  assert.equal((await f.queue.state('review')).status, 'interrupted');
  f.start(env);
  await f.queue.resubmit('review', 'new-review');
  const state = await f.queue.wait('new-review', { timeoutMs: 10000 });
  assert.equal(state.status, 'done', state.error);
  assert.equal(state.attempt, undefined);
  assert.equal(state.result.approved, undefined, 'the interrupted job did not produce the current result');
  assert.equal(Object.hasOwn(state.result, 'success'), false);
  assert.equal(requests, 3);
  assert.equal(await readFile(resultPath, 'utf8'), '{"approved":false}');
});

for (const content of ['{invalid', 'null', '{"exception":""}', '{"exception":false}']) {
  test(`a persistently invalid agent result fails the job after correction: ${content}`, async t => {
    const f = await fixture(t, { agentArgs: ['--model', 'fixture/model'] });
    let requests = 0;
    const server = createServer(connectNodeAdapter({ routes(router) { router.service(Provider, {
      listModels() { return { models: [model] }; },
      async *infer() {
        requests++;
        const message = assistant([{ type: 'text', text: content }]);
        yield { payload: JSON.stringify({ type: 'done', reason: message.stopReason, message }) };
      },
    }); } }));
    f.start({ DCOMP_IN_INFERENCE: await listen(t, server, join(f.root, 'provider.sock')) });
    await f.queue.submit('agent', 'invalid', { input: { prompt: 'Return the result.' } });
    const state = await f.queue.wait('invalid', { timeoutMs: 10000 });
    assert.equal(state.status, 'failed');
    assert.equal(requests, 2);
    assert.equal(state.exit_code, 1);
    assert.equal(state.artifacts, undefined);
  });
}

for (const input of [
  { prompt: 'Review the board', request: 'Explicit prompt takes precedence', form: { type: 'boolean' } },
  { request: 'Review the board', form: { type: 'boolean' } },
]) {
test(`human jobs accept ${input.prompt ? 'prompt' : 'request'} and publish the answer into their own result file`, async t => {
  const f = await fixture(t);
  const service = new HumanService(join(f.root, 'human-service'));
  t.after(() => service.close());
  const target = await listen(t, humanServer(service), join(f.root, 'human.sock'));
  f.start({ DCOMP_IN_HUMAN: target, DCOMP_COMPONENT_NAME: 'workers' });
  await f.queue.submit('human', 'approval', { input, metadata: { purpose: 'PCB review' } });
  const task = await until(() => service.listTasks().tasks[0]);
  assert.equal(task.id, 'workers.approval');
  assert.deepEqual(JSON.parse(task.inputJson), { ...input, prompt: 'Review the board' });
  const metadata = JSON.parse(task.metadataJson);
  assert.equal(metadata.component, 'workers');
  assert.equal(metadata.purpose, 'PCB review');
  assert.deepEqual(metadata.files, { workspace: f.queue.workspace('approval') });
  const { token } = service.claimTask({ id: task.id, claimant: 'alice', claimId: 'claim' });
  service.completeTask({ id: task.id, token, completionId: 'answer', resultJson: 'false' });
  const outcome = await f.queue.wait('approval', { timeoutMs: 5000 });
  assert.equal(outcome.status, 'done', outcome.error);
  assert.equal(outcome.result, false);
  assert.equal(JSON.parse(await readFile(join(f.queue.executionDirectory('approval'), 'result.json'), 'utf8')), false);
});
}

for (const phase of ['implement', 'verify']) {
  for (const action of ['retry', 'stop', 'cancel']) {
    test(`one runtime goal job handles ${phase} help and human ${action}`, async t => {
      const f = await fixture(t);
      const models = join(f.root, 'models.json');
      await writeFile(models, JSON.stringify({ simple: model.id }));
      const counts = { implement: 0, verify: 0 };
      const service = new HumanService(join(f.root, 'human-service'));
      t.after(() => service.close());
      const provider = createServer(connectNodeAdapter({ routes(router) { router.service(Provider, {
        listModels() { return { models: [model] }; },
        async *infer(request) {
          assert.equal(request.model, model.id);
          const { context } = JSON.parse(request.payload);
          const data = JSON.parse(context.messages.at(-1).content[0].text.split('Assignment data:\n')[1]);
          const { phase: current } = data;
          assert.ok(Object.hasOwn(counts, current), 'goals start with implementation and use no contract phases');
          if (current === 'verify' || counts[current] === 0) {
            assert.equal(conversationOf(context).length, 1, 'verification remains fresh, including human retries');
          } else {
            assert.equal(conversationOf(context).length, 3, 'the implementation human retry retains its earlier conversation');
            assert.match(JSON.stringify(conversationOf(context)[1].content), /Input missing/);
          }
          if (counts[current] > 0) assert.equal(data.humanGuidance[0].answer.guidance, 'The input is now available.');
          const help = ++counts[current] === 1 && current === phase;
          const result = help
            ? { final: 'Checked the workspace. The required input is unavailable.', exception: 'Input missing', question: 'Please supply the input.' }
            : {
              implement: { final: 'Implementation finished.', exception: null, goal_status: 'review' },
              verify: { final: 'Inspected the required artifact.', exception: null, coverage: 'complete',
                criteria: [{ id: 'C1', requirement: 'Produce an artifact', basis: 'Original user request', status: 'satisfied',
                  evidence: [{ source: 'artifact.txt', observation: 'Inspected its complete contents.' }] }] },
            }[current];
          yield { payload: JSON.stringify({ type: 'done', reason: 'stop', message: assistant([{ type: 'text', text: JSON.stringify(result) }]) }) };
        },
      }); } }));
      f.start({ ASYS_SYSTEM_MODELS: models, DCOMP_COMPONENT_NAME: 'goal-workers',
        DCOMP_IN_INFERENCE: await listen(t, provider, join(f.root, 'provider.sock')),
        DCOMP_IN_HUMAN: await listen(t, humanServer(service), join(f.root, 'human.sock')) });
      await f.queue.submit('goal', 'design', { input: { goal: 'Produce an artifact', maxAttempts: 1 }, metadata: { run_id: 'test-run' } });
      const task = await until(() => service.listTasks().tasks[0]);
      assert.equal((await f.queue.state('design')).status, 'running');
      assert.deepEqual(await readdir(f.queue.jobs), ['design']);
      const metadata = JSON.parse(task.metadataJson);
      assert.equal(metadata.job_id, 'design');
      assert.equal(metadata.goal_phase, phase);
      assert.equal(metadata.run_id, 'test-run');
      assert.deepEqual(metadata.files, { workspace: f.queue.workspace('design') });
      const { token } = service.claimTask({ id: task.id, claimant: 'alice', claimId: 'claim' });
      if (action === 'cancel') await f.queue.cancel('design');
      else service.completeTask({ id: task.id, token, completionId: 'answer', resultJson: JSON.stringify({ action, guidance: 'The input is now available.' }) });
      const outcome = await f.queue.wait('design', { timeoutMs: 10000 });
      assert.equal(outcome.status, { retry: 'done', stop: 'failed', cancel: 'cancelled' }[action], outcome.error);
      if (action === 'retry') {
        assert.equal(outcome.result.verified, true);
        assert.equal(counts[phase], 2);
        const directory = f.queue.executionDirectory('design');
        const goalState = JSON.parse(await readFile(join(directory, 'goal.json'), 'utf8'));
        const retried = goalState.sessions.filter(session => session.phase === phase);
        assert.equal(retried.length, 2);
        const transcripts = await Promise.all(retried.map(session =>
          readFile(join(directory, session.directory, 'agent.json'), 'utf8').then(JSON.parse)));
        if (phase === 'implement') {
          assert.equal(transcripts[0].agent.session.header.id, transcripts[1].agent.session.header.id);
          assert.ok(transcripts[1].agent.sessionStartEntryCount > 0);
        } else assert.notEqual(transcripts[0].agent.session.header.id, transcripts[1].agent.session.header.id);
      } else if (action === 'stop') {
        assert.equal(outcome.result.verified, false);
        assert.equal(outcome.error, 'Stopped by human');
      } else await until(() => service.getTask({ id: task.id }).task.status === 'cancelled');
    });
  }
}

test('a runtime goal continues ordinary implementation turns and reviews only the explicit final claim', async t => {
  const f = await fixture(t);
  const models = join(f.root, 'models.json');
  await writeFile(models, JSON.stringify({ simple: model.id }));
  let implementations = 0, reviews = 0;
  const phases = [];
  const provider = createServer(connectNodeAdapter({ routes(router) { router.service(Provider, {
    listModels() { return { models: [model] }; },
    async *infer(request) {
      const { context } = JSON.parse(request.payload);
      const data = JSON.parse(context.messages.at(-1).content[0].text.split('Assignment data:\n')[1]);
      phases.push(data.phase);
      let result;
      if (data.phase === 'implement') {
        implementations++;
        assert.equal(reviews, 0, 'progress reports must not schedule a reviewer');
        assert.equal(conversationOf(context).length, implementations * 2 - 1);
        if (implementations > 1) assert.match(JSON.stringify(context.messages), /FIRST_PROGRESS_MARKER/);
        result = { final: implementations === 1 ? 'FIRST_PROGRESS_MARKER' : 'Further work performed.', exception: null,
          goal_status: implementations === 3 ? 'review' : 'continue' };
      } else {
        assert.equal(data.phase, 'verify');
        reviews++;
        assert.equal(conversationOf(context).length, 1);
        assert.doesNotMatch(JSON.stringify(context.messages), /FIRST_PROGRESS_MARKER/);
        result = { final: 'Observed the complete artifact.', exception: null, coverage: 'complete',
          criteria: [{ id: 'C1', requirement: 'Produce an artifact', basis: 'Original user request', status: 'satisfied',
            evidence: [{ source: 'artifact.txt', observation: 'All required contents are present.' }] }] };
      }
      yield { payload: JSON.stringify({ type: 'done', reason: 'stop',
        message: assistant([{ type: 'text', text: JSON.stringify(result) }]) }) };
    },
  }); } }));
  f.start({ ASYS_SYSTEM_MODELS: models,
    DCOMP_IN_INFERENCE: await listen(t, provider, join(f.root, 'provider.sock')) });
  await f.queue.submit('goal', 'continuing', { input: { goal: 'Produce an artifact', maxAttempts: 3 } });
  const outcome = await f.queue.wait('continuing', { timeoutMs: 10000 });
  assert.equal(outcome.status, 'done', outcome.error);
  assert.equal(outcome.result.verified, true);
  assert.equal(outcome.result.attempts, 3);
  assert.deepEqual(phases, ['implement', 'implement', 'implement', 'verify']);
  assert.equal(reviews, 1);
});

for (const corrected of [true, false]) {
  test(`a runtime goal ${corrected ? 'repairs' : 'rejects'} an invalid verification report without human escalation`, async t => {
    const f = await fixture(t);
    const models = join(f.root, 'models.json');
    await writeFile(models, JSON.stringify({ simple: model.id }));
    let implementations = 0, verifications = 0;
    const provider = createServer(connectNodeAdapter({ routes(router) { router.service(Provider, {
      listModels() { return { models: [model] }; },
      async *infer(request) {
        const { context } = JSON.parse(request.payload);
        assert.equal(conversationOf(context).length, 1, 'each verification correction is independent');
        const data = JSON.parse(conversationOf(context)[0].content[0].text.split('Assignment data:\n')[1]);
        let result;
        if (data.phase === 'implement') {
          implementations++;
          result = { final: 'Implementation ready for inspection.', exception: null, goal_status: 'review' };
        } else {
          assert.equal(data.phase, 'verify');
          verifications++;
          if (verifications === 2) {
            assert.match(data.correction.problem, /basis/);
            assert.equal(data.correction.previousResult.criteria[0].basis, undefined);
          }
          result = { final: 'Inspected artifact.txt.', exception: null, coverage: 'complete',
            criteria: [{ id: 'C1', requirement: 'Produce an artifact', status: 'satisfied',
              ...(corrected && verifications === 2 ? { basis: 'Original user request' } : {}),
              evidence: [{ source: 'artifact.txt', observation: 'The required artifact exists.' }] }] };
        }
        yield { payload: JSON.stringify({ type: 'done', reason: 'stop',
          message: assistant([{ type: 'text', text: JSON.stringify(result) }]) }) };
      },
    }); } }));
    f.start({ ASYS_SYSTEM_MODELS: models,
      DCOMP_IN_INFERENCE: await listen(t, provider, join(f.root, 'provider.sock')) });
    await f.queue.submit('goal', 'invalid-review', { input: { goal: 'Produce an artifact', maxAttempts: 1 } });
    const outcome = await f.queue.wait('invalid-review', { timeoutMs: 10000 });
    assert.equal(outcome.status, corrected ? 'done' : 'failed', outcome.error);
    assert.equal(outcome.result.verified, corrected);
    assert.equal(implementations, 1);
    assert.equal(verifications, 2, 'phase protocol gets exactly one corrective session');
    if (!corrected) assert.match(outcome.error, /basis/);
  });
}

test('program jobs execute a supplied command, preserve input, and propagate failures', async t => {
  const f = await fixture(t);
  f.start();
  const code = 'import json,os,sys; json.dump({"input":json.load(sys.stdin),"args":sys.argv[1:]},open(os.environ["ASYS_RESULT"],"w"))';
  await f.queue.submit('program', 'command', { args: ['python3', '-c', code, 'literal spaces', '$(no-shell)'], input: { value: 42 } });
  const outcome = await f.queue.wait('command', { timeoutMs: 5000 });
  assert.equal(outcome.status, 'done', outcome.error);
  assert.deepEqual(outcome.result, { input: { value: 42 }, args: ['literal spaces', '$(no-shell)'] });
  await f.queue.submit('program', 'empty');
  assert.equal((await f.queue.wait('empty', { timeoutMs: 5000 })).status, 'failed');
  await f.queue.submit('program', 'failure', { args: ['python3', '-c', 'raise SystemExit(17)'] });
  assert.equal((await f.queue.wait('failure', { timeoutMs: 5000 })).exit_code, 17);
});

test('cancelling a job withdraws its human decision and rejects late completion', async t => {
  const f = await fixture(t);
  const service = new HumanService(join(f.root, 'human-service'));
  t.after(() => service.close());
  const target = await listen(t, humanServer(service), join(f.root, 'cancel.sock'));
  f.start({ DCOMP_IN_HUMAN: target, DCOMP_COMPONENT_NAME: 'workers' });
  await f.queue.submit('human', 'cancelled', { input: { prompt: 'Wait for me' } });
  const task = await until(() => service.listTasks().tasks[0]);
  const { token } = service.claimTask({ id: task.id, claimant: 'alice', claimId: 'claim' });
  await f.queue.cancel('cancelled');
  assert.equal((await f.queue.wait('cancelled', { timeoutMs: 5000 })).status, 'cancelled');
  await until(() => service.getTask({ id: task.id }).task.status === 'cancelled');
  assert.throws(() => service.completeTask({ id: task.id, token, completionId: 'decision', resultJson: 'true' }), /no longer waiting/);
});
