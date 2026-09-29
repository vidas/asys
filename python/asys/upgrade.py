"""Drain and replace one workflow's components without retrying its jobs.

The launcher lease protects execution ownership. A second, shorter-lived lease
serializes upgrade requests, including the handover from an existing launcher.
The journal records intent before component changes so an interrupted command
can continue without selecting a different set of replacement images.
"""
import fcntl
import os
from pathlib import Path
import time
import uuid

from asys_runtime.environment import Environment
from asys_runtime.files import acquire_lock, read_json, timestamp, write_json, write_text_atomic
from asys_runtime.permissions import shared
from asys_runtime.queue import Queue
from .lifecycle import LaunchError
from .runs import Runs
from .state import state_root


PROTOCOL = 1
HANDOVER_TIMEOUT = 30
POLL_SECONDS = 0.2
PHASES = ('requested', 'owned', 'stopping_engine', 'draining', 'replacing',
          'prepared', 'starting', 'recovering', 'complete')
TERMINAL = {'completed', 'failed', 'cancelled'}


class UpgradeHandover(Exception):
    """The current monitor yielded its lease without cancelling execution."""


def _journal(directory):
    path = Path(directory) / 'upgrade.json'
    if not path.exists():
        return None
    value = read_json(path)
    if (not isinstance(value, dict) or value.get('version') != PROTOCOL
            or value.get('phase') not in PHASES or not isinstance(value.get('id'), str)
            or value.get('runId') != Path(directory).name):
        raise LaunchError(f'Invalid upgrade journal: {path}')
    return value


def pending_upgrade(directory):
    value = _journal(directory)
    if value is None or value['phase'] == 'complete':
        return False
    if value['phase'] != 'requested' or value.get('handedOverAt'):
        return True
    # A requester can exit before the monitor sees it. Such a request must not
    # prevent ordinary resume if the original workflow subsequently fails.
    requester = acquire_lock(Path(directory) / 'upgrade.lock')
    if requester is None:
        return True
    os.close(requester)
    return False


def _save(host, journal, phase=None, **fields):
    if phase is not None:
        journal['phase'] = phase
    journal.update(fields, updatedAt=timestamp())
    write_json(host.directory / 'upgrade.json', journal)


def handover_if_requested(host):
    """Called by the owning monitor; an absent requester never causes a detach."""
    if getattr(host, 'upgrade_in_progress', False):
        return
    journal = _journal(host.directory)
    if not journal or journal['phase'] != 'requested':
        return
    requester = acquire_lock(host.directory / 'upgrade.lock')
    if requester is not None:
        os.close(requester)
        return
    host.upgrade_handover = True
    host.preserve_components = True
    host.record['status'] = 'upgrading'
    host.record.pop('finished_at', None)
    host.snapshot()
    _save(host, journal, handedOverAt=timestamp())
    host.say('Handing workflow monitoring to asys-run --upgrade; jobs remain running')
    raise UpgradeHandover()


def _record(host, directory):
    record = read_json(directory / 'run.json')
    if (not isinstance(record, dict) or record.get('id') != directory.name
            or not record.get('workflow') or not isinstance(record.get('components'), dict)
            or not {'engine', 'workers'} <= record['components'].keys()
            or not isinstance(record.get('links'), dict)):
        raise LaunchError('Upgrade requires a saved workflow with its component and connection records')
    host.directory, host.record = directory, record
    host.id, host.names = record['id'], record['components']
    host.args.system = record['system']
    host.dcomp = list(record['dcomp'])
    if os.environ.get('DCOMP_BINARY'):
        host.dcomp[0] = os.environ['DCOMP_BINARY']
    host.channel = directory / 'runtime/channels/workflow'
    return record


def _lease(directory):
    lease = (directory / 'launcher.lock').open('a+b')
    try:
        fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lease.close()
        return None
    return lease


def _view(host):
    view = host.document('view', '--json', host.args.system)
    if view.get('operation'):
        raise LaunchError('A dcomp operation is still present; finish it before continuing this upgrade')
    return {item['name']: item for item in view['components']}


def _image(component):
    return component.get('image_id') or component.get('image_ref')


def _identity(component):
    return {'image': _image(component), 'container': component.get('status', {}).get('container_id')}


def _matches(name, component, expected):
    if _image(component) != expected['image']:
        raise LaunchError(f'Component {name} has an unexpected image; preserving it for inspection')
    container = expected.get('container')
    if container and component.get('status', {}).get('container_id') != container:
        raise LaunchError(f'Component {name} was replaced outside this upgrade; preserving it for inspection')


def _remove(host, names, expected):
    for name in names:
        host.check_interrupt()
        component = _view(host).get(name)
        if component is None:
            continue
        _matches(name, component, expected[name])
        host.command(host.dcomp + ['rm-component', host.args.system, name])
        if name in _view(host):
            raise LaunchError(f'Component {name} is still present after removal')


def _jobs(host):
    return [job for root in (host.directory / 'runtime/environments').glob('*/jobs')
            for job in Queue(root.parent).list() if job['status'] in {'pending', 'running'}]


def _drain(host, journal):
    next_notice = next_check = 0
    while True:
        host.check_interrupt()
        jobs = _jobs(host)
        if not jobs:
            return
        now = time.monotonic()
        if now >= next_check:
            components = _view(host)
            if host.names['engine'] in components:
                raise LaunchError('The old workflow engine reappeared while draining jobs')
            names = [name for name in journal['originalComponents'] if name != host.names['engine']]
            host.check_components(components, names=names)
            if host.human:
                host.human.check()
            next_check = now + 2
        if now >= next_notice:
            host.say(f"Draining {len(jobs)} existing job(s) before upgrade: " + ', '.join(job['id'] for job in jobs))
            next_notice = now + 15
        host.interrupted.wait(POLL_SECONDS)


def _manifest_image(path):
    for line in path.read_text().splitlines():
        words = line.split()
        if len(words) == 2 and words[0] == 'docker' and words[1].startswith('sha256:'):
            return words[1]
    raise LaunchError(f'Upgrade requires a pinned image in {path}')


def _prepare(host, journal):
    environment = Path(host.record['environment_directory']).expanduser().resolve()
    if Environment(environment).name != host.record['environment']:
        raise LaunchError('The saved workflow requires the original environment name')
    # Keep private Human and saved connections. Ordinary resume deliberately
    # migrates an unattached private Human service to the shared service.
    links = dict(host.record['links'])
    human = links.pop('human', None)
    host.prepare_environment(environment, [f'{key}={value}' for key, value in links.items()], human_target=human)
    engine = journal['engineImage']
    write_text_atomic(host.directory / 'engine/component.dcomp',
        f'docker {engine}\noutput asys.workflow.v1.Workflow workflow\n')
    targets = {host.names['engine']: engine,
               host.names['workers']: _manifest_image(host.directory / 'environment/component.dcomp')}
    targets.update({world['name']: world['image'] for world in host.record.get('world_components', {}).values()})
    host.snapshot()
    _save(host, journal, 'prepared', targetImages=targets)


def _attach_human(host):
    if not getattr(host.args, 'human', False) or host.human:
        return
    if 'human' not in host.names:
        raise LaunchError('This workflow uses shared Human; attach with asys-human-prompt instead of --human')
    from .human import HumanHandler
    host.human = HumanHandler(host, host.names['human'])
    host.human.start(attach=True)


def _start(host, journal):
    targets = journal['targetImages']
    manifests = {host.names['engine']: host.directory / 'engine/component.dcomp',
                 host.names['workers']: host.directory / 'environment/component.dcomp'}
    manifests.update({world['name']: host.directory / world['directory'] / 'component.dcomp'
                      for world in host.record.get('world_components', {}).values()})
    if manifests.keys() != targets.keys() or any(_manifest_image(path) != targets[name]
                                               for name, path in manifests.items()):
        raise LaunchError('Prepared upgrade manifests changed; restore their pinned images before retrying')
    components = _view(host)
    for name, image in targets.items():
        if name in components:
            _matches(name, components[name], {'image': image})
    # Before recovery the new engine always awaits a command and all old queue
    # jobs are terminal. Recreating a partial start therefore cannot retry work.
    _remove(host, [host.names['engine'], *reversed([name for name in targets if name != host.names['engine']])],
            {name: {'image': image} for name, image in targets.items()})
    host.owned = [host.names['human']] if 'human' in host.names else []
    host.start_workers()
    host.record['engine_await_resume'] = True
    host.add('engine', 'engine', host.execution_mounts() + [
        '--bind', f"{host.directory / 'workflow'},/var/lib/asys-bpmn,rw",
        '--arg=--host-channel', '--arg=workflow', '--arg=--await-resume'])
    host.wait_ready()
    host.snapshot()
    _save(host, journal, 'recovering')


def _recover(host, journal):
    components = _view(host)
    for name, image in journal['targetImages'].items():
        if name not in components:
            raise LaunchError(f'Upgraded component {name} is missing; restore it before continuing recovery')
        _matches(name, components[name], {'image': image})
    host.owned = [*journal['targetImages'], *([host.names['human']] if 'human' in host.names else [])]
    host.check_components(components)
    state = host.reattach_request('status')
    if state['status'] not in TERMINAL and not state['active']:
        state = host.reattach_request('recover')
    if state['status'] not in TERMINAL and not state['active']:
        raise LaunchError('Upgraded engine has not recovered its saved workflow')
    # It may finish immediately, or have finished after a lost recovery reply.
    host.reattach_result = state.get('result')
    host.reattaching = True


def finish_upgrade(host):
    """Commit maintenance only after the replacement monitor is initialized."""
    if not getattr(host, 'upgrade_in_progress', False):
        return
    host.check_interrupt()
    journal = _journal(host.directory)
    if not journal or journal['phase'] != 'recovering':
        raise LaunchError('Upgrade has not reached workflow recovery')
    if journal.get('outcome') == 'finished during handover':
        host.say(f'Workflow {host.id} finished during handover; no replacement was needed')
    else:
        host.say(f'Replacement ready for workflow {host.id}; existing job IDs and outcomes are retained')
    _save(host, journal, 'complete', completedAt=timestamp(), error=None)
    host.upgrade_in_progress = False
    host.preserve_components = False


def prepare_upgrade(host):
    directory = Runs(state_root('runs', root=host.args.root)).select(host.args.run)
    if shared(directory):
        os.umask(0o007)
    _record(host, directory)
    guard = acquire_lock(directory / 'upgrade.lock')
    if guard is None:
        raise LaunchError('This run already has an upgrade command')
    journal = None
    try:
        journal = _journal(directory)
        if journal and journal['phase'] == 'complete':
            journal = None
        if not journal or journal['phase'] == 'requested':
            if host.record.get('status') in {'completed', 'cancelled'}:
                raise LaunchError(f"Cannot upgrade a {host.record['status']} workflow")
            for relative in ('workflow/workflow.sqlite', 'environment/component.dcomp', 'system-models.json'):
                if not (directory / relative).is_file():
                    raise LaunchError(f'Upgrade requires saved {relative}')
            if not Path(host.record['environment_directory']).is_dir():
                raise LaunchError('The saved environment directory is unavailable')
            if Environment(host.record['environment_directory']).name != host.record['environment']:
                raise LaunchError('The saved workflow requires the original environment name')
            if getattr(host.args, 'human', False) and 'human' not in host.names:
                raise LaunchError('This workflow uses shared Human; attach with asys-human-prompt instead of --human')
            _view(host)
        host.lease = _lease(directory)
        if host.lease is None:
            if host.record.get('upgrade_protocol') != PROTOCOL:
                raise LaunchError('The active launcher does not support upgrade handover; no components were changed')
            if journal and journal['phase'] != 'requested':
                raise LaunchError('Another launcher owns this interrupted upgrade')
            if journal is None:
                journal = {'version': PROTOCOL, 'id': uuid.uuid4().hex, 'runId': host.id,
                           'phase': 'requested', 'requestedAt': timestamp()}
                _save(host, journal)
            deadline = time.monotonic() + getattr(host, 'UPGRADE_HANDOVER_TIMEOUT', HANDOVER_TIMEOUT)
            while host.lease is None:
                host.check_interrupt()
                if time.monotonic() >= deadline:
                    raise LaunchError('The active launcher did not hand over; no components were changed')
                host.interrupted.wait(POLL_SECONDS)
                host.lease = _lease(directory)
            journal = _journal(directory)
        _record(host, directory)  # The previous owner may have published a result.
        if journal and journal['phase'] == 'requested' and host.record.get('status') in {'completed', 'cancelled'}:
            _save(host, journal, 'complete', completedAt=timestamp(), outcome='finished before handover')
            raise LaunchError(f"Cannot upgrade a {host.record['status']} workflow")
        if journal and (journal['phase'] != 'requested' or journal.get('handedOverAt')):
            # Once the old monitor yielded, a probe error must be recorded as
            # interrupted maintenance, even before any component is removed.
            host.upgrade_in_progress = host.preserve_components = host.save_record = True
        if not journal or journal['phase'] == 'requested':
            components = _view(host)
            missing = set(host.names.values()) - components.keys()
            if missing:
                raise LaunchError('Saved workflow components are missing; recover them before upgrading: ' + ', '.join(sorted(missing)))
            state = host.reattach_request('status')
            if state['status'] in TERMINAL:
                if journal and journal.get('handedOverAt'):
                    # Completion can race a cooperative handover. Let the new
                    # monitor consume that result; no replacement is needed.
                    host.owned = list(host.names.values())
                    host.reattach_result = state['result']
                    host.reattaching = True
                    _save(host, journal, 'recovering', outcome='finished during handover',
                          targetImages={name: _image(components[name]) for name in host.names.values()
                                        if name != host.names.get('human')})
                    return
                raise LaunchError(f"Cannot upgrade a {state['status']} workflow; ordinary --resume handles failed execution")
            if not state['active']:
                raise LaunchError('Workflow engine has no active execution; recover it before upgrading')
            engine_image = host.engine_image()
            journal = journal or {'version': PROTOCOL, 'id': uuid.uuid4().hex, 'runId': host.id,
                                  'requestedAt': timestamp()}
            _save(host, journal, 'owned', originalStatus=host.record.get('status'), engineImage=engine_image,
                  originalComponents={name: _identity(components[name]) for name in host.names.values()})
        host.upgrade_in_progress = True
        host.preserve_components = True
        host.save_record = True
        host.record['status'] = 'upgrading'
        host.record.pop('error', None)
        host.record.pop('finished_at', None)
        host.snapshot()
        _attach_human(host)
        if journal['phase'] == 'owned':
            _save(host, journal, 'stopping_engine')
        if journal['phase'] == 'stopping_engine':
            _remove(host, [host.names['engine']], journal['originalComponents'])
            _save(host, journal, 'draining')
        if journal['phase'] == 'draining':
            _drain(host, journal)
            _save(host, journal, 'replacing')
        if journal['phase'] == 'replacing':
            private_human = host.names.get('human')
            names = [name for name in journal['originalComponents'] if name != private_human]
            _remove(host, [host.names['engine'], *reversed([name for name in names if name != host.names['engine']])], journal['originalComponents'])
            _prepare(host, journal)
        if journal['phase'] == 'prepared':
            _save(host, journal, 'starting')
        if journal['phase'] == 'starting':
            _start(host, journal)
        if journal['phase'] == 'recovering':
            _recover(host, journal)
    except BaseException as error:
        # During requested, the old owner alone publishes acknowledgement.
        # Writing this caller's stale copy could erase a concurrent handover.
        if journal and journal['phase'] != 'requested':
            try:
                _save(host, journal, error=str(error) or type(error).__name__)
            except OSError as journal_error:
                host.say(f'Could not record upgrade failure: {journal_error}')
        raise
    finally:
        os.close(guard)
