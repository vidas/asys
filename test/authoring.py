"""Authoring boundaries and real CLI round trips; no runtime or Docker needed."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'python'), str(ROOT / 'asys-runtime'), str(ROOT / 'asys-workers')]
from asys.worker_definitions import (BUILTINS, bind_definition, builtin_definition,
    definition_command, ensure_environment, list_definitions, load_definition, validate_definition)
from asys import workers as authoring


class AuthoringTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='asys-authoring-test-')
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.environment = self.directory / 'design environment'
        self.env = dict(os.environ)
        self.env.pop('VISUAL', None)
        self.editor = self.directory / 'test editor.py'
        self.editor.write_text('import os, pathlib, sys\n'
            'pathlib.Path(sys.argv[1]).write_text(os.environ["EDIT_TEXT"])\n'
            'sys.exit(int(os.environ.get("EDITOR_EXIT", "0")))\n')
        self.env['EDITOR'] = f'{shlex.quote(sys.executable)} {shlex.quote(str(self.editor))}'

    def invoke(self, utility, *args, success=True):
        arguments = [args[0], str(self.environment), *args[1:]]
        result = subprocess.run([sys.executable, str(ROOT / f'tools/asys-{utility}'),
            *map(str, arguments)], env=self.env, text=True,
            capture_output=True, timeout=15)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
        return result

    def config(self):
        return json.loads((self.environment / 'workers.json').read_text())

    def skill(self, name='schematic', metadata=None):
        source = self.directory / name
        source.mkdir()
        (source / 'SKILL.md').write_text(metadata or f'---\nname: {name}\n'
            'description: Check schematic connectivity.\n---\nRead resources/rules.txt.\n')
        return source

    def test_add_all_kinds_scaffolds_one_environment_and_preserves_programs(self):
        self.invoke('workers', 'add', 'agent', 'designer')
        config = self.config()
        config['types']['check'] = {'command': ['./programs/check', '--strict'],
                                    'timeout': 45, 'env': {'CHECK': '1'}}
        config['egress'] = True
        (self.environment / 'workers.json').write_text(json.dumps(config))
        self.invoke('workers', 'add', 'goal', 'build')
        self.invoke('workers', 'add', 'senate', 'review')
        self.invoke('workers', 'add', 'swarm', 'search')
        final = self.config()
        self.assertEqual(final['types']['check'], config['types']['check'])
        self.assertTrue(final['egress'])
        self.assertEqual(sorted(list_definitions(self.environment)), ['build', 'designer', 'review', 'search'])
        for name in ('designer', 'build', 'review', 'search'):
            self.assertEqual(final['types'][name]['command'], definition_command(name))
            self.assertNotIn(str(self.environment), ' '.join(final['types'][name]['command']))
        self.assertEqual((self.environment / 'agents/designer/prompt.md').read_text(), '')
        self.assertEqual(len(list(self.environment.rglob('Dockerfile'))), 2)
        self.assertNotIn('mission', load_definition(self.environment, 'search')['config'])
        self.assertIn('search-step', final['types'])
        self.assertEqual(final['types']['search-step']['command'],
            ['/opt/asys/asys-workers/tools/asys-swarm-agent', '--agent', 'search-member'])
        self.assertTrue((self.environment / 'agents/search-member/prompt.md').is_file())
        self.assertTrue((self.environment / 'worlds/search/view.mjs').is_file())
        completed = subprocess.run([sys.executable, str(self.environment / 'worlds/search/component/evaluate.py')],
            input='{"candidate":{},"problem":{}}', capture_output=True, text=True, check=True)
        self.assertFalse(json.loads(completed.stdout)['accepted'])

    def test_builtins_are_reported_without_creating_definition_files(self):
        ensure_environment(self.environment)
        before = {str(path.relative_to(self.environment)): path.read_bytes()
                  for path in self.environment.rglob('*') if path.is_file()}
        rows = json.loads(self.invoke('workers', 'list', '--json').stdout)
        records = {entry['name']: entry for entry in rows}
        for name in BUILTINS:
            self.assertTrue(records[name]['builtin'])
            self.assertEqual(records[name]['definition'], builtin_definition(name))
        self.assertEqual(before, {str(path.relative_to(self.environment)): path.read_bytes()
                         for path in self.environment.rglob('*') if path.is_file()})
        self.assertEqual(json.loads(self.invoke('workers', 'describe', 'simple').stdout)['kind'], 'agent')

    def test_new_swarm_requires_evaluator_setup_before_member_inference(self):
        from worlds.common import ArtifactWorld, Evaluator
        self.invoke('workers', 'add', 'swarm', 'search')
        definition = load_definition(self.environment, 'search')
        evaluator = Evaluator([sys.executable, str(self.environment / 'worlds/search/component/evaluate.py')])
        world = ArtifactWorld('leaderboard', evaluator)
        with self.assertRaisesRegex(ValueError, 'Configure this evaluator'):
            world.initialize(definition['config']['world']['settings'], ['a-1', 'a-2'], 0)

    def test_user_definition_and_arbitrary_type_own_builtin_names(self):
        self.invoke('workers', 'add', 'agent', 'simple')
        config = self.config()
        config['types']['goal'] = {'command': ['./programs/my-goal']}
        (self.environment / 'workers.json').write_text(json.dumps(config))
        records = {entry['name']: entry for entry in json.loads(self.invoke('workers', 'list', '--json').stdout)}
        self.assertNotIn('builtin', records['simple'])
        self.assertFalse(records['simple']['definition']['config'].get('system', False))
        self.assertEqual(records['goal']['kind'], 'program')
        self.assertNotIn('builtin', records['goal'])

    def test_collision_never_overwrites_definition_prompt_or_program_type(self):
        self.invoke('workers', 'add', 'agent', 'review')
        prompt = self.environment / 'agents/review/prompt.md'
        prompt.write_text('Keep these instructions.\n')
        definition = self.environment / 'workers/review.json'
        before = definition.read_bytes(), (self.environment / 'workers.json').read_bytes()
        self.invoke('workers', 'add', 'goal', 'review', success=False)
        self.invoke('workers', 'add', 'agent', 'program', success=False)
        self.assertEqual(before, (definition.read_bytes(), (self.environment / 'workers.json').read_bytes()))
        self.assertEqual(prompt.read_text(), 'Keep these instructions.\n')

    def test_import_validates_kind_and_creates_selected_agent_assets(self):
        source = self.directory / 'definition.json'
        value = {'version': 1, 'kind': 'agent', 'description': 'Inspect the design.',
                 'config': {'agent': 'inspector', 'model': 'pool/model', 'maxSteps': 9, 'reasoning': 'high'}}
        source.write_text(json.dumps(value))
        self.invoke('workers', 'add', 'agent', 'inspect', '--file', source)
        self.assertEqual(load_definition(self.environment, 'inspect'), value)
        self.assertTrue((self.environment / 'agents/inspector/prompt.md').is_file())
        before = (self.environment / 'workers.json').read_bytes()
        self.invoke('workers', 'add', 'goal', 'wrong', '--file', source, success=False)
        value['config']['command'] = ['unexpected']
        source.write_text(json.dumps(value))
        self.invoke('workers', 'add', 'agent', 'wrong', '--file', source, success=False)
        self.assertEqual((self.environment / 'workers.json').read_bytes(), before)
        self.assertFalse((self.environment / 'workers/wrong.json').exists())

    def test_definition_validation_rejects_unsafe_or_unusable_configurations(self):
        invalid = [
            {'version': True, 'kind': 'goal', 'config': {}},
            {'version': 1, 'kind': 'agent', 'config': {'agent': '../outside'}},
            {'version': 1, 'kind': 'agent', 'config': {'agent': 'other', 'system': True}},
            {'version': 1, 'kind': 'agent', 'config': {'agent': 'other', 'reasoning': 'extreme'}},
            {'version': 1, 'kind': 'agent', 'config': {'agent': 'other', 'reasoning': None}},
            {'version': 1, 'kind': 'goal', 'config': {'reasoning': 'high'}},
            {'version': 1, 'kind': 'goal', 'config': {'maxAttempts': True}},
            {'version': 1, 'kind': 'goal', 'config': {'model': ' '}},
            {'version': 1, 'kind': 'swarm', 'config': {'version': 1, 'world': {'channel': 'world'}}},
            {'version': 1, 'kind': 'swarm', 'config': {'version': 1, 'world': {'command': ['../outside']}}},
            {'version': 1, 'kind': 'swarm', 'config': {'version': 1,
                'world': {'command': ['world'], 'view': '../outside.mjs'}}},
            {'version': 1, 'kind': 'senate', 'config': {'version': 1,
                'princeps': {'name': 'Chair'}, 'senators': [{'name': ' Chair '}]}},
        ]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_definition(value)

    def test_bind_compiles_a_copy_and_preserves_custom_type_settings(self):
        self.invoke('workers', 'add', 'goal', 'build')
        config = self.config()
        config['types']['build']['timeout'] = 600
        (self.environment / 'workers.json').write_text(json.dumps(config))
        before = (self.environment / 'workers.json').read_bytes()
        compiled = bind_definition(self.environment, 'build', write=False)
        self.assertEqual(compiled['types']['build']['timeout'], 600)
        self.assertEqual((self.environment / 'workers.json').read_bytes(), before)
        with self.assertRaisesRegex(ValueError, 'different command'):
            bind_definition(self.environment, 'program', builtin_definition('goal'), write=False)

    def test_edit_uses_visual_and_preserves_original_on_invalid_input_or_editor_failure(self):
        self.invoke('workers', 'add', 'goal', 'build')
        path = self.environment / 'workers/build.json'
        before = path.read_bytes()
        self.env['VISUAL'] = self.env['EDITOR']
        self.env['EDITOR'] = 'this-editor-must-not-run'
        for text, code in [('{broken', '0'), ('{"version":1,"kind":"goal","config":{"bad":1}}', '0'),
                           ('{}', '3')]:
            self.env.update(EDIT_TEXT=text, EDITOR_EXIT=code)
            self.invoke('workers', 'edit', 'build', success=False)
            self.assertEqual(path.read_bytes(), before)
        self.env.update(EDIT_TEXT=json.dumps({'version': 1, 'kind': 'goal', 'config': {'maxAttempts': 7}}), EDITOR_EXIT='0')
        self.invoke('workers', 'edit', 'build')
        self.assertEqual(load_definition(self.environment, 'build')['config']['maxAttempts'], 7)
        self.assertEqual(self.config()['types']['build']['command'], definition_command('build'))
        self.assertFalse(list(path.parent.glob('.*.edit-*')))

    def test_edit_ordinary_program_changes_only_its_specification(self):
        ensure_environment(self.environment)
        self.env['EDIT_TEXT'] = json.dumps({'command': ['./programs/task'], 'timeout': 20})
        self.invoke('workers', 'edit', 'program')
        self.assertEqual(self.config()['types']['program'], json.loads(self.env['EDIT_TEXT']))
        self.assertFalse((self.environment / 'workers/program.json').exists())
        self.env['EDIT_TEXT'] = '{"command": "shell string"}'
        self.invoke('workers', 'edit', 'program', success=False)
        self.assertEqual(self.config()['types']['program']['timeout'], 20)

    def test_definition_paths_reject_traversal_and_symlinked_storage(self):
        self.invoke('workers', 'add', 'goal', '../escape', success=False)
        self.assertFalse(self.environment.exists())
        ensure_environment(self.environment)
        outside = self.directory / 'outside'
        outside.mkdir()
        (self.environment / 'workers').symlink_to(outside, target_is_directory=True)
        self.invoke('workers', 'add', 'goal', 'escape', success=False)
        self.assertFalse(list(outside.iterdir()))

    def test_edit_cannot_commit_an_agent_definition_with_escaping_assets(self):
        self.invoke('workers', 'add', 'agent', 'review')
        outside = self.directory / 'outside'
        outside.mkdir()
        (self.environment / 'agents/escape').symlink_to(outside, target_is_directory=True)
        destination = self.environment / 'workers/review.json'
        before = destination.read_bytes()
        self.env['EDIT_TEXT'] = json.dumps({'version': 1, 'kind': 'agent', 'config': {'agent': 'escape'}})
        self.invoke('workers', 'edit', 'review', success=False)
        self.assertEqual(destination.read_bytes(), before)
        self.assertFalse(list(outside.iterdir()))

    def test_file_valued_parent_paths_fail_before_creating_assets_or_committing_edits(self):
        self.invoke('workers', 'add', 'goal', 'build')
        bindings = (self.environment / 'workers.json').read_bytes()
        (self.environment / 'worlds').write_text('Keep this existing file.')
        self.invoke('workers', 'add', 'swarm', 'search', success=False)
        self.assertEqual((self.environment / 'workers.json').read_bytes(), bindings)
        self.assertFalse((self.environment / 'agents').exists())
        self.assertFalse((self.environment / 'workers/search.json').exists())
        path = self.environment / 'workers/build.json'
        before = path.read_bytes()
        (self.environment / 'agents').write_text('Also keep this file.')
        self.env['EDIT_TEXT'] = json.dumps({'version': 1, 'kind': 'agent', 'config': {'agent': 'new'}})
        self.invoke('workers', 'edit', 'build', success=False)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual((self.environment / 'agents').read_text(), 'Also keep this file.')

    def test_failed_swarm_add_rolls_back_assets_and_binding_and_can_be_retried(self):
        ensure_environment(self.environment)
        # An existing empty directory is user content too; rollback retains it.
        (self.environment / 'agents').mkdir()
        original = (self.environment / 'workers.json').read_bytes()
        real_json, real_text = authoring.write_json, authoring.write_text_atomic
        for stage in ('asset', 'binding_before_commit', 'binding_after_commit'):
            with self.subTest(stage=stage):
                def write_json(path, value, **kwargs):
                    if Path(path).name == 'workers.json':
                        if stage == 'binding_after_commit':
                            real_json(path, value, **kwargs)
                        if stage != 'asset':
                            raise OSError('Injected binding failure')
                    return real_json(path, value, **kwargs)
                def write_text(path, text, **kwargs):
                    if stage == 'asset' and Path(path).name == 'evaluate.py':
                        raise OSError('Injected asset failure')
                    return real_text(path, text, **kwargs)
                with mock.patch.object(authoring, 'write_json', write_json), \
                     mock.patch.object(authoring, 'write_text_atomic', write_text), self.assertRaises(OSError):
                    authoring.add_worker(self.environment, 'swarm', 'search')
                self.assertEqual((self.environment / 'workers.json').read_bytes(), original)
                self.assertTrue((self.environment / 'agents').is_dir())
                self.assertEqual(list((self.environment / 'agents').iterdir()), [])
                for name in ('workers', 'worlds', 'programs'):
                    self.assertFalse((self.environment / name).exists(), name)
        authoring.add_worker(self.environment, 'swarm', 'search')
        self.assertIn('search', self.config()['types'])

    def test_failed_agent_edit_restores_definition_and_preserves_existing_assets(self):
        self.invoke('workers', 'add', 'agent', 'review')
        definition = self.environment / 'workers/review.json'
        original, bindings = definition.read_bytes(), (self.environment / 'workers.json').read_bytes()
        prompt = self.environment / 'agents/review/prompt.md'
        prompt.write_text('Existing instructions.')
        self.env['EDIT_TEXT'] = json.dumps({'version': 1, 'kind': 'agent', 'config': {'agent': 'new'}})
        real = authoring.write_text_atomic
        def write_text(path, text, **kwargs):
            if Path(path) == self.environment / 'agents/new/prompt.md':
                raise OSError('Injected new prompt failure')
            return real(path, text, **kwargs)
        with mock.patch.dict(os.environ, self.env), mock.patch.object(authoring, 'write_text_atomic', write_text), \
             self.assertRaises(OSError):
            authoring.edit_worker(self.environment, 'review')
        self.assertEqual(definition.read_bytes(), original)
        self.assertEqual((self.environment / 'workers.json').read_bytes(), bindings)
        self.assertEqual(prompt.read_text(), 'Existing instructions.')
        self.assertFalse((self.environment / 'agents/new').exists())

    def test_editor_conflict_does_not_roll_back_an_independent_file_change(self):
        self.invoke('workers', 'add', 'goal', 'build')
        path = self.environment / 'workers/build.json'
        changed = json.dumps({'version': 1, 'kind': 'goal', 'config': {'maxAttempts': 11}})
        proposed = json.dumps({'version': 1, 'kind': 'goal', 'config': {'maxAttempts': 7}})
        self.editor.write_text('import pathlib, sys\n'
            f'pathlib.Path({str(path)!r}).write_text({changed!r})\n'
            f'pathlib.Path(sys.argv[1]).write_text({proposed!r})\n')
        result = self.invoke('workers', 'edit', 'build', success=False)
        self.assertIn('File changed while the editor was open', result.stderr)
        self.assertEqual(path.read_text(), changed)

    def test_skill_import_copies_complete_resources_and_preserves_executable_mode(self):
        source = self.skill()
        (source / 'resources').mkdir()
        (source / 'resources/rules.txt').write_text('The reference rules.\n')
        script = source / 'check'
        script.write_text('#!/bin/sh\nexit 0\n')
        script.chmod(0o755)
        self.invoke('environment', 'add-skill', source)
        destination = self.environment / 'skills/schematic'
        self.assertEqual((destination / 'resources/rules.txt').read_bytes(), (source / 'resources/rules.txt').read_bytes())
        self.assertEqual((destination / 'check').stat().st_mode & 0o777, 0o755)
        (source / 'SKILL.md').write_text((source / 'SKILL.md').read_text() + 'Changed.\n')
        self.invoke('environment', 'add-skill', source, success=False)
        self.assertNotEqual((destination / 'SKILL.md').read_bytes(), (source / 'SKILL.md').read_bytes())

    def test_skill_import_rejects_links_and_special_files_before_copying(self):
        source = self.skill()
        outside = self.directory / 'secret'
        outside.write_text('outside')
        link = source / 'link'
        link.symlink_to(outside)
        self.invoke('environment', 'add-skill', source, success=False)
        self.assertFalse(self.environment.exists())
        link.unlink()
        os.mkfifo(source / 'pipe')
        self.invoke('environment', 'add-skill', source, success=False)
        self.assertFalse(self.environment.exists())

    def test_invalid_skill_metadata_is_rejected_and_folded_description_works(self):
        source = self.skill()
        path = source / 'SKILL.md'
        for text in ['no metadata', '---\nname: schematic\n---\n',
                     '---\nname: other\ndescription: Valid.\n---\n',
                     '---\nname: schematic\ndescription: true\n---\n',
                     '---\nname: schematic\ndescription: # missing\n---\n',
                     '---\nname: schematic\ndescription: Check: circuit\n---\n',
                     '---\nname: schematic\nname: schematic\ndescription: Valid.\n---\n']:
            path.write_text(text)
            self.invoke('environment', 'add-skill', source, success=False)
            self.assertFalse(self.environment.exists())
        path.write_text('---\nname: schematic\ndescription: >-\n  Check circuit\n  connectivity.\n---\nInstructions.\n')
        self.invoke('environment', 'add-skill', source)

    def test_dockerfile_import_replaces_only_the_canonical_file(self):
        self.invoke('workers', 'add', 'goal', 'build')
        before = (self.environment / 'workers.json').read_bytes()
        source = self.directory / 'Dockerfile.custom'
        source.write_text('FROM asys-workers\nCOPY . /opt/asys/environment\nRUN true\n')
        self.invoke('environment', 'dockerfile', source)
        self.assertEqual((self.environment / 'Dockerfile').read_bytes(), source.read_bytes())
        self.assertEqual((self.environment / 'workers.json').read_bytes(), before)
        self.assertFalse((self.environment / source.name).exists())
        source.write_text('')
        self.invoke('environment', 'dockerfile', source, success=False)
        self.assertIn('RUN true', (self.environment / 'Dockerfile').read_text())

    def test_environment_edit_scopes_files_and_validates_runtime_json(self):
        self.env['EDIT_TEXT'] = 'FROM asys-workers\nCOPY . /opt/asys/environment\n'
        self.invoke('environment', 'edit')
        before = (self.environment / 'workers.json').read_bytes()
        self.env['EDIT_TEXT'] = '{"version":1,"name":"test","types":{}}'
        self.invoke('environment', 'edit', 'workers.json', success=False)
        self.assertEqual((self.environment / 'workers.json').read_bytes(), before)
        outside = self.directory / 'outside'
        outside.write_text('Keep outside.')
        (self.environment / 'outside').symlink_to(outside)
        for path in ('../outside', str(outside), 'outside'):
            self.invoke('environment', 'edit', path, success=False)
        self.assertEqual(outside.read_text(), 'Keep outside.')


if __name__ == '__main__':
    unittest.main()
