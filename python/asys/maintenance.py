"""Coordinate a shared-service update with the runs it would break.

A new inference format leaves the workers of active runs without usable models.
Before the services change, every affected run drains on the old services:
a workflow through a background asys-run --upgrade, which then waits for the
new services before it replaces its workers; a single worker by finishing.
STATE/maintenance.json journals the operation, so repeating asys update
continues it.
"""
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

from asys_runtime import release
from asys_runtime.files import acquire_lock, read_json, timestamp, write_json

from .runs import TERMINAL, Runs, launcher_state
from .upgrade import PROTOCOL as UPGRADE_PROTOCOL, read_journal

FILE = 'maintenance.json'
POLL_SECONDS = 1
NOTICE_SECONDS = 15


def load(root):
    path = Path(root) / FILE
    return read_json(path) if path.is_file() else None


def save(root, maintenance):
    maintenance['updatedAt'] = timestamp()
    write_json(Path(root) / FILE, maintenance)


def affected_runs(root, installed):
    """Active runs whose workers speak another inference format than INSTALLED."""
    wanted = installed.get('interfaces', {}).get('inference')
    affected = []
    for directory in Runs(Path(root) / 'runs').directories():
        record = read_json(directory / 'run.json')
        if record.get('status') in TERMINAL or launcher_state(directory) != 'running':
            continue  # Nothing executes it; a later resume uses the installed code.
        spoken = _inference_format(directory)
        if spoken == wanted:
            continue
        if not record.get('workflow'):
            kind = 'finish'
        elif record.get('upgrade_protocol') == UPGRADE_PROTOCOL:
            kind = 'upgrade'
        else:
            kind = 'unsupported'
        affected.append({'id': record['id'], 'name': record.get('name', record['id']), 'kind': kind,
                         'inference': spoken or 'unknown'})
    return affected


def plan(root, installed, *, force=False):
    """Return the maintenance to perform before replacing services, or None."""
    current = load(root)
    if current and current.get('phase') != 'complete':
        print(f"Continuing the update to {current['build']} begun at {current['createdAt']}.", flush=True)
        return current
    affected = affected_runs(root, installed)
    if not affected:
        return None
    unsupported = [run for run in affected if run['kind'] == 'unsupported']
    if unsupported and not force:
        names = ', '.join(f"{run['id'][:8]} ({run['name']})" for run in unsupported)
        raise ValueError(f"Active workflows started before upgrade handover would lose inference: {names}. "
                         'Let them finish, or repeat with --force to update anyway; they will fail.')
    maintenance = {'version': 1, 'id': uuid.uuid4().hex, 'build': installed['build'],
                   'inference': installed['interfaces']['inference'], 'phase': 'draining',
                   'runs': {run['id']: run['kind'] for run in affected if run['kind'] != 'unsupported'},
                   'createdAt': timestamp()}
    save(root, maintenance)
    for run in affected:
        action = {'upgrade': 'drain and upgrade', 'finish': 'let finish',
                  'unsupported': 'left to fail (--force)'}[run['kind']]
        print(f"Run {run['id'][:8]} ({run['name']}) speaks {run['inference']}: {action}", flush=True)
    return maintenance


def drain(root, maintenance, spawn):
    """Wait until every affected run has drained on the current services."""
    root = Path(root)
    children, next_notice = {}, 0
    while True:
        waiting = []
        for run_id, kind in maintenance['runs'].items():
            directory = root / 'runs' / run_id
            if kind == 'finish':
                if _executing(directory):
                    waiting.append(run_id)
                continue
            state = run_state(directory, maintenance)
            if state in {'drained', 'done'}:
                continue
            child = children.get(run_id)
            # A failed upgrade resumes from its journal when started again; only
            # an upgrade started by this command exiting early stops the update.
            if child is not None and child.poll() is not None:
                raise ValueError(f'The upgrade of run {run_id[:8]} stopped: {_failure(directory)}. '
                                 f'See {directory / "upgrade.log"}; fix it and repeat asys update to continue.')
            if child is None and _upgrade_idle(directory):
                children[run_id] = spawn(run_id)
            waiting.append(run_id)
        if not waiting:
            return
        if time.monotonic() >= next_notice:
            print(f"Waiting for {len(waiting)} run(s) to drain on the current services: "
                  + ', '.join(run_id[:8] for run_id in waiting), flush=True)
            next_notice = time.monotonic() + NOTICE_SECONDS
        time.sleep(POLL_SECONDS)


def release_runs(root, maintenance, *, timeout=600):
    """Let drained workflows continue on the replaced services."""
    maintenance['phase'] = 'ready'
    save(root, maintenance)
    deadline = time.monotonic() + timeout
    # Only runs waiting at the barrier have anything left to replace.
    upgrades = [run_id for run_id, kind in maintenance['runs'].items()
                if kind == 'upgrade' and run_state(Path(root) / 'runs' / run_id, maintenance) == 'drained']
    while True:
        pending = [run_id for run_id in upgrades
                   if (read_journal(Path(root) / 'runs' / run_id) or {}).get('phase') != 'complete']
        if not pending:
            break
        if time.monotonic() >= deadline:
            raise ValueError('Upgraded runs have not recovered yet: ' + ', '.join(run_id[:8] for run_id in pending)
                             + '. Their background upgrades continue; see each run\'s upgrade.log.')
        time.sleep(POLL_SECONDS)
    maintenance['phase'] = 'complete'
    maintenance['completedAt'] = timestamp()
    save(root, maintenance)
    for run_id in upgrades:
        print(f'Run {run_id[:8]} continues on {maintenance["build"]}; watch it with asys top or asys logs -f {run_id[:8]}',
              flush=True)


def spawner(root):
    """Start a background asys-run --upgrade whose monitor outlives this command."""
    checkout = Path(__file__).resolve().parents[2] / 'tools/asys-run'
    command = str(checkout) if checkout.is_file() else str(Path(sys.argv[0]).resolve().parent / 'asys-run')

    def spawn(run_id):
        directory = Path(root) / 'runs' / run_id
        with (directory / 'upgrade.log').open('a') as log:
            return subprocess.Popen([sys.executable, command, '--upgrade', run_id, '--root', str(root)],
                                    stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                    start_new_session=True)
    return spawn


def _inference_format(directory):
    manifest = directory / 'environment/component.dcomp'
    image = next((words[1] for words in (line.split() for line in manifest.read_text().splitlines())
                  if len(words) == 2 and words[0] == 'docker'), None) if manifest.is_file() else None
    try:
        return release.image_labels(image).get(release.INFERENCE_LABEL) if image else None
    except release.ReleaseError:
        return None


def _executing(directory):
    record = read_json(directory / 'run.json')
    return record.get('status') not in TERMINAL and launcher_state(directory) == 'running'


def run_state(directory, maintenance):
    """drained (waiting for new services), done or active, for MAINTENANCE."""
    journal = read_journal(directory)
    ours = journal is not None and journal.get('maintenance') == maintenance['id']
    if ours and journal.get('awaitingMaintenance') == maintenance['id']:
        return 'drained'
    if ours and journal['phase'] == 'complete':
        return 'done'  # It finished during handover; nothing to replace.
    if not ours and read_json(directory / 'run.json').get('status') in TERMINAL:
        return 'done'  # It ended on its own; a later resume uses the installed code.
    return 'active'


def _upgrade_idle(directory):
    guard = acquire_lock(directory / 'upgrade.lock')
    if guard is None:
        return False
    os.close(guard)
    return True


def _failure(directory):
    return (read_journal(directory) or {}).get('error') or 'it exited before draining'
