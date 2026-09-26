# Human requests and terminal review

The Human component owns pending questions, claims, validation and completed
answers. Workers call `asys.human.v1.Human`; a host terminal presents the request
through a runtime channel. The service does not need worker job-directory mounts.

```sh
asys-human-prompt --root ./state
asys-run ./env/development workflow.bpmn --input request.md --human
asys-run --resume RUN --human
```

The first command attaches to the shared service. Workflow `--human` creates a
private service and terminal for that run. Questions can arrive before a terminal
attaches. A shared service survives handler exit. A private handler normally
removes its own service when it exits; workflow health recovery detaches the
terminal and preserves that service and its pending requests. Closing a terminal
never answers a question.

`--root` selects the same asys state as the runner. Human records live under
`ROOT/human`. `--system`, `--dcomp-state-root` and `--runtime-root` select the dcomp
namespace and storage. `--private --name review-desk` publishes
`review-desk.human` without changing the global; a runner may select it with
`-L human=review-desk.human`. `--claimant NAME` chooses the identity used for
candidate eligibility, not an authentication mechanism.

Reconnect to a private service retained during workflow recovery using
`asys-human-prompt --private --name COMPONENT` with the original `--system`,
`--root`, and dcomp settings. The terminal checks the saved session identity and
acquires its existing handler lock, recovers an abandoned claim, and rediscovers
pending questions. It retains that service on exit. A matching component that
has not been explicitly retained is not adopted.

## Answer a request

The terminal opens with the question, completed work and evidence links. Review,
Files, Response and Technical preserve the answer draft while navigating.
Workspace files can be previewed in place; Open externally is an explicit action.
At narrow widths the panes become separate tabs.

| Key | Action |
| --- | --- |
| F2 / F3 / F4 / F5 | Review / Files / Response / Technical |
| Tab / Shift-Tab | Next / previous control |
| Arrows / Space | Navigate and choose |
| Ctrl-S | Submit the displayed response |
| Ctrl-K | Skip the request, leaving it pending |
| Ctrl-Q / Ctrl-C | Release the claim and detach |

Choices begin unselected, including when the schema declares a default.
Validation errors retain the draft. `--once` leaves after one completed answer.
Only one host handler owns a shared channel at a time; reconnecting restores
pending questions and recovers abandoned claims.

`--plain` selects line prompts; redirected input/output also uses plain mode.
`--tui` forces the full terminal. In plain mode, `/details` opens technical
context, `/skip` leaves the question pending and `/quit` stops the handler.
Multiline input ends with `/done`; `/keep` retains previous text. `/omit`,
`/empty` and `/null` distinguish absent, empty and null values where permitted.
Prefix a literal slash command with another slash. A final confirmation submits
the constructed answer; a default or elapsed time does not.

## Author useful requests

The portable [Human authoring reference](../skills/asys-authoring/references/human.md)
contains the canonical briefing and revision pattern. Supply existing artifacts,
observed checks, a concrete question and the consequence of each option.

| Field | Meaning |
| --- | --- |
| `prompt` | Required question |
| `title`, `summary` | Decision title and completed work |
| `files` | Workspace-relative `{path,label,description?}` evidence |
| `context` | Supporting explanation |
| `details` | Technical information |
| `form` | JSON Schema draft-07 for the answer |
| `uischema` | Optional JSON Forms control layout |
| `candidates` | Eligible claimant names |

File links must stay inside the actual workspace. The handler translates worker
paths using dcomp binds, previews text and Markdown, and resolves links relative
to the open document. Missing or unmounted files show an explanation. Named
volumes remain worker paths when the host cannot resolve them. Original references
remain in the technical record even when no preview is available.

The service validates the complete answer. Negative decisions are successful
Human jobs whose values belong in workflow conditions. Revision must pass the
person's comments back to implementation, then repeat checks before asking again.

## Form capabilities

Strings, booleans, numeric fields, objects, homogeneous arrays, enum/constant
choices and nullable fields have native controls. Local schema references are
supported. Omission, empty text, false, zero and null remain distinct. `required`
requires presence; `minLength` requires nonempty text.

JSON Forms supports Control, Label, VerticalLayout, HorizontalLayout, Group,
Categorization and Category. Controls use schema pointers, including nested and
escaped property names. Radio choices and multiline text are supported. Layouts
are visited in declared order in plain mode.

Full-schema validation may constrain existing fields through conditionals and
combinations. Branches that introduce new controls are unsupported. Conditional
UI rules, overlapping controls, uncovered required fields, remote or recursive
references, tuple arrays and read-only/secret fields are also unsupported. The
handler reports unsupported forms and releases their claims for another handler.

## Durable service contract

The [Human protobuf](../asys-workers/proto/asys/human/v1/human.proto) is authoritative.
`Ask` carries an ID, input and metadata; it waits for validated answer JSON.
Cancellation withdraws unanswered work. Completed requests can be retrieved
idempotently using the same ID and input. Completed answers survive restarts;
in-flight RPCs may fail and need caller recovery.

The component exports `output asys.human.v1.Human human`; environments declare
a matching input, normally linked to `@human_endpoint`. State is mounted at
`/var/lib/asys-human`; its internal component `--root` selects that service
storage, unlike the public host's asys root. Tasks persist in `tasks.sqlite`.

Use runtime Reader/Writer clients for the `human` host channel. Directions are
relative to the component: the host writes `in` and reads `out`.

| Direction | Event | Payload |
| --- | --- | --- |
| Out | `ready` | Empty object |
| Out | `attention` | Worker identity and Human Task in protobuf JSON |
| In | `request` | `worker`, `method`, `body` |
| Out | `result` | Inbound request sequence and `result` |
| Out | `error` | Request sequence, Connect code and message |

Methods are ListTasks, GetTask, ClaimTask, ReleaseTask and CompleteTask.
Use stable claim/completion IDs and retain tokens and answer content on retry.
Publish replies before advancing cursors; fetch current task state before acting
on attention. The service streams existing and newly available questions.

Handler state records the selected component, request, unresolved claim and
answer. `asys update` refreshes owned shared services with current images;
private services are excluded. Replacement interrupts unanswered RPCs, so finish
active Human decisions before applying a service update.

The handler's separate `control` channel accepts `detach` with an empty object.
After successful setup, it publishes `attached` with its `component`, process
`pid`, and the optional `ASYS_HUMAN_ATTACHMENT` nonce supplied by its host. The
host waits for that acknowledgement after claim recovery and request discovery.
On detach, the handler persists service retention before replying `detached` with `request` (the
request sequence) and `component`, then exits while releasing its active claim.
Shutdown also checks pending detach requests, so a termination signal following
a durable detach cannot remove the service. Claim release failures remain in
the saved session for the next terminal to recover.

## Development

`make install-host` installs the terminal and its pinned private Python
dependencies. `make install` also builds the image. `npm test` covers protocol
and presentation fixtures; `tools/integration-test` exercises real component
and terminal behavior. The [Human prompt example](../asys-bpmn/examples/human-prompt/README.md)
requires no inference provider.
