import { makeDirectory } from '../../asys-runtime/javascript/permissions.mjs';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as Elements from 'bpmn-elements';
import { Code, ConnectError } from '@connectrpc/connect';
import { parseWorkflow, indexElements, requiredJobTypes } from './bpmn.mjs';
import { environmentName } from '../../asys-runtime/javascript/environments.mjs';
import { ENGINE, prepareEngine, executionContext } from './engine.mjs';
import { expressions, scripts, feel, contextOf } from './expressions.mjs';
import { clone, digest, errorRecord, object, parseJSON, requiredString, variables, publicVariables } from './values.mjs';
import { AdHoc, actionEvent } from './ad-hoc.mjs';
import { applyOutput, dataValue, inputValues } from './data.mjs';
import { FORMAT as FLOW_FORMAT, FLOW_ENGINE, FlowExecution, flowArtifact, flowJobTypes } from './flow.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const now = () => new Date().toISOString();
const fail = (message, code = Code.InvalidArgument) => { throw new ConnectError(message, code); };

export class WorkflowRuntime {
  constructor({ store, environments, workspace = join(dirname(environments.root), 'workspace') }) {
    this.store = store;
    this.environments = environments;
    this.jobRoot = join(dirname(environments.root), 'jobs');
    this.workspace = workspace;
    this.definitions = new Map();
    this.active = new Map();
    this.resuming = new Map();
    this.operations = new Map();
    this.closing = false;
  }
  async prepare(artifact) {
    // workflow/1 documents are interpreted directly; BPMN needs an engine definition.
    if (artifact.format !== FLOW_FORMAT && !this.definitions.has(artifact.id)) {
      this.definitions.set(artifact.id, await prepareEngine(artifact));
    }
    return artifact;
  }
  async recover() {
    for (const record of this.store.runs()) {
      if (TERMINAL.has(record.status)) continue;
      await this.continueRun(record);
    }
  }
  recoverRun({ id }) {
    return this.withRun(id, async () => {
      this.ready();
      const record = this.record(id);
      if (!TERMINAL.has(record.status) && !this.active.has(id)) await this.continueRun(record);
      return this.getRun({ id });
    });
  }
  async continueRun(record) {
    if (record.engine !== engineOf(this.store.workflow(record.workflowId))) throw new Error(`Run ${record.id} requires workflow engine ${record.engine}`);
    await this.prepare(this.store.workflow(record.workflowId));
    record.status = 'running';
    await this.store.save(record);
    const run = this.attach(record);
    run.event('run.recovered');
    if (record.definition) run.definition.recover(record.definition).resume();
    else run.definition.run({ processId: record.processId });
    for (const id of Object.keys(record.messages)) run.deliver(id);
    await run.flush();
  }
  resumeRun({ id }) {
    this.ready();
    if (!this.resuming.has(id)) {
      const pending = this.withRun(id, () => this.resumeFailedRun(id)).finally(() => this.resuming.delete(id));
      this.resuming.set(id, pending);
    }
    return this.resuming.get(id);
  }
  async resumeFailedRun(id) {
    const record = this.record(id);
    if (record.engine !== engineOf(this.store.workflow(record.workflowId))) fail(`Run ${id} requires workflow engine ${record.engine}`, Code.FailedPrecondition);
    if (record.status === 'resuming') {
      await this.continueRun(record);
      return this.getRun({ id });
    }
    const active = this.active.get(id);
    if (!TERMINAL.has(record.status) && active) return this.getRun({ id });
    if (TERMINAL.has(record.status) && record.status !== 'failed') fail(`Cannot resume a ${record.status} run`, Code.FailedPrecondition);
    if (active) { await Promise.all([...active.pending]); await active.flush(); }
    // A stopped component may leave a running checkpoint before job failure is
    // recorded. Resume that checkpoint with fresh jobs, just like a failed run.
    const recovery = record.status === 'failed' ? record.recovery : record;
    if (!recovery?.definition) fail(`Run ${id} has no saved failure checkpoint`, Code.FailedPrecondition);
    const compatibility = await this.checkWorkflow(record);
    if (!compatibility.compatible) fail(`Environment ${record.environment} does not define job types: ${compatibility.missingTypes.join(', ')}`, Code.FailedPrecondition);
    const point = clone(recovery);
    delete point.error;
    delete point.recovery;
    point.status = 'resuming';
    const events = [];
    const queue = this.environments.queue(record.environment);
    for (const job of Object.values(point.jobs)) {
      if (!['publishing', 'submitted'].includes(job.status)) continue;
      let state;
      try { state = await queue.state(job.id); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (state?.status === 'done') continue;
      if (state && ['pending', 'running'].includes(state.status)) {
        await queue.cancel(job.id);
        await queue.wait(job.id, { signal: AbortSignal.timeout(30000) });
      }
      const previousId = job.id;
      job.id = randomUUID().replaceAll('-', '');
      job.metadata = { ...job.metadata, retry_of: previousId };
      delete job.cancelRequested;
      delete job.result;
      delete job.error;
      job.status = 'publishing';
      events.push({ type: 'job.created', activityId: job.activityId,
        data: { jobId: job.id, retryOf: previousId, type: job.type,
          executionId: job.metadata.execution_id, workspace: point.workspace } });
    }
    // Record the new job IDs before dispatch. Recovery reuses these IDs, so a
    // launcher or engine restart cannot accidentally execute a job twice.
    await this.store.save(point, events);
    await this.continueRun(point);
    return this.getRun({ id });
  }
  ready() {
    if (this.store.failure) throw this.store.failure;
    if (this.closing) fail('Workflow runtime is stopping', Code.Unavailable);
  }
  withRun(id, action) {
    // Async persistence leaves a window in which the live record is newer than
    // disk. Serialize requests for a run so an idempotent duplicate cannot
    // acknowledge that record before its first request has durably saved it.
    const pending = (this.operations.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    this.operations.set(id, pending);
    const cleanup = () => { if (this.operations.get(id) === pending) this.operations.delete(id); };
    pending.then(cleanup, cleanup);
    return pending;
  }
  async loadWorkflow({ bpmnXml, workflow, workflowJson }) {
    this.ready();
    let artifact;
    try {
      // A workflow/1 document comes resolved, as an object over the host
      // channel or as JSON over the Workflow service; otherwise it is BPMN.
      if (workflow === undefined && workflowJson) workflow = parseJSON(workflowJson, 'Workflow document', { record: true });
      artifact = await this.prepare(workflow !== undefined ? flowArtifact(workflow) : await parseWorkflow(bpmnXml));
    }
    catch (error) { fail(error.message); }
    return { workflowId: await this.store.loadWorkflow(artifact) };
  }
  listWorkflows() { return { workflows: this.store.workflows().map(info) }; }
  describe({ workflowId }) {
    const row = this.store.workflows().find(w => w.id === workflowId);
    if (!row) fail('Workflow not found', Code.NotFound);
    return { workflow: info(row), bpmnXml: JSON.parse(row.artifact).source };
  }
  async listEnvironments() { return { environments: await this.environments.list() }; }
  async checkWorkflow({ workflowId, processId = '', environment }) {
    const artifact = this.store.workflow(workflowId);
    if (!artifact) fail('Workflow not found', Code.NotFound);
    processId = selectProcess(artifact, processId);
    let descriptor;
    try { descriptor = await this.environments.get(environment); }
    catch (error) { fail(error.message, Code.FailedPrecondition); }
    const requiredTypes = artifact.format === FLOW_FORMAT ? flowJobTypes(artifact) : requiredJobTypes(artifact, processId);
    const missingTypes = requiredTypes.filter(type => !descriptor.types.includes(type));
    return { compatible: !missingTypes.length, requiredTypes, missingTypes };
  }
  startRun(request) { return this.withRun(request.id, () => this.start(request)); }
  async start({ id, workflowId, processId = '', variablesJson = '{}', environment }) {
    this.ready(); identifier(id, 'Run ID');
    try { environmentName(environment); } catch (error) { fail(error.message); }
    const artifact = this.store.workflow(workflowId);
    if (!artifact) fail('Workflow not found', Code.NotFound);
    processId = selectProcess(artifact, processId);
    let input;
    try { input = variables(parseJSON(variablesJson || '{}', 'Run variables', { record: true })); }
    catch (error) { fail(error.message); }
    if (!(await stat(this.workspace)).isDirectory()) fail('Workflow workspace must be a prepared directory');
    const inputHash = digest({ workflowId, processId, input, environment, workspace: this.workspace });
    const existing = this.store.run(id);
    if (existing) {
      if (existing.inputHash !== inputHash) fail('Run ID was already used with different input', Code.AlreadyExists);
      return this.getRun({ id });
    }
    const compatibility = await this.checkWorkflow({ workflowId, processId, environment });
    if (!compatibility.compatible) fail(`Environment ${environment} does not define job types: ${compatibility.missingTypes.join(', ')}`, Code.FailedPrecondition);
    await this.prepare(artifact);
    // The preparation await may overlap another idempotent StartRun request.
    const raced = this.store.run(id);
    if (raced) {
      if (raced.inputHash !== inputHash) fail('Run ID was already used with different input', Code.AlreadyExists);
      return this.getRun({ id });
    }
    const record = { id, workflowId, processId, environment, workspace: this.workspace, inputHash, variables: input, engine: engineOf(artifact), status: 'running',
      createdAt: now(), updatedAt: now(), jobs: {}, messages: {}, output: {}, definition: null };
    await this.store.save(record, [{ type: 'run.created' }]);
    const run = this.attach(record);
    run.definition.run({ processId });
    await run.flush();
    return this.getRun({ id });
  }
  attach(record) {
    const artifact = this.store.workflow(record.workflowId);
    const run = new (artifact.format === FLOW_FORMAT ? FlowExecution : Execution)(this, record, artifact);
    this.active.set(record.id, run);
    return run;
  }
  record(id) {
    const record = this.active.get(id)?.record ?? this.store.run(id);
    if (!record) fail('Run not found', Code.NotFound);
    return record;
  }
  getRun({ id }) {
    // A terminal status can cause the host to tear down the component. Expose
    // only committed state, even while an execution has advanced in memory.
    const record = this.store.run(id);
    if (!record) fail('Run not found', Code.NotFound);
    return { run: runInfo(record) };
  }
  listRuns({ limit = 50, before = '' } = {}) {
    limit = Math.max(1, Math.min(limit || 50, 200));
    const all = this.store.runs();
    const start = before ? all.findIndex(r => r.id === before) + 1 : 0;
    if (before && !start) fail('Unknown pagination cursor');
    const page = all.slice(start, start + limit);
    return { runs: page.map(runInfo), nextBefore: start + limit < all.length ? page.at(-1).id : '' };
  }
  cancelRun(request) { return this.withRun(request.id, () => this.cancel(request)); }
  async cancel({ id }) {
    this.ready();
    const record = this.record(id);
    const run = this.active.get(id);
    if (TERMINAL.has(record.status)) {
      await run?.flush();
      return this.getRun({ id });
    }
    record.status = 'cancelled';
    run.abort.abort(new Error('Run cancelled'));
    run.definition.stop();
    run.event('run.cancelled');
    await run.cancelJobs();
    await run.flush();
    return this.getRun({ id });
  }
  sendMessage(request) { return this.withRun(request.runId, () => this.message(request)); }
  async message({ runId, target, payloadJson = '{}', id }) {
    this.ready(); identifier(id, 'Message ID'); requiredString(target, 'Message target');
    const record = this.record(runId);
    let payload;
    try { payload = parseJSON(payloadJson || '{}', 'Message payload', { record: true }); }
    catch (error) { fail(error.message); }
    const hash = digest({ target, payload });
    if (Object.hasOwn(record.messages, id)) {
      if (record.messages[id].hash !== hash) fail('Message ID was already used with different input', Code.AlreadyExists);
      return this.getRun({ id: runId });
    }
    if (TERMINAL.has(record.status)) fail('Run has finished', Code.FailedPrecondition);
    const run = this.active.get(runId);
    if (run instanceof FlowExecution) {
      if (!run.index.has(target)) fail('Message target must be a message a wait step of this workflow names');
    } else {
      const waiting = run.waiters.get(target);
      const known = ['bpmn:Message', 'bpmn:Signal'].includes(run.index.get(target)?.$type);
      if (waiting?.activity.type !== 'bpmn:ReceiveTask' && !known) fail('Message target must be a BPMN message, signal, or waiting receive execution');
    }
    record.messages = { ...record.messages, [id]: { hash, target, payload, applied: false } };
    run.event('message.received', '', { id, target });
    await run.checkpoint();
    run.deliver(id);
    await run.flush();
    return this.getRun({ id: runId });
  }
  getEvents({ runId, after = 0n, limit = 100 }) {
    this.record(runId);
    return { events: this.store.events(runId, after, Math.max(1, Math.min(limit || 100, 1000))).map(e => ({
      sequence: BigInt(e.sequence), runId: e.run_id, type: e.type, activityId: e.activity_id, time: e.time, dataJson: e.data,
    })) };
  }
  close() { return this.closed ??= this.stop(); }
  async stop() {
    this.closing = true;
    try {
      // Finish requests already admitted before closing their executions/store.
      await Promise.allSettled([...this.operations.values()]);
      for (const run of this.active.values()) {
        run.abort.abort(new Error('Workflow runtime stopping'));
        if (!TERMINAL.has(run.record.status)) run.definition.stop();
      }
      await Promise.allSettled([...this.active.values()].flatMap(run => [...run.pending]));
      if (!this.store.failure) for (const run of this.active.values()) await run.flush();
    } finally {
      await this.store.close();
    }
  }
}

class Execution {
  constructor(runtime, record, artifact) {
    this.runtime = runtime; this.record = record; this.artifact = artifact;
    this.queue = runtime.environments.queue(record.environment);
    this.index = indexElements(artifact.document);
    this.events = []; this.pending = new Set(); this.waiters = new Map();
    this.controllers = new Map(); this.enabled = new Map();
    this.abort = new AbortController(); this.scheduled = null; this.saving = 0;
    const execution = this;
    function service(coordinator, activity) {
      let controller, executionId;
      this.execute = (message, callback) => {
        controller = new AbortController();
        executionId = message.content.executionId;
        execution.track(Promise.resolve().then(() => coordinator
          ? new AdHoc(execution, activity, message, controller.signal).run(callback)
          : execution.job(activity, message, callback, controller.signal)));
      };
      this.stop = () => controller?.abort(new Error('Activity stopped'));
      this.discard = () => {
        controller?.abort(new Error('Activity discarded'));
        execution.track(execution.cancelJob(executionId));
      };
    }
    function Service(activity) { service.call(this, false, activity); }
    function Coordinator(activity) { service.call(this, true, activity); }
    const context = executionContext(runtime.definitions.get(artifact.id), artifact.bindings, Service, Coordinator,
      (activity, content) => {
        const controller = this.controllers.get(activity.context);
        if (controller) controller.enable(activity.id, content);
        else {
          const pending = this.enabled.get(activity.context) ?? [];
          pending.push({ activityId: activity.id, content: clone(content) });
          this.enabled.set(activity.context, pending);
        }
      });
    const environment = new Elements.Environment({
      variables: clone(record.variables), expressions: expressions((env, content) => this.context(env, content)), scripts: scripts((env, content) => this.context(env, content)),
      extensions: { asys: activity => this.extension(activity) },
    });
    this.definition = new Elements.Definition(Elements.Context(context, environment));
    this.definition.on('error', error => this.fatal(error));
    this.definition.on('end', () => {
      if (!TERMINAL.has(record.status)) { record.status = 'completed'; this.event('run.completed'); }
      this.schedule();
    });
    this.definition.broker.subscribeTmp('event', '#', (key, message) => {
      if (['activity.start', 'activity.end', 'activity.discard', 'activity.wait', 'activity.timer', 'flow.take'].includes(key)) {
        const { id, executionId, expireAt } = message.content;
        this.event(key, id, { executionId, ...(expireAt && { expireAt }) });
      }
      this.schedule();
    }, { noAck: true });
  }
  track(promise) {
    this.pending.add(promise);
    promise.then(() => { this.pending.delete(promise); this.schedule(); }, error => {
      this.pending.delete(promise);
      if (!this.runtime.store.failure) { this.fatal(error); this.schedule(); }
    });
    return promise;
  }
  extension(activity) {
    const binding = this.artifact.bindings[activity.id];
    const standardLoop = activity.behaviour.loopCharacteristics?.type === 'bpmn:StandardLoopCharacteristics';
    const tag = `_asys_${activity.id}`;
    return {
      activate: () => {
        activity.broker.subscribeTmp('execution', 'execute.*', (key, message) => {
          const content = message.content;
          // The root also has isMultiInstance, but no iteration index (P9).
          if (!content.isMultiInstance || content.isRootScope || !['execute.start', 'execute.completed', 'execute.discard'].includes(key)) return;
          this.record.loops ??= {};
          const loop = this.record.loops[content.parent.executionId] ??= {};
          loop[content.index] = key === 'execute.start' ? 'running' : key === 'execute.completed' ? 'completed' : 'terminated';
          if (binding && standardLoop && key === 'execute.completed') activity.environment.assignVariables({ [binding.result]: clone(content.output ?? null) });
        }, { noAck: true, consumerTag: `${tag}_loop`, priority: 500 });
        activity.broker.subscribeTmp('event', 'activity.#', (key, message) => {
          const content = message.content;
          actionEvent(this, activity, key, content);
          if (key === 'activity.wait') this.waiters.set(content.executionId, { api: activity.getApi(message), activity });
          if (key === 'activity.end' && binding) {
            const result = standardLoop ? content.output?.at(-1) ?? null : content.output ?? null;
            activity.environment.assignVariables({ [binding.result]: clone(result) });
            activity.environment.output[binding.result] = clone(result);
          }
          if (key === 'activity.end') applyOutput(this.index.get(activity.id), this.index, activity.environment, content.output, content);
          if (key === 'activity.end' && activity.behaviour.asysCoordinator) activity.environment.output.result = clone(content.output ?? null);
          const controller = this.controllers.get(activity.context);
          if (key === 'activity.end' && controller?.entries.some(entry => entry.id === activity.id)) controller.complete();
          if (['activity.end', 'activity.discard'].includes(key)) this.waiters.delete(content.executionId);
          this.schedule();
        }, { noAck: true, consumerTag: tag, priority: 100 });
      },
      deactivate: () => { activity.broker.cancel(tag); activity.broker.cancel(`${tag}_loop`); },
    };
  }
  async job(activity, message, callback, localSignal, { metadata = {} } = {}) {
    const signal = AbortSignal.any([this.abort.signal, localSignal]);
    if (signal.aborted) return;
    const executionId = message.content.executionId;
    let job = this.record.jobs[executionId];
    try {
      if (!job) {
        const { bindingId, binding, input, args } = this.jobValues(activity, message.content);
        job = this.record.jobs[executionId] = {
          id: randomUUID().replaceAll('-', ''), activityId: activity.id,
          type: binding.type, args, input: clone(input ?? null), status: 'publishing',
          metadata: { name: bindingId, workflow_id: this.record.workflowId, run_id: this.record.id, environment: this.record.environment, activity_id: bindingId,
            execution_id: executionId, bpmn: this.index.get(bindingId), ...metadata },
        };
        this.event('job.created', activity.id, { jobId: job.id, type: job.type, executionId, workspace: this.record.workspace });
        await this.checkpoint();
      }
      if (signal.aborted) return;
      if (job.status === 'completed') { callback(null, clone(job.result)); return; }
      if (job.status === 'failed') throw Object.assign(new Error(job.error.message), { code: job.error.code });
      const descriptor = await this.runtime.environments.get(this.record.environment);
      if (signal.aborted) return;
      if (!descriptor.types.includes(job.type)) throw new Error(`Environment ${this.record.environment} no longer defines job type ${job.type}`);
      const directory = join(this.runtime.jobRoot, job.id), workspace = this.record.workspace;
      makeDirectory(directory, { recursive: true, mode: 0o700 });
      await this.queue.submit(job.type, job.id, { directory, workspace, args: job.args, input: job.input, metadata: job.metadata });
      job.status = 'submitted';
      if (job.cancelRequested || (signal.aborted && TERMINAL.has(this.record.status))) await this.queue.cancel(job.id);
      if (signal.aborted) return;
      await this.checkpoint();
      const outcome = await this.queue.wait(job.id, { signal });
      if (signal.aborted) return;
      job.result = outcome.result ?? null;
      if (outcome.status !== 'done') throw Object.assign(new Error(outcome.error ?? `Job ${job.id} ${outcome.status}`), { code: String(outcome.exit_code ?? outcome.status) });
      job.status = 'completed'; job.result = outcome.result;
      this.event('job.completed', activity.id, { jobId: job.id, executionId });
      await this.checkpoint();
      if (signal.aborted) return;
      callback(null, clone(job.result ?? null));
    } catch (error) {
      if (this.runtime.store.failure) throw error;
      if (signal.aborted) return;
      await this.checkpoint();
      if (signal.aborted) return;
      const { recovery: _previous, ...point } = this.record;
      const recovery = clone(point);
      const result = { ...(object(job?.result) ? clone(job.result) : {}), exception: error.message };
      if (job) { job.status = 'failed'; job.error = errorRecord(error); job.result = result; }
      const binding = this.artifact.bindings[activity.behaviour.asysCoordinator ?? activity.id];
      if (binding) {
        activity.environment.assignVariables({ [binding.result]: clone(result) });
        activity.environment.output[binding.result] = clone(result);
      }
      this.event('job.failed', activity.id, { jobId: job?.id, executionId, ...errorRecord(error) });
      await this.checkpoint();
      if (signal.aborted) return;
      this.failureRecovery = recovery;
      try { callback(error); }
      finally { this.failureRecovery = undefined; }
    } finally { this.schedule(); }
  }
  jobValues(activity, content, options = {}) {
    const bindingId = activity.behaviour.asysCoordinator ?? activity.id;
    const binding = this.artifact.bindings[bindingId];
    const context = this.context(activity.environment, { ...content, asysLoopBody: true });
    let input, args;
    try {
      input = feel(binding.input, context, options);
      args = feel(binding.args, context, options);
    } catch (error) { throw new Error(`${bindingId}: invalid job input: ${error.message}`); }
    if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) throw new Error(`${bindingId}: job args must evaluate to a list of strings`);
    return { bindingId, binding, input, args };
  }
  async cancelJob(executionId) {
    const job = this.record.jobs[executionId];
    if (!job || ['completed', 'failed'].includes(job.status)) return;
    job.cancelRequested = true;
    await this.checkpoint();
    if (job.status === 'submitted') await this.queue.cancel(job.id);
  }
  cancelJobs() { return Promise.all(Object.keys(this.record.jobs).map(id => this.cancelJob(id))); }
  context(environment, content = {}) {
    const model = this.index.get(content.id);
    const loop = this.record.loops?.[content.isMultiInstance ? content.parent?.executionId : content.executionId] ?? {};
    const states = Object.values(loop);
    const completed = states.filter(s => s === 'completed').length;
    const active = states.filter(s => s === 'running').length;
    const terminated = states.filter(s => s === 'terminated').length;
    const loopCounter = model?.loopCharacteristics?.$type === 'bpmn:StandardLoopCharacteristics' && !content.asysLoopBody ? completed : (content.index ?? -1) + 1;
    const data = {};
    for (const element of this.index.values()) if (['bpmn:DataObject', 'bpmn:DataObjectReference'].includes(element.$type)) {
      const value = dataValue(element.id, this.index, environment);
      Object.defineProperty(data, element.name ?? element.id, { value, enumerable: true, configurable: true });
    }
    const itemName = model?.loopCharacteristics?.inputDataItem?.name ?? model?.loopCharacteristics?.inputDataItem?.id;
    const context = contextOf(environment, content);
    for (const name of ['variables', 'output', 'item', 'index', 'message', '__proto__', 'constructor', 'prototype']) delete data[name];
    return { ...context, ...data, ...(itemName && { [itemName]: content.item }),
      task: model, inputs: inputValues(model, this.index, environment, content), loopCounter,
      numberOfInstances: content.loopCardinality, numberOfActiveInstances: active,
      numberOfCompletedInstances: completed, numberOfTerminatedInstances: terminated,
      nrOfInstances: content.loopCardinality, nrOfActiveInstances: active,
      nrOfCompletedInstances: completed, nrOfTerminatedInstances: terminated };
  }
  deliver(id) {
    const message = this.record.messages[id];
    if (message.applied) return;
    const waiter = this.waiters.get(message.target);
    if (waiter) waiter.api.signal(message.payload);
    else this.definition.signal({ ...message.payload, id: message.target });
    message.applied = true;
    this.schedule();
  }
  event(type, activityId = '', data = {}) {
    if (activityId) {
      const model = this.index.get(activityId);
      data = { name: model?.name ?? '', activityType: model?.$type ?? '', ...(!model && { internal: true }), ...data };
    }
    this.events.push({ type, activityId, data, time: now() });
  }
  schedule() {
    if (this.runtime.store.failure) return;
    this.scheduled ??= Promise.resolve().then(() => { this.scheduled = null; return this.checkpoint(); });
    this.scheduled.catch(error => { if (!this.runtime.store.failure) this.fatal(error); });
  }
  async flush() { await this.scheduled; await this.checkpoint(); }
  async checkpoint() {
    this.record.definition = this.definition.getState();
    const process = this.definition.getProcessById(this.record.processId);
    if (process) { this.record.variables = clone(publicVariables(process.environment)); this.record.output = clone(process.environment.output); }
    if (!TERMINAL.has(this.record.status)) this.record.status = this.definition.activityStatus === 'executing' ? 'running' : 'waiting';
    this.record.updatedAt = now();
    const events = this.events;
    this.events = [];
    this.saving++;
    try { await this.runtime.store.save(this.record, events); }
    finally { this.saving--; }
    if (TERMINAL.has(this.record.status) && !this.runtime.closing && !this.pending.size && !this.scheduled && !this.saving) this.runtime.active.delete(this.record.id);
  }
  fatal(error) {
    if (TERMINAL.has(this.record.status)) return;
    this.record.status = 'failed'; this.record.error = errorRecord(error);
    if (this.failureRecovery) this.record.recovery = this.failureRecovery;
    this.abort.abort(error);
    this.definition.stop();
    this.event('run.failed', '', this.record.error);
    this.track(this.cancelJobs());
    this.schedule();
  }
}

function engineOf(artifact) {
  return artifact?.format === FLOW_FORMAT ? FLOW_ENGINE : ENGINE;
}
function identifier(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f]/u.test(value)) fail(`${label} must contain 1–256 printable characters`);
}
function info(row) {
  const a = JSON.parse(row.artifact);
  return { id: row.id, name: row.name, processIds: a.processes.filter(p => p.isExecutable).map(p => p.id), loadedAt: row.loaded_at };
}
function selectProcess(artifact, processId) {
  const processes = artifact.processes.filter(process => process.isExecutable);
  if (!processId && processes.length === 1) processId = processes[0].id;
  if (!processes.some(process => process.id === processId)) fail('Select an executable process in this workflow');
  return processId;
}
function runInfo(record) {
  return { id: record.id, workflowId: record.workflowId, processId: record.processId, status: record.status,
    variablesJson: JSON.stringify(record.variables), outputJson: JSON.stringify(record.output),
    error: record.error?.message ?? '', createdAt: record.createdAt, updatedAt: record.updatedAt, environment: record.environment };
}
