# Hello workflow

This complete workflow runs one program through the ordinary job contract. The
environment declares the program `greet`, which writes
`{"message":"Hello from asys."}` to `ASYS_RESULT`; the workflow names it and
returns its result. No inference provider or request file is required.

From this directory after installation:

```sh
asys-run env/dummy workflow.yaml
```

From the repository root after building the images:

```sh
tools/asys-run asys-bpmn/examples/hello/env/dummy asys-bpmn/examples/hello/workflow.yaml
```

The environment supplies `workers.json`, Dockerfile and component manifest.
The runner builds its image automatically. `workflow.bpmn` is the same
workflow in BPMN, which runs on the BPMN engine while both formats are
supported; it supplies its program as a script, which workflow files cannot
do. See the [workflow format](../../../docs/workflow-design.md) and the
[authoring skill](../../../skills/asys-authoring/SKILL.md) for creating another
environment or replacing the program with a named worker.
