# Verified goals

A goal iterates implementation and independent verification inside one ordinary
worker job. Start with a named definition or the bundled `goal`:

```sh
asys-workers add ./env/development goal repair
asys-run ./env/development repair "Implement the specification and demonstrate that its acceptance criteria hold" --workspace ./project
```

The objective and governing constraints come from the request. The controller
preserves an implementation conversation and asks independent verification to
inspect the workspace against those requirements. A fresh verifier receives the
objective, all previous reviews, Human guidance and the implementer's latest
response, including evidence locations and rebuttals. It checks those claims
against artifacts and proportionate tests. Only successful verification completes
the goal.

Each review assesses the current requirements and evidence, including the
disposition of earlier concerns. Reviews are retained as history, not converted
into a separate registry of mandatory fixes. A mistaken criticism can be withdrawn
with a source-grounded explanation. There are no finding IDs to allocate or close;
labels used in discussion do not control execution. Completion requires complete
assessment coverage and satisfied criteria in the current review. The controller
checks the response structure; it cannot establish that a claimed requirement or
observation is correct.

Implementation reports `goal_status: "continue"` to keep working or `"review"`
to request verification. Any phase can surface a blocker for Human guidance.
Retry/correction retain applicable context.
A genuine unanswered Human question remains pending until answered or cancelled.

`config.maxAttempts` or `--parameters limits.json` with `{"maxAttempts":4}` in
that file supplies a positive limit on successful implementation turns, including continued work. The default
is unlimited. A process timeout is separate. Model selection follows the named
definition, run override and configured system default.

Checkpoints use version 4. Older checkpoints remain inspectable but cannot be
resumed by this controller; start a new goal against the preserved workspace.
The caller supplies any external review, such as a Senate rejection, in the new
request and remains responsible for scheduling that external review again.

BPMN binds the same name with `{request: request}`. The
[portable template](../skills/asys-authoring/assets/goal.bpmn) shows the binding.
Inspect criteria, implementation, verification and Human exchanges in saved job
sessions through `asys top` or the dashboard. See
[worker definitions](../skills/asys-authoring/references/workers.md) and
[Human help](../skills/asys-authoring/references/human.md).
