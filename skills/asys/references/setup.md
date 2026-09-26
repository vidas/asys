# Setup and inference

## Install

The host needs Linux, Python 3.10+, a local Docker Engine and CLI, and separately
installed dcomp 0.3.2+ with Machine API 2. Building inference needs Go 1.25+.
The Human terminal installs pinned dependencies in a private environment;
worker dependencies are built into images.

From the source checkout, run `make install`. The prefix defaults to `~/.local`;
put its `bin` on PATH. `PREFIX=/path` selects another installation; `DESTDIR`
supports staging. `make install-host` installs core commands, Python modules,
the default design, world resources and skills without building images.

```sh
asys skill
asys skill ./agent-skills
asys skill --name asys-authoring
```

Export into the discovery directory supported by the consuming agent. Asys
does not edit another agent product's settings or search paths.

## Initialize a setup

```sh
asys init ./state
source ./state/asys-env
```

This creates state and a selection script; it does not start services. Dcomp
state defaults to `./state/dcomp`, independent of the current environment and
the invoking user's home directory. Use `--dcomp DIRECTORY` to explicitly
initialize or reuse another dcomp state directory. Use the same script in the
Human terminal. `--group GROUP` initializes both asys and dcomp state with shared
permissions for an existing Unix group; users also need workspace and Docker
access. Existing permissions are not recursively repaired.

The root contains `config.json`, `runs/`, `inference/`, `human/` and `asys-env`,
plus `dcomp/` by default. Each project's workspace is a separate directory.

## Start inference and select models

```sh
asys-inference init
asys-inference start
asys-inference gateway providers
asys-inference gateway login PROVIDER --as ACCOUNT
asys-inference models
asys system-model set simple EXPORTED_MODEL_ID
```

Replace placeholders with actual catalogue IDs. API-key login accepts
`--api-key-env VARIABLE` or `--api-key-stdin`; use the variable name rather than
the key as an argument. Credentials remain in inference state.

`init` saves settings and an initial gateway. `start` exports
`@inference_endpoint`. `models` queries that selected endpoint; `gateway models`
queries the gateway itself. They may differ when a pooler is selected.

Named agent/goal definitions can select models. `asys-run --model` overrides
the named worker's selection for one run. Senate participants and swarm member
commands can have explicit models; configure them deliberately rather than
assuming an override replaces all selections. Defaults are snapshotted when
workers start.

## Compose providers

```sh
asys-inference components
asys-inference add pool pooler work personal -L upstream=gateway.provider
asys-inference select pool.provider
asys-inference show --json
asys-inference status
```

SOURCE is a component name or directory. Extra arguments configure that component;
`-L` connects inputs. Use `--` before literal component arguments conflicting
with host options such as `--root` or `--help`. `remove NAME` removes the provider
and its connections; `select -` unbinds the endpoint. Mutations save and apply
configuration; show/status only observe. Command help works without initialized
or running state.

## Update

Install with the same prefix, load the selected `asys-env`, then run `asys update`.
This refreshes shared services without restarting active workflow workers.
New runs and resume rebuild environments against installed base images.
The 0.2.0 installer removes specialized host launchers; use `asys-run` throughout.
Existing 0.1.x `workers.json` command bindings and `agents/` instructions stay in
place. Named worker definitions are the authoring format for new workers; there
is no required relocation of existing environment files.
