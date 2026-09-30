# asys-runtime

This is the component-level execution and channel contract. Its internal
`--root` selects a runtime queue or channel directory. Public asys host tools
instead use `--root` for the parent state directory containing runs, inference
and Human records; use `asys-run` for normal worker and workflow execution.

A filesystem job queue whose job types select programs and arguments. Producers
publish work, runtimes claim jobs for their configured types, and programs return
results. Multiple runtimes can share a queue.

Requires Python 3.10+ and a local POSIX filesystem with `flock`, atomic rename,
and directory `fsync`. Programs execute in process groups. The runtime can run
inside a container and inherits its environment, mounts, and installed programs.

## Run

From this directory, start the example runtime:

```sh
tools/asys-runtime run examples/runtime.json --root /tmp/asys-jobs
```

In another terminal:

```sh
mkdir -p /tmp/asys-job-records/first /tmp/asys-workspaces/project
tools/asys-runtime submit echo first --directory /tmp/asys-job-records/first \
  --workspace /tmp/asys-workspaces/project --input examples/input.json \
  --root /tmp/asys-jobs hello "two words"
tools/asys-runtime wait first --root /tmp/asys-jobs
tools/asys-runtime show first --root /tmp/asys-jobs
```

[asys-workers](../asys-workers) provides programs using the Pi coding-agent SDK
and human-task interface. They can be registered as job types in the same way.

`run` stays in the foreground. SIGINT or SIGTERM stops its active program groups
and records their jobs as interrupted. A small job runner watches a pipe
from the runtime, so killing the runtime with SIGKILL also stops those programs.
`--once` processes available matching jobs and exits when its own jobs finish.
The runtime starts matching jobs dynamically, with no fixed concurrency limit.
Waiting jobs do not prevent newly submitted work from starting.

No installation is required for `tools/asys-runtime`. For an isolated installation:

```sh
python3 -m venv .venv
.venv/bin/pip install .
.venv/bin/asys-runtime --help
```

## Channels

A channel is a pair of ordered event streams between a component and the host,
kept under `ROOT/channels/NAME/in` and `ROOT/channels/NAME/out`. Directions are
named from the component's side: it writes `out` and reads `in`. Each event is
one file named by its sequence number, holding `type`, `time`, and `data`. It
is published with an atomic link after being written and synced, so a reader
never sees a partial event. Seeing event N proves every earlier event was
published (some may since have been pruned). Several writers may share a
direction; each event still has one number and each writer's own events stay
in order.

Readers keep a cursor in the direction directory and advance it themselves.
`follow` polls for new events and never advances the cursor. `prune` removes
acknowledged events but always keeps the latest one, which carries the
high-water mark that writers continue from. Publication and pruning hold a
short per-direction transaction lock in `.write-lock.sqlite`, using SQLite
from the Python and Node standard libraries. The OS releases the lock if its
holder dies; the file must remain in place. Events and cursors stay in JSON.
Channels run no programs; a request that needs an answer is two events, one
each way, correlated by whatever the two ends agree on.

New direction directories are private (`0700`). Files inherit the directory's
read/write permission bits, so a caller can explicitly prepare shared
directions for processes with different user IDs. The workflow launcher puts
those shared directions inside a private run directory. Each direction has
one acknowledgement cursor; additional observers can read from an explicit
sequence without advancing it.

```sh
tools/asys-runtime send demo out started --root /tmp/asys-root --data input.json
tools/asys-runtime events demo out --root /tmp/asys-root --follow --ack
```

`asys_runtime.channel` provides `Writer` and `Reader` in Python;
`javascript/channel.mjs` provides the same in JavaScript, and the two
interoperate on one directory. The JavaScript API requires Node 22.19+.

## Named environments

An environment is a definition directory containing `workers.json`, its programs,
and (for a container deployment) its Dockerfile and component declaration.
The [worker environments](../asys-workers/env) provide concrete examples.

`workers.json` uses the job-type format below, with environment fields:
`name` is required, `description` is optional text, and `egress` is an optional
boolean, defaulting to false. `asys-run` uses `egress` to configure the
worker container's outbound network access. The runtime itself inherits the
network of the process or container in which it runs. Names use the same syntax
as job types. Executable paths containing `/` resolve against the definition
directory. Programs receive `ASYS_ENVIRONMENT` and `ASYS_ENVIRONMENT_DIR`, in
addition to the ordinary job variables.

```sh
tools/asys-runtime describe /path/to/env/my-environment
tools/asys-runtime run /path/to/env/my-environment --root /path/to/runtime-state
tools/asys-runtime environments --root /path/to/runtime-state
tools/asys-runtime submit program build --environment my-environment --root /path/to/runtime-state \
  --directory /path/to/prepared/job --workspace /path/to/prepared/workspace -- make all
```

Running a directory registers its name and declared types, then executes jobs in
that environment's namespace. Queue commands accept `--environment NAME` to use
that namespace. Passing a configuration file to `run` uses the standalone queue
behaviour shown above and does not register an environment.

The definition and runtime state are separate:

```text
env/my-environment/workers.json          editable source configuration
runtime-state/environments/my-environment/
  environment.json                      derived name, types, and definition digest
  environment.lease                     live definition ownership
  jobs/                                 requests, ownership, execution status
```

The published descriptor contains no commands or environment-variable values.
It remains present when workers stop: it describes supported types, not worker
liveness or proof that a task will work. Identical executor definitions can share
an environment name; different definitions cannot use that name concurrently.
After its executors stop, a changed definition can register the name again.

## Job types

```json
{
  "version": 1,
  "types": {
    "review": {
      "command": ["/opt/workers/review", "--model", "provider/model"],
      "env": {"REVIEW_STYLE": "concise"},
      "timeout": 600
    }
  }
}
```

`command` is an argument array. The runtime appends the job's arguments and
executes that array directly. Use `sh -c` explicitly when shell interpretation is
wanted. Relative executable paths containing `/` resolve against the configuration
directory. Other executable names are resolved through `PATH`. Arguments remain
literal strings.

`env` adds environment variables. `timeout` optionally limits the job's elapsed
seconds. A job executes once. An interrupted or failed job remains terminal;
the caller decides whether to submit a new job with the same assignment.

The configuration is read at startup. Unhandled job types stay pending for a
runtime that handles them.

## Execution contract

The caller prepares two directories before submission: a job area for execution
records and scratch work, and the workspace containing the material to work on.
The runtime does not create or populate the workspace. These are required
arguments to `Queue.submit` (`directory` and `workspace`) and to the CLI
(`--directory` and `--workspace`).

The API accepts filesystem paths and stores them relative to the queue root in
`request.json`. Both parties must see the same relative mount layout. This also
keeps saved records readable from the host. A host launcher may keep a workspace
symlink beside its state roots and bind its target at the matching container
location. Submission preserves that reference instead of resolving it away. Job storage
must be unique to the job; callers own any sharing or serialization of workspaces.
Directories must already exist and be writable by the executing process.

Each job starts in the supplied workspace. JSON input is supplied on stdin;
absent/null input gives empty stdin. Programs receive:

| Variable | Value |
| --- | --- |
| `ASYS_JOB_ID`, `ASYS_JOB_TYPE` | Job identity and type |
| `ASYS_JOB_DIR` | Supplied job directory, resolved to an absolute path |
| `ASYS_REQUEST` | Immutable queue request file |
| `ASYS_WORKSPACE` | Actual project working directory |
| `ASYS_INPUT` | JSON input file in the job directory |
| `ASYS_RESULT` | Optional JSON result file to write before exiting |

Exit code zero completes a job. An absent result file means a null result.
Nonzero exit, invalid JSON output, or timeout fails it. Standard output and error
are captured separately. A human-task program waits for an answer and uses the
same completion contract.

A failing program can still write a result to `ASYS_RESULT`. The runtime retains
it in the job's state. A nonempty `exception` string becomes the diagnostic.
The exit code remains authoritative for ordinary programs. `asys-agent` maps
its final JSON exception to a failing exit code.

Completion atomically records the result in `state.json`. Consumers read that
record, rather than a result file while its program may still be writing. JSON
files are limited to 8 MiB. Project files belong to the workspace. The runtime
imposes no input/output directory convention and does not copy artifacts.

## Queue and lifecycle

```text
QUEUE/jobs/<id>/
  request.json              immutable assignment and storage references
  state.json                execution status and terminal result
  lease                     advisory ownership lock
  cancel.json               cancellation request

SUPPLIED_JOB_DIRECTORY/
  input.json                serialized task input
  stdout.log
  stderr.log
  result.json               optional program result
  ...                       program-owned reports, scratch and records

SUPPLIED_WORKSPACE/          actual project, managed by the caller
```

A job moves from `pending` to `running`, then to `done`, `failed`, `cancelled`,
or `interrupted`. Submitting an existing ID with an identical request is
idempotent and never reexecutes the job. Different input under that ID is rejected.
A fresh execution requires a new job ID and a new job directory. The caller
can reuse the actual workspace and log the relationship between the two jobs.

```sh
tools/asys-runtime list --root /tmp/asys-jobs
tools/asys-runtime cancel first --root /tmp/asys-jobs
```

After a runtime restart, jobs with live ownership locks keep running. A `running`
job whose lock has been released without an outcome becomes `interrupted`.
The executor never starts it again. Pending jobs can still be claimed.

Runtime options can appear around positional arguments. For `submit`, after
`TYPE ID`, unrecognized arguments belong to the program. `--` protects program
arguments that match runtime options.

## Embedding and filesystem producers

```python
from pathlib import Path
from asys_runtime import Queue

job, workspace = Path("/tmp/asys-job-records/review"), Path("/tmp/asys-workspaces/project")
job.mkdir(parents=True, exist_ok=True)
workspace.mkdir(parents=True, exist_ok=True)
queue = Queue("/tmp/asys-jobs")
queue.submit("review", "review-1", directory=job, workspace=workspace,
             args=["--strict"], input={"subject": "change"})
result = queue.wait("review-1", timeout=60)
```

Other languages can publish the same files. Build a hidden directory under
`jobs/`, write and sync `request.json` and the initial `state.json`,
then atomically rename it to the final job ID and
sync `jobs/`. The runtime ignores hidden staging directories. IDs and types use
1–128 ASCII letters, numbers, dots, underscores, or hyphens, starting with a
letter or number. Use the Python API or CLI for cancellation.

Request shape:

```json
{
  "version": 1, "id": "review-1", "type": "review",
  "directory": "../asys-job-records/review", "workspace": "../asys-workspaces/project",
  "args": [], "input": {}, "metadata": {}
}
```

Initial state shape:

```json
{"version":1,"id":"review-1","type":"review","status":"pending","submitted_at":"2026-09-13T12:00:00+00:00","updated_at":"2026-09-13T12:00:00+00:00"}
```

Test with `python3 -m unittest discover -s test -v`. The suite executes real
programs and covers concurrent consumers, arguments, results, process-tree
cancellation, runtime death, separate job records, and caller-controlled resubmission.
