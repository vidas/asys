import fcntl
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'python'), str(ROOT / 'asys-runtime'), str(ROOT / 'test-support')]
from asys import maintenance
from asys.update import update
from asys_runtime.files import read_json, write_json
from argparse import Namespace
from release_fixture import use_fixture_release

NEW = 'pi-ai@new'


class UpdateTests(unittest.TestCase):
    def test_only_running_inference_and_live_shared_handlers_are_updated(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            use_fixture_release(self, root, 'sha256:fixture')
            (root / 'inference').mkdir()
            (root / 'inference/machine.json').write_text(json.dumps({'config': {
                'running': True, 'system': 'selected', 'dcomp_state_root': '/selected/dcomp',
                'runtime_root': '/selected/runtime'}}))
            leases = []
            for name, private, live in [('shared', False, True), ('private', True, True), ('stale', False, False)]:
                directory = root / 'human' / name
                directory.mkdir(parents=True)
                (directory / 'session.json').write_text(json.dumps({'global': None if private else 'human_endpoint', 'component_removed': False, 'component': name}))
                lease = (directory / 'handler.lock').open('a+b')
                leases.append(lease)
                if live:
                    fcntl.flock(lease, fcntl.LOCK_EX)
            # Runs are deliberately not part of this command's scope.
            (root / 'runs').mkdir()
            (root / 'runs/not-a-service').write_text('untouched')
            try:
                with patch('asys.update.subprocess.run') as run, patch('asys.update.refresh_human') as human, \
                        patch('asys.update.SharedHumanService') as service:
                    update(Namespace(root=root))
                self.assertEqual(service.call_args.args[0].system, 'selected')
                self.assertEqual(service.call_args.args[0].dcomp_state_root, Path('/selected/dcomp'))
                service.return_value.ensure.assert_called_once_with()
                self.assertEqual(run.call_args.args[0][-3:], ['--root', str(root), 'start'])
                self.assertEqual(human.call_count, 1)
                self.assertEqual(human.call_args.args[0], root / 'human/shared')
                self.assertEqual((root / 'runs/not-a-service').read_text(), 'untouched')
            finally:
                for lease in leases:
                    lease.close()

    def test_update_does_not_start_a_stopped_installation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'inference').mkdir()
            (root / 'inference/machine.json').write_text(json.dumps({'config': {'running': False}}))
            with patch('asys.update.subprocess.run') as run:
                update(Namespace(root=root))
            run.assert_not_called()


class CoordinatedUpdateTests(unittest.TestCase):
    """Runs whose workers cannot use new inference drain before services change."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='asys-maintenance-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.installed = {'version': '1', 'build': 'new-build', 'interfaces': {'inference': NEW}, 'images': {}}
        self.labels = {}
        labels = patch.object(maintenance.release, 'image_labels', side_effect=lambda image: self.labels[image])
        labels.start()
        self.addCleanup(labels.stop)
        self.leases = {}
        self.addCleanup(lambda: [lease.close() for lease in self.leases.values()])

    def run_directory(self, run_id, *, inference=None, workflow=True, handover=True, status='running', active=True):
        directory = self.root / 'runs' / run_id
        (directory / 'environment').mkdir(parents=True)
        image = f'sha256:{run_id}'
        (directory / 'environment/component.dcomp').write_text(f'docker {image}\n')
        self.labels[image] = {'io.asys.inference-format': inference} if inference else {}
        record = {'id': run_id, 'name': run_id, 'status': status}
        if workflow:
            record['workflow'] = '/saved/workflow.bpmn'
        if handover:
            record['upgrade_protocol'] = 1
        write_json(directory / 'run.json', record)
        if active:
            self.leases[run_id] = (directory / 'launcher.lock').open('a+b')
            fcntl.flock(self.leases[run_id], fcntl.LOCK_EX)
        return directory

    def finish(self, run_id):
        self.leases.pop(run_id).close()

    def journal(self, run_id, **fields):
        write_json(self.root / 'runs' / run_id / 'upgrade.json', {'version': 1, 'id': 'upgrade', 'runId': run_id,
                                                                  'phase': 'replacing', **fields})

    def test_only_active_runs_speaking_another_format_are_drained(self):
        self.run_directory('current', inference=NEW)
        self.run_directory('workflow', inference='pi-ai@old')
        self.run_directory('worker', workflow=False)
        self.run_directory('stopped', inference='pi-ai@old', active=False)
        self.run_directory('ended', inference='pi-ai@old', status='completed')
        self.run_directory('legacy', inference='pi-ai@old', handover=False)
        with self.assertRaisesRegex(ValueError, r'legacy.*--force'):
            maintenance.plan(self.root, self.installed)
        self.assertIsNone(maintenance.load(self.root))
        planned = maintenance.plan(self.root, self.installed, force=True)
        self.assertEqual(planned['runs'], {'workflow': 'upgrade', 'worker': 'finish'})
        self.assertEqual((planned['phase'], planned['build'], planned['inference']), ('draining', 'new-build', NEW))
        self.assertEqual(maintenance.plan(self.root, self.installed), planned, 'an unfinished update continues')

    def test_update_drains_before_and_releases_after_replacing_services(self):
        use_fixture_release(self, self.root, 'sha256:fixture')
        (self.root / 'inference').mkdir()
        (self.root / 'inference/machine.json').write_text(json.dumps({'config': {
            'running': True, 'system': 'selected', 'dcomp_state_root': '/selected/dcomp'}}))
        order = []
        with patch.object(maintenance, 'plan', return_value={'id': 'planned'}), \
                patch.object(maintenance, 'drain', side_effect=lambda *a: order.append('drain')), \
                patch.object(maintenance, 'release_runs', side_effect=lambda *a: order.append('release')), \
                patch('asys.update.subprocess.run', side_effect=lambda *a, **k: order.append('services')), \
                patch('asys.update.SharedHumanService'):
            update(Namespace(root=self.root, force=False))
        self.assertEqual(order, ['drain', 'services', 'release'])

    def test_drain_upgrades_each_workflow_once_and_waits_for_workers_to_finish(self):
        self.run_directory('workflow', inference='pi-ai@old')
        self.run_directory('worker', workflow=False)
        planned = maintenance.plan(self.root, self.installed)
        spawned = []

        class Upgrade:
            def poll(self):
                return None

        def spawn(run_id):
            spawned.append(run_id)
            return Upgrade()

        def later(_):
            # The background upgrade drains; the single worker ends on its own.
            self.journal('workflow', maintenance=planned['id'], awaitingMaintenance=planned['id'])
            self.finish('worker')
        with patch.object(maintenance.time, 'sleep', side_effect=later), patch('builtins.print'):
            maintenance.drain(self.root, planned, spawn)
        self.assertEqual(spawned, ['workflow'])

    def test_an_upgrade_that_exits_before_draining_stops_the_update(self):
        self.run_directory('workflow', inference='pi-ai@old')
        planned = maintenance.plan(self.root, self.installed)

        class Exited:
            def poll(self):
                return 1
        with patch.object(maintenance.time, 'sleep'), patch('builtins.print'), \
                self.assertRaisesRegex(ValueError, r'upgrade\.log.*repeat asys update'):
            maintenance.drain(self.root, planned, lambda run_id: Exited())

    def test_release_waits_only_for_runs_held_at_the_barrier(self):
        self.run_directory('held', inference='pi-ai@old')
        self.run_directory('ended', inference='pi-ai@old')
        planned = maintenance.plan(self.root, self.installed)
        self.journal('held', maintenance=planned['id'], awaitingMaintenance=planned['id'])
        write_json(self.root / 'runs/ended/run.json', {'id': 'ended', 'status': 'failed', 'workflow': 'x'})

        def recover(_):
            self.assertEqual(maintenance.load(self.root)['phase'], 'ready')
            self.journal('held', maintenance=planned['id'], phase='complete')
        with patch.object(maintenance.time, 'sleep', side_effect=recover) as sleep, patch('builtins.print'):
            maintenance.release_runs(self.root, planned)
        self.assertEqual(sleep.call_count, 1)
        self.assertEqual(maintenance.load(self.root)['phase'], 'complete')


if __name__ == '__main__':
    unittest.main()
