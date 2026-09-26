"""Shared host support for running assignments in dcomp worker environments."""
import json
import os
from pathlib import Path
import re
import tempfile
import time
import uuid

from asys_runtime.environment import Environment
from asys_runtime.files import timestamp, write_json
from asys_runtime.permissions import mkdir, shared
from .lifecycle import ComponentHost, LaunchError, CommandTimeout, Interrupted, RecoveryRequired
from .human_service import ensure_human
from .config import system_models
from .options import dcomp_options

PROVIDER = 'cyclo.provider.v1.Provider'
HUMAN = 'asys.human.v1.Human'


def human_workers(environment, config, selected=None, selected_name=None):
    """Resolve authoring metadata here; the runtime remains a command executor."""
    if selected:
        if selected.get('kind') == 'goal':
            return True
        if selected.get('kind') != 'swarm':
            return False
    # A direct program uses only its own binding. Workflows and swarms can
    # dispatch further environment jobs, so retain their dependency scan.
    workers = ([(selected_name, config['types'][selected_name])]
               if selected_name is not None and selected is None else config['types'].items())
    from .worker_definitions import definition_command, definition_path, validate_definition
    for name, worker in workers:
        if Path(worker['command'][0]).name in {'asys-human', 'asys-goal'}:
            return True
        if worker['command'] == definition_command(name):
            value = json.loads(definition_path(environment, name).read_text())
            if isinstance(value, dict) and value.get('kind') == 'goal':
                validate_definition(value, environment)
                return True
    return False


def worker_kinds(environment, config, selected=None, selected_name=None):
    """Snapshot authoring kinds before dispatch, without inspecting live sources later."""
    from .worker_definitions import definition_command, load_definition
    kinds = {}
    for name, worker in config['types'].items():
        if selected_name is not None and name != selected_name:
            continue
        if selected is not None and name == selected_name:
            kinds[name] = selected['kind']
        elif worker['command'] == definition_command(name):
            kinds[name] = load_definition(environment, name)['kind']
        else:
            executable = Path(worker['command'][0]).name
            kinds[name] = {'asys-agent': 'agent', 'asys-goal': 'goal', 'asys-senate': 'senate',
                           'asys-swarm': 'swarm', 'asys-human': 'human'}.get(executable, 'program')
    return kinds


def execution_options(parser):
    parser.add_argument('--workspace', type=Path, default=Path.cwd(), metavar='DIRECTORY',
                        help='actual project directory to work in (default: current directory)')
    parser.add_argument('-L', '--link', action='append', default=[], metavar='INPUT=TARGET',
                        help='wire an environment input to COMPONENT.OUTPUT or @GLOBAL; - leaves it unconnected')
    dcomp_options(parser)


def prepare_run(root, workspace):
    workspace = workspace.expanduser().resolve(strict=True)
    root = root.expanduser().resolve()
    if not workspace.is_dir():
        raise LaunchError('Workspace must be an existing project directory')
    if any(',' in str(path) for path in (root, workspace)):
        raise LaunchError('State and workspace paths cannot contain commas (dcomp mount syntax)')
    mkdir(root, parents=True, exist_ok=True)
    if shared(root):
        os.umask(0o007)
    run_id = uuid.uuid4().hex
    directory = root / run_id
    mkdir(directory)
    for name in ('runtime', 'jobs'):
        mkdir(directory / name)
    mkdir(directory / 'environment')
    # A local reference to the real project, matching the container mount's
    # position relative to the queue. Neither side copies or populates it.
    (directory / 'workspace').symlink_to(workspace, target_is_directory=True)
    return run_id, directory, workspace


class EnvironmentHost(ComponentHost):
    HEALTH_GRACE = 60
    HEALTH_RESTART_READY = 90
    HEALTH_RESTART_LIMIT = 1

    def __init__(self, args):
        super().__init__(args)
        self.record = {}
        self._unhealthy_since = {}
        self._health_restart_deadline = {}
        self.preserve_components = False

    def prepare_environment(self, environment, links, *, configuration_directory=None, human_target=None):
        definition = Environment(environment, external=configuration_directory)
        descriptor, config = definition.descriptor, definition.config
        self.definition = descriptor['definition']
        self.record.update(environment=descriptor['name'], environment_directory=str(environment),
                           egress=config.get('egress', False))
        self.record['worker_kinds'] = {**self.record.get('worker_kinds', {}), **worker_kinds(
            environment, config, getattr(self, 'worker_definition', None), getattr(self.args, 'worker', None))}
        version = json.loads(self.command([self.dcomp[0], 'version', '--json']))
        release = re.fullmatch(r'(\d+)\.(\d+)\.(\d+)(?:[-+].*)?', version.get('version', ''))
        if version.get('api_version') != 2 or not release or tuple(map(int, release.groups())) < (0, 3, 2):
            raise LaunchError(f'Requires dcomp 0.3.2+ (Machine API 2); {self.dcomp[0]} reports {version}')
        manifest = self.directory / 'environment/component.dcomp'
        with tempfile.TemporaryDirectory(prefix='preview-', dir=self.directory) as temporary:
            preview = Path(temporary)
            (preview / 'environment').mkdir()
            (preview / 'environment/component.dcomp').write_text((environment / 'component.dcomp').read_text())
            system = preview / 'preview.dcomp'
            system.write_text('system execution-preview\ncomponent environment environment\n')
            component = self.document('view', '--json', str(system))['components'][0]
        inputs = {entry['name']: entry['service'] for entry in component['inputs']}
        human_worker = human_workers(environment, config, getattr(self, 'worker_definition', None),
                                     getattr(self.args, 'worker', None))
        if human_target is not None or human_worker:
            for entry in component['inputs'] + component['outputs']:
                if entry['name'] == 'human' and entry['service'] != HUMAN:
                    raise LaunchError(f"Environment interface 'human' uses {entry['service']}; expected {HUMAN}")
            # Workers call Human; the separate Human component exports it.
            component['outputs'] = [entry for entry in component['outputs'] if entry['name'] != 'human']
            if 'human' not in inputs:
                component['inputs'].append({'name': 'human', 'service': HUMAN})
                inputs['human'] = HUMAN
        resolved = {'inference': '@inference_endpoint'} if inputs.get('inference') == PROVIDER else {}
        if inputs.get('human') == HUMAN:
            resolved['human'] = '@human_endpoint'
        explicit = set()
        for link in links:
            source, separator, target = link.partition('=')
            if not separator or not target or source not in inputs or source in explicit:
                raise LaunchError(f'Invalid or duplicate environment link {link!r}; use INPUT=TARGET for a declared input')
            explicit.add(source)
            resolved[source] = target
        if human_target is not None:
            resolved['human'] = human_target
        if resolved.get('human') == '@human_endpoint':
            ensure_human(self)
        existing = self.document('view', '--json', self.args.system)
        if existing.get('operation'):
            raise LaunchError(f'dcomp system {self.args.system} has a pending operation')
        for source, target in resolved.items():
            if target.startswith('@') and not any(item['name'] == target[1:] for item in existing.get('globals', [])):
                raise LaunchError(f'Global {target} is not declared in dcomp system {self.args.system}; start its provider or supply -L {source}=TARGET')
        from .world_host import prepare_worlds
        prepare_worlds(self, environment, config)
        image = self.environment_image(environment, component['image_ref'])
        lines = [f'docker {image}']
        for direction in ('inputs', 'outputs'):
            lines += [f"{direction[:-1]} {entry['service']} {entry['name']}" for entry in component[direction]]
        manifest.write_text('\n'.join(lines) + '\n')
        self.record['links'] = resolved
        return descriptor

    def build_environment(self, environment):
        self.say(f"Building environment {self.record['environment']} from {environment}")
        image_file = self.directory / 'environment-image'
        self.command(['docker', 'build', '--iidfile', str(image_file), str(environment)], timeout=900, cancellable=True)
        return image_file.read_text().strip()

    def environment_image(self, environment, image_ref):
        if (environment / 'Dockerfile').is_file():
            return self.build_environment(environment)
        return self.command(['docker', 'image', 'inspect', '--format', '{{.Id}}', image_ref]).strip()

    def execution_mounts(self):
        if not Path(self.record['workspace']).is_dir():
            raise LaunchError(f"Workspace is unavailable: {self.record['workspace']}")
        gid = self.directory.stat().st_gid if shared(self.directory) else os.getgid()
        options = ['--user', f'{os.getuid()}:{gid}']
        for name in ('runtime', 'jobs'):
            options += ['--bind', f'{self.directory / name},/var/lib/asys/{name},rw']
        options += ['--bind', f"{self.record['workspace']},/var/lib/asys/workspace,rw"]
        return options

    def worker_models(self):
        return system_models(self.args.root)

    def start_workers(self):
        from .world_host import start_worlds
        start_worlds(self)
        options = self.execution_mounts()
        models = self.directory / 'system-models.json'
        write_json(models, self.worker_models())
        options += ['--bind', f'{models},/etc/asys/system-models.json,ro']
        bindings = self.directory / 'world-bindings.json'
        if bindings.exists():
            options += ['--bind', f'{bindings},/etc/asys/world-bindings.json,ro']
        if self.record.get('egress'):
            options.append('--egress')
        for source, target in self.record['links'].items():
            if target != '-':
                options += ['--link', f'{source}={target}']
        self.add('workers', 'environment', options)

    def add(self, role, directory, options):
        name = self.names[role]
        self.say(f"Starting {'workflow' if role == 'engine' else role}: {name}")
        self.owned.append(name)
        self.command(self.dcomp + ['add-component', *options, self.args.system, name, str(self.directory / directory)])

    def observe(self, *, cleanup=False, timeout=120):
        document = self.document('view', '--json', self.args.system, cleanup=cleanup, timeout=timeout)
        return document, {item['name']: item for item in document['components'] if item['name'] in self.owned}

    def monitor_components(self):
        # A shared lifecycle edit can hold dcomp's status lock. Failure to
        # observe is not evidence that this run's components have failed.
        try:
            _, components = self.observe(timeout=5)
        except CommandTimeout as error:
            if not getattr(self, '_status_delayed', False):
                self.say(f"Component status temporarily unavailable; execution continues and monitoring will retry: {error}")
            self._status_delayed = True
            now = time.monotonic()
            for name, since in self._unhealthy_since.items():
                deadline = self._health_restart_deadline.get(name, since + self.HEALTH_GRACE)
                if now >= deadline:
                    self.require_health_recovery(name, 'Component health could not be observed before its recovery deadline')
            return
        except (LaunchError, OSError, ValueError) as error:
            if self._health_restart_deadline:
                name = next(iter(self._health_restart_deadline))
                self.require_health_recovery(name, f'Could not monitor the restarted engine: {error}')
            raise
        if getattr(self, '_status_delayed', False):
            self.say("Component status monitoring recovered")
            self._status_delayed = False
        try:
            self.check_components(components, allow_unhealthy=True)
        except LaunchError as error:
            if self._health_restart_deadline:
                name = next(iter(self._health_restart_deadline))
                self.require_health_recovery(name, f'Component unavailable during engine recovery: {error}')
            raise
        now = time.monotonic()
        for name in self.owned:
            status = components[name]['status']
            if name in self._unhealthy_since:
                self.record['component_health'][name]['status'] = dict(status)
            if status.get('status') == 'running' and status.get('health') == 'unhealthy':
                if name not in self._unhealthy_since:
                    self._unhealthy_since[name] = now
                    self.record.setdefault('component_health', {})[name] = {
                        'state': 'unhealthy', 'since': timestamp(), 'status': dict(status)}
                    self._publish_health()
                    self._health_notice(f"Component {name} is running but unhealthy; execution continues "
                                        f"during a {self.HEALTH_GRACE}s recovery grace period.")
                    self._record_component_health(name, status, inspect=True)
            elif (name in self._unhealthy_since and status.get('status') == 'running'
                  and status.get('health') in {'healthy', 'none'}):
                del self._unhealthy_since[name]
                self._health_restart_deadline.pop(name, None)
                self.record.get('component_health', {}).pop(name, None)
                self._publish_health()
                self._health_notice(f"Component {name} health recovered")
                self._record_component_health(name, status)
        # Inspect every component before deciding to restart: workers/worlds
        # with expired health must never be replayed as a side effect.
        for name, since in list(self._unhealthy_since.items()):
            deadline = self._health_restart_deadline.get(name)
            if deadline is not None:
                if now >= deadline:
                    self.require_health_recovery(name, 'Engine health did not recover after its targeted restart')
            elif now - since >= self.HEALTH_GRACE:
                self.recover_unhealthy_component(name, components[name]['status'])

    def _publish_health(self):
        if self.record.get('status') in {'running', 'degraded', 'recovering'}:
            recovering = any(value.get('state') == 'restarting'
                             for value in self.record.get('component_health', {}).values())
            self.record['status'] = 'recovering' if recovering else 'degraded' if self._unhealthy_since else 'running'
        if hasattr(self, 'snapshot'):
            try:
                self.snapshot()
            except OSError as error:
                self._health_notice(f'Could not save component health status: {error}')
                return False
        return True

    def recover_unhealthy_component(self, name, status):
        self.require_health_recovery(name, 'Persistent unhealthy component cannot be restarted without interrupting its jobs')

    def require_health_recovery(self, name, reason):
        self.preserve_components = True
        detail = self.record.setdefault('component_health', {}).setdefault(name, {})
        detail.update(state='recovery-required', reason=reason)
        self.record.update(status='recovery-required', components_removed=False)
        message = (f'{reason}: {name}. Components, jobs and checkpoints are preserved; '
                   f'inspect component-health.jsonl in {self.directory} and component logs before recovery.')
        self.record['error'] = message
        self._record_component_health(name, detail.get('status', {}), action='recovery-required', reason=reason)
        self._publish_health()
        raise RecoveryRequired(message)

    def _health_notice(self, message):
        # Diagnostic log I/O must not turn a health warning into teardown.
        try:
            self.say(message)
        except OSError:
            pass

    def _record_component_health(self, name, status, *, inspect=False, **details):
        record = {'time': timestamp(), 'component': name, 'status': status}
        record.update(details)
        if inspect:
            try:
                container = status.get('container_id')
                if not container:
                    raise ValueError('No container ID in component status')
                # Preserve the healthcheck ring before Docker overwrites it.
                # State excludes environment variables and container config.
                record['docker_state'] = json.loads(self.command(
                    ['docker', 'container', 'inspect', '--format', '{{json .State}}', container], timeout=5))
            except Interrupted:
                raise
            except Exception as error:
                record['diagnostic_error'] = str(error)
        try:
            with (self.directory / 'component-health.jsonl').open('a', encoding='utf-8') as output:
                output.write(json.dumps(record) + '\n')
        except OSError as error:
            self._health_notice(f"Could not save component health diagnostics for {name}: {error}")

    def wait_ready(self):
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            self.check_interrupt()
            _, components = self.observe()
            self.check_components(components)
            if len(components) == len(self.owned) and all(
                component['status'].get('status') == 'running' and component['status'].get('health') in {'healthy', 'none'}
                for component in components.values()
            ):
                return
            self.interrupted.wait(0.2)
        raise LaunchError('Timed out waiting for components to start')
