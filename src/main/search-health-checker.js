'use strict';

// @req FR-DOC-019 AC-10 IR-APP-013 AC-15
const fs = require('node:fs');
const { parentPort, threadId, workerData } = require('node:worker_threads');
const Database = require('better-sqlite3');
const audit = { pid: process.pid, threadId, opens: [] };

if (workerData.r3HealthCheckBarrier) {
  const barrier = new Int32Array(workerData.r3HealthCheckBarrier);
  Atomics.wait(barrier, 0, 0, 5000);
}

function inspect(file, required) {
  if (!fs.existsSync(file)) return required ? 'source_ledger_missing' : null;
  let db;
  try {
    audit.opens.push({ role: required ? 'source-ledger' : 'keyword', readOnly: true });
    db = new Database(file, { readonly: true, fileMustExist: true });
    return db.pragma('integrity_check', { simple: true }) === 'ok' ? null
      : required ? 'source_ledger_corrupt' : 'keyword_index_corrupt';
  } catch {
    return required ? 'source_ledger_corrupt' : 'keyword_index_corrupt';
  } finally {
    if (db) db.close();
  }
}

const code = inspect(workerData.ledgerPath, true) || inspect(workerData.keywordPath, false);
parentPort.postMessage(code ? { ok: false, code, audit } : { ok: true, audit });
