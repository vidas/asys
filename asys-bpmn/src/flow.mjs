// Interpreter for workflow/1 files (docs/workflow-design.md).
//
// The host loads and validates the YAML and sends the resolved document: the
// root file and every file it calls, each with its calls resolved to file keys.
// A run is a tree of frames. A frame runs one scope (the workflow, a group, a
// called file, a parallel branch, a for_each item, a repeat iteration or a
// choose action) with a cursor at its current step. State changes are saved
// before their effects, and a job is keyed by frame, step and visit, so
// recovery resumes every frame at its cursor and never submits a recorded job
// again.
import { makeDirectory } from '../../asys-runtime/javascript/permissions.mjs';
import { readJSON, writeJSON } from '../../asys-runtime/javascript/queue.mjs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { checkExpression, feel, messagePaths } from './expressions.mjs';
import { clone, digest, errorRecord, object } from './values.mjs';

export const FORMAT = 'workflow/1';
export const FLOW_ENGINE = 'asys-flow/1';
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const KINDS = ['run', 'parallel', 'group', 'call', 'switch', 'repeat', 'choose', 'wait', 'delay', 'compensate', 'end'];
const POLL = 50;
const now = () => new Date().toISOString();
const copy = value => value === undefined ? null : clone(value);

// The saved artifact: the resolved document in the shape the runtime and the
// Workflow service expect of every workflow (id, name, processes, source).
export function flowArtifact(workflow) {
  if (!object(workflow) || !object(workflow.files) || !object(workflow.files[workflow.root])) {
    throw new Error('A workflow/1 document has a root and its files');
  }
  for (const [key, file] of Object.entries(workflow.files)) {
    if (!object(file?.data) || file.data.asys !== FORMAT || !object(file.data.steps)) throw new Error(`${key} is not a ${FORMAT} file`);
    for (const ref of Object.values(file.calls ?? {})) if (!object(workflow.files[ref])) throw new Error(`${key} calls a missing file ${ref}`);
    // Names were checked by the host; syntax is checked here, by the parser
    // that evaluates them, before any job runs.
    for (const [where, expression] of fileExpressions(file.data)) checkExpression(expression, `${key}: ${where}`);
  }
  const root = workflow.files[workflow.root].data;
  const name = root.name ?? workflow.root;
  const source = JSON.stringify(workflow);
  const body = { format: FORMAT, name, source, sourceHash: digest(source), document: clone(workflow),
    processes: [{ id: 'main', name, isExecutable: true }] };
  return { ...body, id: digest(body) };
}

// Every worker type a run may use, in its own file and the files it calls.
export function flowJobTypes(artifact) {
  const types = new Set();
  for (const file of Object.values(artifact.document.files)) {
    for (const step of steps(file.data.steps)) {
      if (typeof step.run === 'string') types.add(step.run);
      if (typeof step.choose?.coordinator === 'string') types.add(step.choose.coordinator);
    }
  }
  return [...types].sort();
}

// [where, expression] for every expression in a file.
function* fileExpressions(data) {
  const text = (where, value) => expressionsIn(value).map(expression => [where, expression]);
  const bare = (where, value) => {
    const found = typeof value === 'string' ? spans(value) : [];
    return found.length ? found.map(span => [where, span.expression]) : [[where, String(value)]];
  };
  if (data.output !== undefined) yield* bare('output', data.output);
  function* scope(map, prefix) {
    for (const [name, step] of Object.entries(map ?? {})) {
      if (!object(step)) continue;
      const at = `${prefix}${name}`;
      for (const key of ['input', 'args']) if (key in step) yield* text(`${at}.${key}`, step[key]);
      if ('for_each' in step) yield* bare(`${at}.for_each`, step.for_each);
      if ('until' in step) yield* bare(`${at}.until`, step.until);
      if (Array.isArray(step.switch)) for (const [index, option] of step.switch.entries()) yield* bare(`${at}.switch[${index}].when`, option?.when);
      if (object(step.choose)) {
        if ('input' in step.choose) yield* text(`${at}.choose.input`, step.choose.input);
        if ('until' in step.choose) yield* bare(`${at}.choose.until`, step.choose.until);
      }
      if (object(step.repeat)) {
        if ('until' in step.repeat) yield* bare(`${at}.repeat.until`, step.repeat.until);
        if (object(step.repeat.step)) yield* scope({ step: step.repeat.step }, `${at}.repeat.`);
      }
      if (object(step.group)) yield* scope(step.group.steps, `${at}.group.`);
    }
  }
  yield* scope(data.steps, 'steps.');
}

function* steps(map) {
  for (const step of Object.values(map ?? {})) {
    if (!object(step)) continue;
    yield step;
    if (object(step.group)) yield* steps(step.group.steps);
    if (object(step.repeat?.step)) yield* steps({ step: step.repeat.step });
  }
}

class StepFailure extends Error {
  constructor(message, { code = 'STEP_FAILED', result = null, timedOut = false } = {}) {
    super(message);
    Object.assign(this, { code, result, timedOut });
  }
}

export class FlowExecution {
  constructor(runtime, record, artifact) {
    this.runtime = runtime; this.record = record; this.artifact = artifact;
    this.document = artifact.document;
    this.queue = runtime.environments.queue(record.environment);
    this.events = []; this.pending = new Set(); this.waiters = new Map();
    this.abort = new AbortController(); this.scheduled = null; this.saving = 0;
    this.stepControllers = new WeakMap(); this.working = 0; this.idle = 0;
    // SendMessage accepts the messages a wait step names.
    this.index = new Map();
    for (const file of Object.values(this.document.files)) {
      for (const step of steps(file.data.steps)) if (typeof step.wait === 'string') this.index.set(step.wait, { $type: 'asys:Wait' });
    }
    // The runtime drives BPMN and workflow/1 executions through this object.
    this.definition = {
      run: () => this.start(),
      recover: state => { this.state = clone(state); return { resume: () => this.drive() }; },
      stop: () => this.abort.abort(new Error('Run stopped')),
    };
  }

  start() {
    const root = this.document.files[this.document.root].data;
    this.state = { sequence: 0, frames: {} };
    this.state.root = this.frame(null, { file: this.document.root, path: [] }, root.start, this.record.variables).id;
    this.drive();
  }

  drive() {
    this.track((async () => {
      try {
        const root = this.state.frames[this.state.root];
        const result = await this.runFrame(root);
        if (TERMINAL.has(this.record.status)) return;
        this.record.status = 'completed';
        this.record.output = copy(result);
        this.event('run.completed', '', { end: root.ended ?? null });
      } catch (error) {
        if (!this.abort.signal.aborted) this.fatal(error);
      }
    })());
  }

  // Frames

  frame(parent, scope, cursor, variables, extra = {}) {
    const id = `f${++this.state.sequence}`;
    this.state.frames[id] = { id, parent: parent?.id ?? null, scope, cursor, variables: copy(variables ?? {}),
      locals: {}, status: 'running', visits: {}, completed: [], ...extra };
    return this.state.frames[id];
  }

  owner(frame) { return frame.shares ? this.state.frames[frame.shares] : frame; }

  scopeSteps(scope) {
    let map = this.document.files[scope.file].data.steps;
    for (const part of scope.path) {
      const step = map[part];
      map = object(step?.group) ? step.group.steps : object(step?.repeat) ? { step: step.repeat.step } : null;
      if (!map) throw new Error(`${scope.file}: no scope ${scope.path.join('/')}`);
    }
    return map;
  }

  async runFrame(frame) {
    const map = this.scopeSteps(frame.scope);
    try {
      while (frame.status === 'running' && frame.cursor) {
        this.abort.signal.throwIfAborted();
        const name = frame.cursor, step = map[name];
        if (!object(step)) throw new Error(`${frame.scope.file}: no step ${name}`);
        if (!frame.step) {
          frame.visits[name] = (frame.visits[name] ?? 0) + 1;
          frame.step = { name, kind: KINDS.find(key => key in step), visit: frame.visits[name] };
          this.stepEvent('step.started', frame, name, { kind: frame.step.kind, visit: frame.step.visit });
          await this.checkpoint();
        }
        let outcome;
        try {
          outcome = await this.withTimeout(frame, name, step, () => this.runStep(frame, name, step));
        } catch (error) {
          if (this.abort.signal.aborted || frame.status !== 'running') throw error;
          const target = error.timedOut ? step.on_timeout ?? step.on_error : step.on_error;
          this.stepEvent('step.failed', frame, name, { ...errorRecord(error), next: target ?? null });
          if (!target) throw error;
          this.setResult(frame, name, { ...(object(error.result) ? error.result : {}), exception: error.message }, step.result);
          this.advance(frame, target);
          await this.checkpoint();
          continue;
        }
        if (frame.status !== 'running') break;
        if ('end' in outcome) {
          this.stepEvent('step.completed', frame, name, { end: outcome.end });
          frame.ended = outcome.end;
          frame.status = 'completed';
          delete frame.step;
          break;
        }
        if ('result' in outcome) {
          this.setResult(frame, name, outcome.result, step.result);
          frame.result = copy(outcome.result);
          if (step.undo) {
            const owner = this.owner(frame);
            owner.completed = [...owner.completed.filter(done => done !== name), name];
          }
        }
        this.stepEvent('step.completed', frame, name, { next: outcome.next ?? null });
        this.advance(frame, outcome.next ?? null);
        await this.checkpoint();
      }
      if (frame.status === 'running') frame.status = 'completed';
    } catch (error) {
      if (frame.status === 'running' && !this.abort.signal.aborted) {
        frame.status = 'failed';
        frame.error = errorRecord(error);
        await this.checkpoint();
      }
      throw error;
    }
    await this.checkpoint();
    return frame.output !== undefined ? frame.output : frame.result ?? null;
  }

  advance(frame, cursor) {
    frame.cursor = cursor;
    delete frame.step;
  }

  async runStep(frame, name, step) {
    const { kind } = frame.step;
    if ('for_each' in step && ['run', 'group', 'call'].includes(kind)) return { result: await this.forEach(frame, name, step), next: step.next };
    switch (kind) {
      case 'run': return { result: await this.job(frame, name, step, this.context(frame)), next: step.next };
      case 'parallel':
        await this.parallel(frame, step);
        return { next: step.join };
      case 'group': {
        const child = await this.child(frame, 'group', this.inner(frame, name), step.group.start);
        return { result: copy(child.variables), next: step.next };
      }
      case 'call': return { result: await this.call(frame, name, step, this.context(frame), 'call'), next: step.next };
      case 'switch': {
        const context = this.context(frame);
        const chosen = step.switch.find(option => this.condition(option.when, context));
        return { next: chosen ? chosen.next : step.default };
      }
      case 'repeat': return { result: await this.repeat(frame, name, step), next: step.next };
      case 'choose': return { result: await this.choose(frame, name, step), next: step.next };
      case 'wait': return { result: await this.wait(frame, step), next: step.next };
      case 'delay':
        await this.delay(frame, step.delay);
        return { result: null, next: step.next };
      case 'compensate':
        await this.compensate(frame, step.compensate);
        return { next: step.next };
      case 'end': {
        if (!frame.scope.path.length && (frame.id === this.state.root || frame.call)) {
          const output = this.document.files[frame.scope.file].data.output;
          if (output !== undefined) frame.output = this.value(output, this.context(frame), { bare: true });
        }
        return { end: step.end };
      }
      default: throw new Error(`${name}: not a step kind this engine runs`);
    }
  }

  inner(frame, name) { return { file: frame.scope.file, path: [...frame.scope.path, name] }; }

  // A composite step records its children in frame.step, so recovery returns
  // to the same children instead of starting new ones.
  async child(frame, key, scope, cursor, { variables = {}, ...extra } = {}) {
    frame.step.children ??= {};
    let id = frame.step.children[key];
    if (!id) {
      id = this.frame(frame, scope, cursor, variables, extra).id;
      frame.step.children[key] = id;
      await this.checkpoint();
    }
    return this.settle(this.state.frames[id]);
  }

  // Run CHILD to its end, or report how it ended earlier.
  async settle(child) {
    if (child.status === 'running') await this.runFrame(child);
    if (child.status === 'completed') return child;
    throw new StepFailure(child.error?.message ?? `${this.activityId(child, child.cursor ?? '')} was ${child.status}`, child.error ?? {});
  }

  result(child) { return copy(child.output !== undefined ? child.output : child.result); }

  async parallel(frame, step) {
    // Branches are steps of this scope: their results are recorded here.
    const owner = this.owner(frame);
    if (!frame.step.branches) {
      frame.step.branches = step.parallel.map(branch => this.frame(frame, frame.scope, branch, {}, { shares: owner.id }).id);
      await this.checkpoint();
    }
    await this.all(frame, frame.step.branches.map(id => this.state.frames[id]).map(branch => () => this.settle(branch)));
  }

  // Run TASKS together. The first failure cancels the others; it is the error
  // reported once every task has settled. STOP ends early without failing.
  async all(frame, tasks, { stopped = () => false } = {}) {
    let failure;
    const runs = tasks.map(task => Promise.resolve().then(task).catch(async error => {
      if (this.abort.signal.aborted) { failure ??= error; return; }
      if (failure || stopped()) return;
      failure = error;
      await this.cancelChildren(frame);
    }));
    await Promise.all(runs);
    if (failure) throw failure;
  }

  async call(frame, name, step, context, key) {
    const target = this.document.files[frame.scope.file].calls?.[step.call];
    if (!target) throw new Error(`${name}: ${step.call} was not resolved when the workflow was loaded`);
    const callee = this.document.files[target].data;
    const child = await this.child(frame, key, { file: target, path: [] }, callee.start,
      { variables: this.value(copy(step.input ?? {}), context), call: name });
    return this.result(child);
  }

  async forEach(frame, name, step) {
    const context = this.context(frame);
    // The list is fixed when the step starts, so recovery sees the same items.
    if (!frame.step.items) {
      const items = this.value(step.for_each, context, { bare: true });
      if (!Array.isArray(items)) throw new Error(`${name}: for_each must produce a list`);
      frame.step.items = copy(items);
      frame.step.results = {};
      await this.checkpoint();
    }
    const { items, results } = frame.step;
    const as = step.as ?? 'item';
    const finished = () => items.flatMap((_, index) => index in results ? [results[index]] : []);
    const satisfied = () => step.until !== undefined && this.condition(step.until, { ...this.context(frame), [name]: finished() });
    const one = async index => {
      if (index in results) return;
      const locals = { [as]: items[index], index: index + 1 };
      let result;
      if ('run' in step) result = await this.job(frame, name, step, { ...context, ...locals }, { item: index + 1 });
      else if ('call' in step) result = await this.call(frame, name, step, { ...context, ...locals }, `item:${index}`);
      else result = copy((await this.child(frame, `item:${index}`, this.inner(frame, name), step.group.start, { locals })).variables);
      results[index] = copy(result);
      await this.checkpoint();
    };
    if (step.sequential) {
      for (let index = 0; index < items.length && !frame.step.stopped; index++) {
        await one(index);
        if (satisfied()) frame.step.stopped = true;
      }
    } else {
      await this.all(frame, items.map((_, index) => async () => {
        await one(index);
        if (!frame.step.stopped && satisfied()) {
          frame.step.stopped = true;
          await this.checkpoint();
          await this.cancelChildren(frame);
        }
      }), { stopped: () => frame.step.stopped });
    }
    return finished();
  }

  async repeat(frame, name, step) {
    const { until, max } = step.repeat;
    frame.step.iteration ??= 1;
    for (;;) {
      const child = await this.child(frame, `iteration:${frame.step.iteration}`, this.inner(frame, name), 'step');
      const result = copy(child.variables.step);
      this.setResult(frame, name, result);
      if (until !== undefined && this.condition(until, { ...this.context(frame), step: result })) return result;
      if (max !== undefined && frame.step.iteration >= max) return result;
      frame.step.iteration += 1;
      await this.checkpoint();
    }
  }

  async wait(frame, step) {
    const state = frame.step;
    if (!('message' in state)) {
      const signal = this.stepSignal(frame);
      await new Promise((resolve, reject) => {
        const waiter = { state, resolve };
        const list = this.waiters.get(step.wait) ?? [];
        list.push(waiter);
        this.waiters.set(step.wait, list);
        signal.addEventListener('abort', () => { this.unwait(step.wait, waiter); reject(signal.reason); }, { once: true });
        const pending = Object.entries(this.record.messages).find(([, message]) => !message.applied && message.target === step.wait);
        if (pending) this.deliver(pending[0]);
        else {
          this.stepEvent('step.waiting', frame, state.name, { reason: `message ${step.wait}` });
          this.schedule();
        }
      });
    }
    return copy(state.message);
  }

  // A message is applied in the same change that records it on its step.
  deliver(id) {
    const message = this.record.messages[id];
    if (message.applied) return;
    const waiter = this.waiters.get(message.target)?.[0];
    if (!waiter) return;  // applied when a step waits for it
    this.unwait(message.target, waiter);
    message.applied = true;
    waiter.state.message = copy(message.payload);
    this.stepEvent('message.applied', null, waiter.state.name, { id, target: message.target });
    waiter.resolve();
    this.schedule();
  }

  unwait(target, waiter) {
    const list = (this.waiters.get(target) ?? []).filter(other => other !== waiter);
    if (list.length) this.waiters.set(target, list);
    else this.waiters.delete(target);
  }

  async delay(frame, duration) {
    frame.step.until ??= Date.now() + milliseconds(duration);
    await this.checkpoint();
    const remaining = frame.step.until - Date.now();
    if (remaining <= 0) return;
    this.stepEvent('step.waiting', frame, frame.step.name, { reason: `timer until ${new Date(frame.step.until).toISOString()}` });
    this.idle++;
    this.schedule();
    try { await sleep(remaining, undefined, { signal: this.stepSignal(frame) }); }
    finally { this.idle--; }
  }

  async withTimeout(frame, name, step, action) {
    if (!step.timeout) return action();
    frame.step.deadline ??= Date.now() + milliseconds(step.timeout);
    const timer = new AbortController();
    const work = action();
    const expired = sleep(Math.max(0, frame.step.deadline - Date.now()), undefined, { signal: timer.signal })
      .then(() => { throw new StepFailure(`${name} timed out after ${step.timeout}`, { code: 'TIMEOUT', timedOut: true }); });
    expired.catch(() => {});
    try {
      return await Promise.race([work, expired]);
    } catch (error) {
      if (error.timedOut) {
        await this.cancelChildren(frame);
        await work.catch(() => {});
      }
      throw error;
    } finally {
      timer.abort();
    }
  }

  async compensate(frame, which) {
    const owner = this.owner(frame);
    const map = this.scopeSteps(frame.scope);
    frame.step.undo ??= which === 'all' ? [...owner.completed].reverse() : [which];
    for (const done of frame.step.undo) {
      if (map[done]?.undo) await this.child(frame, `undo:${done}`, frame.scope, map[done].undo, { shares: owner.id });
      owner.completed = owner.completed.filter(name => name !== done);
      await this.checkpoint();
    }
  }

  // choose: a coordinator job selects actions through the protocol of BPMN
  // ad-hoc subprocesses: it writes requests to actions/requests in its job
  // directory, and reads results/ID.json and state.json.
  async choose(frame, name, step) {
    const spec = step.choose, map = this.scopeSteps(frame.scope);
    const state = frame.step;
    state.actions ??= {};
    const entries = spec.actions.map(action => ({ id: action, name: action, description: map[action]?.description ?? '',
      inputPaths: [...new Set(['input', 'args'].flatMap(key => expressionsIn(map[action]?.[key]).flatMap(messagePaths)))].sort() }));
    const running = new Map();
    const busy = () => Object.values(state.actions).filter(action => action.status === 'running');
    const available = id => !state.finishing && !busy().some(action => action.request.action === id) && !(spec.sequential && busy().length);
    const lists = () => Object.fromEntries(spec.actions.map(action => [action, Object.values(state.actions)
      .filter(entry => entry.request.action === action && entry.status === 'completed').map(entry => copy(entry.result))]));
    const start = (id, action) => {
      const child = this.state.frames[action.child];
      running.set(id, (child.status === 'running' ? this.runFrame(child) : Promise.resolve()).then(() => {
        Object.assign(action, { status: 'completed', result: this.result(child) });
      }, error => {
        if (!state.finishing) Object.assign(action, { status: 'failed', error: error.message });
        else Object.assign(action, { status: 'cancelled' });
      }).finally(() => { running.delete(id); this.schedule(); }));
    };
    for (const [id, action] of Object.entries(state.actions)) if (action.status === 'running') start(id, action);

    let outcome;
    const coordinator = this.job(frame, name, { run: spec.coordinator, input: spec.input ?? {} }, this.context(frame),
      { metadata: { actions: { version: 1, entries } } });
    coordinator.then(result => { outcome = { result }; }, error => { outcome = { error }; });
    let directory;
    const published = new Map();
    const publish = async (path, value) => {
      const text = JSON.stringify(value);
      if (published.get(path) === text) return;
      await this.flush();
      await writeJSON(path, value);
      published.set(path, text);
    };
    const signal = this.stepSignal(frame);
    try {
      for (;;) {
        signal.throwIfAborted();
        const job = this.record.jobs[this.jobKey(frame, name)];
        if (!directory && ['submitted', 'completed'].includes(job?.status)) {
          directory = join((await this.queue.paths(job.id)).directory, 'actions');
          for (const sub of ['requests', 'results']) makeDirectory(join(directory, sub), { recursive: true, mode: 0o700 });
        }
        if (directory) {
          await this.requests(frame, directory, state, map, spec.actions, available, start, publish);
          for (const [id, action] of Object.entries(state.actions)) {
            const { child: _child, ...visible } = action;
            await publish(join(directory, 'results', `${id}.json`), visible);
          }
          await publish(join(directory, 'state.json'), {
            entries: entries.map(entry => ({ ...entry, available: available(entry.id) })),
            running: busy().map(action => action.request.action),
            actions: Object.fromEntries(Object.entries(state.actions).map(([id, action]) => [id, { action: action.request.action, status: action.status }])),
          });
        }
        const failed = Object.values(state.actions).find(action => action.status === 'failed' && action.child);
        if (failed) throw new StepFailure(`${name}: action ${failed.request.action} failed: ${failed.error}`);
        if (outcome?.error && !state.finishing) throw outcome.error;
        if (!state.finishing && (spec.until === undefined ? outcome : this.condition(spec.until, { ...this.context(frame), ...lists() }))) {
          state.finishing = true;
          await this.checkpoint();
        }
        if (state.finishing) {
          if (!outcome) await this.cancelJob(job);
          if (!spec.sequential) await this.cancelChildren(frame, { only: key => key.startsWith('action:') });
          if (!running.size && outcome) {
            return { ...lists(), report: outcome.result ?? null };
          }
        } else if (outcome && !running.size) {
          throw new StepFailure(`${name}: the coordinator finished before its until condition held`);
        }
        await sleep(POLL, undefined, { signal });
      }
    } finally {
      await Promise.allSettled([coordinator, ...running.values()]);
    }
  }

  async requests(frame, directory, state, map, actions, available, start, publish) {
    for (const file of (await readdir(join(directory, 'requests'))).sort()) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u.test(file)) continue;
      const id = file.slice(0, -5);
      let request;
      try {
        request = await readJSON(join(directory, 'requests', file));
        const existing = state.actions[id];
        if (existing) {
          if (!isDeepStrictEqual(existing.request, request)) {
            await publish(join(directory, 'results', file), { request, status: 'failed', error: 'Action ID already has a different request' });
          }
          continue;
        }
        if (state.finishing) throw new Error('The choose step is finishing');
        if (!object(request) || request.id !== id || !actions.includes(request.action)) throw new Error('Unknown action');
        if (!available(request.action)) throw new Error('Action is not available; wait for running work to finish');
        // A tool call is a proposal: reject input the action cannot use, so the
        // coordinator can correct its call.
        const action = map[request.action];
        const locals = { message: copy(request.input) };
        this.value(copy(action.input ?? {}), { ...this.context(frame), ...locals });
        const child = this.frame(frame, frame.scope, request.action, {}, { shares: this.owner(frame).id, locals });
        frame.step.children ??= {};
        frame.step.children[`action:${id}`] = child.id;
        state.actions[id] = { request: copy(request), status: 'running', child: child.id };
        await this.checkpoint();
        start(id, state.actions[id]);
      } catch (error) {
        if (this.runtime.store.failure || this.abort.signal.aborted) throw error;
        state.actions[id] = { request: copy(request ?? { id }), status: 'failed', error: error.message };
        await this.checkpoint();
      }
    }
  }

  // Jobs. A job is recorded before it is submitted, and a recorded job is
  // waited for, never resubmitted, so recovery runs no work twice.

  jobKey(frame, name, item) { return `${frame.id}:${name}${item ? `#${item}` : ''}:${frame.step.visit}`; }

  async job(frame, name, step, context, { metadata = {}, item } = {}) {
    const key = this.jobKey(frame, name, item);
    let job = this.record.jobs[key];
    if (!job) {
      const input = this.value(copy(step.input ?? {}), context);
      const args = this.value(copy(step.args ?? []), context);
      if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error(`${name}: args must be strings`);
      const activity = this.activityId(frame, name);
      job = this.record.jobs[key] = { id: randomUUID().replaceAll('-', ''), activityId: activity, type: step.run, args, input,
        status: 'publishing', metadata: { name, workflow_id: this.record.workflowId, run_id: this.record.id,
          environment: this.record.environment, activity_id: activity, execution_id: key, file: frame.scope.file,
          ...(item && { item }), ...metadata } };
      this.event('job.created', activity, { jobId: job.id, type: job.type, executionId: key, frame: frame.id, workspace: this.record.workspace });
      await this.checkpoint();
    }
    if (job.status === 'completed') return copy(job.result);
    if (job.status === 'failed') throw new StepFailure(job.error.message, { code: job.error.code, result: job.result });
    const descriptor = await this.runtime.environments.get(this.record.environment);
    if (!descriptor.types.includes(job.type)) throw new Error(`Environment ${this.record.environment} no longer defines job type ${job.type}`);
    if (job.status === 'publishing') {
      const directory = join(this.runtime.jobRoot, job.id);
      makeDirectory(directory, { recursive: true, mode: 0o700 });
      await this.queue.submit(job.type, job.id, { directory, workspace: this.record.workspace, args: job.args, input: job.input, metadata: job.metadata });
      job.status = 'submitted';
      await this.checkpoint();
      if (job.cancelRequested) await this.queue.cancel(job.id);
    }
    this.working++;
    this.schedule();
    let outcome;
    try { outcome = await this.queue.wait(job.id, { signal: this.abort.signal }); }
    finally { this.working--; }
    if (outcome.status !== 'done') {
      const message = outcome.error ?? `Job ${job.id} ${outcome.status}`;
      const result = { ...(object(outcome.result) ? clone(outcome.result) : {}), exception: message };
      // A job that fails on its own leaves a checkpoint from before its failure,
      // as BPMN runs do: asys-run --resume submits it again under a new ID.
      if (!job.cancelRequested) {
        const { recovery: _previous, ...point } = this.record;
        this.recovery = clone({ ...point, definition: this.state });
      }
      Object.assign(job, { status: 'failed', result,
        error: errorRecord(Object.assign(new Error(message), { code: String(outcome.exit_code ?? outcome.status) })) });
      this.event('job.failed', job.activityId, { jobId: job.id, executionId: key, ...job.error });
      await this.checkpoint();
      throw new StepFailure(message, { code: job.error.code, result });
    }
    Object.assign(job, { status: 'completed', result: outcome.result ?? null });
    this.event('job.completed', job.activityId, { jobId: job.id, executionId: key });
    await this.checkpoint();
    return copy(job.result);
  }

  async cancelJob(job) {
    if (!job || ['completed', 'failed'].includes(job.status) || job.cancelRequested) return;
    job.cancelRequested = true;
    await this.checkpoint();
    if (job.status === 'submitted') await this.queue.cancel(job.id);
  }

  cancelJobs() { return Promise.all(Object.values(this.record.jobs).map(job => this.cancelJob(job))); }

  // Cancel what FRAME's current step started: its jobs, waits and timers, and
  // every child frame with what it started in turn. ONLY limits the
  // cancellation to the children whose keys it selects.
  async cancelChildren(frame, { only } = {}) {
    if (!frame.step) return;
    if (!only) {
      this.stepControllers.get(frame.step)?.abort(new StepFailure('Step cancelled', { code: 'CANCELLED' }));
      const { name, visit } = frame.step;
      const mine = new RegExp(`^${frame.id}:${name}(#\\d+)?:${visit}$`, 'u');
      await Promise.all(Object.entries(this.record.jobs).filter(([key]) => mine.test(key)).map(([, job]) => this.cancelJob(job)));
    }
    const ids = [...(only ? [] : frame.step.branches ?? []),
      ...Object.entries(frame.step.children ?? {}).filter(([key]) => !only || only(key)).map(([, id]) => id)];
    for (const id of ids) {
      const child = this.state.frames[id];
      if (child?.status !== 'running') continue;
      child.status = 'cancelled';
      await this.cancelChildren(child);
    }
    await this.checkpoint();
  }

  stepSignal(frame) {
    let controller = this.stepControllers.get(frame.step);
    if (!controller) this.stepControllers.set(frame.step, controller = new AbortController());
    return AbortSignal.any([this.abort.signal, controller.signal]);
  }

  // Values

  context(frame) {
    const chain = [];
    for (let current = frame; current; current = current.parent && !current.call ? this.state.frames[current.parent] : null) chain.unshift(current);
    return Object.assign({}, ...chain.flatMap(current => [this.owner(current).variables, current.locals]));
  }

  /* A result is stored under its step's ID and, with result:, under that
   * shared name too, which several steps may update. */
  setResult(frame, name, value, shared) {
    const owner = this.owner(frame);
    owner.variables[name] = copy(value);
    if (shared) owner.variables[shared] = copy(value);
    if (owner.id === this.state.root) this.record.variables = clone(owner.variables);
  }

  value(value, context, { bare = false } = {}) {
    if (typeof value === 'string') {
      const trimmed = value.trim(), found = spans(trimmed);
      // Exactly one expression keeps its value's type; text interpolates.
      if (found.length === 1 && found[0].start === 0 && found[0].end === trimmed.length) return feel(found[0].expression, context);
      if (bare && !found.length) return feel(value, context);
      let result = '', last = 0;
      for (const { start, end, expression } of spans(value)) {
        result += value.slice(last, start) + text(feel(expression, context));
        last = end;
      }
      return result + value.slice(last);
    }
    if (Array.isArray(value)) return value.map(item => this.value(item, context));
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.value(item, context)]));
    return value;
  }

  condition(expression, context) {
    const result = this.value(String(expression), context, { bare: true });
    if (typeof result !== 'boolean') throw new Error(`${expression} did not produce true or false`);
    return result;
  }

  // Step IDs as viewers address them: the path inside the step's file.
  activityId(frame, name) { return [...frame.scope.path, name].join('/'); }

  stepEvent(type, frame, name, data = {}) {
    const where = frame ? { frame: frame.id, file: frame.scope.file } : {};
    this.event(type, frame ? this.activityId(frame, name) : name, { ...where, ...data });
  }

  // Persistence, as for BPMN executions.

  track(promise) {
    this.pending.add(promise);
    promise.finally(() => { this.pending.delete(promise); this.schedule(); }).catch(() => {});
    return promise;
  }

  event(type, activityId = '', data = {}) { this.events.push({ type, activityId, data, time: now() }); }

  schedule() {
    if (this.runtime.store.failure) return;
    this.scheduled ??= Promise.resolve().then(() => { this.scheduled = null; return this.checkpoint(); });
    this.scheduled.catch(error => { if (!this.runtime.store.failure) this.fatal(error); });
  }

  async flush() { await this.scheduled; await this.checkpoint(); }

  async checkpoint() {
    if (this.state) this.record.definition = clone(this.state);
    if (!TERMINAL.has(this.record.status)) this.record.status = !this.working && (this.waiters.size || this.idle) ? 'waiting' : 'running';
    this.record.updatedAt = now();
    const events = this.events;
    this.events = [];
    this.saving++;
    try { await this.runtime.store.save(this.record, events); }
    finally { this.saving--; }
    if (TERMINAL.has(this.record.status) && !this.runtime.closing && !this.pending.size && !this.scheduled && !this.saving) {
      this.runtime.active.delete(this.record.id);
    }
  }

  fatal(error) {
    if (TERMINAL.has(this.record.status)) return;
    this.record.status = 'failed'; this.record.error = errorRecord(error);
    if (this.recovery) this.record.recovery = this.recovery;
    this.abort.abort(error);
    this.event('run.failed', '', this.record.error);
    this.track(this.cancelJobs());
    this.schedule();
  }
}

// Each `${...}` in TEXT. Braces nest, so `${{a: 1}}` holds a FEEL context;
// quoted strings may contain any character; an unclosed `${` is plain text.
export function spans(text) {
  const found = [];
  let position = 0, start;
  while ((start = text.indexOf('${', position)) >= 0) {
    let depth = 1, index = start + 2, quoted = false;
    for (; index < text.length && depth; index++) {
      const char = text[index];
      if (quoted) {
        if (char === '\\') index++;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}') depth--;
    }
    if (depth) break;
    found.push({ start, end: index, expression: text.slice(start + 2, index - 1) });
    position = index;
  }
  return found;
}

function expressionsIn(value) {
  if (typeof value === 'string') return spans(value).map(span => span.expression);
  if (Array.isArray(value)) return value.flatMap(expressionsIn);
  if (object(value)) return Object.values(value).flatMap(expressionsIn);
  return [];
}

function text(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function milliseconds(duration) {
  const match = String(duration).match(/^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/u);
  if (!match || duration === 'P' || String(duration).endsWith('T')) throw new Error(`Invalid duration ${duration}`);
  const [years, months, weeks, days, hours, minutes, seconds] = match.slice(1).map(part => Number(part ?? 0));
  return ((((years * 365 + months * 30 + weeks * 7 + days) * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}
