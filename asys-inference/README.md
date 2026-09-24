# Inference services

`asys-inference` manages a persistent provider network and exposes its selected
`cyclo.provider.v1.Provider` output as `@inference_endpoint`. Commands exit while
dcomp and provider components continue running. Gateway, passthrough and pooler
retain the existing streaming, model-catalogue, cancellation and capacity-error
contracts.

## Install and initialize

Follow the root [installation guide](../INSTALL.md) for required versions and
the separate dcomp installation. `make build` builds the host binary and images;
`make install` installs under `PREFIX`, with `DESTDIR` for staging.

```sh
asys-inference init --root ./state
asys-inference start --root ./state
asys-inference gateway providers --root ./state
asys-inference gateway login openai-codex --as work --root ./state
asys-inference models --root ./state
```

The asys root is shared with runners and observers. Precedence is explicit
`--root`, `ASYS_STATE_ROOT`, `XDG_STATE_HOME/asys`, then `~/.local/state/asys`.
Inference configuration and recovery records live in `ROOT/inference`.
`--root` may appear before or after the command. `COMMAND --help` explains its
arguments without creating state or contacting providers.

Initialization saves `--system` (default `asys`), `--dcomp-state-root`,
`--runtime-root`, `--prefix` and `--components-root`. Later operations reuse
those settings. `init --empty` omits the default gateway. Set matching system
and dcomp paths on runners so their symbolic links resolve in the same namespace.

## Accounts and model names

```sh
asys-inference gateway login openai --as work --api-key-env OPENAI_API_KEY
asys-inference gateway models
asys-inference gateway usage
asys-inference gateway rename work personal
asys-inference gateway logout personal
```

`--api-key-env` takes an environment variable's name. `--api-key-stdin` reads
secret input. `--authentication auto|oauth|api_key` selects an authentication
method; OAuth follows the provider's interactive instructions. Credentials remain
in the gateway's private persistent volume, not machine configuration. `gateway
--name NAME` selects another gateway instance.

`models` queries the currently exported endpoint; `gateway models` queries that
gateway's accounts. Use the actual exported IDs in named worker definitions or
`asys system-model set simple MODEL`. A pool named `pool` exports `pool/MODEL`;
its dcomp component prefix does not alter model IDs.

## Compose providers

```sh
asys-inference add trace passthrough -L upstream=gateway.provider
asys-inference add pool pooler work personal -L upstream=trace.provider
asys-inference show --json
asys-inference status
asys-inference select gateway.provider
```

`add NAME SOURCE` selects the new provider's output. Named sources resolve in
the configured components directory; explicit paths select an external package.
Links use logical `NAME.OUTPUT` references or symbolic `@GLOBAL` targets.
Custom providers declare their typed interfaces in `component.dcomp` and may
supply `runtime.json` defaults for arguments, volumes, ports and egress.

Host `-L`/`--link` and `--root` options are recognized before a `--` delimiter.
Place literal component arguments after it when they would conflict with host
options. The delimiter itself is consumed; later tokens are passed unchanged.

```sh
asys-inference add filter ./filter -L upstream=pool.provider -- --root /data
```

A package with a Dockerfile is built using Docker's cache; otherwise its image
must exist. Components need exactly one Provider output and a useful health
check. Startup waits for the selected provider and its local dependencies before
switching the global endpoint. A failed addition remains configured for diagnosis
while the previous working output continues serving.

## Operate and recover

| Command | Purpose |
| --- | --- |
| `components [--json]` | Available sources and interfaces |
| `show [--json]` | Saved desired configuration |
| `status [--json]` | Provider health, selected endpoint and recent failures |
| `models [--json]` | Live exported model catalogue |
| `start` | Build/apply the saved network and current images |
| `select NAME[.OUTPUT]` | Switch the exported provider |
| `select -` | Leave the global unbound |
| `remove NAME` | Remove a configured provider |
| `stop` | Remove owned components, retaining configuration and credentials |

Installing software leaves current containers running. `start` applies new
provider images; root `asys update` also handles shared Human services. Unchanged
providers retain containers. Switching an endpoint closes streams whose concrete
route changes; new connections resolve the new symbolic target.

`stop` leaves other programs' dcomp components alone. Correct configuration or
source failures, then run `start` to retry. Status exits nonzero when its requested
endpoint is nonoperational while still printing diagnostics. Do not infer model
authentication success merely from a healthy container.

`gateway usage` reports request and token accounting.

Inference failures emit structured `inference_failed` records in gateway container
logs and persist a bounded diagnostic in the private `usage.jsonl` audit. Records
include the model, request ID, error category, sanitized message and upstream HTTP
status when known; prompts and successful model output are not logged. Native
provider error events are counted as `provider_error`, rather than successful
requests. Status includes the latest failure per model since gateway startup
(up to 100 models), with its timestamp; this is historical evidence, not a claim
that the latest request is still failing.

Independent consumers declare a Provider input and link to `@inference_endpoint`
in the same system. Use `dcomp dashboard SYSTEM` to inspect component wiring;
`asys dashboard` instead inspects saved asys runs and job evidence.

## Protocols and development

The [gateway channel](docs/gateway-channel.md) defines interactive authentication
and cancellation. The [provider channel](docs/provider-channel.md) describes
catalogue access. Host channel directories are private per provider; inference
traffic stays on the typed dcomp interface.

`make test` and `go test -race ./...` check configuration and lifecycle behavior.
`make integration` uses isolated state and real containers with protocol fixtures,
without authenticating an account or making paid model calls. It checks streaming,
failover, updates, recovery, independent consumers and credential-volume identity.
