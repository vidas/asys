# Workflow files: design

Status: proposal. Replaces nothing yet; BPMN workflows keep working.

## Why

A BPMN workflow describes asys work through one extension, `<asys:job>`, whose
attributes carry FEEL expressions. The BPMN element types carry no asys meaning,
prompts and human forms live inside XML attributes, and the diagram is hard to
read or edit without a BPMN tool. asys already has its own vocabulary: an
environment declares worker types, jobs run on a filesystem queue, results are
JSON. A workflow file should use that vocabulary directly.

## Goals

- A workflow is a short YAML file a person can read, review in a diff, and edit
  by hand.
- Steps name the environment's worker types; the environment decides what each
  type is (named agent, goal, Senate or swarm; program; human).
- Everything the BPMN workflows do keeps working: sequence, parallel work and
  joins, decisions, revision loops, repeated work over collections, groups,
  calls to other workflows, agent-selected work, message waits, deadlines and
  delays, error routing and compensation.
- Calling another workflow file is a first-class step, so workflows compose.
- The engine speaks the existing host-channel protocol and Workflow service, so
  `asys-run`, `--resume`, `--upgrade`, `asys status`, coordinated `asys update`
  and the dashboard work unchanged.
- The file is validated against the environment before anything runs.

Non-goals: drawing coordinates in the file (layout is computed), a general
programming language, and scripts in the workflow (programs are declared by
the environment, never written in a workflow).

## A complete example

```yaml
asys: workflow/1
name: Delivery route review
inputs:
  request: {type: string}          # --input FILE becomes `request`
start: brief

steps:
  brief:
    run: single
    input:
      request: |
        Read proposal.md, problem.json and test_route.py. Write requirements.md
        with concrete acceptance criteria. Do not modify implementation or tests.
    next: work

  work:
    parallel: [search, implement]
    join: evidence

  search:                          # a branch with several steps is a group
    group:
      start: global_search
      steps:
        global_search:
          run: route-global
          input: {request: Find a closed route with length at most 16.}
          next: local_search
        local_search:
          run: route-local
          input: {request: Find a closed route with length at most 16.}

  implement:
    run: goal
    input:
      request: |
        Implement route_length in route.py according to proposal.md. Run the
        tests and obtain independent verification. Limit edits to route.py.

  evidence:
    run: compare                   # a program type declared by the environment
    input: {request: Compare both saved swarm artifacts and run all tests.}
    next: review

  review:
    call: review-loop.yaml         # another workflow file, as one step
    input:
      request: Review requirements.md, route.py and evidence.md.
    next: question

  question:
    run: human
    input:
      title: Delivery-route decision
      prompt: The review is complete. Which next step do you want?
      summary: ${review.final}
      files:
        - {path: evidence.md, label: Measured evidence}
      form: forms/decision.json
    timeout: P2D
    on_timeout: stopped
    next: decide

  decide:
    switch:
      - when: question.action = "accept"
        next: handover
      - when: question.action = "revise"
        next: revise
    default: stopped

  revise:
    run: goal
    input:
      request: |
        Address the human feedback and re-verify.
        Human comments: ${question.comments or "Recheck the evidence."}
    next: evidence

  handover:
    run: single
    input:
      request: "Write handover.md. Human comments: ${question.comments or 'None.'}"
    on_error: stopped
    next: accepted

  accepted: {end: Accepted}
  stopped: {end: Stopped by human}
```

## File

| Key | Meaning |
| --- | --- |
| `asys` | Format version, `workflow/1`. Required. |
| `name`, `description` | Display text. |
| `inputs` | Named inputs with a JSON Schema each. `asys-run --input FILE` supplies `request`; a call supplies them all. Optional; the default is `request: {type: string}`. |
| `start` | The first step. |
| `steps` | A map from step ID to step. IDs are stable names: `[a-z][a-z0-9_]*`. |
| `output` | The value a called workflow returns, an expression. Optional; the default is the result of the end step's last predecessor. |

## Steps

Every step has exactly one kind key. These keys may appear on any step:

| Key | Meaning |
| --- | --- |
| `next` | The following step. Omitted in a parallel branch or group, where reaching the end finishes the branch. |
| `on_error` | Step to continue at if this step fails. Without it, a failure fails the enclosing group, call or run. |
| `timeout`, `on_timeout` | ISO 8601 duration and the step to continue at when it elapses; the running work is cancelled. |
| `undo` | Compensation: a step that reverses this one's effect, run by a `compensate` step. |
| `description` | Text for people and viewers. |

### `run`: a job

```yaml
review:
  run: reviewer                    # a key of the environment's workers.json types
  input: {request: Review the report.}
  args: [--strict]                 # appended to a program command; programs only
  for_each: ${parts}               # optional: one job per item
  as: part                         # the item's name inside input, default `item`
  sequential: false                # parallel by default
  until: ${count(review[approved = false]) > 0}   # optional completion condition
```

`input` is the job's JSON. Plain values are literal. `${expression}` inside a
string inserts a value; a string that is exactly `${expression}` keeps the
value's type. The result is stored under the step ID; with `for_each` it is a
list of the finished items' results in item order. `index` counts from 1, as
FEEL lists do. `until` sees the step's own ID bound to that list; once it
holds, unfinished items are cancelled.

### `parallel` and `join`

```yaml
work:
  parallel: [search, implement]
  join: evidence
```

All listed steps start together. Each branch is one step or a `group`. `join`
starts once every branch has finished. A failing branch cancels the others and
fails `work`, unless the branch has `on_error`.

### `group`: steps as one unit

```yaml
attempt:
  group:
    start: draft
    steps: {draft: ..., check: ...}
  on_error: report
  for_each: ${modules}
```

A group has its own `start` and `steps`, finishes when its steps reach their end,
and fails as one unit. It is how a parallel branch, a repeated chain or a shared
error handler is written. Step IDs inside a group are local; outer results are
visible, and the group's result is a map from its step IDs to their results.

### `call`: another workflow

```yaml
review:
  call: review-loop.yaml           # relative to this file
  input: {request: Review the evidence.}
  for_each: ${modules}
```

The called file's `inputs` must accept `input`. It runs with its own step IDs and
variables, in the same environment and workspace, and its `output` becomes this
step's result. Calls are resolved and validated when the workflow is loaded, and
the resolved files are saved with the run, so resume and upgrade never read a
changed file. Recursion is limited to a depth of 16.

### `switch`: a decision

```yaml
decide:
  switch:
    - when: question.action = "accept"
      next: handover
  default: stopped
```

Conditions are evaluated in order and the first true one wins. `default` is
required.

### `repeat`: a standard loop

```yaml
polish:
  repeat:
    step:                          # a run, group or call step, defined inline
      run: editor
      input: {request: "Improve ${if polish = null then brief.final else polish.final}."}
    until: ${step.approved = true}
    max: 5
```

Each iteration runs the inline step as new work. Inside `until` its latest
result is `step`; the repeat's own ID holds that result as well, so the next
iteration can read it. The loop ends when `until` holds or after `max`
iterations, with the latest result as the step's result.

### `choose`: work selected by a coordinator

```yaml
build:
  choose:
    coordinator: planner           # a worker type with the action tools
    input: {request: Build the modules in plan.md.}
    actions: [design_module, test_module, document]
    sequential: false
    until: ${count(test_module) >= 3}
```

The coordinator is a job of that type, given `input`. It receives
`list_actions`, `start_action` and `wait_action`, as with an ad-hoc subprocess
today. Actions are steps of this scope; each runs at most once at a time, and
reads the coordinator's request as `message`. A request whose input the action
cannot use is returned to the coordinator as failed, without starting work.

Inside `until`, each action's ID is the list of its completed results. Without
`until`, the step finishes when the coordinator does; with it, it finishes once
`until` holds, cancelling the coordinator and, unless `sequential`, any running
actions. The result maps each action to its list of results, plus `report`, the
coordinator's own result. A failing action fails the step.

### `wait`: a message

```yaml
approval:
  wait: approved                   # message name
  timeout: P1D
  on_timeout: escalate
```

The run waits until the Workflow service's `SendMessage` delivers that message;
its payload is the step's result.

### `delay`

```yaml
cool_down: {delay: PT10M, next: retry}
```

### `compensate`

```yaml
rollback: {compensate: all, next: failed}
```

Runs the `undo` step of every completed step in the enclosing group, call or
run, latest first. `compensate: deploy` undoes one step.

### `end`

```yaml
accepted: {end: Accepted}
```

The label shown for this ending. A workflow may have several.

## Expressions

Expressions are FEEL, the language the BPMN engine already evaluates. They
appear in `${...}` inside strings, and in `when`, `until` and `output`. Visible
names are `request` and the other inputs, every finished step's result under
its ID, the current `item` (or its `as` name) and `index` inside `for_each`, and
`message` inside a `choose` action. A step that runs again replaces its result,
so a revision loop always sees the latest one. A called file sees only its
inputs and its own steps.

A string that is exactly one `${...}` keeps the value's type, so
`${{topic: brief.topic}}` is a context. Names inside a filter, such as
`approved` in `review[approved = false]`, belong to each item, and keys of a
context literal are not names.

## Validation

Before a run starts, the loaded workflow and every called file are checked:

- the file matches the schema of `workflow/1`;
- every `run` and `choose.coordinator` names a type in the selected environment,
  and `args` appear only on program types;
- every referenced step exists, every step is reachable, and no `next` leaves
  its group or parallel branch;
- each `call` resolves, its `input` satisfies the callee's `inputs`, and calls
  do not exceed the depth limit;
- every expression refers only to names that exist at that point, and parses
  (checked by the engine's FEEL parser when the run's workflow is loaded);
- every form file is valid JSON Schema, and a `switch` that compares a human
  answer with a literal uses a value the form allows;
- durations are valid ISO 8601.

## Engine

The interpreter (`asys-bpmn/src/flow.mjs`) runs inside the existing workflow
component, beside the BPMN engine. Everything around an execution is shared
and engine-neutral: the host-channel requests (`start`, `status`, `recover`,
`resume`, `cancel`, `message`), the `asys.workflow.v1.Workflow` service, the
SQLite run store, job dispatch to the filesystem queue, failure checkpoints for
`asys-run --resume`, and the upgrade handover. Only the execution differs. A
second component would have duplicated all of that, and two images to keep in
step for every update. Each run records its engine (`asys-flow/1` or the BPMN
engine's version), and recovery, resume and upgrade refuse a run whose engine
does not match. Retiring BPMN later removes one execution class and its
libraries.

`asys-run` chooses by file type. For `.yaml` and `.yml` it loads the file and
every file it calls, validates them against the selected environment, refuses
to start on any problem, and sends the resolved document (the files keyed by
path relative to the root file, each call resolved to a key). The run keeps
that document in `workflow/workflow.json`, so resume and upgrade never read a
file that changed since.

A run is a tree of frames: the workflow, a group, a called file, a parallel
branch, a `for_each` item, a `repeat` iteration or a `choose` action. A frame
has a cursor at its current step and records which children that step
started. Each change is saved before its effects: a job is recorded before it
is submitted, and a result before the next step starts. A job is keyed by
frame, step and visit, so recovery waits for a recorded job instead of
submitting it again, and a step that runs again gets a new job. Stopping the
component never cancels work; it only stops waiting for it.

## Viewer and editor

`asys workflow` is the model behind every viewer:

- `asys workflow check FILE --environment ENV` validates and reports errors.
- `asys workflow serve` reads and writes JSON requests on stdin and stdout:
  load a file, lay it out as nodes and edges in the style guide's grammar,
  apply an edit (add, remove, connect, change a field), save, and stream a run's
  step states. Edits go through `ruamel.yaml`, so comments and order survive.

The desktop viewer and editor, `asys-flow-view`, is a C program on the standard
X11 toolkit: Xt and Athena widgets for windows, panes, lists, text fields and
menus, and one custom widget for the map. It depends only on libraries every
X11 system has (Xt, Xaw, Xmu, Xft, XRender, fontconfig), builds with `make`, and
runs on macOS through XQuartz. A browser viewer is a separate later client of
the same service.

Old widgets, current interaction practice:

- the map is drawn with XRender and text with Xft, so shapes and type are
  antialiased; type is Nimbus Sans (Helvetica metrics) set as the style guide
  specifies, and colours are its palette;
- keyboard first: every action has a key, and a command palette (`/`) finds
  any step or action by name, ranking whole-word matches first;
- direct manipulation: select a step on the map, edit it in the inspector beside
  it, connect steps by dragging from one to another (with Shift, the error
  path); the YAML updates as you go;
- unlimited undo and redo, and no modal dialogs: prompts use the line at the
  bottom, and errors from validation appear next to the step they concern and
  in the list below the map;
- open a run instead of a file to follow it live: each step shows its state by
  form, never by colour (open until it runs, filled once done, the verde cursor
  beneath it while it runs, and FAILED in words), and selecting it shows its
  jobs, results and the end of their logs;
- the window remembers its size and zoom; resources (`Xdefaults`) can set the
  fonts and each colour of the palette (`AsysFlowView*map.verde`, ...).

```text
asys-flow-view [--environment DIR] FILE.yaml    view and edit
asys-flow-view --run RUN [--root DIR]           follow a run

/ palette   arrows move along the flow   Return edit the selected step
a add after   r rename   c continue at   e on error   Delete remove
u, Ctrl+Z undo   Ctrl+Y redo   Ctrl+S save   + - 0 zoom and fit   y YAML   q quit
```

A double click on a `call` step opens the file it calls. `ASYS_FLOW_SERVICE`
names another command for the model, for example a checkout's
`python3 tools/asys workflow serve`.

## Migration

`asys workflow convert FILE.bpmn [-o FILE.yaml]` writes the equivalent YAML for
the subset the examples and templates use: tasks with `asys:job`, sequence
flows, exclusive gateways (decisions and merges), parallel gateways (forks and
joins; a branch of several steps becomes a group), ad-hoc subprocesses
(`choose`) and end events. FEEL contexts become YAML mappings, and string
concatenation becomes `${...}` text. Result variables, and element IDs that are
not step IDs, are renamed everywhere they are read.

It writes nothing when part of a process cannot be expressed, and says why:
inline scripts (declare the program in `workers.json` instead), sequence flows
inside an ad-hoc subprocess, boundary and intermediate events, call activities
and BPMN loops. Approximations are written and reported as notes: a job without
`input` received all variables and now receives `{request}`; a decision with no
default ends at an end step instead of failing; an error end event becomes an
end labelled as an error.

Of the repository's BPMN, agent-task, human-prompt, mixed-review, the
named-swarm fixture and the goal template convert and validate; hello,
shared-workspace and the team template run inline scripts, and agent-review
orders its actions with sequence flows. The team and goal templates and the
hello example ship YAML versions written by hand. Both engines ship until BPMN
is retired by a separate decision.

## Open questions

- Escalation: whether a goal's built-in request for human help should become a
  visible step outcome that a workflow routes, instead of staying inside the
  worker.
- Worker contracts: environments do not yet declare what a worker type accepts
  and returns. Declaring them would let validation check `input` and result
  fields as it checks forms.
