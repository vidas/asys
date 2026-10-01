# Validate an authored project

First inspect definitions and command vectors with `asys-workers list` and
`describe`. Check required executables, files and model IDs. These checks establish
configuration validity, not execution correctness.

## Run the portable starter

Copy this skill's `assets/team` directory into a new project. When using the
installed bundle:

```sh
asys_authoring_dir=$(asys skill --name asys-authoring)
cp -R "$asys_authoring_dir/assets/team" ./report-team
mkdir -p ./report-workspace
asys workflow check ./report-team/workflow.yaml --environment ./report-team/env/dummy
asys-run ./report-team/env/dummy ./report-team/workflow.yaml \
  --input ./report-team/request.md --workspace ./report-workspace
asys status latest
```

The deterministic environment deliberately omits Evidence on its first report,
rejects it, revises it, checks the artifact again and accepts. It uses real
program jobs without inference. Its checks establish shared-file handoff and
revision routing, not model quality.

For model execution, configure the definitions under `team/env/agents/workers/`
with exported model IDs and start inference. Run the same workflow in a fresh
workspace with the agents environment. Adapt its prompts, deliverables and checks
to the real project before treating it as a production team.

## Check the actual composition

Exercise the paths the user requested: parallel outputs join before consumers;
programs read the same files written by workers; negative review reaches revision;
human choices preserve comments; cancellation and failure leave inspectable
evidence. Use genuine human input for a live human demonstration. Fixture answers
belong only in deterministic tests.

Inspect actual results and artifacts, not just final prose. For swarms, check
evaluator measurements and rejected candidates. For goals, inspect independent
verification. For a Senate, inspect participant contributions and the decision.
For a diagram or design change, capture the running UI and inspect the screenshot.

Report what ran, its saved ID, the workspace artifacts and the limits of each
check. Stop repeating broad successful checks unless a new change or finding
creates an unresolved concern.
