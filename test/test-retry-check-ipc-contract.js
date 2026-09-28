'use strict';

// @req FR-DOC-019 AC-10 IR-APP-013 AC-13 AC-15
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/main/index.js'), 'utf8');
const start = source.indexOf("ipcMain.handle('indexing:retry-check'");
const end = source.indexOf("ipcMain.handle('indexing:compact'", start);
assert.ok(start >= 0 && end > start);
let handler;
let calls = 0;
let allowed = true;
const owner = { command: async (type, payload) => {
  calls += 1;
  assert.equal(type, 'manage_index');
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), { operation: 'retry_check' });
  return { started: true, scheduled: true };
} };
vm.runInNewContext(source.slice(start, end), {
  ipcMain: { handle: (name, fn) => { assert.equal(name, 'indexing:retry-check'); handler = fn; } },
  settingsIndexingWindow: () => allowed ? {} : null,
  isDocumentStoreSourceRootConfigured: () => true,
  saveDocumentOwner: owner,
  getIndexingStatusPayload: () => ({ ledgerState: 'CORRUPT_DEGRADED' })
});

(async () => {
  let result = await handler({ sender: {} }, { dbPath: 'C:\\private\\source.sqlite3' });
  assert.equal(result.started, false, 'extra private IPC payload is rejected');
  assert.equal(result.jobId, undefined);
  assert.equal(calls, 0, 'invalid payload starts no checker');
  allowed = false;
  result = await handler({ sender: {} });
  assert.equal(result.started, false, 'non-Settings sender is rejected');
  assert.equal(calls, 0);
  allowed = true;
  result = await handler({ sender: {} });
  assert.equal(result.started, true);
  assert.equal(result.scheduled, true);
  assert.equal(result.jobId, undefined);
  assert.equal(calls, 1);
  console.log('retry-check IPC contract passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
