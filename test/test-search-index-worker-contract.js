'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const { SearchEngine } = require('../src/main/search-engine');
const { SQLiteKeywordIndex } = require('../src/main/search-sqlite-store');
const { IndexingWorkerController } = require('../src/main/search-index-worker-controller');

const LATENCY_BUDGET_MS = Object.freeze({
  statusCancelP95: 1000,
  statusCancelP99: 3000,
  statusCancelMax: 5000,
  mainHeartbeatMaxGap: 2000
});

const REQUIRED_LOADS = Object.freeze([
  'keyword-rebuild',
  'sqlite-vacuum-compact',
  'semantic-reindex',
  'hnsw-build',
  'hnsw-compact'
]);

const REQUIRED_PROBES = Object.freeze([
  'settings-status-ipc',
  'settings-cancel-ipc',
  'tray-menu-event',
  'window-focus',
  'window-close',
  'mcp-read',
  'mcp-search',
  'main-process-heartbeat'
]);

const REQUIRED_STATUS_FIELDS = Object.freeze([
  'phase',
  'progress',
  'currentPath',
  'heartbeatAt',
  'cancelRequested',
  'diagnostic'
]);

const REQUIRED_CANCEL_CHECKPOINTS = Object.freeze([
  'scan',
  'read',
  'tokenize',
  'insert',
  'embedding',
  'hnsw',
  'commit'
]);

const VALID_FOCUS = new Set(['worker-runtime', 'sqlite-generation']);
const focusArg = process.argv.find((arg) => arg.startsWith('--focus='));
const FOCUS = focusArg ? focusArg.slice('--focus='.length) : null;

if (FOCUS && !VALID_FOCUS.has(FOCUS)) {
  console.error(`Unsupported --focus value: ${FOCUS}`);
  process.exit(2);
}

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf-8');
}

function createStore(docsDir) {
  return {
    get(key, defaultValue) {
      if (key === 'mcpAutoSave') return true;
      if (key === 'mcpAutoSavePath') return docsDir;
      return defaultValue;
    }
  };
}

function getIndexingBoundary(engine) {
  if (typeof engine.getIndexingWorkerController === 'function') {
    return engine.getIndexingWorkerController();
  }
  return engine.indexingWorkerController || engine.searchIndexWorkerController || engine.indexWorkerController || null;
}

function normalizeContract(boundary) {
  if (!boundary) return null;
  if (typeof boundary.getResponsivenessContract === 'function') {
    return boundary.getResponsivenessContract();
  }
  if (boundary.responsivenessContract && typeof boundary.responsivenessContract === 'object') {
    return boundary.responsivenessContract;
  }
  return null;
}

function includesAll(actual, expected) {
  const values = new Set(Array.isArray(actual) ? actual : []);
  return expected.filter((item) => !values.has(item));
}

function methodBody(source, methodName) {
  const pattern = new RegExp(`\\n\\s*(?:async\\s+)?${methodName}\\s*\\([^)]*\\)\\s*{`, 'm');
  const match = pattern.exec(source);
  if (!match) return '';
  let depth = 0;
  for (let index = match.index + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  return source.slice(match.index);
}

function hasQueryTimeHnswBuild(searchEngineSource) {
  return /_searchSemanticCandidatesWithHnsw\s*\([^)]*\)\s*{[\s\S]*listChunkEmbeddingVectors[\s\S]*createHnswIndex[\s\S]*(addPoint|init\()/m.test(searchEngineSource);
}

function pushFailure(failures, signature, message) {
  failures.push(`${signature}: ${message}`);
}

function assertContract(condition, signature, message) {
  if (!condition) {
    const err = new Error(`${signature}: ${message}`);
    err.signature = signature;
    throw err;
  }
}

function searchDocument(filePath, title, body) {
  return {
    filePath,
    meta: {
      title,
      project: 'Generation',
      docName: title,
      docType: 'note',
      documentTags: []
    },
    body,
    contentHash: `${title}-content`,
    textHash: `${title}-text`
  };
}

async function waitForControllerIdle(controller, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (controller && controller.isActive && controller.isActive()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('worker clear timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForStatus(readStatus, predicate, timeoutMs = 8000) {
  const startedAt = Date.now();
  let lastStatus = null;
  while (Date.now() - startedAt <= timeoutMs) {
    lastStatus = readStatus();
    if (predicate(lastStatus)) return lastStatus;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const err = new Error('timed out waiting for indexing status');
  err.lastStatus = lastStatus;
  throw err;
}

function shouldRun(group) {
  if (!FOCUS) return true;
  return FOCUS === group;
}

(async () => {
  const failures = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-index-worker-contract-'));
  let engine = null;

  try {
    const docsDir = path.join(tmp, 'docs');
    const indexDataDir = path.join(tmp, 'userData', 'index');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.mkdirSync(indexDataDir, { recursive: true });

    engine = new SearchEngine(createStore(docsDir), {
      indexBackend: 'sqlite',
      indexDataDir
    });

    const searchEngineSource = readProjectFile('src/main/search-engine.js');
    const sqliteStoreSource = readProjectFile('src/main/search-sqlite-store.js');
    const indexingServiceSource = readProjectFile('src/main/indexing-service.js');
    const controllerPath = path.join(root, 'src/main/search-index-worker-controller.js');
    const workerPath = path.join(root, 'src/main/search-index-worker.js');
    const controllerSource = fs.existsSync(controllerPath) ? readProjectFile('src/main/search-index-worker-controller.js') : '';
    const workerSource = fs.existsSync(workerPath) ? readProjectFile('src/main/search-index-worker.js') : '';
    const boundary = getIndexingBoundary(engine);
    const contract = normalizeContract(boundary);

    if (!fs.existsSync(controllerPath) || !fs.existsSync(workerPath)) {
      pushFailure(
        failures,
        'worker runtime isolation',
        'expected src/main/search-index-worker-controller.js and src/main/search-index-worker.js so keyword rebuild, SQLite writes, VACUUM/compact, semantic reindex, and HNSW build/compact run outside Electron main process'
      );
    }

    if (!boundary || typeof boundary !== 'object') {
      pushFailure(
        failures,
        'worker runtime isolation',
        'SearchEngine must expose an indexing worker controller through getIndexingWorkerController(), indexingWorkerController, searchIndexWorkerController, or indexWorkerController'
      );
    }

    const startRebuildBody = methodBody(searchEngineSource, 'startRebuild');
    if (/this\.rebuild\(\)\.catch/m.test(startRebuildBody)) {
      pushFailure(
        failures,
        'worker runtime isolation',
        'startRebuild must enqueue a worker/controller job instead of invoking SearchEngine.rebuild() in the main process'
      );
    }

    const compactBody = methodBody(searchEngineSource, 'compact');
    if (/_getSQLiteIndex\(indexPath\)\.vacuum\(\)/m.test(compactBody)) {
      pushFailure(
        failures,
        'worker runtime isolation',
        'compact/VACUUM must execute in the worker boundary, not through runBoundedAsyncTask on the Electron main process'
      );
    }

    const smartDrainBody = methodBody(searchEngineSource, '_performSmartIndexDrain');
    if (!/enqueueSemanticDocument\s*\(/m.test(smartDrainBody)) {
      pushFailure(
        failures,
        'semantic worker runtime isolation',
        'semantic embedding/HNSW document indexing must be enqueued through the indexing worker controller instead of calling IndexingService.indexDocument on the Electron main process'
      );
    }
    if (!/enqueueSemanticDocument\s*\(/m.test(controllerSource) || !/semantic-document/m.test(controllerSource)) {
      pushFailure(
        failures,
        'semantic worker runtime isolation',
        'IndexingWorkerController must expose enqueueSemanticDocument and dispatch semantic-document jobs for post-save semantic reindexing'
      );
    }
    if (!/runSemanticDocument/m.test(workerSource) || !/createOpenAICompatibleEmbeddingProvider/m.test(workerSource) || !/kind\s*===\s*['"]semantic-document['"]/m.test(workerSource)) {
      pushFailure(
        failures,
        'semantic worker runtime isolation',
        'search-index-worker.js must execute semantic-document jobs with a worker-local embedding provider and HNSW-capable indexing service'
      );
    }
    if (!/shouldCancel/m.test(indexingServiceSource) || !/_throwIfCancelled\(['"]embedding['"]/m.test(indexingServiceSource) || !/_throwIfCancelled\(['"]hnsw['"]/m.test(indexingServiceSource) || !/_throwIfCancelled\(['"]commit['"]/m.test(indexingServiceSource)) {
      pushFailure(
        failures,
        'semantic worker cancel checkpoints',
        'IndexingService must check worker cancellation inside embedding/HNSW/commit work, not only before and after indexDocument()'
      );
    }
    if (!/indexingShouldCancel/m.test(workerSource)) {
      pushFailure(
        failures,
        'semantic worker cancel checkpoints',
        'search-index-worker.js must pass a cancellation callback into the worker-local indexing service'
      );
    }

    if (shouldRun('worker-runtime')) {
      try {
        const staleDocsDir = path.join(tmp, 'stale-docs');
        const staleIndexDataDir = path.join(tmp, 'stale-userData', 'index');
        fs.mkdirSync(staleDocsDir, { recursive: true });
        fs.mkdirSync(staleIndexDataDir, { recursive: true });
        let activeSnapshot = null;
        const staleEngine = new SearchEngine(createStore(staleDocsDir), {
          indexBackend: 'sqlite',
          indexDataDir: staleIndexDataDir,
          smartIndexDelayMs: 60000,
          indexingWorkerController: {
            isActive: () => Boolean(activeSnapshot),
            getStatus: () => ({
              active: Boolean(activeSnapshot),
              jobId: activeSnapshot && activeSnapshot.jobId,
              state: activeSnapshot ? 'indexing' : 'idle',
              phase: activeSnapshot ? 'embedding' : null
            }),
            getActiveJobSnapshot: () => activeSnapshot,
            enqueueSemanticDocument: () => ({ started: false, scheduled: false, reason: 'not-used-in-this-fixture' })
          }
        });
        try {
          const stalePath = path.join(staleDocsDir, 'same-document.md');
          fs.writeFileSync(stalePath, '# Same\n\nfirst content', 'utf-8');
          const firstQueued = staleEngine.queueDocumentIndex({
            filePath: stalePath,
            content: '# Same\n\nfirst content',
            requestedBy: 'contract.stale.first'
          });
          activeSnapshot = {
            kind: 'semantic-document',
            jobId: firstQueued.jobId,
            currentPath: stalePath
          };
          const secondQueued = staleEngine.queueDocumentIndex({
            filePath: stalePath,
            content: '# Same\n\nsecond content',
            requestedBy: 'contract.stale.second'
          });
          const thirdQueued = staleEngine.queueDocumentIndex({
            filePath: stalePath,
            content: '# Same\n\nthird content',
            requestedBy: 'contract.stale.third'
          });
          assertContract(secondQueued.jobId && secondQueued.jobId !== firstQueued.jobId, 'semantic latest-wins worker behavior', 'a newer same-document save queued while an older worker is active must not reuse the active worker jobId');
          assertContract(thirdQueued.jobId === secondQueued.jobId, 'semantic latest-wins worker behavior', 'same-document saves queued behind an active worker must still coalesce into the latest queued job');
        } finally {
          staleEngine.close();
        }

        const unavailableDocsDir = path.join(tmp, 'unavailable-docs');
        const unavailableIndexDataDir = path.join(tmp, 'unavailable-userData', 'index');
        fs.mkdirSync(unavailableDocsDir, { recursive: true });
        fs.mkdirSync(unavailableIndexDataDir, { recursive: true });
        const unavailableEngine = new SearchEngine(createStore(unavailableDocsDir), {
          indexBackend: 'sqlite',
          indexDataDir: unavailableIndexDataDir,
          smartIndexDelayMs: 60000,
          indexingWorkerController: {
            isActive: () => false,
            getStatus: () => ({ active: false, state: 'idle', phase: null }),
            enqueueSemanticDocument: () => ({ started: false, scheduled: false, reason: 'worker-start-failed' })
          }
        });
        try {
          const unavailablePath = path.join(unavailableDocsDir, 'worker-unavailable.md');
          fs.writeFileSync(unavailablePath, '# Worker Unavailable\n\nretryable content', 'utf-8');
          const unavailableQueued = unavailableEngine.queueDocumentIndex({
            filePath: unavailablePath,
            content: '# Worker Unavailable\n\nretryable content',
            requestedBy: 'contract.worker.unavailable'
          });
          await unavailableEngine._drainSmartIndexQueue();
          const unavailableJob = unavailableEngine.getSourceLedger().getIndexJob(unavailableQueued.jobId);
          assertContract(unavailableJob && unavailableJob.status === 'queued' && unavailableJob.diagnosticCode === 'worker-start-failed', 'semantic worker unavailable behavior', 'worker start failure must leave the durable semantic job retryable instead of silently dropping it');
        } finally {
          unavailableEngine.close();
        }

        const asyncFailureDocsDir = path.join(tmp, 'async-failure-docs');
        const asyncFailureIndexDataDir = path.join(tmp, 'async-failure-userData', 'index');
        fs.mkdirSync(asyncFailureDocsDir, { recursive: true });
        fs.mkdirSync(asyncFailureIndexDataDir, { recursive: true });
        const asyncFailureEngine = new SearchEngine(createStore(asyncFailureDocsDir), {
          indexBackend: 'sqlite',
          indexDataDir: asyncFailureIndexDataDir,
          smartIndexDelayMs: 60000,
          indexingWorkerPath: path.join(tmp, 'missing-search-index-worker.js')
        });
        try {
          const asyncFailurePath = path.join(asyncFailureDocsDir, 'async-worker-failure.md');
          fs.writeFileSync(asyncFailurePath, '# Async Worker Failure\n\nretryable async startup content', 'utf-8');
          const asyncFailureQueued = asyncFailureEngine.queueDocumentIndex({
            filePath: asyncFailurePath,
            content: '# Async Worker Failure\n\nretryable async startup content',
            requestedBy: 'contract.worker.async-failure'
          });
          await asyncFailureEngine._drainSmartIndexQueue();
          const asyncFailureJob = asyncFailureEngine.getSourceLedger().getIndexJob(asyncFailureQueued.jobId);
          assertContract(asyncFailureJob && asyncFailureJob.status === 'queued' && asyncFailureJob.diagnosticCode, 'semantic worker unavailable behavior', 'async worker startup/module-load failure must leave the durable semantic job retryable with a diagnostic');
        } finally {
          asyncFailureEngine.close();
        }

        const semanticPath = path.join(docsDir, 'semantic-worker.md');
        const semanticContent = [
          '---',
          'title: Semantic Worker',
          'category: worker-contract',
          '---',
          '# Semantic Worker',
          '',
          'semantic worker queue should index chunks outside the main process'
        ].join('\n');
        fs.writeFileSync(semanticPath, semanticContent, 'utf-8');
        const queued = engine.queueDocumentIndex({
          filePath: semanticPath,
          content: semanticContent,
          requestedBy: 'contract-semantic-worker'
        });
        assertContract(queued.queued === true && queued.jobId, 'semantic worker behavior', 'queueDocumentIndex must enqueue a document-level semantic worker job');
        await engine._drainSmartIndexQueue();
        const semanticController = getIndexingBoundary(engine);
        await waitForControllerIdle(semanticController);
        const ledger = engine.getSourceLedger();
        const document = ledger.findDocumentByCanonicalPath({ canonicalPathInternal: semanticPath });
        assertContract(document && document.documentId, 'semantic worker behavior', 'semantic worker must persist the indexed document in the source ledger');
        const chunkRow = ledger.open().prepare('SELECT COUNT(*) AS count FROM chunks WHERE document_id = ?').get(document.documentId);
        assertContract(Number(chunkRow && chunkRow.count) > 0, 'semantic worker behavior', 'semantic worker must persist document chunks through the worker-local indexing service');
        const job = ledger.getIndexJob(queued.jobId);
        assertContract(job && job.status === 'completed', 'semantic worker behavior', 'semantic worker must complete the original queued index job');

        let embeddingRequests = 0;
        const embeddingServer = http.createServer((request, response) => {
          if (request.method !== 'POST' || request.url !== '/v1/embeddings') {
            response.writeHead(404, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: 'not found' }));
            return;
          }
          let body = '';
          request.setEncoding('utf-8');
          request.on('data', (chunk) => {
            body += chunk;
          });
          request.on('end', () => {
            embeddingRequests += 1;
            const payload = JSON.parse(body || '{}');
            const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({
              data: inputs.map((_, index) => ({
                index,
                embedding: [1, 0, 0]
              }))
            }));
          });
        });
        await new Promise((resolve) => embeddingServer.listen(0, '127.0.0.1', resolve));
        try {
          const address = embeddingServer.address();
          const port = address && typeof address === 'object' ? address.port : 0;
          engine.options.semanticSearch = {
            enabled: true,
            provider: 'openai-compatible',
            baseURL: `http://127.0.0.1:${port}/v1`,
            model: 'worker-fixture-model',
            modelFingerprint: 'worker-fixture-fingerprint',
            dimensions: 3,
            batchSize: 2,
            hnsw: { forceUnavailable: true }
          };
          const embeddingPath = path.join(docsDir, 'semantic-embedding-worker.md');
          const embeddingContent = [
            '---',
            'title: Semantic Embedding Worker',
            'category: worker-contract',
            '---',
            '# Semantic Embedding Worker',
            '',
            'semantic embedding worker should call the configured local provider'
          ].join('\n');
          fs.writeFileSync(embeddingPath, embeddingContent, 'utf-8');
          const embeddingQueued = engine.queueDocumentIndex({
            filePath: embeddingPath,
            content: embeddingContent,
            requestedBy: 'contract-semantic-embedding-worker'
          });
          assertContract(embeddingQueued.queued === true && embeddingQueued.jobId, 'semantic embedding worker behavior', 'enabled semantic indexing must enqueue through the worker controller');
          await engine._drainSmartIndexQueue();
          await waitForControllerIdle(semanticController);
          const embeddingCount = ledger.open().prepare(`
            SELECT COUNT(*) AS count
            FROM chunk_embeddings ce
            JOIN embedding_models em ON em.model_id = ce.model_id
            WHERE em.model_fingerprint = ?
          `).get('worker-fixture-fingerprint');
          const annCount = ledger.open().prepare(`
            SELECT COUNT(*) AS count
            FROM ann_indexes ai
            JOIN embedding_models em ON em.model_id = ai.model_id
            WHERE em.model_fingerprint = ? AND ai.status = 'committed'
          `).get('worker-fixture-fingerprint');
          const embeddingJob = ledger.getIndexJob(embeddingQueued.jobId);
          assertContract(embeddingRequests >= 1, 'semantic embedding worker behavior', 'worker-local embedding provider must call the configured embedding endpoint');
          assertContract(Number(embeddingCount && embeddingCount.count) >= 1, 'semantic embedding worker behavior', 'worker-local semantic indexing must persist chunk embeddings');
          assertContract(Number(annCount && annCount.count) >= 1 || (embeddingJob && embeddingJob.diagnosticCode), 'semantic embedding worker behavior', 'worker-local semantic indexing must either commit HNSW ANN metadata or record an HNSW diagnostic from the worker');
        } finally {
          engine.options.semanticSearch = null;
          await new Promise((resolve) => embeddingServer.close(resolve));
        }
      } catch (err) {
        pushFailure(failures, err.signature || 'semantic worker behavior', err.message || String(err));
      }
    }

    if (!contract) {
      pushFailure(
        failures,
        'status/cancel latency',
        'IndexingWorkerController must expose a responsiveness contract with latency thresholds, load scenarios, and main-process probes'
      );
      pushFailure(
        failures,
        'durable cancel checkpoints',
        'IndexingWorkerController must expose durable status fields and scan/read/tokenize/insert/embedding/HNSW/commit cancel checkpoints'
      );
    } else {
      const thresholds = contract.thresholds || {};
      if (Number(thresholds.statusCancelP95Ms) > LATENCY_BUDGET_MS.statusCancelP95 || !Number.isFinite(Number(thresholds.statusCancelP95Ms))) {
        pushFailure(failures, 'status/cancel latency', 'status/cancel IPC p95 threshold must be <= 1000ms');
      }
      if (Number(thresholds.statusCancelP99Ms) > LATENCY_BUDGET_MS.statusCancelP99 || !Number.isFinite(Number(thresholds.statusCancelP99Ms))) {
        pushFailure(failures, 'status/cancel latency', 'status/cancel IPC p99 threshold must be <= 3000ms');
      }
      if (Number(thresholds.statusCancelMaxMs) > LATENCY_BUDGET_MS.statusCancelMax || !Number.isFinite(Number(thresholds.statusCancelMaxMs))) {
        pushFailure(failures, 'status/cancel latency', 'status/cancel IPC max threshold must be <= 5000ms');
      }
      if (Number(thresholds.mainHeartbeatMaxGapMs) > LATENCY_BUDGET_MS.mainHeartbeatMaxGap || !Number.isFinite(Number(thresholds.mainHeartbeatMaxGapMs))) {
        pushFailure(failures, 'status/cancel latency', 'main-process heartbeat max gap threshold must be <= 2000ms');
      }

      const missingLoads = includesAll(contract.loadScenarios, REQUIRED_LOADS);
      if (missingLoads.length > 0) {
        pushFailure(
          failures,
          'status/cancel latency',
          `responsiveness regression must cover load scenarios: ${missingLoads.join(', ')}`
        );
      }

      const missingProbes = includesAll(contract.probes, REQUIRED_PROBES);
      if (missingProbes.length > 0) {
        pushFailure(
          failures,
          'status/cancel latency',
          `responsiveness regression must probe tray menu, window focus/close, MCP read/search, status/cancel IPC, and heartbeat; missing: ${missingProbes.join(', ')}`
        );
      }

      const missingStatusFields = includesAll(contract.durableStatusFields, REQUIRED_STATUS_FIELDS);
      if (missingStatusFields.length > 0) {
        pushFailure(
          failures,
          'durable cancel checkpoints',
          `durable job status must include phase/progress/currentPath/heartbeatAt/cancelRequested/diagnostic fields; missing: ${missingStatusFields.join(', ')}`
        );
      }

      const missingCheckpoints = includesAll(contract.cancelCheckpoints, REQUIRED_CANCEL_CHECKPOINTS);
      if (missingCheckpoints.length > 0) {
        pushFailure(
          failures,
          'durable cancel checkpoints',
          `worker cancel checks must exist at scan/read/tokenize/insert/embedding/HNSW/commit safe checkpoints; missing: ${missingCheckpoints.join(', ')}`
        );
      }
    }

    if (shouldRun('sqlite-generation')) {
      const hasGenerationMethods = [
        'beginStagedRebuild',
        'commitStagedGeneration',
        'getCommittedGeneration'
      ].every((name) => typeof SQLiteKeywordIndex.prototype[name] === 'function');
      const hasGenerationMarkers =
        /committed[_-]?generation|generation[_-]?id|revision[_-]?id/i.test(sqliteStoreSource) &&
        /staging|stage|swap|commit/i.test(sqliteStoreSource);

      if (!hasGenerationMethods && !hasGenerationMarkers) {
        pushFailure(
          failures,
          'committed generation',
          'SQLite keyword rebuild must use worker-owned staged generation/revision commit semantics so cancel, failure, or worker crash preserves the last committed searchable generation'
        );
      }

      try {
        const sqlitePath = path.join(indexDataDir, 'behavior-search-index.sqlite3');
        const sqliteIndex = new SQLiteKeywordIndex({ dbPath: sqlitePath, sourceRoot: docsDir });
        const oldDoc = searchDocument(path.join(docsDir, 'old.md'), 'Old', 'alpha committed needle');
        const newDoc = searchDocument(path.join(docsDir, 'new.md'), 'New', 'beta replacement needle');
        const firstCommit = sqliteIndex.rebuild([oldDoc]);
        assertContract(
          firstCommit && firstCommit.backupManifest && firstCommit.backupManifest.backupSkipped === true,
          'rebuild backup manifest',
          'SQLite rebuild must record an explicit redacted backup-skip manifest when it does not perform a full backup'
        );
        assertContract(sqliteIndex.search('alpha', { limit: 5 }).length === 1, 'committed generation behavior', 'initial committed generation is searchable');

        const staged = sqliteIndex.beginStagedRebuild([newDoc], { batchSize: 1 });
        let stagedFailure = false;
        try {
          sqliteIndex.commitStagedGeneration({ generationId: `${staged.generationId}-missing`, revisionId: staged.revisionId });
        } catch {
          stagedFailure = true;
        }
        assertContract(stagedFailure, 'committed generation behavior', 'committing an unknown staged generation must fail');
        assertContract(sqliteIndex.search('alpha', { limit: 5 }).length === 1, 'committed generation behavior', 'failed staged commit preserves previous searchable generation');
        assertContract(sqliteIndex.search('beta', { limit: 5 }).length === 0, 'committed generation behavior', 'failed staged commit does not expose staged replacement data');

        let cancelled = false;
        try {
          sqliteIndex.rebuild([newDoc], {
            batchSize: 1,
            shouldCancel: (phase) => phase === 'commit'
          });
        } catch (err) {
          cancelled = err && err.code === 'INDEX_REBUILD_CANCELLED';
        }
        assertContract(cancelled, 'committed generation behavior', 'cancellation before commit must abort the staged generation');
        assertContract(sqliteIndex.search('alpha', { limit: 5 }).length === 1, 'committed generation behavior', 'cancel before commit preserves previous searchable generation');
        assertContract(sqliteIndex.search('beta', { limit: 5 }).length === 0, 'committed generation behavior', 'cancel before commit does not expose replacement data');

        const progressDocs = Array.from({ length: 5 }, (_, index) => (
          searchDocument(
            path.join(docsDir, `progress-${index}.md`),
            `Progress ${index}`,
            `progress callback needle ${index}`
          )
        ));
        const progressEvents = [];
        sqliteIndex.rebuild(progressDocs, {
          batchSize: 2,
          onProgress(event) {
            progressEvents.push(event);
          }
        });
        assertContract(
          progressEvents.some((event) => (
            event &&
            event.phase === 'insert' &&
            event.current > 0 &&
            event.total === progressDocs.length &&
            String(event.currentPath || '').endsWith('.md')
          )),
          'SQLite rebuild save progress',
          'SQLite staged rebuild must report insert/save progress with current document path during long save phases'
        );
        assertContract(
          progressEvents.some((event) => event && event.phase === 'commit' && event.current === progressDocs.length),
          'SQLite rebuild save progress',
          'SQLite staged rebuild must report commit progress before swapping the staged generation'
        );

        const onePercentDocs = Array.from({ length: 350 }, (_, index) => (
          searchDocument(
            path.join(docsDir, `one-percent-${String(index).padStart(3, '0')}.md`),
            `One Percent ${index}`,
            `one percent progress needle ${index}`
          )
        ));
        const onePercentValues = [];
        sqliteIndex.rebuild(onePercentDocs, {
          onProgress(event) {
            if (event && event.phase === 'insert' && event.total > 0) {
              onePercentValues.push(Math.round((event.current / event.total) * 100));
            }
          }
        });
        const maxProgressJump = onePercentValues.reduce((maxJump, value, index) => {
          const previous = index === 0 ? 0 : onePercentValues[index - 1];
          return Math.max(maxJump, value - previous);
        }, 0);
        assertContract(
          maxProgressJump <= 1,
          'SQLite rebuild save progress',
          'default SQLite staged rebuild progress must update in one-percent UI increments instead of large batch jumps'
        );
        sqliteIndex.close();

        const deleteFailurePath = path.join(indexDataDir, 'delete-failure.sqlite3');
        fs.mkdirSync(deleteFailurePath, { recursive: true });
        const deleteFailureIndex = new SQLiteKeywordIndex({ dbPath: deleteFailurePath, sourceRoot: docsDir });
        const deleteResult = deleteFailureIndex.deleteFiles({ throwOnFailure: false });
        assertContract(deleteResult.deleted === false && deleteResult.failedCount > 0, 'verified delete failure', 'deleteFiles must report deletion verification failure instead of swallowing it');
        let deleteThrow = false;
        try {
          deleteFailureIndex.deleteFiles();
        } catch (err) {
          deleteThrow = err && err.code === 'SQLITE_KEYWORD_INDEX_DELETE_FAILED';
        }
        assertContract(deleteThrow, 'verified delete failure', 'deleteFiles default path must throw on verified deletion failure');

        const clearDocsDir = path.join(tmp, 'clear-docs');
        const clearIndexDataDir = path.join(tmp, 'clear-userData', 'index');
        fs.mkdirSync(clearDocsDir, { recursive: true });
        fs.mkdirSync(clearIndexDataDir, { recursive: true });
        fs.writeFileSync(path.join(clearDocsDir, 'clear.md'), '---\ntitle: Clear\n---\nclear worker needle', 'utf-8');
        const clearEngine = new SearchEngine(createStore(clearDocsDir), {
          indexBackend: 'sqlite',
          indexDataDir: clearIndexDataDir
        });
        try {
          await clearEngine.rebuild();
          const clearController = clearEngine.getIndexingWorkerController();
          assertContract(clearController && typeof clearController.enqueueClear === 'function', 'worker-owned clear', 'IndexingWorkerController must expose enqueueClear for worker-owned SQLite clear');
          const clearResult = await clearEngine.clear();
          assertContract(clearResult.scheduled === true && clearResult.cleared === false, 'worker-owned clear', 'SQLite clear must schedule worker-owned backup/delete instead of completing synchronously in SearchEngine.clear');
          await waitForControllerIdle(clearController);
          assertContract(!fs.existsSync(clearEngine.getIndexPath()), 'worker-owned clear', 'worker-owned clear deletes the SQLite DB after backup manifest creation');
        } finally {
          clearEngine.close();
        }

        const liveDocsDir = path.join(tmp, 'live-rebuild-docs');
        const liveIndexDataDir = path.join(tmp, 'live-rebuild-userData', 'index');
        fs.mkdirSync(liveDocsDir, { recursive: true });
        fs.mkdirSync(liveIndexDataDir, { recursive: true });
        fs.writeFileSync(path.join(liveDocsDir, 'old.md'), '---\ntitle: Old\n---\n# Old\n\nold committed needle', 'utf-8');
        const liveEngine = new SearchEngine(createStore(liveDocsDir), {
          indexBackend: 'sqlite',
          indexDataDir: liveIndexDataDir,
          smartIndexDelayMs: 60000
        });
        try {
          await liveEngine.rebuild();
          const liveRebuildDocCount = 500;
          for (let i = 0; i < liveRebuildDocCount; i += 1) {
            fs.writeFileSync(
              path.join(liveDocsDir, `bulk-${String(i).padStart(3, '0')}.md`),
              `---\ntitle: Bulk ${i}\n---\n# Bulk ${i}\n\nbulk rebuild needle ${i}`,
              'utf-8'
            );
          }

          const resetStart = liveEngine.startRebuild();
          assertContract(resetStart.scheduled === true && resetStart.jobId, 'live rebuild status', 'settings rebuild must schedule a worker job for live status');
          const startedStatus = resetStart.status || liveEngine.getStatus();
          assertContract(
            startedStatus.rebuildSession && startedStatus.rebuildSession.indexedCount === 0,
            'live rebuild status',
            'full rebuild status starts indexedCount at 0'
          );
          assertContract(
            startedStatus.indexedCount === 0,
            'live rebuild status',
            'visible indexed count resets to 0 during full rebuild'
          );
          fs.writeFileSync(
            path.join(liveDocsDir, 'new-during-rebuild.md'),
            '---\ntitle: Added During Rebuild\n---\n# Added During Rebuild\n\nunique-mid-rebuild-token',
            'utf-8'
          );

          const publicStatus = await waitForStatus(
            () => liveEngine.getStatus(),
            (status) => status &&
              status.rebuildSession &&
              status.rebuildSession.active === true &&
              status.rebuildSession.totalCount >= liveRebuildDocCount &&
              status.rebuildSession.indexedCount > 0 &&
              /\.md$/.test(String(status.currentPath || ''))
          );
          assertContract(!String(publicStatus.currentPath || '').includes(tmp), 'redacted rebuild status', 'public currentPath must not expose the raw temp path');
          assertContract(/\.md$/.test(String(publicStatus.currentPath || '')), 'live rebuild status', 'public currentPath should identify the current Markdown file');
          await waitForControllerIdle(liveEngine.getIndexingWorkerController(), 20000);
          await waitForStatus(
            () => liveEngine.getStatus(),
            (status) => status && status.state === 'ready' && status.indexedCount >= liveRebuildDocCount + 2,
            5000
          );
          assertContract(
            liveEngine.search('unique-mid-rebuild-token', { limit: 5 }).some((result) => path.basename(result.filePath) === 'new-during-rebuild.md'),
            'mid-rebuild additions',
            'full rebuild must include Markdown files added before rebuild commit'
          );
        } finally {
          liveEngine.close();
        }

        const redactionDocsDir = path.join(tmp, 'public-redaction-docs');
        const redactionIndexDataDir = path.join(tmp, 'public-redaction-userData', 'index');
        fs.mkdirSync(redactionDocsDir, { recursive: true });
        fs.mkdirSync(redactionIndexDataDir, { recursive: true });
        const redactionPath = path.join(redactionDocsDir, 'raw-leak.md');
        fs.writeFileSync(redactionPath, '# Raw Leak\n\nraw path leak fixture', 'utf-8');
        const redactionEngine = new SearchEngine(createStore(redactionDocsDir), {
          indexBackend: 'sqlite',
          indexDataDir: redactionIndexDataDir,
          indexingWorkerController: {
            isActive: () => true,
            getStatus: () => ({
              active: true,
              kind: 'rebuild',
              state: 'rebuilding',
              phase: 'read',
              progress: { current: 1, total: 2 },
              currentPath: redactionPath,
              diagnostic: {
                code: 'raw_path_probe',
                message: `raw paths ${redactionDocsDir} ${redactionIndexDataDir} ${redactionPath}`
              },
              rebuildSession: {
                active: true,
                indexedCount: 1,
                pendingCount: 1,
                totalCount: 2,
                currentPath: redactionPath
              }
            })
          }
        });
        try {
          redactionEngine._status.failedFiles = [{
            filePath: redactionPath,
            phase: 'read',
            error: `failed under ${redactionDocsDir}`
          }];
          redactionEngine._status.errorSummary = `raw summary ${redactionIndexDataDir}`;
          const publicStatusJson = JSON.stringify(redactionEngine.getStatus());
          for (const forbiddenPath of [redactionDocsDir, redactionIndexDataDir, redactionPath, path.dirname(redactionIndexDataDir)]) {
            const escapedForbiddenPath = JSON.stringify(forbiddenPath).slice(1, -1);
            assertContract(
              !publicStatusJson.includes(forbiddenPath) && !publicStatusJson.includes(escapedForbiddenPath),
              'redacted rebuild status',
              `public indexing status must not expose raw path ${forbiddenPath}`
            );
          }
          assertContract(publicStatusJson.includes('raw-leak.md'), 'redacted rebuild status', 'source-root files remain visible as source-relative display paths');
          assertContract(publicStatusJson.includes('[REDACTED_PATH:'), 'redacted rebuild status', 'non-source index paths are represented by redacted tokens');
        } finally {
          redactionEngine.close();
        }

        const resetDocsDir = path.join(tmp, 'full-reset-docs');
        const resetIndexDataDir = path.join(tmp, 'full-reset-userData', 'index');
        fs.mkdirSync(resetDocsDir, { recursive: true });
        fs.mkdirSync(resetIndexDataDir, { recursive: true });
        const resetPath = path.join(resetDocsDir, 'reset.md');
        fs.writeFileSync(resetPath, '---\ntitle: Reset\n---\n# Reset\n\nfresh reset needle', 'utf-8');
        const resetEngine = new SearchEngine(createStore(resetDocsDir), {
          indexBackend: 'sqlite',
          indexDataDir: resetIndexDataDir,
          smartIndexDelayMs: 60000
        });
        try {
          await resetEngine.rebuild();
          const resetLedger = resetEngine.getSourceLedger();
          const resetSource = resetLedger.recordSource({
            rootPathInternal: resetDocsDir,
            rootFingerprint: 'full-reset-root',
            includeGlobs: ['**/*.md'],
            excludeGlobs: []
          });
          const resetDocument = resetLedger.upsertDocument({
            sourceId: resetSource.sourceId,
            sourceRelativePath: 'reset.md',
            pathKey: 'reset.md',
            canonicalPathInternal: resetPath,
            contentHash: 'stale-document-content',
            docType: 'guide'
          });
          const staleChunk = resetLedger.upsertChunk({
            documentId: resetDocument.documentId,
            ordinal: 0,
            headingPath: ['Reset'],
            searchText: 'stale semantic text',
            text: 'stale semantic text',
            textHash: 'stale-chunk-text'
          });
          const resetModel = resetLedger.upsertEmbeddingModel({
            provider: 'openai-compatible',
            modelName: 'reset-model',
            modelFingerprint: 'reset-fingerprint',
            dimensions: 3
          });
          const staleAnnFile = path.join(resetIndexDataDir, 'stale.hnsw');
          const unsafeUserDataFile = path.join(path.dirname(resetIndexDataDir), 'do-not-delete.hnsw');
          fs.writeFileSync(staleAnnFile, 'stale ann artifact', 'utf-8');
          fs.writeFileSync(unsafeUserDataFile, 'outside index artifact dir', 'utf-8');
          let outsideAnnRejected = false;
          try {
            resetLedger.recordAnnIndex({
              annIndexId: 'ann_outside_api_rejected',
              modelId: resetModel.modelId,
              indexPathInternal: unsafeUserDataFile,
              checksum: 'unsafe-checksum',
              status: 'committed'
            });
          } catch (err) {
            outsideAnnRejected = err && err.code === 'ANN_INDEX_PATH_OUTSIDE_INDEX_DIR';
          }
          resetLedger.open().prepare(`
            INSERT OR REPLACE INTO ann_indexes(
              ann_index_id, model_id, index_path_internal, index_path_token,
              params_json, checksum, status, created_at, committed_at, updated_at
            )
            VALUES (
              'ann_polluted_user_data_path', @modelId, @indexPathInternal, '[REDACTED_PATH:polluted]',
              '{}', 'polluted-checksum', 'committed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            )
          `).run({
            modelId: resetModel.modelId,
            indexPathInternal: unsafeUserDataFile
          });
          resetLedger.upsertChunkEmbedding({
            chunkId: staleChunk.chunk_id,
            modelId: resetModel.modelId,
            embedding: [1, 0, 0],
            vectorHash: 'sha256:stale',
            status: 'active'
          });
          const staleAnn = resetLedger.recordAnnIndex({
            modelId: resetModel.modelId,
            indexPathInternal: path.join(resetIndexDataDir, 'stale.hnsw'),
            checksum: 'stale-checksum',
            status: 'committed'
          });
          resetLedger.replaceAnnMemberships({
            annIndexId: staleAnn.ann_index_id,
            modelId: resetModel.modelId,
            memberships: [{ chunkId: staleChunk.chunk_id, annLabel: 1 }]
          });
          resetLedger.enqueueIndexJob({
            jobId: 'stale-reset-job',
            sourceId: resetSource.sourceId,
            documentId: resetDocument.documentId,
            jobType: 'index_document',
            status: 'completed',
            requestedBy: 'stale-before-rebuild',
            currentPathInternal: resetPath,
            contentHash: 'stale-document-content'
          });

          const resetStart = resetEngine.startRebuild();
          assertContract(resetStart.scheduled === true && resetStart.jobId, 'settings rebuild full reset', 'settings rebuild must schedule a worker job');
          await waitForControllerIdle(resetEngine.getIndexingWorkerController());

          const staleCounts = resetLedger.open().prepare(`
            SELECT
              (SELECT COUNT(*) FROM chunks) AS chunks,
              (SELECT COUNT(*) FROM chunk_search_content) AS chunkSearchContent,
              (SELECT COUNT(*) FROM chunk_embeddings) AS chunkEmbeddings,
              (SELECT COUNT(*) FROM ann_indexes) AS annIndexes,
              (SELECT COUNT(*) FROM ann_memberships) AS annMemberships,
              (SELECT COUNT(*) FROM index_jobs WHERE requested_by = 'stale-before-rebuild') AS staleJobs
          `).get();
          assertContract(
            staleCounts.chunks === 0 &&
              staleCounts.chunkSearchContent === 0 &&
              staleCounts.chunkEmbeddings === 0 &&
              staleCounts.annIndexes === 0 &&
              staleCounts.annMemberships === 0 &&
              staleCounts.staleJobs === 0,
            'settings rebuild full reset',
            'settings rebuild must remove stale chunk/search/embedding/ANN/index job derived state before rebuilding from scratch'
          );
          const requeued = resetLedger.open().prepare(`
            SELECT COUNT(*) AS count
            FROM index_jobs
            WHERE requested_by = 'settings.rebuild.full-reset'
              AND status = 'queued'
              AND document_id = ?
          `).get(resetDocument.documentId);
          assertContract(
            Number(requeued && requeued.count) >= 1,
            'settings rebuild full reset',
            'settings rebuild must queue active documents for fresh semantic/link/HNSW indexing after clearing derived state'
          );
          assertContract(
            resetEngine.search('fresh reset needle', { limit: 5 }).length === 1,
            'settings rebuild full reset',
            'settings rebuild must still rebuild the keyword index from source Markdown'
          );
          assertContract(fs.existsSync(unsafeUserDataFile), 'safe ANN cleanup', 'full reset must not delete userData files outside the index artifact directory');
          assertContract(!fs.existsSync(staleAnnFile), 'safe ANN cleanup', 'full reset deletes contained stale ANN artifact files');
          assertContract(outsideAnnRejected, 'safe ANN cleanup', 'recordAnnIndex rejects ANN artifact paths outside the index artifact directory');
          const sourceAfterReset = resetLedger.open().prepare('SELECT source_id AS sourceId FROM sources WHERE source_id = ?').get(resetSource.sourceId);
          const documentAfterReset = resetLedger.open().prepare('SELECT document_id AS documentId FROM documents WHERE document_id = ?').get(resetDocument.documentId);
          assertContract(sourceAfterReset && sourceAfterReset.sourceId === resetSource.sourceId, 'source identity preservation', 'full reset preserves source identity rows');
          assertContract(documentAfterReset && documentAfterReset.documentId === resetDocument.documentId, 'source identity preservation', 'full reset preserves document identity rows');
        } finally {
          resetEngine.close();
        }

        const postCommitDocsDir = path.join(tmp, 'post-commit-recovery-docs');
        const postCommitIndexDataDir = path.join(tmp, 'post-commit-recovery-userData', 'index');
        fs.mkdirSync(postCommitDocsDir, { recursive: true });
        fs.mkdirSync(postCommitIndexDataDir, { recursive: true });
        const postCommitEngine = new SearchEngine(createStore(postCommitDocsDir), {
          indexBackend: 'sqlite',
          indexDataDir: postCommitIndexDataDir,
          disableIndexingWorkerController: true
        });
        try {
          const postCommitLedger = postCommitEngine.getSourceLedger();
          postCommitLedger.enqueueIndexJob({
            jobId: 'job_post_commit_reset_gap',
            jobType: 'keyword_rebuild',
            status: 'indexing',
            requestedBy: 'settings.rebuild',
            phase: 'commit',
            currentPathInternal: postCommitDocsDir
          });
          let releasePostCommitReset = null;
          const postCommitResetGate = new Promise((resolve) => {
            releasePostCommitReset = resolve;
          });
          let resolvedAfterReset = false;
          const postCommitController = new IndexingWorkerController({
            ledgerProvider: () => postCommitLedger,
            onJobCompleted: () => postCommitResetGate
          });
          const postCommitJob = {
            jobId: 'job_post_commit_reset_gap',
            kind: 'rebuild',
            state: 'rebuilding',
            status: {
              jobId: 'job_post_commit_reset_gap',
              kind: 'rebuild',
              active: true,
              state: 'rebuilding',
              phase: 'commit',
              progress: { current: 1, total: 1 },
              currentPath: postCommitDocsDir,
              heartbeatAt: new Date().toISOString(),
              cancelRequested: false,
              diagnostic: null
            },
            worker: {
              removeAllListeners() {},
              unref() {}
            },
            resolve() {
              resolvedAfterReset = true;
            },
            reject(err) {
              throw err;
            },
            settled: false
          };
          postCommitController.activeJob = postCommitJob;
          postCommitController._finishJob(postCommitJob, 'completed', { indexed: 1, scanned: 1 }, null);
          const duringPostCommitReset = postCommitLedger.getIndexJob('job_post_commit_reset_gap');
          assertContract(
            duringPostCommitReset.status === 'indexing' && duringPostCommitReset.phase === 'post-commit-reset',
            'post-commit rebuild recovery',
            'keyword_rebuild job remains restartable until post-commit reset/requeue callback completes'
          );
          assertContract(!resolvedAfterReset, 'post-commit rebuild recovery', 'worker rebuild promise does not resolve before post-commit reset/requeue completes');
          releasePostCommitReset();
          await new Promise((resolve) => setTimeout(resolve, 25));
          const afterPostCommitReset = postCommitLedger.getIndexJob('job_post_commit_reset_gap');
          assertContract(afterPostCommitReset.status === 'completed', 'post-commit rebuild recovery', 'keyword_rebuild job is completed after post-commit reset/requeue callback completes');
          assertContract(resolvedAfterReset, 'post-commit rebuild recovery', 'worker rebuild promise resolves after post-commit reset/requeue completes');
        } finally {
          postCommitEngine.close();
        }

        let fakeWorkerActive = true;
        const busyEngine = new SearchEngine(createStore(docsDir), {
          indexBackend: 'sqlite',
          indexDataDir,
          indexingWorkerController: {
            isActive: () => fakeWorkerActive,
            getStatus: () => ({ active: fakeWorkerActive, state: fakeWorkerActive ? 'rebuilding' : 'idle', phase: fakeWorkerActive ? 'commit' : null })
          }
        });
        try {
          const busyResult = await busyEngine.clear();
          assertContract(busyResult.cleared === false && busyResult.reason === 'job-in-progress', 'clear serialization', 'clear must not run while a worker-controller job is active');
          fakeWorkerActive = false;
          busyEngine._compactInFlight = Promise.resolve();
          const compactBusyResult = await busyEngine.clear();
          assertContract(compactBusyResult.cleared === false && compactBusyResult.reason === 'job-in-progress', 'clear serialization', 'clear must not run while compact is in flight');
          busyEngine._compactInFlight = null;
          busyEngine._rebuildPromise = Promise.resolve();
          const rebuildBusyResult = await busyEngine.clear();
          assertContract(rebuildBusyResult.cleared === false && rebuildBusyResult.reason === 'job-in-progress', 'clear serialization', 'clear must not run while rebuild is in flight');
          busyEngine._rebuildPromise = null;
          busyEngine._clearInFlight = Promise.resolve();
          const clearBusyResult = await busyEngine.clear();
          assertContract(clearBusyResult.cleared === false && clearBusyResult.reason === 'job-in-progress', 'clear serialization', 'clear must not run while another clear is in flight');
          busyEngine._clearInFlight = null;
        } finally {
          busyEngine.close();
        }
      } catch (err) {
        pushFailure(failures, err.signature || 'sqlite-generation behavior', err.message || String(err));
      }
    }

    if (!FOCUS && hasQueryTimeHnswBuild(searchEngineSource)) {
      pushFailure(
        failures,
        'query-time HNSW build',
        'smart_search must not create/populate an in-memory HNSW index from SQLite vectors on the request path; use committed HNSW, SQLite vector fallback, or keyword-only degraded results'
      );
    }

    if (failures.length > 0) {
      const error = new Error([
        'REL-DOC-007 expected RED worker responsiveness contract failure.',
        ...failures.map((failure) => `- ${failure}`)
      ].join('\n'));
      error.code = 'REL_DOC_007_WORKER_CONTRACT_RED';
      throw error;
    }

    console.log(`test-search-index-worker-contract: ${FOCUS || 'full'} assertions passed`);
  } finally {
    if (engine && typeof engine.close === 'function') engine.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
