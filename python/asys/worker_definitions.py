"""Reusable worker definitions and environment authoring primitives.

The runtime remains a command executor. This module compiles the named worker
convention into its ordinary command map; it is also used by the dispatcher.
"""
from contextlib import contextmanager
from copy import deepcopy
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile

from asys_runtime.config import parse_config
from asys_runtime.files import read_json, validate_name, write_json, write_text_atomic


KINDS = ('agent', 'goal', 'senate', 'swarm')
BUILTINS = ('simple', 'goal')
DEFINITION_LIMIT = 128 * 1024
DISPATCHER = '/opt/asys/asys-workers/tools/asys-worker'


def _object(value, label, fields):
    if not isinstance(value, dict):
        raise ValueError(f'{label} must be an object')
    unknown = set(value) - set(fields)
    if unknown:
        raise ValueError(f'Unknown {label} field(s): {", ".join(sorted(unknown))}')


def _text(value, label, *, empty=False):
    if not isinstance(value, str) or '\0' in value or (not empty and not value.strip()):
        raise ValueError(f'{label} must be {"" if empty else "nonempty "}text without NUL characters')
    return value


def _positive(value, label):
    if type(value) is not int or not 1 <= value <= 2147483647:
        raise ValueError(f'{label} must be a positive integer at most 2147483647')


def validate_definition(value, environment=None):
    """Return a detached validated definition; never execute or import its code."""
    encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2)
    if len(encoded.encode()) > DEFINITION_LIMIT:
        raise ValueError('Worker definition exceeds 128 KiB')
    value = json.loads(encoded)
    _object(value, 'worker definition', {'version', 'kind', 'description', 'config'})
    if type(value.get('version')) is not int or value['version'] != 1:
        raise ValueError('Worker definition version must be 1')
    kind = value.get('kind')
    if kind not in KINDS:
        raise ValueError(f'Worker kind must be one of {", ".join(KINDS)}')
    if 'description' in value:
        _text(value['description'], 'description', empty=True)
    config = value.get('config')
    if kind == 'agent':
        _object(config, 'agent config', {'agent', 'system', 'model', 'maxSteps'})
        validate_name('agent name', config.get('agent'))
        if 'system' in config and type(config['system']) is not bool:
            raise ValueError('agent config.system must be true or false')
        if config.get('system') and config['agent'] != 'simple':
            raise ValueError('The supported system agent is simple')
        if 'maxSteps' in config:
            _positive(config['maxSteps'], 'maxSteps')
    elif kind == 'goal':
        _object(config, 'goal config', {'model', 'maxAttempts'})
        if 'maxAttempts' in config:
            _positive(config['maxAttempts'], 'maxAttempts')
    elif kind == 'senate':
        _object(config, 'senate config', {'version', 'princeps', 'senators'})
        if type(config.get('version')) is not int or config['version'] != 1:
            raise ValueError('Senate config version must be 1')
        members = config.get('senators')
        if not isinstance(members, list) or not members:
            raise ValueError('Senate requires at least one senator')
        names = set()
        for participant in [config.get('princeps'), *members]:
            _object(participant, 'Senate participant', {'name', 'prompt', 'agent', 'model'})
            name = _text(participant.get('name'), 'participant name').strip()
            if name in names:
                raise ValueError('Senate participant names must be unique')
            names.add(name)
            if 'prompt' in participant:
                _text(participant['prompt'], 'participant prompt', empty=True)
            if 'agent' in participant:
                validate_name('participant agent', participant['agent'])
            if 'model' in participant:
                _text(participant['model'], 'participant model')
    else:
        if not isinstance(config, dict):
            raise ValueError('swarm config must be an object')
        if not isinstance(config.get('world'), dict) or 'package' not in config['world']:
            raise ValueError('Named swarm definitions require world.package')
        if 'channel' in config['world']:
            raise ValueError('Named swarm world channels are assigned per job')
        # The request supplies the mission. Reuse the engine's validation for
        # limits and world settings rather than maintain another schema here.
        from asys_swarm.config import validate_config
        had_mission = 'mission' in config
        candidate = deepcopy(config)
        candidate.setdefault('mission', 'Request supplied at execution.')
        value['config'] = validate_config(candidate)
        value['config']['world'].pop('channel', None)
        if not had_mission:
            value['config'].pop('mission', None)
    if kind in {'agent', 'goal'} and 'model' in config:
        _text(config['model'], 'model')
    return value


def scoped_path(environment, relative, *, existing=False):
    """Resolve an authoring path without following links outside the environment."""
    root = Path(environment).expanduser().resolve()
    if not isinstance(relative, (str, Path)):
        raise ValueError('Environment file must be a relative path')
    path = Path(relative)
    if path.is_absolute() or '..' in path.parts or not path.parts or '\0' in str(path):
        raise ValueError('File must remain inside the environment')
    current = root
    for index, part in enumerate(path.parts):
        current /= part
        if current.is_symlink():
            raise ValueError(f'Environment file must not use symlinks: {relative}')
        if index < len(path.parts) - 1 and current.exists() and not current.is_dir():
            raise ValueError(f'Environment parent path must be a directory: {current.relative_to(root)}')
    if existing and not current.is_file():
        raise ValueError(f'Environment file does not exist: {relative}')
    return current


def definition_path(environment, name):
    validate_name('worker name', name)
    return scoped_path(environment, f'workers/{name}.json')


def load_definition(environment, name):
    path = definition_path(environment, name)
    return validate_definition(read_json(path), environment)


def list_definitions(environment):
    directory = scoped_path(environment, 'workers')
    if not directory.exists():
        return {}
    if not directory.is_dir():
        raise ValueError('workers must be a directory')
    return {path.stem: load_definition(environment, path.stem)
            for path in sorted(directory.glob('*.json')) if not path.name.startswith('.')}


def definition_command(name):
    validate_name('worker name', name)
    return [DISPATCHER, '--definition', f'/opt/asys/environment/workers/{name}.json']


def builtin_definition(name):
    """Describe a built-in without creating files or overriding user workers."""
    if name == 'simple':
        return {'version': 1, 'kind': 'agent', 'description': 'One assignment using the built-in simple agent.',
                'config': {'agent': 'simple', 'system': True}}
    if name == 'goal':
        return {'version': 1, 'kind': 'goal', 'description': 'Implementation with independent verification.', 'config': {}}
    raise ValueError(f'Unknown built-in worker: {name}')


def environment_config(environment):
    path = scoped_path(environment, 'workers.json', existing=True)
    config = read_json(path)
    parse_config(config, directory=path.parent, environment=True)
    validate_name('environment name', config.get('name'))
    if not isinstance(config.get('description', ''), str):
        raise ValueError('Environment description must be text')
    return config


def bind_definition(environment, name, definition=None, *, write=True):
    """Compile one definition into the command map, preserving every other type.

    Callers performing multiple authoring writes hold authoring_lock around the
    transaction. write=False provides the same transformation without mutation.
    """
    definition = load_definition(environment, name) if definition is None else validate_definition(definition, environment)
    config = environment_config(environment)
    command = definition_command(name)
    previous = config['types'].get(name)
    if previous is not None and previous.get('command') != command:
        raise ValueError(f'Worker type {name} already has a different command')
    config['types'][name] = {**(previous or {}), 'command': command}
    if write:
        write_json(scoped_path(environment, 'workers.json'), config)
    return config


def ensure_environment(environment):
    """Create only missing standard environment files; preserve existing content."""
    root = Path(environment).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    name = re.sub(r'[^A-Za-z0-9._-]', '-', root.name).strip('._-')[:128] or 'environment'
    image_name = re.sub(r'[^a-z0-9-]', '-', name.lower()).strip('-') or 'environment'
    defaults = {
        'Dockerfile': 'FROM asys-workers\nCOPY . /opt/asys/environment\n',
        'component.dcomp': f'docker asys-env-{image_name}\ninput cyclo.provider.v1.Provider inference\ninput asys.human.v1.Human human\n',
        'workers.json': json.dumps({'version': 1, 'name': name, 'types': {
            'program': {'command': ['/opt/asys/asys-workers/tools/asys-program']}}}, indent=2) + '\n',
    }
    for relative, text in defaults.items():
        path = scoped_path(root, relative)
        if not path.exists():
            write_text_atomic(path, text, mode=0o644)
        elif not path.is_file():
            raise ValueError(f'{relative} must be a file')
    environment_config(root)
    return root


@contextmanager
def authoring_lock(environment):
    root = Path(environment).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    fd = os.open(root / '.asys-authoring.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield root
    finally:
        os.close(fd)


def edit_validated(path, validate, *, before_replace=lambda: None):
    """Edit a temporary copy; keep the original intact on errors or conflicts."""
    path = Path(path)
    original = path.read_bytes()
    editor = os.environ.get('VISUAL') or os.environ.get('EDITOR') or 'vi'
    command = shlex.split(editor)
    if not command:
        raise ValueError('VISUAL or EDITOR must name an editor')
    fd, temporary = tempfile.mkstemp(prefix=f'.{path.stem}.edit-', suffix=path.suffix, dir=path.parent)
    temporary = Path(temporary)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(original)
        completed = subprocess.run([*command, str(temporary)], check=False)
        if completed.returncode:
            raise ValueError(f'Editor exited with status {completed.returncode}; original file retained')
        if temporary.is_symlink() or not temporary.is_file():
            raise ValueError('Editor must leave a regular file')
        changed = temporary.read_text(encoding='utf-8')
        validate(changed)
        if path.is_symlink() or path.read_bytes() != original:
            raise ValueError('File changed while the editor was open; original file retained')
        if changed.encode() != original:
            before_replace()
            write_text_atomic(path, changed, mode=path.stat().st_mode & 0o777)
        return changed
    finally:
        temporary.unlink(missing_ok=True)


def validate_runtime_text(text, environment):
    config = json.loads(text)
    parse_config(config, directory=Path(environment), environment=True)
    validate_name('environment name', config.get('name'))
    if not isinstance(config.get('description', ''), str):
        raise ValueError('Environment description must be text')
    return config


def initial_definition(kind, name):
    validate_name('worker name', name)
    if kind == 'agent':
        config = {'agent': name}
    elif kind == 'goal':
        config = {}
    elif kind == 'senate':
        config = {'version': 1, 'princeps': {'name': 'Princeps senatus'},
                  'senators': [{'name': 'Reviewer', 'prompt': 'Check assumptions and supporting evidence.'}]}
    elif kind == 'swarm':
        config = {'version': 1, 'world': {'package': f'worlds/{name}',
                                        'settings': {'top_k': 0, 'problem': {'initial': {}}}},
                  'agents': {'count': 4, 'type': f'{name[:123]}-step'},
                  'limits': {'turns': 20, 'decisions': 80}}
    else:
        raise ValueError(f'Unsupported worker kind: {kind}')
    definition = {'version': 1, 'kind': kind, 'config': config}
    if kind == 'swarm':
        definition['description'] = 'Configure the task evaluator and world settings before running this swarm.'
    return validate_definition(definition)
