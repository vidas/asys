"""Exercise nested world observation and the shared dashboard HTTP boundary."""
import http.client
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'python'), str(ROOT / 'asys-runtime')]
from asys.dashboard import Dashboard, DashboardData, MEMBER_ATTEMPTS, SWARM_ATTEMPTS, TRANSCRIPT_CHARACTERS, WORLD_ARTIFACT_BYTES, saved_messages
from asys.dashboard_design import Design
from asys.transcript import render
from asys.world_history import WorldHistory


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


class DashboardTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.run = self.root / 'runs/workflow-run'
        self.job = self.run / 'jobs/child-1'
        self.queue = self.run / 'runtime/environments/lab/jobs/child-1'
        save(self.run / 'run.json', {'id': 'workflow-run', 'name': 'Investigation',
            'system': 'experiment', 'environment': 'lab', 'status': 'running',
            'workflow': '/unavailable/original.bpmn',
            'world_views': {'local-search': {'directory': 'world-views/local-search', 'entry': 'view.mjs'}}})
        save(self.queue / 'request.json', {'id': 'child-1', 'type': 'local-search',
            'directory': '../../../jobs/child-1', 'workspace': '../../../workspace',
            'metadata': {'name': 'Explore', 'bpmn': {'id': 'explore'}, 'environment': 'lab'}})
        save(self.queue / 'state.json', {'id': 'child-1', 'type': 'local-search', 'status': 'running'})
        save(self.job / 'worker.json', {'kind': 'swarm', 'control_channel': 'swarm-child-1'})
        save(self.job / 'swarm/checkpoint.json', {'version': 2, 'id': 'child-1', 'status': 'running',
            'agents': [], 'config': {'mission': 'Explore candidates'}, 'turn': 2,
            'world': {'candidate': 42}, 'evaluation': {'metrics': {'score': 7}}})
        self.journal = self.job / 'swarm/events.jsonl'
        self.journal.write_text(json.dumps({'sequence': 1, 'type': 'swarm.snapshot',
            'time': '2026-09-23T11:00:00Z', 'data': {'turn': 1, 'state': {'candidate': 41}}}) + '\n')
        asset = self.run / 'world-views/local-search/view.mjs'
        asset.parent.mkdir(parents=True)
        asset.write_text('export function mount() { return {update() {}, dispose() {}}; }')
        workflow = self.run / 'workflow/workflow.bpmn'
        workflow.parent.mkdir()
        workflow.write_text('<definitions><process><startEvent id="start"/><serviceTask id="explore" name="Explore"/>'
            '<sequenceFlow id="flow" sourceRef="start" targetRef="explore"/></process></definitions>')
        self.data = DashboardData(self.root)

    def decision(self, identity, member, turn, *, status='done', stage=None):
        directory = self.job / 'swarm/decisions' / identity
        save(directory / 'state.json', {'id': identity, 'agent': member, 'turn': turn, 'status': status,
            'submitted_at': f'2026-09-23T11:{turn:02d}:00Z', 'directory': '/not/read/from/state'})
        save(directory / 'input.json', {'mission': 'Explore candidates', 'agent': member, 'turn': turn})
        save(directory / 'result.json', {'actions': [{'score': turn}], 'memory': None})
        if stage is not None:
            save(directory / stage / 'agent.json', {'agent': {'model': 'fixture/model', 'session': {'entries': [
                {'id': 'request', 'type': 'message', 'message': {'role': 'user', 'content': f'Inspect {identity}'}},
                {'id': 'reply', 'parentId': 'request', 'type': 'message', 'message': {'role': 'assistant',
                    'content': [{'type': 'text', 'text': f'Candidate from {member}'},
                                {'type': 'toolCall', 'name': 'submit_plan', 'arguments': {'score': turn}}]}},
                {'id': 'tool', 'parentId': 'reply', 'type': 'message', 'message': {'role': 'toolResult',
                    'toolName': 'submit_plan', 'content': [{'type': 'text', 'text': 'Plan recorded'}]}}
            ], 'leafId': 'tool'}}})
        return directory

    def test_saved_member_sessions_and_script_results_survive_restart_and_are_filtered(self):
        checkpoint = json.loads((self.job / 'swarm/checkpoint.json').read_text())
        save(self.job / 'swarm/checkpoint.json', {**checkpoint, 'agents': ['agent-001', 'agent-002', 'agent-003']})
        first = self.decision('attempt-one', 'agent-001', 0, stage='')
        self.decision('attempt-two', 'agent-002', 1)
        self.decision('attempt-three', 'agent-001', 2, stage='proposal')
        (first / 'stderr.log').write_text('Saved diagnostic\n')
        before = {path: path.read_bytes() for path in self.job.rglob('*') if path.is_file()}
        self.assertEqual([row['id'] for row in self.data.members('workflow-run', 'child-1')['members']],
                         ['agent-001', 'agent-002', 'agent-003'])
        member = self.data.member('workflow-run', 'child-1', 'agent-001')
        self.assertEqual((member['decisions'], member['turn'], member['status']), (2, 2, 'done'))
        text = member['transcript']['text']
        for expected in ('Inspect attempt-one', 'Inspect attempt-three', 'Stage: proposal',
                         'Tool call: submit_plan', 'Tool result: submit_plan', 'Plan recorded'):
            self.assertIn(expected, text)
        self.assertTrue(member['hasConversation'])
        self.assertNotIn('Saved diagnostic', text)
        self.assertNotIn('Decision result', text)
        self.assertIn('Saved diagnostic', member['output']['text'])
        self.assertNotIn('agent-002', text)
        sources = member['transcript']['sources']
        self.assertEqual([source['path'] for source in sources], [
            'swarm/decisions/attempt-one/agent.json', 'swarm/decisions/attempt-three/proposal/agent.json'])
        self.assertEqual([source['turn'] for source in sources], [0, 2])
        messages = member['transcript']['messages']
        self.assertEqual([message['role'] for message in messages], ['user', 'assistant', 'toolResult'] * 2)
        self.assertEqual(messages[1]['content'][1]['arguments'], {'score': 0})
        self.assertEqual(messages[2]['toolName'], 'submit_plan')
        for message in messages:
            self.assertEqual(message['displayText'], '\n'.join(render({'session': {'entries': [
                {'type': 'message', 'message': message}]}})))
        self.assertEqual(messages[0]['sourceId'], sources[0]['id'])
        source = self.data.source('workflow-run', 'child-1', sources[0]['id'])
        self.assertEqual(source['path'], sources[0]['path'])
        self.assertIn('Inspect attempt-one', source['transcript']['text'])
        self.assertEqual(source['transcript']['messages'], messages[:3])
        self.assertEqual(self.data.sources('workflow-run', 'child-1')['sources'], sources)
        scripted = self.data.member('workflow-run', 'child-1', 'agent-002')
        self.assertFalse(scripted['hasConversation'])
        self.assertIn('No saved agent session is available for the decisions shown', scripted['transcript']['text'])
        self.assertNotIn('Decision result', scripted['transcript']['text'])
        self.assertIn('Decision result', scripted['output']['text'])
        self.assertIn('Score:', scripted['output']['text'])
        self.assertEqual(scripted['output']['records'][1]['type'], 'result')
        self.assertEqual(scripted['output']['records'][1]['data']['actions'], [{'score': 1}])
        waiting = self.data.member('workflow-run', 'child-1', 'agent-003')
        self.assertEqual(waiting['status'], 'waiting')
        self.assertIn('Waiting for saved agent messages', waiting['transcript']['text'])
        aggregate = self.data.job('workflow-run', 'child-1')
        self.assertIn('Candidate from agent-001', aggregate['transcript']['text'])
        self.assertIn('agent-002', aggregate['transcript']['text'])
        self.assertEqual(aggregate['members'][0]['decisions'], 2)
        record = json.loads((self.run / 'run.json').read_text())
        save(self.run / 'run.json', {**record, 'status': 'completed', 'components_removed': True})
        restarted = DashboardData(self.root)
        self.assertEqual(restarted.member('workflow-run', 'child-1', 'agent-001'), member)
        self.assertEqual(before, {path: path.read_bytes() for path in before})

    def test_member_history_bounds_are_explicit_and_new_attempts_are_discoverable(self):
        for turn in range(MEMBER_ATTEMPTS + 2):
            self.decision(f'attempt-{turn:03}', 'agent-001', turn)
        value = self.data.member('workflow-run', 'child-1', 'agent-001')
        self.assertEqual(value['data']['totalAttempts'], MEMBER_ATTEMPTS + 2)
        self.assertEqual(value['data']['shownAttempts'], MEMBER_ATTEMPTS)
        self.assertIn(f'Showing the latest {MEMBER_ATTEMPTS}', value['output']['text'])
        self.assertNotIn('Decision attempt-000', value['output']['text'])
        self.decision('attempt-latest', 'agent-001', MEMBER_ATTEMPTS + 2, status='running')
        value = self.data.member('workflow-run', 'child-1', 'agent-001')
        self.assertEqual(value['status'], 'running')
        self.assertEqual(value['latestDecision'], 'attempt-latest')
        self.assertIn('Waiting for saved agent messages', value['transcript']['text'])

    def test_program_stdout_and_results_are_never_agent_conversations(self):
        directory = self.decision('attempt-program', 'agent-001', 0)
        save(directory / 'agent.json', {'agent': {'prompt': 'Metadata without saved messages', 'session': {'entries': []}}})
        (directory / 'stdout.log').write_text(json.dumps({'type': 'agent.message_delta',
            'kind': 'text', 'contentIndex': 0, 'delta': 'PROCESS OUTPUT ONLY'}) + '\n')
        member = self.data.member('workflow-run', 'child-1', 'agent-001')
        aggregate = self.data.job('workflow-run', 'child-1')
        for value in (member, aggregate):
            self.assertFalse(value['hasConversation'])
            self.assertIn('No saved agent session is available for the decisions shown', value['transcript']['text'])
            self.assertNotIn('PROCESS OUTPUT ONLY', value['transcript']['text'])
            self.assertNotIn('Decision result', value['transcript']['text'])
            self.assertNotIn('Metadata without saved messages', value['transcript']['text'])
            self.assertIn('PROCESS OUTPUT ONLY', value['output']['text'])
            self.assertIn('Decision result', value['output']['text'])

    def test_missing_recent_sessions_do_not_claim_older_conversations_never_occurred(self):
        self.decision('first-model', 'agent-001', 0, stage='')
        for turn in range(1, SWARM_ATTEMPTS + 1):
            self.decision(f'later-{turn:03}', 'agent-001', turn)
        aggregate = self.data.job('workflow-run', 'child-1')
        self.assertFalse(aggregate['hasConversation'])
        self.assertIn('for the decisions shown', aggregate['transcript']['text'])
        member = self.data.member('workflow-run', 'child-1', 'agent-001')
        self.assertTrue(member['hasConversation'])
        self.assertIn('Inspect first-model', member['transcript']['text'])

    def test_invalid_saved_session_surfaces_an_error(self):
        directory = self.decision('attempt-one', 'agent-001', 0, stage='proposal')
        (directory / 'proposal/agent.json').write_text('broken saved session')
        with self.assertRaises(ValueError):
            self.data.member('workflow-run', 'child-1', 'agent-001')
        source = self.data.sources('workflow-run', 'child-1')['sources'][0]
        self.assertEqual(source['status'], 'error')
        self.assertIn('proposal/agent.json', source['error'])
        direct = self.data.source('workflow-run', 'child-1', source['id'])
        self.assertIn('proposal/agent.json', direct['transcript']['text'])
        self.assertEqual(direct['transcript']['messages'], [])

    def test_pending_source_is_indexed_before_its_first_message(self):
        directory = self.decision('attempt-pending', 'agent-001', 0, status='running')
        save(directory / 'agent.json', {'agent': {'model': 'fixture/model', 'prompt': 'Not a saved message',
                                               'session': {'entries': []}}})
        member = self.data.member('workflow-run', 'child-1', 'agent-001')
        source = member['transcript']['sources'][0]
        self.assertEqual(source['status'], 'pending')
        self.assertEqual(source['path'], 'swarm/decisions/attempt-pending/agent.json')
        self.assertFalse(source['hasConversation'])
        direct = self.data.source('workflow-run', 'child-1', source['id'])
        self.assertEqual(direct['transcript']['messages'], [])
        self.assertIn('Waiting for saved agent messages', direct['transcript']['text'])
        self.assertNotIn('Not a saved message', direct['transcript']['text'])
        self.assertEqual(source['title'], 'agent-001 · Turn 0')
        self.assertEqual(direct['transcript']['title'], source['title'])

    def test_source_labels_use_recorded_agent_names_member_identity_and_stage(self):
        directory = self.decision('attempt-one', 'agent-001', 3, stage='inspection')
        path = directory / 'inspection/agent.json'
        value = json.loads(path.read_text())
        value['agent']['name'] = 'Mapper'
        save(path, value)
        value['agent']['name'] = 'Builder'
        save(directory / 'proposal/agent.json', value)
        payload = self.data.member('workflow-run', 'child-1', 'agent-001')
        sources = payload['transcript']['sources']
        self.assertEqual([row['title'] for row in sources], [
            'Mapper (agent-001) · Turn 3 · inspection', 'Builder (agent-001) · Turn 3 · proposal'])
        self.assertEqual(sources[0]['memberName'], 'Mapper (agent-001)')
        self.assertEqual(sources[0]['agentName'], 'Mapper')
        self.assertEqual(sources[0]['stage'], 'inspection')
        self.assertNotIn('agent.json', sources[0]['title'])
        first = payload['transcript']['messages'][0]
        self.assertEqual((first['memberName'], first['agentName'], first['stage']),
                         ('Mapper (agent-001)', 'Mapper', 'inspection'))
        direct = self.data.source('workflow-run', 'child-1', sources[0]['id'])
        self.assertEqual(direct['title'], sources[0]['title'])
        self.assertEqual(direct['transcript']['title'], sources[0]['title'])
        self.assertEqual(direct['transcript']['messages'], payload['transcript']['messages'][:3])

    def test_structured_compaction_preserves_order_identity_and_current_turn_boundary(self):
        agent = {'sessionStartEntryCount': 1, 'session': {'leafId': 'answer', 'entries': [
            {'id': 'previous', 'type': 'message', 'message': {'role': 'user', 'content': 'Earlier question'}},
            {'id': 'summary', 'parentId': 'previous', 'type': 'compaction', 'summary': 'Keep the checked design constraints.'},
            {'id': 'answer', 'parentId': 'summary', 'type': 'message',
             'message': {'role': 'assistant', 'content': 'Continuing from the saved constraints.'}}
        ]}}
        path = 'swarm/decisions/attempt-one/agent.json'
        metadata = {'member': 'agent-001', 'turn': 2}
        full = saved_messages(agent, path, metadata)
        current = saved_messages(agent, path, metadata, current_turn=True)
        self.assertEqual([message['role'] for message in full], ['user', 'context', 'assistant'])
        self.assertEqual(current, full[1:])
        self.assertEqual(current[0]['content'], [{'type': 'text', 'text': 'Keep the checked design constraints.'}])
        self.assertEqual((current[0]['source'], current[0]['member'], current[0]['turn']), (path, 'agent-001', 2))
        agent['sessionStartEntryCount'] = 2
        self.assertEqual(saved_messages(agent, path, metadata, current_turn=True), full[2:])

    def test_message_display_text_is_the_complete_shared_terminal_format(self):
        entries = [
            {'id': 'input', 'type': 'message', 'message': {'role': 'user', 'content': json.dumps({
                'mission': 'Inspect every output', 'constraints': ['Preserve widths', 'Check zero input'],
                'evidence': {'path': 'design.v', 'observations': ['first', 'last']}})}},
            {'id': 'call', 'type': 'message', 'message': {'role': 'assistant', 'content': [
                {'type': 'text', 'text': 'Checking the complete design.'},
                {'type': 'toolCall', 'name': 'verify', 'arguments': {'command': 'check --all\nreport --full',
                    'settings': {'depth': 64, 'preserve': ['reset', 'ports']}, 'unfamiliarField': 'Keep this too'}}]}},
            {'id': 'result', 'type': 'message', 'message': {'role': 'toolResult', 'toolName': 'verify',
                'content': [{'type': 'text', 'text': json.dumps({'passed': True, 'allEvidence': ['start', 'middle', 'end']})}]}},
            {'id': 'report', 'type': 'message', 'message': {'role': 'assistant', 'content': [{'type': 'text',
                'text': json.dumps({'final': 'Complete report.', 'exception': None,
                    'additionalEvidence': {'fullDetails': ['alpha', 'omega']}, 'notAWhitelistedField': 'Still present'})}]}},
            {'id': 'compact', 'type': 'compaction', 'summary': 'All recorded constraints remain relevant.'}
        ]
        messages = saved_messages({'session': {'entries': entries}}, 'agent.json', {})
        self.assertEqual(len(messages), len(entries))
        for original, message in zip(entries, messages):
            self.assertEqual(message['displayText'], '\n'.join(render({'session': {'entries': [original]}})))
        self.assertIn('"observations": ["first", "last"]', messages[0]['displayText'])
        self.assertIn('unfamiliarField: Keep this too', messages[1]['displayText'])
        self.assertIn('report --full', messages[1]['displayText'])
        self.assertIn('"allEvidence": ["start", "middle", "end"]', messages[2]['displayText'])
        self.assertIn('Still present', messages[3]['displayText'])
        self.assertIn('omega', messages[3]['displayText'])
        system = {'id': 'system', 'type': 'message', 'message': {'role': 'system', 'content': '',
            'sections': {'preamble': 'PI_PREAMBLE'}, 'toolsAdded': []}}
        self.assertEqual(saved_messages({'session': {'entries': [system, *entries]}}, 'agent.json', {}), messages)
        self.assertIn('Context compacted', messages[4]['displayText'])

    def test_selected_source_returns_full_large_session_and_signatures_do_not_consume_text_budget(self):
        save(self.job / 'worker.json', {'kind': 'agent'})
        (self.job / 'swarm/checkpoint.json').unlink()
        body = 'BEGIN\n' + 'x' * (TRANSCRIPT_CHARACTERS + 1024) + '\nEND'
        agent = {'name': 'Editor', 'session': {'entries': [
            {'id': 'large', 'type': 'message', 'message': {'role': 'user', 'content': body}},
            {'id': 'answer', 'type': 'message', 'message': {'role': 'assistant', 'content': 'Complete response.'}}
        ]}}
        save(self.job / 'agent.json', {'agent': agent})
        aggregate = self.data.job('workflow-run', 'child-1')
        self.assertIsNotNone(aggregate['transcript']['messagesNotice'])
        source = aggregate['transcript']['sources'][0]
        selected = self.data.source('workflow-run', 'child-1', source['id'])['transcript']
        self.assertEqual(len(selected['messages']), 2)
        self.assertEqual(selected['messages'][0]['content'], body)
        self.assertEqual(selected['messages'][0]['displayText'], 'User\n' + body + '\n')
        self.assertIn(body, selected['text'])
        self.assertIsNone(selected['messagesNotice'])
        agent['session']['entries'] = [{'id': 'signed', 'type': 'message', 'message': {
            'role': 'assistant', 'content': [{'type': 'text', 'text': 'Visible complete response.',
                'opaqueProviderSignature': 's' * (TRANSCRIPT_CHARACTERS + 1024)}]}}]
        save(self.job / 'agent.json', {'agent': agent})
        aggregate = self.data.job('workflow-run', 'child-1')['transcript']
        self.assertEqual(len(aggregate['messages']), 1)
        self.assertIn('Visible complete response.', aggregate['messages'][0]['displayText'])
        self.assertIsNone(aggregate['messagesNotice'])

    def test_agent_goal_and_senate_sources_follow_their_saved_session_records(self):
        directory = self.decision('template', 'agent-001', 0, stage='')
        session = json.loads((directory / 'agent.json').read_text())
        (self.job / 'swarm/checkpoint.json').unlink()
        for kind, relative in (('agent', 'agent.json'), ('goal', 'phases/implementation/agent.json'),
                               ('senate', 'phases/reviewer/agent.json')):
            with self.subTest(kind=kind):
                for previous in ('agent.json', 'goal.json', 'senate.json'):
                    (self.job / previous).unlink(missing_ok=True)
                save(self.job / 'worker.json', {'kind': kind})
                session['agent']['name'] = {'agent': 'Editor', 'goal': 'Builder', 'senate': 'Analyst'}[kind]
                save(self.job / relative, session)
                if kind != 'agent':
                    phase = {'directory': str(Path(relative).parent), 'status': 'done',
                             **({'phase': 'implement', 'attempt': 1} if kind == 'goal' else
                                {'phase': 'review', 'round': 0, 'participant': 'Reviewer'})}
                    save(self.job / f'{kind}.json', {'version': 1, 'sessions': [phase]})
                payload = self.data.job('workflow-run', 'child-1')
                self.assertEqual([source['path'] for source in payload['transcript']['sources']], [relative])
                self.assertEqual(payload['transcript']['messages'][1]['content'][1]['arguments'], {'score': 0})
                for message in payload['transcript']['messages']:
                    self.assertEqual(message['displayText'], '\n'.join(render({'session': {'entries': [
                        {'type': 'message', 'message': message}]}})))
                source = payload['transcript']['sources'][0]
                self.assertEqual(source['title'], {'agent': 'Editor', 'goal': 'Builder · Attempt 1 · implement',
                                                  'senate': 'Reviewer (Analyst) · Round 0 · review'}[kind])
                self.assertEqual(payload['transcript']['messages'][0]['agentName'], session['agent']['name'])
                self.assertEqual(self.data.source('workflow-run', 'child-1', source['id'])['path'], relative)

    def test_goal_and_senate_structured_history_uses_current_turn_and_terminal_live_reader(self):
        (self.job / 'swarm/checkpoint.json').unlink()
        for kind in ('goal', 'senate'):
            with self.subTest(kind=kind):
                for previous in ('goal.json', 'senate.json'):
                    (self.job / previous).unlink(missing_ok=True)
                self.data = DashboardData(self.root)
                save(self.job / 'worker.json', {'kind': kind})
                phase = {'directory': 'phases/current', 'status': 'running', 'phase': 'review',
                         **({'attempt': 2} if kind == 'goal' else {'round': 1, 'participant': 'Reviewer'})}
                save(self.job / f'{kind}.json', {'version': 1, 'sessions': [phase]})
                agent = {'name': 'Analyst', 'sessionStartEntryCount': 1, 'session': {'leafId': 'current', 'entries': [
                    {'id': 'previous', 'type': 'message', 'message': {'role': 'user', 'content': 'Previous turn'}},
                    {'id': 'current', 'parentId': 'previous', 'type': 'message',
                     'message': {'role': 'user', 'content': 'Current turn'}}]}}
                path = self.job / 'phases/current/agent.json'
                save(path, {'agent': agent})
                (self.job / 'stdout.log').write_text('\n'.join(json.dumps(row) for row in [
                    {'type': 'agent.message_started', 'parentId': 'current'},
                    {'type': 'agent.message_delta', 'kind': 'text', 'contentIndex': 0, 'delta': 'Live verified response'}]) + '\n')
                payload = self.data.job('workflow-run', 'child-1')
                messages = payload['transcript']['messages']
                self.assertEqual(messages[0]['content'], 'Current turn')
                self.assertEqual(messages[1]['content'], [{'type': 'text', 'text': 'Live verified response'}])
                self.assertTrue(messages[1]['live'])
                self.assertEqual(messages[1]['displayText'], 'Assistant\nLive verified response\n')
                self.assertEqual(messages[1]['agentName'], 'Analyst')
                self.assertIn('Live verified response', payload['transcript']['text'])
                source = payload['transcript']['sources'][0]
                selected = self.data.source('workflow-run', 'child-1', source['id'])['transcript']
                full = selected['messages']
                self.assertEqual([row['content'] for row in full[:2]], ['Previous turn', 'Current turn'])
                self.assertEqual(full[2], messages[1])
                self.assertIn('Live verified response', selected['text'])
                agent['session']['entries'].append({'id': 'finished', 'parentId': 'current', 'type': 'message',
                    'message': {'role': 'assistant', 'content': 'Live verified response'}})
                agent['session']['leafId'] = 'finished'
                save(path, {'agent': agent})
                messages = self.data.job('workflow-run', 'child-1')['transcript']['messages']
                self.assertEqual([row['content'] for row in messages], ['Current turn', 'Live verified response'])
                self.assertFalse(any(row.get('live') for row in messages))
                selected = self.data.source('workflow-run', 'child-1', source['id'])['transcript']['messages']
                self.assertEqual([row['content'] for row in selected], ['Previous turn', 'Current turn', 'Live verified response'])
                self.assertFalse(any(row.get('live') for row in selected))

    def test_member_paths_and_saved_symlinks_cannot_read_private_files(self):
        directory = self.decision('attempt-one', 'agent-001', 0)
        for member in ('../private', '/private', '..', 'agent-001\\private'):
            with self.subTest(member=member), self.assertRaises(ValueError):
                self.data.member('workflow-run', 'child-1', member)
        with self.assertRaises(FileNotFoundError):
            self.data.member('workflow-run', 'child-1', 'unrelated-member')
        private = self.root / 'private'
        save(private / 'agent.json', {'agent': {'prompt': 'PRIVATE CONTENT'}})
        (directory / 'proposal').symlink_to(private, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.data.member('workflow-run', 'child-1', 'agent-001')
        (directory / 'proposal').unlink()
        (directory / 'stdout.log').symlink_to(private / 'agent.json')
        with self.assertRaises(ValueError):
            self.data.member('workflow-run', 'child-1', 'agent-001')

    def test_workflow_conditions_are_saved_definition_facts(self):
        (self.run / 'workflow/workflow.bpmn').write_text(
            '<definitions><process><exclusiveGateway id="check" default="retry"/>'
            '<sequenceFlow id="pass" name="Accepted" sourceRef="check" targetRef="end">'
            '<conditionExpression>score &lt; 10</conditionExpression></sequenceFlow>'
            '<sequenceFlow id="retry" sourceRef="check" targetRef="explore"/></process></definitions>')
        graph = self.data.run('workflow-run')['workflow']
        self.assertEqual(graph['source'], 'saved-definition')
        self.assertEqual(graph['nodes'][0]['defaultFlow'], 'retry')
        self.assertEqual(graph['edges'][0]['name'], 'Accepted')
        self.assertEqual(graph['edges'][0]['condition'], 'score < 10')
        self.assertNotIn('selected', graph['edges'][0])

    def test_workflow_exposes_program_and_human_bindings_before_dispatch(self):
        (self.run / 'workflow/workflow.bpmn').write_text(
            '<definitions xmlns:asys="urn:asys:workflow:1"><process>'
            '<serviceTask id="check"><extensionElements><asys:job type="program"/></extensionElements></serviceTask>'
            '<userTask id="help"><extensionElements><asys:job type="human"/></extensionElements></userTask>'
            '</process></definitions>')
        nodes = self.data.run('workflow-run')['workflow']['nodes']
        self.assertEqual([node['workerType'] for node in nodes], ['program', 'human'])
        job = self.data.decorate_job({'directory': str(self.run / 'jobs/human'), 'type': 'human'})
        self.assertEqual(job['kind'], 'human')

    def test_workflow_keeps_timer_boundary_calls_and_nested_scope_connections(self):
        (self.run / 'workflow/workflow.bpmn').write_text('''
            <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:asys="urn:asys:workflow:1">
              <process id="main"><startEvent id="start"/>
                <intermediateCatchEvent id="wait"><timerEventDefinition><timeDuration>PT1S</timeDuration></timerEventDefinition></intermediateCatchEvent>
                <callActivity id="call" calledElement="nested"/>
                <boundaryEvent id="deadline" attachedToRef="call"><timerEventDefinition/></boundaryEvent>
                <subProcess id="scope"><manualTask id="inside"><extensionElements><asys:job type="local-search"/></extensionElements></manualTask>
                  <intermediateThrowEvent id="send"/><sequenceFlow id="nested-flow" sourceRef="inside" targetRef="send"/>
                </subProcess><endEvent id="end"/>
                <sequenceFlow id="a" sourceRef="start" targetRef="wait"/>
                <sequenceFlow id="b" sourceRef="wait" targetRef="call"/>
                <sequenceFlow id="c" sourceRef="call" targetRef="scope"/>
                <sequenceFlow id="d" sourceRef="scope" targetRef="end"/>
                <sequenceFlow id="timeout" sourceRef="deadline" targetRef="end"/>
              </process><process id="nested"><startEvent id="called-start"/><endEvent id="called-end"/>
                <sequenceFlow id="called-flow" sourceRef="called-start" targetRef="called-end"/>
              </process>
            </definitions>''')
        graph = self.data.run('workflow-run')['workflow']
        nodes = {node['id']: node for node in graph['nodes']}
        self.assertEqual(set(nodes), {'start', 'wait', 'call', 'deadline', 'scope', 'inside', 'send',
                                      'end', 'called-start', 'called-end'})
        self.assertEqual(len(graph['edges']), 7)
        self.assertTrue(all(edge['source'] in nodes and edge['target'] in nodes for edge in graph['edges']))
        self.assertEqual(nodes['wait']['eventDefinitions'], ['timerEventDefinition'])
        self.assertEqual(nodes['call']['calledElement'], 'nested')
        self.assertEqual(nodes['inside']['scope'], 'scope')
        self.assertEqual(nodes['inside']['workerKind'], 'swarm')
        self.assertNotIn('workerType', nodes['scope'])
        self.assertEqual(graph['attachments'], [{'id': 'attachment:deadline', 'source': 'call',
                                                'target': 'deadline', 'kind': 'attachment'}])

    def test_unstarted_named_worker_kinds_come_from_saved_configuration(self):
        record = json.loads((self.run / 'run.json').read_text())
        record['worker_kinds'] = {'quality-review': 'senate', 'repair': 'goal'}
        save(self.run / 'run.json', record)
        (self.run / 'workflow/workflow.bpmn').write_text(
            '<definitions xmlns:asys="urn:asys:workflow:1"><process>'
            '<serviceTask id="review"><extensionElements><asys:job type="quality-review"/></extensionElements></serviceTask>'
            '<serviceTask id="revise"><extensionElements><asys:job type="repair"/></extensionElements></serviceTask>'
            '</process></definitions>')
        nodes = self.data.run('workflow-run')['workflow']['nodes']
        self.assertEqual([node['workerKind'] for node in nodes], ['senate', 'goal'])

    def test_overview_and_nested_world_survive_component_removal(self):
        overview = self.data.overview()
        self.assertEqual(overview['scope'], str(self.root))
        self.assertEqual(overview['runs'][0]['jobs'], {'total': 1, 'active': 1})
        self.assertEqual(overview['runs'][0]['kind'], 'workflow')
        detail = self.data.run('workflow-run')
        self.assertEqual(detail['jobs'][0]['kind'], 'swarm')
        self.assertEqual(detail['workflow']['edges'][0]['target'], 'explore')
        job = self.data.job('workflow-run', 'child-1')
        self.assertIn('Explore candidates', job['transcript']['text'])
        world = self.data.world('workflow-run', 'child-1')
        self.assertEqual(world['snapshot']['state']['candidate'], 42)
        self.assertEqual(world['frames'][0]['index'], 1)
        self.assertEqual(world['view']['module'], '/api/runs/workflow-run/jobs/child-1/view/view.mjs')
        self.assertEqual(self.data.history('workflow-run', 'child-1').state(1)['state']['candidate'], 41)
        record = json.loads((self.run / 'run.json').read_text())
        save(self.run / 'run.json', {**record, 'status': 'completed', 'components_removed': True})
        self.assertFalse(self.data.world('workflow-run', 'child-1')['control']['cancel'])
        self.assertEqual(self.data.history('workflow-run', 'child-1').state(1)['turn'], 1)

    def test_partial_append_rotation_and_exact_frame_selection(self):
        history = WorldHistory(self.job)
        self.assertEqual(len(history.frames()), 1)
        row = json.dumps({'sequence': 2, 'type': 'swarm.snapshot', 'data': {'turn': 2}})
        with self.journal.open('a') as stream:
            stream.write(row[:20])
        self.assertEqual(len(history.frames()), 1)
        with self.journal.open('a') as stream:
            stream.write(row[20:] + '\n')
        self.assertEqual(history.state(2)['turn'], 2)
        self.journal.write_text(json.dumps({'sequence': 4, 'type': 'swarm.snapshot', 'data': {'turn': 4}}) + '\n')
        self.assertEqual([r['sequence'] for r in history.frames()], [4])
        with self.assertRaises(ValueError):
            history.state(2)

    def test_control_targets_selected_nested_job_and_observation_never_acks(self):
        before = self.journal.read_bytes()
        self.data.world('workflow-run', 'child-1')
        self.data.control('workflow-run', 'child-1', 'pause')
        channel = self.run / 'runtime/channels/swarm-child-1'
        events = [json.loads(p.read_text()) for p in (channel / 'in').glob('[0-9]*.json')]
        self.assertEqual(events[0]['data']['id'], 'child-1')
        self.assertEqual(events[0]['type'], 'pause')
        self.assertFalse((channel / 'out/ack.json').exists())
        self.assertEqual(before, self.journal.read_bytes())
        with self.assertRaises(ValueError):
            self.data.control('workflow-run', 'child-1', 'resume')

    def test_http_scope_static_assets_and_same_origin_controls(self):
        server = Dashboard(self.root).start()
        self.addCleanup(server.close)
        def request(method, path, body=None, headers=None):
            connection = http.client.HTTPConnection('127.0.0.1', server.port)
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            data = response.read()
            connection.close()
            return response.status, data
        base = '/api/runs/workflow-run/jobs/child-1'
        self.assertEqual(request('GET', '/api/runs')[0], 200)
        self.assertEqual(request('GET', base + '/world')[0], 200)
        self.decision('attempt-one', 'agent-001', 0, stage='')
        status, body = request('GET', base + '/members')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['members'][0]['id'], 'agent-001')
        status, body = request('GET', base + '/members/agent-001')
        self.assertEqual(status, 200)
        self.assertIn('Inspect attempt-one', json.loads(body)['transcript']['text'])
        self.assertEqual(request('GET', base + '/members/unknown')[0], 404)
        self.assertEqual(request('GET', base + '/members/%2e%2e')[0], 400)
        self.assertEqual(request('GET', base + '/members/%2e%2e%2fprivate')[0], 404)
        status, body = request('GET', base + '/transcripts')
        self.assertEqual(status, 200)
        source = json.loads(body)['sources'][0]
        self.assertEqual(source['path'], 'swarm/decisions/attempt-one/agent.json')
        status, body = request('GET', base + '/transcripts/' + source['id'])
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['transcript']['messages'][1]['role'], 'assistant')
        self.assertEqual(request('GET', base + '/transcripts/' + 'f' * 64)[0], 404)
        self.assertEqual(request('GET', base + '/transcripts/%2e%2e')[0], 400)
        self.assertEqual(request('GET', base + '/transcripts/%2e%2e%2fprivate')[0], 404)
        self.assertEqual(request('GET', base + '/view/view.mjs')[0], 200)
        self.assertEqual(request('GET', base + '/view/%2e%2e/%2e%2e/run.json')[0], 400)
        self.assertEqual(request('GET', '/api/runs/%2e%2e')[0], 400)
        self.assertEqual(request('GET', '/api/runs', headers={'Host': 'hostile.example'})[0], 403)
        self.assertEqual(request('POST', base + '/control', '{"action":"pause"}',
            {'Content-Type': 'application/json', 'Origin': 'https://hostile.example'})[0], 403)
        self.assertEqual(request('POST', base + '/control', '{"action":"pause"}',
            {'Content-Type': 'application/json'})[0], 202)

    def world_artifact(self, contents='(board "saved Ω")\n'.encode()):
        record = json.loads((self.run / 'run.json').read_text())
        save(self.run / 'run.json', {**record, 'world_components': {
            'worlds/original': {'runtime': 'worlds/original-binding'},
            'worlds/replacement': {'runtime': 'worlds/replacement-binding'}}})
        save(self.job / 'worker.json', {'kind': 'swarm', 'world_package': 'worlds/original'})
        runtime = self.run / 'runtime/worlds/original-binding'
        path = runtime / 'exports/candidate/board.kicad_pcb'
        path.parent.mkdir(parents=True)
        path.write_bytes(contents)
        return runtime, path, {'path': str(path.relative_to(runtime)),
            'sha256': hashlib.sha256(contents).hexdigest(), 'size': len(contents)}

    def test_world_artifact_uses_job_package_and_survives_component_removal(self):
        runtime, path, reference = self.world_artifact()
        replacement = self.run / 'runtime/worlds/replacement-binding' / reference['path']
        replacement.parent.mkdir(parents=True)
        replacement.write_text('latest environment content must not replace old evidence')
        self.assertEqual(self.data.world_artifact('workflow-run', 'child-1', reference), path.read_bytes())
        # The file reader uses saved bindings, not the original environment or component.
        record = json.loads((self.run / 'run.json').read_text())
        record['environment'] = '/removed/environment'
        save(self.run / 'run.json', record)
        self.assertEqual(DashboardData(self.root).world_artifact('workflow-run', 'child-1', reference), path.read_bytes())
        with self.assertRaises(FileNotFoundError):
            self.data.world_artifact('workflow-run', 'unknown', reference)
        save(self.job / 'worker.json', {'kind': 'swarm', 'world_package': 'worlds/unrecorded'})
        with self.assertRaisesRegex(FileNotFoundError, 'recorded world runtime is unavailable'):
            self.data.world_artifact('workflow-run', 'child-1', reference)

    def test_world_artifact_rejects_invalid_references_and_changed_content(self):
        runtime, path, reference = self.world_artifact()
        cases = [None, {}, {**reference, 'package': 'worlds/replacement'}]
        cases += [{**reference, 'path': value} for value in ['', '.', '../private', '/private',
            'exports/../private', 'exports//candidate', 'exports/./candidate', 'exports\\private', 'x\0y', 4]]
        cases += [{**reference, 'size': value} for value in [True, -1, 1.5, '1', WORLD_ARTIFACT_BYTES + 1]]
        cases += [{**reference, 'sha256': value} for value in ['', 'A' * 64, 'g' * 64, None]]
        for case in cases:
            with self.subTest(reference=case), self.assertRaises(ValueError):
                self.data.world_artifact('workflow-run', 'child-1', case)
        path.write_bytes(b'x' * reference['size'])
        with self.assertRaisesRegex(ValueError, 'content does not match'):
            self.data.world_artifact('workflow-run', 'child-1', reference)
        path.write_bytes(b'changed length')
        with self.assertRaisesRegex(ValueError, 'size does not match'):
            self.data.world_artifact('workflow-run', 'child-1', reference)
        path.write_bytes(b'\xff')
        with self.assertRaises(UnicodeDecodeError):
            self.data.world_artifact('workflow-run', 'child-1',
                {**reference, 'size': 1, 'sha256': hashlib.sha256(b'\xff').hexdigest()})

    def test_world_artifact_rejects_symlinks_at_every_level_and_nonregular_files(self):
        runtime, path, reference = self.world_artifact()
        original = path.with_name('original')
        path.rename(original)
        path.symlink_to(original)
        with self.assertRaises(ValueError):
            self.data.world_artifact('workflow-run', 'child-1', reference)
        path.unlink()
        original.rename(path)
        candidate = path.parent
        moved = candidate.with_name('moved')
        candidate.rename(moved)
        candidate.symlink_to(moved, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.data.world_artifact('workflow-run', 'child-1', reference)
        candidate.unlink()
        moved.rename(candidate)
        moved_runtime = runtime.with_name('moved-runtime')
        runtime.rename(moved_runtime)
        runtime.symlink_to(moved_runtime, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.data.world_artifact('workflow-run', 'child-1', reference)
        runtime.unlink()
        moved_runtime.rename(runtime)
        path.unlink()
        os.mkfifo(path)
        with self.assertRaisesRegex(ValueError, 'regular file'):
            self.data.world_artifact('workflow-run', 'child-1', reference)

    def test_world_artifact_http_enforces_binding_integrity_and_containment(self):
        runtime, path, reference = self.world_artifact()
        contents = path.read_bytes()
        secret = self.root / 'private'
        secret.write_bytes(b'outside secret content')
        (runtime / 'escape').symlink_to(secret)
        (runtime / 'outside').symlink_to(self.root, target_is_directory=True)
        server = Dashboard(self.root).start()
        self.addCleanup(server.close)
        def get(value, extra=''):
            connection = http.client.HTTPConnection('127.0.0.1', server.port)
            connection.request('GET', '/api/runs/workflow-run/jobs/child-1/world-artifact?' + urlencode(value) + extra)
            response = connection.getresponse()
            result = response.status, response.getheader('Content-Type'), response.read()
            connection.close()
            self.assertNotIn(secret.read_bytes(), result[2])
            return result
        self.assertEqual(get(reference), (200, 'text/plain; charset=utf-8', contents))
        for override in [{'path': '../private'}, {'path': str(secret)}, {'path': 'escape'},
                         {'path': 'outside/private'}, {'sha256': '0' * 64}, {'size': 0}]:
            with self.subTest(override=override):
                self.assertEqual(get({**reference, **override})[0], 400)
        self.assertEqual(get({**reference, 'path': 'missing'})[0], 404)
        self.assertEqual(get(reference, '&size=1')[0], 400)
        self.assertEqual(get({**reference, 'package': 'worlds/replacement'})[0], 400)
        path.write_bytes(b'x' * reference['size'])
        self.assertEqual(get(reference)[0], 400)
        save(self.job / 'worker.json', {'kind': 'swarm'})
        self.assertEqual(get(reference)[0], 404)
        save(self.job / 'worker.json', {'kind': 'swarm', 'world_package': 'worlds/original'})
        record = json.loads((self.run / 'run.json').read_text())
        record['world_components']['worlds/original']['runtime'] = '../private'
        save(self.run / 'run.json', record)
        self.assertEqual(get(reference)[0], 400)

    def test_world_jobs_keep_their_own_view_generation_after_environment_refresh(self):
        record = json.loads((self.run / 'run.json').read_text())
        versions = {}
        for identity, entry in (('a' * 64, 'view.mjs'), ('b' * 64, 'replacement.mjs')):
            relative = f'world-view-versions/{identity}'
            asset = self.run / relative / entry
            asset.parent.mkdir(parents=True)
            asset.write_text(f'export const generation = "{identity}";')
            versions[identity] = {'directory': relative, 'entry': entry}
        save(self.run / 'run.json', {**record, 'world_view_versions': versions})
        save(self.job / 'worker.json', {'kind': 'swarm', 'world_view': 'a' * 64})
        new_job = self.run / 'jobs/child-2'
        new_queue = self.run / 'runtime/environments/lab/jobs/child-2'
        save(new_queue / 'request.json', {'id': 'child-2', 'type': 'local-search',
            'directory': '../../../jobs/child-2', 'workspace': '../../../workspace'})
        save(new_queue / 'state.json', {'id': 'child-2', 'type': 'local-search', 'status': 'running'})
        save(new_job / 'worker.json', {'kind': 'swarm', 'world_view': 'b' * 64})
        self.assertEqual(self.data.view('workflow-run', 'child-1')[1],
                         self.run / versions['a' * 64]['directory'] / 'view.mjs')
        self.assertEqual(self.data.view('workflow-run', 'child-2')[1],
                         self.run / versions['b' * 64]['directory'] / 'replacement.mjs')
        save(self.job / 'worker.json', {'kind': 'swarm', 'world_view': 'c' * 64})
        with self.assertRaisesRegex(ValueError, 'generation is unavailable'):
            self.data.view('workflow-run', 'child-1')
        save(self.job / 'worker.json', {'kind': 'swarm'})
        self.assertEqual(self.data.view('workflow-run', 'child-1')[1],
                         self.run / 'world-views/local-search/view.mjs')

    def test_asset_symlink_cannot_escape_saved_view(self):
        (self.run / 'world-views/local-search/view.mjs').unlink()
        secret = self.root / 'private.mjs'
        secret.write_text('private')
        (self.run / 'world-views/local-search/view.mjs').symlink_to(secret)
        with self.assertRaises(ValueError):
            self.data.view('workflow-run', 'child-1')

    def test_custom_design_serves_local_styles_fonts_and_identity_without_exposing_other_files(self):
        package = self.root / 'custom design'
        save(package / 'design.json', {'version': 1, 'name': 'Research', 'stylesheet': 'css/main.css',
            'logo': 'identity.svg', 'wordmark': 'Lab <&>', 'title': 'Research <console>'})
        (package / 'css').mkdir()
        (package / 'css/main.css').write_text(':root { --goal: #007799; }')
        (package / 'identity.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')
        (package / 'display.woff2').write_bytes(b'font fixture')
        (package / 'private.json').write_text('{"hidden":true}')
        (self.root / 'outside.css').write_text('private')
        (package / 'escape.css').symlink_to(self.root / 'outside.css')
        server = Dashboard(self.root, design=package).start()
        self.addCleanup(server.close)
        def get(path):
            connection = http.client.HTTPConnection('127.0.0.1', server.port)
            connection.request('GET', path)
            response = connection.getresponse()
            result = response.status, response.getheader('Content-Type'), response.read()
            connection.close()
            return result
        status, mime, html = get('/')
        self.assertEqual(status, 200)
        self.assertIn('text/html', mime)
        self.assertLess(html.index(b'/design/default/styles.css'), html.index(b'/design/custom/css/main.css'))
        self.assertIn(b'/design/custom/identity.svg', html)
        self.assertIn(b'Lab &lt;&amp;&gt;', html)
        self.assertIn(b'<title>Research &lt;console&gt;</title>', html)
        self.assertEqual(get('/design/custom/css/main.css'), (200, 'text/css', b':root { --goal: #007799; }'))
        self.assertEqual(get('/design/custom/display.woff2')[0], 200)
        self.assertEqual(get('/design/default/styles.css')[0], 200)
        for path in ('private.json', 'design.json', 'escape.css', '%2e%2e/outside.css', '%2Fetc/passwd'):
            self.assertEqual(get('/design/custom/' + path)[0], 400, path)
        self.assertEqual(get('/design/custom/absent.css')[0], 404)

    def test_invalid_design_fails_before_starting_a_server(self):
        package = self.root / 'invalid design'
        for config in ({'version': True}, {'version': 2}, {'version': 1, 'name': 'X'},
                       {'version': 1, 'name': 'X', 'stylesheet': '../outside.css'},
                       {'version': 1, 'name': 'X', 'stylesheet': 'main.css', 'script': 'theme.js'}):
            save(package / 'design.json', config)
            with self.assertRaises(ValueError):
                Design(package)


if __name__ == '__main__':
    unittest.main()
