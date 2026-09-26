import { writeFileSync, rmSync } from 'node:fs';

export function heartbeat(path, { ready = () => true } = {}) {
  const tick = () => { if (ready()) writeFileSync(path, '', { mode: 0o600 }); };
  tick();
  const timer = setInterval(tick, 2000);
  timer.unref();
  return () => { clearInterval(timer); rmSync(path, { force: true }); };
}
