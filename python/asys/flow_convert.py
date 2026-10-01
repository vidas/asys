"""asys workflow convert: the workflow file a BPMN process corresponds to.

The subset the examples and templates use converts: tasks with asys:job,
sequence flows, exclusive gateways (decisions and merges), parallel gateways
(forks and joins), ad-hoc subprocesses (coordinators) and end events. Job
inputs, FEEL contexts, become YAML mappings: literals stay literals, and string
concatenation becomes `${...}` text. A result variable or an element ID that is
not a valid step ID is renamed everywhere it is read.

Anything the format cannot express is reported, never approximated in
silence: inline scripts (workflow files name programs the environment
declares), and BPMN this subset does not cover. Approximations that keep a
workflow runnable are reported as notes.
"""
import io
import re
import xml.etree.ElementTree as ET

from . import flow

BPMN = '{http://www.omg.org/spec/BPMN/20100524/MODEL}'
ASYS = '{urn:asys:workflow:1}'
TASKS = {'task', 'serviceTask', 'userTask', 'scriptTask', 'sendTask', 'manualTask', 'businessRuleTask'}


class Conversion:
    def __init__(self):
        self.problems = []      # cannot be expressed: no file is written
        self.notes = []         # expressed approximately: written, and said


def convert(text, process_id=None):
    """(YAML text or None, Conversion) for the executable process in TEXT."""
    result = Conversion()
    try:
        root = ET.fromstring(text)
    except ET.ParseError as error:
        result.problems.append(f'not BPMN XML: {error}')
        return None, result
    processes = [p for p in root.iter(f'{BPMN}process') if p.get('isExecutable') == 'true']
    if process_id:
        processes = [p for p in processes if p.get('id') == process_id]
    if len(processes) != 1:
        result.problems.append('select one executable process' if processes else 'no executable process')
        return None, result
    process = processes[0]
    data = _Process(process, root, result).document()
    if result.problems:
        return None, result
    stream = io.StringIO()
    stream.write(f'# Converted from BPMN process {process.get("id")} by asys workflow convert.\n')
    flow.yaml().dump(data, stream)
    return stream.getvalue(), result


class _Process:
    def __init__(self, process, root, result):
        self.process, self.root, self.result = process, root, result
        self.elements = {}
        self.outgoing, self.incoming = {}, {}
        self.flows = {}
        self.ids = {}           # element ID -> step ID
        self.used = set()
        self.renames = {}       # names expressions read -> step IDs
        self._index(process)

    def _index(self, container):
        for child in container:
            tag = child.tag.replace(BPMN, '')
            identifier = child.get('id')
            if tag == 'sequenceFlow':
                self.flows[identifier] = child
                self.outgoing.setdefault(child.get('sourceRef'), []).append(child)
                self.incoming.setdefault(child.get('targetRef'), []).append(child)
            elif identifier and child.tag.startswith(BPMN):
                self.elements[identifier] = child

    # Naming

    def step_id(self, element_id):
        if element_id in self.ids:
            return self.ids[element_id]
        name = re.sub(r'[^a-z0-9_]+', '_', re.sub(r'([a-z0-9])([A-Z])', r'\1_\2', element_id).lower()).strip('_')
        if not name or not name[0].isalpha():
            name = f'step_{name}'
        candidate, count = name, 2
        while candidate in self.used:
            candidate, count = f'{name}_{count}', count + 1
        self.used.add(candidate)
        self.ids[element_id] = candidate
        return candidate

    # Document

    def document(self):
        starts = [e for e in self.elements.values() if e.tag == f'{BPMN}startEvent']
        if len(starts) != 1:
            self.result.problems.append(f'{"no" if not starts else "several"} start events; a workflow has one start')
            return {}
        steps = {}
        start = self.follow(starts[0], steps)
        data = {'asys': flow.FORMAT}
        name = self.process.get('name') or self.root.get('name')
        if name:
            data['name'] = name
        data['start'] = start
        data['steps'] = steps
        for step in steps.values():
            self.apply_renames(step)
        for element_id, element in self.elements.items():
            tag = element.tag.replace(BPMN, '')
            if element_id not in self.ids and tag not in {'startEvent', 'exclusiveGateway', 'parallelGateway'} \
                    and not tag.endswith('Definition') and tag not in {'documentation', 'extensionElements'}:
                self.result.notes.append(f'{element_id}: not reachable from the start; left out')
        return data

    def follow(self, element, steps, stop=None):
        """The step the flow leaving ELEMENT enters, converting as it goes."""
        flows = self.outgoing.get(element.get('id'), [])
        if not flows:
            return None
        if len(flows) > 1 and element.tag != f'{BPMN}startEvent':
            self.result.problems.append(f'{element.get("id")}: several flows leave a task; use a parallel or exclusive gateway')
        return self.enter(self.elements.get(flows[0].get('targetRef')), steps, stop)

    def enter(self, element, steps, stop=None):
        """The step ID ELEMENT becomes in STEPS; converted once, so loops close."""
        if element is None:
            return None
        if stop is not None and element is stop:
            return None
        identifier = element.get('id')
        tag = element.tag.replace(BPMN, '')
        if tag == 'exclusiveGateway' and len(self.outgoing.get(identifier, [])) == 1:
            return self.follow(element, steps, stop)            # a merge is just where flows meet
        if identifier in self.ids:
            return self.ids[identifier]
        name = self.step_id(identifier)
        steps[name] = {}                                         # reserved: a loop back finds it
        if tag in TASKS:
            steps[name] = self.task(element)
            following = self.follow(element, steps, stop)
            if following:
                steps[name]['next'] = following
        elif tag == 'endEvent':
            errors = element.findall(f'{BPMN}errorEventDefinition')
            label = element.get('name') or identifier
            steps[name] = {'end': f'Error: {label}' if errors else label}
            if errors:
                self.result.notes.append(f'{identifier}: an error end event becomes an end labelled as an error')
        elif tag == 'exclusiveGateway':
            steps[name] = self.decision(element, steps, stop)
        elif tag == 'parallelGateway':
            steps[name] = self.fork(element, steps)
        elif tag == 'adHocSubProcess':
            steps[name] = self.coordinator(element, steps, stop)
        else:
            self.result.problems.append(f'{identifier}: BPMN {tag} has no workflow file equivalent in this converter')
            steps[name] = {'end': f'Unconverted {tag}'}
        return name

    # Steps

    def task(self, element):
        identifier = element.get('id')
        jobs = element.findall(f'{BPMN}extensionElements/{ASYS}job')
        if len(jobs) != 1:
            self.result.problems.append(f'{identifier}: a task needs one asys:job binding')
            return {'run': 'unknown'}
        job = jobs[0]
        step = {'run': job.get('type', 'unknown')}
        result_name = job.get('result') or identifier
        self.renames[result_name] = self.step_id(identifier)
        if element.get('name') and element.get('name') != identifier:
            step['description'] = element.get('name')
        if job.get('input') is None:
            step['input'] = {'request': '${request}'}
            self.result.notes.append(f'{identifier}: BPMN sends all variables when input is absent; '
                                     'the workflow file sends {request}')
        else:
            step['input'] = self.value(_feel(job.get('input')), identifier)
        args = job.get('args')
        if args is not None:
            source = _feel(args)
            if 'task.script' in source or element.findall(f'{BPMN}script'):
                self.result.problems.append(f'{identifier}: runs an inline script; workflow files run only what the '
                                            'environment declares, so declare the program in workers.json and name it')
            value = self.value(source, identifier)
            if value != []:
                step['args'] = value
        for loop in ('multiInstanceLoopCharacteristics', 'standardLoopCharacteristics'):
            if element.find(f'{BPMN}{loop}') is not None:
                self.result.problems.append(f'{identifier}: BPMN loops are not converted; use for_each or repeat')
        for boundary in self.elements.values():
            if boundary.tag == f'{BPMN}boundaryEvent' and boundary.get('attachedToRef') == identifier:
                self.result.problems.append(f'{boundary.get("id")}: boundary events are not converted; use on_error or timeout')
        return step

    def decision(self, element, steps, stop):
        identifier = element.get('id')
        default = element.get('default')
        cases, otherwise = [], None
        for sequence in self.outgoing.get(identifier, []):
            target = self.elements.get(sequence.get('targetRef'))
            condition = sequence.find(f'{BPMN}conditionExpression')
            entered = self.enter(target, steps, stop)
            if sequence.get('id') == default or condition is None:
                if otherwise is not None:
                    self.result.problems.append(f'{identifier}: several flows without conditions')
                otherwise = entered
            else:
                cases.append({'when': _feel(condition.text or ''), 'next': entered})
        step = {'switch': cases}
        if otherwise is None:
            name = self.step_id(f'{identifier}_unmatched')
            steps[name] = {'end': 'No condition held'}
            otherwise = name
            self.result.notes.append(f'{identifier}: BPMN fails when no condition holds; '
                                     'the workflow file ends at an end step instead')
        step['default'] = otherwise
        return step

    def fork(self, element, steps):
        identifier = element.get('id')
        branches = self.outgoing.get(identifier, [])
        if len(branches) < 2:
            self.result.problems.append(f'{identifier}: a parallel gateway that does not fork is not converted')
            return {'end': 'Unconverted gateway'}
        join = self.join_of(element)
        if join is None:
            self.result.problems.append(f'{identifier}: its branches do not meet at one parallel join')
            return {'end': 'Unconverted gateway'}
        names = []
        for number, sequence in enumerate(branches, 1):
            first = self.elements.get(sequence.get('targetRef'))
            chain = self.chain(first, join)
            if len(chain) == 1 and chain[0].tag.replace(BPMN, '') in TASKS:
                name = self.step_id(chain[0].get('id'))
                steps[name] = self.task(chain[0])
            else:
                # A longer branch is a group; outside it, its steps' results
                # are read through the group.
                name = self.step_id(f'{identifier}_branch_{number}')
                inner = {}
                before = dict(self.renames)
                start = self.enter(first, inner, stop=join)
                for step in inner.values():
                    self.apply_renames(step)
                for result_name, step_id in list(self.renames.items()):
                    if before.get(result_name) != step_id:
                        self.renames[result_name] = f'{name}.{step_id}'
                steps[name] = {'group': {'start': start, 'steps': inner}}
            names.append(name)
        return {'parallel': names, 'join': self.follow(join, steps)}

    def chain(self, element, join):
        found = []
        while element is not None and element is not join and len(found) < 1000:
            found.append(element)
            following = self.outgoing.get(element.get('id'), [])
            element = self.elements.get(following[0].get('targetRef')) if len(following) == 1 else None
        return found

    def join_of(self, fork):
        """The parallel gateway where every branch of FORK meets."""
        joins = set()
        for sequence in self.outgoing.get(fork.get('id'), []):
            element, seen = self.elements.get(sequence.get('targetRef')), set()
            while element is not None and element.get('id') not in seen:
                seen.add(element.get('id'))
                if element.tag == f'{BPMN}parallelGateway' and len(self.incoming.get(element.get('id'), [])) > 1:
                    joins.add(element.get('id'))
                    break
                following = self.outgoing.get(element.get('id'), [])
                element = self.elements.get(following[0].get('targetRef')) if following else None
        return self.elements[joins.pop()] if len(joins) == 1 else None

    def coordinator(self, element, steps, stop):
        identifier = element.get('id')
        jobs = element.findall(f'{BPMN}extensionElements/{ASYS}job')
        if len(jobs) != 1:
            self.result.problems.append(f'{identifier}: an ad-hoc subprocess needs one asys:job binding for its coordinator')
            return {'end': 'Unconverted coordinator'}
        inner = _Process(element, self.root, self.result)
        inner.ids, inner.used, inner.renames = self.ids, self.used, self.renames
        if inner.flows:
            self.result.problems.append(f'{identifier}: sequence flows inside an ad-hoc subprocess are not converted')
        actions = []
        for child in element:
            if child.tag.replace(BPMN, '') in TASKS:
                name = self.step_id(child.get('id'))
                steps[name] = self.task(child)
                actions.append(name)
        choose = {'coordinator': jobs[0].get('type', 'unknown')}
        if jobs[0].get('input') is not None:
            choose['input'] = self.value(_feel(jobs[0].get('input')), identifier)
        choose['actions'] = actions
        if element.get('ordering') == 'Sequential':
            choose['sequential'] = True
        condition = element.find(f'{BPMN}completionCondition')
        if condition is not None and (condition.text or '').strip():
            choose['until'] = _feel(condition.text)
        self.renames[jobs[0].get('result') or identifier] = self.step_id(identifier)
        step = {'choose': choose}
        following = self.follow(element, steps, stop)
        if following:
            step['next'] = following
        return step

    # Values

    def value(self, source, where):
        try:
            return _value(source)
        except ValueError as error:
            self.result.problems.append(f'{where}: {error}')
            return None

    def apply_renames(self, step):
        """Expressions read results by step ID; BPMN read them by result variable."""
        mapping = {old: new for old, new in self.renames.items() if old != new}
        if not mapping:
            return
        # Through placeholders, so a rename never feeds another.
        placeholders = {old: f'zzrename{index}' for index, old in enumerate(mapping)}
        for stage in (placeholders, {placeholders[old]: new for old, new in mapping.items()}):
            for old, new in stage.items():
                for key in ('input', 'args'):
                    if key in step:
                        step[key] = flow.rename_in_value(step[key], old, new)
                for case in step.get('switch', []):
                    case['when'] = flow.rename_in_value(case['when'], old, new, bare=True)
                choose = step.get('choose')
                if choose:
                    for key, bare in (('input', False), ('until', True)):
                        if key in choose:
                            choose[key] = flow.rename_in_value(choose[key], old, new, bare=bare)


# FEEL to YAML

def _feel(text):
    return (text or '').strip().removeprefix('=').strip()


def _split(text, separator):
    """TEXT split at SEPARATOR outside strings and brackets."""
    parts, depth, quoted, start, index = [], 0, False, 0, 0
    while index < len(text):
        char = text[index]
        if quoted:
            if char == '\\':
                index += 1
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char in '([{':
            depth += 1
        elif char in ')]}':
            depth -= 1
        elif char == separator and depth == 0:
            parts.append(text[start:index])
            start = index + 1
        index += 1
    parts.append(text[start:])
    return [part.strip() for part in parts]


def _enclosed(text, opening, closing):
    """Whether TEXT is one bracketed whole, such as a context literal."""
    if not (text.startswith(opening) and text.endswith(closing)):
        return False
    depth, quoted = 0, False
    for index, char in enumerate(text):
        if quoted:
            quoted = not (char == '"' and text[index - 1] != '\\')
        elif char == '"':
            quoted = True
        elif char == opening:
            depth += 1
        elif char == closing:
            depth -= 1
            if depth == 0 and index != len(text) - 1:
                return False
    return True


STRING = re.compile(r'"((?:[^"\\]|\\.)*)"', re.S)


def _string(text):
    match = STRING.fullmatch(text.strip())
    if not match:
        return None
    return re.sub(r'\\(.)', lambda m: {'n': '\n', 't': '\t'}.get(m.group(1), m.group(1)), match.group(1))


def _value(source):
    """A FEEL expression as the YAML value a workflow file writes."""
    text = source.strip()
    if not text:
        raise ValueError('an empty expression')
    if _enclosed(text, '{', '}'):
        mapping = {}
        inner = text[1:-1].strip()
        for entry in _split(inner, ',') if inner else []:
            key, _, value = entry.partition(':')
            key = _string(key) if key.strip().startswith('"') else key.strip()
            if not key or not _:
                raise ValueError(f'cannot read the context entry {entry!r}')
            mapping[key] = _value(value)
        return mapping
    if _enclosed(text, '[', ']'):
        inner = text[1:-1].strip()
        items = [_value(item) for item in _split(inner, ',')] if inner else []
        if all(not (isinstance(item, str) and item.startswith('${')) for item in items):
            return items
        return '${' + text + '}'
    literal = _string(text)
    if literal is not None:
        return literal
    if re.fullmatch(r'-?\d+', text):
        return int(text)
    if re.fullmatch(r'-?\d+\.\d+', text):
        return float(text)
    if text in ('true', 'false'):
        return text == 'true'
    if text == 'null':
        return None
    parts = _split(text, '+')
    if len(parts) > 1 and any(_string(part) is not None for part in parts):
        # String concatenation reads as text with the values in place.
        return ''.join(_string(part) if _string(part) is not None else '${' + part + '}' for part in parts)
    return '${' + text + '}'
