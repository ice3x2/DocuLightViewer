'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// @req REL-DOC-009 AC-2 IR-APP-013 AC-13
async function run() {
  if (process.platform !== 'win32') return;
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const ingressRoot = fs.mkdtempSync(path.join(tempRoot, 'doculight-null-identity-'));
  const originalExecFile = childProcess.execFile;
  let calls = 0;
  let entered = false;
  try {
    childProcess.execFile = (_file, _args, _options, callback) => {
      calls += 1;
      queueMicrotask(() => callback(calls === 1 ? new Error('transient') : null,
        calls === 1 ? '' : '12345678901234567\n', ''));
      return { kill() {} };
    };
    delete require.cache[require.resolve('../src/main/process-owner-identity')];
    const { withPublicationGate } = require('../src/main/index-ingress-store');
    await assert.rejects(withPublicationGate(ingressRoot, () => { entered = true; }),
      error => error?.code === 'publication_busy',
      'unknown Windows self identity must fail closed before lock acquisition');
    assert.strictEqual(entered, false, 'unknown owner never enters the critical section');
    assert.strictEqual(fs.existsSync(path.join(ingressRoot, '.publication.lock')), false,
      'unknown owner leaves no unrecoverable live lock');
    await withPublicationGate(ingressRoot, () => { entered = true; });
    assert(entered && calls === 2, 'next attempt retries identity and acquires the gate');
    assert.strictEqual(fs.existsSync(path.join(ingressRoot, '.publication.lock')), false,
      'successful gate releases its lock');
  } finally {
    childProcess.execFile = originalExecFile;
    delete require.cache[require.resolve('../src/main/process-owner-identity')];
    const resolved = fs.realpathSync.native(ingressRoot);
    assert.strictEqual(path.dirname(resolved).toLowerCase(), tempRoot.toLowerCase());
    fs.rmSync(ingressRoot, { recursive: true });
  }
}

run().then(() => console.log('test-publication-null-identity: all assertions passed'),
  error => { console.error(error.stack || String(error)); process.exitCode = 1; });
