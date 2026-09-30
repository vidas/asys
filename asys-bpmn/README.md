# Workflow component

The BPMN component coordinates ordinary jobs in a selected environment. It
supports branching, parallel work, revision loops, Human decisions and explicit
recovery. Launch every workflow through the shared `asys-run` command:

```sh
asys-run ./env/development ./workflow.bpmn --input request.md --workspace ./project
asys-run --resume RUN
asys status RUN
asys top RUN
asys dashboard
```

An input file becomes the literal `request` string. `--process ID` selects an
executable process. `--name NAME` labels the run. `--human` attaches a private
Human terminal for that workflow. The environment and workspace must exist;
workspace defaults to the current directory. Run state is separate from both.

## Author and validate

Use the [authoring guide](AUTHORING.md) and the portable
[asys-authoring skill](../skills/asys-authoring/SKILL.md). A bound task selects an
exact `workers.json.types` key. Named agentic workers receive
`{request: request}`; programs and Human tasks receive their native JSON input.
The worker kind comes from its definition, not the BPMN task's visual type.

The [hello](examples/hello/README.md) and
[shared workspace](examples/shared-workspace/README.md) examples need no model.
The [mixed review](examples/mixed-review/README.md) example combines an agent,
two swarms, a goal, a program, a Senate and Human acceptance or revision.

## Execution and recovery

Each run owns a workflow component and workers component. Referenced worlds are
prepared separately before jobs start. Jobs share the actual workspace and get
separate evidence directories. Runtime executes them; BPMN controls ordering.
Parallel writers should own distinct files and join before consuming results.

A negative review is an ordinary successful result. Route it through a gateway.
A failing program or agent exception is an activity error; catch it with an
appropriate boundary event or let the run fail. The graph and conditions must
express acceptance, revision and stopping explicitly.

`asys-run --resume RUN` loads the saved run, rebuilds its selected environment,
and retries interrupted or failed work in fresh jobs. It retains the workspace,
completed results and execution evidence. Do not supply a new workflow,
environment, workspace or model during resume. Checkpoint engine compatibility
is checked before recovery. Resume is not a general migration between versions.

Workflow checkpoints and their events commit together in SQLite WAL mode with
`synchronous=FULL`. A dedicated writer thread keeps durable disk writes off the
workflow event loop. Job identities commit before dispatch, and outcomes commit
before the engine advances or publishes action results. Requests for the same
run are serialized so duplicate requests cannot acknowledge uncommitted state.
A persistence error stops the component; a write pending for 60 seconds stops
its readiness heartbeat. Recovery uses the last committed checkpoint and its
existing job identities.

The root contains `run.json`, `run.log`, the saved workflow, runtime records and
job evidence. `asys logs` reads process output; `asys top` and the dashboard read agent
sessions. The dashboard computes layout from actual saved edges and exposes
all jobs, including programs and Human tasks.

## Embedding

The component exports `asys.workflow.v1.Workflow`. The
[protobuf contract](proto/asys/workflow/v1/workflow.proto) defines loading,
checking, execution, status, cancellation, messages, events and recovery.
The [engine contract](ENGINE.md) documents adapter compatibility.
The filesystem host channel uses the runtime's atomic Reader/Writer transport.
Its start/resume/cancel/message requests belong to an embedding API. `status`
reports committed run state and whether an execution is attached; `recover`
reattaches an inactive, unfinished run using its existing job identities.
Recovery is idempotent and does not retry failed jobs; `resume` performs that
explicit retry. There is no
separate public workflow host executable.

## Development

`make build` builds the workflow and worker images. `make install` then installs
the shared host commands. `npm test` covers engine behavior and host integration
fixtures; `tools/integration-test` checks real dcomp containers, programs, Pi
adapter fixtures, Human protocol and launcher recovery without paid model calls.
`make test-upstream-drift` checks newer upstream engine assumptions separately.
