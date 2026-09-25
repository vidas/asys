# Worker execution

This component executes the environment's named agents, goals, Senates, swarms,
programs and Human requests. Every assignment uses the ordinary runtime queue
and supplied workspace. The workflow engine decides which assignments to submit;
each worker owns the execution of its assigned algorithm.

## Create and run

```sh
asys-workers add ./env/development agent editor
asys-workers add ./env/development goal repair
asys-workers add ./env/development senate review
asys-workers list ./env/development
asys system-model set simple account/model
asys-run ./env/development repair "Implement and verify the supplied specification" --workspace ./project
```

`asys-workers add --help` explains each kind, generated files and required
configuration. Swarms additionally need a configured world and evaluator.
`asys-environment add-skill ENVIRONMENT DIRECTORY` imports a complete skill.
`asys-environment dockerfile ENVIRONMENT FILE` installs a replacement Dockerfile.

The portable [authoring skill](../skills/asys-authoring/SKILL.md) contains the
canonical guides for [environments and programs](../skills/asys-authoring/references/environments.md),
[named definitions](../skills/asys-authoring/references/workers.md),
[workflow bindings](../skills/asys-authoring/references/workflows.md), and
[Human requests](../skills/asys-authoring/references/human.md). These references
are installed with asys and exported by `asys skill DEST`.

## Environment and storage contract

The image supplies `/opt/asys/environment`, including `workers.json`, named
`workers/*.json`, agent prompts, skills, extensions and programs. Optional
`tools.md` inventories installed tools for agent prompts. It does not install
software or register a tool. A running component retains its image; new runs
and workflow resumes rebuild the environment when it has a Dockerfile.

| Location | Responsibility |
| --- | --- |
| Environment image | Reusable commands, definitions and agent knowledge |
| Runtime queue | Assignment, ownership, cancellation and exit status |
| Job directory | Input, result, transcript, logs, reports and scratch files |
| Workspace | Project files and shared deliverables |

The host mounts the queue, jobs and workspace for the invoking UID/GID.
Processes execute in the workspace. The [runtime contract](../asys-runtime/README.md#execution-contract)
defines stdin, `ASYS_INPUT`, `ASYS_RESULT` and execution variables. The container's
internal `--root` selects its mounted runtime queue; public host `--root` selects
asys state containing runs, inference and Human records.

## Agent execution

The Pi session combines the global [system prompt](src/system.md), environment
`tools.md`, selected agent's optional prompt and memory, shared and agent-specific
skills, and installed extensions. Unrelated agent resources are not loaded.
Workspace files do not silently install extensions or replace the system prompt.
The effective prompt and definition hashes are recorded with the job.

Named assignments supply `request` and optional kind-specific `parameters`.
The dispatcher translates them to the internal algorithm input. Agent completion
is an object with nonempty `final` and `exception: null` or a nonempty blocker;
extra task-defined fields are preserved. A non-null exception fails execution.
Malformed completion gets one correction in the same session, then fails if
still invalid. Verification must assess the actual artifact, not merely this
completion envelope.

Inference uses the existing `cyclo.provider.v1.Provider` interface. The adapter
owns retries, preserving partial messages and completed tools while refusing to
execute unfinished tool calls. Its default inactivity timeout is 600000 ms,
configurable with `ASYS_INFERENCE_IDLE_TIMEOUT_MS`. Progress refreshes the timer;
it is not a total job deadline. Transient retry backoff is capped at 30 seconds.
Capacity waits follow the provider's retry time but are capped at ten minutes,
so recovered capacity is rechecked even when a later reset was reported.
Cancellation interrupts calls and waits.
Pi's separate transport retry loop is disabled. `maxSteps` counts logical
inference calls, including compaction, rather than transport retries.

`agent.json` retains the conversation; stdout records streaming activity,
retries, compaction and diagnostics. `asys top RUN` and the dashboard
read this saved evidence. Programs' stdout and structured results remain output,
separate from agent conversations.

## Algorithms and interfaces

The agent, goal and Senate controllers live in this image. A goal independently
verifies its workspace; a Senate deliberates through separate participant
sessions. Their public contract is the named definition, used identically by
standalone runs and BPMN jobs.

A swarm owns identities, private memory, member decisions, scheduling and
checkpoints. Its world runs in a separate component. Bounded model members
receive their mission, observation, private memory and action schema; they have
no shell or general coding extensions. Trusted program members can implement
another decision policy using the same execution contract. Member logs and
sessions stay under the parent job's `swarm/decisions/` directories.

Programs use ordinary command mappings. The internal `asys-program` wrapper
runs its appended command arguments. Human jobs call the typed
[Human interface](proto/asys/human/v1/human.proto), normally linked to
`@human_endpoint`. A shared `asys-human-prompt` terminal or workflow `--human`
handler collects answers. Questions and submission semantics are documented in
the [Human component guide](../asys-human-interface/README.md).

## Development

From this directory, `make build` builds runtime, world and worker base images.
`npm test` checks the JavaScript adapters; the root `make test` also covers
Python algorithms, authoring, installation and host execution. Internal
executables under `tools/` are container commands, not extra public launchers.
