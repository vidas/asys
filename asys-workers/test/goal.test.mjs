import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { goal } from '../src/goal.mjs';
import { systemModel } from '../src/system-model.mjs';
import { HumanService } from '../../asys-human-interface/src/human-service.mjs';
import { assistant, conversationOf, model, systemPromptOf } from './helpers.mjs';

const implemented = { final: 'IMPLEMENTER_CLAIMS_SUCCESS', exception: null, goal_status: 'review' };
const progress = { final: 'Useful progress made; required work remains.', exception: null, goal_status: 'continue' };
const criterion = { requirement: 'Produce the required output', basis: 'Original user request' };
const blocked = { final: 'Inspected inputs; the specification is missing and existing work is preserved.',
  exception: 'Missing specification', question: 'Please supply the expected output format.' };
const assignment = context => JSON.parse(context.job.input.prompt.split('Assignment data:\n')[1]);
const observed = [{ source: 'cat output.txt', observation: 'The file contains the required output.' }];
const checked = (data, satisfied = true) => ({ final: satisfied ? 'Observed the required output.' : 'Output is still missing.',
  exception: null, coverage: 'complete', criteria: [{ ...criterion, status: satisfied ? 'satisfied' : 'unmet',
    evidence: satisfied ? observed : [{ source: 'cat output.txt', observation: 'File does not exist.' }] }] });
const normal = data => data.phase === 'implement' ? implemented : checked(data);

async function fixture(t, input = {}) {
  const root = await mkdtemp(join(tmpdir(), 'asys-goal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'job'), workspace = join(root, 'workspace'), environment = join(root, 'environment');
  for (const path of [directory, workspace, environment]) await mkdir(path);
  await mkdir(join(environment, 'agents/simple'), { recursive: true });
  await writeFile(join(environment, 'agents/simple/prompt.md'), 'ENVIRONMENT_PRIVATE_PROMPT');
  await writeFile(join(environment, 'agents/simple/memory.md'), 'ENVIRONMENT_PRIVATE_MEMORY');
  const models = join(root, 'models.json');
  await writeFile(models, JSON.stringify({ simple: model.id }));
  const controller = new AbortController(), events = [];
  const context = { job: { id: 'goal-test', directory, workspace, result: join(directory, 'result.json'),
    input: { goal: 'Produce the required output', ...input } }, argv: [],
    env: { ASYS_ENVIRONMENT_DIR: environment, ASYS_SYSTEM_MODELS: models }, signal: controller.signal };
  return { root, directory, workspace, models, controller, context, events,
    run(dependencies = {}) { return goal(context, { event: (type, data) => events.push({ type, ...data }), ...dependencies }); },
    state: () => readFile(join(directory, 'goal.json'), 'utf8').then(JSON.parse),
  };
}

test('implementation receives review history; fresh verification receives its response but no private history', async t => {
  const f = await fixture(t), calls = [], dependencies = [];
  let verifications = 0;
  const result = await f.run({ async executeAgent(context, options) {
    calls.push(context); dependencies.push(options);
    const data = assignment(context);
    assert.equal(options.definition.prompt, '');
    assert.equal(options.definition.memory, '');
    assert.deepEqual(context.argv, ['--agent', 'simple', '--model', model.id]);
    assert.equal(data.goal, f.context.job.input.goal);
    assert.equal(data.contract, undefined);
    if (data.phase === 'implement') {
      await writeFile(join(context.job.directory, 'lessons.md'), 'IMPLEMENTATION_LESSON');
      return implemented;
    }
    assert.equal(data.implementationResponse, implemented.final);
    assert.doesNotMatch(context.job.input.prompt, /IMPLEMENTATION_LESSON/);
    assert.equal(options.sessionFile, undefined);
    return checked(data, ++verifications > 1);
  } });
  assert.equal(result.verified, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(calls.map(call => assignment(call).phase), ['implement', 'verify', 'implement', 'verify']);
  assert.equal(new Set(calls.map(call => call.job.id)).size, 4);
  assert.equal(new Set(calls.map(call => call.job.workspace)).size, 1);
  assert.equal(dependencies[0].sessionFile, join(f.directory, 'implementation/session.jsonl'));
  assert.equal(dependencies[2].sessionFile, dependencies[0].sessionFile);
  assert.equal(assignment(calls[2]).reviews[0].final, 'Output is still missing.');
  assert.equal(assignment(calls[3]).reviews[0].criteria[0].requirement, criterion.requirement);
  assert.equal(assignment(calls[2]).implementationResponse, undefined);
  const state = await f.state();
  assert.equal(state.version, 4);
  assert.equal(state.status, 'completed');
  assert.equal(state.sessions[0].lessons, 'IMPLEMENTATION_LESSON');
  assert.equal(state.reviews.length, 2);
  assert.equal(state.reviews[0].criteria[0].status, 'unmet');
  assert.deepEqual(state.reviews[1].criteria[0].evidence, observed);
  for (const session of state.sessions) {
    assert.deepEqual(JSON.parse(await readFile(join(f.directory, session.directory, 'result.json'))), session.result);
  }
});

test('canonical request supplies a goal when the legacy goal field is absent', async t => {
  const f = await fixture(t, { goal: undefined, request: 'Produce the required output' });
  const result = await f.run({ async executeAgent(context) {
    const data = assignment(context);
    assert.equal(data.goal, 'Produce the required output');
    return normal(data);
  } });
  assert.equal(result.verified, true);
});

test('a premature review request and narrow passing checks do not complete the original goal', async t => {
  const f = await fixture(t), implementations = [];
  let verifications = 0;
  const result = await f.run({ async executeAgent(context) {
    const data = assignment(context);
    if (data.phase === 'implement') {
      implementations.push(data);
      return { ...implemented, final: 'One increment finished; required work remains.' };
    }
    if (++verifications === 1) return { ...checked(data), coverage: 'gap', final: 'The output also needs a UTF-8 encoding check.' };
    const result = checked(data);
    result.criteria.push({ ...criterion, id: 'C2', requirement: 'Required UTF-8 encoding', status: 'satisfied', evidence: observed });
    return result;
  } });
  assert.equal(result.attempts, 2);
  assert.equal(result.verified, true);
  assert.equal(implementations[1].goal, implementations[0].goal);
  assert.match(implementations[1].reviews.at(-1).final, /UTF-8/);
  assert.equal(implementations[1].reviews.length, 1);
});

test('ordinary progress turns continue the same implementation without invoking a reviewer', async t => {
  const f = await fixture(t), phases = [], files = [];
  let implementations = 0;
  const result = await f.run({ async executeAgent(context, options) {
    const data = assignment(context);
    phases.push(data.phase);
    if (data.phase === 'verify') return checked(data);
    files.push(options.sessionFile);
    assert.deepEqual(data.reviews, [], 'progress does not manufacture review feedback');
    return ++implementations < 4 ? progress : implemented;
  } });
  assert.equal(result.verified, true);
  assert.equal(result.attempts, 4);
  assert.deepEqual(phases, ['implement', 'implement', 'implement', 'implement', 'verify']);
  assert.equal(new Set(files).size, 1);
});

test('rejected completion can be followed by partial repairs before another review request', async t => {
  const f = await fixture(t), phases = [];
  let implementations = 0, reviews = 0;
  const result = await f.run({ async executeAgent(context) {
    const data = assignment(context);
    phases.push(data.phase);
    if (data.phase === 'verify') return checked(data, ++reviews === 2);
    implementations++;
    if (implementations > 1) {
      assert.match(data.reviews.at(-1).final, /missing/);
      assert.equal(data.reviews[0].criteria[0].status, 'unmet');
    }
    return implementations === 2 ? progress : implemented;
  } });
  assert.equal(result.verified, true);
  assert.equal(result.attempts, 3);
  assert.deepEqual(phases, ['implement', 'verify', 'implement', 'implement', 'verify']);
  assert.deepEqual((await f.state()).reviews.map(review => review.attempt), [1, 3]);
});

for (const reviewOnLastTurn of [false, true]) {
  test(`an implementation turn limit ${reviewOnLastTurn ? 'permits final review on the last turn' : 'exhausts on partial progress without review'}`, async t => {
    const f = await fixture(t, { maxAttempts: 3 });
    let implementations = 0, reviews = 0;
    const result = await f.run({ async executeAgent(context) {
      const data = assignment(context);
      if (data.phase === 'verify') { reviews++; return checked(data); }
      return ++implementations === 3 && reviewOnLastTurn ? implemented : progress;
    } });
    assert.equal(result.verified, reviewOnLastTurn);
    assert.equal(result.attempts, 3);
    assert.equal(implementations, 3);
    assert.equal(reviews, reviewOnLastTurn ? 1 : 0);
    if (!reviewOnLastTurn) {
      assert.equal((await f.state()).status, 'exhausted');
      assert.match(result.exception, /after 3/);
      assert.equal(result.criteria, undefined, 'unfinished work has no invented verification');
    }
  });
}

test('missing or invalid implementation disposition gets one correction and cannot trigger review', async t => {
  for (const goal_status of [undefined, null, 'complete', true]) {
    const f = await fixture(t, { maxAttempts: 1 }), files = [];
    let implementations = 0;
    const result = await f.run({ async executeAgent(context, options) {
      const data = assignment(context);
      assert.equal(data.phase, 'implement', 'an invalid disposition must not launch a reviewer');
      implementations++;
      files.push(options.sessionFile);
      if (implementations === 2) assert.match(data.correction.problem, /goal_status/);
      return { ...implemented, goal_status };
    } });
    assert.equal(result.verified, false);
    assert.equal(implementations, 2);
    assert.equal(new Set(files).size, 1);
    assert.equal(result.attempts, 1, 'protocol correction is not another implementation turn');
    assert.equal((await f.state()).status, 'failed');
  }
});

test('a corrected implementation disposition can request review without consuming another turn', async t => {
  const f = await fixture(t, { maxAttempts: 1 });
  let implementations = 0, reviews = 0;
  const result = await f.run({ async executeAgent(context) {
    const data = assignment(context);
    if (data.phase === 'verify') { reviews++; return checked(data); }
    return ++implementations === 1 ? { final: 'Missing disposition.', exception: null } : implemented;
  } });
  assert.equal(result.verified, true);
  assert.equal(result.attempts, 1);
  assert.equal(implementations, 2);
  assert.equal(reviews, 1);
});

test('attempt exhaustion preserves gaps; an unlimited goal continues beyond three attempts', async t => {
  for (const cap of [2, null]) {
    const f = await fixture(t, cap ? { maxAttempts: cap } : {});
    let verifications = 0;
    const result = await f.run({ async executeAgent(context) {
      const data = assignment(context);
      return data.phase === 'implement' ? implemented : checked(data, ++verifications === 4);
    } });
    assert.equal(result.attempts, cap ?? 4);
    assert.equal(result.verified, cap === null);
    const state = await f.state();
    assert.equal(state.status, cap ? 'exhausted' : 'completed');
    assert.equal(state.reviews.length, cap ?? 4, 'each assessment remains in review history');
    if (cap) assert.match(result.exception, /after 2 attempts/);
  }
});

test('earlier concerns remain available even when an intermediate review omits them', async t => {
  const f = await fixture(t);
  let reviews = 0;
  const result = await f.run({ async executeAgent(context) {
    const data = assignment(context);
    if (data.phase === 'implement') return implemented;
    if (++reviews === 1) return checked(data, false);
    if (reviews === 2) return { ...checked(data), coverage: 'gap', final: 'Another required check is unavailable.' };
    assert.equal(data.reviews.length, 2);
    assert.equal(data.reviews[0].criteria[0].status, 'unmet');
    assert.equal(data.reviews[1].coverage, 'gap');
    return { ...checked(data), final: 'Rechecked the original missing output and the later check; both now pass.' };
  } });
  assert.equal(result.attempts, 3);
  assert.deepEqual((await f.state()).reviews.map(review => review.attempt), [1, 2, 3]);
});

test('unavailable evidence remains unverified, distinct from an observed defect', async t => {
  const f = await fixture(t, { maxAttempts: 1 });
  const result = await f.run({ async executeAgent(context) {
    const data = assignment(context);
    return data.phase === 'implement' ? implemented : { ...checked(data), criteria: [{ ...criterion,
      status: 'unverified', explanation: 'The check could not obtain a result.', evidence: [] }] };
  } });
  assert.equal(result.verified, false);
  assert.equal(result.criteria[0].status, 'unverified');
  assert.match(result.criteria[0].explanation, /could not obtain/);
});

test('a Senate repair task returns a real gap to implementation regardless of discussion labels', async t => {
  const request = 'Repair the Senate objections: pre-edge checking, stale evidence rejection and accurate coverage. ' +
    'The approved plan also requires testing a data width above 32 bits.';
  const f = await fixture(t, { goal: request }), phases = [];
  let reviews = 0;
  const wider = { requirement: 'Exercise a data width above 32 bits', basis: 'Approved plan', status: 'unmet',
    evidence: [{ source: 'build modes', observation: 'Only widths 1, 8, 16 and 32 are configured.' }] };
  const result = await f.run({ async executeAgent(context) {
    const data = assignment(context);
    phases.push(data.phase);
    assert.equal(data.goal, request);
    if (data.phase === 'implement') {
      if (data.attempt === 2) assert.deepEqual(data.reviews[0].criteria[0].evidence, wider.evidence);
      return implemented;
    }
    assert.equal(data.correction, undefined, 'engineering feedback must not require label correction');
    if (++reviews === 1) return { final: 'PF1, PF2 and PF3 repaired; the wider-data case is still absent.',
      exception: null, coverage: 'gap', criteria: [wider],
      // Reproduce the extra field that stopped the real repair run. It has no control semantics.
      resolved_findings: ['PF1', 'PF2', 'PF3'].map(id => ({ id, reason: 'Repaired', evidence: observed })) };
    return { final: 'Rechecked all Senate objections and observed the wider-data case passing.', exception: null,
      coverage: 'complete', criteria: [{ ...wider, status: 'satisfied',
        evidence: [{ source: 'width-64 test', observation: 'Upper data bits were exercised and checked.' }] }] };
  }, askHuman() { assert.fail('ordinary review feedback must return to implementation'); } });
  assert.equal(result.verified, true);
  assert.deepEqual(phases, ['implement', 'verify', 'implement', 'verify']);
  assert.equal((await f.state()).reviews.length, 2);
});

test('a mistaken demand can be withdrawn after an independently checked rebuttal', async t => {
  const f = await fixture(t);
  const rebuttal = 'The request requires output.txt only; it does not require a second JSON export. ' +
    'Read the original request and output.txt to verify this.';
  const result = await f.run({ async executeAgent(context) {
    const data = assignment(context);
    if (data.phase === 'implement') return data.attempt === 1 ? implemented : { ...implemented, final: rebuttal };
    if (data.attempt === 1) return { ...checked(data, false), final: 'A second JSON export is missing.',
      criteria: [{ ...criterion, requirement: 'Also export JSON', status: 'unmet',
        evidence: [{ source: 'workspace', observation: 'No JSON export is present.' }] }] };
    assert.equal(data.implementationResponse, rebuttal);
    assert.equal(data.reviews[0].criteria[0].requirement, 'Also export JSON');
    return { ...checked(data), final: 'Read the request and output.txt. The output meets the request; ' +
      'the earlier JSON-export demand was unsupported and is withdrawn.' };
  } });
  assert.equal(result.verified, true);
  assert.equal(result.attempts, 2);
  const history = (await f.state()).reviews;
  assert.equal(history.length, 2);
  assert.match(history[1].final, /unsupported and is withdrawn/);
});

test('criterion labels are optional discussion text and cannot override an unmet assessment', async t => {
  const f = await fixture(t, { maxAttempts: 1 });
  const result = await f.run({ async executeAgent(context) {
    const data = assignment(context);
    if (data.phase === 'implement') return implemented;
    return { ...checked(data), criteria: [
      { ...checked(data).criteria[0], id: 'F1' },
      { ...checked(data, false).criteria[0], id: 'F1', requirement: 'Another required outcome' },
    ] };
  } });
  assert.equal(result.verified, false);
  assert.match(result.exception, /Goal remains unmet/);
  assert.equal((await f.state()).sessions.filter(s => s.phase === 'verify').length, 1);
});

test('review history survives interruption and is supplied to the resumed verifier', async t => {
  const f = await fixture(t), interruption = new Error('interrupted between reviews');
  await assert.rejects(f.run({ async executeAgent(context) {
    const data = assignment(context);
    if (data.phase === 'implement') return implemented;
    if (data.attempt === 1) return checked(data, false);
    f.controller.abort(interruption);
    throw interruption;
  } }), /interrupted between reviews/);
  assert.equal((await f.state()).reviews.length, 1);
  f.context.signal = new AbortController().signal;
  const result = await f.run({ async executeAgent(context) {
    const data = assignment(context);
    assert.equal(data.phase, 'verify', 'completed implementation must not repeat');
    assert.equal(data.reviews.length, 1);
    assert.equal(data.reviews[0].criteria[0].status, 'unmet');
    assert.equal(data.implementationResponse, implemented.final);
    return checked(data);
  } });
  assert.equal(result.verified, true);
  assert.deepEqual((await f.state()).reviews.map(review => review.attempt), [1, 2]);
});

for (const phase of ['implement', 'verify']) {
  test(`${phase} waits for human guidance and retries with the correct session policy`, async t => {
    const f = await fixture(t), calls = [];
    let answer, asked, blockedOnce = false;
    const attention = new Promise(resolve => { asked = resolve; });
    const pending = f.run({ async executeAgent(context, options) {
      calls.push({ context, options });
      const data = assignment(context);
      if (data.phase === phase && !blockedOnce) { blockedOnce = true; return blocked; }
      return normal(data);
    }, askHuman(context) {
      assert.equal(context.signal, f.controller.signal);
      assert.match(context.job.input.prompt, /expected output format/);
      assert.match(context.job.input.prompt, phase === 'implement' ? /continues the implementation conversation/ : /fresh verification/);
      assert.equal(context.job.input.summary, blocked.final);
      asked();
      return new Promise(resolve => { answer = resolve; });
    } });
    await attention;
    assert.equal((await f.state()).status, 'needs_human');
    answer({ action: 'retry', guidance: 'Use the supplied specification.' });
    assert.equal((await pending).verified, true);
    const retried = calls.filter(call => assignment(call.context).phase === phase);
    assert.equal(retried.length, 2);
    assert.equal(assignment(retried[1].context).humanGuidance[0].answer.guidance, 'Use the supplied specification.');
    assert.equal(retried[0].options.sessionFile, retried[1].options.sessionFile);
    assert.notEqual(retried[0].context.job.id, retried[1].context.job.id);
  });
}

test('a human stop is durable and cannot become a successful verification', async t => {
  const f = await fixture(t);
  const result = await f.run({ async executeAgent() { return blocked; }, async askHuman() { return { action: 'stop' }; } });
  assert.equal(result.verified, false);
  assert.equal(result.exception, 'Stopped by human');
  assert.equal((await f.state()).status, 'stopped');
  assert.deepEqual(await f.run({ executeAgent() { assert.fail('stopped goals must not execute'); } }), result);
});

for (const waiting of ['agent', 'human']) {
  test(`cancellation interrupts ${waiting} and saved state permits an explicit retry`, async t => {
    const f = await fixture(t);
    let ready, calls = 0;
    const started = new Promise(resolve => { ready = resolve; });
    const wait = ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }); ready();
    });
    const pending = f.run({ executeAgent(context) { calls++; return waiting === 'agent' ? wait(context) : blocked; }, askHuman: wait });
    const rejected = assert.rejects(pending, /Cancelled by test/);
    await started;
    f.controller.abort(new Error('Cancelled by test'));
    await rejected;
    assert.equal(calls, 1);
    assert.equal((await f.state()).status, 'cancelled');
    f.context.signal = new AbortController().signal;
    let asked = 0;
    const resumed = await f.run({ async executeAgent(context) { return normal(assignment(context)); },
      async askHuman() { asked++; return { action: 'retry', guidance: 'Resume the work.' }; } });
    assert.equal(resumed.verified, true);
    assert.equal(asked, waiting === 'human' ? 1 : 0);
  });
}

test('restart preserves completed implementation but reruns interrupted verification', async t => {
  const f = await fixture(t);
  let implementations = 0;
  const executeAgent = async context => {
    const data = assignment(context);
    if (data.phase === 'implement') implementations++;
    return normal(data);
  };
  await assert.rejects(f.run({ executeAgent, event(type, data) {
    if (type === 'goal.phase_finished' && data.phase === 'verify') f.controller.abort(new Error('Cancelled at handoff'));
  } }), /Cancelled at handoff/);
  assert.equal((await f.state()).status, 'cancelled');
  f.context.signal = new AbortController().signal;
  const resumed = await f.run({ executeAgent });
  assert.equal(resumed.verified, true);
  assert.equal(implementations, 1);
  assert.equal((await f.state()).sessions.filter(s => s.phase === 'verify').length, 2);
});

test('restart replaces a cancelled Human service request instead of reusing its rejected ID', async t => {
  const f = await fixture(t), service = new HumanService(join(f.root, 'human'));
  t.after(() => service.close());
  const ids = [];
  let ready;
  const waiting = new Promise(resolve => { ready = resolve; });
  const askHuman = async (context, options) => {
    ids.push(options.id);
    const answer = service.ask({ id: options.id, inputJson: JSON.stringify(context.job.input) },
      { signal: context.signal });
    if (ids.length === 1) ready();
    else {
      const { token } = service.claimTask({ id: options.id, claimant: 'tester', claimId: 'retry' });
      service.completeTask({ id: options.id, token, completionId: 'answered',
        resultJson: JSON.stringify({ action: 'retry', guidance: 'The missing input is available.' }) });
    }
    return JSON.parse((await answer).resultJson);
  };
  const pending = f.run({ async executeAgent() { return blocked; }, askHuman });
  const rejected = assert.rejects(pending, /Interrupted human wait/);
  await waiting;
  f.controller.abort(new Error('Interrupted human wait'));
  await rejected;
  assert.equal(service.getTask({ id: ids[0] }).task.status, 'cancelled');
  f.context.signal = new AbortController().signal;
  const resumed = await f.run({ async executeAgent(context) { return normal(assignment(context)); }, askHuman });
  assert.equal(resumed.verified, true);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  assert.equal(service.getTask({ id: ids[1] }).task.status, 'completed');
  assert.equal((await f.state()).human.length, 1);
});

test('a worker crash after implementation checkpoint does not repeat its side effects', async t => {
  const f = await fixture(t);
  let implementations = 0;
  const executeAgent = async context => {
    if (assignment(context).phase === 'implement') implementations++;
    return normal(assignment(context));
  };
  const failed = await f.run({ executeAgent, event(type, data) {
    if (type === 'goal.phase_finished' && data.phase === 'implement') throw new Error('Worker interrupted');
  } });
  assert.equal(failed.verified, false);
  assert.equal((await f.run({ executeAgent })).verified, true);
  assert.equal(implementations, 1);
});

test('restart after a persisted continue result advances without replaying the completed turn', async t => {
  const f = await fixture(t), effects = join(f.workspace, 'effects.txt');
  let implementations = 0, reviews = 0;
  const executeAgent = async context => {
    const data = assignment(context);
    if (data.phase === 'verify') { reviews++; return checked(data); }
    implementations++;
    if (implementations === 1) {
      await writeFile(effects, 'preserved first-turn side effect');
      return progress;
    }
    assert.equal(await readFile(effects, 'utf8'), 'preserved first-turn side effect');
    return implemented;
  };
  const failed = await f.run({ executeAgent, event(type, data) {
    if (type === 'goal.phase_finished' && data.phase === 'implement') throw new Error('Worker interrupted after progress');
  } });
  assert.equal(failed.verified, false);
  assert.equal(implementations, 1);
  assert.equal(reviews, 0);
  const resumed = await f.run({ executeAgent });
  assert.equal(resumed.verified, true);
  assert.equal(resumed.attempts, 2);
  assert.equal(implementations, 2);
  assert.equal(reviews, 1);
});

test('restart with a pending review cannot finish from the implementation claim alone', async t => {
  const f = await fixture(t, { maxAttempts: 1 });
  let implementations = 0;
  const failed = await f.run({ async executeAgent(context) {
    if (assignment(context).phase === 'verify') throw new Error('Reviewer unavailable');
    implementations++;
    return implemented;
  } });
  assert.equal(failed.verified, false);
  assert.equal((await f.state()).nextPhase, 'verify');
  const resumed = await f.run({ async executeAgent(context) {
    assert.equal(assignment(context).phase, 'verify', 'the pending review resumes without replaying implementation');
    return checked(assignment(context), false);
  } });
  assert.equal(resumed.verified, false);
  assert.equal((await f.state()).status, 'exhausted');
  assert.equal(implementations, 1);
});

test('saved checkpoints reject a different goal and earlier workflow versions', async t => {
  const f = await fixture(t);
  await f.run({ async executeAgent(context) { return normal(assignment(context)); } });
  f.context.job.input.goal = 'A different goal';
  await assert.rejects(f.run(), /checkpoint does not match/);
  f.context.job.input.goal = 'Produce the required output';
  const state = await f.state();
  for (const version of [1, 2, 3]) {
    await writeFile(join(f.directory, 'goal.json'), JSON.stringify({ ...state, version }));
    await assert.rejects(f.run(), /older workflow/);
  }
});

test('malformed verifier reports get one fresh correction, never another implementation', async t => {
  const invalid = [
    data => ({ ...checked(data), criteria: [] }),
    data => ({ ...checked(data), coverage: 'maybe' }),
    data => ({ ...checked(data), criteria: [null] }),
    data => ({ ...checked(data), criteria: [{ ...checked(data).criteria[0], basis: '' }] }),
    data => ({ ...checked(data), criteria: [{ ...checked(data).criteria[0], evidence: [] }] }),
  ];
  for (const verdict of invalid) {
    const f = await fixture(t);
    let reviews = 0, implementations = 0;
    const result = await f.run({ async executeAgent(context) {
      const data = assignment(context);
      if (data.phase === 'implement') { implementations++; return implemented; }
      if (++reviews > 1) assert.ok(data.correction.problem);
      return verdict(data);
    } });
    assert.equal(result.verified, false);
    assert.equal(implementations, 1);
    assert.equal(reviews, 2);
    assert.equal((await f.state()).status, 'failed');
  }
});

test('a positive worker boolean cannot override unmet criteria', async t => {
  const f = await fixture(t, { maxAttempts: 1 });
  const result = await f.run({ async executeAgent(context) {
    const data = assignment(context);
    return data.phase === 'implement' ? implemented : { ...checked(data, false), verified: true };
  } });
  assert.equal(result.verified, false);
});

test('model overrides work and invalid limits fail before inference', async t => {
  const f = await fixture(t);
  assert.equal(systemModel('simple', undefined, f.context.env), model.id);
  await writeFile(f.models, '{}');
  assert.throws(() => systemModel('simple', undefined, f.context.env), /asys system-model set simple MODEL/);
  await writeFile(f.models, 'broken');
  f.context.argv = ['--model', model.id, '--max-attempts', '1'];
  assert.equal((await f.run({ async executeAgent(context) { return normal(assignment(context)); } })).verified, true);
  for (const maxAttempts of [0, -1, true, '2', 1.5]) {
    const invalid = await fixture(t, { maxAttempts });
    await assert.rejects(invalid.run({ executeAgent() { assert.fail('must not start'); } }), /positive integer/);
  }
});

// Exercise the actual agent/session adapter, tools and transcript viewer. Only
// Inference is scripted, but implementation and verification use real shell
// tools. Progress turns keep their history and do not invoke a reviewer; an
// explicit review request starts an independent session that reads output.txt.
test('real sessions continue partial work, retain review feedback and isolate final reviewers', async t => {
  const f = await fixture(t), frames = [];
  let reviews = 0, implementationTurns = 0;
  const provider = {
    async listModels() { return { models: [model] }; },
    async *infer(request) {
      const frame = JSON.parse(request.payload), messages = conversationOf(frame.context);
      frames.push(frame);
      const users = messages.filter(m => m.role === 'user');
      const data = JSON.parse(users.at(-1).content[0].text.split('Assignment data:\n')[1]);
      const initialRequest = messages.at(-1).role === 'user';
      let message;
      if (initialRequest) {
        const shared = await readFile(new URL('../src/system.md', import.meta.url), 'utf8');
        assert.ok(systemPromptOf(frame.context).includes(shared.trim()));
        assert.doesNotMatch(systemPromptOf(frame.context), /Agent instructions:|ENVIRONMENT_PRIVATE/);
        if (data.phase === 'implement') {
          implementationTurns++;
          if (implementationTurns === 2) {
            assert.ok(messages.some(m => m.role === 'toolResult' && m.toolCallId === 'implement-1'));
            assert.ok(messages.some(m => m.role === 'assistant' && m.content.some(p => p.text?.includes('Useful progress made'))));
            assert.deepEqual(data.reviews, []);
            assert.equal(reviews, 0, 'partial work must continue before any review');
          }
          if (implementationTurns >= 3) {
            assert.ok(messages.some(m => m.role === 'toolResult' && m.toolCallId === 'implement-2'));
            assert.match(data.reviews.at(-1).final, /missing/);
            assert.equal(reviews, 1, 'partial repairs must not trigger another review');
          }
          message = assistant([{ type: 'toolCall', id: `implement-${implementationTurns}`, name: 'bash',
            arguments: { command: implementationTurns <= 2 ? 'printf initial > output.txt' : 'printf required > output.txt' } }], 'toolUse');
        } else {
          reviews++;
          assert.equal(messages.length, 1);
          assert.equal(data.implementationResponse, implemented.final);
          assert.equal(messages.some(m => m.role === 'toolResult'), false);
          message = assistant([{ type: 'toolCall', id: `verify-${reviews}`, name: 'bash', arguments: { command: 'cat output.txt' } }], 'toolUse');
        }
      } else {
        if (data.phase === 'verify') {
          const output = JSON.stringify(messages.at(-1));
          assert.match(output, reviews === 1 ? /initial/ : /required/);
        }
        const result = data.phase === 'implement'
          ? (implementationTurns === 1 || implementationTurns === 3 ? progress : implemented)
          : checked(data, reviews > 1);
        message = assistant([{ type: 'text', text: JSON.stringify(result) }]);
      }
      yield { payload: JSON.stringify({ type: 'done', reason: message.stopReason, message }) };
    },
  };
  const result = await f.run({ provider });
  assert.equal(result.verified, true);
  assert.equal(result.attempts, 4);
  assert.equal(implementationTurns, 4);
  assert.equal(reviews, 2);
  assert.equal(await readFile(join(f.workspace, 'output.txt'), 'utf8'), 'required');
  const state = await f.state();
  const transcripts = await Promise.all(state.sessions.map(async s =>
    JSON.parse(await readFile(join(f.directory, s.directory, 'agent.json'))).agent));
  assert.deepEqual(state.sessions.map(s => s.phase), ['implement', 'implement', 'verify', 'implement', 'implement', 'verify']);
  assert.equal(new Set([0, 1, 3, 4].map(i => transcripts[i].session.header.id)).size, 1);
  assert.notEqual(transcripts[2].session.header.id, transcripts[5].session.header.id);
  assert.ok(transcripts[1].sessionStartEntryCount > 0);
  const script = [
    'import json, sys', 'sys.path.insert(0, sys.argv[1])', 'from asys.transcript import JobOutput',
    'title, lines = JobOutput().read({"directory": sys.argv[2]})',
    'print(json.dumps({"title": title, "text": "\\n".join(lines)}))',
  ].join('\n');
  const { stdout } = await promisify(execFile)('python3', ['-c', script,
    fileURLToPath(new URL('../../python', import.meta.url)), f.directory]);
  const observed = JSON.parse(stdout);
  assert.equal(observed.title, 'Goal');
  assert.match(observed.text, /Attempt 1: implement/);
  assert.match(observed.text, /Attempt 4: verify/);
  assert.equal(observed.text.split('Tool call: bash').length - 1, 6, 'earlier implementation messages are not rendered twice');
  assert.doesNotMatch(observed.text, /Attempt 0:/);
});
