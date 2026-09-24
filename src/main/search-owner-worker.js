'use strict';

const { parentPort, threadId, workerData } = require('node:worker_threads');
const { SourceLedgerStore } = require('./source-ledger-store');
const { SQLiteKeywordIndex } = require('./search-sqlite-store');
const { createKeywordTokenizer } = require('./search-tokenizer');
const { createWorkUnitScheduler } = require('./search-work-scheduler');

const opened = [];
function loadDatabase(role) {
  const Database = require('better-sqlite3');
  return class AuditedDatabase extends Database {
    constructor(file, options) {
      super(file, options);
      opened.push({ role, threadId });
    }
  };
}
let ledger = null;
let keyword = null;
let started = false;
let keywordReady = false;
let lastSnapshot = null;
const seen = new Set();
let sequence = 0;
let closing = false;
const scheduler = createWorkUnitScheduler({ capacity: 32 });
let fixtureWrite = null;

function status(state, diagnosticCode = null, patch = {}) {
  lastSnapshot = {
    state, active: false, phase: null, progress: { current: 0, total: 0 },
    currentPath: null, heartbeatAt: new Date().toISOString(), cancelRequested: false,
    diagnostic: diagnosticCode ? { code: diagnosticCode } : null,
    ...patch
  };
  parentPort.postMessage({ tag: 'STATUS', sequence: ++sequence, snapshot: lastSnapshot });
}

function result(id, value, code) {
  parentPort.postMessage({ tag: 'RESULT', id, ...(code ? { error: { code } } : { value }) });
}

async function dispatch(message) {
  const { tag, id, type, payload = {} } = message || {};
  if (tag === 'START') {
    if (started || closing) { result(id, null, 'owner_duplicate_start'); return; }
    started = true;
    try {
      const config = message.ownerConfig || {};
      const tokenizer = createKeywordTokenizer({
        provider: config.keywordTokenizerProvider || 'garu',
        maxAnalysisChars: config.keywordTokenizerMaxAnalysisChars
      });
      await tokenizer.initialize();
      ledger = new SourceLedgerStore({ dbPath: config.ledgerPath, loadDatabase: () => loadDatabase('ledger') });
      keyword = new SQLiteKeywordIndex({ dbPath: config.keywordPath, sourceRoot: config.sourceRoot,
        tokenizer,
        loadDatabase: () => loadDatabase('keyword') });
      ledger.initialize();
      keyword.open();
      if (workerData?.r3SchedulerFixture === true) {
        const db = keyword.open();
        db.exec('CREATE TABLE IF NOT EXISTS r3_scheduler_units (target TEXT NOT NULL, ordinal INTEGER NOT NULL, digest INTEGER NOT NULL, PRIMARY KEY(target, ordinal))');
        const insert = db.prepare('INSERT INTO r3_scheduler_units VALUES (?, ?, ?)');
        fixtureWrite = db.transaction((target, ordinal, iterations) => {
          let digest = ordinal;
          for (let i = 0; i < iterations; i += 1) digest = (Math.imul(digest, 33) + i) | 0;
          insert.run(target, ordinal, digest);
        });
      }
      const health = keyword.open().prepare('PRAGMA integrity_check').get();
      if (!health || Object.values(health)[0] !== 'ok') throw new Error('keyword integrity');
      const committed = keyword.getCommittedGeneration();
      let keywordDiagnostic = committed ? null : 'keyword_index_missing';
      if (committed && !config.sourceRoot) keywordDiagnostic = 'keyword_source_not_configured';
      if (committed && !keywordDiagnostic) {
        try { keyword.assertSourceRoot(); }
        catch { keywordDiagnostic = 'keyword_source_mismatch'; }
        if (!keywordDiagnostic) {
          const stored = keyword.loadIndexMetadata();
          const expected = keyword.tokenizer.getIndexMetadata();
          if (Object.entries(expected).some(([key, value]) => stored[key] !== String(value || ''))) {
            keywordDiagnostic = 'keyword_tokenizer_mismatch';
          }
        }
      }
      keywordReady = !keywordDiagnostic;
      status(keywordDiagnostic ? 'stale' : 'ready', keywordDiagnostic);
      const ledgerOpen = opened.find(item => item.role === 'ledger');
      const keywordOpen = opened.find(item => item.role === 'keyword');
      parentPort.postMessage({ tag: 'START', state: 'ready', threadId, audit: {
        ledgerOpenThreadId: ledgerOpen.threadId, keywordOpenThreadId: keywordOpen.threadId, openCount: opened.length
      } });
    } catch {
      status('failed');
      parentPort.postMessage({ tag: 'START', state: 'failed', error: { code: 'owner_start_failed' } });
      if (ledger) ledger.close();
      if (keyword) keyword.close();
      parentPort.close();
    }
    return;
  }
  if (tag === 'SHUTDOWN') {
    closing = true;
    status('shutdown');
    if (ledger) ledger.close();
    if (keyword) keyword.close();
    result(id, { shutdown: true });
    parentPort.close();
    return;
  }
  if (!id || typeof id !== 'string' || seen.has(id)) {
    result(id, null, 'owner_duplicate_id');
    return;
  }
  seen.add(id);
  if (closing) { result(id, null, 'owner_shutdown'); return; }
  if (!started || !ledger || !keyword) { result(id, null, 'owner_not_ready'); return; }
  try {
    if (tag === 'QUERY' && type === 'get_status') {
      result(id, { ...lastSnapshot, sequence });
    } else if (tag === 'QUERY' && type === 'resolve_origin') {
      result(id, ledger.getIndexedDocumentOpenTargetInternal({ documentId: payload.documentId, filePath: payload.filePath }));
    } else if (tag === 'QUERY' && type === 'query_keyword') {
      if (fixtureWrite && payload.r3SchedulerCount === true) {
        result(id, keyword.open().prepare('SELECT count(*) AS count FROM r3_scheduler_units').get());
        return;
      }
      const committed = keywordReady ? keyword.getCommittedGeneration() : null;
      result(id, committed ? keyword.search(payload.query || '', { limit: 20 }) : []);
    } else if (tag === 'CANCEL' && typeof message.target === 'string') {
      const cancelled = scheduler.cancel(message.target);
      if (cancelled) status('indexing', null, {
        active: true, phase: 'cancel_requested', cancelRequested: true,
        progress: lastSnapshot?.progress || { current: 0, total: 0 }
      });
      result(id, { cancelled });
    } else if (tag === 'COMMAND' && type === 'accept_save') {
      if (!fixtureWrite || !Number.isInteger(payload.r3SchedulerUnits) || payload.r3SchedulerUnits < 1 ||
          payload.r3SchedulerUnits > 20000 || typeof payload.testTarget !== 'string' || !payload.testTarget) {
        result(id, null, 'owner_not_implemented');
        return;
      }
      let current = 0;
      const total = payload.r3SchedulerUnits;
      const iterations = Number.isInteger(payload.r3SchedulerCpuIterations) &&
        payload.r3SchedulerCpuIterations >= 90000 && payload.r3SchedulerCpuIterations <= 500000
        ? payload.r3SchedulerCpuIterations : 90000;
      const target = payload.testTarget;
      const accepted = scheduler.enqueue({
        id: target,
        runUnit() { fixtureWrite(target, ++current, iterations); return current >= total; },
        onProgress() {
          status('indexing', null, { active: true, phase: 'fixture', progress: { current, total } });
        },
        onDone(cancelled, error) {
          status(keywordReady ? 'ready' : 'stale', keywordReady ? null : 'keyword_index_missing');
          result(id, { cancelled, current }, error ? 'owner_operation_failed' : null);
        }
      });
      if (!accepted) result(id, null, 'owner_ingress_capacity');
    } else if (tag === 'COMMAND' && type === 'shutdown') {
      await dispatch({ tag: 'SHUTDOWN', id });
    } else {
      result(id, null, 'owner_unknown_type');
    }
  } catch {
    result(id, null, 'owner_operation_failed');
  }
}

parentPort.on('message', message => { void dispatch(message); });
