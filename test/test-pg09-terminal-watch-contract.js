'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { armOwnerTerminalWatch, readDurableCancelledJob,
  awaitWithReferencedTimeout } = require('./helpers/package-native-owner-smoke');

// @req IR-APP-013 AC-13 REL-DOC-007 AC-2 REL-DOC-009 AC-4
(async () => {
  assert.strictEqual(typeof armOwnerTerminalWatch, 'function',
    'PG-09 exposes a nonblocking terminal observer arm');
  const calls = [];
  let terminal;
  const ipc = async (_path, action, params) => {
    calls.push(action);
    if (action === 'r3_test_owner_terminal_watch_arm') {
      terminal = null;
      return { result: { token: 'watch-1', jobId: params.jobId } };
    }
    if (action === 'r3_test_settings_cancel') {
      terminal = { jobId: 'job-1', phase: 'cancelled' };
      return { result: { cancelled: true } };
    }
    if (action === 'r3_test_owner_terminal_watch_wait')
      return { result: terminal };
    throw new Error(`unexpected action: ${action}`);
  };
  const watch = await armOwnerTerminalWatch(ipc, 'pipe', 'job-1');
  await assert.rejects(awaitWithReferencedTimeout(new Promise(() => {}),
    'terminal event', 10), /terminal event timeout/);
  assert.deepStrictEqual(calls, ['r3_test_owner_terminal_watch_arm'],
    'arm returns before cancellation; it cannot block the IPC server');
  await ipc('pipe', 'r3_test_settings_cancel');
  const observed = await watch.wait();
  assert.deepStrictEqual(observed, { jobId: 'job-1', phase: 'cancelled' },
    'terminal that arrives before wait is still observed');
  assert.deepStrictEqual(calls, ['r3_test_owner_terminal_watch_arm',
    'r3_test_settings_cancel', 'r3_test_owner_terminal_watch_wait']);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pg09-terminal-watch-'));
  try {
    const dbPath = path.join(userData, 'index', 'smart-search.sqlite3');
    fs.mkdirSync(path.dirname(dbPath));
    const db = new Database(dbPath);
    db.exec('CREATE TABLE index_jobs (job_id TEXT PRIMARY KEY, status TEXT, phase TEXT, cancel_requested INTEGER)');
    db.prepare('INSERT INTO index_jobs VALUES (?, ?, ?, ?)').run('job-1', 'cancelled', 'cancelled', 1);
    db.close();
    assert.deepStrictEqual(readDurableCancelledJob(userData, 'job-1'),
      { jobId: 'job-1', status: 'cancelled', phase: 'cancelled', cancelRequested: true });
    assert.strictEqual(readDurableCancelledJob(userData, 'job-2'), null);
  } finally { fs.rmSync(userData, { recursive: true, force: true }); }
  console.log('test-pg09-terminal-watch-contract: all assertions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
