import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { agentDefinition, agentResult, systemAgentDefinition } from '../src/agent-definition.mjs';
import { runAgent } from '../src/agent-session.mjs';
import { agent } from '../src/agent.mjs';
import { assistant, conversationOf, model, systemPromptOf } from './helpers.mjs';

test('the removed inference timeout flag is rejected', async () => {
  await assert.rejects(agent({ argv: ['--timeout', '1'], job: {}, env: {}, signal: new AbortController().signal },
    { provider: {} }), /Unknown option '--timeout'/);
});

test('named agents share environment resources and load their own memory and skills', async t => {
  const root = await mkdtemp(join(tmpdir(), 'asys-agent-definition-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = join(root, 'environment'), workspace = join(root, 'work'), jobDirectory = join(root, 'job');
  await mkdir(workspace);
  for (const name of ['pcb', 'schematic']) {
    await mkdir(join(environment, 'agents', name, 'skills', name), { recursive: true });
    await writeFile(join(environment, 'agents', name, 'memory.md'), `${name} retained lesson`);
    await writeFile(join(environment, 'agents', name, 'prompt.md'), `${name} base instructions`);
    await writeFile(join(environment, 'agents', name, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} techniques\n---\n${name} procedure`);
  }
  await mkdir(join(environment, 'skills', 'common'), { recursive: true });
  await writeFile(join(environment, 'skills', 'common', 'SKILL.md'), '---\nname: common\ndescription: Common techniques\n---\nCommon procedure');
  await writeFile(join(environment, 'tools.md'), '- board-tool 1.2\n- board-library 3.4');
  const requests = [], job = { id: 'board' };
  const provider = {
    async listModels() { return { models: [model] }; },
    async *infer(request) {
      requests.push(JSON.parse(request.payload));
      const message = assistant([{ type: 'text', text: '{"final":"Board complete","exception":null,"approved":false}' }]);
      yield { payload: JSON.stringify({ type: 'done', reason: 'stop', message }) };
    },
  };
  const definition = agentDefinition(environment, 'pcb');
  const result = await runAgent({ config: { model: model.id, prompt: 'Route the board.', maxSteps: 2, options: {} },
    job, workspace, jobDirectory, definition, provider,
    signal: new AbortController().signal, save() {}, event() {} });
  assert.deepEqual(result, { final: 'Board complete', exception: null, approved: false });
  const prompt = systemPromptOf(requests[0].context);
  assert.match(prompt, /Installed environment tools:\n- board-tool 1\.2\n- board-library 3\.4/);
  assert.match(prompt, /pcb retained lesson/);
  assert.match(prompt, /pcb base instructions/);
  assert.match(prompt, /Common techniques/);
  assert.match(prompt, /pcb techniques/);
  assert.doesNotMatch(prompt, /schematic retained lesson|schematic techniques|schematic base instructions/);
  assert.match(prompt, /report\.md/);
  assert.match(prompt, /lessons\.md/);
  const reportingGuide = await readFile(new URL('../src/reporting-to-humans.md', import.meta.url), 'utf8');
  const reportingPath = fileURLToPath(new URL('../src/reporting-to-humans.md', import.meta.url));
  assert.ok(prompt.includes(JSON.stringify(reportingPath)), 'structured reporting guidance remains discoverable at a readable path');
  assert.ok(!prompt.includes(reportingGuide.trim()), 'ordinary assignments do not preload the structured reporting guide');
  assert.doesNotMatch(prompt, /ASYS_RESULT/);
  assert.equal(job.agent.name, 'pcb');
  assert.equal(await readFile(join(environment, 'agents/pcb/memory.md'), 'utf8'), 'pcb retained lesson');
  assert.equal(await readFile(join(jobDirectory, '.pi/system-prompt.txt'), 'utf8'), prompt);
  await assert.rejects(readFile(join(workspace, '.pi/system-prompt.txt')), { code: 'ENOENT' });
});

test('an external agent uses its own prompt and memory alongside shared environment resources', async t => {
  const root = await mkdtemp(join(tmpdir(), 'asys-external-agent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = join(root, 'environment'), external = join(root, 'bundle');
  const workspace = join(root, 'work'), jobDirectory = join(root, 'job');
  await mkdir(workspace);
  for (const directory of [environment, external]) {
    await mkdir(join(directory, 'agents', 'reviewer'), { recursive: true });
  }
  await writeFile(join(environment, 'agents/reviewer/prompt.md'), 'Builtin reviewer instructions');
  await writeFile(join(environment, 'agents/reviewer/memory.md'), 'Builtin private memory');
  await writeFile(join(external, 'agents/reviewer/prompt.md'), 'External reviewer instructions');
  await writeFile(join(external, 'agents/reviewer/memory.md'), 'External retained lesson');
  for (const [directory, name] of [[environment, 'environment-common'], [external, 'bundle-common'],
    [join(external, 'agents/reviewer'), 'reviewer-specific']]) {
    await mkdir(join(directory, 'skills', name), { recursive: true });
    await writeFile(join(directory, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} techniques\n---\nProcedure`);
  }
  await writeFile(join(environment, 'tools.md'), '- environment-tool 2.0');
  await writeFile(join(external, 'tools.md'), 'UNSELECTED_BUNDLE_TOOLS');
  await writeFile(join(workspace, 'tools.md'), 'UNSELECTED_WORKSPACE_TOOLS');
  await writeFile(join(external, 'extra.mjs'), `export default pi => {
    pi.on('before_agent_start', event => ({ systemPrompt: event.systemPrompt + '\\nExternal explicit extension' }));
  };`);
  const requests = [];
  const provider = {
    async listModels() { return { models: [model] }; },
    async *infer(request) {
      requests.push(JSON.parse(request.payload));
      yield { payload: JSON.stringify({ type: 'done', reason: 'stop',
        message: assistant([{ type: 'text', text: '{"final":"Reviewed","exception":null}' }]) }) };
    },
  };
  const result = await agent({
    job: { id: 'review', input: { prompt: 'Review the latest result.' }, workspace,
      directory: jobDirectory, result: join(jobDirectory, 'result.json') },
    argv: ['--agent', 'reviewer', '--model', model.id, '--extension', 'extra.mjs'],
    env: { ASYS_ENVIRONMENT_DIR: environment, ASYS_WORKERS_DIR: external },
    signal: new AbortController().signal,
  }, { provider });
  assert.deepEqual(result, { final: 'Reviewed', exception: null });
  const { context } = requests[0];
  for (const text of ['External reviewer instructions', 'External retained lesson', 'External explicit extension',
    'environment-common techniques', 'bundle-common techniques', 'reviewer-specific techniques']) {
    assert.ok(systemPromptOf(context).includes(text), text);
  }
  assert.match(systemPromptOf(context), /Installed environment tools:\n- environment-tool 2\.0/);
  assert.doesNotMatch(systemPromptOf(context), /UNSELECTED_BUNDLE_TOOLS|UNSELECTED_WORKSPACE_TOOLS/);
  assert.doesNotMatch(systemPromptOf(context), /Builtin reviewer instructions|Builtin private memory/);
  assert.deepEqual(conversationOf(context)[0].content, [{ type: 'text', text: 'Review the latest result.' }]);
  const state = JSON.parse(await readFile(join(jobDirectory, 'agent.json'), 'utf8'));
  assert.equal(state.agent.environment, environment);
  assert.equal(state.agent.directory, join(external, 'agents/reviewer'));
  assert.equal(state.agent.promptHash, agentDefinition(environment, 'reviewer', external).promptHash);
  assert.equal(await readFile(join(external, 'agents/reviewer/memory.md'), 'utf8'), 'External retained lesson');
  await mkdir(join(environment, 'agents', 'builtin-only'));
  assert.throws(() => agentDefinition(environment, 'builtin-only', external), { code: 'ENOENT' });
});

test('completion accepts only the agreed final JSON and preserves task-specific results', () => {
  const message = text => assistant([{ type: 'text', text }]);
  assert.deepEqual(agentResult(message('{"final":"Missing input","exception":"No schematic"}')),
    { final: 'Missing input', exception: 'No schematic' });
  for (const text of ['Finished', '{}', '[]', '{"final":"Done"}', '{"final":"Done","exception":""}', '{"final":"Done","exception":false}']) {
    assert.throws(() => agentResult(message(text)), /Agent/);
  }
});

test('the shared simple agent uses the shared system prompt without extra role instructions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'asys-system-agent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = join(root, 'environment'), workspace = join(root, 'work');
  const run = join(root, 'run'), jobDirectory = join(run, 'job');
  await mkdir(workspace);
  await mkdir(join(environment, 'agents/simple'), { recursive: true });
  await writeFile(join(environment, 'tools.md'), '- shared-tool 5.0');
  await writeFile(join(environment, 'agents/simple/prompt.md'), 'UNSELECTED_ENVIRONMENT_AGENT');
  await writeFile(join(environment, 'agents/simple/memory.md'), 'UNSELECTED_ENVIRONMENT_MEMORY');
  const requests = [];
  const provider = {
    async listModels() { return { models: [model] }; },
    async *infer(request) {
      assert.equal(request.model, model.id);
      requests.push(JSON.parse(request.payload));
      yield { payload: JSON.stringify({ type: 'done', reason: 'stop',
        message: assistant([{ type: 'text', text: '{"final":"Assignment finished","exception":null}' }]) }) };
    },
  };
  await agent({ job: { id: 'one', input: { prompt: 'Complete the assignment.' }, workspace,
    directory: jobDirectory, result: join(jobDirectory, 'result.json') },
    argv: ['--agent', 'simple', '--system-agent', '--model', model.id],
    env: { ASYS_ENVIRONMENT_DIR: environment, ASYS_WORKERS_DIR: environment },
    signal: new AbortController().signal,
  }, { provider });
  const packaged = await readFile(new URL('../../python/asys/system_agents/simple/prompt.md', import.meta.url), 'utf8');
  assert.equal(packaged, '');
  const shared = await readFile(new URL('../src/system.md', import.meta.url), 'utf8');
  assert.ok(systemPromptOf(requests[0].context).includes(shared.trim()));
  assert.match(systemPromptOf(requests[0].context), /Installed environment tools:\n- shared-tool 5\.0/);
  assert.doesNotMatch(systemPromptOf(requests[0].context), /Agent instructions:/);
  assert.doesNotMatch(systemPromptOf(requests[0].context), /UNSELECTED_ENVIRONMENT_AGENT|UNSELECTED_ENVIRONMENT_MEMORY/);
  assert.deepEqual(conversationOf(requests[0].context)[0].content, [{ type: 'text', text: 'Complete the assignment.' }]);
  const { agent: state } = JSON.parse(await readFile(join(jobDirectory, 'agent.json'), 'utf8'));
  assert.equal(state.name, 'simple');
  assert.equal(state.model, model.id);
});

for (const [label, contents] of [['absent', null], ['empty', ' \n\t'], ['populated', '- compiler 1.0']]) {
  test(`built-in agent receives the selected environment's ${label} tool list`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'asys-environment-tools-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const environment = join(root, 'environment'), workspace = join(root, 'work');
    await mkdir(environment);
    await mkdir(workspace);
    await writeFile(join(workspace, 'tools.md'), 'UNSELECTED_WORKSPACE_TOOLS');
    if (contents !== null) await writeFile(join(environment, 'tools.md'), contents);
    const requests = [];
    const provider = {
      async listModels() { return { models: [model] }; },
      async *infer(request) {
        requests.push(JSON.parse(request.payload));
        yield { payload: JSON.stringify({ type: 'done', reason: 'stop',
          message: assistant([{ type: 'text', text: '{"final":"Done","exception":null}' }]) }) };
      },
    };
    await runAgent({ config: { model: model.id, prompt: 'Complete the assignment.', options: {} },
      job: { id: 'tools' }, workspace, jobDirectory: join(root, 'job'),
      definition: systemAgentDefinition(environment, 'simple'), provider,
      signal: new AbortController().signal, save() {}, event() {} });
    const prompt = systemPromptOf(requests[0].context);
    if (contents?.trim()) assert.match(prompt, /Installed environment tools:\n- compiler 1\.0/);
    else assert.doesNotMatch(prompt, /Installed environment tools:/);
    assert.doesNotMatch(prompt, /UNSELECTED_WORKSPACE_TOOLS/);
  });
}
