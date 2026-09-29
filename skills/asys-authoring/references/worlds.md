# World packages

A swarm worker owns member identity, private memory, turn scheduling and
checkpoints. A world owns observations, action rules, state transitions and
evaluation. The world runs as a separate dcomp component; workers neither import
its code nor start its process.

## Start a package

```sh
asys-workers add ./env/research swarm search
```

This creates `worlds/search/world.json`, a viewer, and a component directory with
Dockerfile, manifest, service and evaluator. `world.json` is:

```json
{"version":1,"component":"component/component.dcomp","view":"view.mjs"}
```

The component and view are relative files in this package. Keep implementation
code outside the viewer directory. Paths cannot escape the package or traverse
symlinks. Optional `deployment` contains boolean `egress` and `links` mapping
input names to `COMPONENT.OUTPUT` or `@GLOBAL`.

The named definition references `world.package: "worlds/search"`. Built-in
references are `builtin:leaderboard`, `builtin:torus`, and `builtin:terrarium`.
The first shares evaluated candidates; the second restricts observations by
wrapped local distance; the third is the Rainkeepers habitat. Task-specific
evaluation belongs in a copied package rather than edits to installed resources.

## Implement evaluation

The artifact-world evaluator reads `{"candidate":...,"problem":...}` from
stdin. It emits either:

```json
{"accepted":true,"score":16,"details":{"checked":true}}
```

or:

```json
{"accepted":false,"reason":"The route visits a city twice"}
```

Check actual constraints before accepting. The starter intentionally rejects
everything until configured. Its initial candidate is evaluated before member
inference, so a broken evaluator cannot masquerade as a valid search. Define
score direction, target, problem and initial candidate in world settings as
required by the selected world. Acceptance and achievement are distinct.

The swarm config chooses member count/type, seed, objective and limits. Counts
range from 1 to 256. A null objective requests exploration. The request becomes
the mission. Member output is actions plus private memory; evaluation is the
authority for success, not a member's narrative.

## World protocol version 1

Each job has an isolated runtime session. Requests are `world.request` events
with `version`, `runId`, `requestId`, `method`, `arguments` and `identity`.
`describe` starts with null identity; subsequent operations use the returned
implementation identity. Responses repeat those identifiers, set `ok`, and
contain `result` or an `error` object.

| Method | Arguments | Result |
| --- | --- | --- |
| `describe` | `[]` | `{identity, actionSchema}` |
| `action_schema` | `[]` | Draft-07 schema for one action |
| `initialize` | `[settings, participantIds, seed]` | State |
| `observe` | `[state, participantId]` | Observation; `active:false` suspends a member |
| `step` | `[state, actionsByParticipant]` | `{state, events}` |
| `evaluate` | `[state, objective]` | `{achieved, metrics, summary}` |
| `artifacts` | `[state]` | Exported artifacts |

World state and seeded randomness must be explicit. Repeated requests must be
deterministic or external effects idempotent. Schema references stay local.
Recovery requires matching implementation identity and action-schema digest.
Runtime transport handles atomic events and acknowledgements; do not create
queue/channel files by hand. The world receives its private runtime subtree,
not member private memory or arbitrary worker job directories.

Python components can use the shipped service SDK:

```python
from asys_swarm.world_service import Component
Component("/var/lib/asys-world", rules, identity="my-rules-v1").serve()
```

## Dashboard view

`view.mjs` exports `mount(element, context)` returning `{update(frame), dispose()}`.
Use `context.inspect(selection)` for the shared sidebar and
`context.selectMember(id)` for member evidence. Theme colors, font and normalized
task path are available as `context.theme`. Keep replay observational: rendering
a frame must not submit actions or mutate execution state.

For larger text artifacts, publish an immutable `{path, sha256, size}` reference
in the frame and call `await context.readWorldArtifact(reference)` to read its
UTF-8 contents on demand. `path` is relative to this job's recorded world runtime;
`sha256` is the lowercase SHA-256 of the raw file bytes and `size` is their count
(at most 32 MiB). Reads reject traversal, symlinks and changed content. Keep the
referenced files for replay. The viewer cannot select another world's directory.

The host snapshots view assets with the run and records durable world frames.
Each job records its renderer generation. Workflow resume can snapshot a new
renderer for new jobs while earlier jobs keep their saved renderer.
Built-in views share the dashboard design
stylesheet; custom views should use the same theme tokens and expose useful
classes for styling. Every co-located member needs a distinct selectable mark.
