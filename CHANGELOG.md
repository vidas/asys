# Release notes

## Unreleased

- Write workflows as YAML files (`asys: workflow/1`) whose steps name the
  environment's worker types and hold no code: run, parallel and join, group,
  call (another workflow file), switch, repeat, for_each, choose, wait, delay,
  timeouts, error paths and compensation. `asys-run ENV WORKFLOW.yaml` validates
  the file and the files it calls, then runs it on a new interpreter in the
  workflow component; BPMN files still run on the BPMN engine.
- `asys workflow check` validates a file against an environment; `asys workflow
  convert` writes the workflow file a BPMN process corresponds to, or says what
  it cannot express; `asys workflow serve` is the model behind viewers.
- `asys-flow-view` views and edits workflow files on X11, in the style guide's
  graphic language, and follows runs live. It builds where the Xaw, Xft and
  XRender development files are installed.
- `asys dashboard --allow-host HOST[:PORT]` also answers requests addressed to
  that name, so a dashboard can be reached through `ssh -R` or a proxy that
  keeps the browser's host; other names are still refused.
- `asys dashboard --run RUN` serves a single run: it is resolved once at
  start, the overview lists only it, every other run's data and controls are
  refused, and the page opens on it.
- `asys logs` reports workflow file steps. The integration test runs on the
  release's images again.

## 0.2.1

- Give every build an identity. `VERSION` names the release; images are tagged
  only with a build ID such as `0.2.1-015b3d3` and recorded in `release.json`,
  which installation copies. Installed commands take the workflow engine, Human
  service and environment base images from that record, never from a tag, so
  building another checkout no longer changes an installation. The `:dev` tag
  is gone.
- Name asys base images without a tag (`FROM asys-workers`); asys resolves them
  to the installed release. Existing `FROM asys-workers:dev` environments build
  unchanged and print a notice to update the line.
- `asys status` without a run reports the setup: its dcomp system, the shared
  services with their state, health and build, and each active run with its
  components. `asys ps` lists runs; `asys status RUN` shows one.
- Add `asys version` to show the installed release, the selected state, and the
  build each running shared service uses, with warnings for outdated services
  and for another `asys-inference` earlier on PATH.
- Coordinate `asys update` with active runs when the inference format changes.
  Affected workflows drain on the current services through a background
  `asys-run --upgrade`, then continue on the new release once the services are
  replaced; single-worker runs finish first. An interrupted update continues
  when repeated. Workflows that predate upgrade handover stop the update unless
  `--force` is given.
- `sudo make install` builds as the invoking user and only copies as root, so
  it no longer leaves root-owned files in the checkout. Rebuilding an unchanged
  tree reuses its build ID and cache.
  Docker Engine 23+ with BuildKit is required.
- Update Pi to 0.99.1 for current models and providers, including GPT-6.
  Provider payloads now carry Pi's normalized transcript, and the inference
  format becomes `pi-ai@0.99.1`: update shared inference and upgrade active runs
  together. Logins survive `asys update`, and a stored-credentials test keeps
  earlier Pi records readable.
- Add `asys-run --upgrade RUN` to drain a workflow's jobs and move it onto
  installed execution code, preserving job IDs, outcomes and saved connections.
  An interrupted upgrade continues by repeating the command.
- Recover runtime failures without discarding active work: retry transient
  catalogue failures, keep durable writes off the workflow event loop, allow a
  bounded engine restart, and reattach private Human handlers. Keep active runs
  alive through shared status timeouts.
- Preserve context-overflow errors so agents compact and resume instead of
  retrying, and report recent gateway failures in `asys-inference status`.
  Recheck exhausted providers within ten minutes.
- Assess goals from current evidence and preserve their review history. Make
  Senate contributions substantive public speeches with preserved dissent.
- Fit workflow diagrams in a zoomable dashboard panel, keep activity and kind
  filters across refresh, and let world renderers cite immutable artifacts.
- Default `asys init DIRECTORY` to `DIRECTORY/dcomp` and initialize it with the
  requested shared group. Only an explicit `--dcomp` selects another directory;
  the caller's existing environment and home directory no longer select it.
- Require dcomp 0.3.2 or newer for its disconnected pending-connection fix.
  Pin the inference Go dependency to v0.3.2 and remove the copied Go source
  override so builds use the published module.

## 0.2.0

- Unify execution under `asys-run ENVIRONMENT WORKER|WORKFLOW.bpmn` and
  `asys-run --resume RUN`. Remove specialized host launchers and their obsolete
  installed packages; algorithms remain ordinary worker jobs.
- Separate named worker definitions from environment programs and shared skills.
  Use `asys-workers COMMAND ENVIRONMENT` and `asys-environment COMMAND ENVIRONMENT`.
  Expand command help with kinds, generated files, configuration and examples.
- Make public `--root` consistently select asys state across execution, inference,
  Human handling and observation. Distinguish state from environment, workspace
  and dcomp system; preserve saved configuration during workflow resume.
- Add a unified dashboard with persistent system selection, readable transcripts,
  structured JSON, program results and a shared inspector. Workflow diagrams
  distinguish all worker kinds, forks, revision paths and alternative endings.
  Senate participants occupy multiple tiers around the princeps senatus.
- Separate dashboard presentation into a shared CSS and asset package. Select
  alternative colors, symbols, fonts, logo and identity with `--design DIRECTORY`.
  Built-in world views use the same stylesheet and theme context.
- Rewrite guides and ship two complete portable skills: `asys` for operation and
  `asys-authoring` for environments, workers, workflows, Human review, worlds and
  designs. `asys skill DEST` exports both with references and runnable templates.
- Package worlds as separate dcomp components plus saved DOM viewers. Common host
  preparation provisions them for standalone and workflow jobs. Workers never
  import world code or start world subprocesses.
- Retain swarm identities, private memory, synchronous turns, limits and checkpoints
  in workers. Include checked-artifact leaderboard, local torus and Rainkeepers
  worlds, with durable frames and member conversations after execution stops.
- Include shared and selected-agent skill instructions in bounded swarm decisions.
  Default capable models to medium reasoning and preserve partial responses on
  interruption without executing unfinished tool calls.
- Add a mixed workflow demonstrating parallel swarms, a verified goal, an
  independent shared-workspace program, Senate review and real Human decisions.
- Keep resumed runs attached to their saved dcomp state and runtime directories,
  even after the invoking shell selects another installation. Preserve each
  swarm job's world viewer when later jobs use an updated world package.
- Include workflow events, boundary attachments and called activities in the
  dashboard, match jobs by task identity, and color tasks before they start.
  Accept direct Human requests through the shared runner input contract.

## 0.1.5

- Strengthen goal prompts to finish actionable implementation before handing off
  and critically review implementation and test adequacy during verification.
  Focus checks on unresolved risks and avoid broad reruns when a known gap
  already prevents acceptance.
- Give malformed agent completion JSON one format correction in the same session,
  preserving completed work and observations. Include the parser diagnostic and
  show complete JSON examples in goal prompts, so a formatting mistake can be
  corrected before it fails a goal or another agent job.

## 0.1.4

- Define and independently review success criteria before goal implementation.
  Preserve accepted contracts, review feedback and unresolved findings across
  attempts; reopen the contract when implementation or verification finds a
  material gap. Any phase can ask for human help. Keep unlimited attempts by
  default and give malformed phase reports one opportunity for correction.

## 0.1.3

- Present Human requests with the question, work summary, and evidence links
  first. Keep request identifiers and technical details in a separate tab or
  `/details` in plain mode, while preserving response drafts during navigation.
- Open workspace file links in the terminal preview, resolve links relative to
  the document, and support returning to the previous file. Expand the authoring
  guide with concrete instructions for preparing human decisions and evidence.
- Replace BPMN loop and ad-hoc activity instance patches with registered loop
  and sequence-flow constructors. Keep ad-hoc work idle until selected, including
  after recovery, and prevent discards from cascading into other selections.
  Discarded active selections now report failure to their coordinator.
  Gateways and events between selections retain native execution and recovery.
  Reject unconnected ad-hoc compensation handlers before execution so they
  cannot run automatically on scope entry.
- Route explicit FEEL conditional-event scripts through the engine's script
  registry. Pin engine/serializer assumptions with contract tests and add an
  advisory CI check against their latest releases.
- Change the workflow engine identity to `bpmn-elements@17.3.0+asys.2`.
  Checkpoints from the previous adapter cannot be recovered or resumed by this
  version, including failed runs from 0.1.2. Finish or resume those runs with
  the previous installation before upgrading, or start a new run. Saved logs,
  results, and workspace files remain available.

## 0.1.2

- Add the reusable `asys-goal` worker and host launcher. Fresh implementation
  and verification sessions repeat until the goal is verified, with no default
  attempt limit. Both phases can ask a human for help; evidence, lessons, and
  replies remain in job state. BPMN can use the same worker as an ordinary job.
- Supply the built-in `simple` agent independently of worker environments.
  One-shot now takes an environment and prompt, without an agent argument.
  `asys system-model set/list` configures defaults, and `--model` overrides
  the model for a one-shot or goal run. See the
  [upgrade instructions](INSTALL.md#upgrade-to-020).
- Load stable `prompt.md` instructions for named environment agents alongside
  their memory and resources, and record the effective definition in job state.
- Install a portable asys Agent Skill covering team and environment design,
  BPMN, one-shot, goals, human decisions, and recovery, with runnable templates.
  `asys skill` locates it; `asys skill DEST` copies it for any compatible agent.
- Teach agents to prepare human briefings with completed work, evidence,
  concrete questions, and the consequences of each choice.

- Keep the shared Human component running independently of terminal prompts.
  Workflows start it when needed; prompts attach later and can disconnect or
  reconnect without failing waiting jobs. `asys update` ensures it exists for
  running inference installations and updates it without requiring a prompt.

- Supply the workers' Human input for built-in human jobs and for `--human`,
  even when the environment omits it or declares it as an output.
  Ordinary runs use `@human_endpoint`;
  private handlers are connected only to their run and leave the global unchanged.
- Preserve Human connections across resume and report conflicting service types
  before starting work.

## 0.1.1

- `asys update` refreshes running inference services and the shared Human service
  from the installed images. Workflow and worker containers remain running.
- Resume preserves the last checkpoint when a worker or engine stops before a
  job failure is recorded. It retries unfinished stages with fresh jobs.
- `asys-bpmn run --human` and `resume --human` create a terminal handler connected
  only to that run. The handler is removed when the run ends.
- Workers send human requests to `@human_endpoint` by default.
  `asys-human-prompt` exports and binds that service. Environment manifests now
  declare `input asys.human.v1.Human human`. Upgrading from 0.1.0 also requires a
  one-time handler restart; see the [upgrade instructions](INSTALL.md#upgrade-to-020).

## 0.1.0

Initial release of asys for running agentic systems as dcomp components on a
Linux host with a local Docker Engine. Requires dcomp 0.3.1; see
[installation](INSTALL.md) for the complete requirements.

- `asys-inference` manages provider components and publishes the selected
  Provider interface as `@inference_endpoint`.
- `asys-runtime` executes typed filesystem jobs. The caller supplies a separate
  job directory and the actual project workspace.
- `asys-workers` provides named agents, programs, and human tasks. Agent
  environments supply memory, skills, tools, and extensions; a shared system
  prompt defines behavior and the final JSON result contract.
- `asys-oneshot` runs one environment agent against a workspace.
- `asys-bpmn` executes workflows in a selected environment, including branching,
  parallel work, human decisions, and error handling. Resuming a failed stage
  creates a new job while preserving the project workspace and completed work.
- `asys` provides run listings, status, logs, agent transcripts, and a terminal
  monitor shared by the launchers.
- Human requests pass through typed component interfaces and a filesystem host
  channel to `asys-human-prompt`.
- Workflow and worker containers run with the invoking user's UID/GID. New
  starts and resumes use current images; running containers retain their images.
