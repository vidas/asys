"""Workflow upgrades preserve job outcomes and resume partial maintenance."""
from copy import deepcopy
import fcntl
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'python'), str(ROOT / 'asys-runtime')]
from asys.lifecycle import Interrupted, LaunchError
from asys.upgrade import UpgradeHandover, finish_upgrade, handover_if_requested, pending_upgrade, prepare_upgrade
from asys.workflow import Launcher
from asys_runtime.files import acquire_lock, read_json, write_json
from asys_runtime.queue import Queue


OLD = 'sha256:' + '1' * 64
WORKER = 'sha256:' + '2' * 64
ENGINE = 'sha256:' + '3' * 64
WORLD = 'sha256:' + '4' * 64


class Host:
    def __init__(self, root, components):
        self.args = SimpleNamespace(root=root, run='saved-run', command='upgrade', human=False)
        self.directory = root / 'runs/saved-run'
        self.components = components
        self.record = {}
        self.lease = None
        self.owned = []
        self.human = None
        self.save_record = self.upgrade_in_progress = self.upgrade_handover = self.preserve_components = False
        self.interrupted = threading.Event()
        self.commands = []
        self.notices = []
        self.requests = []
        self.builds = 0
        self.native = {'runId': 'saved-run', 'status': 'running', 'active': True}
        self.operation = None
        self.fail_remove = self.fail_start = self.fail_recover = False

    def say(self, value):
        self.notices.append(value)

    def snapshot(self):
        if self.save_record:
            write_json(self.directory / 'run.json', self.record)

    def document(self, *args):
        return {'components': list(self.components.values()), 'operation': self.operation}

    def check_interrupt(self):
        if self.interrupted.is_set():
            raise Interrupted()

    def check_components(self, components, names=None):
        for name in self.owned if names is None else names:
            if name not in components or components[name]['status']['status'] != 'running':
                raise LaunchError('Unavailable component ' + name)

    def command(self, argv, **kwargs):
        self.commands.append(argv)
        if argv[-3] != 'rm-component':
            raise AssertionError(argv)
        name = argv[-1]
        self.components.pop(name)
        if name == 'worker' and self.fail_remove:
            self.fail_remove = False
            raise LaunchError('lost component removal response')
        return ''

    def engine_image(self):
        return ENGINE

    def prepare_environment(self, source, links, *, human_target=None):
        assert 'engine' not in self.components and 'worker' not in self.components
        self.builds += 1
        (self.directory / 'environment/component.dcomp').write_text('docker ' + WORKER + '\n')
        (self.directory / 'world-components/world/component.dcomp').write_text('docker ' + WORLD + '\n')
        self.record['world_components']['worlds/test']['image'] = WORLD
        self.prepared_links = (links, human_target)

    def execution_mounts(self):
        return []

    def start_workers(self):
        self.models_at_start = read_json(self.directory / 'system-models.json')
        self.add('world-id', 'world-components/world', [])
        self.add('workers', 'environment', [])

    def add(self, role, directory, options):
        name = self.names[role]
        image = (self.directory / directory / 'component.dcomp').read_text().split()[1]
        self.components[name] = {'name': name, 'image_id': image,
                                 'status': {'container_id': 'new-' + name, 'status': 'running', 'health': 'healthy'}}
        self.owned.append(name)
        if role == 'engine':
            assert '--arg=--await-resume' in options
            self.native = {'runId': 'saved-run', 'status': 'running', 'active': False}
        if role == 'workers' and self.fail_start:
            self.fail_start = False
            raise LaunchError('start interrupted')

    def wait_ready(self):
        self.check_components(self.components)

    def reattach_request(self, kind):
        self.requests.append(kind)
        if kind == 'recover':
            self.native['active'] = True
            if self.fail_recover:
                self.fail_recover = False
                raise LaunchError('lost recovery reply')
        elif kind != 'status':
            raise AssertionError('Upgrade must never send ' + kind)
        return deepcopy(self.native)


class Upgrade(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='asys-upgrade-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.directory = self.root / 'runs/saved-run'
        for relative in ['environment', 'engine', 'workflow', 'workspace', 'source', 'jobs', 'world-components/world']:
            (self.directory / relative).mkdir(parents=True)
        (self.directory / 'workflow/workflow.sqlite').write_bytes(b'durable checkpoint')
        (self.directory / 'environment/component.dcomp').write_text('docker ' + OLD + '\n')
        (self.directory / 'engine/component.dcomp').write_text('docker ' + OLD + '\n')
        (self.directory / 'world-components/world/component.dcomp').write_text('docker ' + OLD + '\n')
        write_json(self.directory / 'source/workers.json', {'version': 1, 'name': 'test',
            'types': {'program': {'command': ['python3', 'worker.py']}}})
        write_json(self.directory / 'system-models.json', {'simple': 'saved/model'})
        write_json(self.directory / 'run.json', {'id': 'saved-run', 'status': 'failed', 'error': 'old host failure',
            'workflow': '/saved/workflow.bpmn', 'environment_directory': str(self.directory / 'source'),
            'environment': 'test', 'workspace': str(self.directory / 'workspace'), 'system': 'shared',
            'dcomp': ['dcomp', '--state-root', '/saved/dcomp'], 'links': {'inference': '@saved_provider', 'human': '@human_endpoint'},
            'components': {'engine': 'engine', 'workers': 'worker', 'world-id': 'world'},
            'world_components': {'worlds/test': {'name': 'world', 'role': 'world-id', 'directory': 'world-components/world', 'image': OLD}}})
        self.components = {name: {'name': name, 'image_id': OLD,
            'status': {'container_id': 'old-' + name, 'status': 'running', 'health': 'healthy'}}
            for name in ['engine', 'worker', 'world', 'unrelated']}
        self.host = self.make_host()

    def make_host(self):
        host = Host(self.root, self.components)
        self.addCleanup(lambda: host.lease.close() if host.lease and not host.lease.closed else None)
        return host

    def retry(self):
        self.host.lease.close()
        previous = self.host
        self.host = self.make_host()
        self.host.native = previous.native
        return self.host

    def job(self, status='running'):
        queue = Queue(self.directory / 'runtime/environments/test')
        queue.submit('program', 'original-job', directory=self.directory / 'jobs', workspace=self.directory / 'workspace')
        state = queue.state('original-job')
        state['status'] = status
        queue.save(state)
        return queue

    def removed(self, host=None):
        return [command[-1] for command in (host or self.host).commands]

    def test_success_preserves_completed_outcome_and_only_replaces_owned_components(self):
        queue = self.job('done')
        before = (queue.directory('original-job') / 'state.json').read_bytes()
        prepare_upgrade(self.host)
        self.assertEqual(self.removed(), ['engine', 'world', 'worker'])
        self.assertEqual(self.components['unrelated']['status']['container_id'], 'old-unrelated')
        self.assertEqual(self.host.requests, ['status', 'status', 'recover'])
        self.assertEqual(self.host.models_at_start, {'simple': 'saved/model'})
        self.assertEqual(self.host.prepared_links, (['inference=@saved_provider'], '@human_endpoint'))
        self.assertEqual((queue.directory('original-job') / 'state.json').read_bytes(), before)
        self.assertFalse((queue.directory('original-job') / 'cancel.json').exists())
        self.assertEqual(read_json(self.directory / 'upgrade.json')['phase'], 'recovering')
        self.assertTrue(self.host.upgrade_in_progress)
        self.host.record['status'] = 'running'
        self.host.snapshot()
        finish_upgrade(self.host)
        self.assertEqual(read_json(self.directory / 'upgrade.json')['phase'], 'complete')
        self.assertFalse(pending_upgrade(self.directory))
        self.assertTrue(self.host.reattaching)
        self.assertFalse(self.host.upgrade_in_progress)

    def test_running_job_drains_before_worker_removal_and_failure_is_not_retried(self):
        queue = self.job()
        outcome = {'version': 1, 'id': 'original-job', 'type': 'program', 'status': 'failed', 'submitted_at': 'now', 'error': 'domain failure'}
        def finish(_):
            self.assertNotIn('engine', self.components)
            self.assertIn('worker', self.components)
            self.assertIn('world', self.components)
            self.assertEqual(self.removed(), ['engine'])
            queue.save(outcome)
        with patch.object(self.host.interrupted, 'wait', side_effect=finish):
            prepare_upgrade(self.host)
        self.assertEqual(queue.state('original-job')['status'], 'failed')
        self.assertEqual([item['id'] for item in queue.list()], ['original-job'])
        self.assertNotIn('resume', self.host.requests)
        self.assertFalse((queue.directory('original-job') / 'cancel.json').exists())

    def test_interrupt_during_drain_preserves_workers_and_retry_continues(self):
        queue = self.job()
        with patch.object(self.host.interrupted, 'wait', side_effect=lambda _: self.host.interrupted.set()):
            with self.assertRaises(Interrupted):
                prepare_upgrade(self.host)
        self.assertEqual(self.removed(), ['engine'])
        self.assertTrue(self.host.upgrade_in_progress)
        self.assertTrue(self.host.preserve_components)
        self.assertEqual(read_json(self.directory / 'upgrade.json')['phase'], 'draining')
        self.assertEqual(queue.state('original-job')['status'], 'running')
        queue.save({**queue.state('original-job'), 'status': 'done'})
        prepare_upgrade(self.retry())
        self.assertTrue(self.host.reattaching)
        self.assertNotIn('engine', self.removed())

    def test_lost_removal_response_retries_absent_component_without_state_edits(self):
        self.host.fail_remove = True
        with self.assertRaisesRegex(LaunchError, 'lost component'):
            prepare_upgrade(self.host)
        self.assertEqual(read_json(self.directory / 'upgrade.json')['phase'], 'replacing')
        prepare_upgrade(self.retry())
        self.assertEqual(self.removed(), [])
        self.assertEqual(self.host.builds, 1)

    def test_partial_start_reuses_pinned_images_without_rebuilding(self):
        self.host.fail_start = True
        with self.assertRaisesRegex(LaunchError, 'start interrupted'):
            prepare_upgrade(self.host)
        self.assertEqual(read_json(self.directory / 'upgrade.json')['phase'], 'starting')
        host = self.retry()
        with patch.object(host, 'engine_image', side_effect=AssertionError('must keep pinned engine')):
            prepare_upgrade(host)
        self.assertEqual(host.builds, 0)
        self.assertEqual(self.removed(), ['world', 'worker'])
        self.assertEqual(self.components['engine']['image_id'], ENGINE)

    def test_lost_recovery_reply_does_not_stop_active_new_execution(self):
        self.host.fail_recover = True
        with self.assertRaisesRegex(LaunchError, 'lost recovery'):
            prepare_upgrade(self.host)
        self.assertEqual(read_json(self.directory / 'upgrade.json')['phase'], 'recovering')
        queue = self.job()
        prepare_upgrade(self.retry())
        self.assertEqual(self.host.requests, ['status'])
        self.assertEqual(self.removed(), [])
        self.assertEqual(queue.state('original-job')['status'], 'running')
        self.assertFalse((queue.directory('original-job') / 'cancel.json').exists())

    def test_finished_after_lost_recovery_reply_returns_saved_terminal_result(self):
        self.host.fail_recover = True
        with self.assertRaises(LaunchError):
            prepare_upgrade(self.host)
        result = {'runId': 'saved-run', 'status': 'completed', 'output': {'answer': 42}}
        self.host.native = {'runId': 'saved-run', 'status': 'completed', 'active': False, 'result': result}
        prepare_upgrade(self.retry())
        self.assertEqual(self.host.reattach_result, result)
        self.assertEqual(self.removed(), [])

    def test_preflight_and_terminal_refusals_do_not_overwrite_saved_record(self):
        before = (self.directory / 'run.json').read_bytes()
        self.host.operation = 'apply'
        with self.assertRaisesRegex(LaunchError, 'dcomp operation'):
            prepare_upgrade(self.host)
        self.assertEqual(self.removed(), [])
        self.assertEqual((self.directory / 'run.json').read_bytes(), before)
        self.host.operation = None
        self.host.native.update(status='failed', active=False)
        with self.assertRaisesRegex(LaunchError, 'failed workflow'):
            prepare_upgrade(self.host)
        self.assertEqual((self.directory / 'run.json').read_bytes(), before)
        self.assertFalse(self.host.save_record)
        self.assertEqual(self.removed(), [])

    def test_changed_replacement_image_is_preserved_for_inspection(self):
        self.host.fail_recover = True
        with self.assertRaises(LaunchError):
            prepare_upgrade(self.host)
        self.components['worker']['image_id'] = OLD
        with self.assertRaisesRegex(LaunchError, 'unexpected image'):
            prepare_upgrade(self.retry())
        self.assertEqual(self.removed(), [])
        self.assertEqual(self.components['worker']['image_id'], OLD)

    def test_changed_environment_name_is_rejected_before_stopping_engine(self):
        config = read_json(self.directory / 'source/workers.json')
        config['name'] = 'different'
        write_json(self.directory / 'source/workers.json', config)
        with self.assertRaisesRegex(LaunchError, 'original environment name'):
            prepare_upgrade(self.host)
        self.assertEqual(self.removed(), [])
        self.assertFalse(self.host.save_record)

    def test_private_human_component_and_binding_are_retained(self):
        record = read_json(self.directory / 'run.json')
        record['components']['human'] = 'private-human'
        record['links']['human'] = 'private-human.human'
        write_json(self.directory / 'run.json', record)
        self.components['private-human'] = {'name': 'private-human', 'image_id': OLD,
            'status': {'container_id': 'original-human', 'status': 'running', 'health': 'healthy'}}
        prepare_upgrade(self.host)
        self.assertEqual(self.removed(), ['engine', 'world', 'worker'])
        self.assertEqual(self.components['private-human']['status']['container_id'], 'original-human')
        self.assertEqual(self.host.prepared_links[1], 'private-human.human')
        self.assertIn('private-human', self.host.owned)

    def test_environment_rename_during_interrupted_drain_does_not_start_wrong_queue(self):
        queue = self.job()
        with patch.object(self.host.interrupted, 'wait', side_effect=lambda _: self.host.interrupted.set()):
            with self.assertRaises(Interrupted):
                prepare_upgrade(self.host)
        queue.save({**queue.state('original-job'), 'status': 'done'})
        config = read_json(self.directory / 'source/workers.json')
        config['name'] = 'different'
        write_json(self.directory / 'source/workers.json', config)
        with self.assertRaisesRegex(LaunchError, 'original environment name'):
            prepare_upgrade(self.retry())
        self.assertNotIn('engine', self.components)
        self.assertTrue(self.host.upgrade_in_progress)
        self.assertEqual(self.host.builds, 0)

    def test_probe_failure_after_handover_preserves_maintenance_ownership(self):
        write_json(self.directory / 'upgrade.json', {'version': 1, 'id': 'request', 'runId': 'saved-run',
            'phase': 'requested', 'handedOverAt': 'now'})
        with patch.object(self.host, 'reattach_request', side_effect=LaunchError('lost status reply')):
            with self.assertRaisesRegex(LaunchError, 'lost status'):
                prepare_upgrade(self.host)
        self.assertTrue(self.host.upgrade_in_progress)
        self.assertTrue(self.host.preserve_components)
        self.assertTrue(self.host.save_record)
        self.assertTrue(pending_upgrade(self.directory))
        self.assertEqual(self.removed(), [])

    def test_terminal_race_after_handover_returns_result_without_replacement(self):
        write_json(self.directory / 'upgrade.json', {'version': 1, 'id': 'request', 'runId': 'saved-run',
            'phase': 'requested', 'handedOverAt': 'now'})
        result = {'runId': 'saved-run', 'status': 'completed', 'output': {'answer': 42}}
        self.host.native = {'runId': 'saved-run', 'status': 'completed', 'active': False, 'result': result}
        prepare_upgrade(self.host)
        self.assertEqual(self.host.reattach_result, result)
        self.assertTrue(self.host.reattaching)
        self.assertTrue(self.host.upgrade_in_progress)
        self.host.record['status'] = 'running'
        self.host.snapshot()
        finish_upgrade(self.host)
        self.assertFalse(self.host.upgrade_in_progress)
        self.assertFalse(pending_upgrade(self.directory))
        self.assertEqual(self.removed(), [])
        self.assertEqual(self.host.builds, 0)

    def test_monitor_initialization_error_preserves_recovered_jobs_and_retry(self):
        prepare_upgrade(self.host)
        queue = self.job()
        self.host.stop_human = Mock(return_value=True)
        self.host.cleanup_components = Mock(side_effect=AssertionError('must preserve components'))
        with patch('asys.workflow.WorkflowHistory', side_effect=OSError('history unavailable')):
            with self.assertRaisesRegex(OSError, 'history unavailable'):
                Launcher.execute(self.host)
        Launcher.close(self.host)
        self.host.stop_human.assert_called_once_with(preserve=True)
        self.host.cleanup_components.assert_not_called()
        self.assertTrue(pending_upgrade(self.directory))
        self.assertEqual(queue.state('original-job')['status'], 'running')
        self.assertFalse((queue.directory('original-job') / 'cancel.json').exists())
        prepare_upgrade(self.retry())
        self.assertEqual(self.host.requests, ['status'])
        self.assertEqual(self.removed(), [])

    def test_interrupt_before_monitor_commit_preserves_execution(self):
        prepare_upgrade(self.host)
        queue = self.job()
        self.host.interrupted.set()
        self.host.stop_human = Mock(return_value=True)
        self.host.cleanup_components = Mock(side_effect=AssertionError('must preserve components'))
        with patch('asys.workflow.WorkflowHistory'), patch('asys.workflow.Runs'):
            with self.assertRaises(Interrupted):
                Launcher.execute(self.host)
        Launcher.close(self.host)
        self.host.stop_human.assert_called_once_with(preserve=True)
        self.host.cleanup_components.assert_not_called()
        self.assertEqual(read_json(self.directory / 'upgrade.json')['phase'], 'recovering')
        self.assertEqual(queue.state('original-job')['status'], 'running')
        self.assertFalse((queue.directory('original-job') / 'cancel.json').exists())

    def test_event_log_open_error_keeps_upgrade_in_recovering(self):
        prepare_upgrade(self.host)
        queue = self.job()
        original_open = Path.open
        def open_path(path, *args, **kwargs):
            if path == self.directory / 'events.jsonl':
                raise OSError('event journal unavailable')
            return original_open(path, *args, **kwargs)
        self.host.stop_human = Mock(return_value=True)
        self.host.cleanup_components = Mock(side_effect=AssertionError('must preserve components'))
        with patch('asys.workflow.WorkflowHistory'), patch('asys.workflow.Runs'), patch.object(Path, 'open', open_path):
            with self.assertRaisesRegex(OSError, 'event journal unavailable'):
                Launcher.execute(self.host)
        Launcher.close(self.host)
        self.host.cleanup_components.assert_not_called()
        self.assertTrue(self.host.upgrade_in_progress)
        self.assertEqual(read_json(self.directory / 'upgrade.json')['phase'], 'recovering')
        self.assertEqual(queue.state('original-job')['status'], 'running')

    def test_crash_after_terminal_handover_recovers_without_replacement(self):
        write_json(self.directory / 'upgrade.json', {'version': 1, 'id': 'request', 'runId': 'saved-run',
            'phase': 'requested', 'handedOverAt': 'now'})
        result = {'runId': 'saved-run', 'status': 'completed', 'output': {'answer': 42}}
        self.host.native = {'runId': 'saved-run', 'status': 'completed', 'active': False, 'result': result}
        prepare_upgrade(self.host)
        self.assertTrue(pending_upgrade(self.directory))
        prepare_upgrade(self.retry())
        self.assertEqual(self.host.reattach_result, result)
        self.assertEqual(self.host.requests, ['status'])
        self.assertEqual(self.removed(), [])

    def test_only_one_upgrade_and_legacy_launcher_cannot_be_forced(self):
        guard = acquire_lock(self.directory / 'upgrade.lock')
        try:
            with self.assertRaisesRegex(LaunchError, 'already has an upgrade'):
                prepare_upgrade(self.host)
        finally:
            os.close(guard)
        lease = (self.directory / 'launcher.lock').open('a+b')
        try:
            fcntl.flock(lease, fcntl.LOCK_EX)
            with self.assertRaisesRegex(LaunchError, 'does not support'):
                prepare_upgrade(self.host)
        finally:
            lease.close()
        self.assertFalse((self.directory / 'upgrade.json').exists())
        self.assertEqual(self.removed(), [])

    def test_capable_launcher_handover_preserves_execution_and_releases_lease(self):
        owner = self.make_host()
        owner.record = read_json(self.directory / 'run.json')
        owner.record.update(status='running', upgrade_protocol=1)
        owner.save_record = True
        owner.snapshot()
        owner.lease = (self.directory / 'launcher.lock').open('a+b')
        fcntl.flock(owner.lease, fcntl.LOCK_EX)
        errors = []
        def upgrade():
            try:
                prepare_upgrade(self.host)
            except BaseException as error:
                errors.append(error)
        thread = threading.Thread(target=upgrade)
        thread.start()
        deadline = time.monotonic() + 3
        while not (self.directory / 'upgrade.json').exists() and time.monotonic() < deadline:
            time.sleep(.01)
        try:
            with self.assertRaises(UpgradeHandover):
                handover_if_requested(owner)
            self.assertTrue(owner.preserve_components)
            self.assertTrue(owner.upgrade_handover)
            self.assertEqual(owner.commands, [])
        finally:
            owner.lease.close()
            thread.join(4)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertTrue(self.host.reattaching)

    def test_abandoned_request_does_not_detach_current_launcher(self):
        self.host.record = read_json(self.directory / 'run.json')
        self.host.save_record = True
        write_json(self.directory / 'upgrade.json', {'version': 1, 'id': 'request', 'runId': 'saved-run', 'phase': 'requested'})
        handover_if_requested(self.host)
        self.assertFalse(self.host.upgrade_handover)
        self.assertFalse(self.host.preserve_components)
        self.assertFalse(pending_upgrade(self.directory))

    def test_abandoned_request_does_not_block_later_failed_run_resume(self):
        write_json(self.directory / 'upgrade.json', {'version': 1, 'id': 'request', 'runId': 'saved-run', 'phase': 'requested'})
        self.components.clear()  # Original launcher later failed and cleaned up.
        self.host.args.command = 'resume'
        self.host.refresh_environment = Mock()
        self.host.start_components = Mock()
        Launcher.setup_resume(self.host)
        self.host.refresh_environment.assert_called_once_with()
        self.host.start_components.assert_called_once_with()
        self.assertFalse(pending_upgrade(self.directory))

    def test_interrupted_requester_cannot_erase_concurrent_handover_ack(self):
        record = read_json(self.directory / 'run.json')
        record.update(status='running', upgrade_protocol=1)
        write_json(self.directory / 'run.json', record)
        owner_lease = (self.directory / 'launcher.lock').open('a+b')
        fcntl.flock(owner_lease, fcntl.LOCK_EX)
        def acknowledge_then_interrupt():
            journal = read_json(self.directory / 'upgrade.json')
            write_json(self.directory / 'upgrade.json', {**journal, 'handedOverAt': 'acknowledged'})
            record['status'] = 'upgrading'
            write_json(self.directory / 'run.json', record)
            raise Interrupted()
        try:
            with patch.object(self.host, 'check_interrupt', side_effect=acknowledge_then_interrupt):
                with self.assertRaises(Interrupted):
                    prepare_upgrade(self.host)
        finally:
            owner_lease.close()
        self.assertEqual(read_json(self.directory / 'upgrade.json')['handedOverAt'], 'acknowledged')
        self.assertTrue(pending_upgrade(self.directory))
        result = {'runId': 'saved-run', 'status': 'completed', 'output': {'answer': 42}}
        self.host = self.make_host()
        self.host.native = {'runId': 'saved-run', 'status': 'completed', 'active': False, 'result': result}
        prepare_upgrade(self.host)
        self.assertEqual(self.host.reattach_result, result)
        self.assertEqual(self.removed(), [])
        self.assertEqual(self.host.builds, 0)


if __name__ == '__main__':
    unittest.main()
