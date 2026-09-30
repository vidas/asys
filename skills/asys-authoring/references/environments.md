# Environments and programs

## Create an environment

```sh
asys-workers add ./env/development agent editor
asys-workers add ./env/development goal repair
asys-workers add ./env/development senate review
asys-workers list ./env/development
```

The first add creates missing `Dockerfile`, `component.dcomp` and `workers.json`.
Each worker adds `workers/NAME.json` and its runtime binding. An agent also gets
`agents/NAME/prompt.md`. Existing names are errors; existing files are preserved.

```text
env/development/
  Dockerfile
  component.dcomp
  workers.json
  tools.md
  workers/editor.json
  workers/repair.json
  workers/review.json
  agents/editor/prompt.md
  skills/checking/SKILL.md
  programs/check.py
```

The environment is reusable software. The workspace supplied at execution is
the project it operates on. Keep generated reports and implementation files out
of the environment definition unless they are intentionally reusable resources.

## Package dependencies

```dockerfile
FROM asys-workers
USER root
RUN apt-get update && apt-get install -y --no-install-recommends make gcc \
    && rm -rf /var/lib/apt/lists/*
COPY . /opt/asys/environment
USER node
```

Name the base without a tag. asys builds the environment on the installed
release's `asys-workers` image, so the environment follows the installation; a
plain `docker build` cannot resolve it. The former `FROM asys-workers:dev`
resolves the same way, with a notice to update it.

Retain the base entrypoint. The host runs components with the invoking UID/GID;
installed programs must work for that identity. Build-time installation is the
place for dependencies. An optional `tools.md` inventories available tools and
versions for agent prompts; it neither installs tools nor registers extensions.

```text
docker project-development
input cyclo.provider.v1.Provider inference
input asys.human.v1.Human human
```

The manifest's docker line names the image. With a Dockerfile, new runs and
resume build using the current base and cache. Without one, the image must
already exist. Program-only environments may omit unused inputs. The generated
environment declares inference and human, so remove inference explicitly if a
pure program environment should run without an inference endpoint.

By default, host preparation links inference to `@inference_endpoint` and Human
to `@human_endpoint`. `-L INPUT=TARGET` overrides a declared input. Worker
`egress` defaults to false; enable it in workers.json only when the tools need
outbound network access. Inference RPC does not need worker egress.

## Command bindings

```json
{
  "version": 1,
  "name": "development",
  "egress": false,
  "types": {
    "check": {"command": ["python3", "/opt/asys/environment/programs/check.py"], "timeout": 300},
    "program": {"command": ["/opt/asys/asys-workers/tools/asys-program"]},
    "human": {"command": ["/opt/asys/asys-workers/tools/asys-human"]}
  }
}
```

Add named workers with the CLI to preserve these bindings. A command is a string
array, with task args appended. No shell syntax is interpreted unless the array
explicitly invokes a shell. Optional `env` supplies environment variables and
`timeout` is the whole-program limit in seconds. A relative executable containing
`/` resolves beside workers.json; a bare executable uses PATH. Relative arguments
belong to the program, usually relative to its workspace.

## Write a program

Runtime supplies JSON on stdin and in `ASYS_INPUT`, sets the working directory
to the workspace, and provides `ASYS_RESULT` for structured output. It also
provides `ASYS_JOB_ID` and `ASYS_JOB_DIR`. This check fails if the report is absent:

```python
import json
import os
from pathlib import Path
import sys

assignment = json.load(sys.stdin)
report = Path(assignment.get("path", "deliverables/report.md"))
contents = report.read_text(encoding="utf-8")
if "## Evidence" not in contents:
    raise SystemExit("Report has no Evidence section")
Path(os.environ["ASYS_RESULT"]).write_text(json.dumps({
    "path": str(report), "bytes": len(contents.encode()), "checked": True
}))
```

Stdout/stderr are logs. Use a nonzero exit when execution failed. A custom
program's input is its own contract; the generic named-worker dispatcher accepts
only `request` and optional `parameters`. In a workflow, bind the check with its
native input object rather than forcing every program through agent semantics.

## Agent knowledge and extensions

Put stable responsibilities, file ownership and reporting conventions in
`agents/NAME/prompt.md`. Put the current assignment and feedback in `request`.
Optional `memory.md` contains deliberately retained knowledge; ordinary execution
does not promote its own lessons into that file.

```sh
asys-environment add-skill ./env/development ./skills/checking
asys-environment edit ./env/development agents/editor/prompt.md
asys-environment dockerfile ./env/development ./Dockerfile
asys-workers edit ./env/development editor
```

Skill import copies the complete directory, including references and assets.
Shared skills live in `skills/`; agent-specific skills can live under
`agents/NAME/skills/`. Extensions live in `extensions/` or
`agents/NAME/extensions/`; package their dependencies in the image. Extensions
add callable tools or behavior; documenting a tool does not implement it.
