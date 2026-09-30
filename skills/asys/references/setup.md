# Setup and inference

## Install

The host needs Linux, Python 3.10+, a local Docker Engine 23+ with BuildKit, and separately
installed dcomp 0.3.2+ with Machine API 2. Building inference needs Go 1.25+.
The Human terminal installs pinned dependencies in a private environment;
worker dependencies are built into images.

From the source checkout, run `make` as your own user, then `make install`
(`sudo make install PREFIX=/usr/local` for a system prefix). Installation only
copies what `make` built. The prefix defaults to `~/.local`; put its `bin` on
PATH. `DESTDIR` supports staging. `make install-host` installs core commands,
Python modules, the default design, world resources, skills and the release
record, without inference or the Human terminal. `asys version` shows the
installed release and whether running services use it.

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

`make` builds commands and images under a new build ID and records them in
`release.json`. `make install` installs everything that was built;
`make install-host` installs core host files, skills and the release record
without the inference/Human host tools. Keep the original installation prefix.
These actions leave existing containers on their original images; `asys version`
lists what still runs an older build.

For workflow/runtime changes with unchanged shared services:

```sh
make -C asys-bpmn build
make install-host PREFIX=/path/to/original/prefix
source /path/to/state/asys-env
asys-run --upgrade RUN
```

The BPMN build also builds its worker, runtime and world image dependencies.
Upgrade drains existing jobs, rebuilds the saved environment against installed
base images, then recovers the same workflow and job outcomes. See
[workflow upgrades](operations.md#upgrade-a-running-workflow) before operating
an existing run. New runs and cold checkpoint resume also rebuild environments.

To refresh shared inference/Human services, source the selected `asys-env` and
run `asys update`. A compatible update replaces the services while runs keep
going. When the inference format changes, it first drains the affected runs and
then upgrades them onto the new release; see
[workflow upgrades](operations.md#upgrade-a-running-workflow) for that sequence
and `--force`. `asys version` then shows whether every service is current.

The 0.2.0 installer removes specialized host launchers; use `asys-run` throughout.
Existing 0.1.x `workers.json` command bindings and `agents/` instructions stay in
place. Named worker definitions are the authoring format for new workers; there
is no required relocation of existing environment files.
