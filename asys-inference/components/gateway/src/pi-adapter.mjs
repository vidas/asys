import { Code, ConnectError } from "@connectrpc/connect";
import { STATUS_CODES } from "node:http";
import { isContextOverflow } from "@earendil-works/pi-ai/compat";
import { createResourceExhaustedError } from "@cyclo/provider/errors";
import { decodePayload, encodePayload } from "@cyclo/provider/protocol";

import { credentialSecretValues } from "./credentials.mjs";

const DEFAULT_EXHAUSTION_RETRY_MS = 60_000;
const TRANSIENT_HTTP = new Set([408, 500, 502, 503, 504, 529]);
const NETWORK_ERRORS = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN",
  "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);

class GatewayTransientError extends Error {
  constructor(reason) {
    super(typeof reason === "number"
      ? `Upstream HTTP ${reason} ${STATUS_CODES[reason] ?? 'Overloaded'}`
      : reason);
  }
}

class GatewayResponseError extends Error {}
export class GatewayCredentialError extends Error {}
class GatewayResourceExhaustion extends Error {
  constructor(retryAt) {
    super("provider resource exhausted");
    this.retryAt = retryAt;
  }
}

// The gateway terminates the opaque transport because this is where a Pi call
// becomes a native provider request. It does not interpret messages, tools,
// schemas, arguments, or successful model output. Each Infer performs one native
// attempt; the caller owns end-to-end timeouts, retries, and capacity waits.
export function createPiAdapter({ now = Date.now } = {}) {
  return Object.freeze({
    infer(route, payload, signal) {
      return dispatch(route, payload, signal, now);
    },
  });
}

async function* dispatch(route, payload, signal, now) {
  if (
    !route?.models
    || typeof route.models.streamSimple !== "function"
    || !route.credentialStore
    || typeof route.credentialStore.read !== "function"
  ) {
    throw new ConnectError("model adapter is unavailable", Code.FailedPrecondition);
  }

  const frame = piCallFrame(payload);
  const localAbort = new AbortController();
  const dispatchSignal = signal
    ? AbortSignal.any([signal, localAbort.signal])
    : localAbort.signal;
  let transportFailure;
  const reflectionGuard = credentialReflectionGuard([]);

  try {
    const api = route.rawModel.api;
    let credential;
    try {
      credential = await route.credentialStore.read(route.provider, {
        signal: dispatchSignal,
      });
    } catch (error) {
      if (dispatchSignal.aborted) throw error;
      throw new GatewayCredentialError("gateway credential unavailable", {
        cause: error,
      });
    }
    reflectionGuard.add(credentialSecretValues(credential));
    let response;
    const options = gatewayOptions(
      frame.options,
      dispatchSignal,
      api,
      (value) => { response = value; },
      (headers) => {
        reflectionGuard.add(Object.values(headers));
        return headers;
      },
    );
    // Observe transport errors before Pi turns them into terminal text events.
    // Classification uses native error codes, never provider error prose.
    options.fetch = async (...args) => {
      try {
        const result = await globalThis.fetch(...args);
        response = { status: result.status, headers: result.headers };
        if (!result.body || !result.ok) return result;
        const reader = result.body.getReader();
        let cancelled = false;
        const body = new ReadableStream({
          async pull(controller) {
            let next;
            try {
              next = await reader.read();
            } catch (error) {
              if (cancelled || dispatchSignal.aborted) return;
              const code = networkErrorCode(error);
              transportFailure = new GatewayTransientError(`Upstream stream interrupted${code ? ` (${code})` : ""}`);
              controller.error(error);
              return;
            }
            // Pi cancels its reader after a terminal provider error. That can
            // resolve a pending read after this controller is already closed.
            // Cleanup is not an upstream outage and must not replace the error.
            if (cancelled) return;
            if (next.done) { reader.releaseLock(); controller.close(); }
            else controller.enqueue(next.value);
          },
          cancel(reason) { cancelled = true; return reader.cancel(reason); },
        });
        return new Response(body, result);
      } catch (error) {
        const code = networkErrorCode(error);
        if (code) transportFailure = new GatewayTransientError(`Upstream connection failed (${code})`);
        throw error;
      }
    };
    const native = route.models.streamSimple(route.rawModel, frame.context, options);

    for await (const event of nativeEvents(native, localAbort, dispatchSignal)) {
      let encoded;
      try {
        encoded = encodePayload(event);
      } catch {
        throw new GatewayResponseError(
          "upstream emitted a non-JSON Pi event",
        );
      }
      reflectionGuard.check(encoded);

      const retryAt = providerExhaustionRetryAt(api, response, event, now);
      if (retryAt !== undefined) {
        throw new GatewayResourceExhaustion(retryAt);
      }
      if (event.type === "error") {
        if (transportFailure) throw transportFailure;
        const status = nativeErrorStatus(api, response, event);
        if (TRANSIENT_HTTP.has(status)) throw new GatewayTransientError(status);
      }

      const terminal = event.type === "done" || event.type === "error";
      yield {
        payload: encoded,
        usage: eventUsage(event),
        ...(event.type === "error" ? { failure: {
          type: isContextOverflow(event.error, route.rawModel.contextWindow) ? "context_overflow" : "provider_error",
          message: diagnosticText(event.error?.errorMessage || "Provider returned an error"),
          ...(response?.status ? { http_status: response.status } : {}),
        } } : {}),
      };
      if (terminal) return;
    }
    throw new GatewayTransientError("Upstream stream ended before a terminal Pi event");
  } catch (error) {
    if (signal?.aborted) throw upstreamFailure(error, signal);
    if (error instanceof GatewayCredentialError) throw error;
    if (error instanceof GatewayTransientError) throw new ConnectError(error.message, Code.Unavailable);
    if (error instanceof GatewayResourceExhaustion) {
      throw createResourceExhaustedError(error.retryAt);
    }
    if (error instanceof GatewayResponseError) {
      throw new ConnectError(error.message, Code.DataLoss);
    }
    if (transportFailure) throw new ConnectError(transportFailure.message, Code.Unavailable);
    const code = networkErrorCode(error);
    if (code) throw new ConnectError(`Upstream connection failed (${code})`, Code.Unavailable);
    throw upstreamFailure(error, signal);
  } finally {
    localAbort.abort(new Error("gateway native dispatch stopped"));
  }
}

function diagnosticText(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 1024);
}

async function* nativeEvents(native, controller, signal) {
  const iterator = native[Symbol.asyncIterator]();
  try {
    while (true) {
      signal.throwIfAborted();
      const aborted = Promise.withResolvers();
      const onAbort = () => aborted.reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      let next;
      try { next = await Promise.race([iterator.next(), aborted.promise]); }
      finally { signal.removeEventListener("abort", onAbort); }
      signal.throwIfAborted();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    controller.abort(new Error("gateway native dispatch stopped"));
    // A broken iterator may ignore cancellation; it must not trap the caller.
    void Promise.resolve().then(() => iterator.return?.()).catch(() => {});
  }
}

function networkErrorCode(error) {
  for (let depth = 0; error && depth < 8; depth++, error = error.cause) {
    if (NETWORK_ERRORS.has(error.code)) return error.code;
  }
  return undefined;
}

function piCallFrame(payload) {
  let frame;
  try {
    frame = decodePayload(payload);
  } catch {
    throw new ConnectError("Pi payload is not valid JSON", Code.InvalidArgument);
  }
  if (!plainObject(frame) || !("context" in frame)) {
    throw new ConnectError("Pi payload has no call frame", Code.InvalidArgument);
  }
  if (frame.options !== undefined && !plainObject(frame.options)) {
    throw new ConnectError("Pi call options are not an object", Code.InvalidArgument);
  }
  return { context: frame.context, options: frame.options ?? {} };
}

// Credentials, arbitrary headers/environment, the client identity (User-Agent
// and attribution headers), callbacks, client objects, and native
// transport/retry/timeout controls belong to the gateway process. They cannot
// be selected through the data plane. Every other JSON option is forwarded
// without a Cyclo allowlist.
function gatewayOptions(options, signal, api, onResponse, transformHeaders) {
  const {
    apiKey: _apiKey,
    signal: _signal,
    headers: _headers,
    identity: _identity,
    env: _env,
    fetch: _fetch,
    telemetry: _telemetry,
    client: _client,
    onPayload: _onPayload,
    onResponse: _onResponse,
    transformHeaders: _transformHeaders,
    transport: _transport,
    timeoutMs: _timeoutMs,
    websocketConnectTimeoutMs: _websocketConnectTimeoutMs,
    maxRetries: _maxRetries,
    maxRetryDelayMs: _maxRetryDelayMs,
    ...inference
  } = options;
  return {
    ...inference,
    signal,
    maxRetries: 0,
    onResponse,
    transformHeaders,
    ...(api === "openai-codex-responses"
      ? { transport: "sse" }
      : {}),
  };
}

// Exhaustion follows the existing Provider contract, including after partial
// output. A pool can select another route before output; the caller can retry
// the complete request in either case.
function providerExhaustionRetryAt(api, response, event, now) {
  if (event?.type !== "error" || nativeErrorStatus(api, response, event) !== 429) {
    return undefined;
  }

  const nowMs = now();
  const waitMs = retryAfterMs(response?.headers, nowMs)
    ?? (api === "openai-codex-responses" ? codexResetWaitMs(event) : undefined)
    ?? DEFAULT_EXHAUSTION_RETRY_MS;
  const retryAt = new Date(nowMs + Math.max(1_000, waitMs));
  return Number.isFinite(retryAt.getTime())
    ? retryAt
    : new Date(nowMs + DEFAULT_EXHAUSTION_RETRY_MS);
}

function nativeErrorStatus(api, response, event) {
  if (Number.isInteger(response?.status) && response.status >= 400) return response.status;
  const message = event?.error?.errorMessage;
  if (typeof message !== "string") return undefined;

  // The pinned Anthropic and OpenAI Pi adapters catch SDK errors before their
  // onResponse hook runs. These exact prefixes are produced from the SDK's
  // numeric status by those pinned adapters; arbitrary body text follows them.
  const match = api === "anthropic-messages"
    ? /^(\d{3})(?:\s|$)/u.exec(message)
    : api === "openai-responses"
      ? /^OpenAI API error \((\d{3})\):/u.exec(message)
      : undefined;
  return match ? Number(match[1]) : undefined;
}

function codexResetWaitMs(event) {
  const message = event?.error?.errorMessage;
  if (typeof message !== "string") return undefined;
  const match = /\bTry again in ~(\d+) min\./u.exec(message);
  if (!match) return undefined;
  const minutes = Number(match[1]);
  return Number.isSafeInteger(minutes) ? Math.max(1, minutes) * 60_000 : undefined;
}

function retryAfterMs(headers = {}, nowMs = Date.now()) {
  const millisecondsValue = headerValue(headers, "retry-after-ms");
  const milliseconds = Number(millisecondsValue);
  if (millisecondsValue?.trim() && Number.isFinite(milliseconds)) {
    return Math.max(0, milliseconds);
  }

  const value = headerValue(headers, "retry-after")?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : undefined;
}

function headerValue(headers, name) {
  const value = typeof headers?.get === "function"
    ? headers.get(name)
    : headers?.[name];
  return typeof value === "string" ? value : undefined;
}

function eventUsage(event) {
  const usage = event?.type === "done"
    ? event.message?.usage
    : event?.type === "error"
      ? event.error?.usage
      : undefined;
  if (!plainObject(usage)) return undefined;
  return {
    inputTokens: safeTokens(usage.input) + safeTokens(usage.cacheRead) + safeTokens(usage.cacheWrite),
    outputTokens: safeTokens(usage.output),
    cachedInputTokens: safeTokens(usage.cacheRead),
    reasoningTokens: safeTokens(usage.reasoning),
  };
}

function safeTokens(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function credentialReflectionGuard(values) {
  const secrets = [];
  const partials = [];

  function add(candidates) {
    for (const candidate of candidates) {
      if (
        typeof candidate !== "string"
        || !candidate
        || secrets.includes(candidate)
      ) continue;
      secrets.push(candidate);
      partials.push(new Set());
    }
  }

  add(values);

  return Object.freeze({
    add,
    check(payload) {
      const fragments = stringFragments(JSON.parse(payload));
      for (const fragment of fragments) {
        for (let index = 0; index < secrets.length; index += 1) {
          if (advancesToCredential(secrets[index], partials[index], fragment)) {
            throw new GatewayResponseError(
              "upstream response contained gateway authentication material",
            );
          }
        }
      }
    },
  });
}

function stringFragments(document) {
  const fragments = [];
  const pending = [document];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      fragments.push(value);
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    const entries = Object.entries(value);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index];
      pending.push(child);
      pending.push(key);
    }
  }
  return fragments;
}

function advancesToCredential(secret, partials, fragment) {
  if (fragment.includes(secret)) return true;

  const existing = [...partials];
  for (const matched of existing) {
    const remainder = secret.slice(matched);
    if (fragment.startsWith(remainder)) return true;
    if (remainder.startsWith(fragment)) {
      partials.add(matched + fragment.length);
    }
  }

  const limit = Math.min(secret.length - 1, fragment.length);
  for (let length = 1; length <= limit; length += 1) {
    if (fragment.endsWith(secret.slice(0, length))) partials.add(length);
  }
  return false;
}

function upstreamFailure(_error, signal) {
  if (signal?.aborted) {
    if (signal.reason instanceof ConnectError) return signal.reason;
    return new ConnectError("request canceled", Code.Canceled);
  }
  return new ConnectError("upstream inference failed", Code.Internal);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
