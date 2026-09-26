"""Host launchers must finish ownership changes and clean up only their own work."""
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
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "python"), str(ROOT / "asys-runtime")]
from asys.lifecycle import ComponentHost, Interrupted, LaunchError
from asys.execution import EnvironmentHost


class LifecycleTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="asys-lifecycle-")
        self.addCleanup(directory.cleanup)
        self.host = ComponentHost(SimpleNamespace(system="test"))
        self.host.directory = Path(directory.name)
        self.host.say = lambda message: None

    def test_failed_command_keeps_diagnostics(self):
        with self.assertRaisesRegex(LaunchError, "Command failed \\(7\\)") as failure:
            self.host.command([sys.executable, "-c", "import sys; print('output'); print('diagnostic', file=sys.stderr); sys.exit(7)"])
        self.assertIn("diagnostic", str(failure.exception))
        self.assertIn("output", (self.host.directory / "commands.log").read_text())

    def test_timeout_stops_helpers_even_after_their_parent_exits(self):
        heartbeat = self.host.directory / "heartbeat"
        helper = f"import time\nfrom pathlib import Path\np = Path({str(heartbeat)!r})\nwhile True:\n with p.open('a') as f: f.write('tick\\n')\n time.sleep(.02)"
        parent = f"import subprocess, sys; subprocess.Popen([sys.executable, '-c', {helper!r}])"
        with self.assertRaisesRegex(LaunchError, "timed out"):
            self.host.command([sys.executable, "-c", parent], timeout=.5)
        saved = heartbeat.read_text()
        time.sleep(.1)
        self.assertEqual(heartbeat.read_text(), saved, "a helper must not outlive its cancelled command")

    def test_interrupt_waits_for_component_changes_but_cancels_builds(self):
        marker = self.host.directory / "changed"
        command = [sys.executable, "-c", f"import time; time.sleep(.3); open({str(marker)!r}, 'w').close()"]
        timer = threading.Timer(.05, self.host.interrupted.set)
        timer.start()
        self.addCleanup(timer.join)
        with self.assertRaises(Interrupted):
            self.host.command(command)
        self.assertTrue(marker.exists(), "a component change must finish before shutdown")
        self.assertEqual(self.host.command([sys.executable, "-c", "print('cleanup')"], cleanup=True), "cleanup\n")
        self.host.interrupted.clear()
        timer = threading.Timer(.05, self.host.interrupted.set)
        timer.start()
        self.addCleanup(timer.join)
        build = self.host.directory / "build-finished"
        with self.assertRaises(Interrupted):
            self.host.command([sys.executable, "-c", f"import time; time.sleep(1); open({str(build)!r}, 'w').close()"], cancellable=True)
        self.assertFalse(build.exists())

    def test_cleanup_removes_only_owned_components_in_reverse_order(self):
        self.host.owned = ["workers", "workflow", "never-started"]
        document = {"components": [{"name": name} for name in ["unrelated", "workers", "workflow"]]}
        commands = []
        def command(args, **options):
            self.assertTrue(options["cleanup"])
            commands.append(args)
            return "saved logs\n"
        with patch.object(self.host, "document", return_value=document), patch.object(self.host, "command", side_effect=command):
            self.assertTrue(self.host.cleanup_components())
        self.assertEqual(commands, [self.host.dcomp + ["logs", "test", "workers", "workflow"],
                                    self.host.dcomp + ["rm-component", "test", "workflow"],
                                    self.host.dcomp + ["rm-component", "test", "workers"]])
        self.assertEqual(self.host.owned, [])
        self.assertEqual((self.host.directory / "components.log").read_text(), "saved logs\n")

    def test_failed_cleanup_keeps_remaining_ownership(self):
        self.host.owned = ["workers", "workflow"]
        document = {"components": [{"name": name} for name in self.host.owned]}
        def command(args, **options):
            if args[len(self.host.dcomp)] == "rm-component" and args[-1] == "workers":
                raise LaunchError("removal failed")
            return ""
        with patch.object(self.host, "document", return_value=document), patch.object(self.host, "command", side_effect=command):
            self.assertFalse(self.host.cleanup_components())
        self.assertEqual(self.host.owned, ["workers"])
        document["operation"] = {"type": "resync"}
        with patch.object(self.host, "document", return_value=document), patch.object(self.host, "command") as execute:
            self.assertFalse(self.host.cleanup_components())
            execute.assert_not_called()

    def test_machine_api_and_component_health_are_checked(self):
        with patch.object(self.host, "command", return_value=json.dumps({"api_version": 1})):
            with self.assertRaisesRegex(LaunchError, "Machine API 2"):
                self.host.document("view", "test")
        self.host.owned = ["workers"]
        for status in [{}, {"status": "exited"}, {"status": "dead"}, {"status": "missing"},
                       {"status": "running", "health": "unhealthy"}, {"problem": "stopped"}]:
            with self.subTest(status=status), self.assertRaises(LaunchError):
                self.host.check_components({"workers": {"status": status}})
        self.host.check_components({"workers": {"status": {"status": "running", "health": "healthy"}}})

    def test_busy_system_status_does_not_fail_or_clean_up_an_active_run(self):
        host = EnvironmentHost(SimpleNamespace(system="test"))
        host.directory = self.host.directory
        host.owned = ['worker']
        messages = []
        host.say = messages.append
        lock_path = host.directory / 'system.lock'
        script = host.directory / 'status.py'
        script.write_text("import fcntl, json\n"
                          f"lock = open({str(lock_path)!r}, 'a')\n"
                          "fcntl.flock(lock, fcntl.LOCK_SH)\n"
                          "print(json.dumps({'api_version': 2, 'components': ["
                          "{'name': 'worker', 'status': {'status': 'running', 'health': 'healthy'}}]}))\n")
        host.dcomp = [sys.executable, str(script)]
        command = host.command
        def quick_command(argv, **kwargs):
            self.assertEqual(kwargs['timeout'], 5)
            return command(argv, **{**kwargs, 'timeout': .15})
        with lock_path.open('a') as lock, patch.object(host, 'command', side_effect=quick_command), \
                patch.object(host, 'cleanup_components') as cleanup:
            fcntl.flock(lock, fcntl.LOCK_EX)
            host.monitor_components()
            host.monitor_components()
            self.assertEqual(len(messages), 1)
            self.assertIn('execution continues', messages[0])
            cleanup.assert_not_called()
            self.assertEqual(host.owned, ['worker'])
            fcntl.flock(lock, fcntl.LOCK_UN)
            host.monitor_components()
        self.assertIn('recovered', messages[-1])
        with patch.object(host, 'observe', return_value=({}, {'worker': {'status': {'status': 'exited'}}})):
            with self.assertRaisesRegex(LaunchError, 'unavailable'):
                host.monitor_components()

    def test_effective_connection_paths_are_frozen_with_explicit_options_first(self):
        root = self.host.directory
        with patch.dict(os.environ, {'DCOMP_STATE_ROOT': str(root / 'environment-state'),
                                     'DCOMP_RUNTIME_ROOT': str(root / 'environment-runtime')}):
            selected = ComponentHost(SimpleNamespace(system='test'))
            self.assertEqual(selected.dcomp[1:], ['--state-root', str(root / 'environment-state'),
                                                 '--runtime-root', str(root / 'environment-runtime')])
            explicit = ComponentHost(SimpleNamespace(system='test', dcomp_state_root=root / 'explicit-state',
                                                      runtime_root=root / 'explicit-runtime'))
            self.assertEqual(explicit.dcomp[1:], ['--state-root', str(root / 'explicit-state'),
                                                 '--runtime-root', str(root / 'explicit-runtime')])
        with patch.dict(os.environ, {'DCOMP_STATE_ROOT': '', 'DCOMP_RUNTIME_ROOT': '',
                                     'XDG_STATE_HOME': str(root / 'xdg')}):
            selected = ComponentHost(SimpleNamespace(system='test'))
            self.assertEqual(selected.dcomp[1:], ['--state-root', str(root / 'xdg/dcomp'),
                                                 '--runtime-root', str(root / 'xdg/dcomp/run')])


if __name__ == "__main__":
    unittest.main()
