"""Attach a terminal to the shared Human service, or own a private service."""
import argparse
import fcntl
import getpass
import json
import os
from pathlib import Path
import re
import signal
import sys
import tempfile
import time
import uuid

from asys.lifecycle import ComponentHost, LaunchError, Interrupted
from asys.state import state_root
from asys.options import ROOT_HELP, dcomp_options
from asys.human_service import SharedHumanService, ensure_human
from asys_runtime.files import write_json
from asys_runtime.permissions import mkdir, shared, open_file
from asys_runtime.channel import Reader, Writer, direction_root

from .channel import Channel, RPCError
from .forms import FormError
from .presentation import request_document
from .prompt import FormPrompt, Quit, Skip, TextInput, text

SERVICE = "asys.human.v1.Human"
NAME = re.compile(r"[a-z][a-z0-9-]{0,62}")


class UpdateRequested(Exception):
    def __init__(self, event):
        self.event = event


def arguments(argv):
    parser = argparse.ArgumentParser(prog="asys-human-prompt", description="Answer worker human requests, one at a time.", allow_abbrev=False)
    parser.add_argument("--private", action="store_true", help="export only COMPONENT.human, without binding @human_endpoint")
    parser.add_argument("--name", help="dcomp component name; with --private, also reconnect to a retained service")
    parser.add_argument("--claimant", default=getpass.getuser(), help="human identity for candidate checks (default: login name)")
    parser.add_argument("--root", type=Path, default=state_root(),
                        metavar="DIRECTORY", help=ROOT_HELP)
    dcomp_options(parser)
    parser.add_argument("--once", action="store_true", help="exit after completing one answer")
    display = parser.add_mutually_exclusive_group()
    display.add_argument("--plain", action="store_true", help="use line prompts (automatic when input or output is redirected)")
    display.add_argument("--tui", action="store_true", help="force the full-screen terminal interface")
    args = parser.parse_intermixed_args(argv)
    if not args.claimant.strip() or len(args.claimant) > 256:
        parser.error("--claimant must be nonempty text of at most 256 characters")
    if args.name and not NAME.fullmatch(args.name):
        parser.error("--name must be a dcomp component name")
    return args


class Launcher(ComponentHost):
    def __init__(self, args, interaction=None):
        super().__init__(args)
        self.interaction = interaction
        self.active = None
        self.channel = None
        self.topology = {}
        self.next_discovery = 0
        self.control = None
        self.lease = None
        self.persistent = False

    def say(self, message):
        if self.interaction:
            self.interaction.say(message)
        else:
            print(text(message), file=sys.stderr, flush=True)

    def check_interrupt(self):
        super().check_interrupt()
        if self.interaction and self.interaction.stopping.is_set():
            raise Quit()

    def view(self):
        value = self.document("view", "--json", self.args.system)
        self.topology = value
        return value

    def save(self):
        value = {"version": 1, "system": self.args.system, "component": self.name, "dcomp": self.dcomp,
                 "claimant": self.args.claimant, "endpoint": f"{self.name}.human", "active": self.active,
                 "component_removed": not self.owned and not self.persistent,
                 "persistent": self.persistent, "global": None if self.args.private else "human_endpoint",
                 "image_ref": getattr(self, 'image_ref', None), "image": getattr(self, 'image', None)}
        path = self.directory / "session.json"
        write_json(path, value)

    def setup(self):
        if not self.args.private:
            self.setup_shared()
            return
        if self.args.name:
            component = self.existing_private_component()
            if component is not None:
                self.setup_attached(component)
                return
        root = state_root('human', root=self.args.root).resolve()
        if "," in str(root):
            raise LaunchError("The state path cannot contain a comma (dcomp mount syntax)")
        mkdir(root, parents=True, exist_ok=True)
        session = uuid.uuid4().hex
        self.name = self.args.name or "human-interface-" + session[:16]
        self.directory = root / session
        mkdir(self.directory)
        self.lease = os.fdopen(open_file(self.directory / 'handler.lock', os.O_CREAT | os.O_RDWR), 'a+b')
        fcntl.flock(self.lease, fcntl.LOCK_EX)
        self.control = Reader(direction_root(self.directory, 'control', 'in'))
        self.control_output = Writer(direction_root(self.directory, 'control', 'out'))
        self.runtime = self.directory / "runtime"
        self.definition = self.directory / "component"
        mkdir(self.definition)
        for path in [self.runtime, self.runtime / "channels", self.runtime / "channels/human",
                     self.runtime / "channels/human/in", self.runtime / "channels/human/out"]:
            mkdir(path)
        self.channel = Channel(self.runtime, self.args.claimant, self.say)
        self.save()
        self.say(f"Human handler state: {self.directory}")
        document = self.view()
        if document.get("operation"):
            raise LaunchError(f"dcomp system {self.args.system} has a pending operation")
        self.image_ref = os.environ.get("ASYS_HUMAN_INTERFACE_IMAGE") or "asys-human-interface:dev"
        try:
            self.image = self.command(["docker", "image", "inspect", "--format", "{{.Id}}", self.image_ref]).strip()
        except LaunchError as error:
            raise LaunchError(f"Build the human component with make -C asys-human-interface build.\n{error}") from error
        if any(c["name"] == self.name for c in document["components"]):
            raise LaunchError(f"Component {self.name} already exists")
        self.attach()
        self.say(f'Human endpoint: {self.name}.human. Ctrl-C to stop.')
        self.next_discovery = time.monotonic() + 2
        self.attached()

    @staticmethod
    def component_runtime(component):
        runtime = next((Path(bind['source']) for bind in component.get('binds', [])
                        if bind['target'] == '/var/lib/asys-human'), None)
        if runtime is None:
            raise LaunchError('Human component has no host channel mounted for the terminal')
        return runtime.expanduser().resolve(strict=True)

    def validate_private_session(self, component, saved):
        expected = {'version': 1, 'system': self.args.system, 'component': component['name'],
                    'endpoint': component['name'] + '.human', 'dcomp': self.dcomp, 'global': None, 'persistent': True}
        if (not isinstance(saved, dict) or any(saved.get(key) != value for key, value in expected.items())
                or saved.get('component_removed') is not False):
            raise LaunchError('Private Human session does not match the selected component, system and dcomp installation')

    def existing_private_component(self):
        # Resolve the live component before trusting or writing its saved session.
        with tempfile.TemporaryDirectory(prefix='asys-human-attach-') as temporary:
            self.directory = Path(temporary)
            try:
                document = self.view()
            finally:
                self.directory = None
        if document.get('operation'):
            raise LaunchError(f'dcomp system {self.args.system} has a pending operation')
        return next((item for item in document['components'] if item['name'] == self.args.name), None)

    def setup_attached(self, component):
        self.check_components({component['name']: component}, [component['name']])
        if (component['status'].get('status') != 'running'
                or component['status'].get('health') not in {'healthy', 'none'}):
            raise LaunchError('Private Human component is not ready for attachment')
        if not any(item.get('name') == 'human' and item.get('service') == SERVICE
                   for item in component.get('outputs', [])):
            raise LaunchError('Selected component does not export the Human service')
        runtime = self.component_runtime(component)
        self.validate_private_session(component, json.loads((runtime.parent / 'session.json').read_text()))
        self.attach_terminal(component, runtime, private=True)

    def setup_shared(self):
        component = ensure_human(self, name=self.args.name)
        if self.args.name and component['name'] != self.args.name:
            raise LaunchError(f"@human_endpoint is already provided by {component['name']}; use --private for a separate service")
        self.attach_terminal(component, self.component_runtime(component))

    def attach_terminal(self, component, runtime, *, private=False):
        directory = runtime.parent
        lease = os.fdopen(open_file(directory / 'handler.lock', os.O_CREAT | os.O_RDWR), 'a+b')
        try:
            fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lease.close()
            raise LaunchError(f"A terminal is already attached to {component['name']}.human") from None
        try:
            previous = directory / 'session.json'
            saved = json.loads(previous.read_text()) if previous.is_file() else {}
            if private:
                self.validate_private_session(component, saved)
        except BaseException:
            lease.close()
            raise
        self.lease = lease
        self.directory, self.runtime = directory, runtime
        self.name = component['name']
        self.args.private = private
        self.persistent = True
        self.channel = Channel(runtime, self.args.claimant, self.say)
        self.control = Reader(direction_root(directory, 'control', 'in'))
        self.control_output = Writer(direction_root(directory, 'control', 'out'))
        state = directory / 'service.json'
        service = json.loads(state.read_text()) if state.is_file() else {}
        self.image_ref = saved.get('image_ref') or service.get('image_ref', 'asys-human-interface:dev')
        self.image = component['image_id']
        self.active = saved.get('active')
        if self.active:
            self.active.setdefault('claimant', saved['claimant'])
        # The former handler may have exited after persisting detach but before
        # acknowledging it. Retain its claim until release below, and do not
        # apply its detach request to this new terminal.
        self.pending_detach()
        if self.active:
            try:
                self.release(cleanup=True)
            except RPCError as error:
                if error.code not in {'FailedPrecondition', 'NotFound'}:
                    raise
                self.active = None
        self.channel.pump()
        self.channel.discover(lambda: self.tick(cleanup=True))
        self.save()
        self.view()
        self.say(f'Human handler state: {directory}')
        endpoint = f'{self.name}.human' if private else '@human_endpoint'
        self.say(f'Human endpoint: {endpoint}. Ctrl-C to detach; the service keeps running.')
        self.next_discovery = time.monotonic() + 2
        self.attached()

    def attached(self):
        self.control_output.send('attached', {'component': self.name, 'pid': os.getpid(),
                                             'attachment': os.environ.get('ASYS_HUMAN_ATTACHMENT')})

    def detach(self, event):
        # Persist retention before advancing the control cursor: SIGTERM can
        # interrupt the terminal between any two of these operations.
        self.persistent = True
        self.owned = []
        self.save()
        self.control_output.send('detached', {'request': event['sequence'], 'component': self.name})
        self.control.advance(event['sequence'])

    def pending_detach(self):
        if self.control:
            for event in self.control.read():
                if event['type'] == 'detach':
                    self.detach(event)

    def update_component(self, event):
        try:
            image = self.command(['docker', 'image', 'inspect', '--format', '{{.Id}}', event['data']['image']]).strip()
            document = self.view()
            if self.args.private or not any(g['name'] == 'human_endpoint' and g.get('target', {}).get('component') == self.name
                                            for g in document.get('globals', [])):
                raise LaunchError('This handler no longer owns @human_endpoint')
            self.say('Updating the Human service; outstanding requests will be interrupted.')
            service = SharedHumanService(self.args, directory=self.directory, dcomp=self.dcomp)
            service.say = self.say
            service.interrupted = self.interrupted
            service.ensure(refresh=True)
            self.active = None
            self.channel.current = None
            self.channel.queue.clear()
            if self.interaction:
                self.interaction.finished('Human service updated; interrupted jobs may be retried.')
            self.image = image
            self.channel.pump()
            self.save()
            self.control_output.send('updated', {'request': event['sequence'], 'image': image})
        except Exception as error:
            self.control_output.send('error', {'request': event['sequence'], 'message': str(error)})
            raise

    def attach(self):
        self.check_interrupt()
        (self.definition / "component.dcomp").write_text(f"docker {self.image}\noutput {SERVICE} human\n")
        gid = self.directory.stat().st_gid if shared(self.directory) else os.getgid()
        options = ["--user", f"{os.getuid()}:{gid}", "--bind", f"{self.runtime},/var/lib/asys-human,rw"]
        self.channel.pump()
        before = self.channel.ready
        self.owned = [self.name]  # Record intent before the lifecycle operation.
        self.save()
        self.command(self.dcomp + ["add-component", *options, self.args.system, self.name, str(self.definition)])
        deadline = time.monotonic() + 90
        next_check = 0
        while self.channel.ready <= before:
            self.check_interrupt()
            self.channel.pump()
            if time.monotonic() >= deadline:
                raise LaunchError("Timed out waiting for the human component's host channel")
            if time.monotonic() >= next_check:
                document = self.view()
                if not document.get("operation"):
                    self.check_component(document)
                next_check = time.monotonic() + 1
            self.interrupted.wait(0.1)

    def check_component(self, document):
        component = next((item for item in document["components"] if item["name"] == self.name), None)
        self.check_components({self.name: component}, [self.name])

    def tick(self, cleanup=False):
        if not cleanup:
            self.check_interrupt()
        self.channel.pump()
        if not cleanup and self.control:
            for event in self.control.read():
                if event['type'] == 'detach':
                    self.detach(event)
                    raise Quit()
                self.control.advance(event['sequence'])
                if event['type'] == 'update' and event['data'].get('image') != self.image:
                    raise UpdateRequested(event)
                self.control_output.send('updated', {'request': event['sequence'], 'image': self.image})
        if self.interaction:
            self.interaction.state({worker for worker, _ in self.channel.queue} | ({self.active["worker"]} if self.active else set()), len(self.channel.queue))
        if cleanup or time.monotonic() < self.next_discovery:
            return
        self.next_discovery = time.monotonic() + 2
        document = self.view()
        if document.get("operation"):
            return  # Another host tool is completing a lifecycle transaction.
        self.check_component(document)

    def call(self, method, body, cleanup=False):
        return self.channel.call(self.active["worker"], method, body, lambda: self.tick(cleanup), timeout=5 if cleanup else 30)

    def release(self, cleanup=False):
        if self.active is None:
            return
        active = self.active
        # A signal can arrive after the service commits a claim but before the
        # host receives its token. Repeat that exact claim to recover the token.
        if "token" not in active:
            claimed = self.call("ClaimTask", {"id": active["id"], "claimant": active.get('claimant', self.args.claimant), "claimId": active["claimId"]}, cleanup)
            active["token"] = claimed["token"]
        self.call("ReleaseTask", {"id": active["id"], "token": active["token"]}, cleanup)
        self.active = None
        self.channel.current = None
        self.save()

    def execute(self):
        stdin = None if self.interaction else TextInput()
        while True:
            self.tick()
            if not self.channel.queue:
                if stdin:
                    stdin.idle()
                self.interrupted.wait(0.1)
                continue
            key, _ = self.channel.queue.popitem(last=False)
            self.channel.current = key
            worker, task_id = key
            # Recheck queued hints: cancellation, completion and other claimants
            # may have changed the task while the preceding question was open.
            try:
                task = self.channel.call(worker, "GetTask", {"id": task_id}, self.tick)["task"]
            except RPCError as error:
                if error.code != "NotFound":
                    raise
                self.channel.current = None
                continue
            if task["status"] != "pending":
                self.channel.current = None
                continue
            self.active = {"worker": worker, "id": task_id, "claimId": uuid.uuid4().hex, 'claimant': self.args.claimant}
            self.save()
            try:
                claim = self.call("ClaimTask", {"id": task_id, "claimant": self.args.claimant, "claimId": self.active["claimId"]})
            except RPCError as error:
                if error.code not in {"AlreadyExists", "PermissionDenied", "FailedPrecondition", "NotFound"}:
                    raise
                self.say(f"Skipping {worker} / {task_id}: {error}")
                self.active = None
                self.channel.current = None
                self.save()
                continue
            self.active["token"] = claim["token"]
            self.save()
            completed = False
            try:
                self.view()  # Resolve this worker's current workspace mount.
                document = request_document(worker, claim["task"], self.topology)
                temporary = self.directory / "request.tmp"
                temporary.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n")
                temporary.replace(self.directory / "request.json")
                form = self.interaction.form(document) if self.interaction else FormPrompt(document)
                while True:
                    answer = form.read(self.tick if self.interaction else lambda: stdin.read(self.tick))
                    completion = {"id": task_id, "token": self.active["token"], "completionId": uuid.uuid4().hex,
                                  "resultJson": json.dumps(answer, ensure_ascii=False, allow_nan=False)}
                    self.active["completion"] = completion
                    self.save()
                    try:
                        self.call("CompleteTask", completion)
                    except RPCError as error:
                        self.say(f"Answer rejected: {error}")
                        if error.code == "InvalidArgument":
                            if self.interaction:
                                self.interaction.rejected(str(error))
                            continue
                        if error.code in {"FailedPrecondition", "NotFound", "PermissionDenied", "AlreadyExists"}:
                            self.active = None
                            self.channel.current = None
                            self.save()
                            if self.interaction:
                                self.interaction.finished("This request is no longer available.")
                            break
                        raise
                    completed = True
                    self.say("Answer recorded.")
                    break
            except Skip:
                self.channel.skipped.add(key)
                self.release()
                if self.interaction:
                    self.interaction.finished("Request skipped. It remains pending.")
            except FormError as error:
                self.say(f"Cannot render this form: {error} Leaving it pending.")
                self.channel.skipped.add(key)
                self.release()
            if completed:
                self.active = None
                self.channel.current = None
                self.channel.queue.pop(key, None)
                self.save()
                if self.interaction:
                    self.interaction.finished("Answer recorded.")
                if self.args.once:
                    return

    def close(self):
        if self.directory is None:
            return True
        # Honor a durable detach request even when a signal prevented tick()
        # from observing it before shutdown.
        self.pending_detach()
        clean = True
        if self.active and (self.owned or self.persistent):
            try:
                self.release(cleanup=True)
            except RPCError as error:
                if error.code not in {"FailedPrecondition", "NotFound"}:
                    self.say(f"Could not release the current claim: {error}; details are saved in {self.directory / 'session.json'}")
                    clean = False
            except Exception as error:
                self.say(f"Could not release the current claim: {error}")
                clean = False
        clean = self.cleanup_components("component.log") and clean
        self.save()
        if self.lease:
            self.lease.close()
        return clean


def run_handler(launcher):
    code = 0
    try:
        launcher.setup()
        while True:
            try:
                launcher.execute()
                break
            except UpdateRequested as request:
                launcher.update_component(request.event)
    except Interrupted:
        code = 130
    except (Quit, EOFError):
        pass
    except (LaunchError, RPCError, OSError, ValueError, KeyError) as error:
        launcher.say(f"error: {error}")
        code = 1
    finally:
        if not launcher.close() and code == 0:
            code = 1
    return code


def main(argv=None):
    args = arguments(sys.argv[1:] if argv is None else argv)
    fullscreen = args.tui or not args.plain and sys.stdin.isatty() and sys.stdout.isatty() and os.environ.get("TERM") != "dumb"
    interaction = None
    if fullscreen:
        try:
            from .interaction import Interaction
            from .tui import HumanApp
        except ImportError as error:
            print(f"The terminal UI is not installed: {error}. Run make -C asys-human-interface install-host.", file=sys.stderr)
            return 1
        interaction = Interaction()
    launcher = Launcher(args, interaction)
    def interrupt(*_):
        launcher.interrupted.set()
    previous = {sig: signal.signal(sig, interrupt) for sig in [signal.SIGINT, signal.SIGTERM]}
    try:
        if not fullscreen:
            return run_handler(launcher)
        app = HumanApp(interaction, lambda: run_handler(launcher), claimant=args.claimant, system=args.system)
        try:
            code = app.run() or 0
            for error in interaction.errors:
                print(text(error), file=sys.stderr)
            if interaction.errors and launcher.directory:
                print(f"Handler state: {launcher.directory}", file=sys.stderr)
            return code
        finally:
            interaction.stopping.set()
            if app.backend:
                app.backend.join()
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
