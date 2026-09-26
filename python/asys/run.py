"""Execute one named worker through the ordinary runtime job contract."""
import argparse
from copy import deepcopy
import fcntl
import json
from pathlib import Path
import re
import sys
import time
import uuid

from asys_runtime.channel import Reader, direction_root
from asys_runtime.environment import Environment, describe, environment_root
from asys_runtime.files import timestamp, validate_name, write_json
from asys_runtime.permissions import mkdir
from asys_runtime.queue import Queue, TERMINAL

from .config import system_model, system_models
from .execution import execution_options, prepare_run
from .lifecycle import LaunchError
from .runs import LogReader
from .single_job import SingleJob, run as run_job
from .state import state_root
from .options import ROOT_HELP
from .worker_definitions import builtin_definition, definition_command, load_definition


def arguments(argv):
    parser = argparse.ArgumentParser(prog='asys-run', allow_abbrev=False,
        description='Run a named worker or a BPMN workflow in the selected environment.',
        usage='%(prog)s ENVIRONMENT WORKER|WORKFLOW.bpmn [REQUEST] [OPTIONS]\n       %(prog)s --resume RUN [--root DIRECTORY] [--human]')
    parser.add_argument('environment', type=Path, nargs='?', metavar='ENVIRONMENT')
    parser.add_argument('worker', nargs='?', metavar='WORKER|WORKFLOW.bpmn')
    parser.add_argument('request', nargs='?', metavar='REQUEST')
    parser.add_argument('--input', metavar='FILE', help='read the Markdown request from a file; - reads stdin')
    parser.add_argument('--resume', metavar='RUN', help='resume a failed or recovery-required workflow using its saved state')
    parser.add_argument('--model', metavar='MODEL', help='override a named worker model for this run')
    parser.add_argument('--parameters', type=Path, metavar='FILE', help='JSON parameters accepted by a named worker')
    parser.add_argument('--name', metavar='NAME', help='name displayed for this run')
    parser.add_argument('--process', default='', metavar='ID', help='select a process in a BPMN document')
    parser.add_argument('--human', action='store_true', help='answer workflow human requests in this terminal')
    parser.add_argument('--root', type=Path, default=state_root(), metavar='DIRECTORY', help=ROOT_HELP)
    execution_options(parser)
    parser.set_defaults(workspace=None, system=None, link=None)
    args = parser.parse_intermixed_args(argv)
    args.workflow = None
    args.command = 'resume' if args.resume else 'run'
    if args.resume:
        if any(value is not None for value in (args.environment,args.worker,args.request,args.input,args.model,args.parameters,args.name)) or args.process:
            parser.error('--resume uses the saved run; do not supply a new environment, worker, request or configuration')
        if any(getattr(args, name) is not None for name in ('workspace','system','link','dcomp_state_root','runtime_root')):
            parser.error('--resume restores the saved workspace, system and connections; only --root and --human can be supplied')
        args.run = args.resume
        return args
    args.workspace = args.workspace or Path.cwd()
    args.system = args.system or 'asys'
    args.link = args.link or []
    if args.environment is None or args.worker is None:
        parser.error('ENVIRONMENT and WORKER or WORKFLOW.bpmn are required')
    if args.input is not None and args.request is not None:
        parser.error('Supply REQUEST or --input FILE, not both')
    if Path(args.worker).suffix.lower() == '.bpmn':
        args.workflow = Path(args.worker)
        args.worker = None
        if args.model is not None or args.parameters is not None:
            parser.error('Workflow models and worker parameters belong in its named worker definitions')
    else:
        try:
            validate_name('worker name', args.worker)
        except ValueError as error:
            parser.error(str(error))
        if args.request is None and args.input is None:
            parser.error('A named worker requires REQUEST or --input FILE')
        if args.human or args.process:
            parser.error('--human and --process apply to workflows')
    if args.request is not None and not args.request.strip():
        parser.error('REQUEST must be nonempty')
    if args.model is not None and not args.model.strip():
        parser.error('--model must be nonempty')
    return args


def selected_definition(environment, name, existing_types=()):
    """Named definitions take precedence; built-ins need no source mutations."""
    path = Path(environment) / 'workers' / f'{name}.json'
    if path.exists() or path.is_symlink():
        return load_definition(environment, name), False
    if name in existing_types:
        return None, False
    try:
        definition = builtin_definition(name)
    except (KeyError, ValueError):
        definition = None
    return definition, definition is not None


def execution_models(root, definition, kind, override=None, command=()):
    if override is not None:
        return {'simple': override}
    config = definition['config'] if definition else {}
    if kind == 'program':
        return {}
    if kind in {'agent', 'goal'}:
        explicit = config.get('model')
        if not definition and '--model' in command:
            index = len(command) - 1 - list(reversed(command)).index('--model')
            if index + 1 < len(command):
                explicit = command[index + 1]
        return {'simple': system_model('simple', explicit, root=root)}
    if kind == 'senate' and all(p.get('model') for p in [config['princeps'], *config['senators']]):
        return {}
    return system_models(root)


class Run(SingleJob):
    manager = 'run'

    def __init__(self, args):
        super().__init__(args)
        self.label = self.job_type = args.worker
        self.definition = None
        self.worker_definition = None
        self.original = None
        self.overlay = None
        self.overlay_target = None
        self.builtin_file = None
        self.progress = None
        self.parameters = None
        self.control_after = 0
        self.outbound = None

    def setup(self):
        environment = self.args.environment.expanduser().resolve(strict=True)
        self.original = Environment(environment)
        self.worker_definition, builtin = selected_definition(environment, self.args.worker, self.original.types)
        if self.worker_definition is None and self.args.worker not in self.original.types:
            raise ValueError(f'Unknown worker {self.args.worker!r}; use asys-workers list ENVIRONMENT')
        executable = Path(self.original.types.get(self.args.worker, {}).get('command', [''])[0]).name
        command_kind = {'asys-agent': 'agent', 'asys-goal': 'goal', 'asys-senate': 'senate',
                       'asys-swarm': 'swarm'}.get(executable, 'program')
        kind = self.worker_definition['kind'] if self.worker_definition else command_kind
        if self.worker_definition is None and kind in {'senate', 'swarm'}:
            raise ValueError(f'{kind} requires a named worker definition; use asys-workers add ENVIRONMENT {kind} NAME')
        if self.args.model and kind == 'program':
            raise ValueError('--model requires an agent, goal, senate, or swarm definition')
        if self.args.parameters:
            with self.args.parameters.expanduser().open(encoding='utf-8') as source:
                self.parameters = json.load(source)
            if not isinstance(self.parameters, dict):
                raise ValueError('Worker parameters must be a JSON object')
        # Read settings before provisioning so malformed configuration cannot
        # leave an idle component behind. Deterministic programs need no model.
        self.models = execution_models(self.args.root, self.worker_definition, kind, self.args.model,
                                       self.original.types.get(self.args.worker, {}).get('command', ()))
        self.id, self.directory, workspace = prepare_run(state_root('runs', root=self.args.root), self.args.workspace)
        self.job_id = uuid.uuid4().hex
        self.lease = (self.directory / 'launcher.lock').open('xb')
        fcntl.flock(self.lease, fcntl.LOCK_EX)
        prefix = re.sub('[^a-z0-9-]', '-', self.original.name.lower()).strip('-')[:37] or 'run'
        if not prefix[0].isalpha():
            prefix = 'env-' + prefix[:33]
        self.names = {'workers': f'{prefix}-workers-{self.id[:16]}'}
        self.record = {'id': self.id, 'manager': self.manager,
            'name': self.args.name or f'{self.original.name}.{self.args.worker}', 'environment': self.original.name,
            'worker_name': self.args.worker, 'worker_kind': kind, 'request': self.args.request,
            'workspace': str(workspace), 'created_at': timestamp(), 'status': 'starting',
            'system': self.args.system, 'components': self.names, 'dcomp': self.dcomp,
            'job_id': self.job_id, 'job_directory': f'jobs/{self.job_id}', 'model': self.args.model}
        self.snapshot()
        self.say(f'Run {self.id}\nState: {self.directory}\nWorkspace: {workspace}')
        effective = deepcopy(self.original.config)
        if self.worker_definition is not None:
            write_json(self.directory / 'worker-definition.json', self.worker_definition)
            command = definition_command(self.args.worker)
            self.builtin_file = self.directory / 'worker-definition.json'
            command = [command[0], '--definition', f'/opt/asys/environment/.asys-run/{self.args.worker}.json']
            previous = effective['types'].get(self.args.worker, {})
            effective['types'][self.args.worker] = {**previous, 'command': command}
        overlay_directory = self.directory / 'worker-bindings'
        mkdir(overlay_directory)
        self.overlay = overlay_directory / 'workers.json'
        write_json(self.overlay, effective)
        # Only replace the dispatch file. Existing relative commands and named
        # agent assets retain the locations selected by the environment.
        self.overlay_target = ('/opt/asys/environment/external/workers.json' if self.original.external
                               else '/opt/asys/environment/workers.json')
        self.prepare_environment(environment, self.args.link, configuration_directory=overlay_directory)
        if kind == 'swarm':
            self.record.update(swarm_state=f'jobs/{self.job_id}/swarm',
                               control_channel=f'swarm-{self.job_id}', world_channel=f'world-{self.job_id}',
                               channel=f'runtime/channels/swarm-{self.job_id}')
            self.outbound = Reader(direction_root(self.directory / 'runtime', self.record['control_channel'], 'out'))
        self.snapshot()
        self.start_workers()
        self.wait_ready()
        descriptor = describe(self.directory / 'runtime', self.original.name)
        if descriptor['definition'] != self.definition:
            raise LaunchError('The running environment does not match the selected worker bindings')
        self.queue = Queue(environment_root(self.directory / 'runtime', self.original.name))

    def worker_models(self):
        return self.models

    def add(self, role, directory, options):
        if role == 'workers':
            options = [*options, '--bind', f'{self.overlay},{self.overlay_target},ro']
            if self.builtin_file is not None:
                options += ['--bind', f'{self.builtin_file},/opt/asys/environment/.asys-run/{self.args.worker}.json,ro']
        super().add(role, directory, options)

    def job_input(self):
        result = {'request': self.args.request}
        if self.parameters is not None:
            result['parameters'] = self.parameters
        return result

    def poll(self):
        if self.outbound is not None:
            while True:
                batch = self.outbound.read(self.control_after, limit=500)
                if not batch:
                    break
                for entry in batch:
                    self.control_after = entry['sequence']
                    data = entry['data']
                    self.event(entry['type'], **data)
                    if entry['type'] == 'swarm.snapshot':
                        self.record['turn'] = data.get('turn')
                    elif entry['type'] in {'swarm.paused', 'swarm.resumed'}:
                        self.record['status'] = 'paused' if entry['type'] == 'swarm.paused' else 'running'
                        self.snapshot()
                self.outbound.advance(self.control_after)
        if self.progress is None:
            self.progress = LogReader(self.directory / 'jobs' / self.job_id / 'stdout.log', None)
        for line in self.progress.read():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if isinstance(event, dict) and event.get('type') in {'goal.phase_started', 'senate.phase_started'}:
                who = event.get('participant', 'worker')
                self.say(f"{who}: {event.get('phase', 'working')}")

    def execute(self):
        directory = self.directory / 'jobs' / self.job_id
        mkdir(directory, exist_ok=True)
        self.record.update(status='running')
        self.snapshot()
        self.event('job.created', jobId=self.job_id, worker=self.args.worker, workspace=self.record['workspace'])
        self.queue.submit(self.job_type, self.job_id, directory=directory,
            workspace=self.directory / 'workspace', input=self.job_input(),
            args=['--model', self.args.model] if self.args.model is not None else [],
            metadata={'name': self.args.worker, 'run_id': self.id,
                      'worker_kind': self.record['worker_kind'], 'environment': self.record['environment']})
        self.say(f'Job {self.job_id}: {self.args.worker}')
        next_health = time.monotonic() + 2
        while True:
            self.check_interrupt()
            state = self.queue.state(self.job_id)
            self.poll()
            if state['status'] in TERMINAL:
                # Runtime completion is authoritative. Drain the committed
                # world events once more before preserving the final result.
                self.poll()
                success = state['status'] == 'done'
                result = state.get('result')
                status = {'done': 'completed', 'cancelled': 'cancelled'}.get(state['status'], 'failed')
                if success and isinstance(result, dict) and result.get('status') == 'cancelled':
                    status = 'cancelled'
                event = {'completed': 'job.completed', 'cancelled': 'job.cancelled', 'failed': 'job.failed'}[status]
                self.event(event, jobId=self.job_id,
                           reason=state.get('error', ''))
                self.record.update(status=status, error=state.get('error', ''))
                write_json(self.directory / 'result.json', result)
                self.snapshot()
                if status == 'failed':
                    raise LaunchError(state.get('error') or f"Job {state['status']}")
                print(json.dumps(result, indent=2, ensure_ascii=False), flush=True)
                return
            if time.monotonic() >= next_health:
                self.monitor_components()
                next_health = time.monotonic() + 2
            self.interrupted.wait(0.1)


def main(argv=None):
    args = arguments(sys.argv[1:] if argv is None else argv)
    if args.workflow is not None or args.resume:
        from .workflow import run as run_workflow
        return run_workflow(args)
    if args.input is not None:
        try:
            args.request = sys.stdin.read() if args.input == '-' else Path(args.input).expanduser().read_text(encoding='utf-8')
            if not args.request.strip():
                raise ValueError('Request input must be nonempty')
        except (OSError, ValueError) as error:
            print(f'error: {error}', file=sys.stderr)
            return 1
        except KeyboardInterrupt:
            return 130
    launcher = Run(args)
    code = run_job(launcher)
    return 130 if code == 0 and launcher.record.get('status') == 'cancelled' else code
