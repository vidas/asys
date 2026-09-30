"""Refresh shared services using the installed component images and sources."""
import fcntl
from argparse import Namespace
import json
from pathlib import Path
import subprocess
import sys
import time
import os

from asys_runtime import release
from asys_runtime.channel import Reader, Writer, direction_root
from asys_runtime.permissions import open_file
from . import maintenance
from .human_service import SharedHumanService, human_image


def inference_command():
    source = Path(__file__).resolve().parents[2] / 'asys-inference/bin/asys-inference'
    return str(source) if source.is_file() else str(Path(sys.argv[0]).resolve().parent / 'asys-inference')


def refresh_human(directory, record):
    # The owning terminal replaces its component; this sends it the installed image.
    _, inspected = human_image(release.inspect_image)
    if inspected == record['image']:
        print(f"Human service {record['component']} is current.", flush=True)
        return
    incoming = Writer(direction_root(directory, 'control', 'in'))
    outgoing = Reader(direction_root(directory, 'control', 'out'))
    after = max(outgoing.sequences(), default=0)
    request = incoming.send('update', {'image': inspected})
    print(f"Updating human service {record['component']}…", flush=True)
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        for event in outgoing.read(after):
            after = event['sequence']
            if event['data'].get('request') != request['sequence']:
                continue
            if event['type'] == 'error':
                raise ValueError(event['data']['message'])
            print(f"Updated human service {record['component']}.", flush=True)
            return
        time.sleep(0.1)
    raise ValueError(f"Human handler did not confirm its update; inspect {directory}")


def update(args):
    root = args.root.expanduser().resolve()
    if not root.is_dir():
        raise ValueError(f'asys state directory does not exist: {root}')
    changed = False
    machine = root / 'inference/machine.json'
    config = json.loads(machine.read_text())['config'] if machine.is_file() else {}
    if config.get('running'):
        # Runs whose workers cannot use the new inference drain on the current
        # services first, then continue on the replaced ones.
        try:
            installed = release.load()
        except release.ReleaseError as error:
            raise ValueError(f'Cannot compare running work with the installation: {error}') from error
        work = maintenance.plan(root, installed, force=getattr(args, 'force', False))
        if work:
            maintenance.drain(root, work, maintenance.spawner(root))
        print('Updating inference services…', flush=True)
        subprocess.run([inference_command(), '--root', str(root), 'start'], check=True)
        service = Namespace(system=config['system'],
                            dcomp_state_root=Path(config['dcomp_state_root']),
                            runtime_root=Path(config['runtime_root']) if config.get('runtime_root') else None)
        SharedHumanService(service, root / 'human').ensure()
        if work:
            maintenance.release_runs(root, work)
        changed = True
    for path in sorted((root / 'human').glob('*/service.json')):
        record = json.loads(path.read_text())
        with os.fdopen(open_file(path.parent / 'handler.lock', os.O_CREAT | os.O_RDWR), 'a+b') as lease:
            try:
                fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                refresh_human(path.parent, record)
            else:
                service = SharedHumanService(Namespace(system=record['system']), directory=path.parent, dcomp=record['dcomp'])
                service.ensure(refresh=True)
                print(f"Shared Human service {record['component']} is current.", flush=True)
        changed = True
    for path in sorted((root / 'human').glob('*/session.json')):
        record = json.loads(path.read_text())
        if record.get('persistent') or record['component_removed'] or record.get('global') != 'human_endpoint':
            continue
        with (path.parent / 'handler.lock').open('rb') as lease:
            try:
                fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                refresh_human(path.parent, record)
                changed = True
    if not changed:
        print('No running shared services in this asys state.')
