"""Bounded health recovery must preserve running work and target only its engine."""
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'python'), str(ROOT / 'asys-runtime')]
from asys.lifecycle import CommandTimeout, Interrupted, RecoveryRequired
from asys.workflow import Launcher
from asys import workflow
from asys.single_job import SingleJob, run as run_single_job
from asys.runs import Runs, status as show_status


class HealthRecovery(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix='asys-health-')
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)

    def launcher(self):
        host = Launcher(SimpleNamespace(system='test', command='run', root=self.directory))
        host.directory = self.directory
        host.names = {'engine': 'engine', 'workers': 'worker'}
        host.owned = ['world', 'worker', 'engine']
        host.record = {'id': 'fixture', 'status': 'running', 'kind': 'workflow'}
        host.say = Mock()
        (host.directory / 'workflow').mkdir(exist_ok=True)
        (host.directory / 'workflow/workflow.sqlite').write_bytes(b'checkpoint retained')
        (host.directory / 'job-state.json').write_text('{"id":"existing-job","status":"running"}')
        components = {name: {'status': {'status': 'running', 'health': 'healthy', 'container_id': name}}
                      for name in [*host.owned, 'unrelated']}
        return host, components

    def test_transient_health_is_visible_and_recovers_without_restart(self):
        host, components = self.launcher()
        components['engine']['status']['health'] = 'unhealthy'
        with patch.object(host, 'observe', return_value=({}, components)), \
                patch.object(host, 'command', return_value='{}') as command, \
                patch('asys.execution.time.monotonic', return_value=100) as clock:
            host.monitor_components()
            self.assertEqual(Runs(host.directory).snapshot(host.directory)['status'], 'degraded')
            clock.return_value = 159
            components['engine']['status']['health'] = 'healthy'
            host.monitor_components()
            self.assertEqual(Runs(host.directory).snapshot(host.directory)['status'], 'running')
            self.assertEqual(host.record['component_health'], {})
            self.assertTrue(all('restart' not in call.args[0] for call in command.call_args_list))

    def test_sustained_engine_health_restarts_only_engine_then_recovers_existing_work(self):
        host, components = self.launcher()
        components['engine']['status']['health'] = 'unhealthy'
        commands = []
        def command(argv, **kwargs):
            commands.append(argv)
            if argv == host.dcomp + ['restart', 'test', 'engine']:
                self.assertEqual(kwargs['timeout'], 120)
                self.assertEqual(json.loads((host.directory / 'run.json').read_text())['status'], 'recovering')
                components['engine']['status'].update(container_id='replacement-engine', health='starting')
                return ''
            self.assertEqual(argv[:5], ['docker', 'container', 'inspect', '--format', '{{json .State}}'])
            return '{"Running":true}'
        with patch.object(host, 'observe', return_value=({}, components)), \
                patch.object(host, 'command', side_effect=command), \
                patch('asys.execution.time.monotonic', return_value=100) as clock:
            host.monitor_components()
            clock.return_value = 159
            host.monitor_components()
            self.assertFalse(any('restart' in argv for argv in commands))
            clock.return_value = 160
            host.monitor_components()
            self.assertEqual(json.loads((host.directory / 'run.json').read_text())['status'], 'recovering')
            self.assertEqual(host.record['component_health']['engine']['state'], 'restarting')
            clock.return_value = 200
            host.monitor_components()
            components['engine']['status']['health'] = 'healthy'
            host.monitor_components()
            self.assertEqual(host.record['status'], 'running')
            self.assertEqual(host.record['health_restarts'], {'engine': 1})
            self.assertEqual([argv for argv in commands if 'restart' in argv],
                             [host.dcomp + ['restart', 'test', 'engine']])
            for name in ['world', 'worker', 'unrelated']:
                self.assertEqual(components[name]['status']['container_id'], name)
            self.assertEqual((host.directory / 'workflow/workflow.sqlite').read_bytes(), b'checkpoint retained')
            self.assertEqual(json.loads((host.directory / 'job-state.json').read_text()),
                             {'id': 'existing-job', 'status': 'running'})
            # A recurrent fault cannot create a restart loop.
            components['engine']['status']['health'] = 'unhealthy'
            host.monitor_components()
            clock.return_value = 260
            with self.assertRaisesRegex(RecoveryRequired, 'restart limit'):
                host.monitor_components()
            self.assertEqual(len([argv for argv in commands if 'restart' in argv]), 1)

    def test_failed_engine_health_recovery_is_bounded_visible_and_preserves_components(self):
        host, components = self.launcher()
        components['engine']['status']['health'] = 'unhealthy'
        with patch.object(host, 'observe', return_value=({}, components)), \
                patch.object(host, 'command', return_value='{}') as command, \
                patch('asys.execution.time.monotonic', return_value=100) as clock, \
                patch.object(host, 'cleanup_components') as cleanup:
            host.monitor_components()
            clock.return_value = 160
            host.monitor_components()
            components['engine']['status']['health'] = 'starting'
            clock.return_value = 249
            host.monitor_components()
            clock.return_value = 250
            with self.assertRaisesRegex(RecoveryRequired, 'did not recover'):
                host.monitor_components()
            self.assertTrue(host.close())
            cleanup.assert_not_called()
            restarts = [call.args[0] for call in command.call_args_list if 'restart' in call.args[0]]
            self.assertEqual(restarts, [host.dcomp + ['restart', 'test', 'engine']])
        observed = Runs(host.directory).snapshot(host.directory)
        self.assertEqual(observed['status'], 'recovery-required')
        self.assertFalse(observed['components_removed'])
        self.assertEqual(host.owned, ['world', 'worker', 'engine'])
        with contextlib.redirect_stdout(io.StringIO()) as output:
            show_status(SimpleNamespace(root=host.directory, run=str(host.directory), json=False))
        self.assertIn('Status: recovery-required', output.getvalue())
        self.assertIn('Health: engine: recovery-required', output.getvalue())
        history = [json.loads(line) for line in (host.directory / 'component-health.jsonl').read_text().splitlines()]
        self.assertEqual([item.get('action') for item in history], [None, 'restart', 'recovery-required'])
        self.assertEqual((host.directory / 'workflow/workflow.sqlite').read_bytes(), b'checkpoint retained')

    def test_workers_worlds_and_await_resume_engines_require_preserved_manual_recovery(self):
        for name, resumed in [('worker', False), ('world', False), ('engine', True)]:
            with self.subTest(component=name, resumed=resumed):
                host, components = self.launcher()
                if resumed:
                    host.record['resumed_at'] = 'previous resume'
                components[name]['status']['health'] = 'unhealthy'
                with patch.object(host, 'observe', return_value=({}, components)), \
                        patch.object(host, 'command', return_value='{}') as command, \
                        patch('asys.execution.time.monotonic', return_value=100) as clock, \
                        patch.object(host, 'cleanup_components') as cleanup:
                    host.monitor_components()
                    clock.return_value = 160
                    with self.assertRaises(RecoveryRequired):
                        host.monitor_components()
                    host.close()
                    cleanup.assert_not_called()
                    self.assertTrue(all('restart' not in call.args[0] for call in command.call_args_list))

    def test_restart_command_failure_preserves_and_interrupt_still_cancels(self):
        for error in [CommandTimeout('restart timeout'), Interrupted()]:
            with self.subTest(error=error):
                host, components = self.launcher()
                components['engine']['status']['health'] = 'unhealthy'
                def command(argv, **kwargs):
                    if 'restart' in argv:
                        raise error
                    return '{}'
                with patch.object(host, 'observe', return_value=({}, components)), \
                        patch.object(host, 'command', side_effect=command), \
                        patch('asys.execution.time.monotonic', return_value=100) as clock, \
                        patch.object(host, 'cleanup_components', return_value=True) as cleanup:
                    host.monitor_components()
                    clock.return_value = 160
                    with self.assertRaises(Interrupted if isinstance(error, Interrupted) else RecoveryRequired):
                        host.monitor_components()
                    if isinstance(error, Interrupted):
                        host.record['status'] = 'cancelled'
                        host.close()
                        cleanup.assert_called_once()
                    else:
                        host.close()
                        cleanup.assert_not_called()

    def test_unobservable_health_cannot_hide_an_expired_grace_period(self):
        host, components = self.launcher()
        components['worker']['status']['health'] = 'unhealthy'
        with patch.object(host, 'observe', return_value=({}, components)) as observe, \
                patch.object(host, 'command', return_value='{}'), \
                patch('asys.execution.time.monotonic', return_value=100) as clock:
            host.monitor_components()
            observe.side_effect = CommandTimeout('view delayed')
            clock.return_value = 160
            with self.assertRaisesRegex(RecoveryRequired, 'could not be observed'):
                host.monitor_components()

    def test_single_job_health_failure_exits_without_cancelling_its_running_job(self):
        host = SingleJob(SimpleNamespace(system='test'))
        host.directory = self.directory
        host.record = {'status': 'running'}
        host.queue, host.job_id = Mock(), 'existing-job'
        host.say = Mock()
        with patch.object(host, 'setup', create=True), \
                patch.object(host, 'execute', create=True, side_effect=lambda: host.require_health_recovery('worker', 'health failed')), \
                patch.object(host, 'cleanup_components') as cleanup:
            self.assertEqual(run_single_job(host), 1)
            cleanup.assert_not_called()
            host.queue.cancel.assert_not_called()
            record = json.loads((host.directory / 'run.json').read_text())
            self.assertEqual(record['status'], 'recovery-required')
            self.assertFalse(record['components_removed'])

    def test_restart_budget_survives_launcher_reattachment(self):
        from asys.run import arguments
        host, components = self.launcher()
        host.record.update(status='recovery-required', components=host.names, system='test', dcomp=host.dcomp,
                           links={}, health_restarts={'engine': 1}, engine_await_resume=False)
        (host.directory / 'environment').mkdir()
        (host.directory / 'environment/component.dcomp').write_text('docker saved-workers\n')
        host.snapshot()
        attached = Launcher(arguments(['--resume', str(host.directory), '--root', str(self.directory)]))
        attached.say = Mock()
        try:
            with patch.object(attached, 'document', return_value={'components': [
                    {'name': name, **component} for name, component in components.items()]}), \
                    patch.object(attached, 'reattach_request', return_value={'status': 'waiting', 'active': True}), \
                    patch.object(attached, 'start_components') as start:
                attached.setup()
            start.assert_not_called()
            self.assertTrue(attached.reattaching)
            attached.record['status'] = 'running'
            attached.save_record = True
            components['engine']['status']['health'] = 'unhealthy'
            with patch.object(attached, 'observe', return_value=({}, components)), \
                    patch.object(attached, 'command', return_value='{}') as command, \
                    patch('asys.execution.time.monotonic', return_value=100) as clock:
                attached.monitor_components()
                clock.return_value = 160
                with self.assertRaisesRegex(RecoveryRequired, 'restart limit'):
                    attached.monitor_components()
                self.assertTrue(all('restart' not in call.args[0] for call in command.call_args_list))
        finally:
            # Fixture owns no real containers.
            attached.owned = []
            attached.close()

    def test_monitor_failure_after_restart_preserves_remaining_components(self):
        for failure in [CommandTimeout('view timeout'), ValueError('bad response'), 'missing', 'exited']:
            with self.subTest(failure=failure):
                host, components = self.launcher()
                components['engine']['status']['health'] = 'unhealthy'
                with patch.object(host, 'observe', return_value=({}, components)) as observe, \
                        patch.object(host, 'command', return_value='{}'), \
                        patch('asys.execution.time.monotonic', return_value=100) as clock, \
                        patch.object(host, 'cleanup_components') as cleanup:
                    host.monitor_components()
                    clock.return_value = 160
                    host.monitor_components()
                    if isinstance(failure, Exception):
                        observe.side_effect = failure
                        clock.return_value = 250
                    elif failure == 'missing':
                        components.pop('engine')
                    else:
                        components['engine']['status']['status'] = 'exited'
                    with self.assertRaises(RecoveryRequired):
                        host.monitor_components()
                    host.close()
                    cleanup.assert_not_called()

    def test_health_snapshot_failure_does_not_turn_diagnostics_into_teardown(self):
        host, components = self.launcher()
        components['worker']['status']['health'] = 'unhealthy'
        with patch.object(host, 'observe', return_value=({}, components)), \
                patch.object(host, 'command', return_value='{}'), \
                patch.object(host, 'snapshot', side_effect=OSError('disk unavailable')), \
                patch('asys.execution.time.monotonic', return_value=100) as clock:
            host.monitor_components()
            self.assertEqual(host.record['status'], 'degraded')
            clock.return_value = 160
            with self.assertRaises(RecoveryRequired):
                host.monitor_components()
            self.assertTrue(host.preserve_components)

    def test_restart_requires_a_durable_budget_and_a_checkpoint(self):
        for reason in ['budget', 'checkpoint']:
            with self.subTest(reason=reason):
                host, components = self.launcher()
                components['engine']['status']['health'] = 'unhealthy'
                if reason == 'checkpoint':
                    (host.directory / 'workflow/workflow.sqlite').unlink()
                with patch.object(host, 'observe', return_value=({}, components)), \
                        patch.object(host, 'command', return_value='{}') as command, \
                        patch('asys.execution.time.monotonic', return_value=100) as clock:
                    host.monitor_components()
                    if reason == 'budget':
                        host.snapshot = Mock(side_effect=OSError('disk unavailable'))
                    clock.return_value = 160
                    with self.assertRaisesRegex(RecoveryRequired, reason):
                        host.monitor_components()
                    self.assertTrue(all('restart' not in call.args[0] for call in command.call_args_list))
                    self.assertTrue(host.preserve_components)

    def test_workflow_health_failure_returns_one_and_preserves_in_finally(self):
        host, _ = self.launcher()
        with patch.object(workflow, 'Launcher', return_value=host), \
                patch.object(host, 'setup'), \
                patch.object(host, 'execute', side_effect=lambda: host.require_health_recovery('engine', 'health failed')), \
                patch.object(host, 'cleanup_components') as cleanup:
            self.assertEqual(workflow.run(host.args), 1)
            cleanup.assert_not_called()
        self.assertEqual(json.loads((host.directory / 'run.json').read_text())['status'], 'recovery-required')

    def test_interrupt_after_health_failure_still_requests_component_cleanup(self):
        host, _ = self.launcher()
        with self.assertRaises(RecoveryRequired):
            host.require_health_recovery('engine', 'health failed')
        host.interrupted.set()
        with patch.object(host, 'cleanup_components', return_value=True) as cleanup:
            host.close()
            cleanup.assert_called_once()

    def prepare_reattachment(self, *, human=False):
        from asys.run import arguments
        host, components = self.launcher()
        if human:
            host.names['human'] = 'private-human'
            components['private-human'] = {'status': {'status': 'running', 'health': 'healthy'}}
        host.record.update(status='recovery-required', components=host.names, system='test', dcomp=host.dcomp,
                           links={}, engine_await_resume=True)
        (host.directory / 'environment').mkdir()
        (host.directory / 'environment/component.dcomp').write_text('docker saved-workers\n')
        host.snapshot()
        args = arguments(['--resume', str(host.directory), '--root', str(self.directory), *(['--human'] if human else [])])
        attached = Launcher(args)
        attached.say = Mock()
        return attached, {'components': [{'name': name, **component} for name, component in components.items()]}

    def test_reattach_probes_execution_and_recovers_inactive_checkpoint_without_resume(self):
        from asys_runtime.channel import Writer
        for active in [True, False]:
            with self.subTest(active=active), tempfile.TemporaryDirectory(dir=self.directory) as directory:
                previous, self.directory = self.directory, Path(directory)
                attached, document = self.prepare_reattachment()
                sent, original = [], Writer.send
                output = Writer(self.directory / 'runtime/channels/workflow/out')
                def send(writer, kind, data):
                    event = original(writer, kind, data)
                    if writer.directory.name == 'in':
                        sent.append(kind)
                        original(output, 'accepted', {'request': event['sequence'], 'runId': 'fixture',
                                 'workflowId': 'saved', 'status': 'waiting', 'active': active or kind == 'recover'})
                    return event
                try:
                    with patch.object(attached, 'document', return_value=document), \
                            patch.object(Writer, 'send', send), \
                            patch.object(attached, 'start_components') as start:
                        attached.setup()
                    self.assertEqual(sent, ['status'] if active else ['status', 'recover'])
                    self.assertTrue(attached.reattaching)
                    start.assert_not_called()
                    self.assertEqual(json.loads((self.directory / 'job-state.json').read_text())['id'], 'existing-job')
                    self.assertEqual(workflow.Reader(output.directory).cursor, 0, 'probe must not consume run events')
                finally:
                    attached.owned = []
                    attached.close()
                    self.directory = previous

    def test_reattach_timeout_or_inactive_recovery_keeps_required_components(self):
        from asys_runtime.channel import Writer
        for failure in ['timeout', 'unsupported', 'inactive', 'terminal-result-missing']:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory(dir=self.directory) as directory:
                previous, self.directory = self.directory, Path(directory)
                attached, document = self.prepare_reattachment()
                attached.REATTACH_TIMEOUT = .01
                sent, original = [], Writer.send
                output = Writer(self.directory / 'runtime/channels/workflow/out')
                def send(writer, kind, data):
                    event = original(writer, kind, data)
                    if writer.directory.name == 'in':
                        sent.append(kind)
                        if failure == 'unsupported':
                            original(output, 'rejected', {'request': event['sequence'], 'message': 'Unknown request status'})
                        elif failure == 'inactive':
                            original(output, 'accepted', {'request': event['sequence'], 'runId': 'fixture',
                                     'workflowId': 'saved', 'status': 'waiting', 'active': False})
                        elif failure == 'terminal-result-missing':
                            original(output, 'accepted', {'request': event['sequence'], 'runId': 'fixture',
                                     'workflowId': 'saved', 'status': 'completed', 'active': False})
                    return event
                try:
                    with patch.object(attached, 'document', return_value=document), \
                            patch.object(Writer, 'send', send), \
                            patch.object(attached, 'cleanup_components') as cleanup:
                        with self.assertRaises(RecoveryRequired):
                            attached.setup()
                        attached.close()
                        cleanup.assert_not_called()
                    self.assertEqual(sent, ['status', 'recover'] if failure == 'inactive' else ['status'])
                    self.assertEqual(json.loads((self.directory / 'run.json').read_text())['status'], 'recovery-required')
                    self.assertEqual(set(attached.owned), {'worker', 'engine'})
                finally:
                    attached.owned = []
                    attached.close()
                    self.directory = previous

    def test_private_human_is_detached_before_preserved_workflow_close(self):
        host, _ = self.launcher()
        handler = Mock()
        handler.close.return_value = True
        host.human = handler
        with self.assertRaises(RecoveryRequired):
            host.require_health_recovery('engine', 'health failed')
        with patch.object(host, 'cleanup_components') as cleanup:
            self.assertTrue(host.close())
            cleanup.assert_not_called()
            handler.close.assert_called_once_with(preserve=True)

    def test_human_detach_intent_is_durable_before_sigterm(self):
        from asys.human import HumanHandler
        from asys_runtime.channel import Reader, direction_root
        host, _ = self.launcher()
        handler = HumanHandler(host, 'private-human')
        handler.directory = self.directory / 'human'
        handler.process = Mock()
        handler.process.poll.return_value = None
        handler.process.returncode = 130
        def terminate():
            event, = Reader(direction_root(handler.directory, 'control', 'in')).read()
            self.assertEqual(event['type'], 'detach')
        handler.process.terminate.side_effect = terminate
        self.assertTrue(handler.close(preserve=True))
        handler.process.terminate.assert_called_once()

    def test_private_human_can_reattach_with_existing_workflow(self):
        attached, document = self.prepare_reattachment(human=True)
        try:
            with patch.object(attached, 'document', return_value=document), \
                    patch.object(attached, 'reattach_request', return_value={'status': 'waiting', 'active': True}), \
                    patch.object(workflow, 'HumanHandler') as handler:
                attached.setup()
                handler.assert_called_once_with(attached, 'private-human')
                handler.return_value.start.assert_called_once_with(attach=True)
            self.assertIn('private-human', attached.owned)
        finally:
            attached.human = None
            attached.owned = []
            attached.close()

    def test_human_start_waits_for_its_terminal_attachment_not_only_component_health(self):
        from asys.human import HumanHandler
        from asys_runtime.channel import Writer, direction_root
        host, _ = self.launcher()
        host.args.human = True
        handler = HumanHandler(host, 'private-human')
        child = Mock(pid=123)
        child.poll.return_value = None
        runtime = self.directory / 'human/runtime'
        calls, selected = [], {}
        def start(command, env):
            selected.update(env)
            self.assertIn('--private', command)
            self.assertNotIn('--attach', command)
            return child
        def view(*args):
            calls.append(args)
            if len(calls) == 2:
                Writer(direction_root(runtime.parent, 'control', 'out')).send('attached', {
                    'component': 'private-human', 'attachment': selected['ASYS_HUMAN_ATTACHMENT']})
            return {'components': [{'name': 'private-human', 'status': {'status': 'running', 'health': 'healthy'},
                                    'binds': [{'source': str(runtime), 'target': '/var/lib/asys-human'}]}]}
        with patch('asys.human.subprocess.Popen', side_effect=start), \
                patch.object(host, 'document', side_effect=view), patch.object(host.interrupted, 'wait'):
            handler.start(attach=True)
        self.assertEqual(len(calls), 2)
        self.assertEqual(handler.directory, runtime.parent)

    def test_reattached_terminal_result_finishes_even_after_old_event_was_consumed(self):
        from asys_runtime.channel import Writer
        attached, document = self.prepare_reattachment()
        saved_path = attached.args.root / 'run.json'
        saved = json.loads(saved_path.read_text())
        saved.update(workflow='saved workflow', environment='fixture')
        saved_path.write_text(json.dumps(saved))
        original = Writer.send
        output = Writer(self.directory / 'runtime/channels/workflow/out')
        result = {'runId': 'fixture', 'workflowId': 'saved', 'status': 'completed', 'output': {'answer': 42}}
        previous = output.send('run.result', result)
        workflow.Reader(output.directory).advance(previous['sequence'])
        def send(writer, kind, data):
            event = original(writer, kind, data)
            if writer.directory.name == 'in':
                self.assertEqual(kind, 'status')
                original(output, 'accepted', {'request': event['sequence'], 'runId': 'fixture',
                         'workflowId': 'saved', 'status': 'completed', 'active': False, 'result': result})
            return event
        try:
            with patch.object(attached, 'document', return_value=document), patch.object(Writer, 'send', send):
                attached.setup()
            with contextlib.redirect_stdout(io.StringIO()) as written:
                attached.execute()
            self.assertEqual(json.loads(written.getvalue()), {'answer': 42})
            self.assertEqual(attached.record['status'], 'completed')
        finally:
            attached.owned = []
            attached.close()


if __name__ == '__main__':
    unittest.main()
