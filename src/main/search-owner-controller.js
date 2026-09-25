'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { acquireOwnerLock } = require('./search-owner-lock');

const TYPES = Object.freeze({
  accept_save: 'COMMAND', resolve_origin: 'QUERY', query_keyword: 'QUERY',
  get_status: 'QUERY', cancel_job: 'CANCEL', manage_index: 'COMMAND', shutdown: 'COMMAND'
});

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

// @req FR-DOC-019 REL-DOC-007 IR-APP-013
class OwnerWorkerController {
  constructor(config) {
    this.config = config;
    this.worker = null;
    this.failedWorker = null;
    this.ready = null;
    this.pending = new Map();
    this.usedIds = new Set();
    this.nextId = 0;
    this.sequence = 0;
    this.workerSequence = 0;
    this.snapshot = { state: 'idle', active: false };
    this.closing = false;
    this.readyReject = null;
    this.releaseOwnerLock = null;
    this.documentCancel = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  }

  getStatus() { return { ...this.snapshot, sequence: this.sequence }; }

  async start() {
    if (this.failedWorker) {
      const failed = this.failedWorker;
      await failed.terminate();
      if (this.worker === failed) this._fail('owner_worker_failed', failed, true);
    }
    if (this.worker) return this.ready;
    this.releaseOwnerLock = acquireOwnerLock(this.config.ledgerPath);
    this.closing = false;
    this.usedIds.clear();
    this.workerSequence = 0;
    const worker = new Worker(this.config.workerPath || path.join(__dirname, 'search-owner-worker.js'), {
      workerData: { r3SchedulerFixture: this.config.r3SchedulerFixture === true,
        r3ReplayFixture: this.config.r3ReplayFixture === true,
        r3RecoveryBarrier: this.config.r3RecoveryBarrier,
        r3MigrationBarrier: this.config.r3MigrationBarrier,
        r3MigrationPageAudit: this.config.r3MigrationPageAudit,
        r3SkipStartupReplay: this.config.r3SkipStartupReplay === true,
        r3MaintenanceFaultBeforeCommit: this.config.r3MaintenanceFaultBeforeCommit === true,
        r3MaintenanceFaultAfterCommit: this.config.r3MaintenanceFaultAfterCommit === true,
        r3MaintenancePageDelayMs: this.config.r3MaintenancePageDelayMs || 0,
        documentCancelBuffer: this.documentCancel.buffer }
    });
    this.worker = worker;
    this.ready = new Promise((resolve, reject) => {
      this.readyReject = reject;
      worker.on('message', message => {
        if (worker !== this.worker) return;
        if (message.tag === 'STATUS' && message.sequence > this.workerSequence) {
          this.workerSequence = message.sequence;
          this.sequence += 1;
          this.snapshot = message.snapshot;
          if (typeof this.config.onStatus === 'function') {
            try { this.config.onStatus(this.snapshot); } catch { /* status delivery remains available */ }
          }
        } else if (message.tag === 'START') {
          this.readyReject = null;
          if (message.state === 'ready') resolve(message);
          else reject(failure(message.error?.code || 'owner_start_failed'));
        } else if (message.tag === 'RESULT') {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          if (message.error) pending.reject(failure(message.error.code));
          else pending.resolve(pending.type === 'get_status' ? this.getStatus() : message.value);
        }
      });
      worker.on('error', () => this._fail('owner_worker_failed', worker, false));
      worker.on('exit', () => this._fail(this.closing ? 'owner_shutdown' : 'owner_worker_failed', worker, true));
    });
    worker.postMessage({ tag: 'START', ownerConfig: {
      ledgerPath: this.config.ledgerPath,
      keywordPath: this.config.keywordPath,
      sourceRoot: this.config.sourceRoot,
      publicationRoot: this.config.publicationRoot || this.config.sourceRoot,
      ingressRoot: this.config.ingressRoot,
      deriveDocuments: this.config.deriveDocuments === true,
      keywordTokenizerProvider: this.config.keywordTokenizerProvider || 'garu',
      keywordTokenizerMaxAnalysisChars: this.config.keywordTokenizerMaxAnalysisChars
    } });
    return this.ready;
  }

  _fail(code, worker, exited = true) {
    if (worker && worker !== this.worker) return;
    if (this.readyReject) this.readyReject(failure(code));
    this.readyReject = null;
    if (exited) {
      this.worker = null;
      this.ready = null;
      this.failedWorker = null;
      if (this.releaseOwnerLock) this.releaseOwnerLock();
      this.releaseOwnerLock = null;
    } else {
      this.failedWorker = worker;
    }
    this.snapshot = { state: code === 'owner_shutdown' ? 'shutdown' : 'failed', active: false, diagnostic: { code } };
    this.sequence += 1;
    for (const pending of this.pending.values()) pending.reject(failure(code));
    this.pending.clear();
  }

  _send(tag, type, payload, id) {
    if (this.closing) return Promise.reject(failure('owner_shutdown'));
    if (!this.worker) return Promise.reject(failure('owner_unavailable'));
    if (TYPES[type] !== tag) return Promise.reject(failure('owner_unknown_type'));
    const key = id === undefined ? `owner-${++this.nextId}` : id;
    if (typeof key !== 'string' || !key.trim()) return Promise.reject(failure('owner_invalid_id'));
    if (this.usedIds.has(key)) return Promise.reject(failure('owner_duplicate_id'));
    this.usedIds.add(key);
    return new Promise((resolve, reject) => {
      this.pending.set(key, { resolve, reject, type });
      const message = tag === 'CANCEL' ? { tag, id: key, target: payload.target } : { tag, id: key, type, payload };
      try { this.worker.postMessage(message); }
      catch { this.pending.delete(key); reject(failure('owner_worker_failed')); }
    });
  }

  command(type, payload = {}, id) {
    if (type === 'shutdown') return this.shutdown(id, true);
    if (type === 'manage_index' && (payload === null || typeof payload !== 'object'
      || Array.isArray(payload) || Object.keys(payload).length !== 1
      || !['rebuild', 'retry', 'compact', 'clear'].includes(payload.operation))) {
      return Promise.reject(failure('owner_invalid_manage_index_payload'));
    }
    if (type === 'manage_index' && this.worker && !this.closing) {
      const snapshot = this.snapshot;
      if (snapshot.migrationComplete !== true || snapshot.recoveryComplete !== true) {
        return Promise.resolve({ started: false, scheduled: false, reason: 'owner-recovery-pending' });
      }
      const allowed = payload.operation === 'compact' || payload.operation === 'clear'
        ? ['ready', 'READY', 'READY_KEYWORD_ONLY', 'READY_MAINTENANCE_PENDING']
        : ['ready', 'stale', 'READY', 'READY_KEYWORD_ONLY',
          'READY_KEYWORD_DEGRADED', 'READY_MAINTENANCE_PENDING'];
      if (!allowed.includes(snapshot.state)
        || snapshot.active === true) {
        return Promise.resolve({ started: false, scheduled: false, reason: 'job-in-progress' });
      }
    }
    if (type === 'accept_save') {
      const allowed = ['intentId', 'operation', 'sourceId', 'rootFingerprint',
        'sourceRelativeLocator', 'contentHash', 'provenance',
        'r3ReadFaultIntentId', 'r3SkipCleanup', 'r3SchedulerUnits',
        'r3SchedulerCpuIterations', 'testTarget'];
      payload = Object.fromEntries(allowed.filter(key => payload[key] !== undefined)
        .map(key => [key, payload[key]]));
    }
    return this._send('COMMAND', type, payload, id);
  }
  // @req FR-DOC-019 REL-DOC-009
  async acceptPublishedSave(payload = {}) {
    try { return await this.command('accept_save', payload); }
    catch {
      return { saved: true, accepted: false, indexingState: 'enqueue_failed', indexing: { state: 'enqueue_failed' },
        warnings: [{ code: 'index_enqueue_failed', message: 'Document was saved but indexing enqueue failed.', retryable: true }] };
    }
  }
  query(type, payload = {}, id) {
    if (type === 'get_status') {
      if (this.closing) return Promise.reject(failure('owner_shutdown'));
      if (!this.worker) return Promise.reject(failure('owner_unavailable'));
      const key = id === undefined ? `owner-${++this.nextId}` : id;
      if (typeof key !== 'string' || !key.trim()) return Promise.reject(failure('owner_invalid_id'));
      if (this.usedIds.has(key)) return Promise.reject(failure('owner_duplicate_id'));
      this.usedIds.add(key);
      return Promise.resolve(this.getStatus());
    }
    return this._send('QUERY', type, payload, id);
  }
  cancel(target, id) {
    const snapshot = this.snapshot;
    if (this.worker && !this.closing && snapshot.active === true
      && snapshot.jobId === target && snapshot.phase === 'index_document') {
      const key = id === undefined ? `owner-${++this.nextId}` : id;
      if (typeof key !== 'string' || !key.trim()) return Promise.reject(failure('owner_invalid_id'));
      if (this.usedIds.has(key)) return Promise.reject(failure('owner_duplicate_id'));
      this.usedIds.add(key);
      const token = snapshot.cancelToken;
      const cancelled = Number.isInteger(token) && token > 0
        && Atomics.compareExchange(this.documentCancel, 0, token, token + 1) === token;
      return Promise.resolve({ cancelled });
    }
    return this._send('CANCEL', 'cancel_job', { target }, id);
  }

  async shutdown(id, command = false) {
    if (!this.worker) {
      this.closing = true;
      if (this.releaseOwnerLock) this.releaseOwnerLock();
      this.releaseOwnerLock = null;
      return { shutdown: true };
    }
    const key = id === undefined ? `shutdown-${++this.nextId}` : id;
    if (typeof key !== 'string' || !key.trim()) throw failure('owner_invalid_id');
    if (this.usedIds.has(key)) throw failure('owner_duplicate_id');
    this.usedIds.add(key);
    this.closing = true;
    const worker = this.worker;
    const done = new Promise(resolve => {
      this.pending.set(key, { resolve, reject: resolve });
    });
    worker.postMessage(command ? { tag: 'COMMAND', type: 'shutdown', id: key, payload: {} }
      : { tag: 'SHUTDOWN', id: key });
    const result = await done;
    await worker.terminate();
    this._fail('owner_shutdown');
    return result;
  }
}

module.exports = { OwnerWorkerController };
