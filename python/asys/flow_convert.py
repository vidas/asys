"""asys workflow convert: the workflow file a BPMN process corresponds to.

The subset the examples and templates use converts: tasks with asys:job,
sequence flows, exclusive gateways (decisions and merges), parallel gateways
(forks and joins), ad-hoc subprocesses (coordinators), end events, and
boundary events: an interrupting error event that catches any error becomes
on_error, an interrupting timer becomes timeout and on_timeout. Job
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
        self.associations = {}  # source -> target, as compensation handlers are attached
        self._index(process)

    def _index(self, container):
        for child in container:
            tag = child.tag.replace(BPMN, '')
            identifier = child.get('id')
            if tag == 'association':
                self.associations[child.get('sourceRef')] = child.get('targetRef')
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
        read = set()
        for _, step in flow._all_steps(steps):
            for key in ('input', 'args', 'for_each'):
                for expression in flow.interpolations(step.get(key, {})):
                    read |= flow.expression_names(expression)
            for case in step.get('switch') or []:
                read |= flow.expression_names(str(case.get('when', '')))
            choose = step.get('choose') or {}
            for expression in flow.interpolations(choose.get('input', {})):
                read |= flow.expression_names(expression)
        local = {'request', 'message', 'item', 'index'} | {name for name, _ in flow._all_steps(steps)}
        local |= {name.rsplit('.', 1)[-1] for name, _ in flow._all_steps(steps)}
        local |= {step.get('as') for _, step in flow._all_steps(steps) if step.get('as')}
        local |= {step.get('result') for _, step in flow._all_steps(steps) if step.get('result')}
        extra = sorted(read - local)
        if extra:   # declared after the name, before the steps, where a reader looks
            inputs = {'request': {'type': 'string'}, **{name: {} for name in extra}}
            data = {key: value for key, value in data.items() if key not in ('start', 'steps')}
            data.update(inputs=inputs, start=start, steps=steps)
            self.result.notes.append(f'{", ".join(extra)}: read but never set in the process, so declared as run '
                                     'inputs; as in BPMN, they are null unless the run supplies them')
        for element_id, element in self.elements.items():
            tag = element.tag.replace(BPMN, '')
            if element_id not in self.ids and tag not in {'startEvent', 'exclusiveGateway', 'parallelGateway', 'boundaryEvent'} \
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
            if tag == 'scriptTask' and not element.findall(f'{BPMN}extensionElements/{ASYS}job'):
                self.result.problems.append(f'{identifier}: a FEEL script task sets variables, which a workflow file '
                                            'does not do; compute the value in the step that needs it')
            steps[name] = self.loop(element, self.task(element))
            following = self.follow(element, steps, stop)
            if following:
                steps[name]['next'] = following
            self.boundaries(element, steps[name], steps, stop)
        elif tag == 'subProcess' and element.get('triggeredByEvent') != 'true':
            steps[name] = self.loop(element, self.subprocess(element, name))
            following = self.follow(element, steps, stop)
            if following:
                steps[name]['next'] = following
            self.boundaries(element, steps[name], steps, stop)
        elif tag == 'receiveTask' or (tag == 'intermediateCatchEvent'
                                      and element.find(f'{BPMN}messageEventDefinition') is not None):
            steps[name] = {'wait': self.message(element)}
            following = self.follow(element, steps, stop)
            if following:
                steps[name]['next'] = following
            if tag == 'receiveTask':
                self.boundaries(element, steps[name], steps, stop)
        elif tag == 'intermediateCatchEvent' and element.find(f'{BPMN}timerEventDefinition/{BPMN}timeDuration') is not None:
            steps[name] = {'delay': (element.find(f'{BPMN}timerEventDefinition/{BPMN}timeDuration').text or '').strip()}
            following = self.follow(element, steps, stop)
            if following:
                steps[name]['next'] = following
        elif tag == 'intermediateThrowEvent' and element.find(f'{BPMN}compensateEventDefinition') is not None:
            activity = element.find(f'{BPMN}compensateEventDefinition').get('activityRef')
            steps[name] = {'compensate': self.step_id(activity) if activity else 'all'}
            following = self.follow(element, steps, stop)
            if following:
                steps[name]['next'] = following
        elif tag == 'callActivity':
            self.result.problems.append(f'{identifier}: calls process {element.get("calledElement")}; move that '
                                        'process into a file of its own and convert it, then use call: FILE')
            steps[name] = {'end': 'Unconverted call'}
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
        self.shared_result(job.get('result'), identifier, step)
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
        return step

    LOOP_NAMES = re.compile(r'\b(loopCounter|numberOf\w*Instances|nrOf\w*Instances)\b')

    def loop(self, element, step):
        """STEP as its loop makes it: multi-instance is for_each, a standard loop repeat."""
        identifier = element.get('id')
        many = element.find(f'{BPMN}multiInstanceLoopCharacteristics')
        if many is not None:
            collection = many.find(f'{BPMN}loopDataInputRef')
            cardinality = many.find(f'{BPMN}loopCardinality')
            item = many.find(f'{BPMN}inputDataItem')
            if collection is not None and (collection.text or '').strip():
                step['for_each'] = '${' + collection.text.strip() + '}'
            elif cardinality is not None and (cardinality.text or '').strip():
                step['for_each'] = '${for i in 1..(' + _feel(cardinality.text) + ') return i}'
            else:
                self.result.problems.append(f'{identifier}: a multi-instance loop needs a collection or a cardinality')
                return step
            name = item.get('name') or item.get('id') if item is not None else None
            if name and name != 'item':
                step['as'] = name
            if many.get('isSequential') == 'true':
                step['sequential'] = True
            done = many.find(f'{BPMN}completionCondition')
            if done is not None and (done.text or '').strip():
                if self.LOOP_NAMES.search(done.text):
                    self.result.problems.append(f'{identifier}: its completion condition counts instances; write it '
                                                f'over the finished results instead, as until: ${{count({self.step_id(identifier)}) >= N}}')
                else:
                    step['until'] = _feel(done.text)
            return step
        standard = element.find(f'{BPMN}standardLoopCharacteristics')
        if standard is None:
            return step
        condition = standard.find(f'{BPMN}loopCondition')
        maximum = standard.get('loopMaximum')
        repeat = {'step': {key: value for key, value in step.items() if key != 'description'}}
        if condition is not None and (condition.text or '').strip():
            if self.LOOP_NAMES.search(condition.text):
                self.result.problems.append(f'{identifier}: its loop condition reads loopCounter; a repeat has no counter, '
                                            'so write the condition over the step\'s result')
            repeat['until'] = 'not(' + _feel(condition.text) + ')'
        if maximum:
            repeat['max'] = int(maximum)
        if 'until' not in repeat and 'max' not in repeat:
            self.result.problems.append(f'{identifier}: a standard loop needs a condition or a maximum')
        if standard.get('testBefore') == 'true':
            self.result.notes.append(f'{identifier}: BPMN tests the loop condition before the first run; a repeat '
                                     'always runs its step once')
        wrapped = {'repeat': repeat}
        if 'description' in step:
            wrapped['description'] = step['description']
        return wrapped

    def subprocess(self, element, name):
        """A subprocess as a group; outside it, its steps' results are read through it."""
        inner = _Process(element, self.root, self.result)
        inner.ids, inner.used = self.ids, self.used
        starts = [e for e in inner.elements.values() if e.tag == f'{BPMN}startEvent']
        if len(starts) != 1:
            self.result.problems.append(f'{element.get("id")}: a subprocess needs one start event')
            return {'group': {'start': None, 'steps': {}}}
        steps = {}
        start = inner.follow(starts[0], steps)
        for step in steps.values():
            inner.apply_renames(step)
        for result_name, step_id in inner.renames.items():
            self.renames[result_name] = f'{name}.{step_id}'
        group = {'group': {'start': start, 'steps': steps}}
        if element.get('name') and element.get('name') != element.get('id'):
            group['description'] = element.get('name')
        return group

    def message(self, element):
        """The message a receive task or catch event waits for, by name."""
        definition = element.find(f'{BPMN}messageEventDefinition')
        reference = (definition if definition is not None else element).get('messageRef')
        for message in self.root.iter(f'{BPMN}message'):
            if message.get('id') == reference:
                return message.get('name') or reference
        return reference or element.get('id')

    def shared_result(self, result, identifier, step):
        """Where a step's result is read from. By default a task's result is its
        own ID, which is the step's; a named result variable, which several tasks
        may write, becomes the step's result: name, so the meaning is kept."""
        if not result or result == identifier:
            self.renames[identifier] = self.step_id(identifier)
            return
        name = _name(result)
        step['result'] = name
        self.renames[identifier] = self.step_id(identifier)
        if name != result:
            self.renames[result] = name

    def boundaries(self, element, step, steps, stop):
        """A task's boundary events as its error and timeout paths.

        An interrupting error event that catches any error is on_error; an
        interrupting timer with a duration is timeout and on_timeout.
        """
        identifier = element.get('id')
        for boundary in self.elements.values():
            if boundary.tag != f'{BPMN}boundaryEvent' or boundary.get('attachedToRef') != identifier:
                continue
            name = boundary.get('id')
            if boundary.find(f'{BPMN}compensateEventDefinition') is not None:
                handler = self.elements.get(self.associations.get(name))
                if handler is None:
                    self.result.problems.append(f'{name}: a compensation event without its handler')
                    continue
                undo = self.step_id(handler.get('id'))
                if undo not in steps:
                    steps[undo] = self.task(handler)
                step['undo'] = undo
                continue
            if boundary.get('cancelActivity', 'true') != 'true':
                self.result.problems.append(f'{name}: a non-interrupting boundary event has no workflow file equivalent')
                continue
            error = boundary.find(f'{BPMN}errorEventDefinition')
            timer = boundary.find(f'{BPMN}timerEventDefinition')
            if error is not None:
                if error.get('errorRef'):
                    self.result.problems.append(f'{name}: catches one error code; on_error catches every failure')
                    continue
                if 'on_error' in step:
                    self.result.problems.append(f'{name}: {identifier} already has an error path')
                    continue
                target = self.follow(boundary, steps, stop)
                if target:
                    step['on_error'] = target
            elif timer is not None and timer.find(f'{BPMN}timeDuration') is not None:
                step['timeout'] = (timer.find(f'{BPMN}timeDuration').text or '').strip()
                target = self.follow(boundary, steps, stop)
                if target:
                    step['on_timeout'] = target
            else:
                self.result.problems.append(f'{name}: only error events and timers with a duration convert')

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
                self.boundaries(chain[0], steps[name], steps, None)
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
        step = {'choose': choose}
        self.shared_result(jobs[0].get('result'), identifier, step)
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

def _name(text):
    """TEXT as a workflow file name: lowercase words joined by _."""
    name = re.sub(r'[^a-z0-9_]+', '_', re.sub(r'([a-z0-9])([A-Z])', r'\1_\2', text).lower()).strip('_')
    return name if name and name[0].isalpha() else f'v_{name}'


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
        return [_value(item) for item in _split(inner, ',')] if inner else []
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
