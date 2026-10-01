"""asys workflow serve: the editing model behind workflow viewers.

One JSON request per line on stdin, one JSON response per line on stdout. A
session holds one workflow file. Every edit changes the round-trip YAML
document, so comments and order survive; every response carries the new
graph, the validation problems and the text, so a viewer never re-derives them.

Requests (`id` is echoed back):
  {"op": "load", "file": PATH, "environment": DIR?}
  {"op": "set", "step": PATH, "key": "input.request", "value": JSON}   null deletes
  {"op": "add", "scope": PATH, "name": NAME, "step": JSON}
  {"op": "remove", "step": PATH}
  {"op": "rename", "step": PATH, "to": NAME}
  {"op": "connect", "step": PATH, "key": "next"|"on_error"|..., "to": NAME}
  {"op": "undo"} {"op": "redo"} {"op": "save"} {"op": "check"}
  {"op": "inspect", "step": PATH}          the step's own fields, without the graph

Following a run (read-only; the graph is the run's saved document):
  {"op": "open", "run": DIRECTORY|ID, "root": STATE?}   graph, run status, step states
  {"op": "poll"}                                         run status, step states
  {"op": "step", "step": PATH}                           the step's jobs, results and logs
"""
import io
import json
from pathlib import Path
import sys

from . import flow, flow_layout
from .flow_runs import RunView

TARGET_KEYS = {'next', 'on_error', 'on_timeout', 'join', 'default', 'undo'}


class EditError(ValueError):
    pass


class Session:
    def __init__(self):
        self.workflow = None
        self.run = None           # a run being followed, instead of or beside a file
        self.environment = None
        self.kinds = None
        self.saved = None
        self.past, self.future = [], []

    # Requests

    def load(self, file, environment=None):
        self.workflow = flow.load_all(file)
        self.environment = Path(environment).expanduser().resolve() if environment else None
        self.kinds = flow.worker_kinds(self.environment) if self.environment else None
        self.saved = self.text()
        self.past, self.future = [], []

    def set(self, step, key, value):
        target = self._step(step)
        keys = key.split('.')
        container = target
        for part in keys[:-1]:
            if not isinstance(container.get(part), dict):
                if value is None:
                    return
                container[part] = {}
            container = container[part]
        if value is None:
            container.pop(keys[-1], None)
        else:
            container[keys[-1]] = value

    def add(self, scope, name, step):
        steps = self._scope(scope)
        if not flow.STEP_ID.match(name or ''):
            raise EditError(f'{name!r} is not a step ID')
        if name in steps:
            raise EditError(f'{name} already exists')
        if not isinstance(step, dict):
            raise EditError('a step is a JSON object')
        steps[name] = step

    def remove(self, step):
        steps, name = self._locate(step)
        del steps[name]
        for other in steps.values():
            if not isinstance(other, dict):
                continue
            for key in TARGET_KEYS:
                if other.get(key) == name:
                    del other[key]
            if isinstance(other.get('parallel'), list) and name in other['parallel']:
                other['parallel'].remove(name)
            if isinstance(other.get('switch'), list):
                for case in [case for case in other['switch'] if isinstance(case, dict) and case.get('next') == name]:
                    other['switch'].remove(case)
            choose = other.get('choose')
            if isinstance(choose, dict) and name in choose.get('actions', []):
                choose['actions'].remove(name)

    def rename(self, step, to):
        steps, name = self._locate(step)
        if not flow.STEP_ID.match(to or ''):
            raise EditError(f'{to!r} is not a step ID')
        if to in steps:
            raise EditError(f'{to} already exists')
        position = list(steps).index(name)
        value = steps.pop(name)
        steps.insert(position, to, value)
        owner = self._owner(step)
        if owner is not None and owner.get('start') == name:
            owner['start'] = to
        for other in steps.values():
            if not isinstance(other, dict):
                continue
            for key in TARGET_KEYS:
                if other.get(key) == name:
                    other[key] = to
            if isinstance(other.get('parallel'), list):
                other['parallel'][:] = [to if item == name else item for item in other['parallel']]
            for case in other.get('switch') or []:
                if isinstance(case, dict) and case.get('next') == name:
                    case['next'] = to
            choose = other.get('choose')
            if isinstance(choose, dict) and isinstance(choose.get('actions'), list):
                choose['actions'][:] = [to if item == name else item for item in choose['actions']]
        # Results are read by name everywhere the step is visible: this scope,
        # the groups inside it, and the file's output.
        for _, other in flow._all_steps(steps):
            for key in ('input', 'args', 'for_each'):
                if key in other:
                    other[key] = flow.rename_in_value(other[key], name, to)
            if 'until' in other:
                other['until'] = flow.rename_in_value(other['until'], name, to, bare=True)
            choose = other.get('choose')
            if isinstance(choose, dict):
                if 'input' in choose:
                    choose['input'] = flow.rename_in_value(choose['input'], name, to)
                if 'until' in choose:
                    choose['until'] = flow.rename_in_value(choose['until'], name, to, bare=True)
            repeat = other.get('repeat')
            if isinstance(repeat, dict) and 'until' in repeat:
                repeat['until'] = flow.rename_in_value(repeat['until'], name, to, bare=True)
            for case in other.get('switch') or []:
                if isinstance(case, dict) and 'when' in case:
                    case['when'] = flow.rename_in_value(case['when'], name, to, bare=True)
        if owner is self.workflow.data and 'output' in owner:
            owner['output'] = flow.rename_in_value(owner['output'], name, to, bare=True)

    def connect(self, step, key, to):
        steps, name = self._locate(step)
        if to not in steps:
            raise EditError(f'{to} is not a step of this scope')
        target = steps[name]
        if key in TARGET_KEYS:
            target[key] = to
        elif key == 'branch':
            target.setdefault('parallel', [])
            if to not in target['parallel']:
                target['parallel'].append(to)
        else:
            raise EditError(f'cannot connect {key}')

    def save(self):
        text = self.text()
        path = self.workflow.path
        temporary = path.with_name(f'.{path.name}.tmp')
        temporary.write_text(text, encoding='utf-8')
        temporary.replace(path)
        self.saved = text

    # Undo keeps whole-document snapshots: edits are small and documents short.

    def edit(self, change):
        before = self.text()
        try:
            change()
        except Exception:
            self._replace(before)  # a failed edit leaves the document as it was
            raise
        if self.text() != before:
            self.past.append(before)
            self.future.clear()

    def undo(self):
        if not self.past:
            raise EditError('nothing to undo')
        self.future.append(self.text())
        self._replace(self.past.pop())

    def redo(self):
        if not self.future:
            raise EditError('nothing to redo')
        self.past.append(self.text())
        self._replace(self.future.pop())

    def state(self):
        problems = flow.check(self.workflow, self.environment) if self.workflow else []
        return {'graph': flow_layout.graph(self.workflow, self.kinds), 'problems': problems,
                'text': self.text(), 'file': str(self.workflow.path), 'dirty': self.text() != self.saved,
                'canUndo': bool(self.past), 'canRedo': bool(self.future)}

    def text(self):
        stream = io.StringIO()
        flow.yaml().dump(self.workflow.data, stream)
        return stream.getvalue()

    # Addressing: a step path is NAME, GROUP/NAME, or REPEAT/step.

    def _replace(self, text):
        self.workflow.data = flow.yaml().load(text)

    def _scope(self, scope):
        if not scope:
            return self.workflow.steps
        holder = self._step(scope)
        if isinstance(holder.get('group'), dict):
            return holder['group'].setdefault('steps', {})
        raise EditError(f'{scope} is not a group')

    def _locate(self, path):
        parts = path.split('/')
        steps = self.workflow.steps
        for part in parts[:-1]:
            holder = steps.get(part)
            if isinstance(holder, dict) and isinstance(holder.get('group'), dict):
                steps = holder['group'].get('steps', {})
            elif isinstance(holder, dict) and isinstance(holder.get('repeat'), dict):
                steps = holder['repeat']
            else:
                raise EditError(f'no step {path}')
        if parts[-1] not in steps:
            raise EditError(f'no step {path}')
        return steps, parts[-1]

    def _step(self, path):
        steps, name = self._locate(path)
        if not isinstance(steps[name], dict):
            raise EditError(f'{path} is not a step')
        return steps[name]

    def _owner(self, path):
        """The mapping that holds `start` for the scope of PATH."""
        parts = path.split('/')
        if len(parts) == 1:
            return self.workflow.data
        holder = self._step('/'.join(parts[:-1]))
        return holder.get('group') if isinstance(holder.get('group'), dict) else None


def handle(session, request):
    op = request.get('op')
    if op == 'open':
        session.run = RunView(request['run'], request.get('root'))
        return {'graph': session.run.graph(), **session.run.poll()}
    if op in {'poll', 'step'}:
        if session.run is None:
            raise EditError('open a run first')
        return session.run.poll() if op == 'poll' else session.run.step(request['step'])
    if op == 'load':
        session.load(request['file'], request.get('environment'))
    elif session.workflow is None:
        raise EditError('load a workflow first')
    elif op in {'set', 'add', 'remove', 'rename', 'connect'}:
        arguments = {key: value for key, value in request.items() if key not in {'op', 'id'}}
        session.edit(lambda: getattr(session, op)(**arguments))
    elif op in {'undo', 'redo', 'save'}:
        getattr(session, op)()
    elif op == 'inspect':
        # A step's own fields, as plain JSON in document order, for an inspector.
        return {'step': request['step'], 'data': json.loads(json.dumps(session._step(request['step']), default=str))}
    elif op != 'check':
        raise EditError(f'unknown request {op!r}')
    return session.state()


def serve(stdin=sys.stdin, stdout=sys.stdout):
    session = Session()
    for line in stdin:
        if not line.strip():
            continue
        request = {}
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise EditError('a request is a JSON object')
            response = {'ok': True, **handle(session, request)}
        except (EditError, ValueError, OSError, KeyError, TypeError) as error:
            response = {'ok': False, 'error': str(error) or type(error).__name__}
        response['id'] = request.get('id') if isinstance(request, dict) else None
        stdout.write(json.dumps(response, default=str) + '\n')
        stdout.flush()
