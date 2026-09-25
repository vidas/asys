# Worker definitions

Every named definition is a version-1 JSON object with `kind`, `config`, and an
optional `description`. Its filename supplies the worker name. `asys-workers
add ENVIRONMENT KIND NAME --file FILE` validates and imports a complete definition.
Imported assets must be supplied separately; swarm import does not scaffold a world.

Standalone runs and workflow bindings use the same input:

```json
{"request":"Check the implementation against its specification","parameters":{}}
```

The built-in `simple` and `goal` are available for standalone runs without source
mutations. An environment definition or ordinary command with the same name takes
precedence. Workflow types must be explicitly declared in `workers.json`.

## Agent

```json
{
  "version": 1,
  "kind": "agent",
  "description": "Edit the assigned project files and check the result.",
  "config": {"agent": "editor", "maxSteps": 30}
}
```

`agent` selects `agents/editor/`; write its prompt there. Optional `model` selects
an exported model ID. Otherwise the `simple` system-model default applies.
`system: true` is supported only with `agent: "simple"` for the bundled prompt.
`parameters.maxSteps` overrides the definition's positive step limit for one job.

An agent reports a JSON object with nonempty `final` and `exception: null` or a
nonempty blocker. Request any additional fields needed downstream, including
their types. A review can return `approved: false` with `exception: null`.

## Goal

```json
{"version":1,"kind":"goal","config":{"maxAttempts":4}}
```

The request is the objective and governing criteria. The implementation agent
keeps a conversation across work turns; `goal_status: "continue"` continues work,
and `goal_status: "review"` asks an independent verifier to check it. Verification
receives the objective, workspace, all previous reviews, human guidance and the
implementer's latest response, including repair evidence and rebuttals. It checks
those claims independently in a fresh session. Reviews remain history; there is
no finding registry or ID-based closure protocol. Earlier criticisms must be
reassessed against the governing requirements and current evidence. Completion
requires complete assessment coverage and satisfied criteria in the current
review. Only verification completes the goal.

External review feedback, such as a Senate rejection, can be included in the
request. The caller schedules any required external review after repair. Goal
checkpoints use version 4; older checkpoints can be inspected but need a new goal
invocation against the preserved workspace to use this controller.

Optional `model` selects a model. Omitting `maxAttempts` leaves attempts unlimited;
the limit counts successful implementation turns, including `continue`.
`parameters.maxAttempts` overrides it for one job. Blockers can ask Human for
retry, correction or abort. A retry retains implementation context and starts
fresh verification. Ordinary worker timeout remains a separate process limit.

## Senate

```json
{
  "version": 1,
  "kind": "senate",
  "config": {
    "version": 1,
    "princeps": {"name": "Marcus", "prompt": "Coordinate the discussion and state the supported decision."},
    "senators": [
      {"name": "Seasoned engineer", "prompt": "Assess implementation choices and maintenance costs."},
      {"name": "Numerical analyst", "prompt": "Check numerical assumptions, bounds and calculations."},
      {"name": "Verification engineer", "prompt": "Inspect actual tests and challenge unsupported claims."}
    ]
  }
}
```

The optional `prompt` is also the place for a short personality paragraph. It
steers this participant's temperament, reasoning style and interaction with
others, separately from their name and the current assignment. For example:

```json
{
  "name": "Numerical analyst",
  "prompt": "You are patient, precise, and quietly skeptical. Prefer small counterexamples and quantitative bounds. Challenge unsupported claims without becoming combative, and readily change your position when the evidence warrants it."
}
```

The paragraph is included in that participant's instructions throughout the
discussion. The princeps accepts the same field. Combine the character with a
concrete professional responsibility; do not replace the task's acceptance
criteria with a persona. Use `agent` to reuse a larger environment definition.

Participant names must be unique. Each may supply `prompt`, `agent` assets and
`model`. The princeps senatus coordinates; the configured name remains Marcus
in this example. Senators carry professional roles. Ask for the structured
decision fields the workflow needs rather than assuming every decision supplies
an `approved` field. The result belongs to the Senate job; individual contributions
and phases remain inspectable separately.

## Swarm

```sh
asys-workers add ./env/research swarm search
```

The starter creates a named swarm, `search-step` member command, member prompt,
and `worlds/search/` package. Configure its evaluator and world settings before
running. The initial evaluator deliberately rejects unconfigured work.

```json
{
  "version": 1,
  "kind": "swarm",
  "config": {
    "version": 1,
    "world": {"package": "worlds/search", "settings": {"top_k": 0, "problem": {"initial": {}}}},
    "agents": {"count": 4, "type": "search-step"},
    "limits": {"turns": 20, "decisions": 80}
  }
}
```

The run request becomes the mission. Member commands execute observations and
return actions and private memory. The separate world component determines
admissibility, transitions and measured success. Reaching a turn or decision
limit does not establish the objective was achieved. Read evaluation metrics.

Named swarm definitions use `world.package`; runtime channels are assigned per
job. Neither `world.command` nor host module imports belong in this definition.
Senate and swarm currently accept no per-job `parameters` fields. Change their
named configuration to change participants, worlds or search limits.
