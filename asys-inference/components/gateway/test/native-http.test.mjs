import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as zlib from "node:zlib";

import { Code, ConnectError } from "@connectrpc/connect";
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { resourceExhaustedRetryAt } from "@cyclo/provider/errors";

import { createPiAdapter } from "../src/pi-adapter.mjs";
import { createGatewayServices } from "../src/services.mjs";
import { runTestAgent, model as testModel } from "../../../../asys-workers/test/helpers.mjs";
import { streamProvider } from "../../../../asys-workers/src/provider-adapter.mjs";

for (const close of [true, false]) {
  test(`native context overflow survives stream cleanup (close=${close})`, async t => {
    let calls = 0;
    const upstream = createServer(async (request, response) => {
      for await (const chunk of request) {}
      calls++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const error = { code: 'context_length_exceeded', message: 'Your input exceeds the context window of this model. Please adjust your input and try again.' };
      response.write(`data: ${JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', ...error } })}\n\n`);
      response.write(`data: ${JSON.stringify({ type: 'response.failed', response: { error } })}\n\n`);
      if (close) response.end();
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    t.after(() => { upstream.closeAllConnections(); upstream.close(); });
    const events = await inferWithAgent(
      route(`http://127.0.0.1:${upstream.address().port}`, 'openai-codex-responses', codexToken()), t.signal,
      { sleep: async () => assert.fail('context overflow must reach Pi instead of retrying transport') },
    );
    assert.equal(calls, 1);
    assert.equal(events.at(-1).type, 'error');
    assert.match(events.at(-1).error.errorMessage, /exceeds the context window/);
  });
}

test('native overflow reaches Pi, compacts and resumes without replaying completed tools', { timeout: 15000 }, async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'asys-native-compaction-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  let calls = 0, tools = 0;
  const audit = [], warnings = [], events = [];
  const upstream = createServer(async (request, response) => {
    for await (const chunk of request) {}
    calls++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (calls === 2) {
      const error = { code: 'context_length_exceeded', message: 'Your input exceeds the context window of this model. Please adjust your input and try again.' };
      response.write(`data: ${JSON.stringify({ type: 'error', error })}\n\n`);
      return; // Pi must cancel this stream after reading the semantic error.
    }
    let frames;
    if (calls === 1) {
      const item = { id: 'fc_test', type: 'function_call', call_id: 'call_test', name: 'produce_context', arguments: '{}', status: 'completed' };
      const completed = nativeEvents().at(-1).response;
      frames = [nativeEvents()[0],
        { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
        { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: '{}' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { ...completed, output: [item] } }];
    } else {
      const text = calls === 3 ? 'The completed tool produced context. Continue the remaining task.'
        : JSON.stringify({ final: 'Finished after native compaction', exception: null });
      frames = nativeEvents(text);
    }
    for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
    response.end();
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const selected = route(`http://127.0.0.1:${upstream.address().port}`, 'openai-codex-responses', codexToken());
  const publicModel = { ...testModel, id: 'work/gpt-test' };
  const services = await createGatewayServices({
    catalogue: { models: [publicModel], routes: { [publicModel.id]: { ...selected, account: 'work' } } },
    audit: { async record(entry) { audit.push(entry); } }, warn(message) { warnings.push(message); },
  });
  const job = { id: 'native-recovery' };
  const result = await runTestAgent({ config: { model: publicModel.id, prompt: 'Perform the task.', maxSteps: 8, options: {} },
    job, workspace, signal: t.signal, provider: services.provider, save() {}, event(type, data) { events.push({ type, ...data }); },
    customTools: [{ name: 'produce_context', label: 'Produce context', description: 'Test context producer', parameters: { type: 'object', properties: {} },
      async execute() { tools++; return { content: [{ type: 'text', text: 'Test data '.repeat(12000) }] }; } }],
  });
  assert.equal(result.final, 'Finished after native compaction');
  assert.equal(calls, 4);
  assert.equal(tools, 1);
  assert.equal(job.agent.session.entries.filter(e => e.type === 'compaction').length, 1);
  assert.ok(events.some(e => e.type === 'agent.compaction_ended' && e.willRetry && !e.errorMessage));
  const failure = audit.find(e => e.failure);
  assert.equal(failure.outcome, 'provider_error');
  assert.equal(failure.failure.type, 'context_overflow');
  assert.equal(failure.failure.http_status, 200);
  assert.match(warnings.join('\n'), /exceeds the context window/);
  assert.equal(services.diagnostics.recentFailures()[0].failure.request_id, failure.failure.request_id);
});

test('the agent retries a native HTTP 502 without exposing the error page', async t => {
  const requests = [], delays = [];
  const upstream = createServer(async (incoming, response) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    requests.push(JSON.parse((incoming.headers['content-encoding'] === 'zstd' ? zlib.zstdDecompressSync(bytes) : bytes).toString('utf8')));
    if (requests.length === 1) {
      response.writeHead(502, { 'content-type': 'text/html' });
      response.end('<html><body><h1>Bad Gateway</h1></body></html>');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of nativeEvents()) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const events = await inferWithAgent(
    route(`http://127.0.0.1:${upstream.address().port}`, 'openai-codex-responses', codexToken()), t.signal,
    { random: () => 1, sleep: async ms => delays.push(ms) },
  );
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(delays, [1000]);
  assert.equal(events.at(-1).type, 'done');
  assert.ok(!events.some(event => event.type === 'error'));
});

for (const failure of ['no response', 'silent partial stream', 'disconnected partial stream', 'cleanly closed partial stream']) {
  test(`the agent recovers from native ${failure} by repeating Infer`, { timeout: 5000 }, async t => {
    const requests = [], logs = [];
    const closed = Promise.withResolvers();
    const upstream = createServer(async (incoming, response) => {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      requests.push(JSON.parse((incoming.headers['content-encoding'] === 'zstd' ? zlib.zstdDecompressSync(bytes) : bytes).toString('utf8')));
      if (requests.length === 1) {
        response.once('close', closed.resolve);
        if (failure === 'no response') return;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of nativeEvents().slice(0, 3)) response.write(`data: ${JSON.stringify(event)}\n\n`);
        if (failure === 'disconnected partial stream') setTimeout(() => response.destroy(), 30);
        else if (failure === 'cleanly closed partial stream') response.end();
        else {
          // Transport heartbeats must not keep a stalled generation alive.
          const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 10);
          response.once('close', () => clearInterval(heartbeat));
        }
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of nativeEvents()) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end('data: [DONE]\n\n');
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    t.after(() => { upstream.closeAllConnections(); upstream.close(); });
    const events = await inferWithAgent(
      route(`http://127.0.0.1:${upstream.address().port}`, 'openai-codex-responses', codexToken()), t.signal,
      { idleTimeoutMs: 200, sleep: async () => {}, onRetry: event => logs.push(event) },
    );
    await closed.promise;
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], requests[1]);
    assert.equal(events.filter(event => event.type === 'start').length, 1);
    assert.equal(events.at(-1).type, 'done');
    assert.equal(events.at(-1).message.content[0].text, 'native ok');
    assert.ok(!events.some(event => event.type === 'error'));
    assert.equal(logs.length, 1);
    assert.match(logs[0].errorMessage, failure === 'no response' ? /first response timeout/
      : failure === 'silent partial stream' ? /stream inactivity/
      : failure === 'cleanly closed partial stream' ? /stream ended/ : /stream interrupted/);
  });
}

test('native Codex requests readable reasoning and forwards summary text unchanged', { timeout: 10000 }, async t => {
  let body;
  const reasoning = { id: 'rs_test', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Check the board before editing.' }] };
  const upstream = createServer(async (incoming, response) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    body = JSON.parse((incoming.headers['content-encoding'] === 'zstd' ? zlib.zstdDecompressSync(bytes) : bytes).toString('utf8'));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = nativeEvents();
    events.splice(1, 0,
      { type: 'response.output_item.added', output_index: 1, item: { ...reasoning, summary: [] } },
      { type: 'response.reasoning_summary_text.delta', output_index: 1, delta: reasoning.summary[0].text },
      { type: 'response.output_item.done', output_index: 1, item: reasoning });
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const selected = route(`http://127.0.0.1:${upstream.address().port}`, 'openai-codex-responses', codexToken());
  selected.rawModel.reasoning = true;
  const events = (await collect(createPiAdapter().infer(selected, JSON.stringify({
    context: { messages: [{ role: 'user', content: 'Check the board.', timestamp: 0 }] }, options: { reasoning: 'medium' },
  }), t.signal))).map(event => JSON.parse(event.payload));
  assert.deepEqual(body.reasoning, { effort: 'medium', summary: 'auto' });
  assert.ok(events.some(event => event.type === 'thinking_delta' && event.delta === reasoning.summary[0].text));
  assert.ok(events.at(-1).message.content.some(block => block.type === 'thinking' && block.thinking === reasoning.summary[0].text));
});

test("the real Pi adapter sends an arbitrary tool schema unchanged", async (t) => {
  let request;
  const upstream = createServer(async (incoming, response) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    request = {
      authorization: incoming.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of nativeEvents()) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const { port } = upstream.address();
  const schema = {
    type: "object",
    properties: {
      refreshRunners: {
        anyOf: [{ type: "boolean" }, { type: "string", enum: ["always", "never"] }],
      },
    },
    "x-unknown-keyword": { nested: true },
  };
  const context = {
    messages: [{ role: "user", content: "hello", timestamp: 0 }],
    tools: [{ name: "lens_diagnostics", description: "Lens", parameters: schema }],
  };
  const output = [];
  for await (const response of createPiAdapter().infer(
    route(`http://127.0.0.1:${port}/v1`, "openai-responses", "test-only-key"),
    JSON.stringify({ context, options: { maxTokens: 32 } }),
    new AbortController().signal,
  )) output.push(JSON.parse(response.payload));

  assert.equal(request.authorization, "Bearer test-only-key");
  assert.deepEqual(request.body.tools[0].parameters, schema);
  assert.deepEqual(output.map(({ type }) => type), [
    "start",
    "text_start",
    "text_delta",
    "text_end",
    "done",
  ]);
  assert.equal(output[2].delta, "native ok");
});

test("the real Codex adapter returns body-only exhaustion without sleeping", async (t) => {
  const now = Date.now();
  let requests = 0;
  const upstream = createServer(async (incoming, response) => {
    for await (const _chunk of incoming) {
      // Drain the request before replying.
    }
    requests += 1;
    if (requests === 1) {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: {
          code: "usage_limit_reached",
          message: "Monthly usage limit reached",
          plan_type: "plus",
          resets_at: Math.floor(now / 1000) + 5 * 60,
        },
      }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of nativeEvents()) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const { port } = upstream.address();
  const adapter = createPiAdapter({
    now: () => now,
  });

  await assert.rejects(
    collect(adapter.infer(
      route(`http://127.0.0.1:${port}`, "openai-codex-responses", codexToken()),
      JSON.stringify({
        context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
        options: { maxTokens: 32 },
      }),
      new AbortController().signal,
    )),
    (error) => error instanceof ConnectError
      && error.code === Code.ResourceExhausted
      && resourceExhaustedRetryAt(error)?.getTime() === now + 5 * 60_000,
  );

  assert.equal(requests, 1);
});

test("the real Anthropic and OpenAI adapters expose SDK 429s as exhaustion", async (t) => {
  const now = Date.parse("2031-02-03T04:05:06Z");
  const cases = [
    ["anthropic-messages", {
      type: "error",
      error: { type: "rate_limit_error", message: "private Anthropic quota detail" },
    }],
    ["openai-responses", {
      error: {
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
        message: "private OpenAI quota detail",
      },
    }],
  ];

  for (const [api, errorBody] of cases) {
    await t.test(api, async (subtest) => {
      let requests = 0;
      const upstream = createServer(async (incoming, response) => {
        for await (const _chunk of incoming) {
          // Drain the request before replying.
        }
        requests += 1;
        response.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "7200",
        });
        response.end(JSON.stringify(errorBody));
      });
      upstream.listen(0, "127.0.0.1");
      await once(upstream, "listening");
      subtest.after(() => new Promise((resolve) => upstream.close(resolve)));
      const { port } = upstream.address();

      await assert.rejects(
        collect(createPiAdapter({ now: () => now }).infer(
          route(
            `http://127.0.0.1:${port}${api === "openai-responses" ? "/v1" : ""}`,
            api,
            "test-only-key",
          ),
          JSON.stringify({
            context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
            options: { maxTokens: 32 },
          }),
          new AbortController().signal,
        )),
        (error) => error instanceof ConnectError
          && error.code === Code.ResourceExhausted
          && resourceExhaustedRetryAt(error)?.getTime() === now + 7_200_000
          && !error.message.includes("private"),
      );
      assert.equal(requests, 1);
    });
  }
});

function route(baseUrl, api = "openai-responses", apiKey = "test-only-key") {
  const provider = api === "anthropic-messages"
    ? "anthropic"
    : api === "openai-codex-responses"
      ? "openai-codex"
      : "openai";
  const rawModel = {
    id: "gpt-test",
    name: "GPT test",
    provider,
    api,
    baseUrl,
    reasoning: false,
    input: ["text"],
    contextWindow: 4096,
    maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const credential = { type: "api_key", key: apiKey };
  const credentialStore = {
    async read() { return structuredClone(credential); },
    async list() { return [{ providerId: provider, type: credential.type }]; },
    async modify(_providerId, fn) {
      return await fn(structuredClone(credential)) ?? structuredClone(credential);
    },
    async delete() {},
  };
  const nativeProvider = createProvider({
    id: provider,
    baseUrl,
    auth: { apiKey: envApiKeyAuth("test key", []) },
    models: [rawModel],
    api: apiStreams(api),
  });
  const models = createModels({ credentials: credentialStore });
  models.setProvider(nativeProvider);
  return {
    publicModel: { id: "work/gpt-test" },
    provider,
    rawModel,
    models,
    credentialStore,
  };
}

function apiStreams(api) {
  if (api === "anthropic-messages") return anthropicMessagesApi();
  if (api === "openai-codex-responses") return openAICodexResponsesApi();
  if (api === "openai-responses") return openAIResponsesApi();
  throw new Error(`unsupported test API ${api}`);
}

function codexToken() {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
  })).toString("base64url");
  return `${header}.${payload}.signature`;
}

function nativeEvents(text = "native ok") {
  const response = {
    id: "resp_test",
    object: "response",
    created_at: 0,
    model: "gpt-test",
    status: "completed",
    output: [],
    usage: {
      input_tokens: 3,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 5,
    },
  };
  const item = {
    id: "msg_test",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    { type: "response.created", response },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 0, item_id: item.id, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { ...response, output: [item] } },
  ];
}

async function collect(values) {
  const result = [];
  for await (const value of values) result.push(value);
  return result;
}

async function inferWithAgent(selected, signal, policy) {
  const adapter = createPiAdapter();
  const client = { infer(request, options) { return adapter.infer(selected, request.payload, options.signal); } };
  return collect(streamProvider(client, selected.publicModel.id, selected.rawModel,
    { messages: [{ role: 'user', content: 'Continue.', timestamp: 0 }] }, { signal }, policy));
}
