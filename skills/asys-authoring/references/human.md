# Human help and review

A human step is an ordinary `run` of the environment's `human` type. Provide an
intelligible briefing from the producing step, not a generic question followed
by raw state.

| Field | Content |
| --- | --- |
| `prompt` | Required question and consequences of each answer |
| `title` | Concrete decision name |
| `summary` | Work completed, changes, observed checks and unresolved issues |
| `files` | Existing workspace artifacts: `{path, label, description?}` |
| `context` | Readable background |
| `details` | Optional technical records |
| `form` | JSON Schema draft-07 describing the answer |
| `uischema` | Optional JSON Forms layout |
| `candidates` | Optional eligible human identities |

Example step:

```yaml
human_review:
  run: human
  input:
    title: Review the route result
    prompt: >-
      Accept writes a handover. Revise sends your comments to implementation,
      repeats checks and asks again. Stop ends without acceptance. Which next
      step do you want?
    summary: ${evidence.final}
    files:
      - {path: evidence.md, label: Measurements and checks}
    form: forms/decision.json        # or the schema inline
  timeout: P2D
  on_timeout: stopped
  next: decide
```

with `forms/decision.json` beside the workflow:

```json
{
  "type": "object",
  "properties": {
    "action": {"type": "string", "enum": ["accept", "revise", "stop"]},
    "comments": {"type": "string", "title": "Requested revision or decision comments"}
  },
  "required": ["action"],
  "additionalProperties": false
}
```

`asys workflow check` reads the form and checks that a `switch` comparing
`human_review.action` with a literal uses a value the form allows. A program
can also produce the whole object, passed through as `input: ${briefing}`. Without a custom form the handler uses
its default answer contract; choose an explicit form when routing depends on
typed fields. The parsed answer becomes the step's result, for example
`{"action":"revise","comments":"Add fractional-coordinate checks"}`.

Route with a `switch` on conditions such as `human_review.action = "revise"`. Pass
`human_review.comments` into the revision request, handling null when optional.
Re-run deterministic validation and review before asking for acceptance again.
Do not interpret “stop” as acceptance or treat a negative answer as a failed
human process.

Artifact links refer to files in the actual workspace. Ensure they exist before
asking. Explain measurements in the summary; do not make the person reconstruct
the decision from internal job directories or UUIDs. Keep secrets out of briefs.

```sh
asys-human-prompt --root ./state
asys-run ./env/development workflow.yaml --input request.md --human
```

The first attaches to the shared service. The second creates a private service
and terminal for a workflow. The service can wait before a terminal attaches.
The dashboard displays the task; answers go through the Human service. A live
revision needs a real person's answer. Fixture answers may test routing but must
be identified as fixture data.

In BPMN, the same object is the FEEL context of a `userTask`'s `asys:job input`;
see [BPMN workflows](workflows.md).
