import { Code, ConnectError } from '@connectrpc/connect';
import { Reader, Writer, directionRoot } from '../../asys-runtime/javascript/channel.mjs';

// The host talks to the workflow component over a runtime channel, not a
// socket. Requests arrive on `in`; every committed run event, and a `run.result`
// after each terminal one, goes out on `out`. The channel itself records how far
// publishing got: each outbound event carries the store sequence it came from.
const TERMINAL_EVENTS = new Set(['run.completed', 'run.failed', 'run.cancelled']);
const BATCH = 200;

export async function serveHostChannel(runtime, { root, name = 'workflow', signal }) {
  const inbound = await new Reader(directionRoot(root, name, 'in')).ready();
  const outbound = await new Writer(directionRoot(root, name, 'out')).ready();
  let published = 0;
  // Replies may follow a terminal event, including in streams written before
  // publication was serialized. Recover from the last actual run event/result.
  let checkpoint;
  let latest = true;
  for (const sequence of (await outbound.sequences()).reverse()) {
    let event;
    try { event = await outbound.event(sequence); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (latest) published = event.data?.store ?? 0; // also survives pruning
    latest = false;
    if (event.type === 'run.result' || event.data?.activityId !== undefined) {
      checkpoint = event;
      published = event.data.store;
      break;
    }
  }
  if (checkpoint && TERMINAL_EVENTS.has(checkpoint.type)) await result(checkpoint.data.runId, published);
  // Keep a terminal event and its result together, and stamp replies only once
  // earlier publication has finished. A write failure stops the whole channel.
  const failed = new AbortController();
  const stopping = signal ? AbortSignal.any([signal, failed.signal]) : failed.signal;
  let pending = Promise.resolve();
  function schedule(action) {
    pending = pending.then(() => { stopping.throwIfAborted(); return action(); });
    pending.catch(error => failed.abort(error));
    return pending;
  }
  async function drain() {
    for (;;) {
      const events = runtime.store.eventsAfter(published, BATCH);
      if (!events.length || stopping.aborted) return;
      for (const event of events) {
        await outbound.send(event.type, {
          runId: event.run_id, activityId: event.activity_id, time: event.time, data: JSON.parse(event.data), store: event.sequence,
        });
        if (TERMINAL_EVENTS.has(event.type)) await result(event.run_id, event.sequence);
        published = event.sequence;
      }
    }
  }
  async function result(runId, store) {
    const record = runtime.store.run(runId);
    await outbound.send('run.result', { runId, status: record.status, error: record.error?.message ?? '',
      output: record.output, variables: record.variables, environment: record.environment, workflowId: record.workflowId, store });
  }
  function runStatus(run) {
    const status = { runId: run.id, workflowId: run.workflowId, status: run.status, active: runtime.active.has(run.id) };
    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      // Reattachment can occur after a former launcher consumed/pruned the
      // terminal event. Supply the same durable result without replaying it.
      status.result = { runId: run.id, workflowId: run.workflowId, status: run.status,
        error: run.error, output: JSON.parse(run.outputJson), variables: JSON.parse(run.variablesJson), environment: run.environment };
    }
    return status;
  }
  async function handle(event) {
    const { data } = event;
    if (!data || typeof data !== 'object') throw new ConnectError('Request data must be an object', Code.InvalidArgument);
    switch (event.type) {
      case 'status': {
        const { run } = runtime.getRun({ id: data.id });
        return runStatus(run);
      }
      case 'recover': {
        const { run } = await runtime.recoverRun({ id: data.id });
        return runStatus(run);
      }
      case 'start': {
        if (data.environmentDefinition !== undefined) {
          const descriptor = await runtime.environments.get(data.environment);
          if (descriptor.definition !== data.environmentDefinition) {
            throw new ConnectError("The running environment's workers.json differs from the selected directory", Code.FailedPrecondition);
          }
        }
        const { workflowId } = await runtime.loadWorkflow({ bpmnXml: data.bpmnXml });
        const { run } = await runtime.startRun({ id: data.id, workflowId, processId: data.processId ?? '',
          variablesJson: JSON.stringify(data.variables ?? {}), environment: data.environment });
        return { runId: run.id, workflowId, status: run.status };
      }
      case 'cancel': {
        const { run } = await runtime.cancelRun({ id: data.id });
        return { runId: run.id, status: run.status };
      }
      case 'resume': {
        const { run } = await runtime.resumeRun({ id: data.id });
        return { runId: run.id, workflowId: run.workflowId, status: run.status };
      }
      case 'message': {
        const { run } = await runtime.sendMessage({ runId: data.runId, target: data.target, id: data.id, payloadJson: JSON.stringify(data.payload ?? {}) });
        return { runId: run.id, status: run.status };
      }
      default: throw new ConnectError(`Unknown request ${event.type}`, Code.Unimplemented);
    }
  }
  const unsubscribe = runtime.store.subscribe(() => { schedule(drain); });
  try {
    await schedule(drain);
    for await (const event of inbound.follow(undefined, { signal: stopping })) {
      await schedule(async () => {
        let reply;
        try { reply = { type: 'accepted', data: { request: event.sequence, ...await handle(event) } }; }
        catch (error) {
          reply = { type: 'rejected', data: { request: event.sequence, message: error.message,
            code: error instanceof ConnectError ? Code[error.code] : 'Unknown' } };
        }
        await outbound.send(reply.type, { ...reply.data, store: published });
        await drain();
      });
      await inbound.advance(event.sequence);
    }
  } catch (error) {
    if (!signal?.aborted) throw failed.signal.reason ?? error;
  } finally {
    unsubscribe();
    await pending.catch(() => {});
  }
}
