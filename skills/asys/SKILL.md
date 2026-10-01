---
name: asys
description: Run and inspect asys workers and workflows, configure inference and model defaults, answer human requests, upgrade running workflows, and recover failed workflow runs. Use for operating an existing asys project. Use asys-authoring to create environments, workers, worlds, workflows or dashboard designs.
---

# Operate asys

Public execution goes through `asys-run`, including workflow files (`.yaml`)
and BPMN workflows. Component
names such as `asys-bpmn` identify implementation packages, not separate host
launch commands. Use the installed command help and these bundled references.

## Select the setup

Identify four independent selections before starting work:

- Environment: Dockerfile, component interfaces, worker definitions and tools.
- Workspace: existing project files that jobs read and modify directly.
- State directory: saved runs, inference, Human state and model defaults.
- System: dcomp namespace containing components and shared endpoints.

`--root` selects the asys state directory. Defaults are `ASYS_STATE_ROOT`, then
`XDG_STATE_HOME/asys`, then `~/.local/state/asys`. Load a project's `asys-env`
when provided; it also selects dcomp state. Observation can read records from
several systems in one state directory.

## Execute and inspect

```sh
asys-workers list ENVIRONMENT
asys-workers describe ENVIRONMENT WORKER
asys-run ENVIRONMENT WORKER "Assignment" --workspace PROJECT
asys-run ENVIRONMENT workflow.yaml --input request.md --workspace PROJECT
asys status latest
asys logs latest
asys dashboard
```

Use actual project paths and names. Check required services and models before a
model run. Program-only work need not use inference. Stay within the authorized
scope; inspection does not require starting paid or externally mutating work.

Read the recorded failure before retrying. `asys-run --resume RUN` restores a
workflow's saved definition and workspace; partial edits persist. Model output
is not proof that acceptance criteria passed: inspect artifacts and checks.

After installing new execution code, use `asys-run --upgrade RUN` to drain a
workflow's jobs and replace its owned engine, workers and worlds. Existing job
IDs and outcomes are retained, including failures; shared services stay in place.
Read [workflow upgrades](references/operations.md#upgrade-a-running-workflow)
before choosing upgrade, retry or shared-service update. Repeat `--upgrade` to
continue an interrupted upgrade; its jobs and checkpoint are preserved.

Answer human tasks through the Human service. Present the recorded question and
evidence, obtain the person's answer, and submit it. Do not invent approval to
complete a demonstration. The dashboard inspects evidence; the terminal handler
accepts answers.

## References

- [Commands](references/commands.md): exact syntax, common options and skill export.
- [Setup](references/setup.md): installation, state, inference, models and updates.
- [Operations](references/operations.md): logs, dashboard, Human requests and recovery.

Report the run ID, useful artifacts, checks performed and remaining limitations.
