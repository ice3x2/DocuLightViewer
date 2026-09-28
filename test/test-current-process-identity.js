'use strict';

const assert = require('assert');
const childProcess = require('child_process');

// @req IR-APP-013 AC-13 REL-DOC-009 AC-2
async function run() {
  if (process.platform !== 'win32') return;
  const originalExecFile = childProcess.execFile;
  const originalSpawnSync = childProcess.spawnSync;
  let asyncCalls = 0;
  let syncCalls = 0;
  const identity = '12345678901234567';
  try {
    childProcess.execFile = (_file, _args, _options, callback) => {
      asyncCalls += 1;
      queueMicrotask(() => callback(asyncCalls === 1 ? new Error('transient') : null,
        asyncCalls === 1 ? '' : `${identity}\n`, ''));
      return { kill() {} };
    };
    childProcess.spawnSync = () => {
      syncCalls += 1;
      throw new Error('same-PID liveness must not spawn synchronous PowerShell');
    };
    delete require.cache[require.resolve('../src/main/process-owner-identity')];
    const { currentProcessIdentity, cachedCurrentProcessIdentity,
      processLiveness } = require('../src/main/process-owner-identity');
    assert.strictEqual(await currentProcessIdentity(), null,
      'failed async self lookup returns null without guessing identity');
    assert.strictEqual(cachedCurrentProcessIdentity(), undefined,
      'transient null is not cached as a process identity');
    assert.strictEqual(processLiveness({ pid: process.pid, identity }), 'unknown',
      'unresolved self identity fails closed without synchronous lookup');
    assert.strictEqual(await currentProcessIdentity(), identity,
      'later async self lookup retries and records real PID-start identity');
    assert.strictEqual(cachedCurrentProcessIdentity(), identity);
    assert.strictEqual(processLiveness({ pid: process.pid, identity }), 'alive');
    assert.strictEqual(processLiveness({ pid: process.pid, identity: 'recycled-old-start' }), 'dead');
    assert.strictEqual(asyncCalls, 2);
    assert.strictEqual(syncCalls, 0, 'same-PID checks never invoke synchronous PowerShell');
    childProcess.spawnSync = () => {
      syncCalls += 1;
      return { status: 0, stdout: `${identity}\n` };
    };
    delete require.cache[require.resolve('../src/main/process-owner-identity')];
    const fresh = require('../src/main/process-owner-identity');
    assert.strictEqual(fresh.processIdentity(process.pid), identity);
    assert.strictEqual(fresh.cachedCurrentProcessIdentity(), identity,
      'a successful startup self lookup is reusable by same-PID recovery');
    assert.strictEqual(fresh.processLiveness({ pid: process.pid,
      identity: 'recycled-old-start' }), 'dead');
    assert.strictEqual(syncCalls, 1,
      'recovery reuses the startup identity rather than spawning again');
  } finally {
    childProcess.execFile = originalExecFile;
    childProcess.spawnSync = originalSpawnSync;
    delete require.cache[require.resolve('../src/main/process-owner-identity')];
  }
}

run().then(() => console.log('test-current-process-identity: all assertions passed'),
  error => { console.error(error.stack || String(error)); process.exitCode = 1; });
