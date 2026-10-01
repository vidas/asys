---
name: asys-authoring
description: Create or change asys environments, named agents, goals, Senates, swarms, program workers, workflow files (YAML, or BPMN while it remains), human review, world packages and dashboard designs. Use when building an executable asys project or translating a design document into a dashboard theme.
---

# Author asys projects

Turn the requested behavior into executable definitions, file contracts and
observable checks. Inspect the existing project first. Preserve the user's
chosen execution shape: one assignment can use one worker; a workflow can
combine different worker kinds and programs in the same environment.

## Put behavior in the right place

| Concern | Location |
| --- | --- |
| Dependencies and installed programs | `ENVIRONMENT/Dockerfile` |
| Component interfaces | `ENVIRONMENT/component.dcomp` |
| Job names and command vectors | `ENVIRONMENT/workers.json` |
| Named worker behavior | `ENVIRONMENT/workers/NAME.json` |
| Reusable agent instructions | `ENVIRONMENT/agents/NAME/prompt.md` |
| Shared tool knowledge | `ENVIRONMENT/skills/NAME/` |
| Deterministic checks | `ENVIRONMENT/programs/` |
| World rules and evaluation | `ENVIRONMENT/worlds/NAME/component/` |
| Sequencing and handoffs | `workflow.yaml` (steps name worker types; no code) |
| Project inputs and deliverables | Separately selected workspace |
| Dashboard presentation | Design package with `design.json` and CSS |

`asys-workers add ENVIRONMENT KIND NAME` creates a worker and missing environment
files, preserving existing assets. `KIND` is `agent`, `goal`, `senate` or `swarm`.
Configure the generated files before declaring the worker ready.

Launch with `asys-run ENVIRONMENT WORKER REQUEST` or
`asys-run ENVIRONMENT WORKFLOW.yaml --input FILE` (BPMN files still run). A workflow is a run definition,
not another named worker kind. Programs and Human handlers are ordinary command
bindings in `workers.json`.

## Define and check the contract

Specify deliverables, file ownership for concurrent writers, result fields and
the checks establishing success. Jobs share the actual workspace; asys does not
copy outputs between stages or create isolated worktrees. Serialize edits to the
same files unless the project explicitly arranges isolation.

Use the same named definitions standalone and in workflows. Named workers accept
`{request, parameters?}`. Programs may define their own input schema. Stdout is a
log; structured output goes to `ASYS_RESULT`. A worker exception is execution
failure; a completed negative review is a successful result for a revision branch.

Give Senate members professional responsibilities such as Seasoned engineer,
Numerical analyst and Verification engineer. Preserve the princeps senatus's
configured name separately from the coordinating role.

Human help needs evidence, a concrete question and the consequences of each
choice. Connect revision back through the relevant program checks and review.
Obtain actual human answers; deterministic test answers are fixture data only.

## References and templates

- [Environments and programs](references/environments.md): new environments,
  Docker, tools, prompts, skills and deterministic workers.
- [Workers](references/workers.md): agent, goal, Senate and swarm definitions.
- [Workflow files](references/workflow-files.md): the YAML format, steps,
  expressions, human steps, the viewer, and converting BPMN.
- [BPMN workflows](references/workflows.md) and [advanced BPMN](references/advanced-workflows.md):
  the earlier format, which still runs; prefer workflow files for new work.
- [Human help](references/human.md): briefings, forms and revision paths.
- [Worlds](references/worlds.md): packages, evaluators, protocols and viewers.
- [Dashboard designs](references/design.md): design document to shared CSS,
  symbols, fonts and logo assets.
- [Validation](references/validation.md): runnable checks and evidence boundaries.

The [team starter](assets/team/workflow.yaml) has deterministic and model
environments for a review/revision loop, with its check as a declared program.
The [goal template](assets/goal.yaml) embeds a goal in a workflow. BPMN
versions of both remain beside them. Copy templates into a project before editing them.
All linked resources travel with this skill; no source checkout is required.
