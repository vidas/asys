"""Shared persistence and cleanup for the unified worker launcher."""
import json
import os
import signal
import sys

from asys_runtime.files import timestamp, write_json
from asys_runtime.queue import TERMINAL
from .execution import EnvironmentHost
from .lifecycle import Interrupted, LaunchError, RecoveryRequired


class SingleJob(EnvironmentHost):
    def __init__(self, args):
        super().__init__(args)
        self.record = {}
        self.lease = None
        self.queue = None
        self.job_id = None
        self.sequence = 0

    def say(self, text):
        if self.directory:
            with (self.directory / 'run.log').open('a') as output:
                print(text, file=output)
        print(text, file=sys.stderr, flush=True)

    def snapshot(self):
        if self.directory:
            self.record['updated_at'] = timestamp()
            if self.record.get('status') in {'completed', 'failed', 'cancelled', 'recovery-required'}:
                self.record.setdefault('finished_at', self.record['updated_at'])
            write_json(self.directory / 'run.json', self.record)

    def event(self, kind, **data):
        self.sequence += 1
        with (self.directory / 'events.jsonl').open('a') as output:
            output.write(json.dumps({'sequence': self.sequence, 'runId': self.id,
                'type': kind, 'time': timestamp(), 'data': data}, ensure_ascii=False) + '\n')
            output.flush()
            os.fsync(output.fileno())

    def close(self):
        try:
            if self.preserve_components and self.record.get('status') != 'cancelled' and not self.interrupted.is_set():
                self.record['components_removed'] = False
                return self._publish_health()
            if self.queue and self.job_id:
                try:
                    state = self.queue.cancel(self.job_id)
                except FileNotFoundError:
                    state = {'status': 'failed'}  # Submission failed before publication.
                except (OSError, ValueError) as error:
                    self.say(f'Could not cancel job: {error}')
                    state = {'status': 'failed'}
                if state['status'] not in TERMINAL:
                    try:
                        self.queue.wait(self.job_id, timeout=5)
                    except (OSError, ValueError) as error:
                        self.say(f'Could not wait for cancellation: {error}')
                        # Component removal terminates its remaining processes.
            clean = self.cleanup_components()
            if self.directory:
                self.record['components_removed'] = clean
                self.snapshot()
            return clean
        finally:
            if self.lease:
                self.lease.close()


def run(launcher):
    previous = {sig: signal.signal(sig, lambda *_: launcher.interrupted.set()) for sig in (signal.SIGINT, signal.SIGTERM)}
    code = 0
    try:
        launcher.setup()
        launcher.execute()
    except (Interrupted, KeyboardInterrupt):
        launcher.record['status'] = 'cancelled'
        launcher.say('Job cancelled')
        if launcher.directory:
            launcher.event('run.cancelled', jobId=launcher.job_id)
        code = 130
    except (LaunchError, OSError, ValueError) as error:
        launcher.record.update(status='recovery-required' if isinstance(error, RecoveryRequired) else 'failed', error=str(error))
        launcher.say(f'error: {error}')
        code = 1
    finally:
        try:
            if not launcher.close() and code == 0:
                code = 1
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
    return code
