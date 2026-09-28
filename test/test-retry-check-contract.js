'use strict';

// @req FR-DOC-019 AC-10 IR-APP-013 AC-13 AC-15 REL-DOC-008 AC-4 AC-5
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SourceLedgerStore } = require('../src/main/source-ledger-store');
const { SQLiteKeywordIndex } = require('../src/main/search-sqlite-store');
const { OwnerWorkerController } = require('../src/main/search-owner-controller');
const { fromOwnerSnapshot } = require('../src/main/ledger-status-registry');

async function waitFor(predicate, timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('timed out waiting for owner state');
}

function databaseFiles(dbPath) {
  return ['', '-wal', '-shm'].map(suffix => {
    const file = dbPath + suffix;
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  });
}

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-issue64-'));
  const root = path.join(dir, 'store');
  const ledgerPath = path.join(dir, 'source-ledger.sqlite3');
  const keywordPath = path.join(dir, 'keyword.sqlite3');
  fs.mkdirSync(root);
  const ledger = new SourceLedgerStore({ dbPath: ledgerPath });
  ledger.initialize();
  ledger.close();
  const original = fs.readFileSync(ledgerPath);
  try {
    fs.writeFileSync(ledgerPath, Buffer.from('not a SQLite database'));
    const owner = new OwnerWorkerController({ ledgerPath, keywordPath, sourceRoot: root,
      publicationRoot: root, keywordTokenizerProvider: 'basic' });
    await assert.rejects(owner.start(), /owner_start_failed/);
    await waitFor(() => owner.worker === null);
    assert.equal(fromOwnerSnapshot(owner.getStatus(), true).ledgerState, 'CORRUPT_DEGRADED',
      'checked source-ledger corruption has a distinct actionable state');
    const invalid = await owner.command('manage_index', { operation: 'retry_check', dbPath: ledgerPath })
      .then(() => null, error => error);
    assert.equal(invalid.code, 'owner_invalid_manage_index_payload');
    const accepted = await owner.command('manage_index', { operation: 'retry_check' });
    assert.equal(accepted.started, true, 'exited owner accepts a private health recheck');
    assert.equal(accepted.scheduled, true);
    assert.equal(accepted.jobId, undefined, 'ephemeral check has no durable jobId');
    await waitFor(() => owner.getStatus().state !== 'CHECKING');
    assert.equal(fromOwnerSnapshot(owner.getStatus(), true).ledgerState, 'CORRUPT_DEGRADED',
      'failed read-only recheck retains corrupt diagnostic');
    assert.equal(owner.lastCheckAudit?.pid, process.pid);
    assert.ok(Number.isInteger(owner.lastCheckAudit?.threadId));
    assert.ok(owner.lastCheckAudit?.opens?.length >= 1);
    assert.ok(owner.lastCheckAudit?.opens?.every(item => item.readOnly === true));
    assert.ok(!JSON.stringify(owner.lastCheckAudit).includes(dir),
      'checker audit contains roles and thread IDs without raw DB paths');
    assert.equal(fs.readFileSync(ledgerPath, 'utf8'), 'not a SQLite database',
      'failed check does not modify corrupt source bytes');
    fs.writeFileSync(ledgerPath, original);
    fs.writeFileSync(keywordPath, Buffer.from('invalid keyword SQLite'));
    await owner.command('manage_index', { operation: 'retry_check' });
    await waitFor(() => owner.getStatus().state !== 'CHECKING');
    assert.equal(owner.getStatus().state, 'INTERRUPTED',
      'repaired source with corrupt keyword no longer claims source corruption');
    assert.equal(owner.getStatus().diagnostic.code, 'keyword_index_corrupt');
    fs.unlinkSync(keywordPath);
    fs.writeFileSync(ledgerPath, Buffer.from('not a SQLite database'));
    await owner.command('manage_index', { operation: 'retry_check' });
    await waitFor(() => owner.getStatus().state !== 'CHECKING');
    assert.equal(owner.getStatus().state, 'CORRUPT_DEGRADED');
    const unavailablePath = `${ledgerPath}.temporarily-missing`;
    fs.renameSync(ledgerPath, unavailablePath);
    await owner.command('manage_index', { operation: 'retry_check' });
    await waitFor(() => owner.getStatus().state !== 'CHECKING');
    assert.equal(owner.getStatus().state, 'INTERRUPTED',
      'missing source ledger no longer claims checked corruption');
    assert.equal(owner.getStatus().diagnostic.code, 'source_ledger_missing');
    fs.renameSync(unavailablePath, ledgerPath);
    await owner.command('manage_index', { operation: 'retry_check' });
    await waitFor(() => owner.getStatus().state !== 'CHECKING');
    assert.equal(owner.getStatus().state, 'CORRUPT_DEGRADED');
    const barrier = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    owner.config.r3HealthCheckBarrier = barrier.buffer;
    const cancelledCheck = await owner.command('manage_index', { operation: 'retry_check' });
    assert.equal(cancelledCheck.started, true);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(owner.getStatus().state, 'CHECKING', 'read-only checker remains independently active');
    assert.equal((await owner.command('manage_index', { operation: 'retry_check' })).started, false,
      'duplicate check is denied without a job');
    assert.equal((await owner.cancelRetryCheck()).cancelled, true);
    assert.equal(owner.getStatus().state, 'CORRUPT_DEGRADED',
      'safe cancel restores the prior corruption diagnostic');
    assert.equal(fs.readFileSync(ledgerPath, 'utf8'), 'not a SQLite database');
    await owner.command('manage_index', { operation: 'retry_check' });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(owner.getStatus().state, 'CHECKING');
    await owner.checker.terminate();
    await waitFor(() => owner.getStatus().state === 'INTERRUPTED');
    Atomics.store(barrier, 0, 1);
    Atomics.notify(barrier, 0);
    fs.writeFileSync(ledgerPath, original);
    fs.writeFileSync(keywordPath, Buffer.from('invalid keyword SQLite'));
    await owner.command('manage_index', { operation: 'retry_check' });
    await waitFor(() => owner.getStatus().state !== 'CHECKING');
    assert.equal(owner.getStatus().state, 'INTERRUPTED',
      'keyword corruption does not erase an interrupted recovery action');
    assert.equal(owner.getStatus().diagnostic.code, 'keyword_index_corrupt');
    fs.unlinkSync(keywordPath);
    const missingPath = `${ledgerPath}.held`;
    fs.renameSync(ledgerPath, missingPath);
    await owner.command('manage_index', { operation: 'retry_check' });
    await waitFor(() => owner.getStatus().state !== 'CHECKING');
    assert.equal(owner.getStatus().state, 'INTERRUPTED',
      'missing ledger keeps the interrupted check actionable');
    assert.equal(owner.getStatus().diagnostic.code, 'source_ledger_missing');
    fs.renameSync(missingPath, ledgerPath);
    const recovered = await owner.command('manage_index', { operation: 'retry_check' });
    assert.equal(recovered.started, true);
    await waitFor(() => owner.getStatus().migrationComplete === true
      && owner.getStatus().recoveryComplete === true, 10000);
    assert.ok(['READY', 'READY_KEYWORD_DEGRADED'].includes(
      fromOwnerSnapshot(owner.getStatus(), true).ledgerState),
    'fresh owner becomes ready only after migration and recovery');
    assert.equal((await owner.command('manage_index', { operation: 'retry_check' })).started, false,
      'ready owner cannot accept a duplicate health check');
    await owner.shutdown();
    fs.writeFileSync(ledgerPath, Buffer.from('not a SQLite database'));
    Atomics.store(barrier, 0, 0);
    await assert.rejects(owner.start(), /owner_start_failed/);
    await waitFor(() => owner.worker === null);
    await owner.command('manage_index', { operation: 'retry_check' });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(owner.getStatus().state, 'CHECKING');
    await owner.shutdown();
    assert.equal(owner.checker, null, 'close ends its own read-only checker');
    assert.equal((await owner.command('manage_index', { operation: 'retry_check' })).started, false,
      'closed controller cannot schedule another check');
  } finally {
    fs.writeFileSync(ledgerPath, original);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const keywordDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-issue64-keyword-'));
  let failed;
  try {
    const store = path.join(keywordDir, 'store');
    fs.mkdirSync(store);
    const sourceFile = path.join(keywordDir, 'source.sqlite3');
    const keywordFile = path.join(keywordDir, 'keyword.sqlite3');
    const source = new SourceLedgerStore({ dbPath: sourceFile });
    source.initialize();
    source.close();
    const corruptBytes = Buffer.from('invalid keyword SQLite');
    fs.writeFileSync(keywordFile, corruptBytes);
    failed = new OwnerWorkerController({ ledgerPath: sourceFile, keywordPath: keywordFile,
      sourceRoot: store, publicationRoot: store, keywordTokenizerProvider: 'basic' });
    await assert.rejects(failed.start(), error => error.code === 'keyword_index_corrupt',
      'corrupt keyword cache is identified before a writable owner open');
    await waitFor(() => failed.worker === null);
    assert.deepEqual(fs.readFileSync(keywordFile), corruptBytes,
      'corrupt keyword bytes remain untouched for explicit repair');
    await assert.rejects(failed.query('query_keyword', { query: 'private' }),
      /owner_unavailable/, 'corrupt keyword cache cannot serve unvalidated results');
  } finally {
    if (failed?.worker) await failed.worker.terminate();
    fs.rmSync(keywordDir, { recursive: true, force: true });
  }
  const fullKeywordDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-issue64-full-keyword-'));
  let fullKeywordOwner;
  try {
    const store = path.join(fullKeywordDir, 'store');
    fs.mkdirSync(store);
    const sourceFile = path.join(fullKeywordDir, 'source.sqlite3');
    const keywordFile = path.join(fullKeywordDir, 'keyword.sqlite3');
    const source = new SourceLedgerStore({ dbPath: sourceFile });
    source.initialize();
    source.close();
    const keyword = new SQLiteKeywordIndex({ dbPath: keywordFile, sourceRoot: store });
    keyword.open();
    keyword.close();
    const Database = require('better-sqlite3');
    const db = new Database(keywordFile);
    let quick, full;
    try {
      db.unsafeMode(true);
      db.exec('CREATE TABLE issue64_probe(a TEXT, b TEXT); CREATE INDEX issue64_index ON issue64_probe(a)');
      db.prepare('INSERT INTO issue64_probe(a, b) VALUES (?, ?)').run('aaa', 'bbb');
      db.exec('PRAGMA writable_schema=ON');
      db.prepare('UPDATE sqlite_schema SET sql = ? WHERE name = ?')
        .run('CREATE INDEX issue64_index ON issue64_probe(b)', 'issue64_index');
      db.exec('PRAGMA writable_schema=OFF');
      db.pragma(`schema_version = ${db.pragma('schema_version', { simple: true }) + 1}`);
      quick = db.pragma('quick_check(1)', { simple: true });
      full = db.pragma('integrity_check', { simple: true });
    } finally { db.close(); }
    assert.equal(quick, 'ok');
    assert.notEqual(full, 'ok');
    const sourceBefore = databaseFiles(sourceFile);
    const keywordBefore = databaseFiles(keywordFile);
    fullKeywordOwner = new OwnerWorkerController({ ledgerPath: sourceFile, keywordPath: keywordFile,
      sourceRoot: store, publicationRoot: store, keywordTokenizerProvider: 'basic' });
    await assert.rejects(fullKeywordOwner.start(), error => error.code === 'keyword_index_corrupt',
      'full-only keyword corruption is classified before writable owner open');
    await waitFor(() => fullKeywordOwner.worker === null);
    assert.deepEqual(fullKeywordOwner.lastStartAudit?.opens, [],
      'corrupt keyword preflight opens no production SQLite writer');
    assert.deepEqual(databaseFiles(sourceFile), sourceBefore,
      'keyword corruption leaves source DB and sidecars unchanged');
    assert.deepEqual(databaseFiles(keywordFile), keywordBefore,
      'owner startup leaves corrupt keyword DB and sidecars unchanged');
  } finally {
    if (fullKeywordOwner?.worker) await fullKeywordOwner.worker.terminate();
    fs.rmSync(fullKeywordDir, { recursive: true, force: true });
  }
  const fullDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-issue64-full-integrity-'));
  let fullOwner;
  try {
    const store = path.join(fullDir, 'store');
    fs.mkdirSync(store);
    const sourceFile = path.join(fullDir, 'source.sqlite3');
    const source = new SourceLedgerStore({ dbPath: sourceFile });
    source.initialize();
    source.close();
    const Database = require('better-sqlite3');
    const db = new Database(sourceFile);
    let quick, full;
    try {
      db.unsafeMode(true);
      db.exec('CREATE TABLE issue64_probe(a TEXT, b TEXT); CREATE INDEX issue64_index ON issue64_probe(a)');
      db.prepare('INSERT INTO issue64_probe(a, b) VALUES (?, ?)').run('aaa', 'bbb');
      db.exec('PRAGMA writable_schema=ON');
      assert.equal(db.pragma('writable_schema', { simple: true }), 1);
      db.prepare('UPDATE sqlite_schema SET sql = ? WHERE name = ?')
        .run('CREATE INDEX issue64_index ON issue64_probe(b)', 'issue64_index');
      db.exec('PRAGMA writable_schema=OFF');
      db.pragma(`schema_version = ${db.pragma('schema_version', { simple: true }) + 1}`);
      quick = db.pragma('quick_check(1)', { simple: true });
      full = db.pragma('integrity_check', { simple: true });
    } finally { db.close(); }
    assert.equal(quick, 'ok');
    assert.notEqual(full, 'ok');
    const keywordFile = path.join(fullDir, 'keyword.sqlite3');
    const keyword = new SQLiteKeywordIndex({ dbPath: keywordFile, sourceRoot: store });
    keyword.open();
    keyword.close();
    const sourceBefore = databaseFiles(sourceFile);
    const keywordBefore = databaseFiles(keywordFile);
    fullOwner = new OwnerWorkerController({ ledgerPath: sourceFile,
      keywordPath: keywordFile, sourceRoot: store,
      publicationRoot: store, keywordTokenizerProvider: 'basic' });
    await assert.rejects(fullOwner.start(), /owner_start_failed/);
    await waitFor(() => fullOwner.worker === null);
    assert.equal(fullOwner.getStatus().state, 'CORRUPT_DEGRADED',
      'full integrity failure is classified even when quick_check reports ok');
    assert.deepEqual(fullOwner.lastStartAudit?.opens, [],
      'corrupt source preflight opens no production SQLite writer');
    assert.deepEqual(databaseFiles(sourceFile), sourceBefore,
      'source corruption leaves source DB and sidecars unchanged');
    assert.deepEqual(databaseFiles(keywordFile), keywordBefore,
      'source corruption leaves keyword DB and sidecars unchanged');
  } finally {
    if (fullOwner?.worker) await fullOwner.worker.terminate();
    fs.rmSync(fullDir, { recursive: true, force: true });
  }
}

run().then(() => console.log('retry-check contract passed'), error => {
  console.error(error);
  process.exitCode = 1;
});
