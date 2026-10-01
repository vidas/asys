"""Follow a workflow/1 run for viewers: its graph, each step's state, its jobs.

A run keeps the resolved document it executes (workflow/workflow.json), so the
graph is drawn from what runs, not from a file that may have changed since.
Step states come from the engine's events, which the launcher mirrors into
events.jsonl and the component publishes on its channel; both carry the
store's sequence, so overlapping copies are counted once.

State is a matter of form, never of colour: a viewer draws `waiting` steps
open, `done` steps filled, marks `running` steps with the cursor, and says
`failed` in words.
"""
import json
from pathlib import Path

from . import flow, flow_layout
from .runs import Runs, tail
from .state import state_root

LOG_LINES = 40


class RunView:
    def __init__(self, selector, root=None):
        runs = Runs(state_root('runs', root=root))
        path = Path(selector).expanduser()
        self.directory = path.resolve() if path.is_dir() else runs.resolve(selector)
        self.runs = runs
        document = json.loads((self.directory / 'workflow/workflow.json').read_text())
        self.root = document['root']
        self.workflows = {key: flow.Workflow(self.directory / 'workflow' / key, file['data'], '')
                          for key, file in document['files'].items()}
        for key, file in document['files'].items():
            self.workflows[key].calls = {ref: self.workflows[target] for ref, target in file.get('calls', {}).items()}
        record = json.loads((self.directory / 'run.json').read_text())
        environment = record.get('environment_directory')
        self.kinds = flow.worker_kinds(environment) if environment and Path(environment).is_dir() else {}
        self.after, self.channel_after = 0, 0
        self.steps = {}

    def graph(self):
        return flow_layout.graph(self.workflows[self.root], self.kinds)

    def poll(self):
        for event in self._events():
            self._consume(event)
        record = self.runs.snapshot(self.directory)
        return {'run': {'id': record['id'], 'name': record['name'], 'status': record['status'],
                        'error': record.get('error', ''), 'directory': str(self.directory)},
                'states': {step: self._state(entry) for step, entry in self.steps.items()}}

    def step(self, step):
        """The jobs a step ran, latest last, with result and the end of each log."""
        jobs = []
        for job in self.runs.jobs(self.directory):
            metadata = job.get('metadata', {})
            if metadata.get('activity_id') != step or metadata.get('file', self.root) != self.root:
                continue
            execution = Path(job['directory'])
            result = execution / 'result.json'
            jobs.append({'id': job['id'], 'type': job.get('type'), 'status': job.get('status'),
                         'item': metadata.get('item'), 'elapsed': job.get('elapsed'), 'detail': job.get('detail', ''),
                         'result': _read_json(result),
                         'stdout': list(tail(execution / 'stdout.log', LOG_LINES)),
                         'stderr': list(tail(execution / 'stderr.log', LOG_LINES))})
        return {'step': step, 'jobs': jobs, 'state': self._state(self.steps.get(step, {}))}

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
        if not step or data.get('file', self.root) != self.root:
            return  # run events, and steps of called files, which their call step stands for
        entry = self.steps.setdefault(step, {'open': set(), 'visits': 0, 'last': None, 'time': None})
        frame = data.get('frame', '')
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


def _read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None
