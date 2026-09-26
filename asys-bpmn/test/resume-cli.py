"""Resume launcher boundary: ownership, saved configuration and channel history."""
import fcntl
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
runpy.run_path(str(ROOT.parent / "tools/asys-run"))
from asys.run import arguments
from asys.workflow import Launcher
from asys import workflow as workflow_module
module = vars(workflow_module)


class Resume(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="asys-resume-cli-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name) / "runs" / "abc123"
        for child in ["environment", "engine", "workflow", "workspace"]:
            (self.directory / child).mkdir(parents=True)
        (self.directory / "workflow/workflow.sqlite").touch()
        (self.directory / "environment/component.dcomp").write_text("docker sha256:saved-workers\n")
        self.record = {"id": "abc123", "name": "Example", "status": "failed", "error": "old failure",
                       "finished_at": "2026-09-14T10:00:00Z", "workflow": "/missing/workflow.bpmn",
                       "workspace": str(self.directory / "workspace"), "environment_directory": "/missing/environment", "environment": "test", "egress": True,
                       "system": "custom", "dcomp": ["dcomp", "--state-root", "/saved/dcomp"],
                       "links": {"inference": "@custom_provider"},
                       "components": {"engine": "example-workflow-abc123", "workers": "example-workers-abc123"}}
        self.path = self.directory / "run.json"
        self.path.write_text(json.dumps(self.record))
        args = arguments(["--root", self.temp.name, "--resume", "abc"])
        self.launcher = Launcher(args)
        self.addCleanup(self.launcher.close)
        self.source = self.source_environment()
        self.component = {"image_ref": "workers:current", "inputs": [
            {"service": "cyclo.provider.v1.Provider", "name": "inference"}], "outputs": []}
        self.globals = [{"name": "custom_provider"}]
        self.commands = []
        command = patch.object(self.launcher, "command", side_effect=self.command)
        command.start()
        self.addCleanup(command.stop)
        service = patch('asys.execution.ensure_human', side_effect=self.ensure_human)
        service.start()
        self.addCleanup(service.stop)

    def ensure_human(self, host):
        self.assertIs(host, self.launcher)
        if not any(item['name'] == 'human_endpoint' for item in self.globals):
            self.globals.append({'name': 'human_endpoint'})

    def command(self, command, **kwargs):
        self.commands.append(command)
        if command[-2:] == ["version", "--json"]:
            return json.dumps({"api_version": 2, "version": "0.3.2"})
        if command[:3] == ["docker", "build", "--iidfile"]:
            Path(command[3]).write_text("sha256:updated-workers")
            return ""
        if command[:3] == ["docker", "image", "inspect"]:
            return "sha256:updated-workers"
        self.fail(f"Unexpected command: {command}")

    def document(self, *command):
        if command[-1] == self.record["system"]:
            return {"components": [], "globals": self.globals}
        # dcomp parses the source manifest, independently of the saved digest.
        preview = Path(command[-1])
        self.assertIn("docker workers:current", (preview.parent / "environment/component.dcomp").read_text())
        return {"components": [deepcopy(self.component)]}

    def setup(self):
        with patch.object(self.launcher, "document", side_effect=self.document), \
                patch.object(self.launcher, "engine_image", return_value="sha256:new-engine"), \
                patch.object(self.launcher, "start_components"):
            self.launcher.setup()

    def test_resume_refreshes_images_and_keeps_saved_workflow_and_connections(self):
        self.setup()
        self.assertEqual(self.launcher.record["links"], {"inference": "@custom_provider"})
        self.assertEqual(self.launcher.dcomp, self.record["dcomp"])
        self.assertEqual(self.launcher.args.system, "custom")
        self.assertEqual((self.directory / "environment/component.dcomp").read_text(), "docker sha256:updated-workers\ninput cyclo.provider.v1.Provider inference\n")
        self.assertIn("sha256:new-engine", (self.directory / "engine/component.dcomp").read_text())

    def test_resume_keeps_connections_selected_by_the_original_shell(self):
        root = Path(self.temp.name)
        workflow = root / 'connections.bpmn'
        workflow.write_text('<definitions id="Connections"/>')
        original_state, original_runtime = root / 'original-dcomp', root / 'original-proxy'
        with patch.dict(os.environ, {'DCOMP_STATE_ROOT': str(original_state),
                                     'DCOMP_RUNTIME_ROOT': str(original_runtime)}):
            first = Launcher(arguments([str(self.source), str(workflow), '--root', str(root),
                                        '--workspace', str(root)]))
            def prepare(*args, **kwargs):
                first.record.update(environment='test', links={})
            with patch.object(first, 'prepare_environment', side_effect=prepare), \
                    patch.object(first, 'engine_image', return_value='sha256:engine'), \
                    patch.object(first, 'start_components'):
                first.setup()
            first.record['status'] = 'failed'
            first.snapshot()
            (first.directory / 'workflow/workflow.sqlite').touch()
            (first.directory / 'environment/component.dcomp').write_text('docker sha256:workers\n')
            first.close()
        saved = json.loads((first.directory / 'run.json').read_text())
        self.assertEqual(saved['dcomp'][1:], ['--state-root', str(original_state),
                                             '--runtime-root', str(original_runtime)])
        with patch.dict(os.environ, {'DCOMP_STATE_ROOT': str(root / 'other-dcomp'),
                                     'DCOMP_RUNTIME_ROOT': str(root / 'other-proxy')}):
            resumed = Launcher(arguments(['--resume', first.id, '--root', str(root)]))
            try:
                with patch.object(resumed, 'command', return_value=json.dumps({
                        'api_version': 2, 'components': [], 'globals': []})) as command, \
                        patch.object(resumed, 'engine_image', return_value='sha256:engine'), \
                        patch.object(resumed, 'refresh_environment'), \
                        patch.object(resumed, 'start_components'):
                    resumed.setup()
                self.assertEqual(resumed.dcomp, saved['dcomp'])
                self.assertEqual(command.call_args.args[0], saved['dcomp'] + ['view', '--json', 'asys'])
            finally:
                resumed.close()

    def test_resume_prepares_separate_world_and_preserves_binding_and_session_evidence(self):
        from asys.worker_definitions import definition_command
        package = self.source / 'worlds/search'
        (package / 'component').mkdir(parents=True)
        (package / 'component/component.dcomp').write_text('docker world:current\n')
        (package / 'view.mjs').write_text('export function mount() {}')
        (package / 'world.json').write_text(json.dumps({'version': 1,
            'component': 'component/component.dcomp', 'view': 'view.mjs'}))
        (self.source / 'workers').mkdir()
        (self.source / 'workers/search.json').write_text(json.dumps({'version': 1, 'kind': 'swarm',
            'config': {'version': 1, 'name': 'search', 'agents': {'count': 2, 'type': 'agent'},
                       'world': {'package': 'worlds/search'}}}))
        config = json.loads((self.source / 'workers.json').read_text())
        config['types']['search'] = {'command': definition_command('search')}
        (self.source / 'workers.json').write_text(json.dumps(config))
        def document(*args):
            if (Path(args[-1]).parent / 'world/component.dcomp').is_file():
                return {'components': [{'image_ref': 'world:current', 'inputs': [], 'outputs': []}]}
            return self.document(*args)
        with patch.object(self.launcher, 'document', side_effect=document), \
                patch.object(self.launcher, 'engine_image', return_value='sha256:new-engine'), \
                patch.object(self.launcher, 'start_components'):
            self.launcher.setup()
            path = self.directory / 'world-bindings.json'
            bindings = path.read_bytes()
            value = json.loads(bindings)['packages']['worlds/search']
            runtime = self.directory / 'runtime' / value['runtime']
            (runtime / 'session.json').write_text('preserved request/response evidence')
            (package / 'view.mjs').write_text('changed source view')
            self.launcher.refresh_environment()
        refreshed = json.loads(path.read_bytes())['packages']['worlds/search']
        self.assertEqual(refreshed['runtime'], value['runtime'])
        self.assertNotEqual(refreshed['view'], value['view'])
        self.assertEqual((runtime / 'session.json').read_text(), 'preserved request/response evidence')
        self.assertEqual(self.launcher.record['world_views']['search'],
                         {'directory': f"world-view-versions/{value['view']}", 'entry': 'view.mjs'})
        self.assertEqual((self.directory / f"world-view-versions/{value['view']}/view.mjs").read_text(),
                         'export function mount() {}')
        current = self.launcher.record['world_view_versions'][refreshed['view']]
        self.assertEqual((self.directory / current['directory'] / current['entry']).read_text(),
                         'changed source view')
        world = self.launcher.record['world_components']['worlds/search']
        self.assertEqual(self.launcher.names[world['role']], world['name'])

    def test_environment_rename_is_rejected_before_replacing_the_saved_image(self):
        config = json.loads((self.source / 'workers.json').read_text())
        config['name'] = 'other'
        (self.source / 'workers.json').write_text(json.dumps(config))
        with self.assertRaisesRegex(module['LaunchError'], 'original environment name'):
            self.setup()
        self.assertEqual((self.directory / 'environment/component.dcomp').read_text(), 'docker sha256:saved-workers\n')

    def test_private_human_adds_the_worker_input_without_changing_the_environment_source(self):
        self.launcher.args.human = True
        source = (self.source / 'component.dcomp').read_text()
        self.setup()
        self.assertEqual(self.launcher.record['links'], {
            'inference': '@custom_provider', 'human': 'example-human-abc123.human'})
        self.assertEqual(self.launcher.names['human'], 'example-human-abc123')
        self.assertEqual((self.directory / 'environment/component.dcomp').read_text(),
                         'docker sha256:updated-workers\ninput cyclo.provider.v1.Provider inference\n'
                         'input asys.human.v1.Human human\n')
        self.assertEqual((self.source / 'component.dcomp').read_text(), source)

    def test_builtin_human_worker_adds_its_input_and_uses_the_shared_endpoint(self):
        config = json.loads((self.source / 'workers.json').read_text())
        config['types']['approval'] = {'command': ['/opt/asys/asys-workers/tools/asys-human']}
        (self.source / 'workers.json').write_text(json.dumps(config))
        self.globals.append({'name': 'human_endpoint'})
        self.setup()
        self.assertNotIn('human', self.launcher.names)
        self.assertEqual(self.launcher.record['links']['human'], '@human_endpoint')
        self.assertIn('input asys.human.v1.Human human\n',
                      (self.directory / 'environment/component.dcomp').read_text())

    def test_builtin_human_worker_uses_an_input_when_the_source_declares_an_output(self):
        self.component['outputs'].append({'service': 'asys.human.v1.Human', 'name': 'human'})
        source = 'docker workers:current\noutput asys.human.v1.Human human\n'
        (self.source / 'component.dcomp').write_text(source)
        config = json.loads((self.source / 'workers.json').read_text())
        config['types']['approval'] = {'command': ['/opt/asys/asys-workers/tools/asys-human']}
        (self.source / 'workers.json').write_text(json.dumps(config))
        self.globals.append({'name': 'human_endpoint'})
        self.setup()
        manifest = (self.directory / 'environment/component.dcomp').read_text()
        self.assertIn('input asys.human.v1.Human human\n', manifest)
        self.assertNotIn('output asys.human.v1.Human human', manifest)
        self.assertEqual(self.launcher.record['links']['human'], '@human_endpoint')
        self.assertEqual((self.source / 'component.dcomp').read_text(), source)

    def test_builtin_human_worker_ensures_the_shared_service_before_starting_components(self):
        config = json.loads((self.source / 'workers.json').read_text())
        config['types']['approval'] = {'command': ['/opt/asys/asys-workers/tools/asys-human']}
        (self.source / 'workers.json').write_text(json.dumps(config))
        self.setup()
        self.assertEqual(self.launcher.record['links']['human'], '@human_endpoint')
        self.assertTrue(any(command[:2] == ['docker', 'build'] for command in self.commands))

    def test_private_human_reuses_a_declared_input_and_overrides_the_saved_global(self):
        self.component['inputs'].append({'service': 'asys.human.v1.Human', 'name': 'human'})
        self.record['links']['human'] = '@human_endpoint'
        self.path.write_text(json.dumps(self.record))
        self.launcher.args.human = True
        self.setup()
        self.assertEqual(self.launcher.record['links']['human'], 'example-human-abc123.human')
        self.assertEqual((self.directory / 'environment/component.dcomp').read_text().count(
            'input asys.human.v1.Human human'), 1)

    def test_resuming_without_private_human_reconnects_to_the_shared_endpoint(self):
        self.record['components']['human'] = 'example-human-abc123'
        self.record['links']['human'] = 'example-human-abc123.human'
        self.path.write_text(json.dumps(self.record))
        self.globals.append({'name': 'human_endpoint'})
        self.setup()
        self.assertNotIn('human', self.launcher.names)
        self.assertEqual(self.launcher.record['links']['human'], '@human_endpoint')
        self.assertIn('input asys.human.v1.Human human\n',
                      (self.directory / 'environment/component.dcomp').read_text())

    def test_resume_keeps_a_saved_human_connection_when_the_source_has_no_input(self):
        self.record['links']['human'] = '@human_endpoint'
        self.path.write_text(json.dumps(self.record))
        self.globals.append({'name': 'human_endpoint'})
        self.setup()
        self.assertEqual(self.launcher.record['links']['human'], '@human_endpoint')
        self.assertIn('input asys.human.v1.Human human\n',
                      (self.directory / 'environment/component.dcomp').read_text())

    def test_private_human_rejects_a_conflicting_service_before_building(self):
        self.component['inputs'].append({'service': 'other.Service', 'name': 'human'})
        self.launcher.args.human = True
        with self.assertRaisesRegex(module['LaunchError'], 'human.*other.Service.*asys.human.v1.Human'):
            self.setup()
        self.assertFalse(any(command[:2] == ['docker', 'build'] for command in self.commands))

    def test_private_human_uses_a_worker_input_even_if_an_output_was_declared(self):
        self.component['outputs'].append({'service': 'asys.human.v1.Human', 'name': 'human'})
        self.launcher.args.human = True
        self.setup()
        manifest = (self.directory / 'environment/component.dcomp').read_text()
        self.assertIn('input asys.human.v1.Human human\n', manifest)
        self.assertNotIn('output asys.human.v1.Human human', manifest)
        self.assertEqual(self.launcher.record['links']['human'], 'example-human-abc123.human')

    def test_private_human_rejects_an_output_with_a_different_service(self):
        self.component['outputs'].append({'service': 'other.Service', 'name': 'human'})
        self.launcher.args.human = True
        with self.assertRaisesRegex(module['LaunchError'], 'human.*other.Service.*asys.human.v1.Human'):
            self.setup()
        self.assertFalse(any(command[:2] == ['docker', 'build'] for command in self.commands))

    def test_missing_connections_fail_without_reading_logs_or_starting_components(self):
        del self.record["links"]
        self.path.write_text(json.dumps(self.record))
        with patch.object(self.launcher, "document") as document, \
                self.assertRaisesRegex(module["LaunchError"], "no saved environment connections"):
            self.launcher.setup()
        document.assert_not_called()
        self.launcher.close()
        self.assertEqual(json.loads(self.path.read_text()), self.record)
        self.assertEqual(self.launcher.owned, [])

    def source_environment(self):
        source = Path(self.temp.name) / "source environment"
        source.mkdir(exist_ok=True)
        config = {"version": 1, "name": "test", "types": {"agent": {"command": ["agent"]}}}
        (source / "workers.json").write_text(json.dumps(config))
        (source / "Dockerfile").write_text("FROM asys-workers:dev\n")
        (source / "component.dcomp").write_text("docker workers:current\n")
        definition = hashlib.sha256(json.dumps(config, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        descriptor = self.directory / "runtime/environments/test/environment.json"
        descriptor.parent.mkdir(parents=True, exist_ok=True)
        descriptor.write_text(json.dumps({"definition": definition}))
        self.record["environment_directory"] = str(source)
        self.path.write_text(json.dumps(self.record))
        return source

    def test_automatic_rebuild_updates_the_saved_image_only_after_build_success(self):
        source = self.source_environment()
        manifest = self.directory / "environment/component.dcomp"

        def build(command, **kwargs):
            if command[-2:] == ["version", "--json"]:
                return json.dumps({"api_version": 2, "version": "0.3.2"})
            self.assertEqual(command[:3], ["docker", "build", "--iidfile"])
            self.assertEqual(command[-1], str(source))
            self.assertEqual(manifest.read_text(), "docker sha256:saved-workers\n")
            Path(command[3]).write_text("sha256:updated-workers")
            return ""

        with patch.object(self.launcher, "command", side_effect=build):
            self.setup()
        self.assertEqual(manifest.read_text(), "docker sha256:updated-workers\ninput cyclo.provider.v1.Provider inference\n")

    def test_failed_rebuild_does_not_replace_the_saved_image(self):
        self.source_environment()
        before = (self.directory / "environment/component.dcomp").read_text()
        with patch.object(self.launcher, "command", side_effect=module["LaunchError"]("build failed")), \
                self.assertRaisesRegex(module["LaunchError"], "build failed"):
            self.setup()
        self.assertEqual((self.directory / "environment/component.dcomp").read_text(), before)

    def test_rebuild_requires_source_and_valid_worker_configuration(self):
        self.record["environment_directory"] = str(Path(self.temp.name) / "missing")
        self.path.write_text(json.dumps(self.record))
        with self.assertRaisesRegex(module["LaunchError"], "environment source"):
            self.setup()
        self.launcher.close()
        source = self.source_environment()
        (source / "workers.json").write_text(json.dumps({"version": 1, "name": "other", "types": {}}))
        with self.assertRaisesRegex(ValueError, "needs at least one job type"):
            self.setup()
        self.assertEqual((self.directory / "environment/component.dcomp").read_text(), "docker sha256:saved-workers\n")

    def test_image_only_environment_resolves_current_tag_on_every_resume(self):
        (self.source / "Dockerfile").unlink()
        self.setup()
        self.assertEqual([command for command in self.commands if command[0] == "docker"], [["docker", "image", "inspect", "--format", "{{.Id}}", "workers:current"]])
        self.assertEqual((self.directory / "environment/component.dcomp").read_text(), "docker sha256:updated-workers\ninput cyclo.provider.v1.Provider inference\n")

    def test_active_launcher_cannot_be_resumed_or_have_its_record_changed(self):
        with (self.directory / "launcher.lock").open("a+b") as lease:
            fcntl.flock(lease, fcntl.LOCK_EX)
            with self.assertRaisesRegex(module["LaunchError"], "active launcher"):
                self.launcher.setup()
        self.assertEqual(json.loads(self.path.read_text()), self.record)

    def test_existing_components_are_not_adopted_or_removed(self):
        before = self.path.read_text()
        with patch.object(self.launcher, "document", return_value={"components": [{"name": self.record["components"]["engine"]}]}):
            with self.assertRaisesRegex(module["LaunchError"], "cleanup"):
                self.launcher.setup()
        self.launcher.close()
        self.assertEqual(self.path.read_text(), before)
        self.assertEqual(self.launcher.owned, [])

    def test_resume_reattaches_live_components_and_consumes_queued_completion_without_new_jobs(self):
        self.record['world_components'] = {'worlds/routing': {'name': 'example-world-abc123', 'role': 'world-routing'}}
        self.record['channel_after'] = 0
        self.path.write_text(json.dumps(self.record))
        names = [*self.record['components'].values(), 'example-world-abc123']
        components = [{'name': name, 'status': {'status': 'running', 'health': 'healthy'}} for name in names]
        with patch.object(self.launcher, 'document', return_value={'components': components}), \
                patch.object(self.launcher, 'start_components') as start, \
                patch.object(self.launcher, 'refresh_environment') as refresh:
            self.launcher.setup()
        start.assert_not_called()
        refresh.assert_not_called()
        self.assertTrue(self.launcher.reattaching)
        self.assertEqual(self.launcher.owned, ['example-world-abc123',
                                              'example-workers-abc123', 'example-workflow-abc123'])
        writer = module['Writer'](self.directory / 'runtime/channels/workflow/out')
        event = writer.send('activity.start', {'store': 1, 'runId': 'abc123', 'activityId': 'work',
                            'time': '2026-09-14T10:01:00Z', 'data': {'name': 'Work'}})
        module['Reader'](writer.directory).advance(event['sequence'])
        writer.send('run.result', {'runId': 'abc123', 'status': 'completed', 'output': {'work': 42}})
        with patch.object(module['Writer'], 'send') as send:
            self.launcher.execute()
        send.assert_not_called()
        self.launcher.snapshot()
        record = json.loads(self.path.read_text())
        self.assertEqual(record['status'], 'completed')
        self.assertEqual(record['channel_after'], 0)
        self.assertNotIn('error', record)
        self.assertIn('reattached_at', record)
        # Release test ownership without making a live cleanup call.
        self.launcher.owned = []

    def test_resume_does_not_adopt_unhealthy_or_partially_missing_execution(self):
        for kind in ['unhealthy', 'missing world', 'pending operation']:
            with self.subTest(kind=kind):
                components = [{'name': name, 'status': {'status': 'running', 'health': 'healthy'}}
                              for name in self.record['components'].values()]
                document = {'components': components}
                if kind == 'unhealthy':
                    components[0]['status']['health'] = 'unhealthy'
                elif kind == 'missing world':
                    self.record['world_components'] = {'worlds/world': {'name': 'missing-world', 'role': 'world-test'}}
                    self.path.write_text(json.dumps(self.record))
                else:
                    document['operation'] = {'kind': 'apply'}
                with patch.object(self.launcher, 'document', return_value=document), \
                        self.assertRaises(module['LaunchError']):
                    self.launcher.setup()
                self.assertEqual(self.launcher.owned, [])
                self.launcher.close()

    def test_resume_skips_old_result_and_appends_new_events(self):
        self.setup()
        channel = self.directory / "runtime/channels/workflow"
        writer = module["Writer"](channel / "out")
        writer.send("run.result", {"runId": "abc123", "status": "failed", "error": "old failure"})
        original_send = module["Writer"].send

        def send(instance, kind, data):
            event = original_send(instance, kind, data)
            if kind == "resume":
                original_send(writer, "accepted", {"request": event["sequence"], "runId": "abc123", "workflowId": "saved"})
                original_send(writer, "run.recovered", {"store": 3, "runId": "abc123", "activityId": "", "time": "2026-09-14T10:01:00Z", "data": {}})
                original_send(writer, "run.result", {"runId": "abc123", "status": "completed", "output": {"work": 42}, "workflowId": "saved"})
            return event

        with patch.object(module["Writer"], "send", send):
            self.launcher.execute()
        self.launcher.snapshot()
        record = json.loads(self.path.read_text())
        self.assertEqual(record["channel_after"], 1)
        self.assertEqual(record["status"], "completed")
        self.assertNotIn("error", record)
        request, = module["Reader"](channel / "in").read(0)
        self.assertEqual((request["type"], request["data"]), ("resume", {"id": "abc123"}))
        self.assertIn("RUN RESUMED", (self.directory / "run.log").read_text())
        result = json.loads((self.directory / "result.json").read_text())
        self.assertEqual(result, {"runId": "abc123", "status": "completed", "output": {"work": 42}, "workflowId": "saved"})

    def test_component_failure_cleanup_does_not_cancel_the_workflow(self):
        self.setup()
        self.launcher.active = True
        self.launcher.save_record = True
        self.launcher.outbound = module['Reader'](self.directory / 'runtime/channels/workflow/out')
        with patch.object(self.launcher, 'cleanup_components', return_value=True), \
                patch.object(module['Writer'], 'send') as send:
            self.launcher.close()
        send.assert_not_called()
        self.assertEqual(json.loads(self.path.read_text())['status'], 'failed')

    def test_resume_starts_engine_without_recovering_old_jobs_before_the_resume_request(self):
        self.setup()
        with patch.object(self.launcher, 'start_workers'), patch.object(self.launcher, 'add') as add, \
                patch.object(self.launcher, 'wait_ready'):
            self.launcher.start_components()
        self.assertIn('--arg=--await-resume', add.call_args.args[2])


if __name__ == "__main__":
    unittest.main()
