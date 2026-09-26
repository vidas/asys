# asys

Run agents, verified goals, Senates, swarms and programs in reusable environments.
Compose them into BPMN workflows with parallel work, human decisions and revision.
Every execution uses `asys-run`; the dashboard and terminal tools inspect the
same saved run and job records.

## Start

[Install asys](INSTALL.md), initialize state and configure an exported model:

```sh
asys init ./state --dcomp ./dcomp-state
source ./state/asys-env
asys-inference init
asys-inference start
asys-inference gateway providers
asys-inference gateway login PROVIDER --as ACCOUNT
asys-inference models
asys system-model set simple EXPORTED_MODEL_ID
```

Replace the uppercase identifiers with actual provider/model IDs. Then create
an environment and run a goal against an existing project:

```sh
asys-workers add ./env/development goal repair
asys-run ./env/development repair "Fix the reported bug and independently verify the result" \
  --workspace ./project
asys status latest
asys dashboard
```

## Compose work

| Kind | Behavior |
| --- | --- |
| Agent | One assignment with tools and a saved conversation |
| Goal | Implementation with independent verification and human help for blockers |
| Senate | A princeps senatus and senators with professional roles deliberate |
| Swarm | Members explore a separate world using independent evaluation |
| Program | A deterministic command with JSON input/output and ordinary logs |
| Human | A person answers a typed question through the Human service |

Agents, goals, Senates and swarms use named definitions in `workers/NAME.json`.
Programs and Human handlers use ordinary command bindings in `workers.json`.
A workflow sequences those bindings:

```sh
asys-run ./env/development ./workflow.bpmn --input request.md --workspace ./project
asys-run --resume RUN
```

[The mixed-review example](asys-bpmn/examples/mixed-review/) combines a single
agent, two model swarms, a verified goal, a program checking their shared files,
a Senate, and a human accept/revise/stop decision.

## Know the directories

An **environment** packages tools, prompts, skills and worker definitions.
A **workspace** is the actual project that jobs modify directly. A **state
directory** stores runs, inference, Human state and model defaults. A **system**
is a dcomp namespace for components and shared endpoints. One state directory
can hold runs from several systems.

`--root` selects asys state; `--workspace` selects project files; `--system`
selects the dcomp namespace. Authoring commands take the environment explicitly.
See the [command reference](skills/asys/references/commands.md) for consistent
option meanings and defaults.

## Author and operate

```sh
asys-workers add ./env/development agent editor
asys-workers add ./env/development senate review
asys-workers add ./env/development swarm search
asys-workers describe ./env/development search
asys-workers edit ./env/development search
asys-workers add --help
asys-environment add-skill ./env/development ./skills/checking
```

The help explains each kind and its generated files. Configure prompts,
participants and evaluators before executing the new worker.

Two portable skills ship with the installation:

- [asys](skills/asys/SKILL.md): setup, execution, inspection and recovery.
- [asys-authoring](skills/asys-authoring/SKILL.md): environments, workers,
  programs, workflows, human help, worlds and dashboard designs.

`asys skill DEST` exports both complete skills. `asys skill --name asys-authoring`
prints the authoring bundle's path. Existing exported copies are preserved.

## Dashboard and designs

```sh
asys dashboard --root ./state
asys dashboard --root ./state --design ./my-design
```

Inspect workflow paths, program output, readable transcripts, Senate participants
and saved swarm frames. Each worker kind has a distinct color. Selection opens
shared details without displacing the map. Display freeze and execution controls
are separate actions.

Workflow diagrams open fitted inside a bounded panel, with zoom controls and
drag-to-pan navigation. Long goals scroll within their own text panel.

The [default design](designs/default/) is a separate package with shared CSS,
logo assets, fonts and diagram symbols. [Create an alternative design](skills/asys-authoring/references/design.md)
from a visual specification without changing execution or dashboard code.

## Documentation

- [Installation and upgrade](INSTALL.md)
- [Commands and state semantics](skills/asys/references/commands.md)
- [Environment and program authoring](skills/asys-authoring/references/environments.md)
- [Worker definitions](skills/asys-authoring/references/workers.md)
- [Workflow authoring](skills/asys-authoring/references/workflows.md)
- [Human review](skills/asys-authoring/references/human.md)
- [World packages](skills/asys-authoring/references/worlds.md)
- [Monitoring and recovery](skills/asys/references/operations.md)
- [Release notes](CHANGELOG.md)

Component internals remain in [runtime](asys-runtime/), [workers](asys-workers/),
[workflow engine](asys-bpmn/), [inference](asys-inference/) and
[Human service](asys-human-interface/). Source directories are not additional
public execution commands. The project is [MIT licensed](LICENSE).
