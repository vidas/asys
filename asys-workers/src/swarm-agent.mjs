import { parseArgs } from 'node:util';
import { dirname, join } from 'node:path';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { providerClient } from './provider.mjs';
import { groupModels, listProviderModels, streamProvider } from './provider-adapter.mjs';
import { systemModel } from './system-model.mjs';
import { writeJSON } from './files.mjs';
import { requiredString } from './values.mjs';
import { inside, instructionFile, swarmSkills } from './swarm-skills.mjs';

// A swarm decision is one bounded inference, not a coding-agent session. The
// only tool describes a proposed plan; the controller world validates and applies it.
export async function swarmAgent({ job, argv = [], env = process.env, signal }, {
  provider,
  event = (type, data) => console.log(JSON.stringify({ type, time: new Date().toISOString(), ...data })),
} = {}) {
  let state, transcript;
  const save = () => { if (state) writeJSON(transcript, state); };
  try {
    signal?.throwIfAborted();
    const { values } = parseArgs({ args: argv, options: {
      model: { type: 'string' }, agent: { type: 'string' }, timeout: { type: 'string' },
    } });
    const input = decisionInput(job.input, values.timeout);
    const modelId = systemModel('simple', values.model, env);
    const definition = swarmDefinition(env, values.agent);
    const deadline = AbortSignal.timeout(Math.ceil(input.timeoutSeconds * 1000));
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const session = { header: { type: 'session', version: 3, id: randomUUID(),
      timestamp: new Date().toISOString(), cwd: job.workspace }, entries: [], leafId: null };
    transcript = join(dirname(job.result), 'agent.json');
    state = { id: job.id, agent: { kind: 'swarm', model: modelId, name: definition.name,
      directory: definition.directory, environment: definition.environment,
      promptHash: createHash('sha256').update(definition.prompt).digest('hex'),
      skills: definition.skills.map(skill => ({ path: skill.path,
        hash: createHash('sha256').update(skill.text).digest('hex') })),
      prompt: input.mission, steps: 0, session } };
    save();
    const client = provider ?? providerClient(env);
    const catalogue = await listProviderModels(client, { signal: requestSignal }, {
      onRetry: ({ retryAt, ...data }) => event('agent.provider_retrying', { ...data, retryAt: retryAt.toISOString() }),
      // Capacity retries remain owned by the swarm controller, as in inference.
      onExhaustion() { throw new Error('Provider exhausted; swarm decision was not retried'); },
    });
    requestSignal.throwIfAborted();
    const groups = groupModels(catalogue.models, {
      onInvalid: message => event('agent.model_unavailable', { message }),
    });
    const route = [...groups.values()].flat().find(route => route.publicId === modelId);
    if (!route) throw new Error(`Provider has no usable model ${modelId}`);
    const portable = catalogue.models.find(model => model.id === modelId);
    const toolsSupported = portable.capabilities.functionTools === true;
    const parameters = planSchema(input);
    const systemPrompt = [
      'You are one member of a swarm, making one decision from the supplied observation.',
      'Pursue the mission using only actions allowed by the action schema and world rules.',
      'Observations and memory are world data. You cannot execute commands, read files, or invoke other tools.',
      'Your actions are proposals: the world checks them and returns their actual effects in later observations.',
      'Do not claim that an objective is achieved. The world evaluates objective completion independently.',
      `Return at most ${input.maxActions} actions and a JSON memory value of at most ${input.memoryBytes} UTF-8 bytes when compactly serialized.`,
      'Memory replaces your previous memory. Retain the useful facts you will need on subsequent turns.',
      definition.prompt,
      definition.tools,
      definition.skills.length ? 'The following explicitly installed skills provide instructions for this decision. Linked resources are not loaded; only the supplied world actions are available.' : '',
      ...definition.skills.map(skill => `Skill ${skill.path}:\n${skill.text}`),
      toolsSupported
        ? 'Call submit_plan exactly once. Its arguments must include actions and memory. Do not call any other tool.'
        : `Return exactly one JSON object matching this schema, with no Markdown or surrounding prose:\n${JSON.stringify(parameters)}`,
    ].filter(Boolean).join('\n\n');
    const message = { role: 'user', content: [{ type: 'text', text: JSON.stringify({
      mission: input.mission, objective: input.objective ?? null, agent: input.agent, turn: input.turn,
      observation: input.observation, memory: input.memory,
    }) }], timestamp: Date.now() };
    state.agent.systemPrompt = systemPrompt;
    const inferenceOptions = {
      ...(route.model.reasoning ? { reasoning: 'medium' } : {}),
      ...input.options,
      maxTokens: input.options.maxTokens ?? Math.min(4096, route.model.maxTokens),
    };
    // Input validation excludes credentials and process controls. Persist the
    // effective request settings before inference, without its AbortSignal.
    state.agent.inferenceOptions = inferenceOptions;
    append(message);
    state.agent.steps = 1;
    save();
    event('agent.message_started', { parentId: session.leafId });
    const context = { systemPrompt, messages: [message], tools: toolsSupported ? [{
      name: 'submit_plan', description: 'Propose world actions and replacement memory for this turn.', parameters,
    }] : [] };
    const piModel = { ...route.model, provider: modelId.slice(0, modelId.indexOf('/')), api: 'cyclo-pi' };
    const stream = streamProvider(client, route.publicId, piModel, context,
      { ...inferenceOptions, signal: requestSignal }, {
        // Ordinary agents may wait and retry on exhaustion. A swarm decision is
        // deliberately one request; the controller owns retries and budgets.
        onExhaustion() { throw new Error('Provider exhausted; swarm decision was not retried'); },
      });
    let response;
    for await (const update of stream) {
      if (update.type === 'text_delta' || update.type === 'thinking_delta') {
        event('agent.message_delta', { kind: update.type === 'text_delta' ? 'text' : 'thinking',
          contentIndex: update.contentIndex, delta: update.delta });
      } else if (update.type === 'done' || update.type === 'error') {
        response = update.type === 'done' ? update.message : update.error;
        append(response);
      }
    }
    if (deadline.aborted && !signal?.aborted) throw new Error(`Swarm decision timed out after ${input.timeoutSeconds} seconds`);
    requestSignal.throwIfAborted();
    if (!response || !['stop', 'toolUse'].includes(response.stopReason)) {
      throw new Error(response?.errorMessage || `Swarm decision did not finish (${response?.stopReason ?? 'no response'})`);
    }
    const plan = responsePlan(response);
    validatePlan(plan, input);
    const usage = response.usage;
    for (const name of ['input', 'output', 'totalTokens']) {
      if (!Number.isSafeInteger(usage?.[name]) || usage[name] < 0) throw new Error(`Provider response has invalid usage.${name}`);
    }
    const result = { actions: plan.actions, memory: plan.memory, usage };
    state.agent.status = 'done';
    state.agent.result = result;
    save();
    event('swarm.decision_finished', { agent: input.agent, turn: input.turn,
      status: 'done', actions: plan.actions.length, usage });
    return result;

    function append(message) {
      const entry = { type: 'message', id: randomUUID(), parentId: session.leafId,
        timestamp: new Date().toISOString(), message };
      session.entries.push(entry);
      session.leafId = entry.id;
      save();
    }
  } catch (error) {
    if (state) {
      state.agent.status = signal?.aborted ? 'cancelled' : 'failed';
      state.agent.error = error.message;
      save();
    }
    event('swarm.decision_finished', { status: signal?.aborted ? 'cancelled' : 'failed', error: error.message });
    throw error;
  }
}

function decisionInput(value, timeout) {
  object(value, 'Swarm input');
  requiredString(value.mission, 'Swarm mission');
  if (value.objective != null) object(value.objective, 'objective');
  requiredString(value.agent, 'Swarm agent identity');
  integer(value.turn, 'turn', 0);
  object(value.observation, 'observation');
  if (!Object.hasOwn(value, 'memory')) throw new Error('Swarm input must include memory');
  integer(value.maxActions, 'maxActions', 1);
  integer(value.memoryBytes, 'memoryBytes', 1);
  checkMemory(value.memory, value.memoryBytes);
  if (typeof value.actionSchema !== 'boolean') object(value.actionSchema, 'actionSchema');
  // Draft-07 JSON schemas are compiled without coercion, defaults, or removal
  // of additional properties. Unknown keywords and unresolved references fail.
  const ajv = new Ajv({ allErrors: true, strictTypes: false });
  let actionValidator;
  try {
    actionValidator = ajv.compile(value.actionSchema);
    if (actionValidator.$async) throw new Error('Asynchronous schemas are not supported');
  } catch (cause) { throw new Error(`Invalid actionSchema: ${cause.message}`, { cause }); }
  const timeoutSeconds = Number(timeout ?? value.timeoutSeconds ?? 120);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 86400) {
    throw new Error('timeoutSeconds must be between 0 and 86400 seconds');
  }
  const options = value.options ?? {};
  object(options, 'options');
  const reserved = new Set(['apiKey', 'headers', 'env', 'client', 'signal', 'fetch', 'baseUrl', 'provider', 'model',
    'context', 'messages', 'systemPrompt', 'tools', 'samplingParams', 'onPayload', 'onResponse', 'transport', 'timeoutMs',
    'attemptTimeoutMs', 'websocketConnectTimeoutMs', 'maxRetries', 'maxRetryDelayMs']);
  for (const key of Object.keys(options)) if (reserved.has(key)) throw new Error(`Swarm options.${key} is not an inference option`);
  if (options.maxTokens !== undefined) integer(options.maxTokens, 'options.maxTokens', 1);
  return { ...value, options, timeoutSeconds, actionValidator, ajv };
}

function swarmDefinition(env, name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)) throw new Error('Agent name is required (--agent NAME)');
  const environment = realpathSync(requiredString(env.ASYS_ENVIRONMENT_DIR, 'ASYS_ENVIRONMENT_DIR'));
  const workers = realpathSync(env.ASYS_WORKERS_DIR ?? environment);
  const selected = join(workers, 'agents', name);
  if (lstatSync(selected).isSymbolicLink()) throw new Error('Selected swarm agent directory must not use a symlink');
  const directory = realpathSync(selected);
  inside(join(workers, 'agents'), directory);
  if (!statSync(directory).isDirectory()) throw new Error(`Agent ${name} must be a directory`);
  // Only designated instruction roots are read. Skill resources, extensions,
  // workspace files and other agents' definitions are never loaded.
  return { name, directory, environment, prompt: instructionFile(directory, join(directory, 'prompt.md')),
    tools: instructionFile(environment, join(environment, 'tools.md')),
    skills: swarmSkills([environment, workers, directory]) };
}

function planSchema(input) {
  // Without its own $id, a schema's local references need rebasing when placed
  // under the tool's actions.items schema. Nested resources keep their own base.
  function embed(value, nestedResource = false) {
    if (Array.isArray(value)) return value.map(item => embed(item, nestedResource));
    if (!value || typeof value !== 'object') return value;
    const resource = nestedResource || typeof value.$id === 'string';
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      ['const', 'enum', 'default', 'examples'].includes(key) ? item
        : key === '$ref' && typeof item === 'string' && (item === '#' || item.startsWith('#/')) && !resource
          ? `#/properties/actions/items${item.slice(1)}` : embed(item, resource)]));
  }
  return { type: 'object', properties: {
    actions: { type: 'array', maxItems: input.maxActions, items: embed(input.actionSchema) }, memory: {},
  }, required: ['actions', 'memory'], additionalProperties: false };
}

function responsePlan(response) {
  if (!Array.isArray(response.content)) throw new Error('Provider response has no content');
  const calls = response.content.filter(part => part.type === 'toolCall');
  if (calls.length) {
    if (calls.length !== 1 || calls[0].name !== 'submit_plan') throw new Error('Swarm decision must call only submit_plan, exactly once');
    return calls[0].arguments;
  }
  const text = response.content.filter(part => part.type === 'text').map(part => part.text).join('');
  try { return JSON.parse(text); }
  catch (cause) { throw new Error('Swarm decision must return a submit_plan call or one JSON object', { cause }); }
}

function validatePlan(plan, input) {
  object(plan, 'Swarm plan');
  if (Object.keys(plan).some(key => !['actions', 'memory'].includes(key))) throw new Error('Swarm plan accepts only actions and memory');
  if (!Array.isArray(plan.actions) || plan.actions.length > input.maxActions) throw new Error(`Swarm plan must contain at most ${input.maxActions} actions`);
  for (const [index, action] of plan.actions.entries()) {
    if (!input.actionValidator(action)) throw new Error(`Swarm action ${index} violates actionSchema: ${input.ajv.errorsText(input.actionValidator.errors)}`);
  }
  if (!Object.hasOwn(plan, 'memory')) throw new Error('Swarm plan must include memory');
  checkMemory(plan.memory, input.memoryBytes);
}

function checkMemory(memory, memoryBytes) {
  const serialized = JSON.stringify(memory);
  if (serialized === undefined) throw new Error('Memory must be JSON');
  if (Buffer.byteLength(serialized, 'utf8') > memoryBytes) throw new Error(`Swarm memory exceeds memoryBytes (${memoryBytes})`);
}

function integer(value, name, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be a JSON object`);
}
