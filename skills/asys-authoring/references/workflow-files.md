# Workflow files

A workflow file is YAML (`asys: workflow/1`) whose steps name the worker types
of the selected environment. It holds no code: programs are commands the
environment declares in `workers.json`, and a step names them. Write new
workflows this way; BPMN files still run on the BPMN engine while both formats
are supported.

## Complete minimal file

```yaml
asys: workflow/1
name: Deliver a verified change
start: deliver
steps:
  deliver:
    run: goal                      # a key of the environment's workers.json types
    input: {request: "${request}"}
    next: done
  done: {end: Delivered}
```

```sh
asys workflow check workflow.yaml --environment ./env/development
asys-run ./env/development ./workflow.yaml --input request.md --workspace ./project
```

`--input FILE` supplies `request`. `asys-run` validates the file and every
file it calls against the environment before anything starts, and saves the
resolved files with the run.

## Steps

Every step has exactly one kind key. Any step may add `next`, `on_error`,
`timeout` with `on_timeout`, `undo` and `description`. A top-level step needs
`next` or is an `end`; inside a group or branch, reaching the last step
finishes it.

| Kind | Example | Result |
| --- | --- | --- |
| `run` | `run: reviewer`, `input: {...}`, `args: [...]` (programs only) | the job's result |
| `parallel` | `parallel: [search, implement]`, `join: evidence` | the branches' own results |
| `group` | `group: {start: draft, steps: {...}}` | a map of its steps' results |
| `call` | `call: review-loop.yaml`, `input: {request: ...}` | the called file's `output` |
| `switch` | `switch: [{when: review.approved = true, next: done}]`, `default: revise` | none |
| `repeat` | `repeat: {step: {run: editor, ...}, until: "${step.approved}", max: 5}` | the latest iteration |
| `choose` | `choose: {coordinator: planner, input: {...}, actions: [a, b], until: ...}` | each action's results, and `report` |
| `wait` | `wait: approved` (a message name) | the message payload |
| `delay` | `delay: PT10M` | none |
| `compensate` | `compensate: all` or a step ID | none |
| `end` | `end: Accepted` | ends this scope |

`run`, `group` and `call` take `for_each: ${list}`, `as: name` (default
`item`; `index` counts from 1), `sequential: true` and `until`; the result is
the list of finished items' results.

## Expressions

Expressions are FEEL in `${...}`, and bare in `when`, `until` and `output`.
They read the inputs (`request`), every finished step's result by its ID, the
current item, and `message` inside a `choose` action. A string that is exactly
one `${...}` keeps the value's type; otherwise values are written into text:

```yaml
input:
  request: >-
    Write deliverables/report.md for: ${request}
    Previous review: ${if review = null then "First pass." else review.reason}
  limits: ${{attempts: 3, files: brief.files}}
```

A step that runs again, as in a revision loop, replaces its result, so later
steps read the latest one. A called file sees only its inputs and its steps.

## Human steps

A `run` of the environment's human type takes `title`, `prompt`, `summary`,
`files`, `context` and a `form`: a JSON Schema inline or a file beside the
workflow. A `switch` comparing an answer with a literal must use a value the
form allows; `asys workflow check` reports it otherwise.

## Seeing and editing

`asys-flow-view [-environment dir] workflow.yaml` shows and edits the file on
X11; `asys-flow-view -run run` follows a run. Edits keep comments and order.

## From BPMN

`asys workflow convert workflow.bpmn -o workflow.yaml` writes the equivalent
file for tasks, sequence flows, exclusive and parallel gateways, ad-hoc
subprocesses and end events. It refuses what a workflow file cannot express,
saying why: an inline script must become a program the environment declares
(see the team template's `check-report`), and sequence flows inside an ad-hoc
subprocess, timers, messages, call activities and BPMN loops are not
converted. Notes report approximations, such as a job without `input`, which
BPMN gave all variables and the file gives `{request}`. Check the result with
`asys workflow check --environment`.
