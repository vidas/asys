import contextlib
import io
import json
import os
import runpy
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'python'), str(ROOT / 'asys-runtime'), str(ROOT / 'test-support')]
from asys import version as version_module
from asys.cli import arguments
from release_fixture import use_fixture_release


class ArgumentTests(unittest.TestCase):
    def test_root_can_precede_follow_or_interrupt_command_arguments(self):
        for command in [
            ['update'], ['ps', '--json'], ['status', 'latest', '--json'],
            ['logs', 'latest', 'worker', '--stream', 'stderr'], ['top', 'latest'],
            ['system-model', 'set', 'simple', 'provider/model'],
            ['system-model', 'list', '--json'],
        ]:
            # --root is accepted at each boundary between complete arguments.
            boundaries = range(len(command) + 1)
            for position in boundaries:
                if position and command[position - 1] == '--stream':
                    continue
                argv = [*command[:position], '--root', '/selected/state', *command[position:]]
                with self.subTest(argv=argv):
                    args = arguments(argv)
                    self.assertEqual(args.root, Path('/selected/state'))
                    self.assertTrue(callable(args.handler))

    def test_default_root_is_the_system_root_for_every_command(self):
        with patch.dict(os.environ, {'ASYS_STATE_ROOT': '/selected/state'}):
            for command in [['update'], ['system-model', 'list']]:
                self.assertEqual(arguments(command).root, Path('/selected/state'))
            for command in ['ps', 'status', 'logs', 'top']:
                self.assertEqual(arguments([command]).root, Path('/selected/state'))

    def test_all_job_launchers_select_the_same_system_root(self):
        from asys.run import arguments as run_arguments
        from asys.human_service import SharedHumanService
        bpmn_arguments = run_arguments
        with patch.dict(os.environ, {'ASYS_STATE_ROOT': '/ambient/state'}):
            for parse, argv in [(run_arguments, ['env', 'simple', 'prompt']),
                                (bpmn_arguments, ['env', 'workflow.bpmn'])]:
                self.assertEqual(parse(argv).root, Path('/ambient/state'))
                selected = parse([*argv, '--root', '/explicit/state'])
                self.assertEqual(selected.root, Path('/explicit/state'))
                self.assertEqual(SharedHumanService(selected).directory.parent, Path('/explicit/state/human'))

    def test_logs_allow_options_between_run_and_job_and_apply_source_defaults(self):
        args = arguments(['logs', 'latest', '--stream', 'stderr', 'worker', '-n', '0'])
        self.assertEqual((args.run, args.job, args.stream, args.source, args.lines),
                         ('latest', 'worker', 'stderr', 'jobs', 0))
        self.assertIsNone(arguments(['logs', 'latest']).lines)
        self.assertEqual(arguments(['logs', '--source', 'components']).lines, 50)
        self.assertEqual(arguments(['logs', 'latest', 'worker']).lines, 50)

    def test_resume_and_upgrade_reject_new_execution_configuration(self):
        from asys.run import arguments as run_arguments
        for option in ['--resume', '--upgrade']:
            for extra in (['--workspace', '/new'], ['--system', 'new'], ['--model', 'account/model'],
                          ['--dcomp-state-root', '/new'], ['--runtime-root', '/new'], ['-L', 'inference=@new'],
                          ['env', 'worker', 'request'], ['--parameters', 'limits.json'], ['--input', 'new.md']):
                with self.subTest(option=option, extra=extra), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                    run_arguments([option, 'saved', *extra])
                self.assertEqual(error.exception.code, 2)
            args = run_arguments([option, 'saved', '--root', '/state', '--human'])
            self.assertEqual((args.run, args.root, args.human, args.command),
                             ('saved', Path('/state'), True, option[2:]))
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            run_arguments(['--resume', 'saved', '--upgrade', 'saved'])
        self.assertEqual(error.exception.code, 2)

    def test_init_accepts_intermixed_options_and_uses_its_directory_argument(self):
        args = arguments(['init', '--group', 'asys', '/state', '--dcomp', '/dcomp'])
        self.assertEqual((args.directory, args.dcomp, args.group), (Path('/state'), Path('/dcomp'), 'asys'))
        self.assertIsNone(args.root)

    def test_invalid_commands_options_and_combinations_fail_at_the_cli(self):
        cases = [
            ['unknown'], ['--unknown'], ['system-model'], ['system-model', 'delete'],
            ['system-model', 'set', 'simple'], ['system-model', 'list', '--js'],
            ['--root', '/state', 'init', '/state'], ['init', '/state', '--root', '/state'],
            ['logs', '--lines', '-1'], ['logs', 'latest', 'worker', '--source', 'events'],
            ['logs', '--stream', 'stdout', '--source', 'run'], ['ps', 'unexpected'],
            ['status', '--js'], ['--roo', '/state', 'ps'], ['update', '--json'],
        ]
        for argv in cases:
            with self.subTest(argv=argv), contextlib.redirect_stderr(io.StringIO()), \
                    self.assertRaises(SystemExit) as exited:
                arguments(argv)
            self.assertEqual(exited.exception.code, 2)

    def test_help_belongs_to_the_selected_command(self):
        for argv, usage in [
            ([], 'usage: asys '), (['--help'], 'usage: asys '),
            (['logs', '--help'], 'usage: asys logs '),
            (['system-model', '--help'], 'usage: asys system-model '),
            (['system-model', 'set', '--help'], 'usage: asys system-model set '),
            (['system-model', 'list', '--help'], 'usage: asys system-model list '),
            (['skill', '--help'], 'usage: asys skill '),
        ]:
            with self.subTest(argv=argv), contextlib.redirect_stdout(io.StringIO()) as output, \
                    self.assertRaises(SystemExit) as exited:
                arguments(argv)
            self.assertEqual(exited.exception.code, 0)
            self.assertTrue(output.getvalue().startswith(usage), output.getvalue())


class VersionTests(unittest.TestCase):
    def test_version_names_the_release_and_flags_services_on_other_builds(self):
        state = Path(tempfile.mkdtemp(prefix='asys-version-'))
        self.addCleanup(shutil.rmtree, state)
        use_fixture_release(self, state, 'sha256:current')
        (state / 'inference').mkdir()
        (state / 'inference/machine.json').write_text(json.dumps({'revision': 2, 'applied_revision': 2, 'applied': {
            'components': [{'name': 'asys-inference-gateway', 'component': {'image': 'sha256:gateway'}}]}}))
        (state / 'human/shared').mkdir(parents=True)
        (state / 'human/shared/service.json').write_text(json.dumps({'component': 'asys-human', 'image': 'sha256:current'}))
        builds = {'sha256:gateway': 'older-build', 'sha256:current': 'fixture'}
        output = io.StringIO()
        with patch.object(version_module.release, 'inspect_image', return_value='sha256:current'), \
                patch.object(version_module, 'image_build', side_effect=builds.get), \
                patch.object(version_module.shutil, 'which', return_value=None), \
                contextlib.redirect_stdout(output):
            args = arguments(['version', '--root', str(state)])
            args.handler(args)
        text = output.getvalue()
        self.assertIn('asys 0.0.0 (build fixture)', text)
        self.assertRegex(text, r'asys-inference-gateway\s+older-build\s+outdated')
        self.assertRegex(text, r'asys-human\s+fixture\s+current')
        self.assertIn('warning: asys-inference-gateway was not built by release fixture; run asys update', text)
        self.assertNotIn('warning: asys-human', text)


if __name__ == '__main__':
    unittest.main()
