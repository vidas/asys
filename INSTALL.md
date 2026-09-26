# Installation and upgrade

## Requirements

Use Linux, GNU Make, Python 3.10+, Go 1.25+ for the inference build, and a local
Docker Engine accessible to the invoking user. Install dcomp 0.3.2+ separately;
`dcomp` and `dcomp-proxy` must be on PATH (or use their documented binary overrides).
Host Node is unnecessary for ordinary execution; container builds install worker
dependencies. Development tests need Node 22.19+, npm and Python jsonschema.

The inference build pins the dcomp Go module to v0.3.2; Go downloads and verifies
it using `go.mod` and `go.sum`. The host executables are installed separately.
When upgrading dcomp, follow its [proxy upgrade procedure](https://github.com/glguida/dcomp/blob/v0.3.2/README.md#upgrade-from-031-to-032):
the fix requires replacing the running proxy; `asys update` alone leaves it running.

```sh
dcomp version
command -v dcomp-proxy
make install
```

Run make from this repository. The default prefix is `~/.local`; add its bin to
PATH. Select another writable installation with `make install PREFIX=/opt/asys`.
`DESTDIR` stages host files. Installation builds images and installs core,
inference and Human host commands. It does not initialize state or authenticate
an inference account.

## Installed interface

| Command | Purpose |
| --- | --- |
| `asys` | Initialize state, set models, inspect runs, dashboard, update and skill export |
| `asys-run` | Execute a named worker or BPMN workflow; resume failed workflows |
| `asys-workers` | List/add/describe/edit worker definitions in an environment |
| `asys-environment` | Import skills/Dockerfiles and edit environment files |
| `asys-inference` | Configure and operate the provider network |
| `asys-human-prompt` | Attach a terminal to human questions |

`make build` builds commands/images without installing. `make install-host`
installs the core commands, Python modules, system prompts, world resources,
default dashboard design and both skills without Docker. It does not build
execution images or install inference and the Human terminal. Component targets
remain available: `make -C asys-inference install` and
`make -C asys-human-interface install`.

Bundled guides are installed under `PREFIX/share/asys/skills/{asys,asys-authoring}`.
The default visual package is `PREFIX/share/asys/designs/default`.

```sh
asys skill
asys skill ./agent-skills
asys skill --name asys-authoring ./agent-skills
```

Choose the export command appropriate to the destination: an existing copy is
an error and is left unchanged. Exported copies are independent snapshots.
The bundle includes all reference pages and runnable templates; a checkout is
not required to use them. Point the consuming agent at its supported discovery
directory. Asys does not change other products' configuration.

## Select state

```sh
asys init ./state
source ./state/asys-env
```

The script sets `ASYS_STATE_ROOT` and `DCOMP_STATE_ROOT` for this shell. Source
it in each management or Human terminal. The asys root contains `runs/`,
`inference/`, `human/` and `config.json`. Initialization also prepares dcomp state
under `./state/dcomp`, independent of `DCOMP_STATE_ROOT`, `XDG_STATE_HOME`, or the
invoking user's home directory. Use `--dcomp DIRECTORY` to explicitly select
another dcomp state directory. Project workspaces remain separate.
Initialization preserves state and starts no services.

Without an explicit root, host tools use `ASYS_STATE_ROOT`, then
`XDG_STATE_HOME/asys`, then `~/.local/state/asys`. Their `--root DIRECTORY` has
that same meaning. `asys init` takes the directory positionally. Authoring
commands take an environment directory and do not use state-root options.

For an existing shared Unix group:

```sh
asys init /srv/asys/host --group asys
source /srv/asys/host/asys-env
```

The same group is passed to dcomp initialization, including for the default
`/srv/asys/host/dcomp` directory. Group members need Docker and workspace access.
Initialization sets permissions
for new state; it does not recursively change existing directories. Shared state
also shares control of configured services and their stored credentials.

## Verify execution without inference

From the checkout, run the bundled deterministic workflow:

```sh
asys-run asys-bpmn/examples/hello/env/dummy asys-bpmn/examples/hello/workflow.bpmn
asys status latest
asys logs latest
```

Its result contains `Hello from asys.` The launch creates runtime components,
executes the program, saves records and removes owned components. The authoring
skill also includes a portable review/revision starter.

## Configure inference

```sh
asys-inference init
asys-inference start
asys-inference gateway providers
asys-inference gateway login PROVIDER --as ACCOUNT
asys-inference models
asys system-model set simple EXPORTED_MODEL_ID
```

Use actual IDs from the catalogues. API-key login supports `--api-key-env VARIABLE`
or `--api-key-stdin`. The provider network exports `@inference_endpoint` in its
saved dcomp system, normally `asys`. For another namespace, select it during
`asys-inference init --system NAME` and use matching runner/Human options.

```sh
asys-workers add ./env/development goal repair
asys-run ./env/development repair "Implement and independently verify the change" \
  --workspace ./project
asys-human-prompt
```

Create/choose the existing project directory before running. The Human service
can queue requests before a terminal attaches. Workflow `--human` instead owns
a private handler for that run. See [setup](skills/asys/references/setup.md) and
[Human authoring](skills/asys-authoring/references/human.md).

## Upgrade to 0.2.0

Finish active work before replacing services or changing definition formats.
Install with the original prefix, source its state selection, then run:

```sh
make install
source /path/to/state/asys-env
asys update
```

The installer removes `asys-oneshot`, `asys-goal`, `asys-senate`, `asys-swarm`
and `asys-bpmn`, plus their obsolete host packages, from the selected prefix.
Manual removal is unnecessary. Use the same `PREFIX` as the previous installation;
copies installed under other prefixes are not changed. All new execution uses:

```text
asys-run ENVIRONMENT WORKER REQUEST
asys-run ENVIRONMENT WORKFLOW.bpmn --input FILE
asys-run --resume RUN
asys-workers COMMAND ENVIRONMENT ...
asys-environment COMMAND ENVIRONMENT ...
```

Existing 0.1.x environments keep their `workers.json` command bindings and
`agents/` instructions in place; no manual relocation is required. Update host
scripts to use the commands above. Use `workers/NAME.json` and `asys-workers`
when authoring named workers; named workers share `{request, parameters?}` input.
Senate and swarm workers require these named definitions. If upgrading from an
unreleased swarm development version, convert its world to a package with a
separate component and view, removing old world command/module launch fields.
Observe everything with `asys dashboard`, `status`, `logs` or `top`.
Keep old saved evidence. Recovery still requires compatible engine checkpoints;
[engine compatibility](asys-bpmn/ENGINE.md) describes that boundary.

`asys update` refreshes running shared services, not current workflow workers.
New runs and resume rebuild environments. Skill exports are not overwritten by
installation; deliberately refresh copied skills after reviewing local edits.

The default state layout and setups using `ASYS_STATE_ROOT` retain their existing
inference configuration and state. Upgrading directly from 0.1.0 also requires
closing the old Human terminal and starting the newly installed
`asys-human-prompt`; `asys update` cannot upgrade that old running terminal.

Custom inference paths need attention: 0.2.0 no longer reads
`ASYS_INFERENCE_STATE_ROOT`, and `asys-inference --root` now selects the parent
asys state directory. If the old inference state is already `STATE/inference`,
pass `--root STATE`. An arbitrary old inference directory must be moved, as a
whole, to `STATE/inference` while its services are stopped. Update scripts that
pass the old root meaning. `asys update` does not discover or move these custom
directories, or rewrite environment definitions into the new authoring format.

## Development validation

```sh
make test-deps
make test
ASYS_DASHBOARD_BROWSER=1 node --test test/dashboard_frontend.test.mjs test/torus_view.test.mjs
```

The browser tests require Chrome (or `CHROME_BIN`). Docker acceptance tests are
separate: `asys-bpmn/tools/integration-test`,
`asys-human-interface/tools/integration-test`, and
`make -C asys-inference integration`. They use disposable systems and deterministic protocol fixtures,
without authenticating accounts or making paid model calls.
