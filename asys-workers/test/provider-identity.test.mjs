import test from 'node:test';
import assert from 'node:assert/strict';
import { streamProvider } from '../src/provider-adapter.mjs';
import { assistant } from './helpers.mjs';

test('Pi sees public identities while Provider receives native history, including after serialization', async () => {
  const native = { ...assistant([
    { type: 'thinking', thinking: '', thinkingSignature: 'encrypted-reasoning', redacted: true },
    { type: 'text', text: 'Working', textSignature: 'signed-text' },
    { type: 'toolCall', id: 'call|native', name: 'bash', arguments: { command: 'true' }, thoughtSignature: 'signed-call' },
  ], 'toolUse'), api: 'openai-codex-responses', provider: 'openai-codex', model: 'backend-model',
  responseId: 'native-response', rawStopReason: 'completed', durationMs: 1200 };
  const nativeError = { ...assistant([], 'error'), api: 'anthropic-messages', provider: 'anthropic', model: 'other-backend', errorMessage: 'context length exceeded', durationMs: 300 };
  const routes = [
    { publicId: 'account/alias', model: { provider: 'account', id: 'alias', api: 'cyclo-pi' } },
    { publicId: 'pool/choice', model: { provider: 'pool', id: 'choice', api: 'cyclo-pi' } },
  ];
  const replies = [
    [{ type: 'start', partial: native }, { type: 'text_delta', contentIndex: 1, delta: 'Working', partial: native }, { type: 'done', reason: 'toolUse', message: native }],
    [{ type: 'error', reason: 'error', error: nativeError }],
  ];
  const saved = [];
  for (const [index, route] of routes.entries()) {
    const stream = streamProvider({ async *infer() {
      for (const event of replies[index]) yield { payload: JSON.stringify(event) };
    } }, route.publicId, route.model, { messages: [] });
    for await (const event of stream) {
      const message = event.partial ?? event.message ?? event.error;
      assert.equal(message.provider, route.model.provider);
      assert.equal(message.model, route.model.id);
      assert.equal(message.api, 'cyclo-pi');
      assert.deepEqual(message.content, (index ? nativeError : native).content);
    }
    saved.push(JSON.parse(JSON.stringify(await stream.result())));
  }
  const history = [{ role: 'user', content: 'Continue', timestamp: 1 }, ...saved];
  const originalHistory = structuredClone(history);
  let request;
  const route = routes[1];
  const stream = streamProvider({ async *infer(value) {
    request = value;
    yield { payload: JSON.stringify({ type: 'done', reason: 'stop', message: assistant([]) }) };
  } }, route.publicId, route.model, { messages: history }, { reasoning: 'high' });
  await stream.result();
  assert.equal(request.model, route.publicId);
  assert.deepEqual(JSON.parse(request.payload), {
    context: { messages: [history[0], native, nativeError] }, options: { reasoning: 'high' },
  });
  assert.deepEqual(history, originalHistory, 'serializing a request must not mutate Pi session history');
});
