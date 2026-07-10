'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SearchEngine } = require('../src/main/search-engine');

function createStore(dir) {
  return {
    _data: {
      mcpAutoSave: true,
      mcpAutoSavePath: dir
    },
    get(key, defaultValue) {
      return Object.prototype.hasOwnProperty.call(this._data, key) ? this._data[key] : defaultValue;
    }
  };
}

function writeDoc(dir, name, frontmatter, body) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, `${frontmatter}\n${body}`, 'utf-8');
  return filePath;
}

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-search-life-'));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function waitFor(predicate, timeoutMs = 500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

(async () => {
  await withTempDir(async (dir) => {
    const indexDataDir = path.join(dir, 'userData', 'index');
    assert.strictEqual(fs.existsSync(indexDataDir), false, 'test starts without an index data directory');

    const engine = new SearchEngine(createStore(dir), {
      indexBackend: 'sqlite',
      indexDataDir
    });
    try {
      assert.strictEqual(fs.existsSync(indexDataDir), true, 'SQLite index data directory is created during SearchEngine construction');
      assert.strictEqual(fs.existsSync(path.join(indexDataDir, 'search-index.sqlite3')), false, 'process initialization does not create the SQLite DB file before indexing');
    } finally {
      engine.close();
    }
  });

  {
    const engine = new SearchEngine(createStore(''));
    try {
      const blocked = engine.startRebuild();
      assert.strictEqual(blocked.started, false, 'full rebuild does not start without a configured document store root');
      assert.strictEqual(blocked.scheduled, false, 'full rebuild is not queued without a configured document store root');
      assert.strictEqual(blocked.reason, 'source-root-unconfigured', 'full rebuild reports source root configuration as the missing prerequisite');
      const status = engine.getStatus();
      assert.notStrictEqual(status.state, 'degraded', 'source-root configuration failure is not reported as a degraded index');
      assert(!String(status.errorSummary || '').includes('mcpAutoSavePath'), 'source-root configuration failure does not expose raw mcpAutoSavePath errors');
    } finally {
      engine.close();
    }
  }

  await withTempDir(async (dir) => {
    const missingRoot = path.join(dir, 'missing-document-store');
    const engine = new SearchEngine(createStore(missingRoot));
    try {
      const blocked = engine.startRebuild();
      assert.strictEqual(blocked.started, false, 'full rebuild does not start when the configured document store root does not exist');
      assert.strictEqual(blocked.scheduled, false, 'full rebuild is not queued when the configured document store root does not exist');
      assert.strictEqual(blocked.reason, 'source-root-unavailable', 'full rebuild reports unavailable source root for missing directories');
      const status = engine.getStatus();
      assert.notStrictEqual(status.state, 'degraded', 'missing source-root configuration is not reported as a degraded index');
    } finally {
      engine.close();
    }
  });

  await withTempDir(async (dir) => {
    writeDoc(dir, 'a.md', '---\nproject: Alpha\n---', '# Alpha\n\nstartup keyword');

    const engine = new SearchEngine(createStore(dir));
    let rebuildCalled = false;
    let startupReconcileCalled = false;
    engine.rebuild = async () => {
      rebuildCalled = true;
      throw new Error('startup initialize must not rebuild');
    };
    engine.reconcileStartupIndexJobs = () => {
      startupReconcileCalled = true;
      return { examined: 0, resumed: 0, failed: 0, cancelled: 0 };
    };

    await engine.initialize();
    await engine.ensureFresh();
    const status = engine.getStatus();

    assert.strictEqual(rebuildCalled, false, 'startup initialize does not run a full rebuild when no index exists');
    assert.strictEqual(startupReconcileCalled, false, 'startup initialize does not synchronously reconcile index jobs');
    assert.strictEqual(status.state, 'stale', 'missing startup index is reported as stale');
    assert.strictEqual(status.dirty, true, 'missing startup index requires settings rebuild');
    assert(status.errorSummary.includes('Search index is missing'), 'missing startup index diagnostic is user-visible');
  });

  await withTempDir(async (dir) => {
    writeDoc(dir, 'a.md', '---\nproject: Alpha\n---', '# Alpha\n\nmissing index rebuild clears diagnostic');
    const engine = new SearchEngine(createStore(dir), {
      smartIndexDelayMs: 60000
    });
    try {
      await engine.initialize();
      const missingStatus = engine.getStatus();
      assert(missingStatus.errorSummary.includes('Search index is missing'), 'missing startup index diagnostic is visible before rebuild');

      const started = engine.startRebuild();
      assert.strictEqual(started.scheduled, true, 'settings rebuild schedules a worker job from a missing index state');
      assert.strictEqual(started.status.errorSummary, null, 'starting full rebuild clears the stale missing-index diagnostic immediately');

      await engine._rebuildPromise;
      const completedStatus = engine.getStatus();
      assert.strictEqual(completedStatus.state, 'ready', 'worker rebuild returns the search index to ready');
      assert.strictEqual(completedStatus.dirty, false, 'worker rebuild clears dirty missing-index state');
      assert.strictEqual(completedStatus.errorSummary, null, 'worker rebuild completion keeps missing-index diagnostic cleared');
      assert.strictEqual(completedStatus.rebuildSession && completedStatus.rebuildSession.active, false, 'worker rebuild completion marks public rebuild session inactive');
      assert.strictEqual(completedStatus.indexingWorker && completedStatus.indexingWorker.rebuildSession && completedStatus.indexingWorker.rebuildSession.active, false, 'worker controller terminal status does not keep rebuildSession active');
      assert(engine.search('diagnostic').some((result) => path.basename(result.filePath) === 'a.md'), 'rebuilt index is searchable after clearing the diagnostic');
    } finally {
      engine.close();
    }
  });

  await withTempDir(async (dir) => {
    writeDoc(dir, 'a.md', '---\nproject: Alpha\n---', '# Alpha\n\nmissing index rebuild worker start failure');
    const engine = new SearchEngine(createStore(dir), {
      indexingWorkerController: {
        isActive: () => false,
        getStatus: () => ({
          active: false,
          state: 'failed',
          phase: 'start',
          progress: { current: 0, total: 0 },
          currentPath: null,
          diagnostic: { code: 'worker_start_failed', message: 'Worker could not start' },
          rebuildSession: { active: false, indexedCount: 0, pendingCount: 0, totalCount: 0, currentPath: null }
        }),
        enqueueRebuild: () => ({
          started: false,
          scheduled: false,
          reason: 'worker-start-failed',
          status: {
            active: false,
            state: 'failed',
            phase: 'start',
            progress: { current: 0, total: 0 },
            currentPath: null,
            diagnostic: { code: 'worker_start_failed', message: 'Worker could not start' },
            rebuildSession: { active: false, indexedCount: 0, pendingCount: 0, totalCount: 0, currentPath: null }
          }
        })
      }
    });
    try {
      await engine.initialize();
      assert(engine.getStatus().errorSummary.includes('Search index is missing'), 'missing index diagnostic is visible before failed rebuild start');

      const failed = engine.startRebuild();
      assert.strictEqual(failed.started, false, 'worker start failure does not report rebuild started');
      assert.strictEqual(failed.scheduled, false, 'worker start failure does not report rebuild scheduled');
      assert.strictEqual(failed.reason, 'worker-start-failed', 'worker start failure reason is returned to Settings');
      assert.notStrictEqual(failed.status.errorSummary, null, 'failed rebuild start replaces stale missing-index diagnostic');
      assert(!failed.status.errorSummary.includes('Search index is missing'), 'failed rebuild start does not keep stale missing-index guidance');
      assert(failed.status.errorSummary.includes('worker-start-failed') || failed.status.errorSummary.includes('Worker could not start'), 'failed rebuild start reports the current worker failure');
      assert.strictEqual(failed.status.rebuildSession && failed.status.rebuildSession.active, false, 'failed rebuild start leaves rebuild session inactive');
    } finally {
      engine.close();
    }
  });

  await withTempDir(async (dir) => {
    writeDoc(dir, 'a.md', '---\nproject: Alpha\n---', '# Alpha\n\nmissing index rebuild source root disappears');
    const engine = new SearchEngine(createStore(dir), {
      smartIndexDelayMs: 60000
    });
    try {
      await engine.initialize();
      assert(engine.getStatus().errorSummary.includes('Search index is missing'), 'missing index diagnostic is visible before source root disappears');
      fs.rmSync(dir, { recursive: true, force: true });

      const failed = engine.startRebuild();
      assert.strictEqual(failed.started, false, 'full rebuild does not start when source root disappeared after initialize');
      assert.strictEqual(failed.scheduled, false, 'full rebuild is not scheduled when source root disappeared after initialize');
      assert.strictEqual(failed.reason, 'source-root-unavailable', 'full rebuild reports the current missing source root');
      assert.notStrictEqual(failed.status.errorSummary, null, 'source root failure replaces stale missing-index diagnostic');
      assert(!failed.status.errorSummary.includes('Search index is missing'), 'source root failure does not keep stale missing-index guidance');
      assert(failed.status.errorSummary.includes('source-root-unavailable'), 'source root failure reports current unavailable-root reason');
      assert.strictEqual(failed.status.rebuildSession && failed.status.rebuildSession.active, false, 'source root failure leaves rebuild session inactive');
    } finally {
      engine.close();
    }
  });

  await withTempDir(async (dir) => {
    writeDoc(dir, 'a.md', '---\nproject: Alpha\n---', '# Alpha\n\nstartup async reconcile');

    const engine = new SearchEngine(createStore(dir), {
      indexBackend: 'sqlite',
      indexDataDir: path.join(dir, 'userData', 'index'),
      startupReconcileDelayMs: 0
    });
    let syncReconcileCalled = false;
    let asyncReconcileCalled = false;
    engine.reconcileStartupIndexJobs = () => {
      syncReconcileCalled = true;
      return { examined: 0, resumed: 0, failed: 0, cancelled: 0 };
    };
    engine.reconcileStartupIndexJobsAsync = async () => {
      asyncReconcileCalled = true;
      return { examined: 0, resumed: 0, failed: 0, cancelled: 0 };
    };

    await engine.initialize();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(syncReconcileCalled, false, 'startup scheduled reconciliation does not use the synchronous reconciliation path');
    assert.strictEqual(asyncReconcileCalled, false, 'startup reconciliation is skipped when no smart-search ledger DB exists');
    assert.strictEqual(fs.existsSync(path.join(engine.getIndexDataDir(), 'smart-search.sqlite3')), false, 'startup reconciliation skip does not create the source ledger DB');
    engine.close();
  });

  await withTempDir(async (dir) => {
    writeDoc(dir, 'a.md', '---\nproject: Alpha\n---', '# Alpha\n\nstartup async reconcile existing ledger');

    const engine = new SearchEngine(createStore(dir), {
      indexBackend: 'sqlite',
      indexDataDir: path.join(dir, 'userData', 'index'),
      startupReconcileDelayMs: 0
    });
    fs.closeSync(fs.openSync(path.join(engine.getIndexDataDir(), 'smart-search.sqlite3'), 'w'));
    let syncReconcileCalled = false;
    let asyncReconcileCalled = false;
    engine.reconcileStartupIndexJobs = () => {
      syncReconcileCalled = true;
      return { examined: 0, resumed: 0, failed: 0, cancelled: 0 };
    };
    engine.reconcileStartupIndexJobsAsync = async () => {
      asyncReconcileCalled = true;
      return { examined: 0, resumed: 0, failed: 0, cancelled: 0 };
    };

    await engine.initialize();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(syncReconcileCalled, false, 'startup scheduled reconciliation with existing ledger does not use the synchronous path');
    assert.strictEqual(asyncReconcileCalled, true, 'startup scheduled reconciliation runs when a smart-search ledger DB exists');
    engine.close();
  });

  await withTempDir(async (dir) => {
    writeDoc(dir, 'a.md', '---\nproject: Alpha\n---', '# Alpha\n\nstartup interrupted keyword rebuild');
    const indexDataDir = path.join(dir, 'userData', 'index');
    const rebuildRequests = [];
    const engine = new SearchEngine(createStore(dir), {
      indexBackend: 'sqlite',
      indexDataDir,
      startupReconcileDelayMs: 0,
      indexingWorkerController: {
        isActive: () => false,
        getStatus: () => ({ active: false, state: 'idle', phase: null, progress: { current: 0, total: 0 }, currentPath: null }),
        enqueueRebuild: (options = {}) => {
          rebuildRequests.push(options);
          return {
            started: true,
            scheduled: true,
            jobId: 'job_startup_rebuild_restart',
            status: { active: true, state: 'rebuilding', phase: 'queued', progress: { current: 0, total: 0 }, currentPath: null }
          };
        }
      }
    });
    try {
      const ledger = engine.getSourceLedger();
      ledger.enqueueIndexJob({
        jobId: 'job_interrupted_keyword_rebuild',
        jobType: 'keyword_rebuild',
        status: 'queued',
        requestedBy: 'settings.rebuild',
        currentPathInternal: dir,
        contentHash: null
      });

      await engine.initialize();
      await waitFor(() => rebuildRequests.length > 0, 1000);

      assert.strictEqual(rebuildRequests.length, 1, 'startup resumes only the interrupted keyword rebuild job as a new rebuild');
      assert.strictEqual(rebuildRequests[0].requestedBy, 'startup.rebuild.interrupted', 'startup interrupted keyword rebuild uses a diagnostic requestedBy value');
      const interrupted = ledger.getIndexJob('job_interrupted_keyword_rebuild');
      assert.strictEqual(interrupted.status, 'failed', 'interrupted keyword rebuild job is closed before the replacement rebuild is queued');
      assert.strictEqual(interrupted.diagnosticCode, 'interrupted_rebuild_restarted', 'interrupted keyword rebuild job records restart diagnostic');
    } finally {
      engine.close();
    }
  });

  await withTempDir(async (dir) => {
    writeDoc(dir, 'a.md', '---\nproject: Alpha\n---', '# Alpha\n\nstartup missing index without interrupted rebuild');
    const rebuildRequests = [];
    const engine = new SearchEngine(createStore(dir), {
      indexBackend: 'sqlite',
      indexDataDir: path.join(dir, 'userData', 'index'),
      startupReconcileDelayMs: 0,
      indexingWorkerController: {
        isActive: () => false,
        getStatus: () => ({ active: false, state: 'idle', phase: null, progress: { current: 0, total: 0 }, currentPath: null }),
        enqueueRebuild: (options = {}) => {
          rebuildRequests.push(options);
          return { started: true, scheduled: true, jobId: 'unexpected-startup-rebuild' };
        }
      }
    });
    try {
      engine.getSourceLedger();
      await engine.initialize();
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.strictEqual(rebuildRequests.length, 0, 'missing index alone does not automatically start full rebuild');
    } finally {
      engine.close();
    }
  });

  await withTempDir(async (dir) => {
    writeDoc(dir, 'a.md', '---\nproject: Alpha\ndocType: guide\n---', '# Alpha Guide\n\nshared keyword alpha');
    writeDoc(dir, 'b.md', '---\nproject: Alpha\ndocType: spec\n---', '# Alpha Spec\n\nshared keyword beta');

    const engine = new SearchEngine(createStore(dir));
    await engine.rebuild();

    const fallbackGuide = engine.search('shared', { docType: 'guide' });
    assert.strictEqual(fallbackGuide.length, 1, 'simple token fallback keeps docType filter');
    assert.strictEqual(fallbackGuide[0].docType, 'guide');
    assert.strictEqual(engine.getStatus().state, 'ready', 'status is ready after rebuild');
  });

  await withTempDir(async (dir) => {
    writeDoc(dir, 'a.md', '---\nproject: Alpha\ndocType: guide\n---', '# Alpha Guide\n\nneedle alpha');
    writeDoc(dir, 'b.md', '---\nproject: Alpha\ndocType: spec\n---', '# Alpha Spec\n\nneedle beta');
    writeDoc(dir, 'c.md', '---\nproject: Beta\ndocType: guide\n---', '# Beta Guide\n\nneedle gamma');

    const engine = new SearchEngine(createStore(dir));
    await engine.rebuild();
    engine.engine.search = () => {
      throw new Error('forced bm25 failure');
    };

    const results = engine.search('needle', { project: 'Alpha', docType: 'spec' });
    assert.strictEqual(results.length, 1, 'BM25 error falls back to keyword-only token search');
    assert.strictEqual(results[0].project, 'Alpha');
    assert.strictEqual(results[0].docType, 'spec');
    assert.strictEqual(engine.getStatus().degradedReason, 'bm25-error', 'status records degraded fallback reason');
  });

  await withTempDir(async (dir) => {
    writeDoc(dir, 'a.md', '---\nproject: Alpha\n---', '# Alpha\n\ncommitted keyword');
    writeDoc(dir, 'b.md', '---\nproject: Beta\n---', '# Beta\n\ncommitted keyword');
    writeDoc(dir, 'c.md', '---\nproject: Gamma\n---', '# Gamma\n\ncommitted keyword');

    const engine = new SearchEngine(createStore(dir));
    await engine.rebuild();
    const indexPath = path.join(dir, '.doculight-search-index.json');
    const committedIndex = fs.readFileSync(indexPath, 'utf-8');
    const committedCount = engine.docMeta.size;

    writeDoc(dir, 'd.md', '---\nproject: Delta\n---', '# Delta\n\nnew keyword');

    const originalRename = fs.promises.rename;
    fs.promises.rename = async (from, to) => {
      if (to === indexPath) {
        throw new Error('forced atomic rename failure');
      }
      return originalRename.call(fs.promises, from, to);
    };

    let failed = false;
    try {
      await engine.rebuild();
    } catch {
      failed = true;
    } finally {
      fs.promises.rename = originalRename;
    }

    assert.strictEqual(failed, true, 'rebuild reports atomic write failure');
    assert.strictEqual(fs.readFileSync(indexPath, 'utf-8'), committedIndex, 'committed JSON index is preserved');
    assert.strictEqual(engine.docMeta.size, committedCount, 'committed in-memory index is preserved');
    assert.strictEqual(engine.getStatus().dirty, true, 'failed rebuild leaves index dirty');
    assert.strictEqual(engine.getStatus().failedCount, 1, 'failed rebuild exposes diagnostics');
    assert.strictEqual(engine.getStatus().failedFiles[0].filePath, path.basename(indexPath), 'public save failure diagnostic identifies index file without raw path');
    assert.strictEqual(engine.getStatus({ publicPaths: false }).failedFiles[0].filePath, indexPath, 'internal save failure diagnostic preserves raw index file path');
  });

  await withTempDir(async (dir) => {
    writeDoc(dir, 'a.md', '---\nproject: Alpha\n---', '# Alpha\n\ncommitted keyword');
    writeDoc(dir, 'b.md', '---\nproject: Beta\n---', '# Beta\n\ncommitted keyword');
    writeDoc(dir, 'c.md', '---\nproject: Gamma\n---', '# Gamma\n\ncommitted keyword');

    const engine = new SearchEngine(createStore(dir));
    await engine.rebuild();
    const indexPath = path.join(dir, '.doculight-search-index.json');
    const committedIndex = fs.readFileSync(indexPath, 'utf-8');
    const committedCount = engine.docMeta.size;
    const failedPath = writeDoc(dir, 'd.md', '---\nproject: Delta\n---', '# Delta\n\nfresh keyword');

    const originalIndexDocument = engine._indexDocument.bind(engine);
    engine._indexDocument = (filePath, content, nextEngine, nextDocMeta) => {
      if (filePath === failedPath) {
        throw new Error('forced document index failure');
      }
      return originalIndexDocument(filePath, content, nextEngine, nextDocMeta);
    };

    let failed = false;
    try {
      await engine.rebuild();
    } catch {
      failed = true;
    }

    assert.strictEqual(failed, true, 'partial document failure aborts rebuild');
    assert.strictEqual(fs.readFileSync(indexPath, 'utf-8'), committedIndex, 'partial failure preserves committed JSON index');
    assert.strictEqual(engine.docMeta.size, committedCount, 'partial failure preserves committed in-memory index');
    assert.strictEqual(engine.getStatus().dirty, true, 'partial failure leaves index dirty');
    assert.strictEqual(engine.getStatus().failedCount, 1, 'partial failure exposes failed file count');
    assert.strictEqual(engine.getStatus().failedFiles[0].filePath, path.basename(failedPath), 'public partial failure diagnostic identifies failed markdown file without raw path');
    assert.strictEqual(engine.getStatus({ publicPaths: false }).failedFiles[0].filePath, failedPath, 'internal partial failure diagnostic preserves raw markdown file path');
  });

  await withTempDir(async (dir) => {
    writeDoc(dir, 'a.md', '---\nproject: Alpha\n---', '# Alpha\n\ncommitted keyword');
    writeDoc(dir, 'b.md', '---\nproject: Beta\n---', '# Beta\n\ncommitted keyword');
    writeDoc(dir, 'c.md', '---\nproject: Gamma\n---', '# Gamma\n\ncommitted keyword');

    const engine = new SearchEngine(createStore(dir));
    await engine.rebuild();
    const indexPath = path.join(dir, '.doculight-search-index.json');
    const committedIndex = fs.readFileSync(indexPath, 'utf-8');
    const committedCount = engine.docMeta.size;
    const failedPath = writeDoc(dir, 'd.md', '---\nproject: Delta\n---', '# Delta\n\nfresh keyword');

    const originalReadFile = fs.promises.readFile;
    fs.promises.readFile = async (filePath, ...args) => {
      if (filePath === failedPath) {
        throw new Error('forced document read failure');
      }
      return originalReadFile.call(fs.promises, filePath, ...args);
    };

    let failed = false;
    try {
      await engine.rebuild();
    } catch {
      failed = true;
    } finally {
      fs.promises.readFile = originalReadFile;
    }

    assert.strictEqual(failed, true, 'partial read failure aborts rebuild');
    assert.strictEqual(fs.readFileSync(indexPath, 'utf-8'), committedIndex, 'read failure preserves committed JSON index');
    assert.strictEqual(engine.docMeta.size, committedCount, 'read failure preserves committed in-memory index');
    assert.strictEqual(engine.getStatus().dirty, true, 'read failure leaves index dirty');
    assert.strictEqual(engine.getStatus().failedCount, 1, 'read failure exposes failed file count');
    assert.strictEqual(engine.getStatus().failedFiles[0].filePath, path.basename(failedPath), 'public read failure diagnostic identifies failed markdown file without raw path');
    assert.strictEqual(engine.getStatus({ publicPaths: false }).failedFiles[0].filePath, failedPath, 'internal read failure diagnostic preserves raw markdown file path');
  });

  await withTempDir(async (dir) => {
    writeDoc(dir, 'a.md', '---\nproject: Alpha\n---', '# Alpha\n\nold keyword');
    writeDoc(dir, 'b.md', '---\nproject: Beta\n---', '# Beta\n\nold keyword');
    writeDoc(dir, 'c.md', '---\nproject: Gamma\n---', '# Gamma\n\nold keyword');

    const engine = new SearchEngine(createStore(dir));
    await engine.rebuild();

    writeDoc(dir, 'd.md', '---\nproject: Delta\n---', '# Delta\n\nfresh keyword');
    engine.markDirty();

    const originalRebuild = engine.rebuild.bind(engine);
    let rebuildCalled = false;
    engine.rebuild = async () => {
      rebuildCalled = true;
      return originalRebuild();
    };

    const staleResults = engine.search('old keyword');
    const staleStatus = engine.getStatus();

    assert.strictEqual(rebuildCalled, false, 'keyword search does not rebuild directly');
    assert(staleResults.length > 0, 'search uses last committed index while stale');
    assert.strictEqual(staleStatus.state, 'stale', 'status explicitly reports stale index');
  });

  console.log('test-search-engine-lifecycle: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
