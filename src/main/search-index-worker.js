'use strict';

const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');
const { SearchEngine } = require('./search-engine');
const { createOpenAICompatibleEmbeddingProvider } = require('./embedding-provider');

let activeEngine = null;
let cancelRequested = false;

// @req REL-DOC-007
function createWorkerStore(sourceRoot) {
  return {
    get(key, defaultValue) {
      if (key === 'mcpAutoSave') return true;
      if (key === 'mcpAutoSavePath') return sourceRoot || '';
      return defaultValue;
    }
  };
}

// @req REL-DOC-007
function post(message) {
  if (!parentPort) return;
  parentPort.postMessage({
    jobId: workerData.jobId,
    ...message
  });
}

// @req REL-DOC-007
function postStatus(patch = {}) {
  post({
    type: 'status',
    heartbeatAt: new Date().toISOString(),
    cancelRequested,
    ...patch
  });
}

// @req REL-DOC-007
function throwIfCancelled(phase, currentPath) {
  if (!cancelRequested) return;
  const err = new Error('Indexing worker job cancelled');
  err.code = 'INDEXING_WORKER_CANCELLED';
  err.phase = phase;
  err.currentPath = currentPath || null;
  throw err;
}

// @req REL-DOC-008
function postEngineStatus(status, fallbackPhase) {
  postStatus({
    state: status && status.state ? status.state : 'indexing',
    phase: status && status.phase ? status.phase : fallbackPhase,
    currentPath: status && status.currentPath ? status.currentPath : null,
    progress: status && status.progress ? status.progress : { current: 0, total: 0 },
    rebuildSession: status && status.rebuildSession ? status.rebuildSession : null,
    diagnostic: status && status.errorSummary ? { code: 'status', message: status.errorSummary } : null
  });
}

// @req REL-DOC-007
function createWorkerEngine(config = {}) {
  const semanticSearch = config.semanticSearch && typeof config.semanticSearch === 'object'
    ? config.semanticSearch
    : {};
  return new SearchEngine(createWorkerStore(config.sourceRoot), {
    indexBackend: config.indexBackend,
    indexDataDir: config.indexDataDir,
    keywordTokenizerProvider: config.keywordTokenizerProvider,
    keywordTokenizerMaxAnalysisChars: config.keywordTokenizerMaxAnalysisChars,
    semanticSearch,
    embeddingConfigProvider: () => semanticSearch,
    embeddingProvider: createOpenAICompatibleEmbeddingProvider({
      getEmbeddingConfig: () => semanticSearch,
      getApiKey: () => semanticSearch.apiKey || ''
    }),
    forceHnswUnavailable: Boolean(semanticSearch.hnsw && semanticSearch.hnsw.forceUnavailable === true),
    indexingShouldCancel: () => cancelRequested === true,
    onRebuildStatus: (status) => postEngineStatus(status, 'scan'),
    disableIndexingWorkerController: true
  });
}

// @req REL-DOC-007
function startEngineStatusMonitor(engine, fallbackPhase) {
  return setInterval(() => {
    let status = null;
    try {
      status = engine.getStatus({ publicPaths: false });
    } catch {
      status = null;
    }
    postEngineStatus(status, fallbackPhase);
  }, 50);
}

// @req REL-DOC-007
async function runRebuild(config) {
  activeEngine = createWorkerEngine(config);
  const monitor = startEngineStatusMonitor(activeEngine, 'scan');
  try {
    throwIfCancelled('scan', config.sourceRoot);
    postStatus({
      state: 'rebuilding',
      phase: 'scan',
      currentPath: config.sourceRoot || null,
      progress: { current: 0, total: 0 },
      rebuildSession: { active: true, indexedCount: 0, pendingCount: 0, totalCount: 0, currentPath: config.sourceRoot || null }
    });
    const result = await activeEngine.rebuild();
    postStatus({
      state: 'ready',
      phase: 'commit',
      currentPath: activeEngine.getIndexPath(),
      progress: { current: result.indexed || 0, total: result.scanned || result.indexed || 0 },
      rebuildSession: { active: false, indexedCount: result.indexed || 0, pendingCount: 0, totalCount: result.scanned || result.indexed || 0, currentPath: null }
    });
    return result;
  } finally {
    clearInterval(monitor);
  }
}

// @req REL-DOC-007
async function runSemanticDocument(config, payload = {}) {
  activeEngine = createWorkerEngine(config);
  const filePath = payload.filePath || null;
  if (!filePath) {
    const err = new Error('Semantic indexing worker requires filePath');
    err.code = 'SEMANTIC_INDEXING_FILE_REQUIRED';
    err.phase = 'read';
    throw err;
  }
  const monitor = startEngineStatusMonitor(activeEngine, 'embedding');
  try {
    throwIfCancelled('read', filePath);
    postStatus({
      state: 'indexing',
      phase: 'read',
      currentPath: filePath,
      progress: { current: 0, total: 4 }
    });
    const content = typeof payload.content === 'string'
      ? payload.content
      : await fs.promises.readFile(filePath, 'utf-8');
    throwIfCancelled('tokenize', filePath);
    postStatus({
      state: 'indexing',
      phase: 'tokenize',
      currentPath: filePath,
      progress: { current: 1, total: 4 }
    });
    const service = typeof activeEngine._getIndexingService === 'function'
      ? activeEngine._getIndexingService()
      : null;
    if (!service || typeof service.indexDocument !== 'function') {
      const err = new Error('Semantic indexing service is not available in worker runtime');
      err.code = 'SEMANTIC_INDEXING_WORKER_UNAVAILABLE';
      err.phase = 'tokenize';
      err.currentPath = filePath;
      throw err;
    }
    throwIfCancelled('embedding', filePath);
    postStatus({
      state: 'indexing',
      phase: 'embedding',
      currentPath: filePath,
      progress: { current: 2, total: 4 }
    });
    const result = await service.indexDocument({
      filePath,
      content,
      requestedBy: payload.requestedBy || 'semantic-reindex',
      jobId: payload.jobId || workerData.jobId
    });
    throwIfCancelled('hnsw', filePath);
    postStatus({
      state: 'indexing',
      phase: 'hnsw',
      currentPath: filePath,
      progress: { current: 3, total: 4 }
    });
    throwIfCancelled('commit', filePath);
    postStatus({
      state: 'ready',
      phase: 'commit',
      currentPath: filePath,
      progress: { current: 4, total: 4 }
    });
    return result;
  } finally {
    clearInterval(monitor);
  }
}

// @req REL-DOC-007
async function runCompact(config) {
  activeEngine = createWorkerEngine(config);
  throwIfCancelled('scan', config.indexDataDir || config.sourceRoot);
  postStatus({
    state: 'compacting',
    phase: 'scan',
    currentPath: config.indexDataDir || config.sourceRoot || null,
    progress: { current: 0, total: 1 }
  });
  const indexPath = activeEngine.getIndexPath();
  throwIfCancelled('read', indexPath);
  if (!indexPath || !fs.existsSync(indexPath)) {
    return { compacted: false, reason: 'index-unavailable' };
  }
  postStatus({
    state: 'compacting',
    phase: activeEngine._usesSQLiteBackend() ? 'insert' : 'commit',
    currentPath: indexPath,
    progress: { current: 1, total: 2 }
  });
  let backupManifest = null;
  if (activeEngine._usesSQLiteBackend()) {
    const vacuumResult = activeEngine._getSQLiteIndex(indexPath).vacuum({ reason: 'compact-before-vacuum' });
    backupManifest = vacuumResult && vacuumResult.backupManifest ? vacuumResult.backupManifest : null;
  } else {
    await activeEngine._saveIndex(indexPath);
  }
  throwIfCancelled('commit', indexPath);
  postStatus({
    state: 'ready',
    phase: 'commit',
    currentPath: indexPath,
    progress: { current: 2, total: 2 }
  });
  return { compacted: true, backupManifest };
}

// @req REL-DOC-007
async function runClear(config) {
  activeEngine = createWorkerEngine(config);
  throwIfCancelled('scan', config.indexDataDir || config.sourceRoot);
  postStatus({
    state: 'clearing',
    phase: 'scan',
    currentPath: config.indexDataDir || config.sourceRoot || null,
    progress: { current: 0, total: 3 }
  });
  const indexPath = activeEngine.getIndexPath();
  throwIfCancelled('read', indexPath);
  if (!indexPath || !fs.existsSync(indexPath)) {
    return {
      cleared: true,
      reason: 'index-unavailable',
      backupManifest: null,
      deleteResult: { deleted: true, files: [], failedCount: 0 }
    };
  }
  if (!activeEngine._usesSQLiteBackend()) {
    const err = new Error('Worker clear is only supported for SQLite search indexes');
    err.code = 'INDEXING_WORKER_CLEAR_UNSUPPORTED_BACKEND';
    err.phase = 'read';
    err.currentPath = indexPath;
    throw err;
  }
  postStatus({
    state: 'clearing',
    phase: 'read',
    currentPath: indexPath,
    progress: { current: 1, total: 3 }
  });
  const sqliteIndex = activeEngine._getSQLiteIndex(indexPath);
  const backupManifest = sqliteIndex.createBackupManifest({ reason: 'clear-before-delete' });
  throwIfCancelled('commit', indexPath);
  postStatus({
    state: 'clearing',
    phase: 'commit',
    currentPath: indexPath,
    progress: { current: 2, total: 3 }
  });
  const deleteResult = sqliteIndex.deleteFiles();
  if (!deleteResult.deleted) {
    const err = new Error('SQLite search index delete verification failed');
    err.code = 'SQLITE_KEYWORD_INDEX_DELETE_FAILED';
    err.phase = 'commit';
    err.currentPath = indexPath;
    err.deleteResult = deleteResult;
    throw err;
  }
  postStatus({
    state: 'ready',
    phase: 'commit',
    currentPath: indexPath,
    progress: { current: 3, total: 3 }
  });
  return { cleared: true, backupManifest, deleteResult };
}

// @req REL-DOC-007
function handleCancel() {
  cancelRequested = true;
  if (activeEngine) {
    activeEngine._cancelRequested = true;
  }
  postStatus({
    phase: 'cancel',
    diagnostic: {
      code: 'cancel_requested',
      message: 'Cancellation requested'
    }
  });
}

// @req REL-DOC-007
function handleParentMessage(message = {}) {
  if (message.type === 'cancel') {
    handleCancel();
  }
}

// @req REL-DOC-007
function closeParentPort() {
  if (!parentPort) return;
  try {
    parentPort.off('message', handleParentMessage);
  } catch {
    // ignore listener cleanup failures
  }
  try {
    parentPort.close();
  } catch {
    // ignore port close failures
  }
}

// @req REL-DOC-007
function serializeError(err) {
  return {
    code: err && err.code ? err.code : 'INDEXING_WORKER_FAILED',
    message: err && err.message ? err.message : 'Indexing worker failed',
    phase: err && err.phase ? err.phase : null,
    currentPath: err && err.currentPath ? err.currentPath : null
  };
}

if (parentPort) {
  parentPort.on('message', handleParentMessage);
}

(async () => {
  const kind = workerData && workerData.kind;
  const config = workerData && workerData.config ? workerData.config : {};
  const payload = workerData && workerData.payload ? workerData.payload : {};
  let terminalMessage = null;
  try {
    let result;
    if (kind === 'compact') {
      result = await runCompact(config);
    } else if (kind === 'clear') {
      result = await runClear(config);
    } else if (kind === 'semantic-document') {
      result = await runSemanticDocument(config, payload);
    } else {
      result = await runRebuild(config);
    }
    terminalMessage = { type: 'completed', result };
  } catch (err) {
    if (err && err.code === 'INDEXING_WORKER_CANCELLED') {
      terminalMessage = { type: 'cancelled', error: serializeError(err) };
    } else {
      terminalMessage = { type: 'failed', error: serializeError(err) };
    }
    process.exitCode = 1;
  } finally {
    if (activeEngine && typeof activeEngine.close === 'function') {
      activeEngine.close();
    }
    if (terminalMessage) {
      post(terminalMessage);
    }
    closeParentPort();
  }
})();
