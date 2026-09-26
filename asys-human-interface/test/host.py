import io
import fcntl
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "python"), str(ROOT.parent / "python"), str(ROOT.parent / "asys-runtime")]
from asys_human.channel import Channel, RPCError
from asys_human.launcher import Launcher, arguments
from asys.human_service import SharedHumanService
from asys_human.presentation import request_document
from asys_human.prompt import FormPrompt, Quit
from asys_runtime.channel import Reader, Writer, direction_root
from asys.lifecycle import LaunchError


class HostTests(unittest.TestCase):
    def test_context_is_presented_without_terminal_controls(self):
        output = io.StringIO()
        description = request_document("alpha.human", {"id": "review", "inputJson": json.dumps({"title": "Review", "prompt": "Question\x1b[2J?",
                    "context": {"report": "full context"}, "form": {"type": "integer"}})}, {})
        lines = iter(["2", "y"])
        FormPrompt(description, output).read(lambda: next(lines))
        self.assertEqual(description["form"], {"type": "integer"})
        self.assertIn("full context", output.getvalue())
        self.assertNotIn("\x1b", output.getvalue())

    def test_fifo_deduplicates_and_filters_candidates_without_claiming_queued_work(self):
        with tempfile.TemporaryDirectory() as directory:
            channel = Channel(directory, "alice")
            output = Writer(direction_root(directory, "human", "out"))
            def attention(worker, id="same", **changes):
                task = {"id": id, "status": "pending", "inputJson": '{"prompt":"Question?"}', **changes}
                output.send("attention", {"worker": worker, "task": task})
            attention("alpha")
            attention("beta")
            attention("alpha")
            attention("private", inputJson='{"prompt":"Private?","candidates":["bob"]}')
            channel.pump()
            self.assertEqual(list(channel.queue), [("alpha", "same"), ("beta", "same")])
            self.assertEqual(channel.input.last(), 0, "queued questions are not claimed")
            channel.current = channel.queue.popitem(last=False)[0]
            attention("alpha")
            attention("beta", status="claimed")
            channel.pump()
            self.assertFalse(channel.queue)

    def test_global_and_private_handlers_have_explicit_endpoint_roles(self):
        self.assertFalse(arguments([]).private)
        self.assertTrue(arguments(['--private', '--name', 'run-human']).private)

    def test_root_selects_the_system_and_human_state_is_derived_beneath_it(self):
        with patch.dict(os.environ, {'ASYS_STATE_ROOT': '/ambient/state'}):
            self.assertEqual(arguments([]).root, Path('/ambient/state'))
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                args = arguments(['--root', str(root)])
                self.assertEqual(SharedHumanService(args).directory.parent, root / 'human')
                launcher = Launcher(arguments(['--private', '--root', str(root)]))
                class Prepared(Exception):
                    pass
                with patch.object(launcher, 'view', side_effect=Prepared), self.assertRaises(Prepared):
                    launcher.setup()
                try:
                    self.assertEqual(launcher.directory.parent, root / 'human')
                    self.assertTrue((launcher.directory / 'session.json').is_file())
                finally:
                    launcher.lease.close()

    def test_cleanup_recovers_an_unacknowledged_claim_and_removes_only_its_component(self):
        args = arguments(["--claimant", "alice"])
        launcher = Launcher(args)
        with tempfile.TemporaryDirectory() as directory:
            launcher.directory = Path(directory)
            launcher.name = "human-interface-test"
            launcher.channel = Channel(Path(directory) / "runtime", "alice")
            launcher.owned = [launcher.name]
            launcher.active = {"worker": "alpha.human", "id": "review", "claimId": "original"}
            calls, commands = [], []
            def call(method, body, cleanup=False):
                calls.append((method, body, cleanup))
                return {"token": "recovered"} if method == "ClaimTask" else {}
            with patch.object(launcher, "call", side_effect=call), patch.object(launcher, "document", return_value={"components": [
                    {"name": "unrelated-worker"}, {"name": launcher.name}]}), patch.object(launcher, "command", side_effect=lambda command, **kwargs: commands.append(command) or ""):
                self.assertTrue(launcher.close())
            self.assertEqual(calls, [("ClaimTask", {"id": "review", "claimant": "alice", "claimId": "original"}, True),
                                     ("ReleaseTask", {"id": "review", "token": "recovered"}, True)])
            self.assertEqual(commands[-1][-3:], ["rm-component", "asys", "human-interface-test"])
            self.assertFalse(launcher.owned)


class PrivateRecoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='human-recovery-')
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.runtime = self.directory / 'runtime'
        self.runtime.mkdir()
        self.args = arguments(['--private', '--name', 'run-human', '--claimant', 'alice'])
        self.host = Launcher(self.args)
        self.component = {'name': 'run-human', 'image_id': 'sha256:fixture',
                          'status': {'status': 'running', 'health': 'healthy'},
                          'binds': [{'source': str(self.runtime), 'target': '/var/lib/asys-human'}],
                          'outputs': [{'name': 'human', 'service': 'asys.human.v1.Human'}]}
        self.saved = {'version': 1, 'system': self.args.system, 'component': 'run-human',
                      'dcomp': self.host.dcomp, 'endpoint': 'run-human.human', 'global': None,
                      'component_removed': False, 'persistent': True, 'claimant': 'bob',
                      'active': {'worker': 'writer', 'id': 'review', 'claimId': 'original'}}
        self.session = self.directory / 'session.json'
        self.session.write_text(json.dumps(self.saved))
        self.document = {'components': [self.component]}
        self.calls = []

    def rpc(self, worker, method, body, poll, **kwargs):
        self.calls.append((worker, method, body))
        replies = Reader(direction_root(self.directory, 'control', 'out')).read()
        self.assertFalse(any(event['type'] == 'attached' for event in replies),
                         'Attachment readiness was announced before claim recovery/discovery completed')
        if method == 'ClaimTask': return {'token': 'recovered'}
        if method == 'ReleaseTask': return {}
        if method == 'ListTasks':
            return {'tasks': [{'id': 'review', 'status': 'pending',
                              'inputJson': '{"prompt":"Review now?"}',
                              'metadataJson': '{"component":"writer"}'}]}
        self.fail('Unexpected RPC: ' + method)

    def test_attachment_releases_stale_claim_rediscovers_requests_and_retains_service(self):
        # Unacknowledged detach belongs to the former handler and cannot close
        # this fresh attachment or discard its saved claim.
        event = Writer(direction_root(self.directory, 'control', 'in')).send('detach', {})
        with patch.object(self.host, 'document', return_value=self.document), \
                patch.object(self.host, 'command') as command, patch.object(Channel, 'call', side_effect=self.rpc), \
                patch.dict(os.environ, {'ASYS_HUMAN_ATTACHMENT': 'fixture-attachment'}):
            self.host.setup()
            ready = [event for event in Reader(direction_root(self.directory, 'control', 'out')).read()
                     if event['type'] == 'attached']
            self.assertEqual([event['data'] for event in ready], [
                {'component': 'run-human', 'pid': os.getpid(), 'attachment': 'fixture-attachment'}])
            self.assertEqual(list(self.host.channel.queue), [('writer', 'review')])
            self.assertEqual(self.host.control.cursor, event['sequence'])
            self.assertTrue(self.host.persistent)
            self.assertFalse(self.host.owned)
            self.assertTrue(self.host.args.private)
            self.assertTrue(self.host.close())
            command.assert_not_called()
        self.assertEqual(self.calls[:2], [
            ('writer', 'ClaimTask', {'id': 'review', 'claimant': 'bob', 'claimId': 'original'}),
            ('writer', 'ReleaseTask', {'id': 'review', 'token': 'recovered'})])
        saved = json.loads(self.session.read_text())
        self.assertFalse(saved['component_removed'])
        self.assertIsNone(saved['active'])
        self.assertIsNone(saved['global'])

    def test_attachment_rejects_identity_mismatch_before_touching_session(self):
        for key, value in [('system', 'another'), ('component', 'another'),
                           ('dcomp', ['dcomp', '--state-root', '/another']),
                           ('global', 'human_endpoint'), ('component_removed', True), ('persistent', False)]:
            with self.subTest(field=key):
                self.session.write_text(json.dumps({**self.saved, key: value}))
                original = self.session.read_bytes()
                host = Launcher(arguments(['--private', '--name', 'run-human']))
                with patch.object(host, 'document', return_value=self.document), \
                        patch.object(host, 'command') as command, self.assertRaisesRegex(LaunchError, 'does not match'):
                    host.setup()
                self.assertIsNone(host.directory)
                self.assertEqual(self.session.read_bytes(), original)
                command.assert_not_called()

    def test_attachment_refuses_a_second_terminal(self):
        with (self.directory / 'handler.lock').open('a+b') as lease:
            fcntl.flock(lease, fcntl.LOCK_EX)
            with patch.object(self.host, 'document', return_value=self.document), \
                    self.assertRaisesRegex(LaunchError, 'already attached'):
                self.host.setup()
        self.assertIsNone(self.host.directory)

    def test_failed_claim_recovery_never_announces_attachment_readiness(self):
        with patch.object(self.host, 'document', return_value=self.document), \
                patch.object(self.host, 'command') as command, \
                patch.object(Channel, 'call', side_effect=RPCError('Unavailable', 'fixture offline')):
            try:
                with self.assertRaises(RPCError): self.host.setup()
                replies = Reader(direction_root(self.directory, 'control', 'out')).read()
                self.assertFalse(any(event['type'] == 'attached' for event in replies))
            finally:
                self.host.close()
            command.assert_not_called()

    def test_new_named_private_service_still_uses_creation_path(self):
        host = Launcher(arguments(['--private', '--name', 'new-human', '--root', str(self.directory)]))
        try:
            with patch.object(host, 'view', return_value={'components': []}), \
                    patch.object(host, 'command', return_value='sha256:fixture'), \
                    patch.object(host, 'attach') as create:
                host.setup()
            create.assert_called_once_with()
            self.assertFalse(host.persistent)
            self.assertEqual(host.name, 'new-human')
            replies = Reader(direction_root(host.directory, 'control', 'out')).read()
            self.assertEqual([event['data']['component'] for event in replies if event['type'] == 'attached'],
                             ['new-human'])
        finally:
            if host.lease: host.lease.close()

    def test_shared_terminal_attachment_keeps_its_existing_endpoint_role(self):
        self.session.write_text(json.dumps({**self.saved, 'global': 'human_endpoint'}))
        host = Launcher(arguments(['--claimant', 'alice']))
        with patch('asys_human.launcher.ensure_human', return_value=self.component), \
                patch.object(host, 'document', return_value=self.document), \
                patch.object(host, 'command') as command, patch.object(Channel, 'call', side_effect=self.rpc):
            host.setup()
            self.assertEqual(list(host.channel.queue), [('writer', 'review')])
            self.assertTrue(host.close())
            command.assert_not_called()
        self.assertEqual(json.loads(self.session.read_text())['global'], 'human_endpoint')

    def private_owner(self):
        host = Launcher(arguments(['--private', '--claimant', 'alice']))
        host.directory = self.directory
        host.name = 'run-human'
        host.channel = Channel(self.runtime, 'alice')
        host.control = Reader(direction_root(self.directory, 'control', 'in'))
        host.control_output = Writer(direction_root(self.directory, 'control', 'out'))
        host.owned = [host.name]
        host.image = 'sha256:fixture'
        host.active = {'worker': 'writer', 'id': 'review', 'claimId': 'original', 'token': 'claimed'}
        return host

    def test_signal_before_tick_honors_durable_detach_without_removing_component(self):
        host = self.private_owner()
        event = Writer(direction_root(self.directory, 'control', 'in')).send('detach', {})
        host.interrupted.set()
        with patch.object(host, 'call', return_value={}) as call, patch.object(host, 'command') as command:
            self.assertTrue(host.close())
            command.assert_not_called()
        call.assert_called_once_with('ReleaseTask', {'id': 'review', 'token': 'claimed'}, True)
        saved = json.loads(self.session.read_text())
        self.assertTrue(saved['persistent'])
        self.assertFalse(saved['component_removed'])
        self.assertIsNone(saved['active'])
        replies = Reader(direction_root(self.directory, 'control', 'out')).read()
        self.assertEqual(replies[0]['type'], 'detached')
        self.assertEqual(replies[0]['data'], {'request': event['sequence'], 'component': 'run-human'})

    def test_tick_detaches_before_releasing_claim_and_shutdown_preserves_it(self):
        host = self.private_owner()
        Writer(direction_root(self.directory, 'control', 'in')).send('detach', {})
        with self.assertRaises(Quit): host.tick()
        self.assertTrue(host.persistent)
        self.assertFalse(host.owned)
        self.assertEqual(json.loads(self.session.read_text())['active'], host.active)
        with patch.object(host, 'call', side_effect=RPCError('Unavailable', 'fixture offline')), \
                patch.object(host, 'command') as command:
            self.assertFalse(host.close())
            command.assert_not_called()
        saved = json.loads(self.session.read_text())
        self.assertFalse(saved['component_removed'])
        self.assertEqual(saved['active']['claimId'], 'original')


if __name__ == "__main__":
    unittest.main()
