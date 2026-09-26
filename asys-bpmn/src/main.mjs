import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveOutput, outputTarget } from '@dcomp/component';
import { AsyncStore } from './async-store.mjs';
import { WorkflowRuntime } from './runtime.mjs';
import { workflowServer } from './server.mjs';
import { serveHostChannel } from './host-channel.mjs';
import { Environments } from '../../asys-runtime/javascript/environments.mjs';
import { heartbeat } from '../../asys-runtime/javascript/health.mjs';

export async function main(argv = process.argv.slice(2), env = process.env) {
  let state = '/var/lib/asys-bpmn';
  let runtimeRoot = '/var/lib/asys/runtime';
  let hostChannel;
  let awaitResume = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--state' && argv[i + 1]) state = resolve(argv[++i]);
    else if (argv[i] === '--root' && argv[i + 1]) runtimeRoot = resolve(argv[++i]);
    else if (argv[i] === '--host-channel' && argv[i + 1]) hostChannel = argv[++i];
    else if (argv[i] === '--await-resume') awaitResume = true;
    else throw new Error('Usage: workflow component [--state DIRECTORY] [--root DIRECTORY] [--host-channel NAME] [--await-resume]');
  }
  outputTarget('workflow', env);
  const shutdown = new AbortController();
  let stop;
  const stopped = new Promise(resolve => { stop = resolve; });
  const onSignal = () => { shutdown.abort(new Error('Workflow component stopping')); stop(); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let runtime, server, output, channel, stopHealth;
  try {
    runtime = new WorkflowRuntime({ store: new AsyncStore(state), environments: new Environments(runtimeRoot) });
    // An explicit resume must replace unfinished jobs before execution starts.
    if (!awaitResume) await runtime.recover();
    server = workflowServer(runtime, { signal: shutdown.signal });
    const failure = new Promise((_, reject) => server.once('error', reject));
    output = serveOutput(server, 'workflow', { env, signal: shutdown.signal });
    let channelStopped = new Promise(() => {});
    if (hostChannel) {
      channel = serveHostChannel(runtime, { root: runtimeRoot, name: hostChannel, signal: shutdown.signal });
      channelStopped = channel.then(() => { if (!shutdown.signal.aborted) throw new Error('Workflow host channel stopped'); });
      console.log(`Workflow host channel ${hostChannel} under ${runtimeRoot}`);
    }
    stopHealth = heartbeat('/tmp/asys-bpmn-health', { ready: () => runtime.store.healthy() });
    console.log('Workflow component ready');
    await Promise.race([stopped, failure, runtime.store.failed, channelStopped, output.then(() => {
      if (!shutdown.signal.aborted) throw new Error('Workflow output stopped');
    })]);
  } finally {
    shutdown.abort(new Error('Workflow component stopped'));
    stopHealth?.();
    server?.closeConnections();
    await runtime?.close();
    await output?.catch(() => {});
    await channel?.catch(() => {});
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
