<img src="docs/assets/banner.svg" alt="asys — Agentic systems, composed. Version 0.2.1. MIT. Linux." width="100%">

**asys runs teams of AI agents, programs and people on your real projects.**
Give one agent an assignment, have a goal implemented and independently
verified, let a Senate of specialists deliberate, send a swarm to explore, and
wire all of it into a workflow with parallel work, human decisions and
revision. Every step is recorded, can be resumed after a failure and inspected
afterwards: what was done, and why.

[Install](INSTALL.md) · [Start](#03--start) · [Workflows](skills/asys-authoring/references/workflows.md) · [Workers](skills/asys-authoring/references/workers.md) · [Operations](skills/asys/references/operations.md) · [Release notes](CHANGELOG.md)

- **Real work, real files.** Jobs edit your actual repository or project
  directory. Deliverables stay in the workspace; logs, transcripts and reports
  stay in the run record.
- **Verified, not just generated.** A goal keeps implementing until a fresh,
  independent verifier accepts the whole request, and asks a person when it is
  blocked.
- **People are part of the system.** Human steps are typed questions that a
  workflow waits on: accept, revise or stop, answered from a terminal.
- **Nothing gets lost.** Runs survive crashes and restarts. Failed workflows
  resume; running workflows move onto newly installed code without losing a job.
- **Any model, one gateway.** OpenAI, Anthropic, Google, Bedrock, OpenRouter and
  more through [Pi](https://github.com/earendil-works/pi), pooled across
  accounts. Credentials stay in the gateway; agents never see them.
- **Your machine, your rules.** Linux and Docker, composed with
  [dcomp](https://github.com/glguida/dcomp). Shared by a team through one Unix
  group. MIT licensed.

## 01 · Follow the work

Take a software change. An agent implements the request in the repository. A
program runs the tests. Then the work forks: a second agent reviews the change
while a person examines the result. The workflow joins both decisions before a
final program packages the work.

<img src="docs/assets/percorso.svg" alt="Work proceeds from an agent to a program, forks into agent and human steps, then joins before a final program. The worker environment is the field these steps run in." width="100%">

The workflow owns the decisions: when to accept, when to send the work back for
repair, when to stop. Workers carry out their assignments with the tools
installed in their environment. Agents run on the Pi coding-agent SDK, programs
run ordinary commands, and human steps wait for an answer. Workflows are
standard BPMN 2.0 XML with a small execution binding.

## 02 · Six kinds of work

| Kind | What it does |
| --- | --- |
| **Agent** | One assignment, with tools, skills, memory and a saved conversation |
| **Goal** | Implements until an independent verifier accepts; asks a person when blocked |
| **Senate** | A princeps senatus and senators with professional roles deliberate in public speeches and reach a decision |
| **Swarm** | A population explores a separate world that measures its results |
| **Program** | A deterministic command with JSON input and output |
| **Human** | A person answers a typed question |

Each is an ordinary job. Run one directly with `asys-run`, or combine them in a
workflow. [The mixed-review example](asys-bpmn/examples/mixed-review/) uses them
all: an agent, two model swarms, a verified goal, a program checking their
files, a Senate, and a human accept, revise or stop decision.

## 03 · Start

[Install asys](INSTALL.md) with dcomp and Docker, then create a state directory
and check execution with the bundled deterministic workflow. No model account is
needed:

```sh
make install
asys init ./state
source ./state/asys-env
asys-run asys-bpmn/examples/hello/env/dummy asys-bpmn/examples/hello/workflow.bpmn
asys logs latest
```

Start inference, sign in to a provider and choose a default model:

```sh
asys-inference init
asys-inference start
asys-inference gateway login openai-codex --as work
asys-inference models
asys system-model set simple work/gpt-6.1-sol
```

Create an environment with a goal worker and put it to work on a project:

```sh
asys-workers add ./env/development goal repair
asys-run ./env/development repair "Fix the reported bug and independently verify the result" \
  --workspace ./project
asys dashboard
```

A workflow uses the same environment and a request file:

```sh
asys-run ./env/development ./workflow.bpmn --input request.md --workspace ./project
```

For human steps, answer from another terminal with `asys-human-prompt`.

## 04 · Nothing gets lost

<img src="docs/assets/nastro.svg" alt="A run record: a numbered strip of saved events, followed by events not yet written, with a reader positioned at the latest saved event." width="100%">

Every run keeps its requests, logs, agent transcripts, reports, results and
workflow checkpoints in the state directory. Writes are atomic and journals
survive a torn write, so a crash leaves a record you can continue from:

```sh
asys top                    # live runs, jobs and transcripts
asys status latest          # jobs, results and errors
asys logs latest            # saved output, or one job's worker output
asys dashboard              # workflow maps, transcripts, Senates and swarm worlds
asys-run --resume RUN       # restart the failed stage of a workflow
asys-run --upgrade RUN      # move a running workflow onto newly installed code
```

`--upgrade` drains the running jobs, replaces the workflow's execution
components and continues with the same job IDs and outcomes. `asys update`
refreshes shared inference and Human services after an installation; signed-in
accounts are kept.

## 05 · Share one machine

A team shares one installation, one inference gateway with its signed-in
accounts, and one set of run records through a Unix group:

```sh
sudo make install PREFIX=/usr/local
sudo groupadd --force asys && sudo usermod -aG asys alice
sudo install -d -g asys -m 2770 /srv/asys
asys init /srv/asys/host --group asys        # as a group member, after logging in again
source /srv/asys/host/asys-env
```

Everyone sources the same `asys-env`, which also adds `{ host }` to the shell
prompt so you always know which setup you are driving. See
[state selection](INSTALL.md#select-state).

## 06 · Make it yours

```sh
asys-workers add ./env/development agent editor
asys-workers add ./env/development senate review
asys-workers add ./env/development swarm search
asys-environment add-skill ./env/development ./skills/checking
asys dashboard --design ./my-design
```

An **environment** packages the tools, prompts, skills and worker definitions;
the same environment serves many workflows. Two portable skills ship with every
installation and teach an agent to operate and author asys:
[asys](skills/asys/SKILL.md) and [asys-authoring](skills/asys-authoring/SKILL.md).
Export them with `asys skill DEST`. The dashboard's look is a separate
[design package](designs/default/), replaceable without touching code.

## Documentation

- [Installation and upgrade](INSTALL.md)
- [Commands and state](skills/asys/references/commands.md)
- [Monitoring and recovery](skills/asys/references/operations.md)
- [Environments and programs](skills/asys-authoring/references/environments.md)
- [Worker definitions](skills/asys-authoring/references/workers.md)
- [Workflows](skills/asys-authoring/references/workflows.md)
- [Human review](skills/asys-authoring/references/human.md)
- [Worlds](skills/asys-authoring/references/worlds.md)
- [Visual style guide](docs/styleguide.pdf)
- [Release notes](CHANGELOG.md)

Component internals live in [runtime](asys-runtime/), [workers](asys-workers/),
[workflow engine](asys-bpmn/), [inference](asys-inference/) and
[Human service](asys-human-interface/).

<img src="docs/assets/cresta.svg" alt="asys · MIT licence" width="100%">
