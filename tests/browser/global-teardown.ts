import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PIDFILE = path.join(os.tmpdir(), 'wa-pw-app.pid');

export default async function globalTeardown() {
  try {
    const pid = fs.readFileSync(PIDFILE, 'utf8').trim();
    if (pid) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', pid, '/T', '/F']);
      else { try { process.kill(Number(pid)); } catch {} }
    }
  } catch {}
  try { fs.unlinkSync(PIDFILE); } catch {}
}
