# Human prompt demo

Two human tasks start in parallel: review a draft with a decision and optional
comments, and leave additional short feedback. The terminal handler queues both requests and presents one
at a time. The workflow joins the two answers and prints them as JSON. It uses
only human workers and needs no model or inference provider.

From this directory, initialize an empty demo system once, before starting
either command:

```sh
dcomp --state-root "$PWD/.asys/dcomp" up system.dcomp
```

The demo requires the workers, workflow and Human images. Build them with
`make build` from the repository root if they are not already available. The launcher builds this
example's small worker environment automatically.

For one terminal, run `./run --human`. To use a shared handler, in the first terminal run:

```sh
./prompt
```

In a second terminal in the same directory, run:

```sh
./run
```

The helpers use the host tools from this checkout and keep the demo's dcomp,
workflow, and handler state under `.asys/`. They connect to the separate
`human-prompt-demo` system. The prompt can start before the workflow; workers connect through `@human_endpoint`.

For the review, type `approve` or `disapprove` (or its displayed number), then
enter optional comment lines and finish with `/done`. Enter `/done` immediately
to omit the comment. This form uses JSON Schema for its fields and JSON Forms
UI schema for decision labels, field order and multiline comments.

The separate feedback question takes a nonempty line of text. Each response is
shown for review; enter `y` at `Submit response?` to send it or `n` to edit it.
The order of the two questions can vary because
they are published in parallel. The workflow waits for both answers, then
prints a result such as:

```json
{
  "approval": {"approved": true, "comments": "The description looks good."},
  "feedback": "Add an example of reviewer feedback."
}
```

Disapproval records `false` and completes this demo normally. The prompt stays
running for another `./run`; press Ctrl-C in its terminal when finished. Ctrl-C
in the workflow terminal cancels that workflow. Empty required feedback is
rejected at the prompt and can be corrected before submission.

Open [workflow.bpmn](workflow.bpmn) in a BPMN editor to see the parallel branches
and join. The environment's [workers.json](env/human/workers.json) declares only
the human runner, and its [component.dcomp](env/human/component.dcomp) declares a Human input.
