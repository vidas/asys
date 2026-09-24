import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { Code, ConnectError } from "@connectrpc/connect";
import { HealthStatus } from "@cyclo/component/contract";
import { AuthenticationMethod } from "@cyclo/gateway-protocol/contract";

import { createAccountTransactions } from "./account-transaction.mjs";
import { logoutAccount, renameAccount } from "./accounts.mjs";
import {
  aggregateUsageFile,
  createUsageAudit,
  usageRecord,
} from "./audit.mjs";
import { buildCatalogue } from "./catalogue.mjs";
import { loginAccount } from "./login.mjs";
import { createPiAdapter, GatewayCredentialError } from "./pi-adapter.mjs";
import { getPiProvider, getPiProviders } from "./pi-registry.mjs";
import { discoverSupportedProviders } from "./providers.mjs";

const DEFAULTS = Object.freeze({
  authPath: "/var/lib/cyclo-gateway/auth.json",
  usagePath: "/var/lib/cyclo-gateway/usage.jsonl",
});

export async function createGatewayServices(options = {}) {
  const env = options.env ?? process.env;
  const providers = options.providers ?? getPiProviders();
  const getProvider = options.getProvider
    ?? (options.providers === undefined
      ? getPiProvider
      : (id) => providers.find((provider) => provider.id === id));
  const authPath = env.CYCLO_GATEWAY_AUTH_JSON ?? DEFAULTS.authPath;
  const paths = {
    authPath,
    modelsCachePath: env.CYCLO_GATEWAY_MODELS_CACHE_JSON
      ?? join(dirname(authPath), "models-cache.json"),
    usagePath: env.CYCLO_GATEWAY_USAGE_JSONL ?? DEFAULTS.usagePath,
  };
  const loadCatalogue = options.loadCatalogue ?? (() => buildCatalogue({
    authPath: paths.authPath,
    modelsCachePath: paths.modelsCachePath,
    getProvider,
    signal: options.signal,
  }));
  if (typeof loadCatalogue !== "function") {
    throw new TypeError("loadCatalogue must be a function");
  }

  const warn = options.warn ?? console.warn;
  if (typeof warn !== "function") throw new TypeError("warn must be a function");

  let catalogue = options.catalogue ?? await loadCatalogue();
  reportDiagnostics(catalogue, warn);

  const backend = options.backend ?? createPiAdapter();
  const audit = options.audit ?? createUsageAudit(paths.usagePath);
  const aggregateUsage = options.aggregateUsage ?? aggregateUsageFile;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const loginOperation = options.login ?? loginAccount;
  const logoutOperation = options.logout ?? logoutAccount;
  const renameOperation = options.rename ?? renameAccount;
  const mutate = serialExecutor();

  const reloadCatalogue = async () => {
    const replacement = await loadCatalogue();
    reportDiagnostics(replacement, warn);
    catalogue = replacement;
  };
  const transactions = createAccountTransactions({
    authPath: paths.authPath,
    modelsCachePath: paths.modelsCachePath,
    replace: reloadCatalogue,
  });

  const mutationCommit = (affected, signal) => {
    let called = false;
    const commit = async (operation) => {
      if (called) throw new Error("gateway account mutation committed more than once");
      if (typeof operation !== "function") {
        throw new TypeError("gateway account mutation must be a function");
      }
      called = true;
      await transactions.commit(affected, operation, signal);
    };
    commit.assertCalled = () => {
      if (!called) throw new Error("gateway account operation did not commit transactionally");
    };
    return commit;
  };

  async function* infer(request, context = {}) {
    const selected = await stableRoute(
      () => catalogue.routes[request.model],
      transactions,
      context.signal,
    );
    const { route, release } = selected;
    try {
      yield* inferRoute(request, route, context);
    } finally {
      release();
    }
  }

  const recentFailures = new Map();

  async function* inferRoute(request, route, context) {
    const started = Date.now();

    let usage;
    let failure;
    let diagnostic;
    const requestId = randomUUID();
    let pendingResponse;
    let auditAttempted = false;
    const writeOutcome = async (outcome) => {
      auditAttempted = true;
      const entry = usageRecord({
        model: request.model,
        started,
        outcome,
        usage,
        failure: diagnostic ? { request_id: requestId, ...diagnostic } : undefined,
      });
      await record(audit, entry);
      if (diagnostic) {
        recentFailures.delete(request.model);
        recentFailures.set(request.model, entry);
        if (recentFailures.size > 100) recentFailures.delete(recentFailures.keys().next().value);
        warn(JSON.stringify({ event: "inference_failed", ...entry }));
      }
    };

    try {
      try {
        for await (const response of backend.infer(
          route,
          request.payload,
          context.signal,
        )) {
          if (response.usage !== undefined) usage = response.usage;
          if (response.failure !== undefined) diagnostic = response.failure;
          if (pendingResponse !== undefined) {
            yield { payload: pendingResponse.payload };
          }
          pendingResponse = response;
        }
      } catch (error) {
        failure = error;
        diagnostic = {
          type: error instanceof GatewayCredentialError ? "credential_unavailable"
            : error instanceof ConnectError ? `rpc_${error.code}` : "internal",
          message: error instanceof ConnectError ? error.rawMessage.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 1024)
            : error instanceof GatewayCredentialError ? "Gateway credential unavailable" : "Gateway inference failed",
        };
      }

      await writeOutcome(
        failure instanceof GatewayCredentialError
          ? "credential_unavailable"
          : failure instanceof ConnectError
            ? `rpc_${failure.code}`
            : failure
              ? "internal"
              : diagnostic ? "provider_error" : "ok",
      );
      if (failure instanceof GatewayCredentialError) {
        throw new ConnectError("gateway credential unavailable", Code.FailedPrecondition);
      }
      if (failure instanceof ConnectError) throw failure;
      if (failure) throw new ConnectError("gateway inference failed", Code.Internal);
      if (pendingResponse !== undefined) yield { payload: pendingResponse.payload };
    } finally {
      if (!auditAttempted) {
        await writeOutcome(
          context.signal?.aborted ? `rpc_${Code.Canceled}` : "client_abandoned",
        );
      }
    }
  }

  return Object.freeze({
    status: Object.freeze({
      async getStatus() {
        return { recent_failures: [...recentFailures.values()] };
      },
    }),
    component: Object.freeze({
      health() {
        try {
          audit.check?.();
          return { status: HealthStatus.READY, message: "ready" };
        } catch {
          return {
            status: HealthStatus.NOT_READY,
            message: "gateway storage unavailable",
          };
        }
      },
    }),

    discovery: Object.freeze({
      listProviders() {
        return { providers: discoverSupportedProviders({ providers }) };
      },
    }),

    diagnostics: Object.freeze({ recentFailures: () => [...recentFailures.values()] }),

    usage: Object.freeze({
      async getUsage() {
        return usageResponse(await aggregateUsage(paths.usagePath));
      },
    }),

    admin: Object.freeze({
      login(request, context = {}) {
        return mutate(async () => {
          const authentication = loginAuthentication(request.authentication);
          const account = request.account || request.provider;
          const commit = mutationCommit([account], context.signal);
          const result = await loginOperation({
            provider: request.provider,
            account: request.account || undefined,
            authentication,
            interactive: request.interactive,
            apiKeyStdin: authentication === "api_key",
          }, {
            env,
            input,
            output,
            interaction: context.interaction,
            apiKeyInput: context.apiKeyInput,
            announce: false,
            signal: context.signal,
            getProvider,
            commit,
          });
          commit.assertCalled();
          return {
            account: result.account,
            authentication: authenticationMethod(result.credentialType),
          };
        }, context.signal);
      },

      logout(request, context = {}) {
        return mutate(async () => {
          const commit = mutationCommit([request.account], context.signal);
          const result = await logoutOperation(
            { account: request.account },
            { env, output: null, commit },
          );
          commit.assertCalled();
          return { account: result.account };
        }, context.signal);
      },

      rename(request, context = {}) {
        return mutate(async () => {
          const commit = mutationCommit(
            [request.account, request.newAccount],
            context.signal,
          );
          const result = await renameOperation(
            { account: request.account, newAccount: request.newAccount },
            { env, output: null, commit },
          );
          commit.assertCalled();
          return { account: result.account, newAccount: result.newAccount };
        }, context.signal);
      },
    }),

    provider: Object.freeze({
      listModels() {
        return { models: catalogue.models };
      },
      infer,
    }),
  });
}

function serialExecutor() {
  let tail = Promise.resolve();
  return (operation, signal) => {
    const result = tail.then(async () => {
      signal?.throwIfAborted();
      return operation();
    });
    tail = result.catch(() => {});
    return result;
  };
}

async function stableRoute(lookup, transactions, signal) {
  while (true) {
    const route = lookup();
    if (!route) throw new ConnectError("unknown model", Code.NotFound);
    const release = await transactions.read(route.account, signal);
    if (lookup() === route) return { route, release };
    release();
  }
}

function loginAuthentication(value) {
  if (value === undefined || value === AuthenticationMethod.UNSPECIFIED) return undefined;
  if (value === AuthenticationMethod.OAUTH) return "oauth";
  if (value === AuthenticationMethod.API_KEY) return "api_key";
  throw new ConnectError("invalid login authentication method", Code.InvalidArgument);
}

function authenticationMethod(value) {
  if (value === "oauth") return AuthenticationMethod.OAUTH;
  if (value === "api_key") return AuthenticationMethod.API_KEY;
  throw new ConnectError("login authentication method is required", Code.InvalidArgument);
}

function usageResponse(report) {
  const counters = (value) => ({
    requests: BigInt(value.requests),
    latencyMs: BigInt(value.latency_ms),
    inputTokens: BigInt(value.input_tokens),
    outputTokens: BigInt(value.output_tokens),
    totalTokens: BigInt(value.total_tokens),
    cachedInputTokens: BigInt(value.cached_input_tokens),
    reasoningTokens: BigInt(value.reasoning_tokens),
    outcomes: Object.fromEntries(
      Object.entries(value.outcomes).map(([name, count]) => [name, BigInt(count)]),
    ),
  });
  return {
    version: report.version,
    totals: counters(report.totals),
    byProvider: Object.fromEntries(
      Object.entries(report.by_provider).map(([name, value]) => [name, counters(value)]),
    ),
    byModel: Object.fromEntries(
      Object.entries(report.by_model).map(([name, value]) => [name, counters(value)]),
    ),
  };
}

function reportDiagnostics(catalogue, warn) {
  for (const entry of catalogue.diagnostics ?? []) {
    const route = safeDiagnostic(
      entry.model ? `${entry.account}/${entry.model}` : entry.account,
      1_024,
      "unknown",
    );
    warn(
      `Cyclo gateway excluded unusable catalogue entry ${route}: `
      + safeDiagnostic(entry.message, 512, "invalid catalogue entry"),
    );
  }
}

async function record(audit, value) {
  try {
    await audit.record(value);
  } catch {
    throw new ConnectError("gateway usage audit unavailable", Code.Internal);
  }
}

function safeDiagnostic(value, limit, fallback) {
  const clean = String(value)
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
  return clean || fallback;
}
