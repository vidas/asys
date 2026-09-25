import { parseArgs } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { REASONING_LEVELS, runAgent } from './agent-session.mjs';
import { providerClient } from './provider.mjs';
import { writeJSON } from './files.mjs';
import { requiredString } from './values.mjs';
import { agentDefinition, systemAgentDefinition } from './agent-definition.mjs';
import { systemModel } from './system-model.mjs';
import { DEFAULT_INFERENCE_IDLE_TIMEOUT_MS } from './provider-adapter.mjs';

export async function agent({ job, argv, env, signal }, { provider = providerClient(env), definition: suppliedDefinition, event, sessionFile } = {}) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    model: { type: 'string' }, agent: { type: 'string' }, extension: { type: 'string', multiple: true },
    'max-steps': { type: 'string' }, 'system-agent': { type: 'boolean' }, reasoning: { type: 'string' },
  } });
  const input = job.input ?? {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Agent input must be a JSON object');
  const maxSteps = values['max-steps'] ?? input.maxSteps;
  const config = {
    model: systemModel('simple', values.model, env),
    prompt: requiredString(positionals.length ? positionals.join(' ') : input.prompt ?? input.request, 'Agent prompt'),
    maxSteps: maxSteps == null ? undefined : Number(maxSteps),
    inferenceIdleTimeoutMs: Number(env.ASYS_INFERENCE_IDLE_TIMEOUT_MS ?? DEFAULT_INFERENCE_IDLE_TIMEOUT_MS),
    options: input.options ?? {},
    reasoning: values.reasoning,
  };
  if (config.reasoning !== undefined && !REASONING_LEVELS.includes(config.reasoning)) {
    throw new Error(`--reasoning must be one of ${REASONING_LEVELS.join(', ')}`);
  }
  if (config.maxSteps !== undefined && (!Number.isSafeInteger(config.maxSteps) || config.maxSteps < 1)) throw new Error('maxSteps must be a positive integer');
  if (!Number.isSafeInteger(config.inferenceIdleTimeoutMs) || config.inferenceIdleTimeoutMs < 1 || config.inferenceIdleTimeoutMs > 2_147_483_647) {
    throw new Error('ASYS_INFERENCE_IDLE_TIMEOUT_MS must be an integer between 1 and 2147483647');
  }
  if (!config.options || typeof config.options !== 'object' || Array.isArray(config.options)) throw new Error('Agent options must be an object');
  const transcript = join(dirname(job.result), 'agent.json');
  const state = { id: job.id };
  if (values['system-agent'] && values.agent !== 'simple') throw new Error('Only simple is a built-in agent');
  const definition = suppliedDefinition ?? (values['system-agent']
    ? systemAgentDefinition(env.ASYS_ENVIRONMENT_DIR, values.agent)
    : agentDefinition(env.ASYS_ENVIRONMENT_DIR, values.agent, env.ASYS_WORKERS_DIR));
  return runAgent({ config, job: state, workspace: job.workspace,
    jobDirectory: job.directory, definition, sessionFile, extensionPaths: (values.extension ?? []).map(path => resolve(definition.workersDirectory, path)),
    signal, provider,
    save: () => writeJSON(transcript, state),
    event: event ?? ((type, data) => console.log(JSON.stringify({ type, time: new Date().toISOString(), ...data }))),
  });
}
