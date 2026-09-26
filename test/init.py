import grp
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'python'), str(ROOT / 'asys-runtime')]


class InitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cwd = Path(self.temp.name)
        self.calls = self.cwd / 'calls.json'
        self.dcomp = self.cwd / 'dcomp'
        self.dcomp.write_text('#!/usr/bin/env python3\nimport json, os, sys\nfrom pathlib import Path\n'
            'Path(os.environ["INIT_TEST_CALLS"]).write_text(json.dumps(sys.argv[1:]))\n'
            'Path(sys.argv[2]).mkdir(parents=True, exist_ok=True)\n')
        self.dcomp.chmod(0o755)
        self.env = {**os.environ, 'DCOMP_BINARY': str(self.dcomp), 'INIT_TEST_CALLS': str(self.calls),
                    'DCOMP_STATE_ROOT': str(self.cwd / 'existing dcomp')}

    def run_init(self, *args):
        return subprocess.run([sys.executable, str(ROOT / 'tools/asys'), 'init', *map(str, args)],
                              cwd=self.cwd, env=self.env, capture_output=True, text=True)

    def test_init_uses_local_dcomp_instead_of_the_active_setup(self):
        state = self.cwd / "state with 'quotes and $dollars"
        result = self.run_init(state)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.calls.read_text()), ['init', str(state / 'dcomp')])
        self.assertIn(f'source {shlex.quote(str(state / "asys-env"))}', result.stdout)
        self.assertFalse((self.cwd / 'asys-env').exists())
        for child in ('runs', 'inference', 'human', 'dcomp'):
            self.assertTrue((state / child).is_dir())
        output = subprocess.check_output(['bash', '-ec', 'source "$1"\nprintenv ASYS_STATE_ROOT DCOMP_STATE_ROOT',
                                         'bash', str(state / 'asys-env')],
                                         cwd=self.cwd, env=self.env, text=True)
        self.assertEqual(output.splitlines(), [str(state), str(state / 'dcomp')])
        (state / 'keep').write_text('preserved')
        self.assertEqual(self.run_init(state).returncode, 0)
        self.assertEqual((state / 'keep').read_text(), 'preserved')

    def test_explicit_dcomp_is_initialized_and_group_is_forwarded(self):
        group = grp.getgrgid(os.getgid()).gr_name
        state, dcomp = self.cwd / 'state', self.cwd / 'new dcomp'
        result = self.run_init('--group', group, state, '--dcomp', dcomp)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.calls.read_text()), ['init', str(dcomp), '--group', group])
        for path in (state, state/'runs', state/'inference', state/'human'):
            self.assertEqual(path.stat().st_mode & 0o7777, 0o2770)
            self.assertEqual(path.stat().st_gid, os.getgid())

    def test_existing_manual_environment_file_is_not_overwritten(self):
        state = self.cwd / 'state'
        state.mkdir()
        path = state / 'asys-env'
        path.write_text('my configuration\n')
        result = self.run_init(state)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(path.read_text(), 'my configuration\n')

    def test_default_dcomp_ignores_xdg_state_home(self):
        self.env.pop('DCOMP_STATE_ROOT')
        self.env['XDG_STATE_HOME'] = str(self.cwd / 'xdg')
        state = self.cwd / 'state'
        result = self.run_init(state)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.calls.read_text()), ['init', str(state / 'dcomp')])
        self.assertFalse((self.cwd / 'xdg').exists())

    def test_default_dcomp_receives_the_shared_group(self):
        group = grp.getgrgid(os.getgid()).gr_name
        state = self.cwd / 'shared'
        result = self.run_init(state, '--group', group)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.calls.read_text()),
                         ['init', str(state / 'dcomp'), '--group', group])
        self.assertEqual((state / 'asys-env').stat().st_mode & 0o777, 0o660)

    def test_failed_dcomp_init_does_not_publish_environment(self):
        self.dcomp.write_text('#!/bin/sh\necho "initialization failed" >&2\nexit 1\n')
        for explicit in (False, True):
            with self.subTest(explicit=explicit):
                state = self.cwd / ('explicit' if explicit else 'default')
                args = ['--dcomp', self.cwd / 'dcomp-state'] if explicit else []
                result = self.run_init(state, *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('initialization failed', result.stderr)
                self.assertFalse((state / 'asys-env').exists())

    def test_group_init_preserves_contents_and_rejects_changing_private_state(self):
        group = grp.getgrgid(os.getgid()).gr_name
        state = self.cwd / 'shared/parent/state'
        self.assertEqual(self.run_init(state, '--group', group).returncode, 0)
        (state / 'runs/keep').write_text('existing run')
        self.assertEqual(self.run_init(state, '--group', group).returncode, 0)
        self.assertEqual(self.run_init(state).returncode, 0)
        self.assertEqual((state / 'asys-env').stat().st_mode & 0o777, 0o660)
        self.assertEqual((state / 'asys-env').stat().st_gid, os.getgid())
        self.assertEqual((state / 'runs/keep').read_text(), 'existing run')
        for path in (state, state.parent, state.parent.parent):
            self.assertEqual(path.stat().st_mode & 0o7777, 0o2770)
        private = self.cwd / 'private'
        self.assertEqual(self.run_init(private).returncode, 0)
        result = self.run_init(private, '--group', group)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('different permissions', result.stderr)
        self.assertEqual(private.stat().st_mode & 0o7777, 0o700)

    def test_base_directory_controls_runs_and_human_state(self):
        code = 'from asys.runs import default_root; from asys.state import state_root; print(default_root()); print(state_root("human"))'
        result = subprocess.check_output([sys.executable, '-c', code], env={**self.env,
            'PYTHONPATH': str(ROOT/'python'), 'ASYS_STATE_ROOT': str(self.cwd/'state')}, text=True)
        self.assertEqual(result.splitlines(), [str(self.cwd/'state/runs'), str(self.cwd/'state/human')])

    def test_sourcing_labels_the_prompt_without_stacking_on_repeat_or_switch(self):
        unrelated = self.cwd / 'asys-env'
        unrelated.write_text('unrelated configuration\n')
        self.assertEqual(self.run_init(self.cwd / 'host').returncode, 0)
        self.assertEqual(self.run_init(self.cwd / 'another').returncode, 0)
        self.assertEqual(unrelated.read_text(), 'unrelated configuration\n')
        shell = '''PS1='original> '
source ./host/asys-env
printf '%s\\n' "$PS1"
source ./host/asys-env
printf '%s\\n' "$PS1"
source ./another/asys-env
printf '%s\\n' "$PS1"
'''
        output = subprocess.check_output(['bash', '-ec', shell], cwd=self.cwd, env=self.env, text=True)
        self.assertEqual(output.splitlines(), ['{ host } original> ', '{ host } original> ', '{ another } original> '])

    def test_directory_name_cannot_execute_code_during_prompt_expansion(self):
        state = self.cwd / '$(touch INJECTED)%n'
        self.assertEqual(self.run_init(state).returncode, 0)
        shell = '''PS1='original> '
source "$1"
printf '%s\\n' "${PS1@P}"
'''
        subprocess.check_output(['bash', '-ec', shell, 'bash', str(state / 'asys-env')],
                                cwd=self.cwd, env=self.env, text=True)
        self.assertFalse((self.cwd / 'INJECTED').exists())
        output = subprocess.check_output(['bash', '-ec', 'unset PS1; source "$1"; printf "%s" "${PS1+x}"',
                                         'bash', str(state / 'asys-env')],
                                         cwd=self.cwd, env=self.env, text=True)
        self.assertEqual(output, '')


if __name__ == '__main__':
    unittest.main()
