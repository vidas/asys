"""Author named worker definitions inside an environment."""
import argparse
from contextlib import contextmanager
import json
from pathlib import Path
import sys

from asys_runtime.config import validate_types
from asys_runtime.files import read_json, write_json, write_text_atomic
from .worker_definitions import (BUILTINS, KINDS, authoring_lock, bind_definition, builtin_definition,
    definition_path, edit_validated, ensure_environment, environment_config,
    initial_definition, list_definitions, load_definition, scoped_path, validate_definition)
from .world_packages import resolve_package


@contextmanager
def _changes(root):
    """Restore changed files on an authoring error; leave existing assets alone."""
    originals = {}
    directories = set()
    def remember(path):
        path = Path(path)
        if path not in originals:
            originals[path] = (path.read_bytes(), path.stat().st_mode & 0o777) if path.exists() else None
            parent = path.parent
            while parent != root and not parent.exists():
                directories.add(parent)
                parent = parent.parent
    try:
        yield remember
    except BaseException:
        for path, original in reversed(originals.items()):
            if original is None:
                path.unlink(missing_ok=True)
            elif not path.exists() or path.read_bytes() != original[0]:
                write_text_atomic(path, original[0].decode('utf-8'), mode=original[1])
        for directory in sorted(directories, key=lambda item: len(item.parts), reverse=True):
            try:
                directory.rmdir()
            except OSError:
                pass
        raise


def _swarm_assets(root, name, definition, config, remember):
    member = definition['config']['agents']['type']
    agent = f'{name[:121]}-member'
    if member in config['types'] or definition_path(root, member).exists():
        raise ValueError(f'Swarm member type {member} already exists')
    template = resolve_package(root, 'builtin:leaderboard')['root']
    package = definition['config']['world']['package']
    files = {
        f'agents/{agent}/prompt.md': 'Pursue the supplied mission by proposing candidate artifacts.\n'
            'Use the world observation, task specification, and independent evaluator feedback.\n'
            'Do not claim success unless the evaluator has verified the required properties.\n',
    }
    for relative in ('world.json', 'view.mjs', 'component/Dockerfile', 'component/serve.py', 'component/evaluate.py'):
        files[f'{package}/{relative}'] = (template / relative).read_text(encoding='utf-8')
    # Docker repository components use lowercase names; hash the authoring name
    # so distinct case-sensitive worker names cannot silently share an image.
    import hashlib
    tag = hashlib.sha256(name.encode()).hexdigest()[:20]
    files[f'{package}/component/component.dcomp'] = f'docker asys-world-{tag}\n'
    for relative in files:
        if scoped_path(root, relative).exists():
            raise ValueError(f'Swarm asset already exists: {relative}')
    for relative, text in files.items():
        path = scoped_path(root, relative)
        remember(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        write_text_atomic(path, text, mode=0o644)
    config['types'][member] = {'command': ['/opt/asys/asys-workers/tools/asys-swarm-agent', '--agent', agent]}


def arguments(argv):
    kinds = '''Worker kinds:
  agent   One agent carrying out an assignment with tools and a saved session.
  goal    Implementation followed by independent verification; retries until
          verified or the configured attempt limit is reached.
  senate  A princeps senatus and senators with distinct professional roles
          deliberate on a request and produce a decision.
  swarm   Multiple agents explore a world with independently evaluated artifacts.
'''
    parser = argparse.ArgumentParser(prog='asys-workers', allow_abbrev=False,
        description='Create, inspect and edit named workers in an environment directory.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=kinds + '''
Examples:
  asys-workers list ./env/development
  asys-workers add ./env/development agent editor
  asys-workers describe ./env/development editor
  asys-workers edit ./env/development editor

Use "asys-workers COMMAND --help" for arguments and configuration details.
ENVIRONMENT is the directory containing Dockerfile, component.dcomp and
workers.json. Run a configured worker with:
  asys-run ENVIRONMENT NAME "Assignment to carry out"
''')
    commands = parser.add_subparsers(dest='command', required=True, metavar='COMMAND', title='commands')

    def command(name, summary, **kwargs):
        result = commands.add_parser(name, help=summary, description=summary,
            allow_abbrev=False, formatter_class=argparse.RawDescriptionHelpFormatter, **kwargs)
        result.add_argument('environment', type=Path, metavar='ENVIRONMENT',
            help='environment directory containing workers.json and worker assets')
        return result

    listing = command('list', 'List named workers, built-in workers and program types',
        epilog='Shows each worker name, kind and description. Built-ins appear unless\n'
               'the environment defines its own worker with the same name.\n\n'
               'Example: asys-workers list ./env/development --json')
    listing.add_argument('--json', action='store_true', help='Print structured definitions and command bindings')
    add = command('add', 'Create a named worker and its runtime binding',
        epilog=kinds + '''
Files and configuration:
  Every kind creates ENVIRONMENT/workers/NAME.json and adds a binding to
  workers.json. Missing Dockerfile, component.dcomp and workers.json are
  created. Existing files are preserved; an existing worker name is an error.

  agent   Also creates agents/NAME/prompt.md. Write the agent's instructions
          there. In workers/NAME.json, config.agent selects these assets;
          config.model and config.maxSteps optionally select a model and limit.
  goal    No agent prompt is required. Put the task in the run request.
          config.model selects a model; config.maxAttempts limits retries
          (unlimited when omitted).
  senate  Edit config.princeps and config.senators. Each participant has a
          unique name, optional prompt or agent assets, and optional model.
          Give senators professional roles, such as Seasoned engineer or
          Numerical analyst; preserve the princeps senatus's configured name.
  swarm   Also creates worlds/NAME/ (world definition, component, evaluator
          and view), a member prompt and a NAME-step command binding.
          Implement worlds/NAME/component/evaluate.py and configure
          config.world.settings before running. Set config.agents.count/type
          and config.limits.turns/decisions for the search. The starter
          evaluator rejects work until it is configured.

  Model defaults come from "asys system-model" in the selected state root.
  Use "asys-workers edit ENVIRONMENT NAME" to edit the definition with
  $VISUAL or $EDITOR; edit prompt and evaluator files in your editor.

Import:
  --file FILE reads a complete version-1 JSON definition containing version,
  kind and config (plus optional description). Its kind must match KIND.
  Supply any referenced world packages and other assets yourself; importing
  a swarm does not generate its world package.

Examples:
  asys-workers add ./env/development agent editor
  asys-workers add ./env/development goal repair
  asys-workers add ./env/development senate review
  asys-workers add ./env/development swarm search
  asys-workers add ./env/development senate review --file review.json
  asys-run ./env/development repair "Fix the parser and verify the tests"
''')
    add.add_argument('kind', choices=KINDS, metavar='KIND',
        help='worker behavior: agent, goal, senate or swarm (described below)')
    add.add_argument('name', metavar='NAME', help='unique worker name; used by asys-run and workflow job types')
    add.add_argument('--file', type=Path, metavar='FILE', help='import a complete JSON definition instead of the starter configuration')
    describe = command('describe', 'Print one worker definition and its runtime binding as JSON',
        epilog='Works for named workers, built-ins and ordinary program types.\n\n'
               'Example: asys-workers describe ./env/development review')
    describe.add_argument('name', metavar='NAME', help='worker name from asys-workers list')
    edit = command('edit', 'Edit and validate one worker using $VISUAL or $EDITOR',
        epilog='Edits workers/NAME.json for a named worker, or its command specification\n'
               'in workers.json for an ordinary program. Invalid edits leave the original\n'
               'configuration intact. Prompt files and world code are edited separately.\n\n'
               'Example: asys-workers edit ./env/development review')
    edit.add_argument('name', metavar='NAME', help='existing environment worker or program type to edit')
    return parser.parse_args(argv)


def _assets(environment, definition, *, write=True, remember=lambda path: None):
    config = definition['config']
    names = []
    if definition['kind'] == 'agent' and not config.get('system'):
        names.append(config['agent'])
    elif definition['kind'] == 'senate':
        names += [member['agent'] for member in [config['princeps'], *config['senators']] if 'agent' in member]
    paths = []
    for name in names:
        directory = scoped_path(environment, f'agents/{name}')
        if directory.exists() and not directory.is_dir():
            raise ValueError(f'Agent assets must be a directory: {name}')
        prompt = scoped_path(environment, f'agents/{name}/prompt.md')
        if prompt.exists() and not prompt.is_file():
            raise ValueError(f'Agent prompt must be a file: {name}')
        paths.append((directory, prompt))
    for directory, prompt in paths:
        if write and not prompt.exists():
            remember(prompt)
        if write:
            directory.mkdir(parents=True, exist_ok=True)
        if write and not prompt.exists():
            write_text_atomic(prompt, '', mode=0o644)


def add_worker(environment, kind, name, source=None):
    # Validate untrusted input and the destination name before scaffolding.
    definition = validate_definition(read_json(source)) if source is not None else initial_definition(kind, name)
    if definition['kind'] != kind:
        raise ValueError(f'Imported definition kind must be {kind}')
    destination = definition_path(environment, name)
    with authoring_lock(environment) as root:
        ensure_environment(root)
        config = environment_config(root)
        if destination.exists() or name in config['types']:
            raise ValueError(f'Worker {name} already exists')
        config = bind_definition(root, name, definition, write=False)
        bindings = scoped_path(root, 'workers.json')
        with _changes(root) as remember:
            if kind == 'swarm' and source is None:
                _swarm_assets(root, name, definition, config, remember)
            _assets(root, definition, remember=remember)
            remember(destination)
            destination.parent.mkdir(parents=True, exist_ok=True)
            write_json(destination, definition, mode=0o644)
            remember(bindings)
            write_json(bindings, config, mode=0o644)
    return destination


def worker_records(environment):
    config = environment_config(environment)
    definitions = list_definitions(environment)
    result = {name: {'name': name, 'kind': definitions[name]['kind'] if name in definitions else 'program',
                   **({'definition': definitions[name]} if name in definitions else {}),
                   **({'runtime': config['types'][name]} if name in config['types'] else {})}
            for name in sorted(set(config['types']) | set(definitions))}
    for name in BUILTINS:
        if name not in result:
            definition = builtin_definition(name)
            result[name] = {'name': name, 'kind': definition['kind'], 'definition': definition, 'builtin': True}
    return dict(sorted(result.items()))


def edit_worker(environment, name):
    destination = definition_path(environment, name)
    with authoring_lock(environment) as root:
        config = environment_config(root)
        if destination.exists():
            # Check the existing binding before accepting the edit.
            bind_definition(root, name, write=False)
            def validate(text):
                candidate = validate_definition(json.loads(text), root)
                _assets(root, candidate, write=False)
            with _changes(root) as remember:
                result = edit_validated(destination, validate, before_replace=lambda: remember(destination))
                definition = validate_definition(json.loads(result), root)
                _assets(root, definition, remember=remember)
                remember(scoped_path(root, 'workers.json'))
                bind_definition(root, name, definition)
        else:
            if name not in config['types']:
                raise ValueError(f'Unknown worker: {name}')
            # An ordinary program has no definition file; edit just its command
            # specification and keep every other runtime type unchanged.
            import tempfile
            with tempfile.TemporaryDirectory(prefix='.asys-worker-edit-', dir=root) as temporary:
                part = Path(temporary) / f'{name}.json'
                write_json(part, config['types'][name])
                result = edit_validated(part, lambda text: validate_types({name: json.loads(text)}, directory=root))
            config['types'][name] = json.loads(result)
            write_json(scoped_path(root, 'workers.json'), config)
    return destination if destination.exists() else root / 'workers.json'


def main(argv=None):
    args = arguments(sys.argv[1:] if argv is None else argv)
    try:
        if args.command == 'add':
            print(add_worker(args.environment, args.kind, args.name, args.file))
            if args.kind == 'swarm' and args.file is None:
                print(f'Before running, configure worlds/{args.name}/component/evaluate.py and the world settings.', file=sys.stderr)
        elif args.command == 'edit':
            print(edit_worker(args.environment, args.name))
        else:
            records = worker_records(args.environment)
            if args.command == 'describe':
                if args.name not in records:
                    raise ValueError(f'Unknown worker: {args.name}')
                print(json.dumps(records[args.name], indent=2, ensure_ascii=False))
            elif args.json:
                print(json.dumps(list(records.values()), indent=2, ensure_ascii=False))
            else:
                for name, record in records.items():
                    detail = record.get('definition', {}).get('description', '')
                    kind = record['kind'] + (' (built-in)' if record.get('builtin') else '')
                    print(f'{name}\t{kind}' + (f'\t{detail}' if detail else ''))
        return 0
    except (OSError, ValueError) as error:
        print(f'asys-workers: {error}', file=sys.stderr)
        return 1
