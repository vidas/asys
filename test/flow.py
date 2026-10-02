"""Workflow files: loading, calls and validation against an environment."""
import json
from pathlib import Path
import sys
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / '.host-deps'), str(ROOT / 'python'), str(ROOT / 'asys-runtime')]
from asys import flow
from asys.worker_definitions import definition_command

WORKFLOW = '''\
asys: workflow/1
name: Delivery route review
start: brief
steps:
  brief:              # comments survive loading
    run: single
    input: {request: Write requirements.md.}
    next: work
  work:
    parallel: [search, implement]
    join: evidence
  search:
    group:
      start: global_search
      steps:
        global_search:
          run: route
          input: {request: Find a route.}
          next: local_search
        local_search:
          run: route
          input: {request: "Improve ${global_search.final}."}
  implement:
    run: goal
    input: {request: Implement route.py.}
  evidence:
    run: compare
    args: [python3, programs/compare.py]
    next: review
  review:
    call: review-loop.yaml
    input: {request: "Review ${evidence}."}
    next: question
  question:
    run: human
    input:
      title: Decision
      prompt: Which next step?
      summary: ${review.final}
      form: forms/decision.json
    timeout: P2D
    on_timeout: stopped
    next: decide
  decide:
    switch:
      - when: question.action = "accept"
        next: accepted
      - when: question.action = "revise"
        next: revise
    default: stopped
  revise:
    run: goal
    input:
      request: |
        Address the feedback: ${question.comments or "none"}
    next: evidence
  accepted: {end: Accepted}
  stopped: {end: Stopped}
'''

REVIEW_LOOP = '''\
asys: workflow/1
name: Review loop
inputs:
  request: {type: string}
start: review
output: ${review}
steps:
  review:
    run: single
    input: {request: "${request}"}
    next: done
  done: {end: Reviewed}
'''

FORM = {'type': 'object', 'properties': {
    'action': {'type': 'string', 'oneOf': [{'const': 'accept'}, {'const': 'revise'}, {'const': 'stop'}]},
    'comments': {'type': 'string'}}, 'required': ['action']}


class Fixture(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='asys-flow-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.environment = self.root / 'env'
        (self.environment / 'workers').mkdir(parents=True)
        types = {'compare': {'command': ['/opt/asys/asys-workers/tools/asys-program']},
                 'human': {'command': ['/opt/asys/asys-workers/tools/asys-human']}}
        for name, kind in {'single': 'agent', 'route': 'swarm', 'goal': 'goal'}.items():
            (self.environment / f'workers/{name}.json').write_text(json.dumps({'version': 1, 'kind': kind, 'config': {}}))
            types[name] = {'command': definition_command(name)}
        (self.environment / 'workers.json').write_text(json.dumps({'version': 1, 'name': 'fixture', 'types': types}))
        (self.root / 'forms').mkdir()
        (self.root / 'forms/decision.json').write_text(json.dumps(FORM))
        (self.root / 'review-loop.yaml').write_text(REVIEW_LOOP)

    def write(self, text, name='workflow.yaml'):
        path = self.root / name
        path.write_text(text)
        return path

    def problems(self, text):
        workflow = flow.load_all(self.write(text))
        return [problem['message'] for problem in flow.check(workflow, self.environment)]


class FlowTests(Fixture):
    def test_a_complete_workflow_with_a_call_and_a_form_is_valid(self):
        workflow = flow.load_all(self.write(WORKFLOW))
        self.assertEqual([str(p) for p in flow.check(workflow, self.environment)], [])
        self.assertEqual(set(workflow.calls), {'review-loop.yaml'})
        self.assertEqual(flow.worker_kinds(self.environment),
                         {'single': 'agent', 'route': 'swarm', 'goal': 'goal', 'compare': 'program', 'human': 'human'})
        self.assertIn('# comments survive loading', workflow.text)

    def test_steps_must_name_environment_types_and_programs_alone_take_args(self):
        found = self.problems(WORKFLOW.replace('run: compare', 'run: missing')
                              .replace('Implement route.py.}', 'Implement route.py.}\n    args: [x]'))
        self.assertIn("the environment has no worker type 'missing'", found)
        self.assertIn('args apply to programs; goal is goal', found)

    def test_references_scopes_and_reachability_are_checked(self):
        broken = (WORKFLOW.replace('next: question\n  question:', 'next: nowhere\n  question:')
                  .replace('Implement route.py.}', 'Implement route.py.}\n    next: review'))
        found = self.problems(broken)
        self.assertIn("'nowhere' is not a step of this scope", found)
        self.assertIn('branch implement ends at the join; remove its next', found)
        self.assertIn('no path from start reaches this step', found)

    def test_expressions_may_only_read_inputs_and_step_results(self):
        found = self.problems(WORKFLOW.replace('${review.final}', '${reviw.final}'))
        self.assertIn("unknown name reviw in 'reviw.final'", found)
        self.assertEqual(flow.expression_names('question.comments or "none" and count(items) > limit'),
                         {'question', 'items', 'limit'})
        # Context keys, filter fields, bound names and multi-word functions are not inputs.
        self.assertEqual(flow.expression_names('{goal: brief.final, n: count(review[approved = false])}'), {'brief', 'review'})
        self.assertEqual(flow.expression_names('for part in parts return string length(part.name) + [a, b][1]'),
                         {'parts', 'a', 'b'})
        self.assertEqual(flow.expression_names('get or else(x, "none")'), {'x'})
        self.assertEqual(flow.rename_name('{evidence: evidence.final}', 'evidence', 'measure'), '{evidence: measure.final}')

    def test_a_switch_on_a_human_answer_must_use_a_value_its_form_allows(self):
        found = self.problems(WORKFLOW.replace('question.action = "revise"', 'question.action = "revize"'))
        self.assertIn("question.action is never 'revize'; the form allows accept, revise, stop", found)

    def test_calls_must_receive_the_inputs_the_called_file_declares(self):
        found = self.problems(WORKFLOW.replace('input: {request: "Review ${evidence}."}', 'input: {topic: x}'))
        self.assertIn('review-loop.yaml has no input topic', found)
        self.assertIn('review-loop.yaml needs input request', found)
        missing = flow.load_all(self.write(WORKFLOW.replace('review-loop.yaml', 'absent.yaml')), problems := [])
        self.assertEqual(missing.calls, {})
        self.assertRegex(problems[0]['message'], r'cannot load absent.yaml')

    def test_durations_kinds_and_top_level_continuations_are_checked(self):
        found = self.problems(WORKFLOW.replace('timeout: P2D', 'timeout: 2 days')
                              .replace('  stopped: {end: Stopped}', '  stopped: {run: single}'))
        self.assertIn('an ISO 8601 duration such as PT30M or P2D', found)
        self.assertIn('a top-level step needs next, or must be an end', found)
        self.assertIn('a step has exactly one of: ' + ', '.join(flow.KINDS),
                      self.problems(WORKFLOW.replace('  accepted: {end: Accepted}', '  accepted: {end: A, run: single}')))

    def test_a_run_gets_every_file_with_calls_as_file_keys(self):
        document = flow.resolved(flow.load_all(self.write(WORKFLOW)))
        self.assertEqual(document['root'], 'workflow.yaml')
        self.assertEqual(document['files']['workflow.yaml']['calls'], {'review-loop.yaml': 'review-loop.yaml'})
        self.assertEqual(document['files']['review-loop.yaml']['data']['output'], '${review}')
        json.dumps(document)  # plain JSON, without YAML node types

    def test_choose_actions_read_message_and_expressions_may_hold_braces(self):
        chooser = WORKFLOW.replace('''  implement:
    run: goal
    input: {request: Implement route.py.}''', '''  implement:
    choose:
      coordinator: single
      actions: [build_module]
      input: {request: "Plan ${{goal: brief.final}}."}
      until: ${count(build_module) >= 2}
  build_module:
    run: goal
    input: {request: "Build ${message.name}."}''')
        self.assertEqual(self.problems(chooser), [])
        self.assertIn('not a key of choose', self.problems(chooser.replace('until: ${count', 'unti: ${count')))
        self.assertIn("unknown name message in 'message.name'",
                      self.problems(chooser.replace('actions: [build_module]', 'actions: [brief]')))
        self.assertEqual(flow.spans('a ${{x: "}"}} b ${y} ${open'), [(2, 13, '{x: "}"}'), (16, 20, 'y')])

    def test_calls_are_followed_once_and_cycles_stop(self):
        self.write(REVIEW_LOOP.replace('run: single\n    input: {request: "${request}"}',
                                       'call: workflow.yaml\n    input: {request: "${request}"}'), 'review-loop.yaml')
        workflow = flow.load_all(self.write(WORKFLOW))
        self.assertIs(workflow.calls['review-loop.yaml'].calls['workflow.yaml'], workflow)


class LayoutAndServiceTests(Fixture):
    def test_the_graph_lays_out_branches_groups_and_loops(self):
        from asys import flow_layout
        graph = flow_layout.graph(flow.load_all(self.write(WORKFLOW)), flow.worker_kinds(self.environment))
        nodes = {node['id']: node for node in graph['nodes']}
        self.assertEqual(nodes['search/global_search']['scope'], 'search')
        self.assertEqual((nodes['implement']['work'], nodes['question']['work'], nodes['evidence']['work']),
                         ('goal', 'human', 'program'))
        # Branches share a column; the join comes after the widest branch.
        self.assertEqual(nodes['search']['x'], nodes['implement']['x'])
        self.assertGreater(nodes['evidence']['x'], nodes['search']['x'] + nodes['search']['w'])
        inside = nodes['search/global_search']
        self.assertTrue(nodes['search']['x'] < inside['x'] < nodes['search']['x'] + nodes['search']['w'])
        roles = {(edge['from'], edge['to']): edge for edge in graph['edges']}
        self.assertTrue(roles[('revise', 'evidence')].get('back'))
        self.assertEqual(roles[('decide', 'revise')]['label'], 'question.action = "revise"')
        self.assertEqual(roles[('question', 'stopped')]['role'], 'timeout')

    def test_a_broken_workflow_still_lays_out_so_it_can_be_fixed(self):
        from asys import flow_layout
        broken = WORKFLOW.replace('next: question\n  question:', 'next: nowhere\n  question:').replace('start: brief', 'start: gone')
        graph = flow_layout.graph(flow.load_all(self.write(broken)))
        self.assertIn('review', {node['id'] for node in graph['nodes']})
        self.assertNotIn('nowhere', {edge['to'] for edge in graph['edges']})

    def test_the_service_edits_keep_comments_and_undo_restores(self):
        import io
        from asys.flow_service import serve
        path = self.write(WORKFLOW)
        requests = [
            {'id': 1, 'op': 'load', 'file': str(path), 'environment': str(self.environment)},
            {'id': 2, 'op': 'set', 'step': 'brief', 'key': 'input.request', 'value': 'Write a sharper brief.'},
            {'id': 3, 'op': 'rename', 'step': 'evidence', 'to': 'measure'},
            {'id': 4, 'op': 'add', 'scope': 'search', 'name': 'compare_routes',
             'step': {'run': 'compare', 'input': {'request': 'Compare.'}}},
            {'id': 5, 'op': 'connect', 'step': 'search/local_search', 'key': 'next', 'to': 'compare_routes'},
            {'id': 6, 'op': 'connect', 'step': 'brief', 'key': 'next', 'to': 'absent'},
            {'id': 7, 'op': 'undo'},
            {'id': 8, 'op': 'save'},
            {'id': 9, 'op': 'remove', 'step': 'handover'},
            {'id': 10, 'op': 'inspect', 'step': 'search/global_search'},
            {'id': 11, 'op': 'set', 'step': '', 'key': 'description', 'value': 'Routes, reviewed.'},
            {'id': 12, 'op': 'inspect', 'step': ''},
        ]
        output = io.StringIO()
        serve(io.StringIO(''.join(json.dumps(request) + '\n' for request in requests)), output)
        responses = {response['id']: response for response in map(json.loads, output.getvalue().splitlines())}
        self.assertEqual(responses[1]['problems'], [])
        self.assertIn('Write a sharper brief.', responses[2]['text'])
        self.assertIn('# comments survive loading', responses[2]['text'])
        # Renaming updates every reference, including the join and the loop.
        self.assertIn('join: measure', responses[3]['text'])
        self.assertIn('next: measure', responses[3]['text'])
        self.assertNotIn('evidence:', responses[3]['text'])
        self.assertEqual(responses[5]['problems'], [])
        self.assertEqual((responses[6]['ok'], responses[6]['error']), (False, 'absent is not a step of this scope'))
        # The failed connect left no history, so undo reverts the connect before it.
        local_search = responses[7]['text'].split('local_search:')[1].split('compare_routes:')[0]
        self.assertNotIn('next: compare_routes', local_search)
        self.assertIn('compare_routes:', responses[7]['text'])
        self.assertTrue(responses[7]['canRedo'])
        self.assertFalse(responses[8]['dirty'])
        self.assertEqual(path.read_text(), responses[8]['text'])
        self.assertEqual((responses[9]['ok'], responses[9]['error']), (False, 'no step handover'))
        # An inspector gets a step's own fields, in document order.
        self.assertEqual(list(responses[10]['data']), ['run', 'input', 'next'])
        self.assertEqual(responses[10]['data']['input'], {'request': 'Find a route.'})
        # The empty path is the file itself, without its steps.
        self.assertEqual(responses[12]['data'], {'asys': 'workflow/1', 'name': 'Delivery route review', 'start': 'brief',
                                                 'description': 'Routes, reviewed.'})


class RunViewTests(Fixture):
    def test_a_run_shows_its_saved_graph_step_states_and_jobs(self):
        from asys.flow_service import Session, handle
        run = self.root / 'runs/0123456789abcdef0123456789abcdef'
        (run / 'workflow').mkdir(parents=True)
        (run / 'workflow/workflow.json').write_text(json.dumps(flow.resolved(flow.load_all(self.write(WORKFLOW)))))
        (run / 'run.json').write_text(json.dumps({'id': run.name, 'name': 'Delivery', 'status': 'running',
                                                  'environment_directory': str(self.environment)}))
        events = [
            (1, 'step.started', 'brief', {'frame': 'f1', 'file': 'workflow.yaml', 'visit': 1}),
            (2, 'step.completed', 'brief', {'frame': 'f1', 'file': 'workflow.yaml'}),
            (3, 'step.started', 'work', {'frame': 'f1', 'file': 'workflow.yaml', 'visit': 1}),
            (4, 'step.started', 'search/global_search', {'frame': 'f3', 'file': 'workflow.yaml', 'visit': 1}),
            (5, 'step.failed', 'implement', {'frame': 'f2', 'file': 'workflow.yaml'}),
            (6, 'step.started', 'review', {'frame': 'f9', 'file': 'review-loop.yaml', 'visit': 1}),
        ]
        (run / 'events.jsonl').write_text(''.join(json.dumps({'sequence': sequence, 'type': kind, 'activityId': step,
                                                              'time': 't', 'data': data}) + '\n'
                                                  for sequence, kind, step, data in events))
        session = Session()
        # By ID prefix, as asys-flow-view -run takes it, as well as by directory.
        by_id = handle(Session(), {'op': 'open', 'run': run.name[:8], 'root': str(self.root)})
        self.assertEqual(by_id['run']['id'], run.name)
        with self.assertRaisesRegex(ValueError, 'No run matching'):
            handle(Session(), {'op': 'open', 'run': 'ffff', 'root': str(self.root)})
        opened = handle(session, {'op': 'open', 'run': str(run)})
        self.assertIn('search/global_search', {node['id'] for node in opened['graph']['nodes']})
        self.assertEqual(opened['run']['name'], 'Delivery')
        states = {step: value['state'] for step, value in opened['states'].items()}
        self.assertEqual(states, {'brief': 'done', 'work': 'running', 'search/global_search': 'running', 'implement': 'failed'})
        # A called file's steps are not this file's: its call step stands for them.
        self.assertEqual(handle(session, {'op': 'step', 'step': 'review'})['state']['state'], 'waiting')
        self.assertEqual(handle(session, {'op': 'step', 'step': 'brief'})['jobs'], [])


class RunPanelTests(Fixture):
    """A viewer enters called files and reads one job of a step at a time."""
    def setUp(self):
        super().setUp()
        self.run = self.root / 'runs/fedcba9876543210fedcba9876543210'
        (self.run / 'workflow').mkdir(parents=True)
        (self.run / 'workflow/workflow.json').write_text(json.dumps(flow.resolved(flow.load_all(self.write(WORKFLOW)))))
        (self.run / 'run.json').write_text(json.dumps({'id': self.run.name, 'name': 'Delivery', 'status': 'running',
                                                       'environment_directory': str(self.environment)}))
        # The root's step "review" calls review-loop.yaml, whose own step is also "review".
        # Job events name only a frame, which the called file's step events place in that file.
        events = [
            (1, 'step.started', 'review', {'frame': 'f1', 'file': 'workflow.yaml', 'kind': 'call', 'visit': 1}),
            (2, 'step.started', 'review', {'frame': 'f9', 'file': 'review-loop.yaml', 'kind': 'run', 'visit': 1}),
            (3, 'job.created', 'review', {'frame': 'f9', 'jobId': 'first', 'type': 'single', 'executionId': 'f9:review:1'}),
            (4, 'step.completed', 'review', {'frame': 'f1', 'file': 'workflow.yaml'}),
            (5, 'job.failed', 'review', {'executionId': 'f9:review:1', 'jobId': 'first'}),
            (6, 'step.failed', 'review', {'frame': 'f9', 'file': 'review-loop.yaml'}),
        ]
        (self.run / 'events.jsonl').write_text(''.join(json.dumps({'sequence': sequence, 'type': kind, 'activityId': step,
                                                                   'time': 't', 'data': data}) + '\n'
                                                       for sequence, kind, step, data in events))
        self.job('first', 'done', '2026-10-01T10:00:00Z', result={'final': 'Needs evidence.', 'exception': None,
                 'approved': False, 'reason': 'No measurements.'}, stdout=['{"type":"agent.message_started"}'],
                 transcript=[('user', 'Review the report.'), ('assistant', 'It lacks measurements.')])
        self.job('second', 'failed', '2026-10-01T11:00:00Z', stderr=['Traceback', 'RuntimeError: model unavailable'],
                 error='worker exited with status 1', exit_code=1)

    def job(self, identity, status, submitted, *, result=None, stdout=(), stderr=(), transcript=(), **state):
        queue = self.run / 'runtime/environments/fixture/jobs' / identity
        queue.mkdir(parents=True)
        (queue / 'request.json').write_text(json.dumps({'id': identity, 'type': 'single',
            'directory': f'../../../jobs/{identity}', 'workspace': '../../../workspace',
            'metadata': {'name': 'review', 'activity_id': 'review', 'file': 'review-loop.yaml'}}))
        (queue / 'state.json').write_text(json.dumps({'id': identity, 'type': 'single', 'status': status,
                                                      'submitted_at': submitted, **state}))
        execution = self.run / 'jobs' / identity
        execution.mkdir(parents=True)
        (execution / 'stdout.log').write_text(''.join(line + '\n' for line in stdout))
        (execution / 'stderr.log').write_text(''.join(line + '\n' for line in stderr))
        if result is not None:
            (execution / 'result.json').write_text(json.dumps(result))
        if transcript:
            entries = [{'type': 'message', 'id': str(index), 'parentId': str(index - 1) if index else None,
                        'message': {'role': role, 'content': [{'type': 'text', 'text': text}]}}
                       for index, (role, text) in enumerate(transcript)]
            (execution / 'agent.json').write_text(json.dumps({'agent': {'session': {
                'entries': entries, 'leafId': str(len(entries) - 1)}}}))

    def test_each_file_has_its_own_steps_and_a_call_enters_its_file(self):
        from asys.flow_service import Session, handle
        session = Session()
        opened = handle(session, {'op': 'open', 'run': str(self.run)})
        # The called file's job failure is its own: the root's step of the same name stays done.
        self.assertEqual(opened['states'], {'review': {'state': 'done', 'visits': 1, 'time': 't'}})
        entered = handle(session, {'op': 'enter', 'step': 'review'})
        self.assertEqual(entered['file'], 'review-loop.yaml')
        self.assertEqual({node['id'] for node in entered['graph']['nodes']}, {'review', 'done'})
        self.assertEqual(entered['states'], {'review': {'state': 'failed', 'visits': 1, 'time': 't'}})
        self.assertEqual(handle(session, {'op': 'view'})['file'], 'workflow.yaml')
        self.assertEqual(handle(session, {'op': 'poll', 'file': 'review-loop.yaml'})['states']['review']['state'], 'failed')
        self.assertEqual([job['id'] for job in handle(session, {'op': 'step', 'step': 'review', 'file': 'review-loop.yaml'})['jobs']],
                         ['first', 'second'])
        self.assertEqual(handle(session, {'op': 'step', 'step': 'review'})['jobs'], [])
        with self.assertRaisesRegex(ValueError, 'does not call another file'):
            handle(session, {'op': 'enter', 'step': 'brief'})
        with self.assertRaisesRegex(ValueError, 'not a file of this run'):
            handle(session, {'op': 'view', 'file': '../outside.yaml'})

    def test_the_panel_shows_one_job_in_each_view(self):
        from asys.flow_service import Session, handle
        session = Session()
        handle(session, {'op': 'open', 'run': str(self.run)})
        panel = lambda **request: handle(session, {'op': 'panel', 'step': 'review', 'file': 'review-loop.yaml', **request})
        latest = panel()
        self.assertEqual((latest['index'], latest['count'], latest['job']['id']), (2, 2, 'second'))
        summary = '\n'.join(latest['lines'])
        self.assertIn('>   2  single  failed', summary)
        self.assertIn('Error (failed)', summary)
        self.assertIn('worker exited with status 1', summary)
        self.assertIn('RuntimeError: model unavailable', summary)
        older = panel(view='result', back=1)
        self.assertEqual((older['index'], older['job']['id']), (1, 'first'))
        self.assertEqual(older['lines'], ['Final', 'Needs evidence.', '', 'Approved:', '  false', 'Reason:', '  No measurements.'])
        self.assertEqual(panel(view='result', back=99)['index'], 1)       # clamped to the oldest job
        self.assertIn('Exit code: 1', panel(view='result')['lines'])
        transcript = panel(view='transcript', back=1)['lines']
        self.assertIn('It lacks measurements.', transcript)
        self.assertEqual(transcript[0], 'Transcript of single')
        logs = panel(view='logs')['lines']
        self.assertEqual(logs[:2], ['stdout', '(empty)'])
        self.assertEqual(logs[-2:], ['Traceback', 'RuntimeError: model unavailable'])
        waiting = handle(session, {'op': 'panel', 'step': 'brief'})
        self.assertEqual((waiting['count'], waiting['job']), (0, None))
        self.assertIn('No jobs yet.', waiting['lines'])
        with self.assertRaisesRegex(ValueError, 'view must be one of'):
            panel(view='everything')


class ConvertTests(unittest.TestCase):
    def convert(self, relative):
        from asys.flow_convert import convert
        return convert((ROOT / relative).read_text())

    def test_the_mixed_review_example_converts_to_a_valid_workflow_with_its_loop(self):
        import subprocess
        text, result = self.convert('asys-bpmn/examples/mixed-review/workflow.bpmn')
        self.assertEqual(result.problems, [])
        with tempfile.TemporaryDirectory() as directory:
            # The example's environment, as its README prepares it.
            subprocess.run([sys.executable, str(ROOT / 'asys-bpmn/examples/mixed-review/prepare.py'), f'{directory}/example'],
                           check=True, capture_output=True)
            path = Path(directory) / 'workflow.yaml'
            path.write_text(text)
            workflow = flow.load_all(path)
            self.assertEqual([str(p) for p in flow.check(workflow, Path(directory) / 'example/environment')], [])
        steps = workflow.data['steps']
        self.assertEqual(list(steps['fork']['parallel']), ['global_search', 'local_search', 'implement'])
        self.assertEqual(steps['fork']['join'], 'evidence')
        self.assertEqual(steps['revise']['next'], 'evidence')     # the revision loop
        self.assertEqual(steps['decision']['switch'][0]['when'], 'human_help.action = "accept"')
        self.assertIn('${(if human_help.comments = null', steps['handover']['input']['request'])

    def test_result_variables_keep_their_meaning_as_shared_results(self):
        # BPMN result variables may be written by several tasks; a step's
        # result: name keeps that, named in the file's style everywhere it is read.
        text, result = self.convert('asys-bpmn/test/fixtures/named-swarm.bpmn')
        self.assertIn('result: search_result', text)
        self.assertIn('when: search_result.output.achieved = true', text)
        self.assertNotIn('searchResult', text)

    def test_what_a_workflow_file_cannot_express_is_refused_with_the_reason(self):
        text, result = self.convert('asys-bpmn/examples/hello/workflow.bpmn')
        self.assertIsNone(text)
        self.assertIn('declare the program in workers.json', result.problems[0])
        text, result = self.convert('asys-bpmn/examples/agent-review.bpmn')
        self.assertIsNone(text)
        self.assertIn('sequence flows inside an ad-hoc subprocess', result.problems[0])

    def test_every_construct_with_an_equivalent_converts(self):
        from asys.flow_convert import convert
        job = '<bpmn:extensionElements><asys:job type="program" input="= {n: 1}"/></bpmn:extensionElements>'
        flows = [('start', 'reserve'), ('reserve', 'each'), ('each', 'twice'), ('twice', 'nested'), ('nested', 'approval'),
                 ('approval', 'pause'), ('pause', 'rollback'), ('rollback', 'done'), ('timeout', 'done')]
        source = f'''<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
            xmlns:asys="urn:asys:workflow:1" id="All"><bpmn:message id="m1" name="approved"/>
          <bpmn:process id="all" isExecutable="true">
            <bpmn:startEvent id="start"/>
            <bpmn:task id="reserve">{job}</bpmn:task>
            <bpmn:boundaryEvent id="comp" attachedToRef="reserve" cancelActivity="false"><bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
            <bpmn:task id="release" isForCompensation="true">{job}</bpmn:task>
            <bpmn:association id="a1" sourceRef="comp" targetRef="release"/>
            <bpmn:task id="each">{job}<bpmn:multiInstanceLoopCharacteristics isSequential="true">
              <bpmn:loopDataInputRef>parts</bpmn:loopDataInputRef><bpmn:inputDataItem id="part" name="part"/>
              <bpmn:completionCondition>each[1].n = 1</bpmn:completionCondition></bpmn:multiInstanceLoopCharacteristics></bpmn:task>
            <bpmn:task id="twice">{job}<bpmn:standardLoopCharacteristics loopMaximum="2">
              <bpmn:loopCondition>twice.n &lt; 1</bpmn:loopCondition></bpmn:standardLoopCharacteristics></bpmn:task>
            <bpmn:subProcess id="nested"><bpmn:startEvent id="s2"/><bpmn:task id="inner">{job}</bpmn:task>
              <bpmn:sequenceFlow id="f_s2" sourceRef="s2" targetRef="inner"/></bpmn:subProcess>
            <bpmn:receiveTask id="approval" messageRef="m1"/>
            <bpmn:boundaryEvent id="late" attachedToRef="approval"><bpmn:timerEventDefinition><bpmn:timeDuration>P1D</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>
            <bpmn:intermediateCatchEvent id="pause"><bpmn:timerEventDefinition><bpmn:timeDuration>PT10M</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:intermediateCatchEvent>
            <bpmn:intermediateThrowEvent id="rollback"><bpmn:compensateEventDefinition/></bpmn:intermediateThrowEvent>
            <bpmn:endEvent id="done"/><bpmn:sequenceFlow id="f_late" sourceRef="late" targetRef="timeout"/>
            <bpmn:task id="timeout">{job}</bpmn:task>
            {"".join(f'<bpmn:sequenceFlow id="f_{a}" sourceRef="{a}" targetRef="{b}"/>' for a, b in flows)}
          </bpmn:process></bpmn:definitions>'''
        text, result = convert(source)
        self.assertEqual(result.problems, [])
        steps = flow.yaml().load(text)['steps']
        self.assertEqual(steps['reserve']['undo'], 'release')
        self.assertEqual((steps['each']['for_each'], steps['each']['as'], steps['each']['sequential'], steps['each']['until']),
                         ('${parts}', 'part', True, 'each[1].n = 1'))
        self.assertEqual(steps['twice']['repeat']['until'], 'not(twice.n < 1)')
        self.assertEqual(steps['twice']['repeat']['max'], 2)
        self.assertEqual(steps['nested']['group']['start'], 'inner')
        self.assertEqual((steps['approval']['wait'], steps['approval']['timeout'], steps['approval']['on_timeout']),
                         ('approved', 'P1D', 'timeout'))
        self.assertEqual(steps['pause']['delay'], 'PT10M')
        self.assertEqual(steps['rollback']['compensate'], 'all')
        problems = [str(p) for p in flow.check(flow.load_all(self.write_text(text)))]
        self.assertEqual(problems, [])
        # What has no equivalent is refused, with what to do instead.
        refused = source.replace('<bpmn:receiveTask id="approval" messageRef="m1"/>',
                                 '<bpmn:callActivity id="approval" calledElement="other"/>')
        self.assertIn('move that process into a file of its own', convert(refused)[1].problems[0])

    def write_text(self, text):
        directory = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__('shutil').rmtree(directory))
        path = Path(directory) / 'workflow.yaml'
        path.write_text(text)
        return path

    def test_feel_contexts_become_yaml_with_text_in_place_of_concatenation(self):
        from asys.flow_convert import _value
        self.assertEqual(_value('{request: "Fix: " + issue.title + ".", n: 3, ok: true, tags: ["a", "b"], raw: items}'),
                         {'request': 'Fix: ${issue.title}.', 'n': 3, 'ok': True, 'tags': ['a', 'b'], 'raw': '${items}'})
        self.assertEqual(_value('{"quoted key": {inner: null}}'), {'quoted key': {'inner': None}})
        self.assertEqual(_value('count(items) + 1'), '${count(items) + 1}')


class EditorTests(Fixture):
    def test_steps_of_any_kind_insert_into_the_chain_and_text_edits_undo(self):
        from asys.flow_service import EditError, Session, handle
        session = Session()
        handle(session, {'op': 'load', 'file': str(self.write(WORKFLOW)), 'environment': str(self.environment)})
        # brief -> work becomes brief -> pause -> work.
        handle(session, {'op': 'insert', 'after': 'brief', 'name': 'pause', 'step': {'delay': 'PT1M'}})
        data = session.workflow.data['steps']
        self.assertEqual((data['brief']['next'], data['pause']['next']), ('pause', 'work'))
        # A switch takes over the continuation as its default, and gains cases.
        handle(session, {'op': 'insert', 'after': 'pause', 'name': 'gate', 'step': {'switch': []}})
        self.assertEqual(data['gate']['default'], 'work')
        handle(session, {'op': 'connect', 'step': 'gate', 'key': 'case', 'to': 'accepted'})
        self.assertEqual(data['gate']['switch'][0], {'when': 'true', 'next': 'accepted'})
        with self.assertRaisesRegex(EditError, 'does not continue with next'):
            handle(session, {'op': 'insert', 'after': 'gate', 'name': 'x', 'step': {'end': 'X'}})
        # The YAML as text, applied as one edit.
        text = session.text().replace('name: Delivery route review', 'name: Routes')
        state = handle(session, {'op': 'replace', 'text': text})
        self.assertIn('name: Routes', state['text'])
        with self.assertRaisesRegex(EditError, 'not YAML'):
            handle(session, {'op': 'replace', 'text': 'steps: [unclosed'})
        self.assertIn('name: Delivery route review', handle(session, {'op': 'undo'})['text'])

    def test_a_new_workflow_starts_as_one_end(self):
        from asys.flow_service import Session, handle
        state = handle(Session(), {'op': 'create', 'file': str(self.root / 'board-review.yaml')})
        self.assertEqual(state['problems'], [])
        self.assertIn('name: "Board review"', state['text'])
        self.assertEqual([node['id'] for node in state['graph']['nodes']], ['done'])


class StartRunTests(Fixture):
    def test_a_saved_workflow_starts_asys_run_and_names_the_run(self):
        import os
        import stat
        from unittest import mock
        from asys.flow_service import EditError, Session, start_run
        bin_dir = self.root / 'bin'
        bin_dir.mkdir()
        fake = bin_dir / 'asys-run'
        fake.write_text('#!/bin/sh\necho "Run 0123456789abcdef0123456789abcdef" >&2\n'
                        'echo "$@" > "$(dirname "$0")/arguments"\nsleep 30\n')
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
        session = Session()
        session.load(self.write(WORKFLOW), self.environment)
        with mock.patch.dict(os.environ, {'PATH': f'{bin_dir}:{os.environ["PATH"]}'}), \
                mock.patch('sys.argv', [str(self.root / 'nowhere/asys')]):
            started = start_run(session, 'Build it.')
            self.assertEqual(started['run'], '0123456789abcdef0123456789abcdef')
            arguments = (bin_dir / 'arguments').read_text().split()
            self.assertEqual(arguments[:2], [str(self.environment), str(session.workflow.path)])
            self.assertIn('--workspace', arguments)
            session.set('brief', 'description', 'changed')
            with self.assertRaisesRegex(EditError, 'save the workflow first'):
                start_run(session, 'Again.')
            session.save()
            session.environment = None
            with self.assertRaisesRegex(EditError, 'no environment'):
                start_run(session, 'Again.')
        os.system(f'pkill -f "{fake}" >/dev/null 2>&1')


class ConvertCommandTests(unittest.TestCase):
    def test_a_project_is_converted_beside_its_bpmn_and_the_rest_is_listed(self):
        import contextlib
        import io
        import shutil
        from asys.flow_migrate import main
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory) / 'project'
            (project / 'tests').mkdir(parents=True)
            shutil.copy(ROOT / 'asys-bpmn/test/fixtures/named-swarm.bpmn', project / 'workflow.bpmn')
            shutil.copy(ROOT / 'asys-bpmn/examples/hello/workflow.bpmn', project / 'tests/scripted.bpmn')
            (project / 'README.md').write_text('Run asys-run env workflow.bpmn.\n')
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                status = main([str(project)])
            text = output.getvalue()
            self.assertEqual(status, 1)                          # the scripted one cannot convert
            self.assertTrue((project / 'workflow.yaml').is_file())
            self.assertFalse((project / 'tests/scripted.yaml').exists())
            self.assertIn('runs an inline script', text)
            self.assertIn('README.md: line 1', text)
            self.assertTrue((project / 'workflow.bpmn').is_file())  # the BPMN stays


class JournalTests(unittest.TestCase):
    def test_asys_logs_reports_workflow_file_steps_like_bpmn_activities(self):
        from asys.workflow_journal import WorkflowHistory
        history, record = WorkflowHistory(), {'id': 'r', 'name': 'Hello', 'jobs': [], 'workflow_root': 'main.yaml'}
        events = [
            ('step.started', 'greet', {'frame': 'f1', 'file': 'main.yaml', 'visit': 1}),
            ('step.completed', 'greet', {'frame': 'f1', 'file': 'main.yaml'}),
            ('step.waiting', 'pause', {'frame': 'f1', 'file': 'main.yaml', 'reason': 'timer until noon'}),
            ('step.failed', 'check', {'frame': 'f7', 'file': 'review.yaml', 'message': 'boom', 'next': 'report'}),
        ]
        lines = [history.consume({'sequence': sequence, 'type': kind, 'activityId': step, 'time': 't', 'data': data}, record)
                 for sequence, (kind, step, data) in enumerate(events, 1)]
        self.assertEqual([line.split()[1] for line in lines], ['STARTED', 'FINISHED', 'WAITING', 'FAILED'])
        self.assertIn('waiting for timer until noon', lines[2])
        self.assertIn('review.yaml:check — boom; continuing at report', lines[3])


if __name__ == '__main__':
    unittest.main()
