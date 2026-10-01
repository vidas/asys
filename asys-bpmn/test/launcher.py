"""Host launcher scenarios inside the integration test's existing dcomp system."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys

from asys_runtime.release import build_contexts


def check_launcher(root, dcomp, system, temp, run, until, log, agent_environment, tags, dummy_environment):
    before = {item['name']: item['status']['container_id'] for item in
              json.loads(run(dcomp, 'view', '--json', system))['components']}
    project = temp / 'project with spaces'
    project.mkdir()
    environment = project / 'worker directory'
    shutil.copytree(root / 'examples/hello/env/dummy', environment)
    configuration = json.loads((environment / 'workers.json').read_text())
    configuration['name'] = 'simulation'
    (environment / 'workers.json').write_text(json.dumps(configuration))
    workflow_file = project / 'workflow.bpmn'
    portable = (root / 'examples/agent-task.bpmn').read_text()
    # Program and model implementations share the example's request contract.
    workflow_file.write_text(portable)
    inputs = project / 'design brief.md'
    request = '# Design brief\n\nKeep spaces, --flags, `code`, and $literal text.\nUse a 30×20 mm board.\n'
    inputs.write_text(request, encoding='utf-8')
    launcher = [sys.executable, str(root.parent / 'tools/asys-run')]
    observer = [sys.executable, str(root.parent / 'tools/asys')]
    cli_root = temp / 'launcher state'
    common = ['--root', str(cli_root), '--system', system, '--dcomp-state-root', str(temp / 'dcomp'),
              '--workspace', str(project)]
    previous_binary = os.environ.get('DCOMP_BINARY')
    os.environ['DCOMP_BINARY'] = dcomp[0]
    try:
        example = json.loads(run(launcher, 'env/dummy', 'workflow.bpmn', *common,
                                 cwd=root / 'examples/hello'))
        assert example['greet']['message'] == 'Hello from asys.', example
        hello_run = max(cli_root.glob('runs/*/run.json'), key=lambda path: path.stat().st_mtime)
        saved_hello = json.loads(hello_run.read_text())
        assert saved_hello['components'] == {'engine': f"hello-workflow-{saved_hello['id'][:16]}",
                                            'workers': f"hello-workers-{saved_hello['id'][:16]}"}, saved_hello
        workflow_log = run(observer, 'logs', str(hello_run.parent))
        assert 'STARTED' in workflow_log and 'FINISHED' in workflow_log and 'greet' in workflow_log, workflow_log
        assert (hello_run.parent / 'run.log').is_file()
        assert 'RUN COMPLETED' in workflow_log and '[stdout]' not in workflow_log, workflow_log
        print('PASS: hello/workflow.bpmn with its own hello/env/dummy -> Hello from asys.', flush=True)
        example = json.loads(run(launcher, 'env/dummy', 'workflow.yaml', *common, cwd=root / 'examples/hello'))
        assert example == {'message': 'Hello from asys.'}, example
        yaml_run = max(cli_root.glob('runs/*/run.json'), key=lambda path: path.stat().st_mtime)
        saved = json.loads((yaml_run.parent / 'workflow/workflow.json').read_text())
        assert saved['root'] == 'workflow.yaml' and saved['files']['workflow.yaml']['data']['steps']['greet']['run'] == 'greet', saved
        assert 'greet' in run(observer, 'logs', str(yaml_run.parent))
        print('PASS: hello/workflow.yaml runs on the workflow/1 engine with the saved resolved document', flush=True)
        output = json.loads(run(launcher, 'env/dummy', 'workflow.bpmn', '--input', 'request.md', *common,
                                   cwd=root / 'examples/shared-workspace'))
        assert output['assemble'] == {'report': 'First section\nSecond section\n', 'sections': 2}, output
        assert (project / 'project/report.txt').read_text() == 'First section\nSecond section\n'
        assert (project / 'project/request.md').read_text() == (root / 'examples/shared-workspace/request.md').read_text()
        print('PASS: parallel writers and their join work in the supplied project directory', flush=True)
        output = json.loads(run(launcher, str(environment), str(workflow_file), '--input', str(inputs), *common))
        assert output['work'] == {'final': request, 'exception': None}, output
        hello = (root / 'examples/hello/workflow.bpmn').read_text()
        workflow_file.write_text(hello)
        output = json.loads(run(launcher, str(environment), str(workflow_file), *common))
        assert output['greet']['message'] == 'Hello from asys.', output
        # Production inference still goes through the worker's dcomp input.
        workflow_file.write_text(portable)
        output = json.loads(run(launcher, str(agent_environment), str(workflow_file),
                                '--input', str(inputs), *common))
        assert output['work']['final'] == 'The draft is ready.', output
        workflow_file.write_text(hello.replace('type="program"', 'type="absent"'))
        rejected = subprocess.run(launcher + [str(environment), str(workflow_file), *common],
                                  capture_output=True, text=True, timeout=180)
        assert rejected.returncode == 1 and 'does not define job types: absent' in rejected.stderr, rejected.stderr
        workflow_file.write_text(hello.replace('import json', 'import sys\nprint("The design input is invalid", file=sys.stderr)\nraise SystemExit(7)\nimport json'))
        failed = subprocess.run(launcher + [str(environment), str(workflow_file), *common],
                                capture_output=True, text=True, timeout=180)
        assert failed.returncode == 1 and 'Program exited with status 7' in failed.stderr, failed.stderr
        assert 'The design input is invalid' in failed.stderr and 'asys logs ' in failed.stderr, failed.stderr
        failed_run = max(cli_root.glob('runs/*/run.json'), key=lambda path: path.stat().st_mtime).parent
        observed = json.loads(run(observer, 'status', str(failed_run), '--json'))
        assert observed['status'] == 'failed' and observed['jobs'][0]['detail'] == 'The design input is invalid', observed
        assert 'The design input is invalid' in run(observer, 'logs', str(failed_run), 'greet')
        assert 'The design input is invalid' in run(observer, 'logs', str(failed_run))
        assert 'STARTED' in failed.stderr and 'FAILED' in failed.stderr, failed.stderr
        # An image-only environment refreshes its tag while the run retains
        # its stored BPMN and actual workspace. Retrying creates a new job.
        image_environment = project / 'image-only environment'
        image_environment.mkdir()
        shutil.copyfile(environment / 'workers.json', image_environment / 'workers.json')
        tag = f'asys-resume-image:{temp.name}'
        tags.append(tag)
        manifest = (environment / 'component.dcomp').read_text().splitlines()
        manifest[0] = f'docker {tag}'
        (image_environment / 'component.dcomp').write_text('\n'.join(manifest) + '\n')
        run(['docker'], 'build', *build_contexts(), '-t', tag, str(environment))
        workflow_file.write_text(hello.replace('import json', 'from pathlib import Path\np = Path("partial.txt")\nif not p.exists():\n    p.write_text("partial work")\n    raise SystemExit(17)\nassert p.read_text() == "partial work"\nassert Path("/opt/asys/environment/tag-fix-installed").exists()\nimport json'))
        failed = subprocess.run(launcher + [str(image_environment), str(workflow_file), *common],
                                capture_output=True, text=True, timeout=180)
        assert failed.returncode == 1 and 'status 17' in failed.stderr, failed.stderr
        retry_run = max(cli_root.glob('runs/*/run.json'), key=lambda path: path.stat().st_mtime).parent
        job, = json.loads(run(observer, 'status', str(retry_run), '--json'))['jobs']
        previous_image = (retry_run / 'environment/component.dcomp').read_text()
        (project / 'workflow.bpmn').rename(project / 'hidden.bpmn')
        (environment / 'tag-fix-installed').touch()
        run(['docker'], 'build', *build_contexts(), '-t', tag, str(environment))
        try:
            output = json.loads(run(launcher, '--resume', retry_run.name[:8], '--root', str(cli_root)))
            assert output['greet']['message'] == 'Hello from asys.', output
            observed = json.loads(run(observer, 'status', str(retry_run), '--json'))
            assert observed['status'] == 'completed' and len(observed['jobs']) == 2, observed
            completed, = [entry for entry in observed['jobs'] if entry['status'] == 'done']
            assert completed['id'] != job['id'] and completed['directory'] != job['directory'], observed
            assert (retry_run / 'environment/component.dcomp').read_text() != previous_image
            first = json.loads((retry_run / 'runtime/environments/simulation/jobs' / job['id'] / 'state.json').read_text())
            assert first['status'] == 'failed' and first['exit_code'] == 17, first
            assert 'RUN RESUMED' in run(observer, 'logs', str(retry_run))
        finally:
            (project / 'hidden.bpmn').rename(workflow_file)
        print('PASS: resume resolves the updated image and saved BPMN, creates a new job, and preserves the failed job and project', flush=True)
        # Changing an environment's base image must invalidate Docker's cache
        # on ordinary resume, even when the environment source is unchanged.
        base = project / 'worker base'
        base.mkdir()
        base_tag = f'asys-resume-base:{temp.name}'
        tags.append(base_tag)
        dockerfile = environment / 'Dockerfile'
        original = dockerfile.read_text().splitlines()
        (base / 'Dockerfile').write_text(original[0] + '\n')
        run(['docker'], 'build', *build_contexts(), '-t', base_tag, str(base))
        dockerfile.write_text('\n'.join([f'FROM {base_tag}', *original[1:]]) + '\n')
        workflow_file.write_text(hello.replace('import json', 'from pathlib import Path\nif not Path("/opt/asys/environment/fix-installed").exists():\n    Path("partial.txt").write_text("partial work")\n    raise SystemExit(17)\nassert Path("partial.txt").read_text() == "partial work"\nimport json'))
        failed = subprocess.run(launcher + [str(environment), str(workflow_file), *common],
                                capture_output=True, text=True, timeout=180)
        assert failed.returncode == 1 and 'status 17' in failed.stderr, failed.stderr
        retry_run = max(cli_root.glob('runs/*/run.json'), key=lambda path: path.stat().st_mtime).parent
        job, = json.loads(run(observer, 'status', str(retry_run), '--json'))['jobs']
        manifest = retry_run / 'environment/component.dcomp'
        previous_image = manifest.read_text()
        (base / 'fix-installed').touch()
        (base / 'Dockerfile').write_text(original[0] + '\nUSER root\nCOPY fix-installed /opt/asys/environment/fix-installed\nUSER node\n')
        run(['docker'], 'build', *build_contexts(), '-t', base_tag, str(base))
        output = json.loads(run(launcher, '--resume', retry_run.name, '--root', str(cli_root)))
        assert output['greet']['message'] == 'Hello from asys.', output
        observed = json.loads(run(observer, 'status', str(retry_run), '--json'))
        assert observed['status'] == 'completed' and len(observed['jobs']) == 2, observed
        completed, = [entry for entry in observed['jobs'] if entry['status'] == 'done']
        assert completed['id'] != job['id'], observed
        assert manifest.read_text() != previous_image
        first = json.loads((retry_run / 'runtime/environments/simulation/jobs' / job['id'] / 'state.json').read_text())
        assert first['status'] == 'failed' and first['exit_code'] == 17, first
        print('PASS: resume automatically rebuilds against the updated base image, retaining saved workflow and job state', flush=True)
        # Cancel real running work, using only the host channel from the host. The original system's components must survive unchanged.
        for scenario in ['interrupt', 'worker-exit', 'engine-exit']:
            release = project / f'release-{scenario}'
            workflow_file.write_text(hello.replace('import json', f'from pathlib import Path\nimport time\nwhile not Path({str(release.name)!r}).exists():\n    time.sleep(0.1)\nimport json'))
            existing_runs = set((cli_root / 'runs').iterdir())
            egress = scenario == 'interrupt'
            configuration['egress'] = egress
            (environment / 'workers.json').write_text(json.dumps(configuration))
            with log.open('a') as output_log:
                process = subprocess.Popen(launcher + [str(environment), str(workflow_file), *common],
                                           stdout=output_log, stderr=output_log)
                try:
                    def running_cli():
                        assert process.poll() is None, 'launcher exited before cancellation'
                        for directory in set((cli_root / 'runs').iterdir()) - existing_runs:
                            path = directory / 'run.json'
                            if path.exists():
                                record = json.loads(path.read_text())
                                if record['status'] == 'running' and any(
                                    json.loads(job.read_text())['status'] == 'running'
                                    for job in (directory / 'runtime/environments/simulation/jobs').glob('*/state.json')
                                ):
                                    return directory, record
                    directory, record = until(running_cli, timeout=90)
                    observed = json.loads(run(observer, 'status', str(directory), '--json'))
                    assert observed['launcher'] == 'running' and observed['job_counts']['running'] == 1, observed
                    # The host's only interface is the runtime channel: the start
                    # request sits on `in`, run events on `out`, and no port exists.
                    channel = directory / 'runtime/channels/workflow'
                    assert record['channel'] == str(channel), record
                    assert json.loads((channel / 'in/000000001.json').read_text())['type'] == 'start'
                    assert any(json.loads(event.read_text())['type'] == 'run.created' for event in channel.glob('out/0*.json'))
                    engine = next(item for item in json.loads(run(dcomp, 'view', '--json', system))['components']
                                  if item['name'] == record['components']['engine'])
                    assert not engine['status'].get('published_ports') and not engine.get('egress'), engine
                    component = next(item for item in json.loads(run(dcomp, 'view', '--json', system))['components']
                                     if item['name'] == record['components']['workers'])
                    for item in (engine, component):
                        expected_user = f'{os.getuid()}:{os.getgid()}'
                        assert item['user'] == expected_user, item
                        actual_user = run(['docker'], 'inspect', '--format', '{{.Config.User}}', item['status']['container_id']).strip()
                        assert actual_user == expected_user, actual_user
                    assert bool(component.get('egress')) == egress, component
                    assert record['egress'] == egress, record
                    mode = run(['docker'], 'inspect', '--format', '{{.HostConfig.NetworkMode}}', component['status']['container_id']).strip()
                    assert (mode != 'none') == egress, mode
                    if scenario == 'interrupt':
                        moved = project.with_name('moved project')
                        project.rename(moved)
                        try:
                            probe = temp / 'probe-runtime'
                            probe.mkdir(mode=0o700)
                            run(dcomp, 'add-component', '--user', expected_user,
                                '--bind', f'{probe},/var/lib/asys/runtime,rw', system, 'mount-probe',
                                str(dummy_environment))
                            current = {item['name']: item['status']['container_id'] for item in
                                       json.loads(run(dcomp, 'view', '--json', system))['components']}
                            for item in (engine, component):
                                assert current[item['name']] == item['status']['container_id']
                            run(dcomp, 'rm-component', system, 'mount-probe')
                            process.send_signal(signal.SIGINT)
                            assert process.wait(timeout=60) == 130
                            assert json.loads((directory / 'run.json').read_text())['components_removed']
                            assert json.loads((directory / 'result.json').read_text())['status'] == 'cancelled'
                            print('PASS: a moved workspace does not block unrelated additions or workflow cleanup', flush=True)
                        finally:
                            moved.rename(project)
                    else:
                        previous_job, = (directory / 'runtime/environments/simulation/jobs').iterdir()
                        if scenario == 'worker-exit':
                            # Force the host to notice first: the engine cannot
                            # consume the worker's failure while paused.
                            run(['docker'], 'pause', engine['status']['container_id'])
                            run(['docker'], 'stop', component['status']['container_id'])
                        else:
                            run(['docker'], 'kill', engine['status']['container_id'])
                        assert process.wait(timeout=90) == 1
                        stopped = json.loads((directory / 'run.json').read_text())
                        assert stopped['status'] == 'failed' and stopped['components_removed'], stopped
                        assert all(json.loads(path.read_text())['type'] != 'cancel' for path in channel.glob('in/0*.json'))
                        release.touch()
                        resumed = json.loads(run(launcher, '--resume', directory.name, '--root', str(cli_root)))
                        assert resumed['greet']['message'] == 'Hello from asys.', resumed
                        jobs = list((directory / 'runtime/environments/simulation/jobs').iterdir())
                        assert len(jobs) == 2 and previous_job in jobs
                        replacement, = [job for job in jobs if job != previous_job]
                        assert json.loads((replacement / 'request.json').read_text())['metadata']['retry_of'] == previous_job.name
                        assert json.loads((directory / 'result.json').read_text())['status'] == 'completed'
                        print(f'PASS: {scenario} before a BPMN failure checkpoint resumes the unfinished stage', flush=True)
                finally:
                    if process.poll() is None:
                        process.terminate()
                        process.wait(timeout=60)
        # Invalid environments fail validation before any component is started.
        configuration['types']['program']['command'] = []
        (environment / 'workers.json').write_text(json.dumps(configuration))
        existing_runs = set((cli_root / 'runs').iterdir())
        failed = subprocess.run(launcher + [str(environment), str(workflow_file), *common],
                                capture_output=True, text=True, timeout=180)
        assert failed.returncode == 1, failed.stderr
        directory, = set((cli_root / 'runs').iterdir()) - existing_runs
        assert 'program: command must be a nonempty argument list' in failed.stderr
        assert not (directory / 'components.log').exists()
        records = [json.loads((directory / 'run.json').read_text()) for directory in (cli_root / 'runs').iterdir()]
        assert len(records) == 14 and all(record['components_removed'] for record in records), records
        after = {item['name']: item['status']['container_id'] for item in
                 json.loads(run(dcomp, 'view', '--json', system))['components']}
        assert before == after, (before, after)
    finally:
        if previous_binary is None:
            os.environ.pop('DCOMP_BINARY', None)
        else:
            os.environ['DCOMP_BINARY'] = previous_binary
