import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const source = fileURLToPath(new URL('../..', import.meta.url));

test('the prompt host tool installs independently and runs without a checkout or Python site packages', async t => {
  const root = await mkdtemp(join(tmpdir(), 'asys-human-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout');
  for (const path of ['asys-human-interface/Makefile', 'asys-human-interface/requirements-host.txt', 'asys-human-interface/tools', 'asys-human-interface/python',
    'asys-human-interface/.host-deps',
    'asys-runtime/asys_runtime', 'asys-runtime/LICENSE.multiagent', 'LICENSE', 'Makefile', 'build.mk', 'VERSION', '.host-deps', 'tools', 'python', 'skills', 'designs']) {
    await cp(join(source, path), join(checkout, path), { recursive: true, preserveTimestamps: true });
  }
  await exec('make', ['-C', join(checkout, 'asys-human-interface'), 'install-host', 'PREFIX=/opt/asys', `DESTDIR=${root}/staged`], {
    env: { ...process.env, PIP_NO_INDEX: '1' },
  });
  await rm(checkout, { recursive: true });
  const { stdout } = await exec('python3', ['-I', '-S', join(root, 'staged/opt/asys/bin/asys-human-prompt'), '--help'], { cwd: root });
  assert.match(stdout, /asys-human-prompt/);
  assert.match(stdout, /--claimant/);
  assert.match(stdout, /--plain/);
  await exec('python3', ['-I', '-S', '-c', `
import asyncio, runpy
runpy.run_path(${JSON.stringify(join(root, 'staged/opt/asys/bin/asys-human-prompt'))})
from asys_human.tui import HumanApp
from asys_human.interaction import Interaction
async def check():
    async with HumanApp(Interaction()).run_test() as pilot:
        await pilot.press('ctrl+q')
asyncio.run(check())
`], { cwd: root, timeout: 15000 });
});
