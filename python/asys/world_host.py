"""Prepare and own the world components used by named swarm workers."""
import hashlib
import os
from pathlib import Path
import shutil
import tempfile
import time

from asys_runtime.files import read_json, validate_name, write_json
from asys_runtime.permissions import mkdir, shared
from .images import build_image
from .lifecycle import LaunchError
from .worker_definitions import definition_command, load_definition


VIEW_BYTES = 32 * 1024 * 1024
VIEW_FILES = 2000
READY_SECONDS = 90
STATIC_SUFFIXES = {'.html', '.css', '.js', '.mjs', '.json', '.svg', '.png', '.jpg', '.jpeg',
                   '.webp', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.wasm', '.map'}
EXCLUDED = {'.git', '.agents', '.codex', 'node_modules', '__pycache__', '.venv'}


def state_path(root, relative):
    """Never follow a saved runtime link when selecting a host mount or asset."""
    relative = Path(relative)
    if relative.is_absolute() or '..' in relative.parts:
        raise LaunchError('World state paths must remain inside the run')
    path = Path(root)
    for part in relative.parts:
        path /= part
        if path.is_symlink():
            raise LaunchError('World state paths must not use symlinks')
    return path


def swarm_definitions(environment, config, selected=None, selected_name=None):
    """Direct runs need only their selected world; workflows can call any type."""
    if selected_name is not None:
        validate_name('worker name', selected_name)
        return {selected_name: selected} if selected is not None and selected.get('kind') == 'swarm' else {}
    definitions = {}
    for name, worker in config['types'].items():
        if worker['command'] == definition_command(name):
            value = load_definition(environment, name)
            if value['kind'] == 'swarm':
                definitions[name] = value
    return definitions


def snapshot_view(package, destination):
    """Retain browser resources, excluding the world's executable sources."""
    root, source = package['root'], package['view']
    component_root = package['component'].parent
    if component_root == root:
        if source.parent == root:
            raise LaunchError('Worlds with a component at package root require a separate viewer directory')
        static_root = source.parent
    else:
        if source.is_relative_to(component_root):
            raise LaunchError('World viewer assets must be outside the component directory')
        static_root = root
    entry = source.relative_to(root).as_posix()
    destination = Path(destination)
    # A resumed workflow retains the original renderer with its recorded frames.
    if destination.exists():
        if destination.is_symlink() or not state_path(destination, entry).is_file():
            raise LaunchError(f'Saved world viewer is unavailable: {destination / entry}')
        return entry
    files, size = [], 0
    for current, directories, names in os.walk(static_root, followlinks=False):
        current = Path(current)
        directories[:] = sorted(name for name in directories if name not in EXCLUDED
                                and current / name != component_root)
        for name in directories + sorted(names):
            path = current / name
            if path.is_symlink():
                raise LaunchError('World viewer assets must not contain symlinks')
            if path.is_dir() or path.name == 'world.json' or path.suffix.lower() not in STATIC_SUFFIXES:
                continue
            if not path.is_file():
                raise LaunchError('World viewer assets must be regular files')
            size += path.stat().st_size
            files.append(path)
            if size > VIEW_BYTES or len(files) > VIEW_FILES:
                raise LaunchError('World viewer assets exceed 32 MiB or 2000 files')
    if source not in files:
        raise LaunchError('World viewer entry must be a browser resource')
    mkdir(destination.parent, parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.view-', dir=destination.parent) as temporary:
        Path(temporary).chmod(0o2770 if shared(destination.parent) else 0o700)
        staged = Path(temporary) / 'assets'
        mkdir(staged)
        for path in files:
            target = staged / path.relative_to(root)
            mkdir(target.parent, parents=True, exist_ok=True)
            shutil.copyfile(path, target)
            target.chmod(0o660 if shared(target.parent) else 0o600)
        staged.rename(destination)
    return entry


def versioned_view(package, directory):
    """Snapshot a renderer generation independently of its worker type."""
    with tempfile.TemporaryDirectory(prefix='.world-view-', dir=directory) as temporary:
        staged = Path(temporary)
        staged.chmod(0o2770 if shared(directory) else 0o700)
        assets = staged / 'assets'
        entry = snapshot_view(package, assets)
        fingerprint = hashlib.sha256(entry.encode() + b'\0')
        for path in sorted(assets.rglob('*')):
            if path.is_file():
                fingerprint.update(path.relative_to(assets).as_posix().encode() + b'\0')
                fingerprint.update(hashlib.sha256(path.read_bytes()).digest())
        identity = fingerprint.hexdigest()
        relative = f'world-view-versions/{identity}'
        destination = state_path(directory, relative)
        if destination.exists():
            if not state_path(destination, entry).is_file():
                raise LaunchError(f'Saved world viewer is unavailable: {destination / entry}')
        else:
            mkdir(destination.parent, parents=True, exist_ok=True)
            assets.rename(destination)
    return identity, {'directory': relative, 'entry': entry}


def _component(host, package):
    with tempfile.TemporaryDirectory(prefix='world-preview-', dir=host.directory) as temporary:
        root = Path(temporary)
        (root / 'world').mkdir()
        shutil.copyfile(package['component'], root / 'world/component.dcomp')
        manifest = root / 'preview.dcomp'
        manifest.write_text('system world-preview\ncomponent world world\n')
        return host.document('view', '--json', str(manifest))['components'][0]


def _image(host, package, component, directory, reference):
    source = package['component'].parent
    if (source / 'Dockerfile').is_file():
        host.say(f'Building world {reference} from {source}')
        return build_image(host, source, directory / 'image')
    return host.image_id(component['image_ref'])


def prepare_worlds(host, environment, config):
    from .world_packages import deployment_settings, resolve_package
    definitions = swarm_definitions(environment, config, getattr(host, 'worker_definition', None),
                                    getattr(host.args, 'worker', None))
    # Resolve all references before builds or replacing saved binding metadata.
    packages = {value['config']['world']['package']: None for value in definitions.values()}
    for reference in packages:
        packages[reference] = resolve_package(environment, reference)
    bindings = {'version': 1, 'packages': {}}
    path = state_path(host.directory, 'world-bindings.json')
    previous = read_json(path) if path.exists() else None
    if previous is not None and (not isinstance(previous, dict) or type(previous.get('version')) is not int
                                 or previous['version'] != 1
                                 or not isinstance(previous.get('packages'), dict)):
        raise LaunchError('Saved world bindings are invalid')
    components, views = {}, dict(host.record.get('world_views', {}))
    versions = dict(host.record.get('world_view_versions', {}))
    for reference, package in sorted(packages.items()):
        binding = hashlib.sha256(reference.encode()).hexdigest()[:20]
        runtime = f'worlds/{binding}'
        value = {'runtime': runtime}
        if previous and reference in previous['packages']:
            old = previous['packages'][reference]
            if (not isinstance(old, dict) or set(old) - {'runtime', 'view'}
                    or old.get('runtime') != runtime):
                raise LaunchError(f'Saved world binding changed for {reference}')
        bindings['packages'][reference] = value
        relative = f'world-components/{binding}'
        directory = state_path(host.directory, relative)
        mkdir(directory, parents=True, exist_ok=True)
        mkdir(state_path(host.directory, f'runtime/{runtime}'), parents=True, exist_ok=True)
        component = _component(host, package)
        deployment = deployment_settings(package['manifest'].get('deployment', {}))
        unknown = set(deployment['links']) - {entry['name'] for entry in component['inputs']}
        if unknown:
            raise LaunchError(f'World {reference} links undeclared input(s): {", ".join(sorted(unknown))}')
        image = _image(host, package, component, directory, reference)
        lines = [f'docker {image}']
        for direction in ('inputs', 'outputs'):
            lines += [f"{direction[:-1]} {entry['service']} {entry['name']}" for entry in component[direction]]
        (directory / 'component.dcomp').write_text('\n'.join(lines) + '\n')
        role = f'world-{binding}'
        name = f'world-{host.id[:24]}-{binding}'
        components[reference] = {'role': role, 'name': name, 'directory': relative,
                                 'runtime': runtime, 'image': image, 'deployment': deployment}
        generation, saved_view = versioned_view(package, host.directory)
        value['view'] = generation
        versions[generation] = saved_view
    for name, definition in definitions.items():
        reference = definition['config']['world']['package']
        # Older jobs predate per-job view IDs. Keep their original type mapping;
        # new jobs select the current generation from the protected binding.
        views.setdefault(name, versions[bindings['packages'][reference]['view']])
    # Old components must already have been removed before BPMN resume reaches
    # environment refresh. Retain session files while replacing deployment data.
    for role in list(host.names):
        if role.startswith('world-'):
            del host.names[role]
    host.names.update({value['role']: value['name'] for value in components.values()})
    host.record.update(world_components=components, world_views=views, world_view_versions=versions)
    write_json(path, bindings)


def start_worlds(host):
    components = host.record.get('world_components', {})
    if not components:
        return
    gid = host.directory.stat().st_gid if shared(host.directory) else os.getgid()
    for reference, value in components.items():
        host.check_interrupt()
        runtime = state_path(host.directory, f"runtime/{value['runtime']}")
        # A marker left by a previous process must not make a new component ready.
        (runtime / 'ready.json').unlink(missing_ok=True)
        options = ['--user', f'{os.getuid()}:{gid}', '--bind', f'{runtime},/var/lib/asys-world,rw']
        from .world_packages import deployment_settings
        deployment = deployment_settings(value.get('deployment', {}))
        if deployment['egress']:
            options.append('--egress')
        for source, target in deployment['links'].items():
            options += ['--link', f'{source}={target}']
        host.add(value['role'], value['directory'], options)
    deadline = time.monotonic() + READY_SECONDS
    while time.monotonic() < deadline:
        host.check_interrupt()
        _, running = host.observe()
        host.check_components(running)
        ready = True
        for reference, value in components.items():
            marker = host.directory / 'runtime' / value['runtime'] / 'ready.json'
            if not marker.exists():
                ready = False
                continue
            if marker.is_symlink() or marker.stat().st_size > 8192:
                raise LaunchError(f'Invalid world readiness marker for {reference}')
            result = read_json(marker)
            if (not isinstance(result, dict) or type(result.get('protocolVersion')) is not int
                    or result['protocolVersion'] != 1 or not isinstance(result.get('identity'), str)
                    or not result['identity'].strip()):
                raise LaunchError(f'World {reference} does not advertise supported protocolVersion 1')
            component = running.get(value['name'], {}).get('status', {})
            if component.get('status') != 'running' or component.get('health') not in {'healthy', 'none'}:
                ready = False
        if ready:
            return
        host.interrupted.wait(.1)
    raise LaunchError('Timed out waiting for world components to become ready')
