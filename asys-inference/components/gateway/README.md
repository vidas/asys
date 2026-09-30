# Credential gateway component

The gateway is a root Provider and credential boundary. It owns
accounts, API keys, OAuth refresh state, the concrete Pi model catalogue,
native provider calls, and usage accounting. Each account is backed by an account-scoped
native Pi `Models` runtime, `CredentialStore`, and `ModelsStore` projection.

```text
docker cyclo-gateway:dev
output cyclo.provider.v1.Provider provider
```

The Provider interface is served through dcomp 0.3's component SDK. Host
administration uses the [gateway filesystem channel](../../docs/gateway-channel.md)
under `/run/asys-host/channels/gateway/`. It supports provider and model
listings, usage, login, logout, and account rename. The gateway listens on
container loopback port 8080 for its internal health check; it publishes no
host port. Only the gateway container mounts
`/var/lib/cyclo-gateway`, containing `auth.json`, `models-cache.json`, and
`usage.jsonl`.

## Inference boundary

Cyclo routes an `Infer` request using only its outer `model` field and passes
the opaque payload to that account's Pi runtime.

That adapter parses only the Pi call frame (`context` plus `options`) and calls
the pinned `pi-ai` `Models.streamSimple` with the gateway-owned native model.
Pi owns provider dispatch, API-key and OAuth resolution, locked OAuth refresh,
credential-specific model filtering, provider environment, headers, and base
URL preparation. The gateway does not interpret or validate prompt content,
history, tools, JSON Schema, reasoning, or tool arguments.
Native Pi events are serialized into response payloads. Each `Infer` performs
one native attempt. The calling inference client owns timeouts and retries,
including replacement of incomplete assistant output.
The one gateway-specific egress check is schema-independent: if a serialized
event exactly reflects an API key or authentication-header value injected by
the gateway, the event is discarded and inference fails with a generic
`DATA_LOSS` error. Events without gateway authentication material remain
unchanged.

The caller cannot choose credentials or gateway process controls. `apiKey`,
arbitrary headers/environment, injected clients, callbacks, and the abort
signal are gateway-owned; all other JSON Pi options pass without a Cyclo
allowlist. ConnectRPC carries cancellation out of band.

Incoming RPC headers are never forwarded. Provider credentials never appear in
the model catalogue, request payload, Docker arguments, logs, or downstream
containers. Login runs the provider's native Pi login flow against a staged
credential store, verifies Pi's available models, and atomically replaces only
that account in `auth.json`; an unknown provider or unusable catalogue leaves
the previous credential store and running gateway untouched. Successful login,
logout, and rename requests reload the in-process catalogue before their
response, so the updated models become visible without a service restart.
Credential mutations use the same kernel lock and atomic replacement as OAuth
refresh, and never rewrite `usage.jsonl`. Each stored credential declares its
provider explicitly, and rename preserves it.
Pi's dynamic per-account model catalogue is persisted separately in
`models-cache.json` and follows account rename/logout.

All built-in Pi text providers and all text APIs in the pinned Pi release are
eligible for publication; there is no Cyclo API allowlist. Pi image generation
uses a different request/result contract and is not part of Cyclo's streaming
Provider ABI.

Login selects OAuth when the pi-ai provider offers it and otherwise enters the
provider's native API-key or ambient-credential flow. `--api-key-stdin` and
`--api-key-env` explicitly select API-key login for a provider that also offers
OAuth. In a terminal, the native flow can ask for structured fields such as a
Cloudflare account/gateway. Piped stdin and `--api-key-env` provide one secret
value and are suitable for ordinary single-key providers. Cyclo does not inject
host credential files or environment into the gateway, so Bedrock AWS-profile
and credential-chain choices and Google Vertex ADC and service-account-file
choices are omitted. Bedrock bearer tokens and Google Vertex API keys remain
available.
OAuth URLs, device codes, prompts and answers use the host channel. A
provider flow whose only completion path is a loopback browser callback inside
the container is not supported; choose its manual-code or device-code option
when available.

Login, logout, and rename are serialized with each other. They do not block
Provider inference or model, provider, and usage reads while a user
is answering login prompts. Read paths use the current immutable catalogue
snapshot; a successful credential mutation builds and swaps in its replacement
before replying. The gateway coordinates account persistence with snapshot
replacement: inference for affected accounts drains before commit, and a hard
catalogue reload failure restores the affected credential and model-cache
entries before the request fails. Pi's authentication interaction callbacks
publish questions and wait for correlated answers. The host client handles
terminal input and echo; the gateway never reads its container stdin for a
host login. A cancelled OAuth prompt releases the host's terminal immediately.

Models using the Pi inference format must publish positive context-window and
output-token limits. The gateway excludes an unusable model without hiding
valid models from the same account, and reports a bounded safe reason at
startup logs. The team-side Pi adapter repeats this check because an
intermediate provider may supply its own catalogue; it logs and ignores only
the bad entry. Intermediate relays preserve the typed catalogue fields
unchanged.

A definite native HTTP 429 becomes the Provider protocol's typed
`RESOURCE_EXHAUSTED` error with an absolute retry time, including after partial
output. It never includes native error text, account, or headers. An optional
pooler can select another account before output starts; otherwise the caller
waits and retries the complete request. The gateway does not sleep for capacity.
HTTP 408, 500, 502, 503, 504 and 529 responses, recognized connection failures,
interrupted response bodies, and native iterators ending without a terminal event
become `UNAVAILABLE`. Other native Pi error events pass through for the caller's
Pi error handling. Malformed output fails with `DATA_LOSS`; unavailable gateway
credentials fail with `FAILED_PRECONDITION`.

The gateway does not retry or impose an inference deadline. Caller cancellation
ends the native attempt, including while awaiting its first event. Native SDK
retries remain disabled. This works with a direct Provider client and with
optional poolers and relays; no pooler is required for recovery.

Usage is observed at the native Pi endpoint and appended to the private audit
file. Accounting observes terminal event usage but does not alter or reorder
the payload stream. A client-abandoned or failed stream is recorded with its
transport outcome. Records are newline-committed: startup truncates only an
incomplete crash tail, and a write failure keeps health not-ready until that
restart repair has run.

## Files

| Path | Purpose | Access |
| --- | --- | --- |
| `/var/lib/cyclo-gateway/auth.json` | API keys and OAuth credentials | private, writable |
| `/var/lib/cyclo-gateway/models-cache.json` | Pi dynamic model catalogues, scoped by account | private, writable |
| `/var/lib/cyclo-gateway/usage.jsonl` | request/token audit | private, writable |
| `/run/asys-host/channels/gateway/` | Host commands, login dialogue, and results | provider-specific shared mount |
| TCP port `8080` | Internal health check | container loopback only |

`/var/lib/cyclo-gateway` is the component's persistent `credentials` volume.
Its name depends on the dcomp state root, system and component, not the image,
so `asys update` mounts the same logins into the rebuilt gateway. Each
`auth.json` entry holds a native Pi credential; a newer Pi must still read the
records an earlier one wrote. `test/fixtures/stored-credentials/` holds one
`auth.json` per earlier Pi release, and the stored-credentials test sends a
request with every account in each. When changing the Pi pin, add a fixture for
the release being replaced.

## Build and test

From `asys-inference`:

```sh
make prepare-runtime
npm --prefix components/protocol/component ci
npm --prefix components/protocol/gateway ci
npm --prefix components/protocol/provider ci
npm --prefix components/gateway ci
npm --prefix components/gateway test
make integration
```

Asys-inference invokes its private Python channel client while holding the
machine lock and a shared dcomp deployment lock. The client uses the installed
asys-runtime package. Request IDs and prompt IDs keep replies attached to the
right exchange. A gateway restart invalidates unfinished exchanges; commands
are not replayed automatically. Logout removes the local account and does not
attempt provider-side token revocation.
