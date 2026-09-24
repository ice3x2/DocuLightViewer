'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const TYPES = Object.freeze({
  accept_save: 'COMMAND', resolve_origin: 'QUERY', query_keyword: 'QUERY',
  get_status: 'QUERY', cancel_job: 'CANCEL', shutdown: 'COMMAND'
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
  }

  getStatus() { return { ...this.snapshot, sequence: this.sequence }; }

  async start() {
    if (this.failedWorker) {
      const failed = this.failedWorker;
      await failed.terminate();
      if (this.worker === failed) this._fail('owner_worker_failed', failed, true);
    }
    if (this.worker) return this.ready;
    this.closing = false;
    this.usedIds.clear();
    this.workerSequence = 0;
    const worker = new Worker(this.config.workerPath || path.join(__dirname, 'search-owner-worker.js'), {
      workerData: { r3SchedulerFixture: this.config.r3SchedulerFixture === true,
        r3ReplayFixture: this.config.r3ReplayFixture === true }
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
  cancel(target, id) { return this._send('CANCEL', 'cancel_job', { target }, id); }

  async shutdown(id, command = false) {
    if (!this.worker) { this.closing = true; return { shutdown: true }; }
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
