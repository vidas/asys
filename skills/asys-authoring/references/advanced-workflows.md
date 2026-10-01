# Advanced workflow patterns

Every step that executes names a worker type of the environment. These
patterns change when and how often work runs; they never add code to the
workflow file or another launcher. Read [workflow files](workflow-files.md)
first. The BPMN versions of these patterns are in [BPMN, advanced](bpmn-advanced.md).

## Revision loops and shared state

A switch that routes back to an earlier step is a revision loop. The step runs
again as new work, and its result replaces the previous one, so the next round
reads the latest review:

```yaml
implement:
  run: implementer
  input:
    request: >-
      Write report.md. Previous review: ${if review = null then "none" else review.reason}
  next: review
review:
  run: reviewer
  input: {request: Review report.md. Return approved and reason.}
  next: decide
decide:
  switch:
    - when: review.approved = true
      next: done
  default: implement
```

When several steps update one value, such as a repair budget or a ledger
carried around nested loops, give each the same `result:` name. Every result
is also stored under that name, and readers see whichever step wrote last:

```yaml
prepare_sheet:
  run: prepare-stage
  result: stage
  input: {budget: "${stage.budget}", feedback: "${check_sheet}"}
prepare_layout:
  run: prepare-stage
  result: stage
  input: {budget: "${stage.budget}"}
```

Bound every loop: a budget the steps track, a `repeat` with `max`, or a human
decision. A loop with none can run forever on a persistent failure.

## Collections

```yaml
inspect_parts:
  run: reviewer
  for_each: ${parts}
  as: part
  input: {request: "Inspect part ${part.name}."}
  sequential: false
  until: ${count(inspect_parts[approved = false]) > 0}
```

Produce `parts` in an earlier step's result; a request in Markdown does not
become a collection. Every item is a fresh job, and the result is the list of
finished items in order; `index` counts from 1. Use `sequential: true` when
items edit the same files. `until` sees the finished results under the step's
own name and stops the rest once it holds. `group` and `call` take `for_each`
too, for several steps per item.

`repeat` runs one inline step until a condition holds:

```yaml
polish:
  repeat:
    step: {run: editor, input: {request: "Improve ${if polish = null then draft.final else polish.final}"}}
    until: ${step.approved}
    max: 5
```

## Parallel work

```yaml
work:
  parallel: [search, implement]
  join: evidence
search:
  group:
    start: global
    steps:
      global: {run: route-global, next: local}
      local: {run: route-local, input: {request: "Improve ${global.final}"}}
implement: {run: goal}
```

Branches are steps without `next`; a branch of several steps is a `group`,
whose result maps its steps to their results (`search.local`). The join waits
for every branch. A failing branch cancels the others unless it has
`on_error`. Branches share the workspace: give each its own files.

## Agent-selected work

`choose` lets a coordinator agent select actions:

```yaml
build:
  choose:
    coordinator: planner
    input: {request: Build the modules listed in plan.md.}
    actions: [design_module, test_module]
    sequential: false
    until: ${count(test_module) >= 3}
  next: review
design_module:
  run: designer
  input: {request: "Design ${message.module.name}."}
test_module:
  run: tester
  input: {request: "Test ${message.module.name}."}
```

The coordinator is a named agent whose definition includes the action tools:
put `export {default} from '/opt/asys/asys-workers/extensions/bpmn.mjs';` in
its `agents/NAME/extensions/` directory (the same extension serves BPMN
ad-hoc subprocesses). It receives `list_actions`, `start_action` and
`wait_action`; a call such as `{"action": "design_module", "input": {"module":
{"name": "power"}}}` makes that input the action's `message`. An action runs
once at a time; `sequential` allows one action at a time overall. Inside
`until`, each action's name is the list of its results. The step's result maps
each action to its results, plus `report`, the coordinator's own result. An
action's input that does not evaluate is returned to the coordinator as a
failed request, so it can correct its call. Actions are independent: there is
no ordering between them, unlike sequence flows inside a BPMN ad-hoc
subprocess.

## Other workflow files

```yaml
review:
  call: review-loop.yaml            # relative to this file
  input: {request: "Review ${evidence.final}"}
```

The called file declares `inputs` and an `output` expression. It runs in the
same environment and workspace, sees only its inputs and its own steps, and
its `output` is the step's result. Calls are resolved when the run starts and
saved with it; they nest up to 16 deep.

## Failure, time and compensation

```yaml
simulate:
  run: simulation
  timeout: PT2H
  on_timeout: report_slow
  on_error: record_failure          # the result holds the job's result plus exception
reserve:
  run: booking
  undo: release                      # run by a compensate step
rollback: {compensate: all, next: failed}
cool_down: {delay: PT10M, next: retry}
```

`on_error` continues with the failure recorded as the step's result, with an
`exception` field. Without it a failure fails the enclosing group, call or run,
which `asys-run --resume` retries from the failed job, keeping finished work.

## Messages and embedding

```yaml
approval:
  wait: approved
  timeout: P1D
  on_timeout: escalate
```

The run waits for a message named `approved`, sent through the Workflow
service's `SendMessage`; its payload is the step's result. There is no message
CLI: an embedding application owns that integration.

The workflow component exposes `asys.workflow.v1.Workflow`: `LoadWorkflow`
takes `bpmn_xml` or `workflow_json`, the resolved document that
`asys workflow resolve FILE` prints; then `StartRun`, `GetRun`, `ListRuns`,
`ResumeRun`, `CancelRun`, `SendMessage` and `GetEvents`.

## What workflow files do not do

Workflow files hold no code: no inline scripts, and no expression steps that
set variables; compute values in the step that needs them, or in a program the
environment declares. There are no data objects, signals, conditional events,
inclusive or event-based gateways, error codes, non-interrupting events or
loop counters. `asys-bpmn-convert` names these when a BPMN process uses them.
