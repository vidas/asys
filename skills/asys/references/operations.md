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

The workflow opens fitted inside its own panel. Use +/− or the mouse wheel to
zoom, drag to pan, and Fit to show the whole diagram again. With the diagram
focused, arrow keys pan, +/− zoom, and Home or 0 fits. Live updates preserve
your view. Long goals and run requests scroll within bounded text panels.

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

## Upgrade a running workflow

Use `--upgrade` after installing execution code that an existing workflow should
use. Build/install prepares host files and images; `asys update` refreshes shared
inference and Human services. A workflow upgrade changes only that run's owned
engine, workers and worlds. It leaves shared inference, shared Human and
unrelated runs untouched. See [setup](setup.md#update) for build commands.

```sh
source /path/to/state/asys-env
asys status RUN
asys-run --upgrade RUN
```

Select the run's state directory with its project's `asys-env`, or pass
`--root DIRECTORY`. The saved workspace, BPMN definition, environment location,
connections, system/dcomp settings and system-model defaults are retained.
The environment is rebuilt from that saved location using installed base
images; an environment without a Dockerfile uses its configured image.

The command takes over monitoring from a launcher supporting upgrade handover,
then removes the old engine to stop new workflow-task scheduling. Existing
workers and worlds stay running until every pending/running queue job reaches
a terminal outcome. Jobs may still need Human answers while draining. Only
then are the owned workers/worlds replaced and the new engine started to recover
the checkpoint. Existing job IDs and results are consumed once. A failed job
keeps its failure and follows the workflow's configured failure handling;
upgrade does not request the job-replacing resume operation.

The saved checkpoint must be compatible with the replacement engine. Starting
an upgrade requires the saved environment, model snapshot and complete saved
component set, plus an engine reporting an active, nonterminal execution.
An active launcher installed before upgrade handover support is refused before
any component changes. Installing new host files does not retrofit that running
process. Restore missing components or resolve checkpoint incompatibility
before attempting an upgrade; completed/cancelled workflows are history.

A private Human component and its pending requests are retained. Add `--human`
to attach its terminal during the upgrade and subsequent monitoring. Without
that flag the private component remains available, but the former launcher's
terminal detaches. Workflows using shared Human continue using the shared
terminal (`asys-human-prompt`); `--human` cannot convert them to private Human.

`upgrade.json` in the run directory records progress and selected replacement
image IDs. If an upgrade fails or is interrupted, inspect its diagnostics and
repeat `asys-run --upgrade RUN` to continue the recorded operation. Do not use
`--resume` for a pending upgrade. Ctrl-C during upgrade preserves remaining
components, running jobs and the checkpoint. A drain can therefore be left
waiting without cancelling its work. After upgrade completes, the command
continues ordinary foreground monitoring; Ctrl-C then cancels the workflow and
cleans up its owned components as usual.

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

Interrupting ordinary foreground execution requests cancellation and removal
of its owned components.
If cleanup is incomplete, inspect saved diagnostics and the selected dcomp
system. Shared inference and unrelated components belong to their own owners.

If a failed or `recovery-required` launcher's complete set of saved components is still healthy,
`asys-run --resume RUN` reattaches to that execution without restarting jobs.
Reattachment sends a read-only engine status query and requires an active workflow
or a terminal result, not just a healthy heartbeat. If an engine was manually
restarted in await-resume mode, explicit `--resume` requests checkpoint recovery
that retains existing job IDs; it does not replay the job-replacing resume
operation. Each status/recovery reply has a 10-second deadline. Rejected,
unsupported or missing replies leave the run `recovery-required` with its
components preserved. Restore the engine/channel, then retry `--resume`.
Partial component cleanup must be finished before a checkpoint restart.
A timeout reading shared dcomp status is logged and retried; it does not fail
unrelated active runs or trigger their cleanup. During active execution, a
running component whose healthcheck becomes unhealthy puts the run in `degraded`
status. Its jobs continue during a 60-second grace period. A healthy observation
clears the degradation. `asys status RUN` and its JSON output expose the current
health state. The launcher logs state transitions without repeating each poll.
`component-health.jsonl` retains timestamped observations, recovery decisions
and a bounded, best-effort Docker state capture with recent healthcheck results.
This history remains after normal component cleanup. Diagnostic capture failures
do not fail the run.

After the grace period, the launcher can restart only the workflow engine using
`dcomp ... restart SYSTEM ENGINE`. It requires a saved checkpoint and preserves
the existing worker/world components and job IDs. The run reports `recovering`
before invoking dcomp. That command has a 120-second timeout; after it returns,
the engine has 90 seconds to become healthy. The engine's ordinary startup
recovery restores its checkpoint. At most one automatic restart is allowed per
saved run, including across launcher reattachment. A healthy observation after
restart returns the run to `running`; a recurring fault cannot cause a restart loop.

Persistent worker/world health failures are not automatically restarted because
doing so interrupts their jobs. Engines started with `--await-resume` also require
operator recovery: replaying resume could cancel and replace running jobs. A
missing checkpoint, exhausted restart budget, failed restart or expired recovery
deadline ends the launcher with exit status 1 and run status `recovery-required`.
The workflow engine, workers, worlds, jobs and checkpoints remain in place for
inspection. A private `--human` terminal handler releases its active claim and
detaches while keeping its Human component and pending requests. Reattach it with
`asys-run --resume RUN --human`, or use `asys-human-prompt --private --name COMPONENT`
with the saved root/system after restoring the execution. Only a matching saved,
preserved private service can be adopted; an existing handler lease excludes a
second terminal. Inspect the saved health evidence, component logs and job progress before
intervening; healthy complete executions can be reattached as described above.
Standalone worker runs have no workflow resume operation and require direct
inspection and operator cleanup of their retained components.

An unavailable status read cannot extend a known unhealthy component's deadline.
Startup and reattachment still require their existing readiness checks. Confirmed
component exit, death, disappearance or a reported component problem still fails
its owning run immediately. During engine recovery these failures retain the
remaining components; otherwise normal cleanup applies. Explicit interruption
of ordinary execution still cancels work and requests cleanup.
