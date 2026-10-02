"""Follow a workflow/1 run for viewers: its graph, each step's state, its jobs.

A run keeps the resolved document it executes (workflow/workflow.json), so the
graph is drawn from what runs, not from a file that may have changed since.
Step states come from the engine's events, which the launcher mirrors into
events.jsonl and the component publishes on its channel; both carry the
store's sequence, so overlapping copies are counted once.

State is a matter of form, never of colour: a viewer draws `waiting` steps
open, `done` steps filled, marks `running` steps with the cursor, and says
`failed` in words.

Every file of the run has its own steps and states; a viewer shows one file at
a time and enters a called file from the step that calls it. The panel gives
one job of a step at a time, in one of four views, as lines of text.
"""
import json
from pathlib import Path

from . import flow, flow_layout
from .runs import JOB_TERMINAL, Runs, tail
from .state import state_root
from .transcript import JobOutput, fields

LOG_LINES = 40
VIEWS = ('summary', 'transcript', 'logs', 'result')
TRANSCRIPT_LINES = 4000
STDOUT_LINES = 2000
STDERR_LINES = 500


class RunView:
    def __init__(self, selector, root=None):
        runs = Runs(state_root('runs', root=root))
        path = Path(selector).expanduser()
        self.directory = path.resolve() if path.is_dir() else runs.select(selector)
        self.runs = runs
        document = json.loads((self.directory / 'workflow/workflow.json').read_text())
        self.root = document['root']
        self.workflows = {key: flow.Workflow(self.directory / 'workflow' / key, file['data'], '')
                          for key, file in document['files'].items()}
        self.call_keys = {key: dict(file.get('calls', {})) for key, file in document['files'].items()}
        for key, file in document['files'].items():
            self.workflows[key].calls = {ref: self.workflows[target] for ref, target in file.get('calls', {}).items()}
        record = json.loads((self.directory / 'run.json').read_text())
        environment = record.get('environment_directory')
        self.kinds = flow.worker_kinds(environment) if environment and Path(environment).is_dir() else {}
        self.after, self.channel_after = 0, 0
        self.steps = {}          # (file, step) -> what its events said
        self.frames = {}         # frame -> its file, from step events, for job events which omit it
        self.outputs = {}        # job ID -> its transcript reader, kept between polls

    def _file(self, file):
        file = file or self.root
        if file not in self.workflows:
            raise ValueError(f'{file!r} is not a file of this run')
        return file

    def graph(self, file=None):
        return flow_layout.graph(self.workflows[self._file(file)], self.kinds)

    def poll(self, file=None):
        file = self._file(file)
        for event in self._events():
            self._consume(event)
        record = self.runs.snapshot(self.directory)
        return {'run': {'id': record['id'], 'name': record['name'], 'status': record['status'],
                        'error': record.get('error', ''), 'directory': str(self.directory)},
                'file': file,
                'states': {step: self._state(entry) for (owner, step), entry in self.steps.items() if owner == file}}

    def view(self, file=None):
        """One file of the run: its graph and its steps' states."""
        return {'graph': self.graph(file), **self.poll(file)}

    def _called(self, step, file):
        """The file STEP calls: a call step's, or that of the one call a repeat or group holds."""
        nodes = self.graph(file)['nodes']
        node = next((node for node in nodes if node['id'] == step), None)
        if node is None:
            raise ValueError(f'no step {step!r} in {file}')
        if node.get('kind') in {'repeat', 'group'}:
            inner = [child for child in nodes if child['id'].startswith(step + '/') and child.get('kind') == 'call']
            node = inner[0] if len(inner) == 1 else node
        if node.get('kind') != 'call':
            return None
        target = self.call_keys.get(file, {}).get(node['call'])
        if target is None:
            raise ValueError(f'{node["call"]} is not saved with this run')
        return target

    def enter(self, step, file=None):
        """The file a call step calls, to view in its place."""
        file = self._file(file)
        target = self._called(step, file)
        if target is None:
            raise ValueError(f'{step} does not call another file')
        return {'step': step, **self.view(target)}

    def _jobs(self, step, file):
        return [job for job in self.runs.jobs(self.directory)
                if job.get('metadata', {}).get('activity_id') == step
                and job.get('metadata', {}).get('file', self.root) == file]

    def step(self, step, file=None):
        """The jobs a step ran, latest last, with result and the end of each log."""
        file = self._file(file)
        jobs = []
        for job in self._jobs(step, file):
            metadata = job.get('metadata', {})
            execution = Path(job['directory'])
            result = execution / 'result.json'
            jobs.append({'id': job['id'], 'type': job.get('type'), 'status': job.get('status'),
                         'item': metadata.get('item'), 'elapsed': job.get('elapsed'), 'detail': job.get('detail', ''),
                         'result': _read_json(result),
                         'stdout': list(tail(execution / 'stdout.log', LOG_LINES)),
                         'stderr': list(tail(execution / 'stderr.log', LOG_LINES))})
        return {'step': step, 'file': file, 'jobs': jobs, 'state': self._state(self.steps.get((file, step), {}))}

    def panel(self, step, file=None, view='summary', back=0):
        """One job of a step, BACK jobs before its latest, in VIEW, as lines."""
        file = self._file(file)
        if view not in VIEWS:
            raise ValueError(f'view must be one of {", ".join(VIEWS)}')
        state = self._state(self.steps.get((file, step), {}))
        jobs = self._jobs(step, file)
        reply = {'step': step, 'file': file, 'view': view, 'state': state, 'count': len(jobs), 'index': 0, 'job': None}
        if not jobs:
            called = self._called(step, file)
            reply['lines'] = [f'{step}: {_state_words(state)}.', '',
                              f'It calls {called}: Return or a double click follows that file\'s steps.' if called
                              else 'No jobs yet.' if state['state'] != 'done' else 'This step ran no jobs.']
            return reply
        back = min(max(int(back), 0), len(jobs) - 1)
        job = jobs[len(jobs) - 1 - back]
        reply['index'] = len(jobs) - back
        reply['job'] = {key: job.get(key) for key in ('id', 'type', 'status', 'elapsed')}
        execution = Path(job['directory'])
        if view == 'summary':
            reply['lines'] = self._summary(step, state, jobs, job)
        elif view == 'transcript':
            label, lines = self.outputs.setdefault(job['id'], JobOutput()).read(job)
            reply['lines'] = _bounded([f'{label} of {job.get("type")}', '', *lines], TRANSCRIPT_LINES)
        elif view == 'logs':
            stdout, stderr = tail(execution / 'stdout.log', STDOUT_LINES), tail(execution / 'stderr.log', STDERR_LINES)
            reply['lines'] = [f'stdout{_last(stdout, STDOUT_LINES)}', *(stdout or ['(empty)']), '',
                              f'stderr{_last(stderr, STDERR_LINES)}', *(stderr or ['(empty)'])]
        else:
            reply['lines'] = _result(job, execution)
        return reply

    def _summary(self, step, state, jobs, chosen):
        lines = [f'{step}: {_state_words(state)}.', '']
        for number, job in enumerate(jobs, 1):
            mark = '>' if job is chosen else ' '
            item = job.get('metadata', {}).get('item')
            lines.append(f'{mark} {number:>3}  {job.get("type", "")}  {job.get("status", "")}'
                         f'  {job.get("elapsed") or ""}{f"  item {item}" if item is not None else ""}')
        execution = Path(chosen['directory'])
        lines += ['', f'Job {chosen["id"]}', f'Worker: {chosen.get("type", "")}', f'Status: {chosen.get("status", "")}']
        if chosen.get('elapsed'):
            lines.append(f'Elapsed: {chosen["elapsed"]}')
        if chosen.get('detail'):
            lines.append(f'Now: {chosen["detail"]}')
        lines += _failure(chosen, execution)
        result = _read_json(execution / 'result.json')
        if isinstance(result, dict) and isinstance(result.get('final'), str):
            lines += ['', 'Outcome', *result['final'].splitlines()]
        lines += ['', 's t l r: summary, transcript, logs, result   [ ]: older and newer jobs']
        return lines

    # Events

    def _events(self):
        mirror = self.directory / 'events.jsonl'
        if mirror.is_file():
            with mirror.open(encoding='utf-8') as stream:
                for line in stream:
                    try:
                        yield json.loads(line)
                    except ValueError:
                        continue  # a line being written
        for path in sorted((self.directory / 'runtime/channels/workflow/out').glob('[0-9]*.json'),
                           key=lambda path: int(path.stem)):
            if int(path.stem) <= self.channel_after:
                continue
            try:
                event = json.loads(path.read_text())
            except (FileNotFoundError, ValueError):
                continue  # pruned or being written
            self.channel_after = int(path.stem)
            body = event.get('data', {})
            if 'activityId' in body and 'store' in body:
                yield {'sequence': body['store'], 'type': event['type'], 'activityId': body['activityId'],
                       'time': body.get('time'), 'data': body.get('data', {})}

    def _consume(self, event):
        sequence = int(event.get('sequence', 0))
        if sequence <= self.after:
            return
        self.after = sequence
        data = event.get('data') or json.loads(event.get('dataJson') or '{}')
        step, kind = event.get('activityId', ''), event.get('type', '')
        if not step:
            return  # run events
        # Each file's steps are its own; a call step stands for its file in the caller.
        # Job events name only their frame, directly or as an execution ID's first part.
        frame = data.get('frame') or str(data.get('executionId', '')).partition(':')[0]
        if 'file' in data:
            self.frames[frame] = data['file']
        file = data.get('file') or self.frames.get(frame)
        if file is None:
            return  # a job of a frame whose step event is not yet read
        entry = self.steps.setdefault((file, step), {'open': set(), 'visits': 0, 'last': None, 'time': None})
        if kind == 'step.started':
            entry['open'].add(frame)
            entry['visits'] = max(entry['visits'], int(data.get('visit', 1)))
        elif kind in ('step.completed', 'step.failed'):
            entry['open'].discard(frame)
            entry['last'] = 'failed' if kind == 'step.failed' else 'done'
        elif kind == 'job.failed':
            entry['last'] = 'failed'
        entry['time'] = event.get('time') or entry['time']

    @staticmethod
    def _state(entry):
        if not entry:
            return {'state': 'waiting', 'visits': 0}
        state = 'running' if entry['open'] else entry['last'] or 'waiting'
        return {'state': state, 'visits': entry['visits'], 'time': entry['time']}


def _state_words(state):
    words = state.get('state', 'waiting')
    visits = state.get('visits', 0)
    return f'{words}, run {visits} times' if visits > 1 else words


def _last(lines, limit):
    return f' (last {limit} lines)' if len(lines) >= limit else ''


def _bounded(lines, limit):
    if len(lines) <= limit:
        return lines
    return [f'(showing the last {limit} of {len(lines)} lines)', '', *lines[-limit:]]


def _failure(job, execution):
    """What went wrong with a job, from its state, exit code and error stream."""
    if job.get('status') not in {'failed', 'interrupted', 'cancelled'}:
        return []
    lines = ['', f'Error ({job.get("status")})']
    if job.get('error'):
        lines += str(job['error']).splitlines()
    if job.get('exit_code') is not None:
        lines.append(f'Exit code: {job["exit_code"]}')
    stderr = tail(execution / 'stderr.log', 20)
    if stderr:
        lines += ['Last error output:', *(f'  {line}' for line in stderr)]
    return lines


def _result(job, execution):
    result = _read_json(execution / 'result.json')
    lines = _failure(job, execution)[1:]
    if lines:
        lines.append('')
    if result is None:
        still = job.get('status') not in JOB_TERMINAL
        return lines + ['No result yet: the job is still running.' if still else 'This job saved no result.']
    if isinstance(result, dict):
        if result.get('exception'):
            lines += ['Exception', *str(result['exception']).splitlines(), '']
        if isinstance(result.get('final'), str):
            lines += ['Final', *result['final'].splitlines(), '']
        rest = {key: value for key, value in result.items() if key not in {'final', 'exception'}}
        return lines + fields(rest) if rest else lines
    return lines + fields(result)


def _read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None
