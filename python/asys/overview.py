"""asys status without a run: is this setup running, and what is on."""
import json
import os
from pathlib import Path
import subprocess

from asys_runtime import release

from . import maintenance
from .runs import TERMINAL, Runs, launcher_state
from .version import image_build


def overview(args):
    root = Path(args.root)
    report = collect(root)
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return
    installed = report['release']
    print(f"asys {installed['version']} (build {installed['build']})" if installed else 'asys (no release information)')
    print(f'state     {root}')
    system = report['system']
    print(f"system    {system['name']} · dcomp {system['dcomp']} · {system['state']}")
    if report['services']:
        print('services')
        for service in report['services']:
            print(f"  {service['role']:<10} {service['name']:<26} {service['status']:<9} {service['health']:<10} {service['build']}")
    else:
        print('services  none running')
    runs = report['runs']
    print(f"runs      {len(runs['active'])} active of {runs['saved']} saved; asys ps lists them")
    for run in runs['active']:
        print(f"  {run['id'][:8]}  {run['name']}  {run['status']}  {run['jobs']} jobs")
        for component in run['components']:
            print(f"    {component['name']:<34} {component['status']:<9} {component['health']}")
    if report['other']:
        print('other components')
        for component in report['other']:
            print(f"  {component['name']:<36} {component['status']:<9} {component['health']}")
    for warning in report['warnings']:
        print(f'warning: {warning}')


def collect(root):
    warnings = []
    try:
        installed = release.load()
    except (release.ReleaseError, OSError, ValueError):
        installed = None
    machine = _read(root / 'inference/machine.json') or {}
    config = machine.get('config', {})
    humans = [record for record in (_read(path) for path in sorted((root / 'human').glob('*/service.json'))) if record]
    name = config.get('system') or next((record['system'] for record in humans if record.get('system')), 'asys')
    dcomp = (config.get('dcomp_state_root') or _human_dcomp(humans) or os.environ.get('DCOMP_STATE_ROOT')
             or _own_dcomp(root) or str(Path(os.environ.get('XDG_STATE_HOME') or Path.home() / '.local/state') / 'dcomp'))
    systems = {}

    def system(dcomp_root, system_name):
        key = (str(Path(dcomp_root).expanduser()), system_name)
        if key not in systems:
            state_, components_ = _system(*key)
            systems[key] = (state_, dict(components_))
        return systems[key]

    state, remaining = system(dcomp, name)

    services = []
    for applied in (machine.get('applied') or {}).get('components', []):
        services.append(_service('inference', applied['name'], remaining, applied['component']['image'], installed, warnings))
    for record in humans:
        if record.get('system', name) == name and record.get('component'):
            services.append(_service('human', record['component'], remaining, record.get('image', ''), installed, warnings))

    runs = Runs(root / 'runs')
    active = []
    directories = runs.directories()
    for directory in directories:
        record = _read(directory / 'run.json') or {}
        if record.get('status') in TERMINAL or launcher_state(directory) != 'running':
            continue
        jobs = runs.snapshot(directory)['jobs']
        # A run records the dcomp state and system it actually runs in.
        _, available = system(_state_root(record.get('dcomp')) or dcomp, record.get('system') or name)
        owned = [available.pop(component) for component in record.get('components', {}).values() if component in available]
        active.append({'id': record.get('id', directory.name), 'name': record.get('name', directory.name),
                       'status': record.get('status', 'unknown'), 'jobs': f"{sum(j.get('status') == 'running' for j in jobs)}/{len(jobs)}",
                       'components': owned})
        for component in owned:
            if component['health'] not in {'healthy', '-'} or component['status'] != 'running':
                warnings.append(f"run {record.get('id', '?')[:8]} component {component['name']} is {component['status']}/{component['health']}")

    pending = maintenance.load(root)
    if pending and pending.get('phase') != 'complete':
        warnings.append(f"the update to {pending['build']} is unfinished ({pending['phase']}); repeat asys update")
    if state not in {'running', 'running, no components'}:
        warnings.append(f"dcomp system {name} is {state}")
    return {'release': installed and {'version': installed['version'], 'build': installed['build']},
            'system': {'name': name, 'dcomp': dcomp, 'state': state},
            'services': services, 'runs': {'saved': len(directories), 'active': active},
            'other': sorted(remaining.values(), key=lambda item: item['name']), 'warnings': warnings}


def _service(role, name, remaining, image, installed, warnings):
    component = remaining.pop(name, None) or {'name': name, 'status': 'absent', 'health': '-'}
    build = image_build(image) if image else ''
    current = installed is not None and build == installed['build']
    if component['status'] != 'running' or component['health'] not in {'healthy', '-'}:
        warnings.append(f"{role} component {name} is {component['status']}/{component['health']}")
    elif installed is not None and not current:
        warnings.append(f'{name} does not run release {installed["build"]}; run asys update')
    return {'role': role, 'name': name, 'status': component['status'], 'health': component['health'],
            'build': 'current' if current else (build or 'built before release identity')}


def _system(dcomp, name):
    # dcomp exits nonzero for a system that is not operational but still
    # reports it; only a missing report means the system does not exist.
    result = subprocess.run(['dcomp', '--state-root', dcomp, 'status', '--json', name], capture_output=True, text=True)
    try:
        status = json.loads(result.stdout)
    except ValueError:
        return 'not created', {}
    if not status.get('desired'):
        state = 'stopped'
    elif status.get('operation'):
        state = f"changing ({status['operation']})"
    elif not status.get('proxy', {}).get('ready') or status.get('proxy', {}).get('problem'):
        state = 'proxy not ready'
    elif not status.get('components'):
        state = 'running, no components'
    else:
        state = 'running' if status.get('operational') else 'degraded'
    components = {item['name']: {'name': item['name'], 'status': item.get('status', 'unknown'),
                                 'health': item.get('health') or '-'} for item in status.get('components', [])}
    return state, components


def _state_root(command):
    command = command or []
    return command[command.index('--state-root') + 1] if '--state-root' in command[:-1] else None


def _human_dcomp(records):
    """The dcomp state root a Human service record was started with."""
    return next((root for root in (_state_root(record.get('dcomp')) for record in records) if root), None)


def _own_dcomp(root):
    """asys init keeps a state's dcomp beside it unless told otherwise."""
    return str(root / 'dcomp') if (root / 'dcomp').is_dir() else None


def _read(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return None
