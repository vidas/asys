"""A terminal Human service owned by one foreground run."""
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

from .lifecycle import LaunchError
from asys_runtime.channel import Reader, Writer, direction_root


class HumanHandler:
    def __init__(self, host, name):
        self.host, self.name = host, name
        self.process = None
        self.directory = None
        self.attached = False

    def start(self, *, attach=False):
        self.attached = attach
        source = Path(__file__).resolve().parents[2] / 'asys-human-interface/tools/asys-human-prompt'
        executable = source if source.is_file() else Path(sys.argv[0]).resolve().parent / 'asys-human-prompt'
        if not executable.is_file():
            raise LaunchError('--human requires asys-human-prompt; install the human interface')
        command = [sys.executable, str(executable), '--private', '--name', self.name,
                   '--system', self.host.args.system, '--root', str(self.host.args.root)]
        options = self.host.dcomp[1:]
        for index in range(0, len(options), 2):
            flag = '--dcomp-state-root' if options[index] == '--state-root' else options[index]
            command += [flag, options[index + 1]]
        attachment = uuid.uuid4().hex
        self.process = subprocess.Popen(command, env={**os.environ, 'DCOMP_BINARY': self.host.dcomp[0],
                                                     'ASYS_HUMAN_ATTACHMENT': attachment})
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            self.host.check_interrupt()
            self.check()
            document = self.host.document('view', '--json', self.host.args.system)
            component = next((item for item in document['components'] if item['name'] == self.name), None)
            if component:
                self.host.check_components({self.name: component}, [self.name])
                if component['status'].get('health') == 'healthy':
                    runtime = next((Path(bind['source']) for bind in component.get('binds', [])
                                    if bind['target'] == '/var/lib/asys-human'), None)
                    if runtime is None:
                        raise LaunchError('Private Human component has no host channel mount')
                    self.directory = runtime.parent
                    self.host.record['human_state'] = str(self.directory)
                    ready = Reader(direction_root(self.directory, 'control', 'out'))
                    if any(event['type'] == 'attached' and event['data'].get('attachment') == attachment
                           and event['data'].get('component') == self.name for event in ready.read(0)):
                        return
            self.host.interrupted.wait(0.2)
        raise LaunchError('Timed out starting the terminal human handler')

    def check(self):
        if self.process and self.process.poll() is not None:
            raise LaunchError(f'The terminal human handler stopped (exit {self.process.returncode})')

    def close(self, *, preserve=False):
        if self.process is None:
            return True
        if self.process.poll() is None:
            if preserve and not self.attached:
                # Publish the ownership handoff before signalling. The handler
                # also reads pending detach intent from its finally path.
                try:
                    if self.directory is None:
                        raise ValueError('Private Human state directory is unknown')
                    Writer(direction_root(self.directory, 'control', 'in')).send('detach', {})
                except (OSError, ValueError) as error:
                    self.host.say(f'Could not detach Human handler safely; it remains running: {error}')
                    return False
            self.process.terminate()
        try:
            self.process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
            self.host.say(f'Human handler cleanup did not finish; inspect component {self.name}')
            return False
        return self.process.returncode in (0, 130)
