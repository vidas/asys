# Inspection and recovery

## Find evidence

```sh
asys ps
asys status RUN --json
asys logs RUN
asys logs RUN JOB --stream stderr
asys logs RUN --source events
asys logs RUN --source commands
asys top RUN
```

Run logs explain progress; job stdout/stderr contains worker output. Events
record execution transitions. Commands/components logs explain launch and
cleanup failures. Use the same `--root` as the run's setup.

## Dashboard

```sh
asys dashboard --root ./state --port 8765
asys dashboard --root ./state --design ./my-design
```

The server binds loopback and prints its address. The overview's system filter
persists in the URL across refresh. Workflow diagrams show sequence flows,
branches, return paths and recorded job state. Each worker kind has its own
color; text states whether a task ran.

Selecting a task opens its evidence. Programs use Output. Model conversation
appears in Transcript, with individual saved sources available. JSON uses shared
structured formatting and Plain text provides a terminal-style rendering.
Use the structured view or inspector for complete tool-result details. The sidebar serves
task, message, world and artifact selections across the page.

Senate participants occupy several seating tiers; the princeps senatus retains
the configured name. Select a participant for their contributions. Swarm frames
replay recorded world state; member selection changes evidence without scrolling
the page. Open transcript is the explicit navigation action.

Freeze display stops polling only. Pause/resume/cancel are separate execution
controls, available according to the selected job. Historical world views keep
their renderer version; custom renderers should consume the theme context to
support alternative designs.

## Human answers

```sh
asys-human-prompt
asys-human-prompt --root ./state --system asys --once
asys-run ENVIRONMENT workflow.bpmn --input request.md --human
```

The shared Human service queues requests even without a terminal. One terminal
owns its handler at a time. Workflow `--human` creates a private handler for that
run. Use `--plain` for line prompts, `--tui` for the full terminal, and
`--claimant NAME` to select the identity used for candidate checks.

Read the briefing and artifacts, fill the form and explicitly submit. In plain
mode, `/details` displays technical context, `/skip` leaves the request pending,
and `/quit` stops the handler. Closing a terminal never supplies an answer.

## Recovery

```sh
asys status RUN
asys logs RUN FAILED_JOB
asys-run --resume RUN
```

Correct the cause first: tools, configuration, inputs, component availability or
a domain check. Resume uses saved BPMN, workspace, environment location, system
and dcomp settings. It can rebuild an environment after a tool fix. Replacement
jobs get new IDs; failed job evidence remains.

Resume applies to recoverable workflow state and must not replace a running
launcher. A workflow loop creates a fresh job per visit. A goal keeps its own
implementation conversation internally. Completed runs remain history.

Interrupting a run requests cancellation and removal of its owned components.
If cleanup is incomplete, inspect saved diagnostics and the selected dcomp
system. Shared inference and unrelated components belong to their own owners.

If a failed launcher's complete set of saved components is still healthy,
`asys-run --resume RUN` reattaches to that execution without restarting jobs.
Partial component cleanup must be finished before a checkpoint restart.
A timeout reading shared dcomp status is logged and retried; it does not fail
unrelated active runs or trigger their cleanup. Actual component failures
still fail their owning run.
