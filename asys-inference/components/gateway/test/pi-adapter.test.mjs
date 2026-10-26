import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Code, ConnectError } from "@connectrpc/connect";
import { resourceExhaustedRetryAt } from "@cyclo/provider/errors";
import { PI_INFERENCE_FORMAT } from "@cyclo/provider/protocol";

import { createPiAdapter } from "../src/pi-adapter.mjs";

test("pins the native Pi implementation to the advertised inference format", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(
    PI_INFERENCE_FORMAT,
    `pi-ai@${manifest.dependencies["@earendil-works/pi-ai"]}`,
  );
});

test("decodes only the Pi call frame and preserves every native event", async () => {
  let invocation;
  const events = [
    { type: "start", partial: { future: { nested: true } } },
    {
      type: "future_pi_event",
      schema: { anyOf: [{ type: "boolean" }, { enum: ["always"] }] },
      unknown: [null, 3, "\u2603"],
    },
    { type: "done", reason: "stop", message: { usage: usage() } },
  ];
  const adapter = createPiAdapter();
  const selectedRoute = route(
    "openai-responses",
    (model, context, options) => {
      invocation = { model, context, options };
      return stream(events);
    },
  );
  const frame = {
    context: {
      messages: [{ role: "future-role", content: "opaque" }],
      tools: [{ name: "odd name", parameters: { anyOf: [] } }],
      futureContextField: { untouched: true },
    },
    options: {
      reasoning: "high",
      futureOption: { untouched: true },
      apiKey: "hostile-key",
      headers: { authorization: "hostile" },
      identity: { userAgent: { custom: "hostile" }, attribution: { name: "hostile", url: "https://hostile.example" } },
      telemetry: { hostile: true },
      env: { SECRET: "hostile" },
      transport: "websocket",
      timeoutMs: 999_999,
      websocketConnectTimeoutMs: 999_999,
      maxRetries: 99,
      maxRetryDelayMs: 999_999,
    },
  };

  const responses = [];
  for await (const response of adapter.infer(
    selectedRoute,
    JSON.stringify(frame),
    new AbortController().signal,
  )) responses.push(response);

  assert.deepEqual(invocation.context, frame.context);
  assert.equal(invocation.options.reasoning, "high");
  assert.deepEqual(invocation.options.futureOption, { untouched: true });
  assert.equal(invocation.options.apiKey, "gateway-key");
  assert.equal(invocation.options.maxRetries, 0);
  assert.equal(invocation.options.headers, undefined);
  assert.equal(invocation.options.identity, undefined);
  assert.equal(invocation.options.telemetry, undefined);
  assert.equal(invocation.options.env, undefined);
  assert.equal(invocation.options.transport, undefined);
  assert.equal(invocation.options.timeoutMs, undefined);
  assert.equal(invocation.options.websocketConnectTimeoutMs, undefined);
  assert.equal(invocation.options.maxRetryDelayMs, undefined);
  assert.deepEqual(responses.map(({ payload }) => JSON.parse(payload)), events);
  assert.deepEqual(responses.at(-1).usage, {
    inputTokens: 14,
    outputTokens: 5,
    cachedInputTokens: 3,
    reasoningTokens: 2,
  });
});

test("disables native SDK retries for every supported Pi API", async () => {
  const expected = new Map([
    ["anthropic-messages", { maxRetries: 0 }],
    ["openai-codex-responses", {
      maxRetries: 0,
      transport: "sse",
    }],
    ["openai-responses", { maxRetries: 0 }],
  ]);

  for (const [api, retry] of expected) {
    let invocation;
    const adapter = createPiAdapter();
    await collect(adapter.infer(
      route(api, (_model, _context, options) => {
        invocation = options;
        return stream([{ type: "done", reason: "stop", message: { usage: usage() } }]);
      }),
      JSON.stringify({
        context: {},
        options: {
          maxRetries: 99,
          maxRetryDelayMs: 999_999,
          transport: "websocket",
        },
      }),
      new AbortController().signal,
    ));

    assert.equal(invocation.maxRetries, retry.maxRetries, api);
    assert.equal(invocation.maxRetryDelayMs, retry.maxRetryDelayMs, api);
    assert.equal(invocation.transport, retry.transport, api);
  }
});

test("returns typed Codex exhaustion immediately from Retry-After", async () => {
  const now = Date.parse("2031-02-03T04:05:06Z");
  let calls = 0;
  const adapter = createPiAdapter({
    now: () => now,
  });

  await assert.rejects(
    collect(adapter.infer(
      route("openai-codex-responses", (_model, _context, options) => {
        calls += 1;
        return terminalUsageLimit(
          options,
          { "retry-after": "7200" },
          () => {},
          "You have hit your ChatGPT usage limit for private-account-name.",
        );
      }),
      JSON.stringify({ context: {}, options: {} }),
      new AbortController().signal,
    )),
    (error) => error instanceof ConnectError
      && error.code === Code.ResourceExhausted
      && error.rawMessage === "provider resource exhausted"
      && resourceExhaustedRetryAt(error)?.getTime() === now + 7_200_000
      && !error.message.includes("private-account-name"),
  );

  assert.equal(calls, 1);
});

test("returns typed exhaustion for every native API", async () => {
  const now = Date.parse("2031-02-03T04:05:06Z");
  for (const [api, headers] of [
    ["anthropic-messages", { "retry-after": "41" }],
    ["openai-responses", new Headers({ "retry-after": "41" })],
  ]) {
    let calls = 0;
    const adapter = createPiAdapter({
      now: () => now,
    });

    await assert.rejects(
      collect(adapter.infer(
        route(api, (_model, _context, options) => {
          calls += 1;
          return terminalUsageLimit(options, headers);
        }),
        JSON.stringify({ context: {}, options: {} }),
        new AbortController().signal,
      )),
      (error) => error instanceof ConnectError
        && error.code === Code.ResourceExhausted
        && resourceExhaustedRetryAt(error)?.getTime() === now + 41_000,
      api,
    );
    assert.equal(calls, 1, api);
  }
});

test("returns typed Codex exhaustion from a body-only reset", async () => {
  const now = Date.parse("2031-02-03T04:05:06Z");
  let calls = 0;
  const adapter = createPiAdapter({
    now: () => now,
  });

  await assert.rejects(
    collect(adapter.infer(
      route("openai-codex-responses", (_model, _context, options) => {
        calls += 1;
        return terminalUsageLimit(
          options,
          {},
          () => {},
          "You have hit your ChatGPT usage limit. Try again in ~37 min.",
        );
      }),
      JSON.stringify({ context: {}, options: {} }),
      new AbortController().signal,
    )),
    (error) => resourceExhaustedRetryAt(error)?.getTime() === now + 37 * 60_000,
  );

  assert.equal(calls, 1);
});

test("never replays ambiguous native failures", async () => {
  for (const [name, failure] of [
    ["invalid request", (options) => terminalProviderError(options, 400)],
    ["transport message", () => stream([{
      type: "error",
      reason: "error",
      error: { errorMessage: "fetch failed", usage: usage() },
    }])],
  ]) {
    let calls = 0;
    const adapter = createPiAdapter();

    const responses = await collect(adapter.infer(
      route("openai-codex-responses", (_model, _context, options) => {
        calls += 1;
        return failure(options);
      }),
      JSON.stringify({ context: {}, options: {} }),
      new AbortController().signal,
    ));

    assert.equal(calls, 1, name);
    assert.deepEqual(
      responses.map(({ payload }) => JSON.parse(payload).type),
      ["error"],
      name,
    );
  }
});

for (const status of [408, 500, 502, 503, 504, 529]) {
  for (const partial of [false, true]) {
    test(`HTTP ${status} ${partial ? 'after partial output' : 'before output'} returns a retryable error without replay`, async () => {
      let calls = 0;
      const events = [];
      const adapter = createPiAdapter();
      await assert.rejects(async () => {
        for await (const response of adapter.infer(route('openai-codex-responses', (_model, _context, options) => {
          calls++;
          return (async function* () {
            if (partial) yield { type: 'start', partial: {} };
            yield* terminalProviderError(options, status);
          })();
        }), JSON.stringify({ context: {} }), new AbortController().signal)) events.push(JSON.parse(response.payload));
      }, error => error.code === Code.Unavailable && error.message.includes(`HTTP ${status}`));
      assert.equal(calls, 1);
      assert.deepEqual(events.map(event => event.type), partial ? ['start'] : []);
    });
  }
}

test('cancellation releases a stalled native iterator without replay', { timeout: 2000 }, async () => {
  const controller = new AbortController(), waiting = Promise.withResolvers();
  let calls = 0, nativeSignal;
  const pending = collect(createPiAdapter().infer(route('openai-codex-responses', (_model, _context, options) => {
    calls++;
    nativeSignal = options.signal;
    return (async function* () { waiting.resolve(); await new Promise(() => {}); })();
  }), JSON.stringify({ context: {} }), controller.signal));
  await waiting.promise;
  controller.abort();
  await assert.rejects(pending, error => error.code === Code.Canceled);
  assert.equal(calls, 1);
  assert.ok(nativeSignal.aborted);
});

test('a native iterator ending without a terminal event returns a retryable error', async () => {
  let calls = 0;
  await assert.rejects(collect(createPiAdapter().infer(route('openai-codex-responses', () => {
    calls++;
    return stream([{ type: 'start', partial: {} }]);
  }), JSON.stringify({ context: {} }), new AbortController().signal)), error =>
    error.code === Code.Unavailable && /terminal Pi event/.test(error.message));
  assert.equal(calls, 1);
});

test('exhaustion after partial output propagates immediately with its reset time', async () => {
  let calls = 0;
  const now = Date.parse('2031-02-03T04:05:06Z');
  await assert.rejects(collect(createPiAdapter({ now: () => now }).infer(
    route('openai-codex-responses', (_model, _context, options) => {
      calls++;
      return partialThenLimited(options);
    }), JSON.stringify({ context: {} }), new AbortController().signal,
  )), error => error.code === Code.ResourceExhausted && resourceExhaustedRetryAt(error)?.getTime() === now + 7_200_000);
  assert.equal(calls, 1);
});

test("preserves Pi event content that contains no gateway credential", async () => {
  const event = {
    type: "done",
    reason: "future-reason",
    message: {
      content: [{
        type: "future-content",
        text: "provider output remains byte-for-byte JSON data",
        schema: { __proto__: null, anyOf: [true, false] },
      }],
      usage: usage(),
    },
  };
  const adapter = createPiAdapter();
  const [response] = await collect(adapter.infer(
    route("openai-responses", () => stream([event])),
    JSON.stringify({ context: {}, options: {} }),
    new AbortController().signal,
  ));
  assert.equal(response.payload, JSON.stringify(event));
});

test("fails closed when a native event reflects gateway authentication material", async () => {
  const apiKey = "comma,key";
  const headerSecret = "quote\"slash\\line\nsnowman\u2603";
  const event = {
    type: "error",
    [`header-${headerSecret}`]: "credential in a property name",
    error: {
      errorMessage: `upstream rejected Bearer ${apiKey} twice: ${apiKey}`,
    },
  };
  const original = structuredClone(event);
  const adapter = createPiAdapter();

  await assert.rejects(
    collect(adapter.infer(
      route("openai-responses", () => stream([event]), {
        credential: { type: "api_key", key: apiKey },
        auth: {
          auth: {
            apiKey,
            headers: { authorization: headerSecret },
          },
        },
      }),
      JSON.stringify({ context: {}, options: {} }),
      new AbortController().signal,
    )),
    (error) => error instanceof ConnectError
      && error.code === Code.DataLoss
      && !error.rawMessage.includes(apiKey)
      && !error.rawMessage.includes(headerSecret),
  );
  assert.deepEqual(event, original);
});

test("protects an authentication-header value independently of the API key", async () => {
  const apiKey = "unreflected-api-key";
  const headerSecret = "private-auth-header-value";
  const adapter = createPiAdapter();

  await assert.rejects(
    collect(adapter.infer(
      route("openai-responses", () => stream([{
        type: "error",
        error: { errorMessage: `upstream reflected ${headerSecret}` },
      }]), {
        credential: { type: "api_key", key: apiKey },
        auth: { auth: { apiKey, headers: { authorization: headerSecret } } },
      }),
      JSON.stringify({ context: {}, options: {} }),
      new AbortController().signal,
    )),
    (error) => error instanceof ConnectError
      && error.code === Code.DataLoss
      && !error.rawMessage.includes(headerSecret),
  );
});

test("sanitizes Connect errors thrown by a native iterator", async () => {
  const secret = "private-native-error-secret";
  const adapter = createPiAdapter();

  await assert.rejects(
    collect(adapter.infer(
      route("openai-responses", () => failingStream(new ConnectError(
        `native error reflected ${secret}`,
        Code.Internal,
        { "x-upstream-error": secret },
      )), {
        credential: { type: "api_key", key: secret },
      }),
      JSON.stringify({ context: {}, options: {} }),
      new AbortController().signal,
    )),
    (error) => error instanceof ConnectError
      && error.code === Code.Internal
      && error.rawMessage === "upstream inference failed"
      && !Array.from(error.metadata.entries()).flat().join("\n").includes(secret),
  );
});

test("rejects malformed framing but never validates context contents", async () => {
  const adapter = createPiAdapter();
  for (const payload of ["not-json", "null", "{}", '{"context":{},"options":[]}']) {
    const iterator = adapter.infer(
      route(),
      payload,
      new AbortController().signal,
    )[Symbol.asyncIterator]();
    await assert.rejects(
      iterator.next(),
      (error) => error instanceof ConnectError && error.code === Code.InvalidArgument,
    );
  }
});

test("maps cancellation and upstream failures to transport errors", async () => {
  const controller = new AbortController();
  controller.abort(new Error("private detail"));
  const adapter = createPiAdapter();
  const iterator = adapter.infer(
    route("openai-responses", () => { throw new Error("private upstream"); }),
    JSON.stringify({ context: {}, options: {} }),
    controller.signal,
  )[Symbol.asyncIterator]();
  await assert.rejects(
    iterator.next(),
    (error) => error instanceof ConnectError
      && error.code === Code.Canceled
      && !error.rawMessage.includes("private"),
  );
});

function route(
  api = "openai-responses",
  streamer = () => stream([]),
  {
    credential = { type: "api_key", key: "gateway-key" },
    auth = { auth: { apiKey: credential?.key } },
  } = {},
) {
  const provider = api === "openai-codex-responses"
    ? "openai-codex"
    : api === "anthropic-messages"
      ? "anthropic"
      : "openai";
  const rawModel = {
    id: "model",
    provider,
    api,
    baseUrl: "https://example.invalid/v1",
  };
  return {
    publicModel: { id: "work/model" },
    provider,
    rawModel,
    credentialStore: {
      async read(providerId, options = {}) {
        assert.equal(providerId, provider);
        options.signal?.throwIfAborted();
        return structuredClone(credential);
      },
    },
    models: {
      streamSimple(model, context, options) {
        const resolved = auth.auth ?? {};
        const headers = options.transformHeaders?.(resolved.headers ?? {})
          ?? resolved.headers;
        const { transformHeaders: _transformHeaders, ...providerOptions } = options;
        return streamer(model, context, {
          ...providerOptions,
          ...(resolved.apiKey === undefined ? {} : { apiKey: resolved.apiKey }),
          ...(headers === undefined || Object.keys(headers).length === 0
            ? {}
            : { headers }),
        });
      },
    },
  };
}

function usage() {
  return {
    input: 7,
    output: 5,
    cacheRead: 3,
    cacheWrite: 4,
    reasoning: 2,
    totalTokens: 19,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

async function* stream(events) {
  for (const event of events) yield event;
}

async function* failingStream(error) {
  throw error;
}

async function* terminalUsageLimit(
  options,
  headers = {},
  responseSeen = () => {},
  errorMessage = "You have hit your ChatGPT usage limit.",
) {
  await options.onResponse({ status: 429, headers });
  responseSeen();
  yield {
    type: "error",
    reason: "error",
    error: {
      errorMessage,
      usage: usage(),
    },
  };
}

async function* terminalProviderError(
  options,
  status,
  headers = {},
  responseSeen = () => {},
) {
  await options.onResponse({ status, headers });
  responseSeen();
  yield {
    type: "error",
    reason: "error",
    error: { errorMessage: "provider request failed", usage: usage() },
  };
}

async function* partialThenLimited(options) {
  await options.onResponse({ status: 429, headers: { "retry-after": "7200" } });
  yield { type: "start", partial: {} };
  yield {
    type: "error",
    reason: "error",
    error: { errorMessage: "You have hit your ChatGPT usage limit.", usage: usage() },
  };
}

async function collect(values) {
  const result = [];
  for await (const value of values) result.push(value);
  return result;
}
