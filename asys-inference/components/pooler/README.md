# Pooler provider component

The bundled pooler adds quota-aware virtual models to an existing Cyclo
Provider. It selects account-qualified members round-robin and moves to another
member only when the selected member reports the Provider protocol's typed,
pre-stream `RESOURCE_EXHAUSTED(retry_at)` error.

The pooler is an intermediate Provider component. It requires one Provider
input named `upstream`, provides one Provider output, and holds no credentials.
Its Provider input/output use dcomp 0.3 interfaces. `asys-inference models`
reads its exported catalogue through its filesystem host channel.

## Create a pool

Pool every provider-local model advertised by at least two selected accounts:

```sh
asys-inference add pool pooler account-a account-b -L upstream=gateway.provider
asys-inference models
```

If both accounts advertise `model` and `family/reasoning`, the pooler adds
`pool/model` and `pool/family/reasoning`. All upstream models remain available
under their original IDs.

Pool exact model IDs under one chosen local name:

```sh
asys-inference add pool pooler account-a/model account-b/model model=balanced \
  -L upstream=gateway.provider
```

That form adds `pool/balanced`. The logical provider name (`pool` above) is
the output model prefix, independently of the dcomp component name.
Asys supplies it in `/run/asys-host/provider.json`. A standalone dcomp
deployment without that identity uses `DCOMP_COMPONENT_NAME`.
The accepted component argument forms are:

```text
PROVIDER PROVIDER [PROVIDER ...]
MEMBER_MODEL MEMBER_MODEL [MEMBER_MODEL ...] model=OUTPUT_MODEL
```

Provider-wide mode accepts any number of distinct provider prefixes; two is the
minimum. It creates a virtual model for every local model ID shared by at least
two selected providers. A selected provider that advertises no models is an
error. Exact mode likewise accepts any number of distinct `PROVIDER/MODEL` IDs
with a minimum of two. The forms cannot be mixed in one instance.

Pool members must advertise identical inference format, capabilities, and
extensions. A virtual model reports the smallest context window and output
limit among its members. Provider-wide models share one provider-level
round-robin cursor and cooldown state; an exact-model pool has its own state.

## Routing guarantees

The pooler retries another member only after typed resource exhaustion arrives
before the first response. It never replays a request after emitting output.
Malformed exhaustion details and all other errors are propagated unchanged. If
every member is cooling down, the pooler returns typed exhaustion with the
earliest retry time; it does not sleep. Each exhaustion cooldown is capped at
ten minutes, even when the upstream reset date is later. After that deadline,
the member is eligible for a new request; another exhaustion response starts
another bounded cooldown. Earlier upstream retry times are preserved.

Inference payloads remain opaque. The component changes only the model ID on a
pooled upstream request. Cooldowns are held in memory and are reconstructed
from upstream errors after a restart.

## Development

From this directory:

```sh
make -C ../.. prepare-runtime
npm ci --ignore-scripts
npm test
```

From the parent components directory:

```sh
docker build -t cyclo-pooler -f pooler/Dockerfile .
```

The image runs as UID/GID 1000. Asys mounts its private host channel and
publishes no TCP port. The image also retains its local port-8080 health and
catalogue HTTP server. Its OCI healthcheck reports catalogue validation failures without leaking
credentials, because the component never receives provider credentials. See
[SECURITY.md](SECURITY.md) for the complete trust boundary.
