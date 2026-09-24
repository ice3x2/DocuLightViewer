'use strict';

const { parentPort, threadId, workerData } = require('node:worker_threads');
const { SourceLedgerStore } = require('./source-ledger-store');
const { SQLiteKeywordIndex } = require('./search-sqlite-store');
const { createKeywordTokenizer } = require('./search-tokenizer');
const { createWorkUnitScheduler } = require('./search-work-scheduler');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readPendingSave } = require('./index-ingress-store');
const { parseFrontmatter } = require('./frontmatter');
const { runClaimedDesiredJob } = require('./desired-job-processor');
const { deriveValidatedDocument } = require('./derived-document-indexer');

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
let keywordDiagnosticCode = 'keyword_index_missing';
let lastSnapshot = null;
const seen = new Set();
let sequence = 0;
let closing = false;
const scheduler = createWorkUnitScheduler({ capacity: 32 });
let fixtureWrite = null;
let sourceRoot = null;
let publicationRoot = null;
let ingressRoot = null;
let replayTimer = null;
let replayDelay = 250;
let recoveryCursor = '';
let draining = false;
let drainRequested = false;
let drainTimer = null;
let drainDelay = 250;
let derivationEnabled = false;

function validatedPublicationRoot() {
  if (!sourceRoot || !publicationRoot) return null;
  try {
    const lexicalReal = fs.realpathSync.native(sourceRoot);
    const publishedReal = fs.realpathSync.native(publicationRoot);
    return lexicalReal === publishedReal ? publishedReal : null;
  } catch { return null; }
}

// @req FR-DOC-019 DR-DOC-014
function scheduleDesiredDrain(delay = 0) {
  if (closing || !derivationEnabled || !ledger || !keyword || !sourceRoot || !ingressRoot) return;
  if (draining) { drainRequested = true; return; }
  if (drainTimer) return;
  drainTimer = setTimeout(() => { drainTimer = null; void drainDesiredPage(); }, delay);
}

async function drainDesiredPage() {
  if (closing || draining) return;
  draining = true;
  let retry = false;
  let more = false;
  try {
    const pending = ledger.getPendingDesiredPage({ limit: 16 });
    for (const item of pending) {
      if (closing) break;
      const claim = ledger.claimDesiredJob(item);
      if (!claim) continue;
      const result = await runClaimedDesiredJob({ ledger, claim, storeRoot: sourceRoot, ingressRoot,
        onValidated: async () => {},
        onFinalValidated: validated => deriveValidatedDocument({ ledger, keyword, claim,
          storeRoot: sourceRoot, validated,
          deferKeyword: keywordDiagnosticCode === 'keyword_source_mismatch'
            || keywordDiagnosticCode === 'keyword_tokenizer_mismatch' }) });
      if (!result.completed) retry = true;
      else {
        if (keywordDiagnosticCode === 'keyword_index_missing') {
          keywordReady = Boolean(keyword.getCommittedGeneration());
          if (keywordReady) keywordDiagnosticCode = null;
        }
        status(keywordReady ? 'ready' : 'stale', keywordDiagnosticCode);
      }
    }
    const links = ledger.reconcilePendingLinkTargets({ limit: 32 });
    more = pending.length === 16 || links.hasMore;
  } catch {
    retry = true;
  } finally {
    draining = false;
    if ((more || drainRequested) && !retry) scheduleDesiredDrain();
    drainRequested = false;
    if (retry) {
      scheduleDesiredDrain(drainDelay);
      drainDelay = Math.min(drainDelay * 2, 30000);
    } else drainDelay = 250;
  }
}

function resumeInterruptedJobs() {
  if (closing || !ledger) return;
  const page = ledger.reconcileInterruptedDesiredPage({ afterJobId: recoveryCursor, limit: 32 });
  recoveryCursor = page.afterJobId;
  if (page.hasMore) setImmediate(resumeInterruptedJobs);
}

function resumePrivateIntents() {
  if (!ingressRoot || closing) return;
  let names;
  try { names = fs.readdirSync(ingressRoot).filter(name => /^[a-f0-9]{64}\.intent\.json$/.test(name)).sort(); }
  catch { return; }
  let cursor = 0;
  let failed = false;
  let progressed = false;
  const unit = () => {
    if (closing) return;
    if (cursor < names.length) {
      const reply = acceptPublishedSave({ ingressRoot, intentId: names[cursor++].slice(0, 64),
        storeRoot: publicationRoot });
      if (reply.accepted) {
        progressed = true;
        scheduleDesiredDrain();
        if (workerData?.r3ReplayFixture === true) status('stale', null, { phase: 'r3_replay_accepted' });
      } else {
        failed = true;
        if (workerData?.r3ReplayFixture === true) status('stale', null, { phase: 'r3_replay_failed' });
      }
      setImmediate(unit);
      return;
    }
    if (failed) {
      replayDelay = progressed ? 250 : Math.min(replayDelay * 2, 30000);
      replayTimer = setTimeout(() => { replayTimer = null; resumePrivateIntents(); }, replayDelay);
    } else replayDelay = 250;
  };
  setImmediate(unit);
}

// @req FR-DOC-019 REL-DOC-009 DR-DOC-014
function acceptPublishedSave(payload) {
  const failed = { saved: true, accepted: false, indexingState: 'enqueue_failed', indexing: { state: 'enqueue_failed' },
    warnings: [{ code: 'index_enqueue_failed', message: 'Document was saved but indexing enqueue failed.', retryable: true }] };
  try {
    const publishedRoot = validatedPublicationRoot();
    if (!publishedRoot || typeof payload.ingressRoot !== 'string' || typeof payload.intentId !== 'string'
      || (payload.storeRoot && path.resolve(payload.storeRoot) !== path.resolve(publishedRoot))) return failed;
    const reply = receipt => receipt.receipt_kind === 'queued'
      ? { saved: true, accepted: true, indexingState: 'queued', indexing: { state: 'queued', jobId: receipt.job_id },
        desiredRevision: receipt.desired_revision, documentId: receipt.document_id, warnings: [] }
      : { saved: true, accepted: true, indexingState: 'provenance_only',
        desiredRevision: null, documentId: receipt.document_id, warnings: [] };
    const receipt = ledger.getSaveIntentReceipt(payload.intentId);
    if (receipt) {
      if (receipt.root_fingerprint !== crypto.createHash('sha256').update(path.resolve(publishedRoot)).digest('hex')) return failed;
      const persisted = readPendingSave({ ingressRoot: payload.ingressRoot, storeRoot: publishedRoot,
        intentId: payload.intentId });
      if (persisted?.retryable || persisted?.quarantined) return failed;
      if (persisted?.intentPath) {
        try { fs.unlinkSync(persisted.intentPath); } catch { /* retry cleanup on later replay */ }
      }
      return reply(receipt);
    }
    const read = intentId => readPendingSave({ ingressRoot: payload.ingressRoot, storeRoot: publishedRoot, intentId });
    const current = read(payload.intentId);
    if (!current || current.retryable || current.quarantined) return failed;
    if (!current.published) return failed;
    const finalPath = path.resolve(publishedRoot, current.sourceRelativeLocator);
    const bytes = fs.readFileSync(finalPath);
    if (bytes.length > 10 * 1024 * 1024 || crypto.createHash('sha256').update(bytes).digest('hex') !== current.contentHash) return failed;
    const pending = fs.readdirSync(payload.ingressRoot).filter(name => /^[a-f0-9]{64}\.intent\.json$/.test(name)
      && name.slice(0, 64) !== current.intentId).map(name => {
      const id = name.slice(0, 64);
      return payload.r3ReadFaultIntentId === id ? { retryable: true } : read(id);
    });
    if (pending.some(intent => intent?.retryable)) return failed;
    const orderOf = intent => Number.isSafeInteger(intent.publicationOrder) ? intent.publicationOrder : null;
    const notOlder = intent => {
      const left = orderOf(intent);
      const right = orderOf(current);
      if (left !== null && right !== null) return left >= right;
      return intent.createdTime >= current.createdTime;
    };
    if (pending.some(intent => intent && !intent.quarantined
      && intent.sourceId === current.sourceId && intent.sourceRelativeLocator === current.sourceRelativeLocator
      && !ledger.getSaveIntentReceipt(intent.intentId)
      && notOlder(intent))) return failed;
    const historical = pending.filter(intent => intent && !intent.quarantined
      && intent.sourceId === current.sourceId && intent.sourceRelativeLocator === current.sourceRelativeLocator
      && !ledger.getSaveIntentReceipt(intent.intentId))
      .sort((a, b) => {
        if (orderOf(a) !== null && orderOf(b) !== null) return orderOf(a) - orderOf(b);
        return a.createdTime.localeCompare(b.createdTime) || a.intentId.localeCompare(b.intentId);
      });
    const accepted = ledger.acceptSaveIntent({ current, historical, storeRoot: sourceRoot,
      finalMetadata: parseFrontmatter(bytes.toString('utf8')).data,
      contentByteLength: bytes.length, contentTextLength: bytes.toString('utf8').length });
    if (payload.r3SkipCleanup !== true) {
      for (const intent of [...historical, current]) {
        if (!ledger.getSaveIntentReceipt(intent.intentId)) continue;
        try { fs.unlinkSync(intent.intentPath); } catch { /* durable receipt permits retry after cleanup failure */ }
      }
    }
    return { saved: true, accepted: true, indexingState: 'queued', indexing: { state: 'queued', jobId: accepted.jobId },
      desiredRevision: accepted.desiredRevision, documentId: accepted.documentId, warnings: [] };
  } catch {
    return failed;
  }
}

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
      sourceRoot = config.sourceRoot || null;
      publicationRoot = config.publicationRoot || sourceRoot;
      if (!validatedPublicationRoot()) throw new Error('publication root mismatch');
      ingressRoot = config.ingressRoot || null;
      derivationEnabled = config.deriveDocuments === true;
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
      resumeInterruptedJobs();
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
      keywordDiagnosticCode = keywordDiagnostic;
      status(keywordDiagnostic ? 'stale' : 'ready', keywordDiagnostic);
      const ledgerOpen = opened.find(item => item.role === 'ledger');
      const keywordOpen = opened.find(item => item.role === 'keyword');
      parentPort.postMessage({ tag: 'START', state: 'ready', threadId, audit: {
        ledgerOpenThreadId: ledgerOpen.threadId, keywordOpenThreadId: keywordOpen.threadId, openCount: opened.length
      } });
      resumePrivateIntents();
      scheduleDesiredDrain();
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
    if (replayTimer) clearTimeout(replayTimer);
    if (drainTimer) clearTimeout(drainTimer);
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
      if (!Number.isInteger(payload.r3SchedulerUnits)) {
        const accepted = acceptPublishedSave(payload);
        result(id, accepted);
        if (accepted.accepted) scheduleDesiredDrain();
        return;
      }
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
