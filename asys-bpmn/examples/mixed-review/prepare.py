#!/usr/bin/env python3
"""Prepare an isolated workspace and environment for the mixed review example."""
import argparse
import json
from pathlib import Path
import shutil


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def prepare(destination, model=None):
    repository = Path(__file__).resolve().parents[3]
    if destination.exists():
        raise SystemExit(f'Refusing to overwrite existing directory: {destination}')
    environment = destination / 'environment'
    shutil.copytree(repository / 'asys-workers/env/default', environment)
    route = repository / 'asys-workers/worlds/samples/route/env'
    shutil.copytree(route / 'worlds', environment / 'worlds')
    (environment / 'programs').mkdir(exist_ok=True)
    shutil.copyfile(Path(__file__).with_name('compare.py'), environment / 'programs/compare.py')
    (environment / 'component.dcomp').write_text('docker asys-env-mixed-review\ninput cyclo.provider.v1.Provider inference\ninput asys.human.v1.Human human\n')
    selected = {'model': model} if model else {}
    definitions = {
        'single': {'kind': 'agent', 'config': {'agent': 'general', 'maxSteps': 12, **selected}},
        'goal': {'kind': 'goal', 'config': {'maxAttempts': 2, **selected}},
        'senate': {'kind': 'senate', 'config': {
            'version': 1,
            'princeps': {'name': 'Princeps senatus', **selected,
                'prompt': 'Coordinate a concise evidence-based review of the delivery-route work. Read proposal.md and evidence.md. Preserve the human decision as a separate step. Keep each contribution below 150 words.'},
            'senators': [
                {'name': 'Seasoned engineer', **selected, 'prompt': 'Review implementation correctness and maintainability against proposal.md. Inspect the code and run its tests. Keep each contribution below 150 words.'},
                {'name': 'Numerical analyst', **selected, 'prompt': 'Independently check closed Manhattan distances, route permutations, the measured scores and the lower bound. Keep each contribution below 150 words.'},
                {'name': 'Verification engineer', **selected, 'prompt': 'Review the independent checks, compare both swarm results and verify evidence is sufficient. Keep each contribution below 150 words.'},
            ]}},
    }
    for name in ('route-global', 'route-local'):
        definition = json.loads((route / 'workers' / f'{name}.json').read_text())
        definition['description'] = 'Two model agents propose routes; the world validates and measures them.'
        definition['config']['agents'] = {'count': 2, 'type': 'route-member'}
        definition['config']['limits'].update(turns=4, decisions=8, concurrency=2, seconds=240, jobSeconds=90)
        definitions[name] = definition
    types = {}
    for name, definition in definitions.items():
        save(environment / 'workers' / f'{name}.json', {'version': 1, **definition})
        types[name] = {'command': ['/opt/asys/asys-workers/tools/asys-worker', '--definition', f'/opt/asys/environment/workers/{name}.json']}
    types['route-member'] = {'command': ['/opt/asys/asys-workers/tools/asys-swarm-agent', '--agent', 'route-search', *(['--model', model] if model else [])]}
    types['program'] = {'command': ['/opt/asys/asys-workers/tools/asys-program']}
    types['human'] = {'command': ['/opt/asys/asys-workers/tools/asys-human']}
    save(environment / 'workers.json', {'version': 1, 'name': 'mixed-review', 'description': 'Parallel model swarms, verified goal, Senate and human revision.', 'types': types})
    prompt = environment / 'agents/route-search/prompt.md'
    prompt.parent.mkdir(parents=True)
    prompt.write_text('You are a route-search specialist. Minimize closed Manhattan distance over the observed cities, visiting each exactly once. Propose a complete candidate tour using the world action schema. Compare the measured baseline and any observed artifacts. Use geometric reasoning and keep memory concise.\n')
    workspace = destination / 'workspace'
    workspace.mkdir()
    problem = definitions['route-global']['config']['world']['settings']['problem']
    save(workspace / 'problem.json', problem)
    (workspace / 'proposal.md').write_text('''# Delivery-route review

Implement route_length(cities, tour) in route.py. It must return the closed
Manhattan distance and reject a tour that omits, duplicates or adds a city with
ValueError. City coordinates are finite numeric pairs. Do not change tests.

Two independent model swarms search the same eight-city problem. Their worlds
validate permutations and independently measure the tours. Compare both saved
results, check their best routes with route_length and report whether each
achieved a score at most 16. Report measured evidence; do not infer success from
an agent claim. A shortest perimeter tour has length 16; a shorter claimed
tour would contradict the x/y span lower bound.

The Senate reviews the code and measured evidence. The person then accepts the
evidence, requests a revision with comments, or stops. Acceptance writes a local
handover report. No external publication or deployment is part of this example.
''')
    (workspace / 'route.py').write_text('def route_length(cities, tour):\n    raise NotImplementedError("Implement the written contract")\n')
    (workspace / 'test_route.py').write_text('''import json
import unittest
from pathlib import Path
from route import route_length

class RouteTests(unittest.TestCase):
    def setUp(self):
        self.cities = json.loads(Path('problem.json').read_text())['cities']
    def test_perimeter(self):
        self.assertEqual(route_length(self.cities, list(range(8))), 16)
    def test_crossed_baseline(self):
        self.assertEqual(route_length(self.cities, [0,4,1,5,2,6,3,7]), 44)
    def test_closing_edge(self):
        self.assertEqual(route_length([[0,0],[3,0],[3,2]], [0,1,2]), 10)
    def test_duplicate(self):
        with self.assertRaises(ValueError): route_length(self.cities, [0,1,2,3,4,5,6,6])
    def test_missing(self):
        with self.assertRaises(ValueError): route_length(self.cities, list(range(7)))
    def test_outside(self):
        with self.assertRaises(ValueError): route_length(self.cities, list(range(7))+[8])

if __name__ == '__main__': unittest.main()
''')
    print(json.dumps({'environment': str(environment), 'workspace': str(workspace)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--model', help='Provider model for all agents; otherwise use system model defaults')
    args = parser.parse_args()
    prepare(args.directory.resolve(), args.model)
