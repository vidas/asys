"""Workflow files (workflow/1): load, resolve calls and validate.

A workflow is YAML whose steps name the environment's worker types. Loading
keeps the round-trip document, so editors can change it without losing
comments or order. Validation collects every problem with its location instead
of stopping at the first; see docs/workflow-design.md for the format.
"""
import json
import os
from pathlib import Path
import re

from ruamel.yaml import YAML
from ruamel.yaml.error import YAMLError

FORMAT = 'workflow/1'
KINDS = ('run', 'parallel', 'group', 'call', 'switch', 'repeat', 'choose', 'wait', 'delay', 'compensate', 'end')
COMMON = {'next', 'on_error', 'timeout', 'on_timeout', 'undo', 'description'}
# result: a shared name the step's result is also stored under, as several
# steps may update one ledger (BPMN's asys:job result attribute).
FIELDS = {
    'run': {'input', 'args', 'for_each', 'as', 'sequential', 'until', 'result'},
    'parallel': {'join'},
    'group': {'for_each', 'as', 'sequential', 'until', 'result'},
    'call': {'input', 'for_each', 'as', 'sequential', 'until', 'result'},
    'switch': {'default'},
    'repeat': {'result'},
    'choose': {'result'},
    'wait': {'result'},
    'delay': set(),
    'compensate': set(),
    'end': set(),
}
CHOOSE = {'coordinator', 'actions', 'input', 'sequential', 'until'}
# Kinds that never continue with `next`: they route by their own keys.
NO_NEXT = {'parallel', 'switch', 'end'}
STEP_ID = re.compile(r'^[a-z][a-z0-9_]*$')
DURATION = re.compile(r'^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$')
MAX_CALL_DEPTH = 16
FEEL_WORDS = {'and', 'or', 'not', 'if', 'then', 'else', 'for', 'in', 'return', 'some', 'every', 'satisfies',
              'true', 'false', 'null', 'between', 'instance', 'of', 'function', 'date', 'time', 'duration'}
# FEEL built-ins whose names contain spaces.
FEEL_FUNCTIONS = {'string length', 'upper case', 'lower case', 'substring before', 'substring after', 'starts with',
                  'ends with', 'list contains', 'insert before', 'index of', 'distinct values', 'get value',
                  'get entries', 'context put', 'context merge', 'date and time', 'years and months duration',
                  'day of year', 'day of week', 'month of year', 'week of year', 'is defined', 'get or else',
                  'string join', 'round up', 'round down', 'round half up', 'round half down', 'last day of month'}
NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_]*')


class Problem(dict):
    """One validation finding: the file, the location inside it and a message."""
    def __str__(self):
        return f"{self['file']}: {self['at']}: {self['message']}" if self['at'] else f"{self['file']}: {self['message']}"


class Workflow:
    def __init__(self, path, data, text):
        self.path = Path(path)
        self.data = data
        self.text = text
        self.calls = {}           # call target as written -> Workflow

    @property
    def steps(self):
        steps = self.data.get('steps') if isinstance(self.data, dict) else None
        return steps if isinstance(steps, dict) else {}


def yaml():
    loader = YAML(typ='rt')
    loader.preserve_quotes = True
    loader.width = 100
    return loader


def load(path):
    """Read one file without following calls; malformed YAML raises ValueError."""
    path = Path(path).expanduser().resolve()
    text = path.read_text(encoding='utf-8')
    try:
        data = yaml().load(text)
    except YAMLError as error:
        raise ValueError(f'{path}: {error}') from error
    return Workflow(path, data, text)


def load_all(path, problems=None):
    """Load a workflow and every file it calls; problems collects unreadable calls."""
    problems = [] if problems is None else problems
    root = load(path)
    seen = {root.path: root}

    def follow(workflow, chain):
        for at, step in _all_steps(workflow.steps):
            target = step.get('call') if isinstance(step, dict) else None
            if not isinstance(target, str):
                continue
            called = (workflow.path.parent / target).resolve()
            if len(chain) >= MAX_CALL_DEPTH:
                problems.append(_problem(workflow, at, f'calls nest deeper than {MAX_CALL_DEPTH}'))
                continue
            if called not in seen:
                try:
                    seen[called] = load(called)
                except (OSError, ValueError) as error:
                    problems.append(_problem(workflow, at + '.call', f'cannot load {target}: {error}'))
                    continue
            workflow.calls[target] = seen[called]
            if called not in chain:
                follow(seen[called], chain + [called])
    follow(root, [root.path])
    return root


def resolved(workflow):
    """The document a run executes: every file, with its calls as file keys.

    Keys are paths relative to the root file's directory. The run keeps this
    copy, so resume and upgrade never read a file that changed since.
    """
    base = workflow.path.parent

    def key(each):
        return Path(os.path.relpath(each.path, base)).as_posix()
    files, pending = {}, [workflow]
    while pending:
        current = pending.pop()
        if key(current) in files:
            continue
        files[key(current)] = {'data': json.loads(json.dumps(current.data, default=str)),
                               'calls': {ref: key(called) for ref, called in current.calls.items()}}
        pending.extend(current.calls.values())
    return {'root': key(workflow), 'files': files}


def check(workflow, environment=None):
    """Return every problem in WORKFLOW and the files it calls."""
    kinds = worker_kinds(environment) if environment is not None else None
    problems = []
    for document in _documents(workflow):
        problems += _check_document(document, kinds)
    if kinds is not None:
        problems += check_switch_choices(workflow, kinds)
    return problems


def worker_kinds(environment):
    """Map each worker type of ENVIRONMENT to agent, goal, senate, swarm, program or human."""
    from asys_runtime.environment import Environment
    from asys_runtime.files import read_json
    from .worker_definitions import definition_path
    env = Environment(environment)
    kinds = {}
    for name, spec in env.types.items():
        command = [str(part) for part in spec.get('command', [])]
        if '--definition' in command[:-1]:
            # Only the declared kind matters here; asys-workers validates the rest.
            definition = Path(command[command.index('--definition') + 1]).stem
            try:
                kind = read_json(definition_path(env.directory, definition)).get('kind')
            except (OSError, ValueError, AttributeError):
                kind = None
            kinds[name] = kind if isinstance(kind, str) else 'unknown'
        elif command and command[0].endswith('asys-human'):
            kinds[name] = 'human'
        else:
            kinds[name] = 'program'
    return kinds


def references(expression):
    """(start, end, name) for each root name EXPRESSION reads from its context.

    `review.final` reads `review`. Not references: strings, `.field` paths,
    function names (including FEEL's multi-word ones), context keys
    (`{key: ...}`), names bound by for, some and every, and names inside a
    filter (`list[approved = false]`), which FEEL resolves against each item.
    """
    tokens = [(match.start(), match.end(), match.group())
              for match in re.finditer(r'"(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_]*|\.\.|\S', expression)]
    found, bound, brackets = [], set(), []
    index = 0
    while index < len(tokens):
        start, end, token = tokens[index]
        before = tokens[index - 1][2] if index else ''
        if token == '[':
            # A filter follows a value; a list literal follows an operator.
            brackets.append(before in (')', ']', '}') or (NAME.fullmatch(before) and before not in FEEL_WORDS))
        elif token == ']' and brackets:
            brackets.pop()
        elif NAME.fullmatch(token):
            words = _function_words(tokens, index)
            if words:
                index += words
                continue
            after = tokens[index + 1][2] if index + 1 < len(tokens) else ''
            if before in ('for', 'some', 'every'):
                bound.add(token)
            elif not (before == '.' or after in ('(', ':') or any(brackets) or token in bound or token in FEEL_WORDS):
                found.append((start, end, token))
        index += 1
    return found


def _function_words(tokens, index):
    """How many name tokens from INDEX form a function name before `(`, or 0."""
    for size in range(4, 0, -1):
        words = tokens[index:index + size]
        if len(words) == size and index + size < len(tokens) and tokens[index + size][2] == '(' \
                and all(NAME.fullmatch(word[2]) for word in words) \
                and (size == 1 or ' '.join(word[2] for word in words) in FEEL_FUNCTIONS):
            return size
    return 0


def expression_names(expression):
    """Root names an expression reads: `review.final` reads `review`."""
    return {name for _, _, name in references(expression)}


def rename_name(expression, old, new):
    """EXPRESSION reading NEW wherever it read the root name OLD."""
    for start, end, name in reversed(references(expression)):
        if name == old:
            expression = expression[:start] + new + expression[end:]
    return expression


def spans(text):
    """(start, end, expression) for each `${...}` in TEXT.

    Braces nest, so `${{a: 1}}` holds a FEEL context, and quoted strings may
    contain any character. An unclosed `${` is plain text.
    """
    found, position = [], 0
    while (start := text.find('${', position)) >= 0:
        depth, index, quoted = 1, start + 2, False
        while index < len(text) and depth:
            char = text[index]
            if quoted:
                if char == '\\':
                    index += 1
                elif char == '"':
                    quoted = False
            elif char == '"':
                quoted = True
            elif char == '{':
                depth += 1
            elif char == '}':
                depth -= 1
            index += 1
        if depth:
            break
        found.append((start, index, text[start + 2:index - 1]))
        position = index
    return found


def rename_in_value(value, old, new, *, bare=False):
    """Rename a step's references in a field: `${...}` in text, or a bare expression."""
    if isinstance(value, str):
        found = spans(value)
        if bare and not found:
            return rename_name(value, old, new)
        text, last = [], 0
        for start, end, expression in found:
            text += [value[last:start], '${', rename_name(expression, old, new), '}']
            last = end
        return ''.join(text) + value[last:]
    if isinstance(value, dict):
        for key in value:
            value[key] = rename_in_value(value[key], old, new)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            value[index] = rename_in_value(item, old, new)
    return value


def interpolations(value):
    """Every `${...}` expression inside a string, or nested in lists and maps."""
    if isinstance(value, str):
        return [expression for _, _, expression in spans(value)]
    if isinstance(value, dict):
        return [found for item in value.values() for found in interpolations(item)]
    if isinstance(value, list):
        return [found for item in value for found in interpolations(item)]
    return []


def _documents(workflow):
    seen, order = set(), []

    def visit(document):
        if document.path in seen:
            return
        seen.add(document.path)
        order.append(document)
        for called in document.calls.values():
            visit(called)
    visit(workflow)
    return order


def _check_document(document, kinds):
    problems = []
    data = document.data

    def report(at, message):
        problems.append(_problem(document, at, message))

    if not isinstance(data, dict):
        report('', 'a workflow file is a YAML mapping')
        return problems
    if data.get('asys') != FORMAT:
        report('asys', f'expected asys: {FORMAT}')
    for key in data:
        if key not in {'asys', 'name', 'description', 'inputs', 'start', 'steps', 'output'}:
            report(str(key), 'unknown key')
    inputs = data.get('inputs', {'request': {'type': 'string'}})
    if not isinstance(inputs, dict) or not all(isinstance(value, dict) for value in inputs.values()):
        report('inputs', 'inputs maps each name to a JSON Schema')
        inputs = {}
    if not isinstance(data.get('steps'), dict) or not data['steps']:
        report('steps', 'a workflow needs steps')
        return problems
    visible = set(inputs)
    _check_scope(document, 'steps', data['steps'], data.get('start'), 'start', visible, kinds, report, top=True)
    if 'output' in data:
        _check_expression(str(data['output']), visible | set(_scope_names(data['steps'])), 'output', report)
    return problems


def _check_scope(document, at, steps, start, start_at, outer, kinds, report, *, top):
    """Check one scope: the workflow's steps or a group's."""
    for name in steps:
        if not isinstance(name, str) or not STEP_ID.match(name):
            report(f'{at}.{name}', 'step IDs are lowercase letters, digits and underscores, starting with a letter')
        elif name in outer:
            report(f'{at}.{name}', f'{name} is already a name in an enclosing scope')
    if start not in steps:
        report(start_at, f'start must name a step of this scope (found {start!r})')
    shared = {step['result'] for step in steps.values() if isinstance(step, dict) and isinstance(step.get('result'), str)}
    visible = outer | set(steps) | shared
    referenced = {'branch': set(), 'action': set(), 'undo': set()}
    # Actions run at a coordinator's request and read its input as `message`.
    actions = {action for step in steps.values() if isinstance(step, dict) and isinstance(step.get('choose'), dict)
               for action in step['choose'].get('actions') or [] if isinstance(action, str)}

    def target(where, name):
        if name not in steps:
            report(where, f'{name!r} is not a step of this scope')

    for name, step in steps.items():
        where = f'{at}.{name}'
        if not isinstance(step, dict):
            report(where, 'a step is a mapping')
            continue
        present = [kind for kind in KINDS if kind in step]
        if len(present) != 1:
            report(where, f'a step has exactly one of: {", ".join(KINDS)}')
            continue
        kind = present[0]
        for key in step:
            if key != kind and key not in COMMON | FIELDS[kind]:
                report(f'{where}.{key}', f'not a key of a {kind} step')
        if kind in NO_NEXT and 'next' in step:
            report(f'{where}.next', f'a {kind} step does not take next')
        for key in ('next', 'on_error', 'on_timeout'):
            if key in step:
                target(f'{where}.{key}', step[key])
        if 'result' in step and (not isinstance(step['result'], str) or not STEP_ID.match(step['result'])
                                 or step['result'] in {'request', 'item', 'index', 'message'}):
            report(f'{where}.result', 'result is a name: lowercase letters, digits and _, and not request, item, '
                                      'index or message')
        if 'undo' in step:
            target(f'{where}.undo', step['undo'])
            referenced['undo'].add(step['undo'])
        if 'timeout' in step and not _duration(step['timeout']):
            report(f'{where}.timeout', 'an ISO 8601 duration such as PT30M or P2D')
        if 'on_timeout' in step and 'timeout' not in step:
            report(f'{where}.on_timeout', 'on_timeout needs timeout')
        local = set(visible) | ({'message'} if name in actions else set())
        if 'for_each' in step:
            local |= {step.get('as', 'item'), 'index'}
            for expression in _expressions(step['for_each']):
                _check_expression(expression, visible, f'{where}.for_each', report)
        if 'until' in step:
            _check_expression(_bare(step['until']), local | {name}, f'{where}.until', report)
        for key in ('input', 'args'):
            for expression in interpolations(step.get(key, {})):
                _check_expression(expression, local, f'{where}.{key}', report)
        _check_kind(document, kind, step, where, steps, local, kinds, referenced, report, target)
    if top:
        # Branches, actions and undo steps finish where they are used; every
        # other top-level step must say where the run continues.
        finishing = referenced['branch'] | referenced['action'] | referenced['undo']
        for name, step in steps.items():
            if (isinstance(step, dict) and name not in finishing and 'next' not in step
                    and not any(kind in step for kind in NO_NEXT)):
                report(f'{at}.{name}', 'a top-level step needs next, or must be an end')
    _check_reachable(at, steps, start, referenced, report)


def _check_kind(document, kind, step, where, steps, visible, kinds, referenced, report, target):
    value = step[kind]
    if kind == 'run':
        if not isinstance(value, str):
            report(f'{where}.run', 'run names a worker type')
        elif kinds is not None and value not in kinds:
            report(f'{where}.run', f'the environment has no worker type {value!r}')
        elif kinds is not None and 'args' in step and kinds[value] != 'program':
            report(f'{where}.args', f'args apply to programs; {value} is {kinds[value]}')
        if 'args' in step and not isinstance(step['args'], list):
            report(f'{where}.args', 'args is a list')
        if kinds is not None and kinds.get(value) == 'human':
            _check_form(document, step, where, report)
    elif kind == 'parallel':
        if not isinstance(value, list) or len(value) < 2:
            report(f'{where}.parallel', 'parallel lists at least two branches')
            value = value if isinstance(value, list) else []
        for branch in value:
            target(f'{where}.parallel', branch)
            referenced['branch'].add(branch)
            if isinstance(steps.get(branch), dict) and 'next' in steps[branch]:
                report(f'{where}.parallel', f'branch {branch} ends at the join; remove its next')
        if 'join' not in step:
            report(where, 'parallel needs join')
        else:
            target(f'{where}.join', step['join'])
    elif kind == 'group':
        if not isinstance(value, dict) or not isinstance(value.get('steps'), dict):
            report(f'{where}.group', 'group has start and steps')
            return
        _check_scope(document, f'{where}.group.steps', value['steps'], value.get('start'), f'{where}.group.start',
                     visible, kinds, report, top=False)
    elif kind == 'call':
        if not isinstance(value, str):
            report(f'{where}.call', 'call names a workflow file')
            return
        called = document.calls.get(value)
        if called is not None:
            _check_call_input(called, step.get('input', {}), where, report)
    elif kind == 'switch':
        if not isinstance(value, list) or not value:
            report(f'{where}.switch', 'switch lists cases with when and next')
            value = []
        for index, case in enumerate(value):
            if not isinstance(case, dict) or set(case) != {'when', 'next'}:
                report(f'{where}.switch[{index}]', 'a case has exactly when and next')
                continue
            _check_expression(str(case['when']), visible, f'{where}.switch[{index}].when', report)
            target(f'{where}.switch[{index}].next', case['next'])
        if 'default' not in step:
            report(where, 'switch needs default')
        else:
            target(f'{where}.default', step['default'])
    elif kind == 'repeat':
        if not isinstance(value, dict) or 'step' not in value or not ({'until', 'max'} & set(value)):
            report(f'{where}.repeat', 'repeat has step and until or max')
            return
        inner = value['step']
        if not isinstance(inner, dict) or not ({'run', 'group', 'call'} & set(inner)):
            report(f'{where}.repeat.step', 'the repeated step is a run, group or call')
        else:
            _check_scope(document, f'{where}.repeat', {'step': inner}, 'step', f'{where}.repeat',
                         visible, kinds, report, top=False)
        if 'until' in value:
            _check_expression(_bare(value['until']), visible | {'step'}, f'{where}.repeat.until', report)
        if 'max' in value and (not isinstance(value['max'], int) or value['max'] < 1):
            report(f'{where}.repeat.max', 'max is a positive integer')
    elif kind == 'choose':
        if not isinstance(value, dict) or 'coordinator' not in value or not isinstance(value.get('actions'), list) \
                or not value['actions']:
            report(f'{where}.choose', 'choose has coordinator and actions')
            return
        for key in set(value) - CHOOSE:
            report(f'{where}.choose.{key}', 'not a key of choose')
        for expression in interpolations(value.get('input', {})):
            _check_expression(expression, visible, f'{where}.choose.input', report)
        if 'until' in value:
            _check_expression(_bare(value['until']), visible, f'{where}.choose.until', report)
        if kinds is not None and value['coordinator'] not in kinds:
            report(f'{where}.choose.coordinator', f'the environment has no worker type {value["coordinator"]!r}')
        for action in value['actions']:
            target(f'{where}.choose.actions', action)
            referenced['action'].add(action)
    elif kind == 'wait':
        if not isinstance(value, str) or not value:
            report(f'{where}.wait', 'wait names a message')
    elif kind == 'delay':
        if not _duration(value):
            report(f'{where}.delay', 'an ISO 8601 duration such as PT10M')
    elif kind == 'compensate':
        if value != 'all':
            target(f'{where}.compensate', value)
    elif kind == 'end':
        if not isinstance(value, str) or not value:
            report(f'{where}.end', 'end gives a label')


def _check_reachable(at, steps, start, referenced, report):
    edges = {}
    for name, step in steps.items():
        if not isinstance(step, dict):
            continue
        targets = [step.get(key) for key in ('next', 'on_error', 'on_timeout', 'join', 'default')]
        targets += step.get('parallel') or [] if isinstance(step.get('parallel'), list) else []
        targets += [case.get('next') for case in step.get('switch') or [] if isinstance(case, dict)]
        choose = step.get('choose')
        targets += choose.get('actions', []) if isinstance(choose, dict) else []
        targets.append(step.get('undo'))
        edges[name] = [target for target in targets if target in steps]
    seen, pending = set(), [start] if start in steps else []
    while pending:
        name = pending.pop()
        if name not in seen:
            seen.add(name)
            pending += edges.get(name, [])
    for name in steps:
        if name not in seen:
            report(f'{at}.{name}', 'no path from start reaches this step')


def _check_expression(expression, visible, where, report):
    unknown = sorted(expression_names(expression) - set(visible))
    if unknown:
        report(where, f'unknown name {", ".join(unknown)} in {expression!r}')


def _check_call_input(called, given, where, report):
    expected = called.data.get('inputs', {'request': {'type': 'string'}}) if isinstance(called.data, dict) else {}
    if not isinstance(given, dict) or not isinstance(expected, dict):
        return
    for name in given:
        if name not in expected:
            report(f'{where}.input.{name}', f'{called.path.name} has no input {name}')
    for name in expected:
        if name not in given:
            report(f'{where}.input', f'{called.path.name} needs input {name}')


def _form(document, step):
    """A human step's form: (schema, None), (None, error), or (None, None) when it has none.

    A form is a JSON Schema, inline or in a file beside the workflow.
    """
    form = (step.get('input') or {}).get('form') if isinstance(step.get('input'), dict) else None
    if isinstance(form, dict):
        return form, None
    if not isinstance(form, str) or form.startswith('${'):
        return None, None
    try:
        return json.loads((document.path.parent / form).read_text(encoding='utf-8')), None
    except (OSError, ValueError) as error:
        return None, f'cannot read form {form}: {error}'


def _check_form(document, step, where, report):
    schema, error = _form(document, step)
    if error:
        report(f'{where}.input.form', error)
    elif schema is not None and not isinstance(schema, dict):
        report(f'{where}.input.form', 'a form is a JSON Schema: a mapping')


def form_choices(document, step):
    """Allowed values of each field of a human step's form, where it enumerates them."""
    schema, _ = _form(document, step)
    if not isinstance(schema, dict):
        return {}
    choices = {}
    for field, spec in (schema.get('properties') or {}).items():
        values = spec.get('enum') or [option.get('const') for option in spec.get('oneOf', []) if 'const' in option]
        if values:
            choices[field] = set(values)
    return choices


def check_switch_choices(workflow, kinds):
    """A switch comparing a human answer with a literal must use a value its form allows."""
    problems = []
    for document in _documents(workflow):
        for at, step in _all_steps(document.steps):
            for index, case in enumerate(step.get('switch') or []):
                if not isinstance(case, dict):
                    continue
                for source, field, literal in re.findall(r'\b([a-z][a-z0-9_]*)\.([A-Za-z_]\w*)\s*=\s*"([^"]*)"',
                                                          str(case.get('when', ''))):
                    human = _find_step(document.steps, source)
                    if not human or kinds.get(human.get('run')) != 'human':
                        continue
                    allowed = form_choices(document, human).get(field)
                    if allowed is not None and literal not in allowed:
                        problems.append(_problem(document, f'{at}.switch[{index}].when',
                                                 f'{source}.{field} is never {literal!r}; the form allows '
                                                 + ', '.join(sorted(map(str, allowed)))))
    return problems


def _find_step(steps, name):
    found = steps.get(name)
    if isinstance(found, dict):
        return found
    for _, step in _all_steps(steps):
        group = step.get('group')
        if isinstance(group, dict) and isinstance(group.get('steps'), dict) and name in group['steps']:
            return group['steps'][name]
    return None


def _all_steps(steps, at='steps'):
    """Every step mapping, including those in groups and repeats, with its location."""
    if not isinstance(steps, dict):
        return
    for name, step in steps.items():
        if not isinstance(step, dict):
            continue
        where = f'{at}.{name}'
        yield where, step
        group = step.get('group')
        if isinstance(group, dict):
            yield from _all_steps(group.get('steps'), f'{where}.group.steps')
        repeat = step.get('repeat')
        if isinstance(repeat, dict) and isinstance(repeat.get('step'), dict):
            yield from _all_steps({'step': repeat['step']}, f'{where}.repeat')


def _scope_names(steps):
    return [name for name in steps if isinstance(name, str)]


def _expressions(value):
    found = interpolations(value)
    return found or ([_bare(value)] if isinstance(value, str) else [])


def _bare(value):
    """`${expr}` or plain `expr` as a FEEL expression."""
    text = str(value).strip()
    found = spans(text)
    return found[0][2] if len(found) == 1 and found[0][:2] == (0, len(text)) else text


def _duration(value):
    return isinstance(value, str) and bool(DURATION.match(value))


def _problem(document, at, message):
    return Problem(file=str(document.path), at=at, message=message)
