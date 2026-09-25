import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { Provider } from '@cyclo/provider/contract';
import { PreparedQueue as Queue } from '../../asys-runtime/test/fixtures.mjs';
import { assistant, model } from './helpers.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));

for (const named of [true, false]) test(`${named ? 'named built-in' : 'ordinary'} agent accepts canonical input through the real Provider`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'asys-dispatcher-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environment = join(directory, 'environment');
  await mkdir(environment);
  const definition = join(environment, 'named.json');
  await writeFile(definition, JSON.stringify({ version: 1, kind: 'agent',
    config: { agent: 'simple', system: true, model: 'fixture/model', maxSteps: 2, reasoning: 'low' } }));
  const command = named ? [join(root, 'asys-workers/tools/asys-worker'), '--definition', definition]
    : [join(root, 'asys-workers/tools/asys-agent'), '--system-agent', '--agent', 'simple', '--model', 'fixture/model', '--reasoning', 'low'];
  const config = join(directory, 'runtime.json');
  await writeFile(config, JSON.stringify({ version: 1, types: { named: { command } } }));
  const requests = [];
  const server = createServer(connectNodeAdapter({ routes(router) { router.service(Provider, {
    listModels() { return { models: [{ ...model, capabilities: { ...model.capabilities, reasoning: true } }] }; },
    async *infer(request) {
      requests.push(JSON.parse(request.payload));
      const message = assistant([{ type: 'text', text: JSON.stringify({ final: 'Worker finished', exception: null }) }]);
      yield { payload: JSON.stringify({ type: 'done', reason: 'stop', message }) };
    },
  }); } }));
  const socket = join(directory, 'provider.sock');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const queue = new Queue(join(directory, 'queue'));
  await queue.submit('named', 'canonical', { input: { request: 'Canonical assignment' } });
  await execute('python3', [join(root, 'asys-runtime/tools/asys-runtime'), 'run', config, '--root', queue.root, '--once'],
    { env: { ...process.env, ASYS_ENVIRONMENT_DIR: environment, DCOMP_IN_INFERENCE: `unix://${socket}` }, timeout: 15000 });
  const state = await queue.state('canonical');
  assert.equal(state.status, 'done', state.error);
  assert.equal(state.result.final, 'Worker finished');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.reasoning, 'low');
  assert.ok(requests[0].context.messages.some(message => JSON.stringify(message).includes('Canonical assignment')));
  assert.deepEqual(await readdir(environment), ['named.json']);
});
