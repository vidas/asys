"""Dcomp process execution and component ownership for host launchers."""
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import threading
import time


class LaunchError(Exception):
    pass


class CommandTimeout(LaunchError):
    pass


class RecoveryRequired(LaunchError):
    """Automatic recovery stopped; retain components and durable work."""


class Interrupted(Exception):
    pass


class ComponentHost:
    def __init__(self, args):
        self.args = args
        self.directory = None
        self.owned = []
        self.interrupted = threading.Event()
        # Freeze effective connection settings, including environment defaults.
        # Saved runs and services must keep addressing the same installation
        # after the invoking shell selects another setup.
        selected_state = (getattr(args, 'dcomp_state_root', None)
                          or os.environ.get('DCOMP_STATE_ROOT')
                          or Path(os.environ.get('XDG_STATE_HOME') or Path.home() / '.local/state') / 'dcomp')
        state = Path(selected_state).expanduser().resolve()
        selected_runtime = (getattr(args, 'runtime_root', None)
                            or os.environ.get('DCOMP_RUNTIME_ROOT') or state / 'run')
        runtime = Path(selected_runtime).expanduser().resolve()
        self.dcomp = [os.environ.get('DCOMP_BINARY') or 'dcomp',
                      '--state-root', str(state), '--runtime-root', str(runtime)]

    def check_interrupt(self):
        if self.interrupted.is_set():
            raise Interrupted()

    def command(self, command, *, timeout=120, cleanup=False, cancellable=False):
        if not cleanup:
            self.check_interrupt()
        with (self.directory / "commands.log").open("a") as log:
            log.write(shlex.join(command) + "\n")
            log.flush()
            child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                     stderr=log, text=True, start_new_session=True)
            deadline = time.monotonic() + timeout
            try:
                while True:
                    if cancellable and self.interrupted.is_set():
                        raise Interrupted()
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise CommandTimeout(f"Command timed out: {shlex.join(command)}")
                    try:
                        output, _ = child.communicate(timeout=min(0.2, remaining))
                        break
                    except subprocess.TimeoutExpired:
                        pass
            except BaseException:
                # The group may still contain helpers after its leader exits.
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    output, _ = child.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    output, _ = child.communicate()
                log.write(output)
                raise
            log.write(output)
        if child.returncode:
            detail = (self.directory / "commands.log").read_text()[-4000:].strip()
            raise LaunchError(f"Command failed ({child.returncode}): {shlex.join(command)}\n{detail}")
        if not cleanup:
            self.check_interrupt()
        return output

    def document(self, *command, cleanup=False, timeout=120):
        value = json.loads(self.command(self.dcomp + list(command), cleanup=cleanup, timeout=timeout))
        if not isinstance(value, dict) or value.get("api_version") != 2:
            raise LaunchError("asys requires dcomp 0.3 (Machine API 2)")
        return value

    def check_components(self, components, names=None, *, allow_unhealthy=False):
        for name in self.owned if names is None else names:
            status = (components.get(name) or {}).get("status", {})
            if (not status or status.get("problem") or status.get("status") in {"exited", "dead", "missing"}
                    or (status.get("health") == "unhealthy"
                        and not (allow_unhealthy and status.get("status") == "running"))):
                raise LaunchError(f"Component {name} is unavailable: {status}")

    def cleanup_components(self, log_name="components.log"):
        if not self.owned:
            return True
        try:
            document = self.document("view", "--json", self.args.system, cleanup=True)
            if document.get("operation"):
                raise LaunchError(f"dcomp has a pending operation; inspect {self.args.system} before cleanup")
            components = {item["name"] for item in document["components"]} & set(self.owned)
            if components:
                try:
                    logs = self.command(self.dcomp + ["logs", self.args.system, *sorted(components)], cleanup=True)
                    with (self.directory / log_name).open("a") as output:
                        output.write(logs)
                except Exception as error:
                    self.say(f"Could not save component logs: {error}")
            for name in list(reversed(self.owned)):
                if name in components:
                    self.command(self.dcomp + ["rm-component", self.args.system, name], cleanup=True)
                self.owned.remove(name)
        except Exception as error:
            self.say(f"Component cleanup is incomplete: {error}\nState: {self.directory}")
            return False
        return True
