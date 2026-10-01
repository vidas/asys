import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const source = fileURLToPath(new URL('..', import.meta.url));

async function checkout(t, extra = []) {
  const root = await mkdtemp(join(tmpdir(), 'asys-host-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'checkout');
  await mkdir(project);
  for (const path of ['Makefile', 'build.mk', 'VERSION', 'LICENSE', '.host-deps', 'tools', 'python', 'skills', 'designs', 'asys-runtime/asys_runtime',
    'asys-runtime/LICENSE.multiagent', 'asys-workers/asys_swarm', 'asys-workers/worlds', ...extra]) {
    await cp(join(source, path), join(project, path), { recursive: true });
  }
  return { root, project, library: join(root, 'staged/opt/asys/share/asys/python') };
}

test('core asys installs system agent resources and definitions without the source checkout', async t => {
  const { root, project, library } = await checkout(t);
  const record = { version: '0.0.0', build: 'fixture', images: {} };
  await writeFile(join(project, 'release.json'), JSON.stringify(record));
  await exec('make', ['--no-print-directory', '-C', project, 'install-host', 'PREFIX=/opt/asys', `DESTDIR=${root}/staged`]);
  await rm(project, { recursive: true });
  // Installed commands take their images from the release this checkout built.
  assert.deepEqual(JSON.parse(await readFile(join(root, 'staged/opt/asys/share/asys/release.json'), 'utf8')), record);
  const binary = join(root, 'staged/opt/asys/bin/asys');
  const { stdout } = await exec('python3', ['-I', '-S', binary, 'ps', '--json', '--root', join(root, 'absent')], { cwd: root });
  assert.deepEqual(JSON.parse(stdout), []);
  const state = join(root, 'state');
  const { stdout: unset } = await exec('python3', ['-I', '-S', binary, 'system-model', 'list', '--json', '--root', state], { cwd: root });
  assert.deepEqual(JSON.parse(unset), { simple: null });
  await exec('python3', ['-I', '-S', binary, 'system-model', 'set', 'simple', 'account/model', '--root', state], { cwd: root });
  const { stdout: models } = await exec('python3', ['-I', '-S', binary, '--root', state, 'system-model', 'list', '--json'], { cwd: root });
  assert.deepEqual(JSON.parse(models), { simple: 'account/model' });
  const { stdout: installed } = await exec('python3', ['-I', '-S', '-c', `
import json, sys
sys.path.insert(0, sys.argv[1])
from asys.config import system_model
from asys.system_agents import agent_names, agent_prompt
from asys.worker_definitions import builtin_definition
print(json.dumps({'agents': agent_names(), 'prompt': agent_prompt('simple'),
    'definition': builtin_definition('simple'), 'model': system_model('simple')}))
`, library], { cwd: root, env: { ...process.env, ASYS_STATE_ROOT: state } });
  const definition = JSON.parse(installed);
  assert.deepEqual(definition.agents, ['simple']);
  const prompt = await readFile(join(source, 'python/asys/system_agents/simple/prompt.md'), 'utf8');
  assert.equal(definition.prompt, prompt);
  assert.equal(definition.model, 'account/model');
  assert.equal(definition.definition.version, 1);
  assert.equal(definition.definition.kind, 'agent');
  assert.deepEqual(definition.definition.config, { agent: 'simple', system: true });
});

test('worker and environment authoring install with the shared runner and world resources', async t => {
  const { root, project } = await checkout(t);
  const prefix = join(root, 'staged/opt/asys');
  await exec('make', ['--no-print-directory', '-C', project, 'install-host', 'PREFIX=/opt/asys', `DESTDIR=${root}/staged`]);
  await rm(project, { recursive: true });
  const invoke = (tool, ...args) => exec('python3', ['-I', '-S', join(prefix, 'bin', tool), ...args], { cwd: root });
  const environment = join(root, 'environment');
  await invoke('asys-workers', 'add', environment, 'agent', 'editor');
  await invoke('asys-workers', 'add', environment, 'goal', 'repair');
  await invoke('asys-workers', 'add', environment, 'senate', 'review');
  await invoke('asys-workers', 'add', environment, 'swarm', 'explore');
  const { stdout: listed } = await invoke('asys-workers', 'list', environment);
  for (const name of ['editor', 'repair', 'review', 'explore', 'simple', 'goal']) assert.match(listed, new RegExp(name));
  const config = JSON.parse(await readFile(join(environment, 'workers/explore.json')));
  const packageDirectory = join(environment, config.config.world.package);
  const manifest = JSON.parse(await readFile(join(packageDirectory, 'world.json')));
  const renderer = join(packageDirectory, manifest.view);
  assert.match(await readFile(renderer, 'utf8'), /export function mount/);
  const skill = join(root, 'checking');
  await mkdir(skill);
  await writeFile(join(skill, 'SKILL.md'), '---\nname: checking\ndescription: Check the project.\n---\nUse the checking instructions.\n');
  await writeFile(join(skill, 'reference.txt'), 'Complete imported asset.\n');
  await invoke('asys-environment', 'add-skill', environment, skill);
  assert.equal(await readFile(join(environment, 'skills/checking/reference.txt'), 'utf8'), 'Complete imported asset.\n');
  const { stdout: help } = await invoke('asys-run', '--help');
  assert.match(help, /ENVIRONMENT WORKER\|WORKFLOW\.bpmn \[REQUEST\]/);
  assert.match(help, /--workspace DIRECTORY/);
  assert.match(help, /--model MODEL/);
  assert.doesNotMatch(help, /--view|--port/);
  const { stdout: dashboardHelp } = await invoke('asys', 'dashboard', '--help');
  assert.match(dashboardHelp, /--port/);
  assert.match(dashboardHelp, /--design DIRECTORY/);
  for (const asset of ['index.html', 'dashboard.css', 'dashboard.mjs', 'design.mjs', 'console-selection.mjs', 'markdown.mjs', 'marked.mjs', 'marked.LICENSE.txt', 'dagre.mjs', 'dagre.LICENSE.txt', 'dagre.LEGAL.txt', 'content.mjs', 'senate.mjs']) {
    assert.ok((await readFile(join(prefix, 'share/asys/python/asys/dashboard_assets', asset))).length > 0);
  }
  for (const asset of ['design.json', 'styles.css', 'logo.svg']) {
    assert.ok((await readFile(join(prefix, 'share/asys/designs/default', asset))).length > 0);
  }
  for (const asset of ['design.json', 'styles.css', 'logo.svg', 'fonts/Yrsa-Regular.ttf', 'fonts/Yrsa-Bold.ttf', 'fonts/Yrsa-Italic.ttf', 'fonts/LICENSE.txt']) {
    assert.deepEqual(await readFile(join(prefix, 'share/asys/designs/slate', asset)),
      await readFile(join(source, 'designs/slate', asset)));
  }
  const {stdout: html} = await exec('python3', ['-I', '-S', '-c', `
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from asys.dashboard_design import Design
print(Design().html((Path(sys.argv[1]) / 'asys/dashboard_assets/index.html').read_text()).decode())
`, join(prefix, 'share/asys/python')], {cwd: root});
  assert.match(html, /\/design\/default\/styles.css/);
});

test('both portable skills export complete references and assets without the source checkout', async t => {
  const { root, project } = await checkout(t);
  const prefix = join(root, 'staged/opt/asys');
  await exec('make', ['--no-print-directory', '-C', project, 'install-host', 'PREFIX=/opt/asys', `DESTDIR=${root}/staged`]);
  await rm(project, { recursive: true });
  const binary = join(prefix, 'bin/asys');
  const invoke = (...args) => exec('python3', ['-I', '-S', binary, 'skill', ...args], { cwd: root });
  const names = ['asys', 'asys-authoring'];
  const bundles = names.map(name => join(prefix, 'share/asys/skills', name));
  const bundled = bundles[0];
  assert.deepEqual((await invoke()).stdout.trim().split('\n'), bundles);
  assert.equal((await invoke('--name', 'asys-authoring')).stdout.trim(), bundles[1]);
  await assert.rejects(invoke(join(bundled, 'nested')), error => error.code === 1 && /outside/.test(error.stderr));

  const parent = join(root, 'agent settings/skills');
  const exported = join(parent, 'asys');
  assert.deepEqual((await invoke(parent)).stdout.trim().split('\n'), names.map(name => join(parent, name)));
  async function compare(name, relative = '') {
    for (const entry of await readdir(join(source, 'skills', name, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await compare(name, path);
      else {
        assert.deepEqual(await readFile(join(parent, name, path)), await readFile(join(source, 'skills', name, path)), path);
        assert.equal((await stat(join(prefix, 'share/asys/skills', name, path))).mode & 0o777, 0o644, path);
      }
    }
  }
  for (const name of names) await compare(name);
  const selected = join(root, 'author settings');
  await invoke(selected, '--name', 'asys-authoring');
  assert.deepEqual(await readdir(selected), ['asys-authoring']);
  // Local edits and symlinked destinations must not be overwritten by a copy.
  await writeFile(join(exported, 'SKILL.md'), 'locally maintained instructions\n');
  await assert.rejects(invoke(parent), error => error.code === 1 && /already exists/.test(error.stderr));
  assert.equal(await readFile(join(exported, 'SKILL.md'), 'utf8'), 'locally maintained instructions\n');
  const linked = join(root, 'linked');
  await mkdir(linked);
  await symlink(exported, join(linked, 'asys'));
  await assert.rejects(invoke(linked), error => error.code === 1 && /already exists/.test(error.stderr));
  await rm(bundled, { recursive: true });
  assert.match(await readFile(join(parent, 'asys-authoring/references/environments.md'), 'utf8'), /workers.json/);
  assert.match(await readFile(join(parent, 'asys-authoring/references/design.md'), 'utf8'), /--design/);
  assert.match(await readFile(join(parent, 'asys-authoring/assets/team/workflow.bpmn'), 'utf8'), /serviceTask/);
  await assert.rejects(invoke(), error => error.code === 1 && /reinstall asys/.test(error.stderr));
});

test('upgrading removes obsolete host entrypoints and packages only from the selected installation', async t => {
  const { root, project } = await checkout(t);
  const stage = join(root, 'staged installation');
  const prefix = join(stage, 'opt/asys');
  const outside = join(root, 'other installation');
  const removed = ['oneshot', 'goal', 'senate', 'swarm'];
  const stale = [];
  for (const name of removed) {
    for (const relative of [`bin/asys-${name}`, `share/asys/python/asys/${name}.py`,
      `share/asys/python/asys/${name}.pyc`, `share/asys/python/asys/__pycache__/${name}.cpython-313.pyc`,
      `share/asys/python/asys/__pycache__/${name}.cpython-313.opt-1.pyc`]) {
      stale.push(relative);
      for (const destination of [prefix, outside]) {
        const target = join(destination, relative);
        await mkdir(join(target, '..'), { recursive: true });
        await writeFile(target, 'obsolete installation fixture\n');
      }
    }
    for (const relative of [`bin/asys-${name}`, `asys-${name}/bin/asys-${name}`]) {
      const target = join(project, relative);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, 'obsolete generated host executable\n');
    }
  }
  for (const module of ['asys/swarm_view', 'asys_swarm/world_process']) {
    const [directory, name] = module.split('/');
    for (const relative of [`share/asys/python/${module}.py`, `share/asys/python/${module}.pyc`,
      `share/asys/python/${directory}/__pycache__/${name}.cpython-313.pyc`]) {
      stale.push(relative);
      for (const destination of [prefix, outside]) {
        const target = join(destination, relative);
        await mkdir(join(target, '..'), { recursive: true });
        await writeFile(target, 'obsolete installation fixture\n');
      }
    }
  }
  for (const relative of ['bin/asys-bpmn', 'share/asys-bpmn/python/asys_bpmn/runs.py']) {
    stale.push(relative);
    for (const destination of [prefix, outside]) {
      const target = join(destination, relative);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, 'obsolete installation fixture\n');
    }
  }
  // The previous standalone swarm installer used its own share directory,
  // separate from the core Python tree seeded above.
  for (const relative of [
    'python/asys_swarm/__init__.py', 'python/asys_swarm/engine.py',
    'python/asys_swarm/world_process.py',
    'python/asys_swarm/__pycache__/world_process.cpython-313.pyc',
    'README.md', 'AUTHORING.md', 'WORLD.md', 'LICENSE', 'LICENSE.multiagent',
    'examples/terrarium/swarm.json', 'examples/terrarium/view.html',
    'examples/terrarium/world/serve.py',
  ]) {
    const path = join('share/asys-swarm', relative);
    stale.push(path);
    for (const destination of [prefix, outside]) {
      const target = join(destination, path);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, 'obsolete installation fixture\n');
    }
  }
  const retained = ['bin/asys-custom', 'share/asys/python/asys/custom.py',
    'share/asys/python/asys/__pycache__/custom.cpython-313.pyc', 'share/asys-custom/README.md'];
  for (const relative of retained) {
    const target = join(prefix, relative);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, 'leave this file alone\n');
  }
  await exec('make', ['--no-print-directory', '-C', project, 'install-host', 'PREFIX=/opt/asys', `DESTDIR=${stage}`]);
  for (const relative of stale) {
    await assert.rejects(stat(join(prefix, relative)), { code: 'ENOENT' }, relative);
    assert.equal(await readFile(join(outside, relative), 'utf8'), 'obsolete installation fixture\n', relative);
  }
  for (const relative of retained) assert.equal(await readFile(join(prefix, relative), 'utf8'), 'leave this file alone\n');
  await assert.rejects(stat(join(prefix, 'share/asys-swarm')), { code: 'ENOENT' });
  // Installing never writes into the checkout; building removes stale entrypoints.
  for (const name of removed) await stat(join(project, `bin/asys-${name}`));
  await exec('make', ['--no-print-directory', '-C', project, 'host']);
  for (const name of removed) {
    await assert.rejects(stat(join(project, `bin/asys-${name}`)), { code: 'ENOENT' });
    await assert.rejects(stat(join(project, `asys-${name}/bin/asys-${name}`)), { code: 'ENOENT' });
  }
  await rm(project, { recursive: true });
  await exec('python3', ['-I', '-S', '-c', `
import importlib.util, sys
sys.path.insert(0, sys.argv[1])
for name in ('oneshot', 'goal', 'senate', 'swarm', 'swarm_view'):
    assert importlib.util.find_spec('asys.' + name) is None, name
assert importlib.util.find_spec('asys_swarm.world_process') is None
from asys.run import arguments
assert arguments(['env', 'simple', 'Do the work']).worker == 'simple'
from asys_swarm.config import validate_config
`, join(prefix, 'share/asys/python')], { cwd: root });
  const help = await exec('python3', ['-I', '-S', join(prefix, 'bin/asys-run'), '--help'], { cwd: root });
  assert.match(help.stdout, /ENVIRONMENT WORKER\|WORKFLOW\.bpmn \[REQUEST\]/);
});
