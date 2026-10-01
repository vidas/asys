# Commands and options

## Execution and authoring

```text
asys-run ENVIRONMENT WORKER [REQUEST] [OPTIONS]
asys-run ENVIRONMENT WORKFLOW.yaml|WORKFLOW.bpmn [REQUEST] [OPTIONS]
asys workflow check WORKFLOW.yaml [--environment DIRECTORY] [--json]
asys workflow convert WORKFLOW.bpmn [-o WORKFLOW.yaml] [--process ID] [--force]
asys workflow resolve WORKFLOW.yaml        (the document a run loads, for the Workflow service)
tools/asys-bpmn-convert [--dry-run] [--force] FILE.bpmn|DIRECTORY ...   (in an asys checkout; not installed)
asys-flow-view [-environment DIRECTORY] WORKFLOW.yaml | -run RUN   (X11 viewer; see its man page)
asys-run --resume RUN [--root DIRECTORY] [--human]
asys-run --upgrade RUN [--root DIRECTORY] [--human]
asys-workers list ENVIRONMENT [--json]
asys-workers add ENVIRONMENT KIND NAME [--file FILE]
asys-workers describe ENVIRONMENT NAME
asys-workers edit ENVIRONMENT NAME
asys-environment add-skill ENVIRONMENT SKILLDIR
asys-environment dockerfile ENVIRONMENT FILE
asys-environment edit ENVIRONMENT [FILE]
```

`KIND` is `agent`, `goal`, `senate` or `swarm`. `add --help` explains generated
files and configuration. Describe prints JSON. Edit uses `VISUAL` or `EDITOR`
and validates before replacement. Environment commands edit source files and
take no state-root option.

`REQUEST` is literal text. `--input FILE` reads UTF-8 text instead; `-` reads
stdin. JSON-looking text remains text. A named worker requires a request;
a workflow may omit it if its tasks do not use the `request` variable.

| Option | Meaning |
| --- | --- |
| `--workspace DIRECTORY` | Existing project directory; default current directory |
| `--root DIRECTORY` | Asys state directory; this run is saved under `runs/` |
| `--name NAME` | Run display name |
| `--input FILE` | Request file or stdin; cannot accompany positional REQUEST |
| `--model MODEL` | Named-worker model override; configure workflow models in definitions |
| `--parameters FILE` | Named-worker JSON parameters: agent `maxSteps`, goal `maxAttempts` |
| `--process ID` | Select an executable process in a BPMN document |
| `--human` | Workflow terminal with a private Human service; resume/upgrade can attach its saved private service |
| `--system NAME` | Dcomp namespace; default `asys` |
| `--dcomp-state-root DIRECTORY` | Dcomp state; default `DCOMP_STATE_ROOT` or dcomp default |
| `--runtime-root DIRECTORY` | Dcomp proxy/socket directory; default `DCOMP_RUNTIME_ROOT` or the dcomp state directory/run |
| `-L INPUT=TARGET`, `--link INPUT=TARGET` | Repeatable input connection: `COMPONENT.OUTPUT`, `@GLOBAL`, or `-` |

Resume and upgrade restore saved configuration and accept only `--root` and
`--human`. They reject a new environment, workspace, request, model, system or
connection. Upgrade drains existing jobs, replaces owned execution components
and recovers their saved outcomes without retrying failures. See
[workflow upgrades](operations.md#upgrade-a-running-workflow) for prerequisites
and interruption behavior.
Stdin cannot supply both `--input -` and interactive `--human` answers.

## Configuration and observation

```text
asys init DIRECTORY [--dcomp DIRECTORY] [--group GROUP]
asys update [--force] [--root DIRECTORY]
asys version [--root DIRECTORY]
asys system-model set simple MODEL [--root DIRECTORY]
asys system-model list [--json] [--root DIRECTORY]
asys ps [--json] [--root DIRECTORY]
asys status [RUN] [--json] [--root DIRECTORY]
asys logs [RUN] [JOB] [--source SOURCE] [--stream STREAM] [-f] [-n N] [--root DIRECTORY]
asys top [RUN] [--root DIRECTORY]
asys dashboard [--run RUN] [--port PORT] [--design DIRECTORY] [--root DIRECTORY]
asys skill [DEST] [--name asys|asys-authoring]
```

`asys status` without `RUN` reports the setup: its dcomp system, the shared
services with their state, health and build, and each active run with its
components. With `RUN` it shows that run's jobs and errors.

`RUN` accepts an ID, unique prefix, `latest`, or saved run directory. `JOB`
accepts a name, ID or unique prefix. An omitted run selects the latest applicable
run; `ps` lists saved runs.

`asys dashboard --run RUN` serves one run of the root, resolved once when the
dashboard starts (an ID, unique prefix or `latest`). Its overview lists only that
run, and requests for any other run, including execution controls, are refused.
Controls for the run itself remain available.

Log sources: `run`, `events`, `jobs`, `components`, `commands`. A JOB or stream
selects `jobs`; streams are `stdout`, `stderr`, `both`. Default output is the
full run log or 50 lines per worker/component log. `-n 0 -f` follows new output.

`asys skill` prints bundled paths; `--name` selects one. DEST is the parent skill
directory. Without `--name`, both `DEST/asys` and `DEST/asys-authoring` are copied
with references and templates. Existing copies are preserved and reported as
an error. Exported copies are snapshots, independent of later installation updates.

## Shared state semantics

`--root` selects the same asys directory for execution, observation, inference
and human host commands. It can precede or follow command arguments. Precedence:
explicit option, `ASYS_STATE_ROOT`, `XDG_STATE_HOME/asys`, `~/.local/state/asys`.
Each service uses its own subdirectory beneath that root.

`asys init` takes the directory positionally. Authoring takes an environment;
skill export reads the installed bundle. These do not take `--root`.

One root can hold runs from several dcomp systems. `--system` does not create a
new root. Inference saves its system and dcomp paths at `init`; later commands
reuse them. Runners must use matching settings to reach its shared endpoint.
