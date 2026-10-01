import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const source = fileURLToPath(new URL('..', import.meta.url));

test('make install is self-contained and preserves saved run records', async t => {
  const root = await mkdtemp(join(tmpdir(), 'asys-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'checkout', 'asys-bpmn');
  await mkdir(join(project, 'bin'), { recursive: true });
  await cp(join(source, 'Makefile'), join(project, 'Makefile'));
  await cp(join(source, 'tools'), join(project, 'tools'), { recursive: true });
  await cp(join(source, '../asys-runtime/asys_runtime'), join(root, 'checkout/asys-runtime/asys_runtime'), { recursive: true });
  await cp(join(source, '../asys-runtime/LICENSE.multiagent'), join(root, 'checkout/asys-runtime/LICENSE.multiagent'));
  await cp(join(source, '../LICENSE'), join(root, 'checkout/LICENSE'));
  await cp(join(source, '../Makefile'), join(root, 'checkout/Makefile'));
  await cp(join(source, '../build.mk'), join(root, 'checkout/build.mk'));
  await cp(join(source, '../VERSION'), join(root, 'checkout/VERSION'));
  await cp(join(source, '../.host-deps'), join(root, 'checkout/.host-deps'), { recursive: true });
  await cp(join(source, '../tools'), join(root, 'checkout/tools'), { recursive: true });
  await cp(join(source, '../python'), join(root, 'checkout/python'), { recursive: true });
  await cp(join(source, '../skills'), join(root, 'checkout/skills'), { recursive: true });
  await cp(join(source, '../designs'), join(root, 'checkout/designs'), { recursive: true });
  const destination = join(root, 'staged');
  const prefix = join(destination, 'opt/asys');
  const stateHome = join(root, 'state');
  const run = join(stateHome, 'asys/runs/previous-run');
  await mkdir(run, { recursive: true });
  const saved = JSON.stringify({ id: 'previous-run', name: 'Previous workflow', status: 'completed',
    components: { engine: 'previous-workflow-1234', workers: 'previous-workers-1234' } });
  await writeFile(join(run, 'run.json'), saved);
  await writeFile(join(run, 'run.log'), 'RUN COMPLETED Previous workflow\n');
  await exec('make', ['--no-print-directory', '-C', project, '-o', 'build', 'install',
    'PREFIX=/opt/asys', `DESTDIR=${destination}`]);
  await rm(join(root, 'checkout'), { recursive: true, force: true });
  const binary = join(prefix, 'bin/asys-run');
  const { stdout } = await exec('python3', ['-I', '-S', binary, '--help'], { cwd: root });
  assert.match(stdout, /usage: asys-run /);
  assert.match(stdout, /WORKER\|WORKFLOW \[REQUEST\]/);
  const host = join(prefix, 'bin/asys');
  const help = (await exec('python3', ['-I', '-S', host, '--help'], { cwd: root })).stdout;
  assert.match(help, /top/);
  const env = { ...process.env, XDG_STATE_HOME: stateHome };
  delete env.ASYS_STATE_ROOT;
  const runs = JSON.parse((await exec('python3', ['-I', '-S', host, 'ps', '--json'], { cwd: root, env })).stdout);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, 'previous-run');
  assert.equal(runs[0].status, 'completed');
  assert.deepEqual(runs[0].components, JSON.parse(saved).components);
  assert.equal(await readFile(join(run, 'run.json'), 'utf8'), saved);
  // Observation continues to work independently of the BPMN installation.
  await assert.rejects(readFile(join(prefix, 'bin/asys-bpmn')), {code:'ENOENT'});
  const logs = (await exec('python3', ['-I', '-S', host, 'logs', 'previous-run'], { cwd: root, env })).stdout;
  assert.equal(logs, 'RUN COMPLETED Previous workflow\n');
});
