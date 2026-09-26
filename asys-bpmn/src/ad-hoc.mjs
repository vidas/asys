import { makeDirectory } from '../../asys-runtime/javascript/permissions.mjs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { readJSON, writeJSON } from '../../asys-runtime/javascript/queue.mjs';
import { clone } from './values.mjs';
import { messagePaths, valueOf } from './expressions.mjs';
import { adHocActions } from './bpmn.mjs';

export class AdHoc {
  constructor(execution, activity, message, signal) {
    this.execution = execution;
    this.activity = activity;
    this.message = message;
    this.signal = signal;
    this.id = message.content.executionId;
    this.scope = execution.index.get(activity.behaviour.asysCoordinator);
    execution.record.controllers ??= {};
    this.record = execution.record.controllers[this.id] ??= { actions: {}, enabled: {} };
    this.record.enabled ??= {};
    this.targets = new Set((this.scope.flowElements ?? []).filter(e => e.$type === 'bpmn:SequenceFlow').map(e => e.targetRef.$ref));
    this.entries = adHocActions(this.scope, execution.artifact.bindings).map(e => ({ id: e.id, name: e.name ?? e.id, description: (e.documentation ?? []).map(d => d.text).join('\n'),
      inputPaths: [...new Set(['input', 'args'].flatMap(key => {
        const expression = execution.artifact.bindings[e.id]?.[key];
        return expression ? messagePaths(expression) : [];
      }))].sort(),
    }));
    execution.controllers.set(activity.context, this);
    for (const pending of execution.enabled.get(activity.context) ?? []) this.enable(pending.activityId, pending.content);
    execution.enabled.delete(activity.context);
    this.published = new Map();
    if (Object.values(this.record.actions).some(action => action.status === 'completed')) this.complete();
  }
  children() { return this.activity.context.getActivities(this.scope.id).filter(a => a.id !== this.activity.id); }
  enable(id, content) {
    this.record.enabled[id] ??= [];
    this.record.enabled[id].push(clone(content));
    this.execution.schedule();
  }
  complete() {
    const condition = this.scope.completionCondition?.body;
    if (!condition || this.record.finishing) return;
    const result = valueOf(`= ${condition}`, this.activity.environment, {});
    if (typeof result !== 'boolean') throw new Error(`${this.scope.id}: ad-hoc completion condition must be boolean`);
    if (result) this.record.finishing = true;
  }
  available(id) {
    const activity = this.activity.context.getActivityById(id);
    return !this.record.finishing && !activity.isRunning && (!this.targets.has(id) || Boolean(this.record.enabled[id]?.length))
      && (this.scope.ordering !== 'Sequential' || !this.children().some(a => a.isRunning));
  }
  async publish(path, value) {
    const text = JSON.stringify(value);
    if (this.published.get(path) === text) return;
    await this.execution.flush();
    await writeJSON(path, value);
    this.published.set(path, text);
  }
  async run(callback) {
    const jobAbort = new AbortController();
    const signal = AbortSignal.any([this.signal, this.execution.abort.signal]);
    let outcome;
    const pending = this.execution.job(this.activity, this.message, (error, result) => { outcome = { error, result }; },
      AbortSignal.any([signal, jobAbort.signal]), { metadata: { actions: { version: 1, entries: this.entries } } });
    pending.catch(error => { outcome = { error }; });
    try {
      for (;;) {
        signal.throwIfAborted();
        const job = this.execution.record.jobs[this.id];
        if (job?.status === 'submitted' || job?.status === 'completed') {
          this.directory ??= join((await this.execution.queue.paths(job.id)).directory, 'actions');
          makeDirectory(join(this.directory, 'requests'), { recursive: true, mode: 0o700 });
          makeDirectory(join(this.directory, 'results'), { recursive: true, mode: 0o700 });
          await this.requests();
          for (const [id, action] of Object.entries(this.record.actions)) await this.publish(join(this.directory, 'results', `${id}.json`), action);
          await this.publish(join(this.directory, 'state.json'), { entries: this.entries.map(entry => ({ ...entry, available: this.available(entry.id) })),
            running: this.children().filter(a => a.isRunning).map(a => a.id),
            actions: Object.fromEntries(Object.entries(this.record.actions).map(([id, action]) => [id, { action: action.request.action, status: action.status }])),
          });
        }
        if (outcome?.error) throw outcome.error;
        if (!this.scope.completionCondition && outcome) this.record.finishing = true;
        if (this.record.finishing) {
          if (!outcome) {
            jobAbort.abort(new Error('Ad-hoc completion condition satisfied'));
            await this.execution.cancelJob(this.id);
          }
          const busy = this.children().filter(a => a.isRunning);
          if (this.scope.ordering !== 'Sequential' && this.scope.cancelRemainingInstances !== false) for (const child of busy) child.getApi().discard();
          if (!this.children().some(a => a.isRunning)) {
            await this.execution.flush();
            callback(null, outcome?.result ?? null);
            return;
          }
        } else if (outcome && !this.children().some(a => a.isRunning)) {
          throw new Error(`${this.scope.id}: coordinator finished before its completion condition was satisfied`);
        }
        await setTimeout(50, undefined, { signal });
      }
    } catch (error) {
      if (this.execution.runtime.store.failure) throw error;
      if (!signal.aborted) callback(error);
    } finally {
      jobAbort.abort(new Error('Ad-hoc coordinator stopped'));
      await pending;
      this.execution.controllers.delete(this.activity.context);
    }
  }
  async requests() {
    for (const file of (await readdir(join(this.directory, 'requests'))).sort()) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u.test(file)) continue;
      const id = file.slice(0, -5);
      let request;
      try {
        request = await readJSON(join(this.directory, 'requests', file));
        this.signal.throwIfAborted();
        this.execution.abort.signal.throwIfAborted();
        const existing = this.record.actions[id];
        if (existing) {
          if (!isDeepStrictEqual(existing.request, request)) {
            await this.publish(join(this.directory, 'results', file), { request, status: 'failed', error: 'Action ID already has a different request' });
            continue;
          }
          if (existing.status !== 'starting') continue;
        }
        if (this.record.finishing) throw new Error('Ad-hoc subprocess is completing');
        if (!request || request.id !== id || !this.entries.some(e => e.id === request.action)) throw new Error('Unknown or unavailable action');
        const activity = this.activity.context.getActivityById(request.action);
        if (!existing && !this.available(request.action)) throw new Error('Action is not enabled; wait for its prerequisites or active work');
        const runContent = existing?.runContent ?? this.record.enabled[request.action]?.[0] ?? {};
        // A tool call is still a proposal here. Reject malformed input before
        // starting the BPMN activity, so the coordinator can correct its call.
        // Loop bindings need their instance data, which is assigned by BPMN
        // when execution begins, and cannot be evaluated at this boundary.
        if (!existing && this.execution.artifact.bindings[request.action] && !activity.behaviour.loopCharacteristics) {
          this.execution.jobValues(activity, { ...runContent, id: activity.id, message: request.input ?? null }, { checkTypes: true });
        }
        if (!existing?.runContent) this.record.enabled[request.action]?.shift();
        this.record.actions[id] = { request: clone(request), status: 'starting', runContent };
        await this.execution.checkpoint();
        activity.run({ ...runContent, message: clone(request.input ?? null), asysController: this.id, asysAction: id });
        await this.execution.checkpoint();
      } catch (error) {
        if (this.execution.runtime.store.failure) throw error;
        if (this.signal.aborted || this.execution.abort.signal.aborted) throw error;
        if (this.record.actions[id]?.status === 'running') throw error;
        this.record.actions[id] = { request: request ?? { id }, status: 'failed', error: error.message };
        await this.execution.checkpoint();
      }
    }
  }
}

export function actionEvent(execution, activity, key, content) {
  const action = execution.record.controllers?.[content.asysController]?.actions[content.asysAction];
  if (!action || action.request.action !== activity.id) return;
  if (key === 'activity.enter') { action.status = 'running'; action.executionId = content.executionId; }
  if (key === 'activity.end') { action.status = 'completed'; action.result = clone(content.output ?? null); }
  // Discarding active work emits execution.discard; activity.discard applies
  // to work discarded before execution. Contract P13 pins both paths.
  if (['activity.discard', 'activity.execution.discard', 'activity.execution.cancel'].includes(key)) {
    action.status = 'failed'; action.error = 'Action discarded';
  }
}
