import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Reader, Writer, directionRoot } from '../../../../asys-runtime/javascript/channel.mjs';
import { createGatewayServices } from '../src/services.mjs';
import { serveGatewayChannel } from '../src/host-channel.mjs';

const helper = fileURLToPath(new URL('../../../tools/gateway-channel', import.meta.url));

async function fixture(t, oauthLogin, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'asys-gateway-channel-'));
  let signal = new AbortController();
  const provider = {
    id: 'test', name: 'Test', baseUrl: 'https://example.invalid',
    auth: oauthLogin ? { oauth: {
      login: oauthLogin, async refresh(value) { return value; },
      async toAuth(value) { return { apiKey: value.access }; },
    } } : { apiKey: {
      async login(interaction) { return { type: 'api_key', key: await interaction.prompt({ type: 'secret', message: 'Enter key' }) }; },
      async resolve({ credential }) { return credential?.key ? { auth: { apiKey: credential.key } } : undefined; },
    } },
    getModels() { return [{ id: 'model', provider: 'test', api: 'openai-responses', input: ['text'], contextWindow: 4096, maxTokens: 1024 }]; },
    stream() {}, streamSimple() {},
  };
  const services = await createGatewayServices({
    env: { CYCLO_GATEWAY_AUTH_JSON: join(root, 'auth.json'), CYCLO_GATEWAY_USAGE_JSONL: join(root, 'usage.jsonl') },
    providers: [provider],
    // Container stdio must never be used for channel authentication.
    input: { on() { throw new Error('attempted container stdin'); } },
    output: { write() { throw new Error('attempted container stdout'); } },
  });
  let running = serveGatewayChannel(services, root, { signal: signal.signal, ...options });
  void running.catch(() => {});
  t.after(async () => { signal.abort(); await running; await rm(root, { recursive: true, force: true }); });
  const input = new Writer(directionRoot(root, 'gateway', 'in'));
  const output = new Reader(directionRoot(root, 'gateway', 'out'));
  let after = 0;
  async function next(type) {
    for await (const event of output.follow(after, { timeoutMs: 4000 })) {
      after = event.sequence;
      if (event.type === type) return event.data;
    }
    assert.fail(`No ${type} event`);
  }
  let { instance } = await next('ready');
  const send = input.send.bind(input);
  input.send = (type, data) => send(type, type === 'request' ? { ...data, instance } : data);
  return { root, input, output, next, services, async restart() {
    const previous = instance;
    signal.abort();
    await running;
    signal = new AbortController();
    running = serveGatewayChannel(services, root, { signal: signal.signal, ...options });
    void running.catch(() => {});
    ({ instance } = await next('ready'));
    return previous;
  } };
}

test('the real Python host client completes native Pi API-key login without attach', async t => {
  const f = await fixture(t);
  const child = spawn('python3', [helper, f.root, 'login', JSON.stringify({ provider: 'test', account: 'work', authentication: 'api_key', interactive: false })], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', value => { out += value; });
  child.stderr.on('data', value => { err += value; });
  child.stdin.end('private-test-key\n');
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0, err);
  assert.deepEqual(JSON.parse(out), { account: 'work', authentication: 'api_key' });
  assert.doesNotMatch(out + err, /private-test-key/);
  assert.equal(JSON.parse(await readFile(join(f.root, 'auth.json'), 'utf8')).work.key, 'private-test-key');
  assert.equal((await f.services.provider.listModels()).models[0].id, 'work/model');
  for (const event of await new Reader(f.input.directory).read(0)) assert.doesNotMatch(JSON.stringify(event), /private-test-key/);
});

test('the real Python host client reads gateway failure status', async t => {
  const f = await fixture(t);
  const child = spawn('python3', [helper, f.root, 'status', '{}'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', value => { out += value; });
  child.stderr.on('data', value => { err += value; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0, err);
  assert.deepEqual(JSON.parse(out), { recent_failures: [] });
});

test('OAuth URLs, selections, and manual codes round-trip through correlated events', async t => {
  const f = await fixture(t, async interaction => {
    interaction.notify({ type: 'auth_url', url: 'https://example.invalid/authorize', instructions: 'Authorize here' });
    assert.equal(await interaction.prompt({ type: 'select', message: 'Method', options: [{ id: 'manual', label: 'Manual' }, { id: 'device', label: 'Device' }] }), 'manual');
    assert.equal(await interaction.prompt({ type: 'manual_code', message: 'Paste code' }), 'test-code');
    return { type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 3600000 };
  });
  await f.input.send('request', { id: 'oauth', command: 'login', body: { provider: 'test', account: 'work', authentication: 'oauth', interactive: true } });
  assert.match((await f.next('notice')).message, /example.invalid/);
  const choice = await f.next('prompt');
  await f.input.send('answer', { id: 'wrong-request', prompt: choice.prompt, value: '2' });
  await f.input.send('answer', { id: 'oauth', prompt: choice.prompt, value: '1' });
  const code = await f.next('prompt');
  assert.notEqual(choice.prompt, code.prompt);
  await f.input.send('answer', { id: 'oauth', prompt: code.prompt, value: 'test-code' });
  assert.deepEqual((await f.next('result')).result, { account: 'work', authentication: 'oauth' });
});

test('cancelling a pending login leaves credentials untouched and permits another request', async t => {
  const f = await fixture(t);
  await f.input.send('request', { id: 'cancel', command: 'login', body: { provider: 'test', authentication: 'api_key', interactive: true } });
  await f.next('prompt');
  await f.input.send('cancel', { id: 'cancel' });
  assert.equal((await f.next('error')).id, 'cancel');
  await assert.rejects(readFile(join(f.root, 'auth.json')), { code: 'ENOENT' });
  await f.input.send('request', { id: 'models', command: 'models' });
  assert.deepEqual((await f.next('result')).result.models, []);
});

test('an OAuth callback can cancel its own prompt and complete login', async t => {
  const f = await fixture(t, async interaction => {
    const prompt = new AbortController();
    const pending = interaction.prompt({ type: 'manual_code', message: 'Optional code', signal: prompt.signal });
    setTimeout(() => prompt.abort(), 100);
    await assert.rejects(pending, { name: 'AbortError' });
    return { type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 3600000 };
  });
  await f.input.send('request', { id: 'callback', command: 'login', body: { provider: 'test', authentication: 'oauth', interactive: true } });
  const prompt = await f.next('prompt');
  assert.equal((await f.next('prompt.cancelled')).prompt, prompt.prompt);
  assert.equal((await f.next('result')).result.authentication, 'oauth');
});

test('a vanished host releases its login and reads remain available while it waits', async t => {
  const f = await fixture(t, undefined, { idleTimeoutMs: 500 });
  await f.input.send('request', { id: 'gone', command: 'login', body: { provider: 'test', authentication: 'api_key', interactive: true } });
  await f.next('prompt');
  await f.input.send('request', { id: 'read', command: 'models' });
  assert.equal((await f.next('result')).id, 'read');
  assert.equal((await f.next('error')).id, 'gone');
  await assert.rejects(readFile(join(f.root, 'auth.json')), { code: 'ENOENT' });
});

test('a restart rejects commands addressed to the previous gateway instance', async t => {
  const f = await fixture(t);
  const previous = await f.restart();
  await new Writer(f.input.directory).send('request', { id: 'stale', instance: previous, command: 'login', body: { provider: 'test', authentication: 'api_key', interactive: true } });
  assert.match((await f.next('error')).message, /restarted/);
  await assert.rejects(readFile(join(f.root, 'auth.json')), { code: 'ENOENT' });
});
