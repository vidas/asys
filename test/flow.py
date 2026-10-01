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


class FlowTests(unittest.TestCase):
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

    def test_calls_are_followed_once_and_cycles_stop(self):
        self.write(REVIEW_LOOP.replace('run: single\n    input: {request: "${request}"}',
                                       'call: workflow.yaml\n    input: {request: "${request}"}'), 'review-loop.yaml')
        workflow = flow.load_all(self.write(WORKFLOW))
        self.assertIs(workflow.calls['review-loop.yaml'].calls['workflow.yaml'], workflow)


if __name__ == '__main__':
    unittest.main()
