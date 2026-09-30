import contextlib
import fcntl
import io
import json
import os
import runpy
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'python'), str(ROOT / 'asys-runtime'), str(ROOT / 'test-support')]
from asys import overview as overview_module
from asys import version as version_module
from asys.cli import arguments
from asys_runtime.files import write_json
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


class SystemStatusTests(unittest.TestCase):
    def setUp(self):
        self.state = Path(tempfile.mkdtemp(prefix='asys-overview-'))
        self.addCleanup(shutil.rmtree, self.state)
        use_fixture_release(self, self.state, 'sha256:current')

    def dcomp(self, reports):
        """Fake `dcomp status --json` per state root; it exits 1 when not operational."""
        def run(command, **kwargs):
            report = reports.get(command[command.index('--state-root') + 1])
            return SimpleNamespace(returncode=0 if report and report.get('operational') else 1,
                                   stdout=json.dumps(report) if report else '', stderr='')
        return patch.object(overview_module.subprocess, 'run', side_effect=run)

    def test_status_without_a_run_reports_the_system_services_and_active_runs(self):
        (self.state / 'inference').mkdir()
        write_json(self.state / 'inference/machine.json', {'revision': 1, 'applied_revision': 1, 'config': {
            'system': 'asys', 'dcomp_state_root': '/shared/dcomp'}, 'applied': {'components': [
                {'name': 'asys-inference-gateway', 'component': {'image': 'sha256:current'}}]}})
        run = self.state / 'runs/abc123'
        run.mkdir(parents=True)
        write_json(run / 'run.json', {'id': 'abc123', 'name': 'Review', 'status': 'running', 'system': 'private',
                                      'dcomp': ['dcomp', '--state-root', '/run/dcomp'],
                                      'components': {'engine': 'review-engine', 'workers': 'review-workers'}})
        lease = (run / 'launcher.lock').open('a+b')
        self.addCleanup(lease.close)
        fcntl.flock(lease, fcntl.LOCK_EX)
        component = lambda name, health='healthy': {'name': name, 'status': 'running', 'health': health}
        reports = {
            '/shared/dcomp': {'desired': True, 'operational': False, 'operation': '', 'proxy': {'ready': True},
                              'components': [component('asys-inference-gateway'), component('stray')]},
            '/run/dcomp': {'desired': True, 'operational': True, 'operation': '', 'proxy': {'ready': True},
                           'components': [component('review-engine'), component('review-workers', 'unhealthy')]},
        }
        output = io.StringIO()
        with self.dcomp(reports), patch.object(overview_module, 'image_build', return_value='fixture'), \
                contextlib.redirect_stdout(output):
            args = arguments(['status', '--root', str(self.state)])
            args.handler(args)
        text = output.getvalue()
        self.assertIn('system    asys · dcomp /shared/dcomp · degraded', text)
        self.assertRegex(text, r'inference\s+asys-inference-gateway\s+running\s+healthy\s+current')
        self.assertIn('1 active of 1 saved', text)
        # Run components come from the run's own dcomp state and system.
        self.assertRegex(text, r'review-engine\s+running\s+healthy')
        self.assertIn('warning: run abc123 component review-workers is running/unhealthy', text)
        self.assertRegex(text, r'other components\n\s+stray\s+running\s+healthy')

    def test_a_run_argument_still_shows_that_run(self):
        args = arguments(['status', 'latest', '--root', str(self.state)])
        with patch('asys.cli.status') as run_status, patch('asys.cli.overview') as system:
            args.handler(args)
        run_status.assert_called_once_with(args)
        system.assert_not_called()


if __name__ == '__main__':
    unittest.main()
