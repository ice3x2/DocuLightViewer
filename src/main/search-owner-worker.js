'use strict';

const { parentPort, threadId } = require('node:worker_threads');
const { SourceLedgerStore } = require('./source-ledger-store');
const { SQLiteKeywordIndex } = require('./search-sqlite-store');
const { createKeywordTokenizer } = require('./search-tokenizer');

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

function status(state, diagnosticCode = null) {
  lastSnapshot = {
    state, active: false, phase: null, progress: { current: 0, total: 0 },
    currentPath: null, heartbeatAt: new Date().toISOString(), cancelRequested: false,
    diagnostic: diagnosticCode ? { code: diagnosticCode } : null
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
      const committed = keywordReady ? keyword.getCommittedGeneration() : null;
      result(id, committed ? keyword.search(payload.query || '', { limit: 20 }) : []);
    } else if (tag === 'CANCEL' && typeof message.target === 'string') {
      result(id, { cancelled: false });
    } else if (tag === 'COMMAND' && type === 'accept_save') {
      result(id, null, 'owner_not_implemented');
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
