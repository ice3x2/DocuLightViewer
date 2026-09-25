'use strict';

const { parentPort, threadId, workerData } = require('node:worker_threads');
const { SourceLedgerStore } = require('./source-ledger-store');
const { SQLiteKeywordIndex } = require('./search-sqlite-store');
const { createKeywordTokenizer } = require('./search-tokenizer');
const { createWorkUnitScheduler } = require('./search-work-scheduler');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { readPendingSave } = require('./index-ingress-store');
const { parseFrontmatter } = require('./frontmatter');
const { runClaimedDesiredJob } = require('./desired-job-processor');
const { deriveValidatedDocument } = require('./derived-document-indexer');
const { SearchEngine } = require('./search-engine');
const { redactToken } = require('./redaction');

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
let legacyMigrationCursor = {};
let recoveryReady = false;
let recoveryComplete = false;
let legacyBlockedCount = 0;
const documentCancel = workerData?.documentCancelBuffer
  ? new Int32Array(workerData.documentCancelBuffer) : null;
let documentCancelRevision = 0;
let maintenanceJob = null;
let maintenancePromise = null;
let maintenanceReadOnlyKeyword = null;
let interruptedMaintenanceFound = false;

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
  if (closing || maintenanceJob || !derivationEnabled || !ledger || !keyword || !sourceRoot || !ingressRoot) return;
  if (draining) { drainRequested = true; return; }
  if (drainTimer) return;
  drainTimer = setTimeout(() => { drainTimer = null; void drainDesiredPage(); }, delay);
}

async function drainDesiredPage() {
  if (closing || draining || maintenanceJob) return;
  draining = true;
  let retry = false;
  let more = false;
  try {
    const pending = ledger.getPendingDesiredPage({ limit: 16 });
    for (const item of pending) {
      if (closing || maintenanceJob) break;
      const claim = ledger.claimDesiredJob(item);
      if (!claim) continue;
      const cancelToken = ++documentCancelRevision * 4 + 1;
      if (documentCancel) Atomics.store(documentCancel, 0, cancelToken);
      status('indexing', keywordDiagnosticCode, { active: true, phase: 'index_document', jobId: claim.jobId,
        cancelToken, progress: { current: 0, total: 1 } });
      const shouldCancel = () => {
        if (!documentCancel || Atomics.load(documentCancel, 0) !== cancelToken + 1) return false;
        ledger.updateIndexJob(claim.jobId, { cancelRequested: true });
        return true;
      };
      const beginCommit = () => !documentCancel
        || Atomics.compareExchange(documentCancel, 0, cancelToken, cancelToken + 2) === cancelToken;
      const onProgress = (current, total) => status('indexing', keywordDiagnosticCode,
        { active: true, phase: 'index_document', jobId: claim.jobId, cancelToken,
          progress: { current, total } });
      const result = await runClaimedDesiredJob({ ledger, claim, storeRoot: sourceRoot, ingressRoot,
        onValidated: async () => shouldCancel() ? { cancelled: true } : null,
        onFinalValidated: validated => deriveValidatedDocument({ ledger, keyword, claim,
          storeRoot: sourceRoot, validated, shouldCancel, beginCommit, onProgress,
          deferKeyword: keywordDiagnosticCode === 'keyword_source_mismatch'
            || keywordDiagnosticCode === 'keyword_tokenizer_mismatch' }) });
      status('indexing', keywordDiagnosticCode, { active: false, phase: result.cancelled ? 'cancelled' :
        result.completed ? 'completed' : 'retryable', jobId: claim.jobId,
        progress: { current: 1, total: 1 } });
      if (!result.completed && !result.cancelled) retry = true;
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
  if (workerData?.r3RecoveryBarrier && !recoveryCursor) {
    const barrier = new Int32Array(workerData.r3RecoveryBarrier);
    Atomics.wait(barrier, 0, 0, 5000);
  }
  const page = ledger.reconcileInterruptedDesiredPage({ afterJobId: recoveryCursor, limit: 32 });
  recoveryCursor = page.afterJobId;
  if (page.hasMore) setImmediate(resumeInterruptedJobs);
  else {
    recoveryComplete = true;
    status(keywordReady ? 'ready' : 'stale', keywordDiagnosticCode);
    resumeInterruptedMaintenance();
    scheduleDesiredDrain();
  }
}

// @req FR-DOC-019 AC-10 REL-DOC-008 AC-4 AC-5
function resumeInterruptedMaintenance() {
  if (closing || maintenanceJob) return;
  const rows = ledger.open().prepare(`SELECT job_id, job_type, cancel_requested, requested_by FROM index_jobs
    WHERE job_type IN ('keyword_rebuild', 'keyword_clear') AND status IN ('queued', 'indexing')
    ORDER BY created_at, job_id LIMIT 16`).all();
  for (const row of rows) {
    const clearCommitted = row.job_type === 'keyword_clear'
      && Boolean(keyword.open().prepare('SELECT 1 FROM keyword_clear_receipts WHERE job_id = ?')
        .get(row.job_id));
    ledger.updateIndexJob(row.job_id, { status: clearCommitted ? 'completed'
      : row.cancel_requested ? 'cancelled' : 'failed',
      phase: clearCommitted ? 'completed' : 'interrupted', finishedAt: true,
      diagnosticCode: clearCommitted ? 'interrupted_clear_committed'
        : row.job_type === 'keyword_clear' ? 'interrupted_clear_preserved'
          : row.cancel_requested ? 'interrupted_rebuild_cancelled' : 'interrupted_rebuild_restarted' });
  }
  if (rows.some(row => row.job_type === 'keyword_rebuild' && !row.cancel_requested && ['settings.rebuild',
    'settings.retry-failures', 'startup.rebuild.interrupted'].includes(row.requested_by))) {
    interruptedMaintenanceFound = true;
  }
  if (rows.length === 16) { setImmediate(resumeInterruptedMaintenance); return; }
  if (interruptedMaintenanceFound) {
    interruptedMaintenanceFound = false;
    beginMaintenance('rebuild', 'startup.rebuild.interrupted');
  }
}

async function* markdownFiles(directory, depth = 0) {
  if (depth >= 10) return;
  let dir;
  try { dir = await fs.promises.opendir(directory); } catch { return; }
  for await (const entry of dir) {
    if (entry.name.startsWith('.')) continue;
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* markdownFiles(filePath, depth + 1);
    else if (entry.isFile() && entry.name.endsWith('.md')) yield filePath;
  }
}

// @req FR-DOC-019 AC-6 AC-10 REL-DOC-007
async function readIndexableMarkdown(filePath, realPath, parser, job) {
  const decoder = new StringDecoder('utf8');
  const contentHash = crypto.createHash('sha256');
  const bodyHash = crypto.createHash('sha256');
  let prefix = '';
  let first = true;
  for await (const bytes of fs.createReadStream(realPath, { highWaterMark: 64 * 1024 })) {
    if (job.cancelRequested || closing) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    const text = decoder.write(bytes);
    contentHash.update(text);
    if (first) {
      first = false;
      prefix = text.slice(0, 2400);
      const frontmatter = prefix.slice(0, 1200).match(/^---\r?\n([\s\S]*?\r?\n)?---\r?\n?/);
      bodyHash.update(text.slice(frontmatter ? frontmatter[0].length : 0));
    } else bodyHash.update(text);
  }
  const trailing = decoder.end();
  if (first && !trailing) return null;
  if (trailing) {
    contentHash.update(trailing);
    bodyHash.update(trailing);
    if (first) prefix = trailing;
  }
  const item = parser._indexDocument(filePath, prefix, null, new Map());
  item.contentHash = contentHash.digest('hex');
  item.textHash = bodyHash.digest('hex');
  return item;
}

function maintenanceSnapshot(job, phase, currentPath = null) {
  const kind = job.operation || 'rebuild';
  status(kind === 'rebuild' || kind === 'retry' ? 'rebuilding' : `${kind}ing`, null,
    { active: true, kind: kind === 'retry' ? 'rebuild' : kind, jobId: job.id, phase,
    cancelRequested: job.cancelRequested, currentPath: currentPath ? path.relative(sourceRoot, currentPath) : null,
    progress: { current: job.indexed, total: job.total },
    rebuildSession: { active: true, indexedCount: job.indexed,
      pendingCount: Math.max(0, job.total - job.indexed), totalCount: job.total,
      currentPath: currentPath ? path.relative(sourceRoot, currentPath) : null } });
}

async function runMaintenance(job) {
  let stage = null;
  try {
    const parser = new SearchEngine({ get: () => sourceRoot }, { disableIndexingWorkerController: true });
    stage = keyword.beginStagedRebuild([]);
    const startedAt = Date.now();
    for (let pass = 0; pass < 3; pass += 1) {
      const page = [];
      let changed = 0;
      for await (const filePath of markdownFiles(sourceRoot)) {
        if (job.cancelRequested || closing) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
        const real = await fs.promises.realpath(filePath);
        const canonicalRoot = validatedPublicationRoot();
        if (!canonicalRoot || (real !== canonicalRoot
          && !real.startsWith(`${canonicalRoot}${path.sep}`))) continue;
        if (pass > 0) {
          const exists = keyword.open().prepare(`SELECT 1 FROM keyword_rebuild_staging_documents
            WHERE generation_id = ? AND file_path = ?`).get(stage.generationId, filePath);
          if (exists && (await fs.promises.stat(real)).mtimeMs < startedAt) continue;
        }
        const item = await readIndexableMarkdown(filePath, real, parser, job);
        if (!item) continue;
        page.push(item);
        changed += 1;
        if (page.length === 16) {
          keyword.appendStagedRebuildPage(stage, page);
          job.indexed = keyword.open().prepare(`SELECT COUNT(*) AS count FROM keyword_rebuild_staging_documents
            WHERE generation_id = ?`).get(stage.generationId).count;
          job.total = Math.max(job.total, job.indexed);
          ledger.updateIndexJob(job.id, { status: 'indexing', phase: 'scan',
            progressCurrent: job.indexed, progressTotal: job.total });
          maintenanceSnapshot(job, 'scan', filePath);
          page.length = 0;
          await new Promise(resolve => setTimeout(resolve,
            workerData?.r3MaintenancePageDelayMs || 0));
        }
      }
      if (page.length) {
        keyword.appendStagedRebuildPage(stage, page);
        job.indexed = keyword.open().prepare(`SELECT COUNT(*) AS count FROM keyword_rebuild_staging_documents
          WHERE generation_id = ?`).get(stage.generationId).count;
        job.total = Math.max(job.total, job.indexed);
        maintenanceSnapshot(job, pass ? 'catch_up' : 'scan', page.at(-1).filePath);
      }
      if (pass > 0 && changed === 0) break;
    }
    if (job.cancelRequested || closing) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    if (workerData?.r3MaintenanceFaultBeforeCommit) throw new Error('r3_fault_before_commit');
    maintenanceSnapshot(job, 'commit');
    const committed = keyword.commitStagedGeneration(stage, {
      shouldCancel: () => job.cancelRequested || closing });
    keywordReady = true;
    keywordDiagnosticCode = null;
    let afterDocumentId = '';
    while (true) {
      const page = ledger.requeueDerivedAfterKeywordRebuildPage({ sourceRoot,
        maintenanceJobId: job.id, afterDocumentId, limit: 16 });
      afterDocumentId = page.afterDocumentId;
      if (!page.hasMore) break;
      await new Promise(resolve => setImmediate(resolve));
    }
    ledger.updateIndexJob(job.id, { status: 'completed', phase: 'completed', finishedAt: true,
      progressCurrent: committed.documentCount, progressTotal: committed.documentCount });
    status('ready', null, { active: false, kind: 'rebuild', jobId: job.id,
      phase: 'completed', progress: { current: committed.documentCount, total: committed.documentCount },
      rebuildSession: { active: false, indexedCount: committed.documentCount,
        pendingCount: 0, totalCount: committed.documentCount, currentPath: null } });
  } catch (error) {
    const cancelled = error.code === 'cancelled' || job.cancelRequested;
    ledger.updateIndexJob(job.id, { status: cancelled ? 'cancelled' : 'failed',
      phase: cancelled ? 'cancelled' : 'failed', finishedAt: true,
      diagnosticCode: cancelled ? 'index_rebuild_cancelled' : 'index_rebuild_failed' });
    status(cancelled ? (keywordReady ? 'ready' : 'stale') : 'stale',
      cancelled ? 'index_rebuild_cancelled' : 'index_rebuild_failed',
      { active: false, kind: 'rebuild', jobId: job.id, phase: cancelled ? 'cancelled' : 'failed',
        rebuildSession: { active: false, indexedCount: job.indexed,
          pendingCount: 0, totalCount: job.total, currentPath: null } });
  } finally {
    maintenanceJob = null;
    scheduleDesiredDrain();
  }
}

// @req FR-DOC-019 AC-6 AC-10 REL-DOC-004 REL-DOC-007
async function runClearMaintenance(job) {
  const db = keyword.open();
  const backupPath = `${keyword.dbPath}.backup-clear-${crypto.randomUUID()}.sqlite3`;
  let transactionOpen = false;
  let committed = false;
  try {
    const oldGeneration = keyword.getCommittedGeneration();
    maintenanceSnapshot(job, 'backup');
    await db.backup(backupPath, { progress: progress => {
      if (job.cancelRequested || closing) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      job.total = progress.totalPages;
      job.indexed = progress.totalPages - progress.remainingPages;
      maintenanceSnapshot(job, 'backup');
      return 32;
    } });
    if (job.cancelRequested || closing) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    const BackupDatabase = loadDatabase('clear-backup-check');
    const backup = new BackupDatabase(backupPath, { readonly: true, fileMustExist: true });
    try {
      if (backup.pragma('quick_check(1)', { simple: true }) !== 'ok'
        || backup.prepare("SELECT value FROM keyword_index_meta WHERE key = 'committed_generation'").get()?.value
          !== oldGeneration?.generationId
        || backup.prepare('SELECT COUNT(*) AS count FROM keyword_documents').get().count
          !== db.prepare('SELECT COUNT(*) AS count FROM keyword_documents').get().count) {
        throw new Error('clear_backup_validation_failed');
      }
    } finally { backup.close(); }
    maintenanceReadOnlyKeyword = new SQLiteKeywordIndex({ dbPath: keyword.dbPath,
      sourceRoot, readOnly: true, tokenizer: keyword.tokenizer });
    maintenanceReadOnlyKeyword.open();
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const batches = [
      ['keyword_fts', 'rowid'], ['keyword_segments', 'segment_id'],
      ['keyword_documents', 'rowid']
    ];
    for (const [table, key] of batches) {
      while (true) {
        if (job.cancelRequested || closing) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
        const ids = db.prepare(`SELECT ${key} AS id FROM ${table} LIMIT 128`).all().map(row => row.id);
        if (!ids.length) break;
        db.prepare(`DELETE FROM ${table} WHERE ${key} IN (${ids.map(() => '?').join(',')})`).run(...ids);
        job.indexed += ids.length;
        maintenanceSnapshot(job, 'clear');
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    db.prepare("DELETE FROM keyword_index_meta WHERE key IN ('committed_generation', 'committed_revision', 'committed_document_count', 'last_rebuilt_at')").run();
    db.prepare('INSERT INTO keyword_clear_receipts(job_id, committed_at) VALUES (?, ?)')
      .run(job.id, new Date().toISOString());
    if (job.cancelRequested || closing) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    if (workerData?.r3MaintenanceFaultBeforeCommit) throw new Error('r3_fault_before_commit');
    maintenanceSnapshot(job, 'commit');
    db.exec('COMMIT');
    transactionOpen = false;
    committed = true;
    keywordReady = false;
    keywordDiagnosticCode = 'keyword_index_missing';
    const backupPathToken = redactToken('PATH', backupPath);
    if (workerData?.r3MaintenanceFaultAfterCommit) throw new Error('r3_fault_after_commit');
    ledger.updateIndexJob(job.id, { status: 'completed', phase: 'completed', finishedAt: true });
    status('stale', keywordDiagnosticCode, { active: false, kind: 'clear', jobId: job.id,
      phase: 'completed', backupPath: backupPathToken });
  } catch (error) {
    if (transactionOpen) db.exec('ROLLBACK');
    if (committed) {
      status('stale', 'index_clear_ledger_finalize_pending', { active: false,
        kind: 'clear', jobId: job.id, phase: 'completed',
        backupPath: redactToken('PATH', backupPath) });
      return;
    }
    const cancelled = error.code === 'cancelled' || job.cancelRequested;
    ledger.updateIndexJob(job.id, { status: cancelled ? 'cancelled' : 'failed',
      phase: cancelled ? 'cancelled' : 'failed', finishedAt: true,
      diagnosticCode: cancelled ? 'index_clear_cancelled' : 'index_clear_failed' });
    status(keywordReady ? 'ready' : 'stale', cancelled ? 'index_clear_cancelled' : 'index_clear_failed',
      { active: false, kind: 'clear', jobId: job.id, phase: cancelled ? 'cancelled' : 'failed' });
  } finally {
    if (maintenanceReadOnlyKeyword) maintenanceReadOnlyKeyword.close();
    maintenanceReadOnlyKeyword = null;
    maintenanceJob = null;
    scheduleDesiredDrain();
  }
}

function beginMaintenance(operation, requestedBy = 'settings.rebuild') {
  if (!['rebuild', 'retry', 'compact', 'clear'].includes(operation)) return { started: false, scheduled: false,
    reason: 'unsupported-operation' };
  if (!recoveryReady || !recoveryComplete) return {
    started: false, scheduled: false, reason: 'owner-recovery-pending' };
  const allowed = operation === 'compact' || operation === 'clear'
    ? ['ready', 'READY', 'READY_KEYWORD_ONLY', 'READY_MAINTENANCE_PENDING']
    : ['ready', 'stale', 'READY', 'READY_KEYWORD_ONLY',
      'READY_KEYWORD_DEGRADED', 'READY_MAINTENANCE_PENDING'];
  if (!allowed.includes(lastSnapshot?.state)
    || lastSnapshot.active === true) return {
    started: false, scheduled: false, reason: 'job-in-progress' };
  if (maintenanceJob || draining || !sourceRoot || !ledger || !keyword) return {
    started: false, scheduled: false, reason: 'job-in-progress' };
  if (operation === 'compact') return { started: false, scheduled: false, compacted: false,
    reason: 'compact-rebuild-required' };
  const kind = operation === 'clear' ? 'clear' : 'rebuild';
  const id = `keyword-${kind}-${crypto.randomUUID()}`;
  ledger.enqueueIndexJob({ jobId: id, jobType: `keyword_${kind}`, status: 'queued', requestedBy });
  maintenanceJob = { id, operation, cancelRequested: false, indexed: 0, total: 0 };
  maintenanceSnapshot(maintenanceJob, 'queued');
  setImmediate(() => {
    if (maintenanceJob) maintenancePromise = (operation === 'clear'
      ? runClearMaintenance(maintenanceJob) : runMaintenance(maintenanceJob))
      .finally(() => { maintenancePromise = null; });
  });
  return { started: true, scheduled: true, jobId: id };
}

function resumeLegacyMigration() {
  if (closing || !ledger) return;
  if (workerData?.r3MigrationBarrier && !legacyMigrationCursor.afterJobId) {
    const barrier = new Int32Array(workerData.r3MigrationBarrier);
    Atomics.wait(barrier, 0, 0, 5000);
  }
  let page;
  try {
    page = ledger.migrateLegacyIndexJobsPage({ storeRoot: sourceRoot,
      ...legacyMigrationCursor, limit: 32 });
  } catch {
    status('stale', 'legacy_migration_failed');
    return;
  }
  if (workerData?.r3MigrationPageAudit) {
    const audit = new Int32Array(workerData.r3MigrationPageAudit);
    Atomics.store(audit, 0, Math.max(Atomics.load(audit, 0), page.pageSize || 0));
    Atomics.add(audit, 1, 1);
  }
  legacyMigrationCursor = { afterCreatedAt: page.afterCreatedAt, afterJobId: page.afterJobId };
  if (page.hasMore) { setImmediate(resumeLegacyMigration); return; }
  recoveryReady = true;
  legacyBlockedCount = page.blocked || 0;
  status(keywordReady ? 'ready' : 'stale', keywordDiagnosticCode,
    legacyBlockedCount ? { legacyMigration: { blocked: legacyBlockedCount } } : {});
  setImmediate(resumeInterruptedJobs);
  if (workerData?.r3SkipStartupReplay !== true) resumePrivateIntents();
}

function resumePrivateIntents() {
  if (!ingressRoot || closing) return;
  let directory;
  try { directory = fs.opendirSync(ingressRoot); }
  catch { return; }
  let failed = false;
  let progressed = false;
  const unit = () => {
    if (closing) { directory.closeSync(); return; }
    const entry = directory.readSync();
    if (entry) {
      if (!/^[a-f0-9]{64}\.intent\.json$/.test(entry.name)) { setImmediate(unit); return; }
      const reply = acceptPublishedSave({ intentId: entry.name.slice(0, 64) });
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
    directory.closeSync();
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
    if (!recoveryReady) return failed;
    const publishedRoot = validatedPublicationRoot();
    if (!publishedRoot || !ingressRoot || typeof payload.intentId !== 'string'
      || (payload.rootFingerprint && payload.rootFingerprint !== crypto.createHash('sha256')
        .update(path.resolve(publishedRoot)).digest('hex'))) return failed;
    const reply = receipt => receipt.receipt_kind === 'queued'
      ? { saved: true, accepted: true, indexingState: 'queued', indexing: { state: 'queued', jobId: receipt.job_id },
        desiredRevision: receipt.desired_revision, documentId: receipt.document_id, warnings: [] }
      : { saved: true, accepted: true, indexingState: 'provenance_only',
        desiredRevision: null, documentId: receipt.document_id, warnings: [] };
    const receipt = ledger.getSaveIntentReceipt(payload.intentId);
    if (receipt) {
      if (receipt.root_fingerprint !== crypto.createHash('sha256').update(path.resolve(publishedRoot)).digest('hex')) return failed;
      if ((payload.sourceId && payload.sourceId !== receipt.source_id)
        || (payload.sourceRelativeLocator && payload.sourceRelativeLocator !== receipt.relative_locator)
        || (payload.contentHash && payload.contentHash !== receipt.content_hash)) return failed;
      const persisted = readPendingSave({ ingressRoot, storeRoot: publishedRoot,
        intentId: payload.intentId });
      if (persisted?.retryable || persisted?.quarantined) return failed;
      if (persisted?.intentPath) {
        try { fs.unlinkSync(persisted.intentPath); } catch { /* retry cleanup on later replay */ }
      }
      return reply(receipt);
    }
    const read = intentId => readPendingSave({ ingressRoot, storeRoot: publishedRoot, intentId });
    const current = read(payload.intentId);
    if (!current || current.retryable || current.quarantined) return failed;
    if (!current.published) return failed;
    if (['operation', 'sourceId', 'rootFingerprint', 'sourceRelativeLocator', 'contentHash', 'provenance']
      .some(key => payload[key] !== undefined
        && JSON.stringify(payload[key]) !== JSON.stringify(current[key]))) return failed;
    const finalPath = path.resolve(publishedRoot, current.sourceRelativeLocator);
    const bytes = fs.readFileSync(finalPath);
    if (bytes.length > 10 * 1024 * 1024 || crypto.createHash('sha256').update(bytes).digest('hex') !== current.contentHash) return failed;
    const pending = [];
    let retryable = false;
    const directory = fs.opendirSync(ingressRoot);
    try {
      let entry;
      while ((entry = directory.readSync())) {
        if (!/^[a-f0-9]{64}\.intent\.json$/.test(entry.name)
          || entry.name.slice(0, 64) === current.intentId) continue;
        const id = entry.name.slice(0, 64);
        const intent = payload.r3ReadFaultIntentId === id ? { retryable: true } : read(id);
        if (intent?.retryable) retryable = true;
        else if (intent && !intent.quarantined && intent.sourceId === current.sourceId
          && intent.sourceRelativeLocator === current.sourceRelativeLocator) pending.push(intent);
      }
    } finally { directory.closeSync(); }
    if (retryable) return failed;
    const orderOf = intent => Number.isSafeInteger(intent.publicationOrder) ? intent.publicationOrder : null;
    const notOlder = intent => {
      const left = orderOf(intent);
      const right = orderOf(current);
      if (left !== null && right !== null) return left >= right;
      return intent.createdTime >= current.createdTime;
    };
    if (pending.some(intent => intent
      && !ledger.getSaveIntentReceipt(intent.intentId)
      && notOlder(intent))) return failed;
    const historical = pending.filter(intent => intent
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
    if (accepted.receiptKind === 'provenance_only') return { saved: true, accepted: true,
      indexingState: 'provenance_only', desiredRevision: null,
      documentId: accepted.documentId, warnings: [] };
    return { saved: true, accepted: true, indexingState: 'queued', indexing: { state: 'queued', jobId: accepted.jobId },
      desiredRevision: accepted.desiredRevision, documentId: accepted.documentId, warnings: [] };
  } catch {
    return failed;
  }
}

// @req FR-DOC-019 AC-10 FR-DOC-035 AC-13
async function adoptContained(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).length !== 1 || typeof payload.sourceRelativeLocator !== 'string') {
    throw Object.assign(new Error('invalid locator'), { code: 'owner_invalid_adopt_contained_payload' });
  }
  const locator = payload.sourceRelativeLocator;
  if (!locator || path.isAbsolute(locator) || locator.includes('\\') || locator.includes(':')
    || locator.split('/').some(part => !part || part === '.' || part === '..')
    || !/\.(?:md|markdown)$/i.test(locator)) {
    throw Object.assign(new Error('invalid locator'), { code: 'owner_invalid_adopt_contained_payload' });
  }
  const canonicalRoot = validatedPublicationRoot();
  if (!canonicalRoot || !recoveryReady) {
    throw Object.assign(new Error('owner unavailable'), { code: 'owner_not_ready' });
  }
  const lexicalPath = path.resolve(sourceRoot, locator);
  const within = (candidate, root) => candidate !== root && candidate.startsWith(`${root}${path.sep}`);
  if (!within(lexicalPath, path.resolve(sourceRoot))) {
    throw Object.assign(new Error('invalid locator'), { code: 'owner_invalid_adopt_contained_payload' });
  }
  let handle;
  const raceGate = workerData?.r3AdoptRaceBuffer
    && payload.sourceRelativeLocator === workerData.r3AdoptRaceLocator
    ? new Int32Array(workerData.r3AdoptRaceBuffer) : null;
  const pauseRace = phase => {
    if (!raceGate) return;
    Atomics.store(raceGate, 0, phase);
    Atomics.notify(raceGate, 0);
    while (Atomics.load(raceGate, 1) < phase) Atomics.wait(raceGate, 1, phase - 1, 1000);
  };
  try {
    const canonicalBefore = fs.realpathSync.native(lexicalPath);
    if (!within(canonicalBefore, canonicalRoot)) throw new Error('outside root');
    const targetBefore = fs.statSync(canonicalBefore);
    pauseRace(1);
    handle = await fs.promises.open(lexicalPath, 'r');
    pauseRace(2);
    const before = await handle.stat();
    if (!before.isFile() || before.size > 10 * 1024 * 1024
      || before.dev !== targetBefore.dev || before.ino !== targetBefore.ino) {
      throw new Error('not bounded canonical regular file');
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error('short read');
      offset += read.bytesRead;
    }
    const afterFirstRead = await handle.stat();
    const confirmBytes = Buffer.alloc(before.size);
    offset = 0;
    while (offset < confirmBytes.length) {
      const read = await handle.read(confirmBytes, offset, confirmBytes.length - offset, offset);
      if (!read.bytesRead) throw new Error('short read');
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    const canonicalAfter = fs.realpathSync.native(lexicalPath);
    const targetAfter = fs.statSync(canonicalAfter);
    if (canonicalBefore !== canonicalAfter || before.dev !== after.dev || before.ino !== after.ino
      || after.dev !== targetAfter.dev || after.ino !== targetAfter.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.mtimeMs !== afterFirstRead.mtimeMs
      || !crypto.createHash('sha256').update(bytes).digest().equals(
        crypto.createHash('sha256').update(confirmBytes).digest())
      || !within(canonicalAfter, canonicalRoot)) throw new Error('file changed');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const canonicalLocator = path.relative(canonicalRoot, canonicalAfter).replace(/\\/g, '/');
    const adopted = ledger.adoptContainedDocument({ storeRoot: sourceRoot,
      sourceRelativeLocator: canonicalLocator, canonicalPathInternal: canonicalAfter,
      content, contentHash: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
      contentByteLength: bytes.length, metadata: parseFrontmatter(content).data || {} });
    if (adopted.status === 'queued') scheduleDesiredDrain();
    return adopted;
  } finally {
    if (handle) await handle.close();
  }
}

function status(state, diagnosticCode = null, patch = {}) {
  lastSnapshot = {
    state, active: false, phase: null, progress: { current: 0, total: 0 },
    currentPath: null, heartbeatAt: new Date().toISOString(), cancelRequested: false,
    diagnostic: diagnosticCode ? { code: diagnosticCode } : null,
    migrationComplete: recoveryReady, recoveryComplete,
    ...(legacyBlockedCount ? { legacyMigration: { blocked: legacyBlockedCount } } : {}),
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
      ledger.assertLegacyMigrationMarker();
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
      setImmediate(resumeLegacyMigration);
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
    if (maintenanceJob) maintenanceJob.cancelRequested = true;
    if (maintenancePromise) await maintenancePromise;
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
      result(id, committed ? (maintenanceReadOnlyKeyword || keyword).search(payload.query || '', { limit: 20 }) : []);
    } else if (tag === 'CANCEL' && typeof message.target === 'string') {
      const maintenance = maintenanceJob && maintenanceJob.id === message.target;
      if (maintenance) {
        maintenanceJob.cancelRequested = true;
        ledger.updateIndexJob(maintenanceJob.id, { cancelRequested: true });
      }
      const cancelled = maintenance || scheduler.cancel(message.target);
      if (maintenance) status(maintenanceJob.operation === 'clear' ? 'clearing' : 'rebuilding', null, {
        active: true, kind: maintenanceJob.operation === 'retry' ? 'rebuild' : maintenanceJob.operation,
        jobId: maintenanceJob.id,
        phase: 'cancel_requested', cancelRequested: true,
        currentPath: lastSnapshot?.currentPath || null,
        progress: lastSnapshot?.progress || { current: 0, total: 0 },
        rebuildSession: lastSnapshot?.rebuildSession || null
      });
      else if (cancelled) status('indexing', null, {
        active: true, phase: 'cancel_requested', cancelRequested: true,
        progress: lastSnapshot?.progress || { current: 0, total: 0 }
      });
      result(id, { cancelled });
    } else if (tag === 'COMMAND' && type === 'manage_index') {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.keys(payload).length !== 1
        || !['rebuild', 'retry', 'compact', 'clear'].includes(payload.operation)) {
        result(id, null, 'owner_invalid_manage_index_payload');
      } else {
        result(id, beginMaintenance(payload.operation,
          payload.operation === 'retry' ? 'settings.retry-failures' : 'settings.rebuild'));
      }
    } else if (tag === 'COMMAND' && type === 'adopt_contained') {
      try { result(id, await adoptContained(payload)); }
      catch (error) { result(id, null, error.code || 'owner_adopt_contained_failed'); }
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
