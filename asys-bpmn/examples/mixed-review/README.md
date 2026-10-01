# Parallel searches with Senate and human review

This example runs an agent, two model swarms, a goal with independent
verification, an independent program, a Senate, and a real human request. The searches and checker goal
run in parallel. Their artifacts share one workspace but use separate paths.
The Senate has a Princeps senatus and three professional reviewers: a seasoned
engineer, a numerical analyst, and a verification engineer.

From the repository root, create a fresh example directory:

```sh
python3 asys-bpmn/examples/mixed-review/prepare.py /tmp/asys-mixed-review
tools/asys-run /tmp/asys-mixed-review/environment \
  asys-bpmn/examples/mixed-review/workflow.yaml \
  --workspace /tmp/asys-mixed-review/workspace \
  --input asys-bpmn/examples/mixed-review/request.md \
  --name mixed-review
```

`workflow.yaml` is the workflow file; `workflow.bpmn` is the same workflow in
BPMN, which runs on the BPMN engine while both formats are supported. To see
the workflow, or follow the run:

```sh
asys-flow-view -environment /tmp/asys-mixed-review/environment \
  asys-bpmn/examples/mixed-review/workflow.yaml
asys-flow-view -run RUN
```

The environment uses the configured system models. Add `--model PROVIDER/MODEL`
to preparation to select one explicitly. Existing worker and world component
images and an inference provider are required, as for the route sample.
Preparation refuses to overwrite a directory, preserving earlier evidence.

Open the dashboard on the same state root. Select the global or local swarm to
inspect the corresponding world, the goal for implementation and verification,
or Senate review for participant conversations. The human task waits in the
shared Human service. Run `asys-human-prompt --root STATE_ROOT` in a terminal
to answer it, or add `--human` to the workflow launcher for a private handler.
The dashboard displays the request; answers go through the Human service.

The program reads both saved swarm artifacts and the goal-produced checker,
recomputes each score, runs tests, and writes `comparison.json` and `evidence.md`.
Its output lists the shared input paths and measured values. If a human revision
adds `revision-checks.json` with `{cases: [{cities, tour, expected}]}`, the same
program verifies those extra cases on the next pass.

The person can accept (write `handover.md`), revise (run a goal with their
comments, rebuild evidence and repeat Senate review), or stop. No answer is
chosen automatically. The swarms do not rerun when revising the checker or
documentation. Nothing is deployed or published.
