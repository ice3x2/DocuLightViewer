'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

const RESPONSIVENESS_CONTRACT = Object.freeze({
  thresholds: Object.freeze({
    statusCancelP95Ms: 1000,
    statusCancelP99Ms: 3000,
    statusCancelMaxMs: 5000,
    mainHeartbeatMaxGapMs: 2000
  }),
  loadScenarios: Object.freeze([
    'keyword-rebuild',
    'sqlite-vacuum-compact',
    'semantic-reindex',
    'hnsw-build',
    'hnsw-compact'
  ]),
  probes: Object.freeze([
    'settings-status-ipc',
    'settings-cancel-ipc',
    'tray-menu-event',
    'window-focus',
    'window-close',
    'mcp-read',
    'mcp-search',
    'main-process-heartbeat'
  ]),
  durableStatusFields: Object.freeze([
    'phase',
    'progress',
    'currentPath',
    'heartbeatAt',
    'cancelRequested',
    'diagnostic'
  ]),
  cancelCheckpoints: Object.freeze([
    'scan',
    'read',
    'tokenize',
    'insert',
    'embedding',
    'hnsw',
    'commit'
  ])
});

const ACTIVE_JOB_STATUSES = new Set(['queued', 'indexing']);

// @req REL-DOC-007
class IndexingWorkerController {
  // @req REL-DOC-007
  constructor(options = {}) {
    this.store = options.store || null;
    this.indexBackend = options.indexBackend || 'json';
    this.indexDataDir = options.indexDataDir || null;
    this.keywordTokenizerProvider = options.keywordTokenizerProvider || 'garu';
    this.keywordTokenizerMaxAnalysisChars = options.keywordTokenizerMaxAnalysisChars;
    this.semanticSearch = options.semanticSearch || null;
    this.semanticConfigProvider = typeof options.semanticConfigProvider === 'function' ? options.semanticConfigProvider : null;
    this.embeddingApiKeyProvider = typeof options.embeddingApiKeyProvider === 'function' ? options.embeddingApiKeyProvider : null;
    this.workerPath = options.workerPath || path.join(__dirname, 'search-index-worker.js');
    this.sourceRootProvider = typeof options.sourceRootProvider === 'function' ? options.sourceRootProvider : null;
    this.ledgerProvider = typeof options.ledgerProvider === 'function' ? options.ledgerProvider : null;
    this.onJobCompleted = typeof options.onJobCompleted === 'function' ? options.onJobCompleted : null;
    this.onJobFailed = typeof options.onJobFailed === 'function' ? options.onJobFailed : null;
    this.activeJob = null;
    this.lastJobStatus = null;
    this.closed = false;
  }

  // @req REL-DOC-007
  getResponsivenessContract() {
    return {
      thresholds: { ...RESPONSIVENESS_CONTRACT.thresholds },
      loadScenarios: [...RESPONSIVENESS_CONTRACT.loadScenarios],
      probes: [...RESPONSIVENESS_CONTRACT.probes],
      durableStatusFields: [...RESPONSIVENESS_CONTRACT.durableStatusFields],
      cancelCheckpoints: [...RESPONSIVENESS_CONTRACT.cancelCheckpoints]
    };
  }

  // @req REL-DOC-007
  getStatus() {
    if (this.activeJob) {
      const durable = this._readDurableJob(this.activeJob.jobId);
      if (durable) {
        this.activeJob.status = this._mergeStatus(this.activeJob.status, durable);
      }
      return this._publicStatus(this.activeJob.status || this._createStatus(this.activeJob));
    }
    return this._publicStatus(this.lastJobStatus || {
      active: false,
      state: 'idle',
      phase: null,
      progress: { current: 0, total: 0 },
      currentPath: null,
      heartbeatAt: null,
      cancelRequested: false,
      diagnostic: null
    });
  }

  // @req REL-DOC-007
  getActiveJobStatus() {
    const status = this.getStatus();
    return status.active ? status : null;
  }

  // @req REL-DOC-007
  isActive() {
    return Boolean(this.activeJob);
  }

  // @req REL-DOC-007
  getActiveJobSnapshot() {
    if (!this.activeJob) return null;
    const status = this.activeJob.status || {};
    return {
      jobId: this.activeJob.jobId,
      kind: this.activeJob.kind,
      state: status.state || this.activeJob.state || null,
      phase: status.phase || null,
      currentPath: status.currentPath || this.activeJob.currentPathInternal || null,
      active: true
    };
  }

  // @req REL-DOC-007
  enqueueRebuild(options = {}) {
    return this._startJob({
      kind: 'rebuild',
      jobType: 'keyword_rebuild',
      state: 'rebuilding',
      phase: 'queued',
      requestedBy: options.requestedBy || 'settings'
    });
  }

  // @req REL-DOC-007
  enqueueCompact(options = {}) {
    return this._startJob({
      kind: 'compact',
      jobType: 'sqlite_vacuum_compact',
      state: 'compacting',
      phase: 'queued',
      requestedBy: options.requestedBy || 'settings'
    });
  }

  // @req REL-DOC-007
  enqueueClear(options = {}) {
    return this._startJob({
      kind: 'clear',
      jobType: 'sqlite_clear',
      state: 'clearing',
      phase: 'queued',
      requestedBy: options.requestedBy || 'settings'
    });
  }

  // @req REL-DOC-007
  enqueueSemanticDocument(options = {}) {
    const filePath = options.filePath || null;
    return this._startJob({
      kind: 'semantic-document',
      jobType: 'index_document',
      state: 'indexing',
      phase: 'queued',
      requestedBy: options.requestedBy || 'semantic-reindex',
      jobId: options.jobId || null,
      currentPathInternal: filePath,
      payload: {
        filePath,
        content: typeof options.content === 'string' ? options.content : null,
        requestedBy: options.requestedBy || 'semantic-reindex',
        jobId: options.jobId || null
      }
    });
  }

  // @req REL-DOC-007
  cancelActiveJob() {
    if (!this.activeJob) {
      return { cancelled: false, status: this.getStatus() };
    }
    const status = this._mergeStatus(this.activeJob.status, {
      cancelRequested: true,
      diagnostic: {
        code: 'cancel_requested',
        message: 'Cancellation requested'
      },
      heartbeatAt: new Date().toISOString()
    });
    this.activeJob.status = status;
    this._patchJob(this.activeJob.jobId, {
      cancelRequested: true,
      diagnosticCode: 'cancel_requested',
      diagnostic: status.diagnostic
    });
    try {
      this.activeJob.worker.postMessage({ type: 'cancel', jobId: this.activeJob.jobId });
    } catch (err) {
      this._finishJob(this.activeJob, 'failed', null, err);
    }
    return { cancelled: true, jobId: status.jobId, status: this.getStatus() };
  }

  // @req REL-DOC-007
  close() {
    this.closed = true;
    if (this.activeJob) {
      this._terminateWorker(this.activeJob);
      this.activeJob = null;
    }
  }

  // @req REL-DOC-007
  _startJob({ kind, jobType, state, phase, requestedBy, jobId: requestedJobId, currentPathInternal, payload }) {
    if (this.closed) {
      return { started: false, scheduled: false, reason: 'controller-closed', status: this.getStatus() };
    }
    if (this.activeJob) {
      return {
        started: false,
        scheduled: true,
        reason: 'job-in-progress',
        jobId: this.activeJob.jobId,
        status: this.getStatus(),
        promise: this.activeJob.promise
      };
    }

    const jobId = requestedJobId || this._createJobId(kind);
    const config = this._createWorkerConfig(kind);
    const initialStatus = this._createStatus({ jobId, kind, state, phase });
    this._persistJob({
      jobId,
      jobType,
      requestedBy,
      status: 'queued',
      phase,
      currentPathInternal: currentPathInternal || config.sourceRoot || config.indexDataDir || null
    });

    let worker;
    try {
      worker = new Worker(this.workerPath, {
        workerData: {
          jobId,
          kind,
          config,
          payload: payload || null
        }
      });
    } catch (err) {
      const failedStatus = this._mergeStatus(initialStatus, {
        active: false,
        state: 'failed',
        diagnostic: serializeError(err),
        heartbeatAt: new Date().toISOString()
      });
      this.lastJobStatus = failedStatus;
      this._patchJob(jobId, {
        status: 'failed',
        phase: 'start',
        diagnosticCode: 'worker_start_failed',
        diagnostic: failedStatus.diagnostic,
        finishedAt: true
      });
      return { started: false, scheduled: false, reason: 'worker-start-failed', status: this.getStatus() };
    }

    const job = {
      jobId,
      kind,
      jobType,
      state,
      worker,
      status: initialStatus,
      settled: false,
      promise: null,
      resolve: null,
      reject: null,
      currentPathInternal: currentPathInternal || config.sourceRoot || config.indexDataDir || null
    };
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    job.promise.catch(() => {});
    this.activeJob = job;

    this._patchJob(jobId, {
      status: 'indexing',
      phase: 'start',
      startedAt: true
    });

    worker.on('message', (message) => this._handleWorkerMessage(job, message));
    worker.on('error', (err) => this._finishJob(job, 'failed', null, err));
    worker.on('exit', (code) => {
      if (job.settled) return;
      if (code === 0) {
        this._finishJob(job, 'completed', null, null);
        return;
      }
      const err = new Error(`Indexing worker exited with code ${code}`);
      err.code = 'INDEXING_WORKER_EXITED';
      this._finishJob(job, 'failed', null, err);
    });

    return {
      started: true,
      scheduled: true,
      jobId,
      status: this.getStatus(),
      promise: job.promise
    };
  }

  // @req REL-DOC-007
  _handleWorkerMessage(job, message = {}) {
    if (!message || message.jobId !== job.jobId) return;
    if (message.type === 'status') {
      const patch = {
        active: true,
        state: message.state || job.state,
        phase: message.phase,
        progress: normalizeProgress(message.progress),
        currentPath: message.currentPath || null,
        heartbeatAt: message.heartbeatAt || new Date().toISOString(),
        cancelRequested: message.cancelRequested === true,
        diagnostic: message.diagnostic || null
      };
      if (Object.prototype.hasOwnProperty.call(message, 'rebuildSession')) {
        patch.rebuildSession = normalizeRebuildSession(message.rebuildSession);
      }
      const status = this._mergeStatus(job.status, patch);
      job.status = status;
      this._patchJob(job.jobId, this._statusToJobPatch(status, 'indexing'));
      return;
    }
    if (message.type === 'completed') {
      this._finishJob(job, 'completed', message.result || null, null);
      return;
    }
    if (message.type === 'cancelled') {
      const err = new Error('Indexing worker job cancelled');
      err.code = 'INDEXING_WORKER_CANCELLED';
      this._finishJob(job, 'cancelled', message.result || null, err);
      return;
    }
    if (message.type === 'failed') {
      const err = new Error(message.error && message.error.message ? message.error.message : 'Indexing worker job failed');
      err.code = message.error && message.error.code ? message.error.code : 'INDEXING_WORKER_FAILED';
      this._finishJob(job, 'failed', message.result || null, err);
    }
  }

  // @req REL-DOC-007
  _finishJob(job, terminalStatus, result, err) {
    if (!job || job.settled) return;
    job.settled = true;
    const diagnostic = terminalStatus === 'completed'
      ? null
      : (err ? serializeError(err) : { code: terminalStatus, message: terminalStatus });
    const state = terminalStatus === 'completed'
      ? 'ready'
      : (terminalStatus === 'cancelled' ? 'cancelled' : 'failed');
    const finalStatus = this._mergeStatus(job.status, {
      active: false,
      state,
      phase: terminalStatus,
      progress: terminalStatus === 'completed'
        ? { current: 1, total: 1 }
        : job.status.progress,
      currentPath: null,
      heartbeatAt: new Date().toISOString(),
      diagnostic
    });
    this.lastJobStatus = finalStatus;
    if (this.activeJob && this.activeJob.jobId === job.jobId) {
      this.activeJob = null;
    }

    let finalJobPatch = this._statusToJobPatch(finalStatus, terminalStatus);
    if (terminalStatus === 'completed' && job.kind === 'semantic-document') {
      const resultJob = result && result.job ? result.job : null;
      finalJobPatch = {
        status: terminalStatus,
        phase: terminalStatus,
        progressCurrent: 1,
        progressTotal: 1,
        currentPathInternal: null,
        cancelRequested: false
      };
      if (resultJob && resultJob.diagnosticCode) {
        finalJobPatch.diagnosticCode = resultJob.diagnosticCode;
        finalJobPatch.diagnostic = resultJob.diagnostic || { message: resultJob.diagnosticCode };
      }
    }
    const deferCompletedRebuild = terminalStatus === 'completed' && job.kind === 'rebuild';
    if (deferCompletedRebuild) {
      this._patchJob(job.jobId, {
        ...finalJobPatch,
        status: 'indexing',
        phase: 'post-commit-reset',
        currentPathInternal: null,
        cancelRequested: false,
        diagnosticCode: null,
        diagnostic: null,
        finishedAt: null
      });
    } else {
      this._patchJob(job.jobId, {
        ...finalJobPatch,
        status: terminalStatus,
        finishedAt: true
      });
    }
    this._releaseWorker(job);

    if (terminalStatus === 'completed') {
      const completion = this.onJobCompleted
        ? Promise.resolve(this.onJobCompleted({
          jobId: job.jobId,
          kind: job.kind,
          result,
          status: finalStatus
        }))
        : Promise.resolve();
      completion.then(() => {
        if (deferCompletedRebuild) {
          this._patchJob(job.jobId, {
            ...finalJobPatch,
            status: terminalStatus,
            finishedAt: true
          });
        }
        job.resolve({ jobId: job.jobId, kind: job.kind, result, status: finalStatus });
      }).catch((callbackErr) => {
          if (deferCompletedRebuild) {
            this._patchJob(job.jobId, {
              status: 'failed',
              phase: 'post-commit-reset',
              diagnosticCode: callbackErr && callbackErr.code ? callbackErr.code : 'post_commit_reset_failed',
              diagnostic: serializeError(callbackErr),
              finishedAt: true
            });
          }
          if (this.onJobFailed) {
            this.onJobFailed({ jobId: job.jobId, kind: job.kind, error: callbackErr, status: finalStatus });
          }
          job.reject(callbackErr);
      });
      return;
    }

    if (this.onJobFailed) {
      this.onJobFailed({ jobId: job.jobId, kind: job.kind, error: err, status: finalStatus });
    }
    job.reject(err || new Error(`Indexing worker job ${terminalStatus}`));
  }

  // @req REL-DOC-007
  _createJobId(kind) {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return `job_${kind}_${suffix}`;
  }

  // @req REL-DOC-007
  _createWorkerConfig(kind) {
    const semanticSearch = this.semanticConfigProvider
      ? this.semanticConfigProvider()
      : this.semanticSearch;
    const embeddingApiKey = this.embeddingApiKeyProvider
      ? this.embeddingApiKeyProvider()
      : '';
    const semanticWorkerConfig = semanticSearch && typeof semanticSearch === 'object'
      ? {
          ...semanticSearch,
          ...(kind === 'semantic-document' ? { apiKey: embeddingApiKey || '' } : {})
        }
      : semanticSearch;
    return {
      sourceRoot: this._getSourceRoot(),
      indexBackend: this.indexBackend,
      indexDataDir: this.indexDataDir,
      keywordTokenizerProvider: this.keywordTokenizerProvider,
      keywordTokenizerMaxAnalysisChars: this.keywordTokenizerMaxAnalysisChars,
      semanticSearch: semanticWorkerConfig
    };
  }

  // @req REL-DOC-007
  _getSourceRoot() {
    if (this.sourceRootProvider) {
      return this.sourceRootProvider() || '';
    }
    if (this.store && typeof this.store.get === 'function') {
      return this.store.get('mcpAutoSavePath', '') || '';
    }
    return '';
  }

  // @req REL-DOC-007
  _createStatus({ jobId, kind, state, phase }) {
    const status = {
      jobId,
      kind,
      active: true,
      state: state || 'indexing',
      phase: phase || null,
      progress: { current: 0, total: 0 },
      currentPath: null,
      heartbeatAt: new Date().toISOString(),
      cancelRequested: false,
      diagnostic: null
    };
    if (kind === 'rebuild') {
      status.rebuildSession = {
        active: true,
        indexedCount: 0,
        pendingCount: 0,
        totalCount: 0,
        currentPath: null
      };
    }
    return status;
  }

  // @req REL-DOC-007
  _mergeStatus(base = {}, patch = {}) {
    return {
      jobId: patch.jobId || base.jobId || (this.activeJob && this.activeJob.jobId) || null,
      kind: patch.kind || base.kind || (this.activeJob && this.activeJob.kind) || null,
      active: Object.prototype.hasOwnProperty.call(patch, 'active') ? patch.active : (base.active === true),
      state: patch.state || base.state || 'indexing',
      phase: Object.prototype.hasOwnProperty.call(patch, 'phase') ? patch.phase : (base.phase || null),
      progress: normalizeProgress(Object.prototype.hasOwnProperty.call(patch, 'progress') ? patch.progress : base.progress),
      currentPath: Object.prototype.hasOwnProperty.call(patch, 'currentPath') ? patch.currentPath : (base.currentPath || null),
      heartbeatAt: patch.heartbeatAt || base.heartbeatAt || null,
      cancelRequested: Object.prototype.hasOwnProperty.call(patch, 'cancelRequested')
        ? patch.cancelRequested === true
        : base.cancelRequested === true,
      diagnostic: Object.prototype.hasOwnProperty.call(patch, 'diagnostic') ? patch.diagnostic : (base.diagnostic || null),
      rebuildSession: Object.prototype.hasOwnProperty.call(patch, 'rebuildSession')
        ? normalizeRebuildSession(patch.rebuildSession)
        : normalizeRebuildSession(base.rebuildSession)
    };
  }

  // @req REL-DOC-007
  _publicStatus(status) {
    return {
      ...status,
      kind: status.kind || null,
      progress: normalizeProgress(status.progress),
      rebuildSession: normalizeRebuildSession(status.rebuildSession),
      responsivenessContract: this.getResponsivenessContract()
    };
  }

  // @req REL-DOC-007
  _statusToJobPatch(status, fallbackStatus) {
    const progress = normalizeProgress(status.progress);
    return {
      status: fallbackStatus,
      phase: status.phase || null,
      progressCurrent: progress.current,
      progressTotal: progress.total,
      currentPathInternal: status.currentPath || null,
      cancelRequested: status.cancelRequested === true,
      diagnosticCode: status.diagnostic && status.diagnostic.code ? status.diagnostic.code : null,
      diagnostic: status.diagnostic || null
    };
  }

  // @req REL-DOC-007
  _getLedger() {
    if (!this.ledgerProvider) return null;
    try {
      return this.ledgerProvider();
    } catch {
      return null;
    }
  }

  // @req REL-DOC-007
  _persistJob(input) {
    const ledger = this._getLedger();
    if (!ledger || typeof ledger.enqueueIndexJob !== 'function') return null;
    try {
      return ledger.enqueueIndexJob(input);
    } catch {
      return null;
    }
  }

  // @req REL-DOC-007
  _patchJob(jobId, patch) {
    const ledger = this._getLedger();
    if (!ledger || typeof ledger.updateIndexJob !== 'function') return null;
    try {
      return ledger.updateIndexJob(jobId, patch);
    } catch {
      return null;
    }
  }

  // @req REL-DOC-007
  _readDurableJob(jobId) {
    const ledger = this._getLedger();
    if (!ledger || typeof ledger.getIndexJob !== 'function') return null;
    try {
      const job = ledger.getIndexJob(jobId);
      if (!job) return null;
      const status = String(job.status || '');
      const kind = this.activeJob && this.activeJob.kind ? this.activeJob.kind : null;
      return {
        jobId: job.jobId,
        kind,
        active: ACTIVE_JOB_STATUSES.has(status),
        state: mapJobState(status, kind),
        phase: job.phase || null,
        progress: {
          current: Number(job.progressCurrent) || 0,
          total: Number(job.progressTotal) || 0
        },
        currentPath: job.currentPath || job.currentPathToken || null,
        heartbeatAt: job.heartbeatAt || null,
        cancelRequested: job.cancelRequested === true,
        diagnostic: job.diagnostic || (job.diagnosticCode ? { code: job.diagnosticCode } : null)
      };
    } catch {
      return null;
    }
  }

  // @req REL-DOC-007
  _terminateWorker(job) {
    if (!job || !job.worker) return;
    try {
      job.worker.terminate();
    } catch {
      // ignore shutdown failures
    }
  }

  // @req REL-DOC-007
  _releaseWorker(job) {
    if (!job || !job.worker) return;
    try {
      job.worker.removeAllListeners('message');
      job.worker.removeAllListeners('error');
      job.worker.removeAllListeners('exit');
    } catch {
      // ignore listener cleanup failures
    }
    try {
      job.worker.unref();
    } catch {
      // ignore unref failures
    }
  }
}

// @req REL-DOC-007
function normalizeProgress(progress) {
  if (!progress || typeof progress !== 'object') {
    return { current: 0, total: 0 };
  }
  return {
    current: Number.isFinite(Number(progress.current)) ? Number(progress.current) : 0,
    total: Number.isFinite(Number(progress.total)) ? Number(progress.total) : 0
  };
}

// @req REL-DOC-008
function normalizeRebuildSession(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    active: value.active === true,
    indexedCount: Math.max(0, Number(value.indexedCount) || 0),
    pendingCount: Math.max(0, Number(value.pendingCount) || 0),
    totalCount: Math.max(0, Number(value.totalCount) || 0),
    currentPath: value.currentPath || null,
    requestedBy: value.requestedBy || null
  };
}

// @req REL-DOC-007
function mapJobState(status, kind) {
  if (status === 'queued') return 'queued';
  if (status === 'indexing' && kind === 'clear') return 'clearing';
  if (status === 'indexing') return kind === 'compact' ? 'compacting' : 'rebuilding';
  if (status === 'completed') return 'ready';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed') return 'failed';
  return status || 'idle';
}

// @req REL-DOC-007
function serializeError(err) {
  return {
    code: err && err.code ? err.code : 'indexing_worker_error',
    message: err && err.message ? err.message : 'Indexing worker error'
  };
}

module.exports = {
  IndexingWorkerController,
  RESPONSIVENESS_CONTRACT
};
