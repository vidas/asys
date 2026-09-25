"""Dispatch a named environment worker through the ordinary job contract."""
import argparse
from copy import deepcopy
import hashlib
import os
from pathlib import Path
import sys

from asys.worker_definitions import validate_definition
from asys_runtime.files import read_json, validate_name, write_json


TOOLS = Path(__file__).resolve().parent / 'tools'


def job_channels(identity):
    identity = validate_name('job ID', identity)
    # Reserve the hash prefix so a short literal ID cannot alias a longer ID's
    # compact form. Normal UUID and short job names retain readable channels.
    token = ('h-' + hashlib.sha256(identity.encode()).hexdigest()
             if len(identity) > 122 or identity.startswith('h-') else identity)
    return f'swarm-{token}', f'world-{token}'


def persist(path, value):
    """Recovery must use the same definition and public request."""
    if path.exists():
        if read_json(path) != value:
            raise ValueError(f'Worker recovery input differs: {path.name}')
    else:
        write_json(path, value)


def prepare(definition, payload, environment, *, model=None, definition_path=None):
    definition = validate_definition(definition, environment=environment['ASYS_ENVIRONMENT_DIR'])
    if (not isinstance(payload, dict) or set(payload) - {'request', 'parameters'}
            or not isinstance(payload.get('request'), str) or not payload['request'].strip()
            or '\0' in payload['request']):
        raise ValueError('Worker input must contain request text and optional parameters')
    parameters = payload.get('parameters', {})
    if not isinstance(parameters, dict):
        raise ValueError('Worker parameters must be an object')
    kind, config = definition['kind'], deepcopy(definition['config'])
    allowed = {'agent': {'maxSteps'}, 'goal': {'maxAttempts'}, 'senate': set(), 'swarm': set()}[kind]
    if set(parameters) - allowed:
        raise ValueError(f'Unsupported {kind} parameter(s): {", ".join(sorted(set(parameters) - allowed))}')
    for key, value in parameters.items():
        if type(value) is not int or not 1 <= value <= 2147483647:
            raise ValueError(f'parameters.{key} must be a positive integer at most 2147483647')
    config.update(parameters)
    if model is not None and (not isinstance(model, str) or not model.strip() or '\0' in model):
        raise ValueError('--model must be nonempty text without NUL')
    directory = Path(environment['ASYS_JOB_DIR']).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    env = dict(environment)
    command = [str(TOOLS / f'asys-{kind}')]
    metadata = {'version': 1, 'kind': kind, 'definition': str(definition_path) if definition_path else None}
    if kind == 'agent':
        # Named definitions select agent assets from the primary environment,
        # independently of the runtime's command configuration directory.
        env['ASYS_WORKERS_DIR'] = env['ASYS_ENVIRONMENT_DIR']
        adapted = {'prompt': payload['request']}
        if 'maxSteps' in config:
            adapted['maxSteps'] = config['maxSteps']
        command += ['--agent', config['agent']]
        if config.get('system'):
            command += ['--system-agent']
        if 'reasoning' in config:
            command += ['--reasoning', config['reasoning']]
    elif kind == 'goal':
        adapted = {'goal': payload['request']}
        if 'maxAttempts' in config:
            adapted['maxAttempts'] = config['maxAttempts']
    elif kind == 'senate':
        adapted = {'topic': payload['request'], 'senate': config}
    else:
        identity = validate_name('job ID', environment['ASYS_JOB_ID'])
        config['mission'] = payload['request']
        control, world = job_channels(identity)
        validate_name('control channel', control)
        validate_name('world channel', world)
        config['world']['channel'] = world
        adapted = {'id': identity, 'channel': control, 'config': config}
        metadata.update(control_channel=control, world_channel=world,
                        swarm_state=f'jobs/{identity}/swarm', world_package=config['world']['package'])
        from asys_swarm.world_binding import world_binding
        binding = world_binding(config, env)
        previous = directory / 'worker.json'
        # A recovered job keeps the renderer that matches its recorded frames.
        # Jobs created after an environment refresh select the new generation.
        generation = (read_json(previous).get('world_view') if previous.exists()
                      else binding.get('view'))
        if generation is not None:
            metadata['world_view'] = generation
    selected_model = model if model is not None else config.get('model')
    if selected_model is not None:
        if kind == 'swarm':
            model_path = directory / 'worker-models.json'
            defaults = Path(env.get('ASYS_SYSTEM_MODELS', '/etc/asys/system-models.json'))
            models = read_json(defaults) if defaults.exists() else {}
            if not isinstance(models, dict):
                raise ValueError('System model settings must be an object')
            persist(model_path, {**models, 'simple': selected_model})
            env['ASYS_SYSTEM_MODELS'] = str(model_path)
        else:
            command += ['--model', selected_model]
    metadata['model'] = selected_model
    persist(directory / 'worker-definition.json', definition)
    persist(directory / 'worker.json', metadata)
    path = directory / 'worker-input.json'
    persist(path, adapted)
    env['ASYS_INPUT'] = str(path)
    return command, env


def main(argv=None, *, environment=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--definition', required=True)
    parser.add_argument('--model')
    args = parser.parse_args(argv)
    environment = dict(os.environ if environment is None else environment)
    try:
        command, environment = prepare(read_json(args.definition), read_json(environment['ASYS_INPUT']),
                                       environment, model=args.model, definition_path=args.definition)
        # Replace the dispatcher: the selected algorithm remains the one outer
        # runtime process and receives its usual cancellation signals directly.
        os.execvpe(command[0], command, environment)
    except Exception as error:
        result = {'final': str(error) or 'Worker definition could not run.',
                  'exception': f'{type(error).__name__}: {error}'}
        if environment.get('ASYS_RESULT'):
            write_json(environment['ASYS_RESULT'], result)
        print(result['exception'], file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
