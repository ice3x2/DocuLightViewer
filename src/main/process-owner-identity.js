'use strict';

const fs = require('node:fs');
const { execFile, spawnSync } = require('node:child_process');

let selfIdentityPromise;
let selfIdentityValue;

function cacheSuccessfulSelfIdentity(pid, value) {
  if (pid === process.pid && value) {
    selfIdentityValue = value;
    if (!selfIdentityPromise) selfIdentityPromise = Promise.resolve(value);
  }
  return value;
}

// A PID alone is not evidence that the process which created a lock is alive.
function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return cacheSuccessfulSelfIdentity(pid,
        boot && fields[19] ? `${boot}:${fields[19]}` : null);
    } catch { return null; }
  }
  if (process.platform === 'win32') {
    const check = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().Ticks`],
    { encoding: 'utf8', timeout: 3000, windowsHide: true });
    const value = (check.stdout || '').trim();
    return cacheSuccessfulSelfIdentity(pid,
      check.status === 0 && /^\d{15,20}$/.test(value) ? value : null);
  }
  return null;
}

function currentProcessIdentity() {
  if (selfIdentityPromise) return selfIdentityPromise;
  if (process.platform !== 'win32') {
    const value = processIdentity(process.pid);
    if (!value) return Promise.resolve(null);
    selfIdentityValue = value;
    selfIdentityPromise = Promise.resolve(value);
    return selfIdentityPromise;
  }
  selfIdentityPromise = new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().Ticks`],
    { encoding: 'utf8', timeout: 3000, maxBuffer: 1024, windowsHide: true },
    (error, stdout) => {
      const value = String(stdout || '').trim();
      const actual = !error && /^\d{15,20}$/.test(value) ? value : null;
      if (actual) selfIdentityValue = actual;
      else if (!selfIdentityValue) selfIdentityPromise = undefined;
      resolve(actual || selfIdentityValue || null);
    });
  });
  return selfIdentityPromise;
}

function cachedCurrentProcessIdentity() {
  return selfIdentityValue;
}

function processLiveness(owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return 'unknown';
  try { process.kill(owner.pid, 0); }
  catch (error) { return error.code === 'ESRCH' ? 'dead' : 'unknown'; }
  if (typeof owner.identity !== 'string' || !owner.identity) return 'unknown';
  const actual = owner.pid === process.pid
    ? cachedCurrentProcessIdentity() : processIdentity(owner.pid);
  if (!actual) return 'unknown';
  return actual === owner.identity ? 'alive' : 'dead';
}

module.exports = { processIdentity, currentProcessIdentity,
  cachedCurrentProcessIdentity, processLiveness };
