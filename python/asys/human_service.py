"""The shared Human component outlives workflows and terminal attachments."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import time

from asys_runtime import release
from asys_runtime.files import write_json
from asys_runtime.permissions import mkdir, open_file, shared

from .lifecycle import ComponentHost, LaunchError
from .state import state_root

SERVICE = 'asys.human.v1.Human'


def human_image(inspect):
    """Return the Human image (tag, ID): an explicit override, else the installed release's."""
    override = os.environ.get('ASYS_HUMAN_INTERFACE_IMAGE')
    if override:
        return override, inspect(override)
    try:
        return release.image('asys-human-interface', inspect=inspect)
    except release.ReleaseError as error:
        raise LaunchError(f'Human image is unavailable: {error}') from error


class SharedHumanService(ComponentHost):
    def __init__(self, args, root=None, *, directory=None, dcomp=None, name=None):
        super().__init__(args)
        if dcomp is not None:
            self.dcomp = list(dcomp)
        # Save the effective selection, including a selection made by the
        # environment, so a later update cannot address another installation.
        if '--state-root' not in self.dcomp:
            selected = Path(os.environ.get('DCOMP_STATE_ROOT') or
                            Path(os.environ.get('XDG_STATE_HOME') or Path.home() / '.local/state') / 'dcomp')
            self.dcomp += ['--state-root', str(selected.expanduser().resolve())]
        identity = self.dcomp[self.dcomp.index('--state-root') + 1] + '\0' + args.system
        key = hashlib.sha256(identity.encode()).hexdigest()[:16]
        self.directory = directory or (root or state_root('human', root=getattr(args, 'root', None))) / ('shared-' + key)
        self.directory = self.directory.expanduser().resolve()
        self.name = name or 'asys-human'

    def say(self, message):
        print(message, flush=True)

    def ensure(self, *, refresh=False):
        if ',' in str(self.directory):
            raise LaunchError('The Human state path cannot contain a comma (dcomp mount syntax)')
        mkdir(self.directory, parents=True, exist_ok=True)
        with os.fdopen(open_file(self.directory / 'service.lock', os.O_CREAT | os.O_RDWR), 'a+b') as lease:
            fcntl.flock(lease, fcntl.LOCK_EX)
            document = self.document('view', '--json', self.args.system)
            if document.get('operation'):
                raise LaunchError(f'dcomp system {self.args.system} has a pending operation')
            state = self.directory / 'service.json'
            previous = json.loads(state.read_text()) if state.is_file() else {}
            name = previous.get('component', self.name)
            target = next((item.get('target') or {} for item in document.get('globals', [])
                           if item['name'] == 'human_endpoint'), {})
            if target.get('component'):
                component = next((item for item in document['components'] if item['name'] == target['component']), None)
                if component is None:
                    raise LaunchError('@human_endpoint points to a missing component')
                self.check_components({component['name']: component}, [component['name']])
                if not refresh:
                    return component
                if previous.get('component') != component['name']:
                    return component  # An explicitly bound provider keeps its ownership.
            else:
                component = next((item for item in document['components'] if item['name'] == name), None)
                if component and not previous:
                    raise LaunchError(f'Component {name} already exists without managed Human service state')

            image_ref, image = human_image(self.image_id)
            runtime = self.directory / 'runtime'
            definition = self.directory / 'component'
            mkdir(runtime, exist_ok=True)
            mkdir(definition, exist_ok=True)
            (definition / 'component.dcomp').write_text(f'docker {image}\noutput {SERVICE} human\n')
            record = {'version': 1, 'system': self.args.system, 'component': name, 'dcomp': self.dcomp,
                      'image_ref': image_ref, 'image': image, 'runtime': str(runtime)}
            write_json(state, record)
            if component and component.get('image_id') != image:
                self.say(f'Updating shared Human service {name}…')
                self.command(self.dcomp + ['rm-component', self.args.system, name])
                component = None
                target = {}
            if component is None:
                self.say(f'Starting shared Human service {name}…')
                gid = self.directory.stat().st_gid if shared(self.directory) else os.getgid()
                self.command(self.dcomp + ['add-component', '--user', f'{os.getuid()}:{gid}',
                                          '--bind', f'{runtime},/var/lib/asys-human,rw',
                                          self.args.system, name, str(definition)])
            deadline = time.monotonic() + 90
            while True:
                self.check_interrupt()
                document = self.document('view', '--json', self.args.system)
                component = next((item for item in document['components'] if item['name'] == name), None)
                self.check_components({name: component}, [name])
                if component['status'].get('health') == 'healthy':
                    break
                if time.monotonic() >= deadline:
                    raise LaunchError('Timed out waiting for the shared Human service')
                self.interrupted.wait(0.2)
            if target.get('component') != name:
                self.command(self.dcomp + ['assign-global', self.args.system, 'human_endpoint', f'{name}.human'])
            return component


def ensure_human(host, root=None, *, name=None):
    service = SharedHumanService(host.args, root, dcomp=host.dcomp, name=name)
    service.interrupted = host.interrupted
    service.say = host.say
    return service.ensure()
