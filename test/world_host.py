"""Shared world provisioning, isolation, readiness, and saved viewer evidence."""
from copy import deepcopy
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'python'), str(ROOT / 'asys-runtime'), str(ROOT / 'asys-workers')]
from asys.execution import EnvironmentHost, prepare_run
from asys.lifecycle import Interrupted, LaunchError
from asys.run import arguments as run_arguments
from asys.worker_definitions import definition_command
from asys.world_host import prepare_worlds, snapshot_view, start_worlds
from asys.world_packages import resolve_package
from asys_runtime.files import write_json
sys.path.insert(0, str(ROOT / 'test-support'))
from release_fixture import use_fixture_release


def swarm(reference):
    return {'version': 1, 'kind': 'swarm', 'config': {'version': 1, 'name': 'search',
        'agents': {'count': 2, 'type': 'member'}, 'limits': {'turns': 2, 'decisions': 4},
        'world': {'package': reference, 'settings': {}}}}


class Host(EnvironmentHost):
    def __init__(self, root, environment):
        super().__init__(SimpleNamespace(system='isolated', root=root))
        workspace = root / 'workspace'
        workspace.mkdir()
        self.id, self.directory, workspace = prepare_run(root / 'runs', workspace)
        self.names = {'workers': f'workers-{self.id}'}
        self.record = {'workspace': str(workspace), 'components': self.names, 'links': {}}
        self.calls, self.running = [], {}
        self.ready = {'protocolVersion': 1, 'identity': 'fixture-world'}
        self.worker_definition = None
        self.package_component = {'image_ref': 'fixture:world', 'inputs': [],
                                  'outputs': [{'name': 'status', 'service': 'example.Status'}]}
        self.fail_add = False

    def say(self, value):
        pass

    def worker_models(self):
        return {}

    def command(self, command, **kwargs):
        self.calls.append(command)
        if command[:3] == ['docker', 'image', 'inspect']:
            return 'sha256:fixture-world'
        if command[:2] == ['docker', 'build']:
            Path(command[command.index('--iidfile') + 1]).write_text('sha256:built-world')
            return ''
        operation = command[len(self.dcomp)]
        if operation == 'add-component':
            if self.fail_add:
                raise LaunchError('fixture add failed')
            name = command[-2]
            self.running[name] = {'name': name, 'status': {'status': 'running', 'health': 'healthy'}}
            for index, item in enumerate(command):
                if item == '--bind' and command[index + 1].endswith(',/var/lib/asys-world,rw'):
                    runtime = Path(command[index + 1].split(',')[0])
                    self.assert_marker_was_removed = not (runtime / 'ready.json').exists()
                    if self.ready is not None:
                        write_json(runtime / 'ready.json', self.ready)
            return ''
        if operation == 'rm-component':
            self.running.pop(command[-1], None)
            return ''
        if operation == 'logs':
            return 'component evidence\n'
        raise AssertionError(command)

    def document(self, *command, **kwargs):
        if command[-1] == self.args.system:
            return {'api_version': 2, 'components': list(self.running.values())}
        return {'api_version': 2, 'components': [deepcopy(self.package_component)]}


class WorldHostTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        use_fixture_release(self, self.root, 'sha256:fixture-world')
        self.environment = self.root / 'env'
        (self.environment / 'workers').mkdir(parents=True)
        self.package('worlds/search')
        self.config = {'version': 1, 'name': 'environment', 'types': {
            'first': {'command': definition_command('first')},
            'second': {'command': definition_command('second')},
            'member': {'command': ['true']}}}
        for name in ('first', 'second'):
            write_json(self.environment / f'workers/{name}.json', swarm('worlds/search'))
        self.host = Host(self.root, self.environment)
        self.addCleanup(self.host.cleanup_components)

    def package(self, reference):
        root = self.environment / reference
        (root / 'component').mkdir(parents=True)
        write_json(root / 'world.json', {'version': 1, 'component': 'component/component.dcomp', 'view': 'view.mjs'})
        (root / 'component/component.dcomp').write_text('docker fixture:world\noutput example.Status status\n')
        (root / 'view.mjs').write_text('export function mount() {}')
        (root / 'style.css').write_text('body {}')
        (root / 'component/serve.py').write_text('private executable')
        (root / 'component/serve.mjs').write_text('private JavaScript executable')
        (root / 'component/settings.json').write_text('{"private":true}')
        return root

    def prepare(self):
        prepare_worlds(self.host, self.environment, self.config)

    def test_shared_package_has_one_component_and_one_saved_view_generation(self):
        self.prepare()
        bindings = json.loads((self.host.directory / 'world-bindings.json').read_text())
        self.assertEqual(set(bindings['packages']), {'worlds/search'})
        self.assertEqual(len(self.host.record['world_components']), 1)
        generation = bindings['packages']['worlds/search']['view']
        self.assertEqual(len(self.host.record['world_view_versions']), 1)
        for name in ('first', 'second'):
            view = self.host.record['world_views'][name]
            self.assertEqual(view, {'directory': f'world-view-versions/{generation}', 'entry': 'view.mjs'})
            self.assertEqual(sorted(p.name for p in (self.host.directory / view['directory']).iterdir()),
                             ['style.css', 'view.mjs'])
        component = next(iter(self.host.record['world_components'].values()))
        manifest = (self.host.directory / component['directory'] / 'component.dcomp').read_text()
        self.assertIn('docker sha256:fixture-world', manifest)
        self.assertIn('output example.Status status', manifest)

    def test_unified_workflow_arguments_prepare_every_referenced_world(self):
        self.package('worlds/local')
        write_json(self.environment / 'workers/second.json', swarm('worlds/local'))
        for workflow in ('workflow.bpmn', str(self.root / 'project with spaces/workflow.bpmn')):
            with self.subTest(workflow=workflow):
                self.host.args = run_arguments([str(self.environment), workflow, '--system', 'isolated'])
                self.prepare()
                self.assertEqual(set(self.host.record['world_components']), {'worlds/search', 'worlds/local'})
                self.assertEqual(set(self.host.record['world_views']), {'first', 'second'})

    def test_worlds_start_first_and_get_only_their_runtime_subtree(self):
        self.prepare()
        self.host.start_workers()
        calls = [call for call in self.host.calls if call[len(self.host.dcomp):][:1] == ['add-component']]
        self.assertEqual(len(calls), 2)
        world, worker = calls
        self.assertIn('/var/lib/asys-world,rw', ' '.join(world))
        self.assertNotIn('/var/lib/asys/jobs', ' '.join(world))
        self.assertNotIn('/var/lib/asys/workspace', ' '.join(world))
        self.assertNotIn('--arg', ' '.join(world))
        self.assertNotIn('--egress', world)
        self.assertNotIn('--link', world)
        self.assertIn(f'{self.host.directory}/world-bindings.json,/etc/asys/world-bindings.json,ro', worker)
        self.assertEqual(world[-2], self.host.owned[0])
        self.assertEqual(worker[-2], self.host.owned[1])
        self.assertTrue(self.host.cleanup_components())
        removed = [call[-1] for call in self.host.calls if call[len(self.host.dcomp):][:1] == ['rm-component']]
        self.assertEqual(removed, [worker[-2], world[-2]])

    def test_package_deployment_forwards_dcomp_egress_and_declared_links(self):
        path = self.environment / 'worlds/search/world.json'
        manifest = json.loads(path.read_text())
        manifest['deployment'] = {'egress': True, 'links': {'data': 'storage.files', 'inference': '@inference_endpoint'}}
        write_json(path, manifest)
        self.host.package_component['inputs'] = [{'name': 'data', 'service': 'example.Files'},
                                                 {'name': 'inference', 'service': 'cyclo.provider.v1.Provider'}]
        self.host.record['links'] = {'inference': 'other.provider'}
        self.prepare()
        self.host.start_workers()
        world, worker = [call for call in self.host.calls if call[len(self.host.dcomp):][:1] == ['add-component']]
        self.assertIn('--egress', world)
        self.assertIn('data=storage.files', world)
        self.assertIn('inference=@inference_endpoint', world)
        self.assertNotIn('inference=other.provider', world)
        self.assertIn('inference=other.provider', worker)
        self.assertNotIn('--egress', worker)

    def test_package_links_must_name_declared_inputs_before_building(self):
        path = self.environment / 'worlds/search/world.json'
        manifest = json.loads(path.read_text())
        manifest['deployment'] = {'links': {'missing': '@service'}}
        write_json(path, manifest)
        with self.assertRaisesRegex(LaunchError, 'undeclared input'):
            self.prepare()
        self.assertEqual(self.host.calls, [])

    def test_unlinked_component_inputs_remain_valid(self):
        self.host.package_component['inputs'] = [{'name': 'optional', 'service': 'example.Optional'}]
        self.prepare()
        start_worlds(self.host)
        self.assertNotIn('--link', self.host.calls[-1])

    def test_selected_snapshot_requires_world_even_with_overridden_dispatch_command(self):
        self.config['types']['selected'] = {'command': ['snapshot-dispatcher']}
        self.host.args.worker = 'selected'
        self.host.worker_definition = swarm('worlds/search')
        self.prepare()
        self.assertEqual(set(self.host.record['world_views']), {'selected'})

    def test_selected_program_or_agent_ignores_unrelated_world_definitions(self):
        (self.environment / 'workers/first.json').write_text('not readable configuration')
        for definition in (None, {'version': 1, 'kind': 'agent', 'config': {'agent': 'member'}}):
            with self.subTest(definition=definition):
                self.host.args.worker = 'member'
                self.host.worker_definition = definition
                with patch('asys.world_packages.resolve_package') as resolve:
                    self.prepare()
                    resolve.assert_not_called()
                self.assertEqual(self.host.record['world_components'], {})
                self.assertEqual(self.host.record['world_views'], {})
                self.assertEqual(self.host.calls, [])

    def test_build_uses_world_context_and_separate_image_receipt(self):
        (self.environment / 'worlds/search/component/Dockerfile').write_text('FROM fixture\n')
        self.prepare()
        builds = [call for call in self.host.calls if call[:2] == ['docker', 'build']]
        self.assertEqual(len(builds), 1)
        self.assertEqual(builds[0][-1], str(self.environment / 'worlds/search/component'))
        self.assertIn('/world-components/', builds[0][builds[0].index('--iidfile') + 1])
        self.assertFalse((self.host.directory / 'environment-image').exists())

    def test_resume_reuses_binding_and_data_and_requires_new_readiness(self):
        self.prepare()
        before = json.loads((self.host.directory / 'world-bindings.json').read_text())['packages']['worlds/search']
        original = self.host.record['world_view_versions'][before['view']]
        value = self.host.record['world_components']['worlds/search']
        runtime = self.host.directory / 'runtime' / value['runtime']
        (runtime / 'session-evidence.json').write_text('saved session')
        write_json(runtime / 'ready.json', {'protocolVersion': 999})
        (self.environment / 'worlds/search/view.mjs').write_text('changed after launch')
        self.prepare()
        after = json.loads((self.host.directory / 'world-bindings.json').read_text())['packages']['worlds/search']
        self.assertEqual(after['runtime'], before['runtime'])
        self.assertNotEqual(after['view'], before['view'])
        current = self.host.record['world_view_versions'][after['view']]
        self.assertEqual((runtime / 'session-evidence.json').read_text(), 'saved session')
        self.assertEqual((self.host.directory / original['directory'] / original['entry']).read_text(),
                         'export function mount() {}')
        self.assertEqual((self.host.directory / current['directory'] / current['entry']).read_text(),
                         'changed after launch')
        self.host.start_workers()
        self.assertTrue(self.host.assert_marker_was_removed)

    def test_changed_package_and_entry_keep_history_and_bind_new_jobs_to_new_view(self):
        from asys_worker import prepare as prepare_worker
        self.prepare()
        bindings_path = self.host.directory / 'world-bindings.json'
        original = json.loads(bindings_path.read_text())['packages']['worlds/search']['view']
        job = self.host.directory / 'jobs/old-job'
        environment = {'ASYS_ENVIRONMENT_DIR': str(self.environment), 'ASYS_JOB_DIR': str(job),
                       'ASYS_JOB_ID': 'old-job', 'ASYS_WORLD_BINDINGS': str(bindings_path)}
        prepare_worker(swarm('worlds/search'), {'request': 'Explore'}, environment)
        self.assertEqual(json.loads((job / 'worker.json').read_text())['world_view'], original)

        replacement = self.package('worlds/replacement')
        (replacement / 'view.mjs').rename(replacement / 'replacement.mjs')
        (replacement / 'replacement.mjs').write_text('export function mount() { return "new world"; }')
        write_json(replacement / 'world.json', {'version': 1, 'component': 'component/component.dcomp',
                                               'view': 'replacement.mjs'})
        write_json(self.environment / 'workers/first.json', swarm('worlds/replacement'))
        self.prepare()
        replacement_id = json.loads(bindings_path.read_text())['packages']['worlds/replacement']['view']
        current = self.host.record['world_view_versions'][replacement_id]
        self.assertNotEqual(original, replacement_id)
        self.assertEqual(current['entry'], 'replacement.mjs')
        self.assertEqual((self.host.directory / current['directory'] / current['entry']).read_text(),
                         'export function mount() { return "new world"; }')
        new_job = self.host.directory / 'jobs/new-job'
        prepare_worker(swarm('worlds/replacement'), {'request': 'Explore'},
                       {**environment, 'ASYS_JOB_DIR': str(new_job), 'ASYS_JOB_ID': 'new-job'})
        self.assertEqual(json.loads((new_job / 'worker.json').read_text())['world_view'], replacement_id)
        self.assertEqual(json.loads((job / 'worker.json').read_text())['world_view'], original)
        self.assertEqual(self.host.record['world_views']['first'],
                         self.host.record['world_view_versions'][original])

    def test_same_package_entry_and_sibling_asset_changes_create_distinct_generations(self):
        self.prepare()
        bindings = self.host.directory / 'world-bindings.json'
        original = json.loads(bindings.read_text())['packages']['worlds/search']['view']
        package = self.environment / 'worlds/search'
        (package / 'style.css').write_text('body { color: purple; }')
        self.prepare()
        styled = json.loads(bindings.read_text())['packages']['worlds/search']['view']
        self.assertNotEqual(original, styled)
        (package / 'view.mjs').rename(package / 'renamed.mjs')
        write_json(package / 'world.json', {'version': 1, 'component': 'component/component.dcomp',
                                           'view': 'renamed.mjs'})
        self.prepare()
        renamed = json.loads(bindings.read_text())['packages']['worlds/search']['view']
        self.assertNotIn(renamed, (original, styled))
        self.assertEqual(self.host.record['world_view_versions'][renamed]['entry'], 'renamed.mjs')
        self.prepare()
        self.assertEqual(json.loads(bindings.read_text())['packages']['worlds/search']['view'], renamed)
        self.assertEqual(len(self.host.record['world_view_versions']), 3)

    def test_modified_saved_binding_is_rejected_before_deployment(self):
        self.prepare()
        write_json(self.host.directory / 'world-bindings.json', {'version': 1,
            'packages': {'worlds/search': {'runtime': '../jobs'}}})
        self.host.calls.clear()
        with self.assertRaisesRegex(LaunchError, 'Saved world binding changed'):
            self.prepare()
        self.assertEqual(self.host.calls, [])

    def test_runtime_symlink_cannot_redirect_world_mount_to_private_jobs(self):
        (self.host.directory / 'runtime/worlds').symlink_to(self.host.directory / 'jobs')
        with self.assertRaisesRegex(LaunchError, 'symlinks'):
            self.prepare()
        self.assertEqual(self.host.calls, [])
        self.assertEqual(list((self.host.directory / 'jobs').iterdir()), [])

    def test_invalid_readiness_never_starts_workers_and_world_remains_owned(self):
        self.prepare()
        self.host.ready = {'protocolVersion': 2, 'identity': 'future'}
        with self.assertRaisesRegex(LaunchError, 'protocolVersion 1'):
            self.host.start_workers()
        self.assertEqual(len(self.host.owned), 1)
        self.assertNotEqual(self.host.owned[0], self.host.names['workers'])

    def test_missing_readiness_times_out_and_interrupt_is_respected(self):
        self.prepare()
        self.host.ready = None
        with patch('asys.world_host.READY_SECONDS', .02), self.assertRaisesRegex(LaunchError, 'Timed out'):
            start_worlds(self.host)
        self.assertTrue(self.host.cleanup_components())
        self.host.interrupted.set()
        with self.assertRaises(Interrupted):
            start_worlds(self.host)

    def test_renderer_paths_and_size_are_checked(self):
        package = resolve_package(self.environment, 'worlds/search')
        (package['root'] / 'escape.js').symlink_to(self.root / 'private.js')
        with self.assertRaisesRegex(LaunchError, 'symlinks'):
            snapshot_view(package, self.host.directory / 'view')
        (package['root'] / 'escape.js').unlink()
        with patch('asys.world_host.VIEW_BYTES', 1), self.assertRaisesRegex(LaunchError, '32 MiB'):
            snapshot_view(package, self.host.directory / 'view')
        self.assertFalse((self.host.directory / 'view').exists())

    def test_view_snapshot_preserves_explicit_shared_state_permissions(self):
        self.host.directory.chmod(0o2770)
        package = resolve_package(self.environment, 'worlds/search')
        destination = self.host.directory / 'world-views/search'
        snapshot_view(package, destination)
        self.assertEqual(destination.stat().st_mode & 0o7777, 0o2770)
        self.assertEqual((destination / 'view.mjs').stat().st_mode & 0o777, 0o660)

    def test_root_component_requires_separate_viewer_directory(self):
        package = resolve_package(self.environment, 'worlds/search')
        package['component'] = package['root'] / 'component.dcomp'
        package['component'].write_text('docker fixture:world\n')
        with self.assertRaisesRegex(LaunchError, 'separate viewer directory'):
            snapshot_view(package, self.host.directory / 'view')
        viewer = package['root'] / 'viewer'
        viewer.mkdir()
        (viewer / 'view.mjs').write_text('browser module')
        (viewer / 'data.json').write_text('{"public":true}')
        (package['root'] / 'server.mjs').write_text('private server')
        (package['root'] / 'settings.json').write_text('{"private":true}')
        package['view'] = viewer / 'view.mjs'
        destination = self.host.directory / 'view'
        self.assertEqual(snapshot_view(package, destination), 'viewer/view.mjs')
        self.assertEqual(sorted(path.relative_to(destination).as_posix()
                                for path in destination.rglob('*') if path.is_file()),
                         ['viewer/data.json', 'viewer/view.mjs'])


if __name__ == '__main__':
    unittest.main()
