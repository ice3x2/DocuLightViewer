'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

// A PID alone is not evidence that the process which created a lock is alive.
function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return boot && fields[19] ? `${boot}:${fields[19]}` : null;
    } catch { return null; }
  }
  if (process.platform === 'win32') {
    const check = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().Ticks`],
    { encoding: 'utf8', timeout: 3000, windowsHide: true });
    const value = (check.stdout || '').trim();
    return check.status === 0 && /^\d{15,20}$/.test(value) ? value : null;
  }
  return null;
}

function processLiveness(owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return 'unknown';
  try { process.kill(owner.pid, 0); }
  catch (error) { return error.code === 'ESRCH' ? 'dead' : 'unknown'; }
  if (typeof owner.identity !== 'string' || !owner.identity) return 'unknown';
  const actual = processIdentity(owner.pid);
  if (!actual) return 'unknown';
  return actual === owner.identity ? 'alive' : 'dead';
}

module.exports = { processIdentity, processLiveness };
