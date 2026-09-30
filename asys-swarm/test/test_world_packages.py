"""World packages are data references; deployment never imports their code."""
import json
from pathlib import Path
import tempfile
import unittest

from asys.world_packages import package_reference, resolve_package
from asys.worker_definitions import validate_definition


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.package = self.root / 'worlds/test'
        self.package.mkdir(parents=True)
        (self.package / 'component').mkdir()
        (self.package / 'world.json').write_text(json.dumps({
            'version': 1, 'component': 'component/component.dcomp', 'view': 'view.mjs'}))
        (self.package / 'component/component.dcomp').write_text('docker test-world\n')
        (self.package / 'view.mjs').write_text('export function mount() {}\n')

    def test_package_resolves_component_and_esm_view_without_imports(self):
        (self.package / 'world.py').write_text('raise RuntimeError("must never import")')
        value = resolve_package(self.root, 'worlds/test')
        self.assertEqual(value['root'], self.package)
        self.assertEqual(value['component'], self.package / 'component/component.dcomp')
        self.assertEqual(value['view'], self.package / 'view.mjs')

    def test_paths_and_manifest_cannot_escape_or_choose_an_execution_mode(self):
        for reference in ('../outside', '/tmp/world', 'worlds/./test', 'worlds//test', '', 'builtin:missing'):
            with self.subTest(reference=reference), self.assertRaises(ValueError):
                package_reference(reference)
        path = self.package / 'world.json'
        for extra in ({'command': ['python3', 'world.py']}, {'view': '../view.mjs'},
                      {'component': '/tmp/component.dcomp'}, {'version': True},
                      {'component': None}, {'view': []}):
            path.write_text(json.dumps({'version': 1, 'component': 'component/component.dcomp', 'view': 'view.mjs', **extra}))
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                resolve_package(self.root, 'worlds/test')

    def test_build_and_viewer_assets_reject_symlinks(self):
        (self.package / 'secret.txt').symlink_to('/etc/passwd')
        with self.assertRaisesRegex(ValueError, 'regular files'):
            resolve_package(self.root, 'worlds/test')

    def test_named_world_requires_package_and_runtime_assigned_session(self):
        for world in ({'command': ['python3', 'world.py']}, {'module': 'world.py'},
                      {'package': 'worlds/test', 'channel': 'shared'},
                      {'package': 'worlds/test', 'view': 'view.mjs'}):
            with self.subTest(world=world), self.assertRaises(ValueError):
                validate_definition({'version': 1, 'kind': 'swarm', 'config': {'version': 1, 'world': world}})
        result = validate_definition({'version': 1, 'kind': 'swarm',
                                      'config': {'version': 1, 'world': {'package': 'worlds/test'}}})
        self.assertEqual(result['config']['world']['package'], 'worlds/test')
        self.assertNotIn('channel', result['config']['world'])

    def test_viewer_and_component_implementation_require_separate_directories(self):
        (self.package / 'component/view.mjs').write_text('export function mount() {}')
        manifest = self.package / 'world.json'
        manifest.write_text(json.dumps({'version': 1, 'component': 'component/component.dcomp',
                                       'view': 'component/view.mjs'}))
        with self.assertRaisesRegex(ValueError, 'outside the component'):
            resolve_package(self.root, 'worlds/test')
        (self.package / 'component.dcomp').write_text('docker test-world\n')
        manifest.write_text(json.dumps({'version': 1, 'component': 'component.dcomp', 'view': 'view.mjs'}))
        with self.assertRaisesRegex(ValueError, 'dedicated viewer'):
            resolve_package(self.root, 'worlds/test')

    def test_builtin_components_and_viewers_are_packaged_together(self):
        for name in ('leaderboard', 'torus'):
            with self.subTest(name=name):
                result = resolve_package(self.root, f'builtin:{name}')
                self.assertEqual(result['component'].parent.name, 'component')
                self.assertTrue((result['component'].parent / 'Dockerfile').is_file())
                self.assertTrue(result['view'].is_file())

    def test_deployment_rejects_unsupported_options_and_malformed_targets(self):
        path = self.package / 'world.json'
        original = json.loads(path.read_text())
        for deployment in ({'egress': 'true'}, {'bind': ['/tmp']}, {'links': []},
                           {'links': {'data': '../storage'}}, {'links': {'data': 'storage'}},
                           {'links': {'data': '@'}}, {'links': {'Data': 'storage.files'}},
                           {'links': {'data': 'storage.files.extra'}}, {'links': {'data': '@global\n'}}):
            path.write_text(json.dumps({**original, 'deployment': deployment}))
            with self.subTest(deployment=deployment), self.assertRaises(ValueError):
                resolve_package(self.root, 'worlds/test')
        path.write_text(json.dumps({**original, 'deployment': {'egress': True, 'links': {'data': '@files'}}}))
        self.assertTrue(resolve_package(self.root, 'worlds/test')['manifest']['deployment']['egress'])

    def test_duplicate_input_links_are_not_silently_overwritten(self):
        (self.package / 'world.json').write_text('{"version":1,"component":"component/component.dcomp",'
            '"view":"view.mjs","deployment":{"links":{"data":"@first","data":"@second"}}}')
        with self.assertRaisesRegex(ValueError, 'Duplicate world manifest field: data'):
            resolve_package(self.root, 'worlds/test')


if __name__ == '__main__':
    unittest.main()
