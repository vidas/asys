import { setTimeout as delay } from "node:timers/promises";

import { Code, ConnectError } from "@connectrpc/connect";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { Modality } from "@cyclo/provider/contract";
import {
  decodePayload,
  encodePayload,
  PI_INFERENCE_FORMAT,
  splitPublicModelId,
} from "@cyclo/provider/protocol";
import { resourceExhaustedRetryAt } from "@cyclo/provider/errors";

const API = "cyclo-pi";
const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const MAX_SAFE_UINT64 = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MIN_EXHAUSTION_RETRY_DELAY_MS = 1_000;
const MAX_EXHAUSTION_RETRY_DELAY_MS = 10 * 60_000;
const RETRYABLE_RPC_CODES = new Set([Code.Unavailable, Code.DeadlineExceeded, Code.Aborted, Code.Canceled]);
const NETWORK_ERRORS = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND",
  "ENETUNREACH", "EHOSTUNREACH", "ERR_STREAM_PREMATURE_CLOSE", "ERR_STREAM_DESTROYED",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);

export const DEFAULT_INFERENCE_IDLE_TIMEOUT_MS = 600_000;

// Catalogue lookup precedes the first inference and needs the same transport
// recovery as inference. Each RPC retains its existing ten-second deadline.
export async function listProviderModels(client, { signal } = {}, {
  now = Date.now, sleep = abortableSleep, random = Math.random,
  onExhaustion = () => {}, onRetry = () => {},
} = {}) {
  for (let retry = 0; ; retry++) {
    signal?.throwIfAborted();
    try {
      const catalogue = await client.listModels({}, { signal, timeoutMs: 10000 });
      signal?.throwIfAborted();
      return catalogue;
    } catch (error) {
      await waitForProviderRetry(error, retry, { signal, now, sleep, random, onExhaustion, onRetry },
        { operation: "list_models" });
    }
  }
}

export function groupModels(models, { onInvalid = console.warn } = {}) {
  if (!Array.isArray(models)) throw new TypeError("Provider catalogue has no model list");
  if (typeof onInvalid !== "function") throw new TypeError("onInvalid must be a function");
  const groups = new Map();
  const publicIds = new Set();

  for (const portable of models) {
    let provider;
    let id;
    try {
      const split = splitPublicModelId(portable?.id);
      if (!split) throw new TypeError(`model id ${portable?.id} must be PROVIDER/MODEL`);
      ({ provider, model: id } = split);
      if (publicIds.has(portable.id)) throw new TypeError(`duplicate model ${portable.id}`);
      const model = piModel(portable, id);
      publicIds.add(portable.id);
      const group = groups.get(provider) ?? [];
      group.push({ publicId: portable.id, model });
      groups.set(provider, group);
    } catch (error) {
      onInvalid(diagnosticMessage(error));
    }
  }
  return groups;
}

function diagnosticMessage(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 512) || "invalid provider model";
}

// This is the only Pi-to-wire boundary. Context and inference options are
// serialized once, then every Provider component sees one opaque string.
export function streamProvider(
  client,
  publicId,
  model,
  context,
  options = {},
  { now = Date.now, sleep = abortableSleep, random = Math.random,
    idleTimeoutMs = DEFAULT_INFERENCE_IDLE_TIMEOUT_MS, onExhaustion = () => {}, onRetry = () => {} } = {},
) {
  const output = createAssistantMessageEventStream();
  void pump(output, client, publicId, model, context, options, { now, sleep, random, idleTimeoutMs, onExhaustion, onRetry });
  return output;
}

async function pump(output, client, publicId, model, context, options, { now, sleep, random, idleTimeoutMs, onExhaustion, onRetry }) {
  let latestAssistant;
  try {
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0 || idleTimeoutMs > MAX_TIMER_DELAY_MS) {
      throw new TypeError(`inference idle timeout must be an integer between 1 and ${MAX_TIMER_DELAY_MS} milliseconds`);
    }
    const request = Object.freeze({
      model: publicId,
      payload: encodePayload({
        context: { ...context, messages: context.messages.map(toProviderMessage) },
        options: inferenceOptions(options),
      }),
    });
    // One logical Pi call can make several RPC attempts against any Provider.
    // The saved request excludes unfinished output and retains completed tools.
    let emitted = false;
    for (let retry = 0; ; retry++) {
      options.signal?.throwIfAborted();
      const replacingPartial = emitted;
      try {
        for await (const response of inferenceAttempt(client, request, options.signal, idleTimeoutMs)) {
          const event = decodePayload(response.payload);
          const received = event.partial ?? event.message ?? event.error;
          if (received?.role === "assistant"
            && (event.type !== "error" || received.content?.length || !latestAssistant?.content?.length)) {
            latestAssistant = toPiMessage(received, publicId);
          }
          if (event.type === "error" && !isContextOverflow(event.error, model.contextWindow)
            && isRetryableAssistantError(event.error)) {
            // Reuse the pinned Pi classifier for native error events. RPC
            // failures below are classified by codes, not by error text.
            throw new ConnectError(providerErrorMessage(event.error.errorMessage), Code.Unavailable);
          }
          const terminal = event.type === "done" || event.type === "error";
          // A second Pi start would append another assistant message. Complete
          // the existing pending message with the replacement's final result.
          if (replacingPartial && !terminal) continue;
          // Every streamed view must agree with the model registered in Pi.
          for (const field of ["partial", "message", "error"]) {
            if (event[field]?.role === "assistant") event[field] = toPiMessage(event[field], publicId);
          }
          output.push(event);
          emitted = true;
          if (terminal) return;
        }
        throw new ConnectError("Provider stream ended without a terminal Pi event", Code.Unavailable);
      } catch (error) {
        // End the failed RPC before waiting; capacity waits have no idle timer.
        await waitForProviderRetry(error, retry,
          { signal: options.signal, now, sleep, random, onExhaustion, onRetry },
          { outputStarted: emitted, idleTimeoutMs });
      }
    }
  } catch (error) {
    const aborted = options.signal?.aborted;
    // Preserve received content as interrupted evidence. Both Pi and the swarm
    // worker reject error/aborted responses before executing any tool calls.
    const message = latestAssistant ? structuredClone(latestAssistant) : assistantMessage(model);
    for (const block of Array.isArray(message.content) ? message.content : []) {
      // These are native streaming parser buffers, not recorded tool arguments.
      if (block && typeof block === "object") { delete block.partialJson; delete block.customInput; }
    }
    message.stopReason = aborted ? "aborted" : "error";
    message.errorMessage = aborted
      ? "Provider request aborted"
      : `Provider request failed: ${providerErrorMessage(error)}`;
    output.push({
      type: "error",
      reason: message.stopReason,
      error: message,
    });
  }
}

async function* inferenceAttempt(client, request, signal, idleTimeoutMs) {
  const controller = new AbortController();
  const attempt = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let iterator, started = false;
  try {
    attempt.throwIfAborted();
    iterator = client.infer(request, { signal: attempt })[Symbol.asyncIterator]();
    while (true) {
      attempt.throwIfAborted();
      const aborted = Promise.withResolvers();
      const onAbort = () => aborted.reject(attempt.reason);
      attempt.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(new ConnectError(
        `Provider ${started ? "stream inactivity" : "first response timeout"} after ${idleTimeoutMs} ms`, Code.DeadlineExceeded,
      )), idleTimeoutMs);
      let next;
      try { next = await Promise.race([iterator.next(), aborted.promise]); }
      finally { clearTimeout(timer); attempt.removeEventListener("abort", onAbort); }
      attempt.throwIfAborted();
      if (next.done) return;
      started = true;
      yield next.value;
    }
  } catch (error) {
    throw attempt.aborted ? attempt.reason : error;
  } finally {
    controller.abort(new Error("inference attempt finished"));
    // A disconnected or broken iterator must not trap cancellation/recovery.
    void Promise.resolve().then(() => iterator?.return?.()).catch(() => {});
  }
}

function retryableTransportError(error) {
  if (error instanceof ConnectError && RETRYABLE_RPC_CODES.has(error.code)) return true;
  for (let depth = 0; error && depth < 8; depth++, error = error.cause) {
    if (NETWORK_ERRORS.has(error.code)) return true;
  }
  return false;
}

async function waitForProviderRetry(error, retry, { signal, now, sleep, random, onExhaustion, onRetry }, extra) {
  signal?.throwIfAborted();
  const retryAt = resourceExhaustedRetryAt(error);
  const exhausted = error instanceof ConnectError && error.code === Code.ResourceExhausted;
  if (!exhausted && !retryableTransportError(error)) throw error;
  const delayMs = retryAt === undefined
    ? Math.round(Math.min(30_000, 1000 * 2 ** Math.min(retry, 5)) * (0.5 + random() * 0.5))
    : Math.min(MAX_EXHAUSTION_RETRY_DELAY_MS,
      Math.max(MIN_EXHAUSTION_RETRY_DELAY_MS, retryAt.getTime() - now()));
  const detail = { attempt: retry + 1, delayMs, errorMessage: providerErrorMessage(error),
    ...extra, retryAt: new Date(now() + delayMs) };
  if (exhausted) onExhaustion(detail);
  else onRetry(detail);
  signal?.throwIfAborted();
  try { await sleep(delayMs, signal); }
  catch (error) { signal?.throwIfAborted(); throw error; }
  signal?.throwIfAborted();
  if (exhausted) onRetry({ ...detail, delayMs: 0 });
}

// Pi compares assistant identities with the selected public route when deciding
// whether to recover from context overflow. The gateway needs the original
// identity to replay native reasoning/signatures. Keep it in local session data
// and restore it before history crosses the Provider interface.
export function toPiMessage(message, publicId) {
  if (message.role !== "assistant") return message;
  const native = toProviderMessage(message);
  const { provider, model } = splitPublicModelId(publicId);
  if (native.api === API && native.provider === provider && native.model === model) return native;
  return {
    ...native, api: API, provider, model,
    asysNativeIdentity: { api: native.api, provider: native.provider, model: native.model },
  };
}

export function toProviderMessage(message) {
  if (message.role !== "assistant" || !message.asysNativeIdentity) return message;
  const { asysNativeIdentity, ...native } = message;
  return { ...native, api: asysNativeIdentity.api, provider: asysNativeIdentity.provider, model: asysNativeIdentity.model };
}

function abortableSleep(delayMs, signal) {
  return delay(delayMs, undefined, { signal });
}

// These values control the local process or the credential boundary; they are
// not inference data and therefore never enter the payload. All other JSON
// options, including provider-specific options unknown to Cyclo, pass through.
function inferenceOptions(options) {
  const {
    signal: _signal,
    apiKey: _apiKey,
    headers: _headers,
    env: _env,
    client: _client,
    onPayload: _onPayload,
    onResponse: _onResponse,
    transport: _transport,
    timeoutMs: _timeoutMs,
    websocketConnectTimeoutMs: _websocketConnectTimeoutMs,
    maxRetries: _maxRetries,
    maxRetryDelayMs: _maxRetryDelayMs,
    ...inference
  } = options;
  return inference;
}

function providerErrorMessage(error) {
  const raw = error instanceof Error ? error.message : String(error ?? "unknown error");
  const safe = raw.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return safe.slice(0, 512) || "unknown provider error";
}

function piModel(portable, id) {
  if (portable?.inferenceFormat !== PI_INFERENCE_FORMAT) {
    throw new TypeError(
      `model ${portable?.id} uses unsupported inference format ${portable?.inferenceFormat || "(missing)"}`,
    );
  }
  const capabilities = portable?.capabilities;
  if (!capabilities || !Array.isArray(capabilities.inputModalities)
      || !Array.isArray(capabilities.outputModalities)) {
    throw new TypeError(`model ${portable?.id} has invalid capabilities`);
  }
  if ((portable.extensions ?? []).length || (capabilities.extensionTypes ?? []).length) {
    throw new TypeError(`model ${portable.id} requires unsupported catalogue extensions`);
  }
  const allowedInput = new Set([Modality.TEXT, Modality.IMAGE]);
  if (!capabilities.inputModalities.includes(Modality.TEXT)
      || capabilities.inputModalities.some((value) => !allowedInput.has(value))) {
    throw new TypeError(`model ${portable.id} has unsupported input modalities`);
  }
  if (capabilities.outputModalities.length !== 1
      || capabilities.outputModalities[0] !== Modality.TEXT) {
    throw new TypeError(`model ${portable.id} has unsupported output modalities`);
  }
  if (portable.displayName !== undefined && typeof portable.displayName !== "string") {
    throw new TypeError(`model ${portable.id} has an invalid display name`);
  }
  return Object.freeze({
    id,
    name: portable.displayName || id,
    reasoning: capabilities.reasoning === true,
    input: Object.freeze(capabilities.inputModalities.includes(Modality.IMAGE)
      ? ["text", "image"]
      : ["text"]),
    cost: ZERO_COST,
    contextWindow: uint64Number(portable.contextWindowTokens, "context window", portable.id),
    maxTokens: uint64Number(portable.maxOutputTokens, "output limit", portable.id),
  });
}

function uint64Number(value, label, model) {
  if (typeof value !== "bigint" || value <= 0n || value > MAX_SAFE_UINT64) {
    throw new TypeError(`model ${model} has no usable ${label}`);
  }
  return Number(value);
}

function assistantMessage(model) {
  return {
    role: "assistant",
    content: [],
    api: API,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
