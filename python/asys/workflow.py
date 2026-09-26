"""BPMN execution behind the shared asys-run command."""
import fcntl
import json
import os
from pathlib import Path
import shlex
import signal
import sys
import time

from asys_runtime.channel import Reader, Writer, direction_root
from asys_runtime.environment import Environment
from asys_runtime.permissions import mkdir, shared
from asys_runtime.files import read_json, timestamp, write_json
from .state import state_root
from .lifecycle import LaunchError, Interrupted, RecoveryRequired
from .execution import EnvironmentHost, execution_options, prepare_run
from .human import HumanHandler
from .workflow_runs import Runs, component_names, workflow_name
from .workflow_journal import WorkflowHistory, agent_notices

SERVICE = "asys.workflow.v1.Workflow"
CHANNEL = "workflow"
TERMINAL = {"completed", "failed", "cancelled", "recovery-required"}


def read_object(path):
    value = read_json(path)
    if not isinstance(value, dict):
        raise ValueError(f"{path}: expected a JSON object")
    return value


class Launcher(EnvironmentHost):
    REATTACH_TIMEOUT = 10

    def __init__(self, args):
        super().__init__(args)
        self.active = False
        self.reattaching = False
        self.request = None
        self.outbound = None
        self.record = {}
        self.lease = None
        self.save_record = args.command != "resume"
        self.human = None
        self.console_errors = []
        self.reattach_result = None

    def say(self, message):
        if self.directory is not None:
            try:
                with (self.directory / "run.log").open("a", encoding="utf-8") as log:
                    print(message, file=log)
            except OSError as error:
                print(f"Could not save run log: {error}", file=sys.stderr)
        if self.human is None or self.human.process is None or self.human.process.poll() is not None:
            print(message, file=sys.stderr, flush=True)
        elif message.startswith('error:'):
            self.console_errors.append(message)

    def snapshot(self):
        if not self.save_record:
            return
        self.record["updated_at"] = timestamp()
        if self.record.get("status") in TERMINAL:
            self.record.setdefault("finished_at", self.record["updated_at"])
        write_json(self.directory / "run.json", self.record)

    def setup(self):
        if self.args.command == "resume":
            return self.setup_resume()
        args = self.args
        workflow = args.workflow.expanduser().resolve(strict=True)
        environment = args.environment.expanduser().resolve(strict=True)
        if not workflow.is_file() or not environment.is_dir():
            raise LaunchError("Expected a BPMN file and an environment directory")
        self.xml = workflow.read_text()
        display_name = workflow_name(self.xml, workflow, args.name)
        if args.input == "-":
            if args.human:
                raise LaunchError('Use --input FILE with --human; the terminal is needed for human answers')
            self.say("Reading workflow request from stdin")
        self.variables = {} if args.request is None else {"request": args.request}
        if args.input:
            self.variables["request"] = (sys.stdin.read() if args.input == "-"
                                         else Path(args.input).expanduser().read_text(encoding="utf-8"))
        self.id, self.directory, workspace = prepare_run(state_root('runs', root=args.root), args.workspace)
        self.lease = (self.directory / "launcher.lock").open("xb")
        fcntl.flock(self.lease, fcntl.LOCK_EX)
        for child in ("workflow", "engine"):
            mkdir(self.directory / child)
        (self.directory / 'workflow/workflow.bpmn').write_text(self.xml)
        self.names = component_names(display_name, self.id)
        # The host and the workflow component talk over a runtime channel in
        # the shared runtime root: no published port, no token.
        self.channel = self.directory / "runtime" / "channels" / CHANNEL
        # Dcomp starts both components with the host user's UID/GID.
        for path in [self.channel.parent, self.channel, self.channel / "in", self.channel / "out"]:
            mkdir(path)
        self.record = {"id": self.id, "manager": "run", "kind": "workflow", "name": display_name, "created_at": timestamp(), "workflow": str(workflow), "environment_directory": str(environment),
                       "workspace": str(workspace), "system": args.system, "components": self.names,
                       "dcomp": self.dcomp, "status": "starting", "channel": str(self.channel)}
        self.snapshot()
        self.say(f"Run {self.id}\nState: {self.directory}")
        self.prepare_environment(environment, args.link, human_target=self.human_target())
        engine_id = self.engine_image()
        (self.directory / "engine/component.dcomp").write_text(f"docker {engine_id}\noutput {SERVICE} workflow\n")
        self.snapshot()
        self.start_components()

    def engine_image(self):
        image = os.environ.get("ASYS_BPMN_IMAGE") or "asys-bpmn:dev"
        try:
            return self.command(["docker", "image", "inspect", "--format", "{{.Id}}", image]).strip()
        except LaunchError as error:
            raise LaunchError(f"Workflow image {image} is unavailable. Build the asys images with make -C asys-bpmn build.\n{error}") from error

    def setup_resume(self):
        directory = Runs(state_root('runs', root=self.args.root)).select(self.args.run)
        if shared(directory):
            os.umask(0o007)
        lease = (directory / "launcher.lock").open("a+b")
        try:
            fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lease.close()
            raise LaunchError("This run already has an active launcher") from None
        self.lease = lease
        record = read_object(directory / "run.json")
        if record.get("status") not in {"failed", "recovery-required"}:
            raise LaunchError(f"Cannot resume a {record.get('status', 'unknown')} run; select a failed or recovery-required run")
        if not (directory / "workflow/workflow.sqlite").is_file():
            raise LaunchError("This run has no saved BPMN execution state")
        if not (directory / "environment/component.dcomp").is_file():
            raise LaunchError("This run has no saved environment image")
        self.directory, self.record = directory, record
        self.id, self.names = record["id"], record["components"]
        self.args.system = record["system"]
        self.dcomp = list(record["dcomp"])
        if os.environ.get("DCOMP_BINARY"):
            self.dcomp[0] = os.environ["DCOMP_BINARY"]
        self.channel = directory / "runtime/channels" / CHANNEL
        if not isinstance(record.get("links"), dict):
            raise LaunchError("This run has no saved environment connections")
        existing = self.document("view", "--json", self.args.system)
        if existing.get("operation"):
            raise LaunchError("A dcomp operation is still present; finish it before resuming")
        names = [*(world['name'] for world in record.get('world_components', {}).values()),
                 *(self.names[role] for role in ('human', 'workers', 'engine') if role in self.names)]
        components = {item['name']: item for item in existing['components'] if item['name'] in names}
        if components:
            if set(components) != set(names):
                raise LaunchError("Some previous run components are missing; finish their cleanup before resuming")
            # Adopt only the complete, healthy saved execution, under its
            # launcher lease. Heartbeat alone does not establish that an
            # --await-resume engine has recovered its workflow.
            self.check_components(components, names=names)
            if any(item['status'].get('status') != 'running' or
                   item['status'].get('health') not in {'healthy', 'none'} for item in components.values()):
                raise LaunchError("Previous run components are not ready; finish recovery before reattaching")
            if self.args.human and 'human' not in self.names:
                raise LaunchError('This execution uses the shared Human service; attach with asys-human-prompt')
            self.owned = names
            self.save_record = True
            self.preserve_components = True
            try:
                state = self.reattach_request('status')
                if state['status'] not in {'completed', 'failed', 'cancelled'} and not state['active']:
                    self.record['status'] = 'recovering'
                    self.snapshot()
                    self.say('Recovering the saved workflow in its existing engine; running job IDs are retained')
                    state = self.reattach_request('recover')
                if state['status'] not in {'completed', 'failed', 'cancelled'} and not state['active']:
                    raise LaunchError('Engine has no active workflow after checkpoint recovery')
                self.reattach_result = state.get('result')
            except (LaunchError, OSError, ValueError, KeyError) as error:
                self.require_health_recovery(self.names['engine'],
                    f'Cannot reattach safely: {error}. Restore the engine/status channel, then retry asys-run --resume {self.id}; do not replay a job-replacing resume request')
            if self.args.human:
                self.human = HumanHandler(self, self.names['human'])
                try:
                    self.human.start(attach=True)
                except (LaunchError, OSError, ValueError) as error:
                    self.require_health_recovery(self.names['human'], f'Could not attach the preserved Human handler: {error}')
            elif 'human' in self.names:
                self.say(f"Private Human service retained; attach with asys-human-prompt --private --name {self.names['human']} --root {self.args.root} --system {self.args.system}")
            self.preserve_components = False
            self.reattaching = True
            self.say(f"Reattaching to live run {self.id} without restarting its jobs")
            return
        engine_id = self.engine_image()
        self.say(f"Resuming run {self.id}\nState: {directory}")
        self.refresh_environment()
        (directory / "engine/component.dcomp").write_text(f"docker {engine_id}\noutput {SERVICE} workflow\n")
        self.start_components()

    def reattach_request(self, kind):
        """Probe/recover an existing engine without consuming workflow events."""
        outbound = Reader(direction_root(self.directory / 'runtime', CHANNEL, 'out'))
        after = max(outbound.sequences(), default=0)
        request = Writer(direction_root(self.directory / 'runtime', CHANNEL, 'in')).send(kind, {'id': self.id})
        deadline = time.monotonic() + self.REATTACH_TIMEOUT
        while time.monotonic() < deadline:
            self.check_interrupt()
            for event in outbound.read(after):
                after = event['sequence']
                data = event['data']
                if data.get('request') != request['sequence']:
                    continue
                if event['type'] == 'rejected':
                    raise LaunchError(f"Engine {kind} request rejected: {data.get('message', data)}")
                if event['type'] == 'accepted':
                    if (data.get('runId') != self.id or type(data.get('active')) is not bool
                            or data.get('status') not in {'running', 'waiting', 'resuming', 'completed', 'failed', 'cancelled'}):
                        raise LaunchError(f'Invalid engine {kind} response')
                    if data['status'] in {'completed', 'failed', 'cancelled'}:
                        result = data.get('result')
                        if not isinstance(result, dict) or result.get('runId') != self.id or result.get('status') != data['status']:
                            raise LaunchError(f'Engine {kind} response omitted its terminal result')
                    return data
            self.interrupted.wait(0.05)
        raise LaunchError(f'Engine did not answer {kind} within {self.REATTACH_TIMEOUT}s; heartbeat alone is not execution readiness')

    def refresh_environment(self):
        environment = Path(self.record["environment_directory"]).expanduser().resolve()
        if not environment.is_dir():
            raise LaunchError(f"Cannot refresh environment source: {environment} is unavailable")
        if Environment(environment).name != self.record['environment']:
            raise LaunchError('The saved workflow requires the original environment name')
        links = dict(self.record['links'])
        previous = self.names.pop('human', None)
        target = links.pop('human', None)
        if previous and target == f'{previous}.human':
            target = '@human_endpoint'
        target = self.human_target() or target
        self.prepare_environment(environment, [f"{source}={endpoint}" for source, endpoint in links.items()],
                                 human_target=target)

    def human_target(self):
        if not self.args.human:
            return None
        name = self.names['workers'].replace('-workers-', '-human-')
        self.names['human'] = name
        return f'{name}.human'

    def stop_human(self, *, preserve=False):
        if self.human is None:
            return True
        handler, self.human = self.human, None
        try:
            return handler.close(preserve=True) if preserve else handler.close()
        finally:
            for message in self.console_errors:
                print(message, file=sys.stderr, flush=True)
            self.console_errors.clear()

    def start_components(self):
        if self.args.human:
            self.human = HumanHandler(self, self.names['human'])
            self.human.start()
        self.start_workers()
        self.record['engine_await_resume'] = self.args.command == 'resume'
        self.add("engine", "engine", self.execution_mounts() + [
            "--bind", f"{self.directory / 'workflow'},/var/lib/asys-bpmn,rw",
            "--arg=--host-channel", f"--arg={CHANNEL}",
        ] + (["--arg=--await-resume"] if self.args.command == "resume" else []))
        self.wait_ready()
        self.snapshot()
        self.say(f"Workflow channel: {self.channel}")

    def recover_unhealthy_component(self, name, status):
        if name != self.names.get('engine'):
            return super().recover_unhealthy_component(name, status)
        # Older resumed engines also retain --await-resume on restart. Sending
        # resume again would cancel running jobs and create replacements.
        if self.record.get('engine_await_resume', bool(self.record.get('resumed_at'))):
            self.require_health_recovery(name, 'This engine awaits explicit resume on restart; preserving its running jobs requires operator recovery')
        if not (self.directory / 'workflow/workflow.sqlite').is_file():
            self.require_health_recovery(name, 'No saved workflow checkpoint is available for engine recovery')
        attempts = self.record.setdefault('health_restarts', {})
        if attempts.get(name, 0) >= self.HEALTH_RESTART_LIMIT:
            self.require_health_recovery(name, 'Automatic engine restart limit reached')
        attempts[name] = attempts.get(name, 0) + 1
        self.record['component_health'][name].update(state='restarting', attempt=attempts[name])
        if not self._publish_health():
            self.require_health_recovery(name, 'Could not persist the engine restart budget; automatic restart was not attempted')
        self._record_component_health(name, status, inspect=True, action='restart', attempt=attempts[name])
        self._health_notice(f'Restarting unhealthy workflow engine {name}; running worker jobs remain attached to their existing IDs')
        try:
            self.command(self.dcomp + ['restart', self.args.system, name], timeout=120)
        except Interrupted:
            raise
        except (LaunchError, OSError, ValueError) as error:
            self.require_health_recovery(name, f'Targeted engine restart failed: {error}')
        self._health_restart_deadline[name] = time.monotonic() + self.HEALTH_RESTART_READY

    def events(self, after):
        """Channel events past `after`, and the sequence of the last one."""
        events = self.outbound.read(after)
        return events, (events[-1]["sequence"] if events else after)

    def finish(self, event):
        run = event["data"]
        self.active = False
        self.record["status"] = run["status"]
        self.record["workflow_id"] = run.get("workflowId")
        write_json(self.directory / "result.json", run)
        return run

    def report_result(self, event):
        run = self.finish(event)
        if not self.stop_human():
            raise LaunchError('Human handler cleanup failed')
        if run['status'] != 'completed':
            raise LaunchError(run.get('error') or f"Workflow {run['status']}")
        print(json.dumps(run.get('output', {}), indent=2, ensure_ascii=False))

    def execute(self):
        inbound = Writer(direction_root(self.directory / "runtime", CHANNEL, "in"))
        self.outbound = Reader(direction_root(self.directory / "runtime", CHANNEL, "out"))
        resuming = self.args.command == "resume"
        after = (self.outbound.cursor if self.reattaching else
                 max(self.outbound.sequences(), default=0) if resuming else 0)
        history = WorkflowHistory(self.directory)
        observer = Runs(state_root('runs', root=self.args.root))
        notices = set()
        if resuming:
            history.read(self.record)
            notices = {key for key, _ in agent_notices(observer.progress.events(observer.jobs(self.directory)))}
        if not self.reattaching:
            self.record["channel_after"] = after
        if self.reattaching:
            self.record["reattached_at"] = timestamp()
        elif resuming:
            self.request = inbound.send("resume", {"id": self.id})
            self.record["resumed_at"] = timestamp()
        else:
            self.request = inbound.send("start", {"id": self.id, "bpmnXml": self.xml, "processId": self.args.process,
                                                  "environment": self.record["environment"], "variables": self.variables,
                                                  "environmentDefinition": self.definition})
        self.active = True  # The request is durable even if this process stops.
        self.save_record = True
        self.record["status"] = "running"
        self.record["components_removed"] = False
        self.record.pop("error", None)
        self.record.pop("finished_at", None)
        self.record.pop("component_health", None)
        self.snapshot()
        action = "Monitoring" if self.reattaching else "Resuming" if resuming else "Running"
        self.say(f"{action} {self.record['workflow']} in {self.record['environment']}")

        def agent_progress():
            for key, line in agent_notices(observer.progress.events(observer.jobs(self.directory))):
                if key not in notices:
                    self.say(line)
                    notices.add(key)
        next_health_check = time.monotonic() + 2
        with (self.directory / "events.jsonl").open("a") as events_file:
            while True:
                self.check_interrupt()
                events, after = self.events(after)
                for event in events:
                    data = event["data"]
                    if event["type"] == "rejected" and self.request and data.get("request") == self.request["sequence"]:
                        self.active = False
                        raise LaunchError(f"{self.request['type']}: {data.get('message', data)}")
                    if event["type"] == "accepted" and self.request and data.get("request") == self.request["sequence"]:
                        self.record["workflow_id"] = data["workflowId"]
                        self.snapshot()
                    if "activityId" in data:  # A run event, mirrored in the engine's own numbering.
                        saved = {"sequence": data["store"], "runId": data["runId"], "type": event["type"],
                                 "activityId": data["activityId"], "time": data["time"], "dataJson": json.dumps(data["data"])}
                        events_file.write(json.dumps(saved) + "\n")
                        activity = data["activityId"]
                        observed = self.record
                        failed = None
                        if event["type"] == "job.failed":
                            job_id = data["data"].get("jobId")
                            jobs = Runs(state_root('runs', root=self.args.root)).jobs(self.directory)
                            failed = next((job for job in jobs if job["id"] == job_id), None)
                            observed = {**self.record, "jobs": jobs}
                        progress = history.consume(saved, observed)
                        if progress:
                            self.say(progress)
                        if event["type"] == "job.failed":
                            self.say(f"  Logs: asys logs {shlex.quote(str(self.directory))} {shlex.quote(failed['activity'] if failed else activity)}")
                    if event["type"] == "run.result" and data.get("runId") == self.id:
                        agent_progress()
                        events_file.flush()
                        self.outbound.advance(event["sequence"])
                        self.report_result(event)
                        return
                events_file.flush()
                agent_progress()
                if events:
                    self.outbound.advance(after)
                if self.reattach_result is not None:
                    # A former launcher may already have consumed/pruned the
                    # result event. The fresh status reply carries durable data.
                    self.report_result({'data': self.reattach_result})
                    return
                if time.monotonic() >= next_health_check:
                    if self.human:
                        self.human.check()
                    self.monitor_components()
                    next_health_check = time.monotonic() + 2
                self.interrupted.wait(0.2)

    def close(self):
        if self.directory is None:
            if self.lease:
                self.lease.close()
            return True
        cancelled = self.record.get('status') == 'cancelled' or self.interrupted.is_set()
        # Only an explicit interruption cancels BPMN execution. On component
        # failure, preserve its last checkpoint for resume, even if the engine
        # has not yet observed the worker's failure.
        if self.active and self.outbound is not None and cancelled:
            try:
                Writer(direction_root(self.directory / "runtime", CHANNEL, "in")).send("cancel", {"id": self.id})
                after, deadline = self.outbound.cursor, time.monotonic() + 5
                while time.monotonic() < deadline:
                    events, after = self.events(after)
                    done = next((e for e in events if e["type"] == "run.result" and e["data"].get("runId") == self.id), None)
                    if done:
                        self.outbound.advance(done["sequence"])
                        self.finish(done)
                        break
                    time.sleep(0.1)
                else:
                    self.say("The workflow component did not confirm the cancellation in time")
            except Exception as error:
                self.say(f"Could not cancel through the workflow channel: {error}")
        if self.preserve_components and not cancelled:
            clean = self.stop_human(preserve=True)
            self.record['components_removed'] = False
            saved = self._publish_health()
            if self.lease:
                self.lease.close()
            return clean and saved
        clean = self.stop_human()
        clean = self.cleanup_components() and clean
        self.record["components_removed"] = clean
        self.snapshot()
        if self.lease:
            self.lease.close()
        return clean


def run(args):
    launcher = Launcher(args)
    def interrupt(*_):
        launcher.interrupted.set()
        # Before resources exist, interrupt blocking stdin immediately. During
        # lifecycle edits, let dcomp finish its transaction before cleanup.
        if launcher.directory is None:
            raise Interrupted()
    previous = {sig: signal.signal(sig, interrupt) for sig in [signal.SIGINT, signal.SIGTERM]}
    code = 0
    try:
        launcher.setup()
        launcher.execute()
    except Interrupted:
        launcher.say("Cancelling workflow")
        launcher.record["status"] = "cancelled"
        code = 130
    except (LaunchError, OSError, ValueError, KeyError) as error:
        launcher.say(f"error: {error}")
        launcher.record.update(status="recovery-required" if isinstance(error, RecoveryRequired) else "failed", error=str(error))
        code = 1
    finally:
        try:
            if not launcher.close() and code == 0:
                code = 1
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
    return code
