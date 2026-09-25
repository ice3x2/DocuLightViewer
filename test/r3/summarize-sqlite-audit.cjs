'use strict';

// @req FR-DOC-019 AC-6 AC-10
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { sourceHash } = require('./runtime.cjs');

const [auditPath, pidList, artifactPath] = process.argv.slice(2);
assert(auditPath && pidList && artifactPath,
  'Usage: node summarize-sqlite-audit.cjs <raw-jsonl> <product-pid,pid> <artifact-json>');
const pids = new Set(pidList.split(',').map(Number));
assert(pids.size >= 2 && [...pids].every(Number.isSafeInteger), 'two inspected product PIDs required');
const raw = fs.readFileSync(auditPath);
const rows = raw.toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
const product = rows.filter(row => pids.has(row.pid));
assert(product.length > 0 && [...pids].every(pid => product.some(row => row.pid === pid)),
  'each product PID must have constructor events');
const isOwner = row => row.threadId > 0
  && row.caller.some(line => line.includes('search-owner-worker.js'));
const writable = product.filter(row => row.readOnly !== true);
assert(writable.length >= pids.size * 2, 'each cold product run must open two owner SQLite databases');
assert(writable.every(isOwner), 'writable main or short-worker SQLite open detected');
const summary = { sourceHash: sourceHash(), rawAuditSha256: crypto.createHash('sha256').update(raw).digest('hex'),
  inspectedProductRuns: pids.size, productConstructorOpenCount: product.length,
  mainWritableOpenCount: writable.filter(row => row.threadId === 0).length,
  shortWorkerWritableOpenCount: writable.filter(row => !isOwner(row) && row.threadId > 0).length,
  ownerWritableOpenCount: writable.length,
  ownerWritableDatabaseRoles: [...new Set(writable.map(row => path.basename(row.dbPath)))].sort(),
  productReadOnlyOpenCount: product.length - writable.length,
  auxiliaryReadOnlyOpenCount: rows.length - product.length,
  auxiliaryWritableOpenCount: rows.filter(row => !pids.has(row.pid) && row.readOnly !== true).length };
assert.deepEqual(summary.ownerWritableDatabaseRoles,
  ['search-index.sqlite3', 'smart-search.sqlite3']);
assert.equal(summary.auxiliaryWritableOpenCount, 0);
fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
fs.writeFileSync(artifactPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary));
