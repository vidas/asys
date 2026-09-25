import { parseArgs } from 'node:util';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeDirectory, prepareFile } from '../../asys-runtime/javascript/permissions.mjs';
import { agent } from './agent.mjs';
import { systemAgentDefinition } from './agent-definition.mjs';
import { human } from './human.mjs';
import { readJSON, writeJSON } from './files.mjs';
import { systemModel } from './system-model.mjs';
import { requiredString } from './values.mjs';
import { implementationResult, verification } from './goal/results.mjs';

const instructions = Object.fromEntries(['implement', 'verify'].map(phase =>
  [phase, readFileSync(new URL(`./goal/${phase}.md`, import.meta.url), 'utf8').trim()]));
const now = () => new Date().toISOString();
const stages = { implement: 'implementation', verify: 'verification' };

export function humanRequest(goal, phase, result, attempt) {
  const retry = phase === 'implement'
    ? 'Retry continues the implementation conversation with your guidance.'
    : 'Retry starts a fresh verification session with your guidance.';
  return {
    title: `Goal ${stages[phase]} needs help`,
    prompt: `${result.question || result.exception}\n\n${retry} ` +
      'The workspace is preserved. Stop ends this goal without marking it achieved.',
    summary: result.final,
    files: result.review_files ?? [],
    context: { 'Original goal': goal, 'Observed blocker': result.exception },
    details: { phase, attempt },
    form: { type: 'object', properties: {
      action: { type: 'string', oneOf: [{ const: 'retry', title: 'Retry with guidance' }, { const: 'stop', title: 'Stop this goal' }] },
      guidance: { type: 'string', title: 'Guidance or information for the agent' },
    }, required: ['action'], additionalProperties: false },
    uischema: { type: 'VerticalLayout', elements: [
      { type: 'Control', scope: '#/properties/action', label: 'Next action', options: { format: 'radio' } },
      { type: 'Control', scope: '#/properties/guidance', options: { multi: true } },
    ] },
  };
}

export async function goal({ job, argv, env, signal }, { executeAgent = agent, askHuman = human, provider,
  event = (type, data) => console.log(JSON.stringify({ type, time: now(), ...data })) } = {}) {
  const { values } = parseArgs({ args: argv, options: {
    model: { type: 'string' }, 'max-attempts': { type: 'string' },
  } });
  const input = job.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Goal input must be a JSON object');
  const original = requiredString(input.goal ?? input.request, 'Goal');
  const maxAttempts = values['max-attempts'] === undefined ? (input.maxAttempts ?? null) : Number(values['max-attempts']);
  if (maxAttempts !== null && (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)) throw new Error('maxAttempts must be a positive integer');
  const model = systemModel('simple', values.model, env);
  const definition = systemAgentDefinition(env.ASYS_ENVIRONMENT_DIR, 'simple');
  const checkpoint = join(job.directory, 'goal.json');
  const workspace = realpathSync(job.workspace);
  const state = readJSON(checkpoint, null) ?? {
    version: 4, goal: original, agent: 'simple', model, workspace, maxAttempts,
    status: 'running', attempt: 1, nextPhase: 'implement', sessions: [], human: [], reviews: [], startedAt: now(),
  };
  if (state.version !== 4) throw new Error('This goal checkpoint uses an older workflow; start a new goal to use review history and current-work assessment');
  if (state.goal !== original || state.model !== model || state.workspace !== workspace || state.maxAttempts !== maxAttempts) {
    throw new Error('Goal checkpoint does not match the requested goal, model, workspace or attempt limit');
  }
  if (!Array.isArray(state.sessions) || !Array.isArray(state.human) || !Array.isArray(state.reviews) ||
      !Number.isSafeInteger(state.attempt) || state.attempt < 1 || !['implement', 'verify'].includes(state.nextPhase)) {
    throw new Error('Invalid goal checkpoint');
  }
  signal.throwIfAborted();
  // Re-executing this worker must not reopen a completed goal or override a
  // human stop or exhausted limit. Interrupted/failed phases can be retried.
  if (['completed', 'stopped', 'exhausted'].includes(state.status)) {
    if (!state.result) throw new Error('Terminal goal checkpoint has no result');
    return state.result;
  }
  const save = () => writeJSON(checkpoint, { ...state, updatedAt: now() });
  const finish = (status, final, exception = null) => {
    signal.throwIfAborted();
    state.status = status;
    state.finishedAt = now();
    const review = state.reviews.at(-1);
    state.result = { final, exception, verified: status === 'completed', attempts: state.attempt,
      ...(review?.attempt === state.attempt ? { criteria: review.criteria, coverage: review.coverage } : {}) };
    save();
    event('goal.finished', { status, attempt: state.attempt, verified: status === 'completed' });
    return state.result;
  };

  function assignmentData(name) {
    const context = { phase: name, goal: original, attempt: state.attempt, maxAttempts,
      humanGuidance: state.human.map(({ phase, question, answer }) => ({ phase, question, answer })),
      reviews: state.reviews };
    // A fresh reviewer can examine the implementer's evidence and rebuttals
    // without inheriting its conversation or treating its claims as proof.
    if (name === 'verify') context.implementationResponse = state.implementation.final;
    return context;
  }

  async function requestHelp(session) {
    const directory = join(job.directory, session.directory);
    const request = humanRequest(original, session.phase, session.result, state.attempt);
    writeJSON(join(directory, 'human.request.json'), request);
    state.status = 'needs_human';
    save();
    let answer = readJSON(join(directory, 'human.result.json'), null);
    if (!answer) {
      // A disconnected Human request stays cancelled in the service. A new
      // wait needs a new ID; a saved answer above is reused without asking.
      session.humanRequestId = randomUUID();
      save();
      event('goal.human_requested', { phase: session.phase, attempt: state.attempt,
        humanRequestId: session.humanRequestId, reason: session.result.exception });
      answer = await askHuman({ job: { ...job, input: request }, argv: [], env, signal },
        { id: session.humanRequestId, metadata: { goal_phase: session.phase, goal_attempt: state.attempt } });
      signal.throwIfAborted();
      if (!answer || !['retry', 'stop'].includes(answer.action) ||
          (answer.guidance !== undefined && typeof answer.guidance !== 'string')) throw new Error('Invalid Human response');
      writeJSON(join(directory, 'human.result.json'), answer);
    }
    if (!['retry', 'stop'].includes(answer.action) ||
        (answer.guidance !== undefined && typeof answer.guidance !== 'string')) throw new Error('Invalid saved Human response');
    if (!state.human.some(item => item.session === session.id)) {
      state.human.push({ phase: session.phase, attempt: state.attempt, session: session.id, question: request.prompt, answer });
    }
    session.status = answer.action === 'retry' ? 'retrying' : 'stopped';
    state.status = 'running';
    save();
    event('goal.human_answered', { phase: session.phase, attempt: state.attempt, action: answer.action });
    return answer.action;
  }

  async function phase(name, validate = result => result) {
    for (;;) {
      signal.throwIfAborted();
      const previous = state.sessions.filter(item => item.attempt === state.attempt && item.phase === name);
      const last = previous.at(-1);
      // Recover a result recorded before the controller advanced its phase.
      // Completed implementation/tool side effects need not be repeated.
      if (last?.status === 'completed' && name === 'implement') return validate(last.result);
      if (last?.status === 'stopped') return null;
      if (last?.status === 'needs_human' && await requestHelp(last) === 'stop') return null;
      const invalid = previous.filter(item => item.status === 'invalid');
      if (invalid.length > 1) throw new Error(invalid.at(-1).error);
      const correction = last?.status === 'invalid' ? { problem: last.error, previousResult: last.result } : null;
      const relative = `attempts/${state.attempt}/${name}-${previous.length + 1}`;
      const directory = join(job.directory, relative);
      makeDirectory(directory, { recursive: true, mode: 0o700 });
      const session = { id: randomUUID(), attempt: state.attempt, phase: name, directory: relative,
        status: 'running', startedAt: now() };
      state.sessions.push(session);
      state.phase = name;
      state.status = 'running';
      const context = { ...assignmentData(name), ...(correction ? { correction } : {}) };
      const assignment = { prompt: `${instructions[name]}\n\nAssignment data:\n${JSON.stringify(context, null, 2)}` };
      writeJSON(join(directory, 'input.json'), assignment);
      const output = join(directory, 'stdout.log');
      prepareFile(output);
      save();
      event('goal.phase_started', { phase: name, attempt: state.attempt, session: session.id });
      const emit = (type, data) => {
        const entry = { type, time: now(), ...data, phase: name, attempt: state.attempt, session: session.id };
        appendFileSync(output, JSON.stringify(entry) + '\n');
        event(type, entry);
      };
      const result = await executeAgent({
        job: { ...job, id: session.id, directory, result: join(directory, 'result.json'), input: assignment },
        argv: ['--agent', 'simple', '--model', model], env, signal,
      }, { definition, ...(provider ? { provider } : {}), event: emit,
        ...(name === 'implement' ? { sessionFile: join(job.directory, 'implementation/session.jsonl') } : {}) });
      signal.throwIfAborted();
      writeJSON(join(directory, 'result.json'), result);
      session.result = result;
      session.finishedAt = now();
      requiredString(result.final, 'Final report');
      if (result.exception !== null) requiredString(result.exception, 'Agent exception');
      session.status = result.exception ? 'needs_human' : 'completed';
      try { session.lessons = readFileSync(join(directory, 'lessons.md'), 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      let validated;
      if (result.exception === null) {
        try { validated = validate(result); }
        catch (error) { session.status = 'invalid'; session.error = error.message; }
      }
      save();
      event('goal.phase_finished', { phase: name, attempt: state.attempt, status: session.status, session: session.id });
      signal.throwIfAborted();
      if (session.status === 'invalid') continue;
      if (result.exception === null) return validated;
      if (await requestHelp(session) === 'stop') return null;
    }
  }

  state.status = 'running';
  delete state.result;
  delete state.finishedAt;
  save();
  try {
    for (;;) {
      let final;
      if (state.nextPhase === 'implement') {
        const implementation = await phase('implement', implementationResult);
        if (!implementation) return finish('stopped', 'The human stopped the goal during implementation.', 'Stopped by human');
        state.implementation = implementation;
        final = implementation.final;
        // A normal turn boundary is not a claim that the whole goal is done.
        // Persist an explicit handoff before starting an independent reviewer.
        if (implementation.goal_status === 'review') {
          state.nextPhase = 'verify';
          save();
        }
      }
      if (state.nextPhase === 'verify') {
        const result = await phase('verify', verification);
        if (!result) return finish('stopped', 'The human stopped the goal during verification.', 'Stopped by human');
        state.reviews.push({ ...result, attempt: state.attempt });
        if (result.verified) return finish('completed', result.final);
        final = result.final;
      }
      if (maxAttempts !== null && state.attempt >= maxAttempts) {
        return finish('exhausted', final, `Goal remains unmet after ${maxAttempts} attempts`);
      }
      state.attempt++;
      state.nextPhase = 'implement';
      save();
    }
  } catch (error) {
    const current = state.sessions.at(-1);
    if (current?.status === 'running') {
      current.status = signal.aborted ? 'cancelled' : 'failed';
      current.error = error.message;
      current.finishedAt = now();
    }
    if (signal.aborted) {
      state.status = 'cancelled';
      state.finishedAt = now();
      save();
      throw error;
    }
    return finish('failed', `Goal execution stopped: ${error.message}`, error.message);
  }
}
