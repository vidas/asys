"""Real engine/runtime upgrade regressions; Docker lifecycle is isolated in-process.

Run with NODE pointing at Node 22.19+ and the checkout's Node dependencies installed:
    python3 asys-bpmn/test/upgrade-cli.py
No Docker daemon, provider, model or shared state is used.
"""
import fcntl
import json
import os
from pathlib import Path
import runpy
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
runpy.run_path(str(ROOT / 'tools/asys-run'))
from asys.run import arguments
from asys.workflow import Launcher
from asys_runtime.channel import Reader, Writer, direction_root
from asys_runtime.files import write_json
sys.path.insert(0, str(ROOT / 'test-support'))
from release_fixture import use_fixture_release

NODE = os.environ.get('NODE') or shutil.which('node')
OLD = 'sha256:' + '1' * 64
NEW = 'sha256:' + '2' * 64

WORKER = r'''
import json, os, pathlib, signal, time
request = json.loads(pathlib.Path(os.environ['ASYS_REQUEST']).read_text())
activity = request['metadata']['activity_id']
job = os.environ['ASYS_JOB_ID']
with open('executions.jsonl', 'a') as log:
    log.write(json.dumps({'job':job, 'activity':activity}) + '\n')
def cancel(*_):
    with open('cancelled', 'a') as log: log.write(job + '\n')
    raise SystemExit(99)
signal.signal(signal.SIGTERM, cancel)
if activity == 'long':
    while not pathlib.Path('release').exists(): time.sleep(0.02)
    if pathlib.Path('fail').exists():
        pathlib.Path(os.environ['ASYS_RESULT']).write_text(json.dumps({'exception':'draining job failed'}))
        raise SystemExit(17)
    result = {'answer':42, 'job':job}
else:
    result = {'activity':activity, 'input':json.loads(pathlib.Path(os.environ['ASYS_INPUT']).read_text())}
pathlib.Path(os.environ['ASYS_RESULT']).write_text(json.dumps(result))
'''

ENGINE = r'''
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [source, root, ready, mode] = process.argv.slice(2);
const { AsyncStore } = await import(pathToFileURL(join(source, 'asys-bpmn/src/async-store.mjs')));
const { WorkflowRuntime } = await import(pathToFileURL(join(source, 'asys-bpmn/src/runtime.mjs')));
const { Environments } = await import(pathToFileURL(join(source, 'asys-runtime/javascript/environments.mjs')));
const { serveHostChannel } = await import(pathToFileURL(join(source, 'asys-bpmn/src/host-channel.mjs')));
const runtime = new WorkflowRuntime({store:new AsyncStore(join(root, 'workflow')),
  environments:new Environments(join(root, 'runtime'))});
const controller = new AbortController();
let stopped;
const stop = new Promise(resolve => { stopped = resolve; });
for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => {
  controller.abort(new Error('fixture component stopped')); stopped();
});
if (mode !== 'await-resume') await runtime.recover();
const serving = serveHostChannel(runtime, {root:join(root,'runtime'), signal:controller.signal});
await writeFile(ready, String(process.pid));
try { await Promise.race([stop, serving]); }
finally { controller.abort(); await serving; await runtime.close(); }
'''


def workflow():
    binding = '<bpmn:extensionElements><asys:job type="program"/></bpmn:extensionElements>'
    return f'''<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
      xmlns:asys="urn:asys:workflow:1" id="Upgrade" targetNamespace="urn:asys:test">
      <bpmn:process id="test" isExecutable="true">
        <bpmn:startEvent id="start"/>
        <bpmn:task id="long">{binding}</bpmn:task>
        <bpmn:task id="after"><bpmn:extensionElements><asys:job type="program" input="= {{previous: long}}"/></bpmn:extensionElements></bpmn:task>
        <bpmn:boundaryEvent id="failure" attachedToRef="long"><bpmn:errorEventDefinition/></bpmn:boundaryEvent>
        <bpmn:task id="repair"><bpmn:extensionElements><asys:job type="program" input="= {{previous: long}}"/></bpmn:extensionElements></bpmn:task>
        <bpmn:endEvent id="done"/>
        <bpmn:sequenceFlow id="begin" sourceRef="start" targetRef="long"/>
        <bpmn:sequenceFlow id="success" sourceRef="long" targetRef="after"/>
        <bpmn:sequenceFlow id="failure_route" sourceRef="failure" targetRef="repair"/>
        <bpmn:sequenceFlow id="finish" sourceRef="after" targetRef="done"/>
        <bpmn:sequenceFlow id="repaired" sourceRef="repair" targetRef="done"/>
      </bpmn:process></bpmn:definitions>'''


def until(predicate, message, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.03)
    raise AssertionError(message)


class Task:
    def __init__(self, action):
        self.error = None
        self.done = threading.Event()
        def run():
            try:
                action()
            except BaseException as error:
                self.error = error
            finally:
                self.done.set()
        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()

    def finish(self):
        if not self.done.wait(30):
            raise AssertionError('Fixture launcher did not finish')
        if self.error:
            raise self.error


class LocalComponents:
    """Only infrastructure operations are replaced; jobs and BPMN are real."""
    def __init__(self, case):
        self.case = case
        self.temp = tempfile.TemporaryDirectory(prefix='asys-upgrade-integration-')
        self.root = Path(self.temp.name)
        self.id = 'upgrade-run'
        self.directory = self.root / 'runs' / self.id
        self.workspace = self.root / 'workspace'
        self.environment = self.root / 'env'
        for path in [self.workspace, self.environment, *[self.directory / p for p in ['jobs','runtime','workflow','environment','engine']]]:
            path.mkdir(parents=True, exist_ok=True)
        (self.directory / 'workspace').symlink_to(self.workspace, target_is_directory=True)
        self.worker = self.root / 'worker.py'
        self.worker.write_text(WORKER)
        self.engine_script = self.root / 'engine.mjs'
        self.engine_script.write_text(ENGINE)
        write_json(self.environment / 'workers.json', {'version':1,'name':'fixture',
            'types':{'program':{'command':[sys.executable,str(self.worker)]}}})
        (self.environment / 'component.dcomp').write_text('docker fixture-workers:current\n')
        (self.directory / 'environment/component.dcomp').write_text(f'docker {OLD}\n')
        (self.directory / 'engine/component.dcomp').write_text(f'docker {OLD}\noutput asys.workflow.v1.Workflow workflow\n')
        self.xml = workflow()
        self.definition = self.root / 'workflow.bpmn'
        self.definition.write_text(self.xml)
        (self.directory / 'workflow/workflow.bpmn').write_text(self.xml)
        self.names = {'engine':'fixture-engine','workers':'fixture-workers'}
        self.record = {'id':self.id,'manager':'run','kind':'workflow','name':'Upgrade fixture',
            'created_at':'2026-09-27T00:00:00Z','status':'running','upgrade_protocol':1,
            'workflow':str(self.definition),'environment_directory':str(self.environment),'environment':'fixture',
            'workspace':str(self.workspace),'system':'fixture','components':self.names,
            'dcomp':['fixture-dcomp','--state-root',str(self.root/'dcomp')], 'links':{},
            'channel':str(self.directory/'runtime/channels/workflow'),'channel_after':0}
        write_json(self.directory / 'run.json', self.record)
        self.processes = {}
        self.images = {}
        self.files = []
        self.commands = []
        self.generation = 0
        self.removed_engine = threading.Event()
        self.launchers = []
        self.tasks = []
        self.unrelated = {'name':'shared-provider', 'image_id':OLD,
                          'status':{'status':'running','health':'healthy','container_id':'untouched'}}
        # Register cleanup before starting either process: a setup failure must
        # not leave an isolated runtime behind.
        case.addCleanup(self.close)
        write_json(self.directory / 'system-models.json', {'simple':'saved-account/saved-model'})
        self.saved_models = (self.directory/'system-models.json').read_bytes()
        write_json(self.root/'config.json', {'system_models':{'simple':'new-account/different-model'}})
        self.start_workers(OLD)
        self.start_engine(OLD, await_resume=False)
        self.original_pids = {role: process.pid for role, process in self.processes.items()}
        self.reader = Reader(direction_root(self.directory/'runtime','workflow','out'))
        self.writer = Writer(direction_root(self.directory/'runtime','workflow','in'))
        self.writer.send('start', {'id':self.id,'bpmnXml':self.xml,'environment':'fixture','variables':{'original':'retained'}})
        self.long_job = until(lambda: next((j for j in self.jobs() if j.get('status')=='running'), None),
                              'Initial real job did not start')['id']
        until(lambda:(self.workspace/'executions.jsonl').exists(), 'Worker did not execute')

    def spawn(self, name, command):
        log = (self.root / f'{name}-{self.generation}.log').open('w')
        self.files.append(log)
        process = subprocess.Popen(command, cwd=self.root, stdout=log, stderr=subprocess.STDOUT,
                                   env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1'})
        self.processes[name] = process
        return process

    def start_workers(self, image):
        self.spawn('workers', [sys.executable,str(ROOT/'asys-runtime/tools/asys-runtime'),'run',
                              str(self.environment),'--root',str(self.directory/'runtime')])
        self.images[self.names['workers']] = image
        until(lambda:(self.directory/'runtime/environments/fixture/environment.json').exists(),
              'Python runtime did not register')

    def start_engine(self, image, *, await_resume):
        self.generation += 1
        ready = self.root / f'engine-{self.generation}.ready'
        process = self.spawn('engine', [NODE,str(self.engine_script),str(ROOT),str(self.directory),str(ready),
                                        'await-resume' if await_resume else 'recover'])
        def started():
            if process.poll() is not None:
                raise AssertionError((self.root/f'engine-{self.generation}.log').read_text())
            return ready.exists()
        until(started, 'Real BPMN engine did not start')
        self.images[self.names['engine']] = image

    def stop(self, role):
        process = self.processes.pop(role, None)
        if process is not None and process.poll() is None:
            process.terminate()
            process.wait(timeout=15)
        self.images.pop(self.names[role], None)
        if role == 'engine':
            self.removed_engine.set()

    def jobs(self):
        return [json.loads(path.read_text()) for path in
                (self.directory/'runtime/environments/fixture/jobs').glob('*/state.json')]

    def observation(self):
        components = [self.unrelated.copy()]
        for role, process in self.processes.items():
            name = self.names[role]
            components.append({'name':name,'image_id':self.images[name],'image_ref':self.images[name],
                'runtime':{},'inputs':[],'outputs':[],
                'status':{'container_id':f'{role}-{process.pid}','status':'running' if process.poll() is None else 'exited',
                          'health':'healthy','exit_code':0,'problem':''}})
        return {'api_version':2,'components':components,'globals':[]}

    def command(self, command, **kwargs):
        self.commands.append(command)
        if command[:3] == ['docker','image','inspect']:
            return NEW
        if command[-2:] == ['version','--json']:
            return json.dumps({'api_version':2,'version':'0.3.2'})
        if 'view' in command:
            if command[-1] == 'fixture':
                return json.dumps(self.observation())
            return json.dumps({'api_version':2,'components':[{'name':'environment','image_ref':'fixture-workers:current',
                'image_id':NEW,'inputs':[],'outputs':[],'runtime':{}}]})
        if 'rm-component' in command:
            name = command[-1]
            self.case.assertNotEqual(name, self.unrelated['name'])
            role = next(role for role,value in self.names.items() if value == name)
            if role == 'workers':
                self.case.assertFalse(any(j['status'] in {'pending','running'} for j in self.jobs()),
                                      'Upgrade removed workers before draining their real jobs')
            self.stop(role)
            return ''
        if 'add-component' in command:
            name = command[-2]
            role = next(role for role,value in self.names.items() if value == name)
            image = (Path(command[-1])/'component.dcomp').read_text().splitlines()[0].split()[1]
            if role == 'workers':
                self.start_workers(image)
            else:
                self.case.assertIn('--arg=--await-resume', command)
                self.start_engine(image, await_resume=True)
            return ''
        if 'logs' in command:
            return 'Fixture component log retained\n'
        raise AssertionError(f'Unexpected infrastructure command: {command}')

    def launcher(self, upgrade=True):
        args = arguments(['--root',str(self.root),'--upgrade',self.id] if upgrade else
                         [str(self.environment),str(self.definition),'--root',str(self.root)])
        fixture = self
        class FixtureLauncher(Launcher):
            def command(self, command, **kwargs):
                return fixture.command(command, **kwargs)
            def say(self, message):
                # Keep diagnostics available without flooding the test runner.
                with (fixture.root/'launcher.log').open('a') as log:
                    print(message, file=log)
        host = FixtureLauncher(args)
        self.launchers.append(host)
        return host

    def events(self):
        database = self.directory/'workflow/workflow.sqlite'
        with sqlite3.connect(database.as_uri()+'?mode=ro',uri=True) as connection:
            return connection.execute('SELECT type,activity_id,data FROM events ORDER BY sequence').fetchall()

    def task(self, action):
        task = Task(action)
        self.tasks.append(task)
        return task

    def close(self):
        (self.workspace/'release').touch()
        for host in self.launchers:
            host.interrupted.set()
        for task in self.tasks:
            task.thread.join(timeout=5)
        for role in ['engine','workers']:
            self.stop(role)
        for host in self.launchers:
            if host.lease is not None:
                host.lease.close()
        for stream in self.files:
            stream.close()
        self.temp.cleanup()


class UpgradeIntegration(unittest.TestCase):
    def fixture(self):
        self.assertIsNotNone(NODE, 'Node 22.19+ is required for actual BPMN integration tests')
        fixture = LocalComponents(self)
        use_fixture_release(self, fixture.root, NEW)
        return fixture

    def upgrade_draining(self, *, failing=False, active_owner=False):
        fixture = self.fixture()
        if failing:
            (fixture.workspace/'fail').touch()
        owner_task = None
        if active_owner:
            owner = fixture.launcher(upgrade=False)
            owner.directory, owner.id, owner.names = fixture.directory, fixture.id, dict(fixture.names)
            owner.record = json.loads((fixture.directory/'run.json').read_text())
            owner.args.system = 'fixture'
            owner.dcomp = list(owner.record['dcomp'])
            owner.owned = list(fixture.names.values())
            owner.reattaching = True
            owner.save_record = True
            owner.lease = (fixture.directory/'launcher.lock').open('a+b')
            fcntl.flock(owner.lease,fcntl.LOCK_EX|fcntl.LOCK_NB)
            def monitor():
                from asys.upgrade import UpgradeHandover
                try:
                    owner.execute()
                except UpgradeHandover:
                    pass
                finally:
                    owner.close()
            owner_task = fixture.task(monitor)
            until(lambda:owner.active, 'Original launcher did not become active')
        upgraded = fixture.launcher()
        setup = fixture.task(upgraded.setup)
        def stopped_engine():
            if setup.error:
                raise setup.error
            return fixture.removed_engine.is_set()
        until(stopped_engine, 'Upgrade did not stop engine scheduling')
        self.assertFalse(setup.done.is_set(), 'Upgrade must wait for the running job')
        self.assertEqual([job['id'] for job in fixture.jobs()], [fixture.long_job])
        self.assertEqual(fixture.jobs()[0]['status'],'running')
        self.assertIsNone(fixture.processes['workers'].poll())
        self.assertEqual(fixture.processes['workers'].pid, fixture.original_pids['workers'])
        self.assertFalse((fixture.workspace/'cancelled').exists())
        if owner_task:
            owner_task.finish()
        (fixture.workspace/'release').touch()
        setup.finish()
        self.assertTrue(upgraded.reattaching)
        self.assertEqual(json.loads((fixture.directory/'upgrade.json').read_text())['phase'], 'recovering')
        self.assertEqual((fixture.directory/'system-models.json').read_bytes(), fixture.saved_models)
        self.assertEqual(fixture.images, {name:NEW for name in fixture.names.values()})
        for role, process in fixture.processes.items():
            self.assertNotEqual(process.pid, fixture.original_pids[role])
        execution = fixture.task(upgraded.execute)
        execution.finish()
        self.assertEqual(json.loads((fixture.directory/'upgrade.json').read_text())['phase'], 'complete')
        self.assertEqual(upgraded.record['status'],'completed')
        jobs = fixture.jobs()
        executions = [json.loads(line) for line in (fixture.workspace/'executions.jsonl').read_text().splitlines()]
        self.assertEqual(len(jobs),2)
        self.assertEqual(len(executions),2)
        self.assertEqual(executions[0], {'job':fixture.long_job,'activity':'long'})
        self.assertEqual(executions[1]['activity'],'repair' if failing else 'after')
        self.assertEqual(next(j for j in jobs if j['id']==fixture.long_job)['status'],'failed' if failing else 'done')
        events = fixture.events()
        self.assertEqual(sum(kind=='job.created' and activity=='long' for kind,activity,_ in events),1)
        self.assertEqual(sum(kind==('job.failed' if failing else 'job.completed') and activity=='long'
                             for kind,activity,_ in events),1)
        self.assertEqual(sum(kind=='run.completed' for kind,_,_ in events),1)
        inbound = Reader(direction_root(fixture.directory/'runtime','workflow','in'))
        requests = [event['type'] for event in inbound.read(0)]
        self.assertIn('recover',requests)
        self.assertNotIn('resume',requests)
        self.assertNotIn('cancel',requests)
        self.assertFalse((fixture.workspace/'cancelled').exists())
        final = json.loads((fixture.directory/'result.json').read_text())
        self.assertEqual(final['variables']['original'], 'retained')
        selected = final['output']['repair' if failing else 'after']['input']['previous']
        if failing:
            self.assertEqual(selected['exception'],'draining job failed')
        else:
            self.assertEqual(selected,{'answer':42,'job':fixture.long_job})
        self.assertFalse(any('shared-provider' in command for command in fixture.commands))

    def test_upgrade_drains_running_job_and_recovers_same_id_and_result_once(self):
        self.upgrade_draining()

    def test_failed_draining_job_takes_boundary_route_without_replacement(self):
        self.upgrade_draining(failing=True)

    def test_active_launcher_hands_over_without_cancelling_job(self):
        self.upgrade_draining(active_owner=True)


if __name__ == '__main__':
    unittest.main()
