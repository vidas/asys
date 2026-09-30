import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Code, ConnectError } from '@connectrpc/connect';
import { senate } from '../src/senate.mjs';
import { assistant, model, systemPromptOf, toolsOf } from './helpers.mjs';

const configuration = () => ({ version: 1, princeps: { name: 'Cicero', prompt: 'CHAIR_PERSONA' },
  senators: [{ name: 'Cato', prompt: 'CAUTIOUS_PERSONA' }, { name: 'Caesar', prompt: 'AMBITIOUS_PERSONA' }] });
const assignment = context => JSON.parse(context.job.input.prompt.split('Assignment data:\n')[1]);
const label = data => `${data.phase}:${data.round}:${data.participant}`;
const response = (data, consensus = true) => ({ final: label(data), exception: null,
  ...(data.phase === 'assess' ? { consensus } : {}) });
const firstRound = ['introduce:0:Cicero', 'intervene:1:Cato', 'intervene:1:Caesar', 'assess:1:Cicero'];
const allRounds = [...firstRound, ...[2, 3].flatMap(round =>
  [`intervene:${round}:Cato`, `intervene:${round}:Caesar`, `assess:${round}:Cicero`]), 'decide:3:Cicero'];

async function fixture(t, input = {}) {
  const root = await mkdtemp(join(tmpdir(), 'asys-senate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'job'), workspace = join(root, 'workspace'), environment = join(root, 'environment');
  for (const path of [directory, workspace, environment]) await mkdir(path);
  await mkdir(join(environment, 'agents/simple'), { recursive: true });
  await writeFile(join(environment, 'agents/simple/prompt.md'), 'UNSELECTED_ENVIRONMENT_PERSONA');
  const models = join(root, 'models.json');
  await writeFile(models, JSON.stringify({ simple: model.id }));
  const controller = new AbortController(), events = [];
  const context = { job: { id: 'senate-test', directory, workspace, result: join(directory, 'result.json'),
    input: { topic: 'Choose a design for the aqueduct.', senate: configuration(), ...input } }, argv: [],
    env: { ASYS_ENVIRONMENT_DIR: environment, ASYS_SYSTEM_MODELS: models }, signal: controller.signal };
  return { root, directory, workspace, environment, models, controller, context, events,
    run(dependencies = {}) { return senate(context, { event: (type, data) => events.push({ type, ...data }), ...dependencies }); },
    state: () => readFile(join(directory, 'senate.json'), 'utf8').then(JSON.parse),
  };
}

test('the princeps introduces once, senators speak in order, and consensus returns one answer', async t => {
  const f = await fixture(t), calls = [], history = [], sessions = new Map();
  const result = await f.run({ async executeAgent(context, options) {
    const data = assignment(context);
    calls.push(label(data));
    assert.equal(data.topic, f.context.job.input.topic);
    assert.deepEqual(data.transcript, history, 'each speaker sees every preceding completed contribution in order');
    assert.equal(context.job.workspace, f.workspace);
    assert.deepEqual(context.argv, ['--agent', 'simple', '--model', model.id]);
    const participant = [f.context.job.input.senate.princeps, ...f.context.job.input.senate.senators]
      .find(participant => participant.name === data.participant);
    assert.ok(options.definition.prompt.includes(participant.prompt));
    assert.doesNotMatch(options.definition.prompt, /UNSELECTED_ENVIRONMENT_PERSONA/);
    const previous = sessions.get(data.participant);
    if (previous) assert.equal(options.sessionFile, previous, 'participants continue their own conversation');
    sessions.set(data.participant, options.sessionFile);
    const result = response(data);
    history.push({ phase: data.phase, round: data.round, participant: data.participant,
      final: result.final, ...(data.phase === 'assess' ? { consensus: true } : {}) });
    return result;
  } });
  assert.deepEqual(calls, firstRound);
  assert.equal(result.final, 'assess:1:Cicero');
  assert.equal(result.exception, null);
  assert.equal(result.consensus, true);
  assert.equal(result.rounds, 1);
  assert.equal(result.decision, 'consensus');
  assert.deepEqual([...sessions.values()], ['princeps', 'senator-1', 'senator-2'].map(name =>
    join(f.directory, 'participants', name, 'session.jsonl')));
  const state = await f.state();
  assert.equal(state.status, 'completed');
  assert.deepEqual(state.transcript, history);
  assert.deepEqual(await f.run({ executeAgent() { assert.fail('a completed senate must only replay its answer'); } }), result);
});

test('canonical request supplies a topic with the existing explicit Senate configuration', async t => {
  const f = await fixture(t, { topic: undefined, request: 'Choose a design for the aqueduct.' });
  const result = await f.run({ async executeAgent(context) {
    const data = assignment(context);
    assert.equal(data.topic, 'Choose a design for the aqueduct.');
    return response(data);
  } });
  assert.equal(result.consensus, true);
});

test('consensus can be reached in a later round without another introduction or a deciding turn', async t => {
  const f = await fixture(t), calls = [];
  const result = await f.run({ async executeAgent(context) {
    const data = assignment(context);
    calls.push(label(data));
    if (data.round === 2 && data.participant === 'Cato') {
      assert.equal(data.transcript.at(-1).phase, 'assess');
      assert.equal(data.transcript.at(-1).consensus, false);
    }
    return response(data, data.round === 2);
  } });
  assert.deepEqual(calls, allRounds.slice(0, 7));
  assert.equal(result.final, 'assess:2:Cicero');
  assert.equal(result.consensus, true);
  assert.equal(result.rounds, 2);
  assert.equal(result.decision, 'consensus');
});

test('three unsuccessful rounds lead to one distinct princeps decision', async t => {
  const f = await fixture(t), calls = [];
  const result = await f.run({ async executeAgent(context) {
    const data = assignment(context);
    calls.push(label(data));
    if (data.phase === 'decide') {
      assert.equal(data.transcript.filter(item => item.phase === 'assess').length, 3);
      assert.equal(data.transcript.at(-1).consensus, false);
    }
    return response(data, false);
  } });
  assert.deepEqual(calls, allRounds);
  assert.equal(result.final, 'decide:3:Cicero');
  assert.equal(result.exception, null);
  assert.equal(result.consensus, false);
  assert.equal(result.rounds, 3);
  assert.equal(result.decision, 'princeps');
});

test('consensus in the third round completes without a deciding turn', async t => {
  const f = await fixture(t), calls = [];
  const result = await f.run({ async executeAgent(context) {
    const data = assignment(context);
    calls.push(label(data));
    return response(data, data.round === 3);
  } });
  assert.deepEqual(calls, allRounds.slice(0, -1));
  assert.equal(result.final, 'assess:3:Cicero');
  assert.equal(result.consensus, true);
  assert.equal(result.rounds, 3);
  assert.equal(result.decision, 'consensus');
});

for (const decision of ['consensus', 'princeps']) {
  test(`the ${decision} answer preserves structured results and authoritative Senate metadata`, async t => {
    const f = await fixture(t);
    const verdict = { approved: false, reason: 'The numerical reference check failed.',
      findings: [{ criterion: 'uncertainty', observed: 0, expected: 0.25 }],
      artifacts: ['check.json'], optional: null };
    const result = await f.run({ async executeAgent(context) {
      const data = assignment(context);
      const terminal = decision === 'consensus' ? data.phase === 'assess' : data.phase === 'decide';
      if (!terminal) return { ...response(data, false), preliminary: 'Do not export intermediate fields.', approved: true };
      return { ...response(data), ...verdict, consensus: true, rounds: 99, decision: 'invented' };
    } });
    assert.deepEqual(result, { final: `${decision === 'consensus' ? 'assess:1' : 'decide:3'}:Cicero`,
      exception: null, ...verdict, consensus: decision === 'consensus',
      rounds: decision === 'consensus' ? 1 : 3, decision });
    assert.deepEqual((await f.state()).result, result, 'checkpoint retains structured fields');
    assert.deepEqual(await f.run({ executeAgent() { assert.fail('completed structured result must replay unchanged'); } }), result);
  });
}

test('participant models take precedence over the launch model and selected environment agents retain their persona', async t => {
  const config = configuration();
  config.princeps.model = 'fixture/chair';
  config.senators[0] = { ...config.senators[0], agent: 'engineer', model: 'fixture/engineer' };
  const f = await fixture(t, { senate: config });
  await mkdir(join(f.environment, 'agents/engineer'), { recursive: true });
  await writeFile(join(f.environment, 'agents/engineer/prompt.md'), 'ENVIRONMENT_ENGINEER_PERSONA');
  await writeFile(join(f.environment, 'agents/engineer/memory.md'), 'ENGINEER_MEMORY');
  const overlay = join(f.root, 'workers-overlay');
  await mkdir(overlay);
  f.context.env.ASYS_WORKERS_DIR = overlay;
  await writeFile(f.models, '{}');
  f.context.argv = ['--model', 'fixture/default'];
  const seen = new Map();
  const result = await f.run({ async executeAgent(context, options) {
    const data = assignment(context);
    seen.set(data.participant, context.argv);
    if (data.participant === 'Cato') {
      assert.match(options.definition.prompt, /ENVIRONMENT_ENGINEER_PERSONA/);
      assert.match(options.definition.prompt, /CAUTIOUS_PERSONA/);
      assert.equal(options.definition.memory, 'ENGINEER_MEMORY');
    }
    return response(data);
  } });
  assert.equal(result.exception, null);
  assert.deepEqual(seen.get('Cicero'), ['--agent', 'simple', '--model', 'fixture/chair']);
  assert.deepEqual(seen.get('Cato'), ['--agent', 'engineer', '--model', 'fixture/engineer']);
  assert.deepEqual(seen.get('Caesar'), ['--agent', 'simple', '--model', 'fixture/default']);
});

test('fully specified participant models do not require a system model default', async t => {
  const config = configuration();
  for (const participant of [config.princeps, ...config.senators]) participant.model = model.id;
  const f = await fixture(t, { senate: config });
  await writeFile(f.models, '{}');
  assert.equal((await f.run({ async executeAgent(context) { return response(assignment(context)); } })).exception, null);
});

test('invalid senate descriptions and worker arguments fail before any participant starts', async t => {
  const invalid = [
    { topic: '' }, { topic: 42 }, { senate: null }, { senate: [] },
    { senate: { ...configuration(), version: 2 } },
    { senate: { ...configuration(), senators: [] } },
    { senate: { ...configuration(), senators: [{ name: 'Cicero' }] } },
    { senate: { ...configuration(), senators: [{ name: 'Cato' }, { name: 'Cato' }] } },
    { senate: { ...configuration(), senators: [{ name: '' }] } },
    { senate: { ...configuration(), senators: [{ name: 'Cato', model: '' }] } },
    { senate: { ...configuration(), senators: [{ name: 'Cato', agent: '../other' }] } },
    { senate: { ...configuration(), senators: [{ name: 'Cato', prompt: 4 }] } },
    { senate: { ...configuration(), questor: { name: 'Unwanted role' } } },
    { senate: { ...configuration(), princeps: { name: 'Cicero', unknown: true } } },
    { senate: { ...configuration(), senators: [{ name: 'Cato', unknown: true }] } },
  ];
  for (const input of invalid) {
    const f = await fixture(t, input);
    await assert.rejects(f.run({ executeAgent() { assert.fail('invalid configuration must not launch inference'); } }));
  }
  for (const argv of [['--max-rounds', '4'], ['unrecognized topic'], ['--agent', 'simple']]) {
    const f = await fixture(t);
    f.context.argv = argv;
    await assert.rejects(f.run({ executeAgent() { assert.fail('invalid arguments must not launch inference'); } }));
  }
});

test('an assessment must contain a strict consensus boolean and gets only one correction', async t => {
  for (const consensus of [undefined, null, 'true', 'false', 0, 1]) {
    const f = await fixture(t), calls = [], files = [];
    const result = await f.run({ async executeAgent(context, options) {
      const data = assignment(context);
      calls.push(label(data));
      if (data.phase !== 'assess') return response(data);
      files.push(options.sessionFile);
      if (files.length === 2) assert.match(data.correction.problem, /consensus/);
      return { ...response(data), consensus };
    } });
    assert.deepEqual(calls, [...firstRound, 'assess:1:Cicero']);
    assert.equal(new Set(files).size, 1);
    assert.equal(result.consensus, false);
    assert.equal(result.decision, null);
    assert.match(result.exception, /consensus/);
    const state = await f.state();
    assert.equal(state.status, 'failed');
    assert.equal(state.transcript.filter(item => item.phase === 'assess').length, 0);
  }
});

test('a corrected assessment completes the same round without replaying the debate', async t => {
  const f = await fixture(t), calls = [];
  let assessments = 0;
  const result = await f.run({ async executeAgent(context) {
    const data = assignment(context);
    calls.push(label(data));
    if (data.phase === 'assess' && ++assessments === 1) return { final: 'Missing disposition.', exception: null };
    return response(data);
  } });
  assert.deepEqual(calls, [...firstRound, 'assess:1:Cicero']);
  assert.equal(result.decision, 'consensus');
  assert.equal(result.rounds, 1);
  assert.equal((await f.state()).transcript.length, 4);
});

test('a participant exception stops the senate without becoming a speech or a human task', async t => {
  for (const failedPhase of ['introduce', 'intervene', 'assess', 'decide']) {
    const f = await fixture(t), calls = [];
    const result = await f.run({ async executeAgent(context) {
      const data = assignment(context);
      calls.push(label(data));
      return data.phase === failedPhase ? { final: 'Unable to complete this assignment.', exception: 'Source unavailable',
        diagnostics: { source: 'reference.csv', retryable: false }, consensus: true, rounds: 99, decision: 'invented' }
        : response(data, false);
    }, askHuman() { assert.fail('senate exceptions do not create human tasks'); } });
    assert.match(result.exception, /Source unavailable/);
    assert.equal(result.decision, null);
    assert.equal(result.consensus, false);
    assert.notEqual(result.rounds, 99);
    assert.deepEqual(result.diagnostics, { source: 'reference.csv', retryable: false });
    assert.equal((await f.state()).status, 'failed');
    assert.equal((await f.state()).transcript.length, calls.length - 1);
    assert.deepEqual(await f.run({ executeAgent() { assert.fail('an explicit participant failure is terminal'); } }), result);
  }
});

test('malformed participant result envelopes cannot complete a senate', async t => {
  for (const invalid of [null, [], 'done', { final: 'No exception field' }, { final: '', exception: null },
    { final: 42, exception: null }, { final: 'Invalid exception', exception: false }]) {
    const f = await fixture(t);
    const result = await f.run({ async executeAgent() { return invalid; } });
    assert.equal(result.decision, null);
    assert.equal(result.consensus, false);
    assert.equal(typeof result.exception, 'string');
    assert.equal((await f.state()).status, 'failed');
  }
});

test('cancellation resumes the exact interrupted participant or phase without replaying completed speeches', async t => {
  for (const interrupted of ['intervene:1:Cato', 'intervene:1:Caesar', 'assess:1:Cicero', 'decide:3:Cicero']) {
    const f = await fixture(t), completed = [], resumed = [];
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const pending = f.run({ async executeAgent(context) {
      const data = assignment(context);
      if (label(data) === interrupted) {
        started();
        return new Promise((_resolve, reject) => context.signal.addEventListener('abort',
          () => reject(context.signal.reason), { once: true }));
      }
      completed.push(label(data));
      return response(data, false);
    } });
    const rejected = assert.rejects(pending, /Cancelled by test/);
    await ready;
    f.controller.abort(new Error('Cancelled by test'));
    await rejected;
    const state = await f.state();
    assert.equal(state.status, 'cancelled');
    assert.deepEqual(state.transcript.map(label), completed);
    f.context.signal = new AbortController().signal;
    const result = await f.run({ async executeAgent(context) {
      const data = assignment(context);
      resumed.push(label(data));
      return response(data, false);
    } });
    assert.equal(resumed[0], interrupted);
    assert.deepEqual([...completed, ...resumed], allRounds);
    assert.equal(result.decision, 'princeps');
    assert.deepEqual((await f.state()).transcript.map(label), allRounds);
  }
});

test('a checkpointed speech is not repeated if cancellation arrives while publishing its completion', async t => {
  const f = await fixture(t), calls = [];
  const executeAgent = async context => {
    const data = assignment(context);
    calls.push(label(data));
    return response(data);
  };
  await assert.rejects(f.run({ executeAgent, event(type, data) {
    if (type === 'senate.phase_finished' && data.phase === 'intervene') f.controller.abort(new Error('Cancelled at handoff'));
  } }), /Cancelled at handoff/);
  assert.equal((await f.state()).status, 'cancelled');
  f.context.signal = new AbortController().signal;
  const resumed = await f.run({ executeAgent });
  assert.equal(resumed.decision, 'consensus');
  assert.deepEqual(calls, firstRound);
});

test('cancellation at a committed final assessment preserves the completed answer for replay', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({ async executeAgent(context) { return response(assignment(context)); }, event(type, data) {
    if (type === 'senate.phase_finished' && data.phase === 'assess') f.controller.abort(new Error('Cancelled after decision'));
  } }), /Cancelled after decision/);
  assert.equal((await f.state()).status, 'completed');
  f.context.signal = new AbortController().signal;
  const result = await f.run({ executeAgent() { assert.fail('committed consensus cannot reopen'); } });
  assert.equal(result.decision, 'consensus');
  assert.equal(result.final, 'assess:1:Cicero');
});

test('saved checkpoints reject changed topics, participant definitions, models, and workspaces', async t => {
  const f = await fixture(t);
  await f.run({ async executeAgent(context) { return response(assignment(context)); } });
  const original = structuredClone(f.context.job.input);
  const changes = [
    () => { f.context.job.input.topic = 'A different topic'; },
    () => { f.context.job.input.senate.senators[0].prompt = 'Changed persona'; },
    () => { f.context.job.input.senate.senators.reverse(); },
    () => { f.context.argv = ['--model', 'fixture/different']; },
    () => { f.context.job.workspace = f.environment; },
  ];
  for (const change of changes) {
    f.context.job.input = structuredClone(original);
    f.context.argv = [];
    f.context.job.workspace = f.workspace;
    change();
    await assert.rejects(f.run({ executeAgent() { assert.fail('mismatched checkpoint must not run'); } }), /checkpoint.*match/i);
  }
});

test('real Pi sessions route participant models and let every senator execute environment search tools', async t => {
  const config = configuration();
  config.princeps.model = 'fixture/chair';
  config.senators[0].model = 'fixture/cautious';
  config.senators[1].model = 'fixture/ambitious';
  const f = await fixture(t, { senate: config });
  await mkdir(join(f.environment, 'extensions'));
  await writeFile(join(f.environment, 'extensions', 'search.ts'), `
    export default function (pi) {
      pi.registerTool({ name: 'web_search', label: 'Search', description: 'Search online reference material.',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        async execute(_id, { query }) { return { content: [{ type: 'text', text: 'SEARCH_RESULT: ' + query }], details: {} }; }
      });
    }
  `);
  const participants = [config.princeps, ...config.senators], calls = [], searches = [];
  const provider = {
    async listModels() { return { models: participants.map(participant => ({ ...model, id: participant.model })) }; },
    async *infer(request) {
      const frame = JSON.parse(request.payload), messages = frame.context.messages;
      const users = messages.filter(message => message.role === 'user');
      const data = JSON.parse(users.at(-1).content[0].text.split('Assignment data:\n')[1]);
      const participant = participants.find(participant => participant.name === data.participant);
      assert.equal(request.model, participant.model);
      assert.ok(systemPromptOf(frame.context).includes(participant.prompt));
      for (const other of participants.filter(other => other !== participant)) {
        assert.ok(!systemPromptOf(frame.context).includes(other.prompt), 'personas remain separate from other participants');
      }
      assert.ok(toolsOf(frame.context).some(tool => tool.name === 'web_search'));
      const firstInference = messages.at(-1).role === 'user';
      let message;
      if (firstInference) {
        calls.push(label(data));
        if (data.phase === 'introduce' || (data.phase === 'intervene' && data.round === 1)) {
          assert.equal(users.length, 1, 'each participant starts an independent conversation');
        } else if (data.phase === 'assess') {
          assert.equal(users.length, data.round + 1, 'princeps continues its own conversation');
          assert.equal(JSON.parse(users[0].content[0].text.split('Assignment data:\n')[1]).phase, 'introduce');
        } else if (data.phase === 'intervene' && data.round === 2) {
          assert.equal(users.length, 2);
          assert.ok(messages.some(message => message.role === 'toolResult' &&
            JSON.stringify(message.content).includes(`SEARCH_RESULT: ${data.participant} round 1`)));
        }
        message = data.phase === 'intervene'
          ? assistant([{ type: 'toolCall', id: `search-${data.participant}-${data.round}`, name: 'web_search',
            arguments: { query: `${data.participant} round ${data.round}` } }], 'toolUse')
          : assistant([{ type: 'text', text: JSON.stringify(response(data, data.round === 2)) }]);
      } else {
        assert.equal(data.phase, 'intervene');
        assert.equal(messages.at(-1).role, 'toolResult');
        assert.ok(JSON.stringify(messages.at(-1).content).includes(`SEARCH_RESULT: ${data.participant} round ${data.round}`));
        searches.push(`${data.participant}:${data.round}`);
        message = assistant([{ type: 'text', text: JSON.stringify(response(data)) }]);
      }
      yield { payload: JSON.stringify({ type: 'done', reason: message.stopReason, message }) };
    },
  };
  const result = await f.run({ provider });
  assert.equal(result.exception, null);
  assert.equal(result.decision, 'consensus');
  assert.equal(result.rounds, 2);
  assert.deepEqual(calls, allRounds.slice(0, 7));
  assert.deepEqual(searches, ['Cato:1', 'Caesar:1', 'Cato:2', 'Caesar:2']);
});

test('a senator retries a transient Provider failure without repeating tools or advancing the debate', { timeout: 10000 }, async t => {
  const config = configuration();
  config.senators = config.senators.slice(0, 1);
  const f = await fixture(t, { senate: config }), resumedRequests = [];
  const provider = {
    async listModels() { return { models: [model] }; },
    async *infer(request) {
      const frame = JSON.parse(request.payload), messages = frame.context.messages;
      const data = JSON.parse(messages.findLast(message => message.role === 'user').content[0].text.split('Assignment data:\n')[1]);
      let message;
      if (data.phase === 'intervene' && messages.at(-1).role === 'user') {
        message = assistant([{ type: 'toolCall', id: 'senator-evidence', name: 'bash',
          arguments: { command: 'printf x >> evidence.txt' } }], 'toolUse');
      } else {
        if (data.phase === 'intervene') {
          assert.equal(messages.at(-1).role, 'toolResult');
          assert.equal(messages.at(-1).toolCallId, 'senator-evidence');
          resumedRequests.push(frame);
          if (resumedRequests.length === 1) {
            yield { payload: JSON.stringify({ type: 'start', partial: assistant([], 'pending') }) };
            throw new ConnectError('Synthetic Provider disconnect', Code.Unavailable);
          }
        }
        message = assistant([{ type: 'text', text: JSON.stringify(response(data)) }]);
      }
      yield { payload: JSON.stringify({ type: 'done', reason: message.stopReason, message }) };
    },
  };
  const result = await f.run({ provider });
  assert.equal(result.exception, null);
  assert.equal(result.decision, 'consensus');
  assert.equal(result.rounds, 1);
  assert.equal(await readFile(join(f.workspace, 'evidence.txt'), 'utf8'), 'x');
  assert.equal(resumedRequests.length, 2);
  assert.deepEqual(resumedRequests[1], resumedRequests[0], 'only the inference request is replayed, with its completed tool result');
  const state = await f.state();
  const expected = ['introduce:0:Cicero', 'intervene:1:Cato', 'assess:1:Cicero'];
  assert.deepEqual(state.transcript.map(label), expected);
  assert.equal(state.sessions.length, expected.length);
  assert.ok(state.sessions.every(session => session.status === 'completed'));
  assert.deepEqual(f.events.filter(event => event.type === 'senate.phase_started').map(label), expected);
  assert.equal(f.events.filter(event => event.type === 'senate.finished').length, 1);
  const retries = f.events.filter(event => event.type === 'agent.provider_retrying');
  assert.equal(retries.length, 1);
  assert.equal(label(retries[0]), 'intervene:1:Cato');
  const saved = JSON.parse(await readFile(join(f.directory, state.sessions[1].directory, 'agent.json'), 'utf8'));
  assert.equal(saved.agent.steps, 2, 'transport retry does not count as another logical inference step');
});
