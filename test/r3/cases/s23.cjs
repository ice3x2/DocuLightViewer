'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { SearchEngine } = require('../../../src/main/search-engine');
const { SQLiteKeywordIndex } = require('../../../src/main/search-sqlite-store');
const { SourceLedgerStore } = require('../../../src/main/source-ledger-store');
const { resolveIndexedMarkdownOpen } = require('../../../src/main/indexed-origin-resolver');
const { OwnerWorkerController } = require('../../../src/main/search-owner-controller');

// @req FR-DOC-019 AC-6 AC-7 AC-8 AC-9
module.exports = { async run({ fixture, assert }) {
  const evidence = {};
  const root = path.join(fixture.root, 's23');
  const storeRoot = path.join(root, 'store');
  const indexDataDir = path.join(root, 'index');
  fs.mkdirSync(storeRoot, { recursive: true });
  fs.mkdirSync(indexDataDir, { recursive: true });
  const keywordPath = path.join(indexDataDir, 'search-index.sqlite3');
  const writer = new SQLiteKeywordIndex({ dbPath: keywordPath, sourceRoot: storeRoot });
  const marker = 's23retainedcommittedkeyword';
  fs.writeFileSync(path.join(storeRoot, 'committed.md'),
    `---\nproject: New\n---\n# Committed\n\n${marker}\n`);
  fs.writeFileSync(path.join(storeRoot, 'second.md'),
    '---\nproject: New\n---\n# Second\n\ns23secondbody\n');
  writer.replaceDocument({
    filePath: path.join(storeRoot, 'committed.md'), contentHash: 'sha256:committed', revision: 1,
    meta: { title: 'Committed', project: 'Old', docName: 'committed', docType: 'markdown',
      category: '', documentTags: [], description: '', date: '', gitBranch: '',
      gitLastCommit: '', snippet: marker },
    segments: [{ ordinal: 0, searchText: marker, textHash: 'seed' }]
  });
  writer.close();
  const ledgerPath = path.join(indexDataDir, 'smart-search.sqlite3');
  const seededLedger = new SourceLedgerStore({ dbPath: ledgerPath });
  seededLedger.initialize();
  seededLedger.close();
  let writableOpenCount = 0;
  const Database = fixture.db.constructor;
  function MainDatabase(file, options = {}) {
    if (!options.readonly) writableOpenCount += 1;
    if (!options.readonly) throw new Error('product_main_writable_sqlite_open');
    return new Database(file, options);
  }
  const engine = new SearchEngine({ get: (key, fallback) => key === 'mcpAutoSavePath' ? storeRoot : fallback }, {
    indexBackend: 'sqlite', indexDataDir, ownerManaged: true,
    keywordTokenizerProvider: 'basic', sqliteLoadDatabase: () => MainDatabase
  });
  let startupReconcileCalls = 0;
  engine._scheduleStartupIndexJobReconciliation = () => { startupReconcileCalls += 1; };
  try {
    await engine.initialize();
    assert(writableOpenCount === 0, 'product main opens keyword SQLite read-only');
    assert(startupReconcileCalls === 0, 'owner-managed product main does not reconcile ledger jobs');
    assert(engine.getStatus().state === 'ready', 'committed keyword index remains ready');
    assert(engine.search(marker).some(row => row.filePath === path.join(storeRoot, 'committed.md')),
      'product search retains the previous committed keyword result');
    engine.getIndexingWorkerController().activeJob = {
      jobId: 's23-status-probe', kind: 'rebuild', status: { active: true, state: 'rebuilding' }
    };
    const originalOpen = SourceLedgerStore.prototype.open;
    const ledgerModes = [];
    SourceLedgerStore.prototype.open = function instrumentedOpen(...args) {
      if (this.dbPath === ledgerPath) {
        ledgerModes.push(this.readOnly);
        if (!this.readOnly) throw new Error('product_main_writable_ledger_open');
      }
      return originalOpen.apply(this, args);
    };
    try { engine.getStatus(); }
    finally { SourceLedgerStore.prototype.open = originalOpen; }
    assert(ledgerModes.length > 0 && ledgerModes.every(Boolean) && engine._sourceLedger === null,
      'active product status opens only a read-only main-process ledger');
    const product = fs.readFileSync(path.join(__dirname, '../../../src/main/index.js'), 'utf8');
    assert(/ownerManaged:\s*true/.test(product) && /getSaveDocumentOwner\(store\.get\('mcpAutoSavePath'/.test(product),
      'product startup wires owner-managed search and owner bootstrap');
    const startupEngine = new SearchEngine({ get: (key, fallback) => key === 'mcpAutoSavePath' ? storeRoot : fallback }, {
      indexBackend: 'sqlite', indexDataDir, ownerManaged: true,
      keywordTokenizerProvider: 'basic', sqliteLoadDatabase: () => MainDatabase
    });
    startupEngine.getSaveDocumentOwner = async () => { throw new Error('owner_start_failed'); };
    const start = product.indexOf('function initializeSearchEngineIfConfigured() {');
    const end = product.indexOf('\nfunction startNativeRepairIfNeeded()', start);
    assert(start >= 0 && end > start, 'actual product startup function is extractable');
    const diagnostics = [];
    vm.runInNewContext(`${product.slice(start, end)}\ninitializeSearchEngineIfConfigured();`, {
      searchEngine: startupEngine,
      store: startupEngine.store,
      isDocumentStoreSourceRootConfigured: () => true,
      console: { error: (...args) => diagnostics.push(args.join(' ')) }
    });
    await new Promise(resolve => setImmediate(resolve));
    assert(startupEngine.initialized && startupEngine.search(marker).some(row => row.filePath === path.join(storeRoot, 'committed.md')),
      'owner startup failure still loads previous committed product search index');
    assert(startupEngine.getStatus().state === 'ready' && diagnostics.some(line => line.includes('owner_start_failed')),
      'product search remains ready while owner failure is diagnosed');
    startupEngine.close();
    let resolverError = null;
    const resolverModes = [];
    SourceLedgerStore.prototype.open = function instrumentedResolverOpen(...args) {
      if (this.dbPath === ledgerPath) {
        resolverModes.push(this.readOnly);
        if (!this.readOnly) throw new Error('product_main_writable_ledger_open');
      }
      return originalOpen.apply(this, args);
    };
    try { await resolveIndexedMarkdownOpen({ documentId: 's23-unknown', searchEngine: engine }); }
    catch (error) { resolverError = error; }
    finally { SourceLedgerStore.prototype.open = originalOpen; }
    assert(resolverError?.code === 'indexed_document_not_found' && resolverModes.length > 0
      && resolverModes.every(Boolean) && engine._sourceLedger === null,
    'product indexed-origin lookup is read-only and preserves unknown-ID contract');

    // @req FR-DOC-019 AC-6 AC-10 IR-APP-010 IR-APP-013 AC-15
    const owner = new OwnerWorkerController({ ledgerPath, keywordPath, sourceRoot: storeRoot,
      publicationRoot: fs.realpathSync.native(storeRoot), ingressRoot: path.join(root, 'ingress'),
      deriveDocuments: true, keywordTokenizerProvider: 'basic',
      onStatus: snapshot => engine.onOwnerStatus(snapshot) });
    fs.mkdirSync(owner.config.ingressRoot);
    try {
      const started = await owner.start();
      await waitForOwnerRecovery(owner);
      assert(started.audit.ledgerOpenThreadId === started.audit.keywordOpenThreadId
        && started.audit.ledgerOpenThreadId > 0,
      'one long owner opens both writable SQLite databases');
      evidence.ownerThreadId = started.audit.ledgerOpenThreadId;
      evidence.ownerOpenCount = started.audit.openCount;
      const callbacks = new Map();
      const first = product.indexOf('const startOwnerIndexMaintenance = async (operation) => {');
      const last = product.indexOf("ipcMain.handle('indexing:compact'", first);
      assert(first > 0 && last > first, 'actual Settings maintenance IPC handlers are extractable');
      let shortWorkerCalls = 0;
      const shortWorkerCalled = () => { shortWorkerCalls += 1; return { started: false, scheduled: false }; };
      engine.startRebuild = shortWorkerCalled;
      engine.retryFailures = shortWorkerCalled;
      engine.getSaveDocumentOwner = async () => owner;
      const statusStart = product.indexOf('function getIndexingStatusPayload() {');
      const statusEnd = product.indexOf('\nfunction sanitizeSettingsPayload(', statusStart);
      assert(statusStart > 0 && statusEnd > statusStart,
        'actual product Settings status composer is extractable');
      vm.runInNewContext(`${product.slice(statusStart, statusEnd)}\n${product.slice(first, last)}`, {
        ipcMain: { handle: (name, handler) => callbacks.set(name, handler) },
        searchEngine: engine, saveDocumentOwner: owner,
        isDocumentStoreSourceRootConfigured: () => true,
        nativeRebuildManager: null,
        store: engine.store,
        require: (name) => name === './ledger-status-registry'
          ? require('../../../src/main/ledger-status-registry') : require(name)
      });
      const rebuild = await callbacks.get('indexing:start-rebuild')();
      assert(shortWorkerCalls === 0 && rebuild.started === true && rebuild.scheduled === true
        && typeof rebuild.jobId === 'string' && rebuild.status?.state === 'rebuilding'
        && rebuild.status?.rebuildSession?.active === true,
        'actual Settings rebuild starts a durable job on the long owner');
      const duplicate = await callbacks.get('indexing:retry-failures')();
      assert(duplicate.started === false && duplicate.scheduled === false
        && duplicate.reason === 'job-in-progress', 'duplicate Settings retry does not enqueue another job');
      let invalid = false;
      try { await owner.command('manage_index', { operation: 'rebuild', dbPath: keywordPath }); }
      catch (error) { invalid = error.code === 'owner_invalid_manage_index_payload'; }
      assert(invalid, 'private maintenance rejects extra DB-path payload without work');
      let wireInvalid = false;
      try { await owner._send('COMMAND', 'manage_index', { operation: 'retry', sourceRoot: storeRoot }); }
      catch (error) { wireInvalid = error.code === 'owner_invalid_manage_index_payload'
        && !String(error.message).includes(storeRoot); }
      assert(wireInvalid, 'owner worker independently rejects extra source-root wire field with redacted diagnostic');
      const completed = await waitForJob(ledgerPath, rebuild.jobId, 'completed');
      assert(completed && completed.status === 'completed', 'Settings rebuild durably completes');
      const refreshed = await waitForEngineProjects(engine, 'New', 2);
      assert(refreshed && engine.getStatus().indexedCount === 2,
        'actual product facade refreshes project list and indexed count after owner terminal without search_documents');
      assert(/onStatus:\s*snapshot\s*=>\s*searchEngine\.onOwnerStatus\(snapshot\)/.test(product),
        'product owner wiring refreshes the read-only search facade on terminal status');
      const index = new SQLiteKeywordIndex({ dbPath: keywordPath, sourceRoot: storeRoot,
        readOnly: true });
      try {
        index.open();
        assert(index.search(marker, { limit: 5 }).some(row => row.filePath.endsWith('committed.md')),
          'body-only keyword remains searchable after owner rebuild');
      } finally { index.close(); }
    } finally { await owner.shutdown(); }

    const Database = require('better-sqlite3');
    const sourceDb = new Database(ledgerPath);
    const now = new Date().toISOString();
    const digest = require('node:crypto').createHash('sha256')
      .update(fs.readFileSync(path.join(storeRoot, 'committed.md'))).digest('hex');
    sourceDb.prepare(`INSERT INTO sources(source_id, root_path_internal, root_fingerprint,
      created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run('s23-source', storeRoot, 's23-root', now, now);
    sourceDb.prepare(`INSERT INTO documents(document_id, source_id, relative_path, path_key,
      content_hash, desired_revision, desired_content_hash, first_seen_at, last_seen_at,
      created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      's23-document', 's23-source', 'committed.md', 'committed.md', `sha256:${digest}`, 1,
      `sha256:${digest}`, now, now, now, now);
    sourceDb.prepare(`INSERT INTO document_source_aliases(alias_id, document_id, alias_kind,
      canonical_path_hash, first_seen_at, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('s23-alias', 's23-document',
      'opened_markdown', 's23-canonical', now, now, now, now);
    sourceDb.prepare(`INSERT INTO chunks(chunk_id, document_id, ordinal, text,
      created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
      's23-old-derived-chunk', 's23-document', 0, 'old derived content', now, now);
    sourceDb.prepare(`INSERT INTO embedding_models(model_id, provider, model_name,
      model_fingerprint, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      's23-model', 'test', 'model', 's23-fingerprint', 'active', now, now);
    const annArtifact = path.join(indexDataDir, 's23-ann-artifact.bin');
    fs.writeFileSync(annArtifact, 'retained artifact');
    sourceDb.prepare(`INSERT INTO ann_indexes(ann_index_id, model_id, index_path_internal,
      status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
      's23-ann', 's23-model', annArtifact, 'committed', now, now);
    sourceDb.prepare(`INSERT INTO ann_memberships(ann_index_id, chunk_id, model_id,
      ann_label, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      's23-ann', 's23-old-derived-chunk', 's23-model', 1, now);
    sourceDb.prepare(`INSERT INTO index_jobs(job_id, job_type, status, created_at,
      heartbeat_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
      's23-unrelated-pending', 'index_document', 'queued', now, now, now);
    sourceDb.close();

    const beforeFault = readCommittedState(keywordPath, storeRoot, marker);
    evidence.beforeFault = { generationId: beforeFault.generationId, checksum: beforeFault.checksum };
    fs.writeFileSync(path.join(storeRoot, 'committed.md'), '# Changed\n\ns23uncommittedfaultword\n');
    const changedDigest = require('node:crypto').createHash('sha256')
      .update(fs.readFileSync(path.join(storeRoot, 'committed.md'))).digest('hex');
    const changedDb = new Database(ledgerPath);
    changedDb.prepare(`UPDATE documents SET content_hash = ?, desired_content_hash = ?
      WHERE document_id = ?`).run(`sha256:${changedDigest}`, `sha256:${changedDigest}`, 's23-document');
    changedDb.close();
    const faultOwner = new OwnerWorkerController({ ledgerPath, keywordPath, sourceRoot: storeRoot,
      publicationRoot: fs.realpathSync.native(storeRoot), ingressRoot: path.join(root, 'ingress'),
      deriveDocuments: true, keywordTokenizerProvider: 'basic', r3MaintenanceFaultBeforeCommit: true });
    try {
      await faultOwner.start();
      await waitForOwnerRecovery(faultOwner);
      const failed = await faultOwner.command('manage_index', { operation: 'rebuild' });
      assert(failed.started && failed.jobId, 'faulted owner accepted durable rebuild');
      await waitForJob(ledgerPath, failed.jobId, 'failed');
      const afterFault = readCommittedState(keywordPath, storeRoot, marker);
      evidence.afterFault = { generationId: afterFault.generationId, checksum: afterFault.checksum };
      assert(afterFault.generationId === beforeFault.generationId
        && afterFault.checksum === beforeFault.checksum && afterFault.hasBodyHit,
        'fault before commit preserves previous generation, logical checksum, and body-only hit');
    } finally { await faultOwner.shutdown(); }

    const retryOwner = new OwnerWorkerController({ ledgerPath, keywordPath, sourceRoot: storeRoot,
      publicationRoot: fs.realpathSync.native(storeRoot), ingressRoot: path.join(root, 'ingress'),
      deriveDocuments: true, keywordTokenizerProvider: 'basic' });
    try {
      await retryOwner.start();
      await waitForOwnerRecovery(retryOwner);
      engine.getSaveDocumentOwner = async () => retryOwner;
      const retryCallbacks = new Map();
      const productSource = fs.readFileSync(path.join(__dirname, '../../../src/main/index.js'), 'utf8');
      const startAt = productSource.indexOf('const startOwnerIndexMaintenance = async (operation) => {');
      const endAt = productSource.indexOf("ipcMain.handle('indexing:compact'", startAt);
      const statusAt = productSource.indexOf('function getIndexingStatusPayload() {');
      const statusUntil = productSource.indexOf('\nfunction sanitizeSettingsPayload(', statusAt);
      vm.runInNewContext(`${productSource.slice(statusAt, statusUntil)}\n${productSource.slice(startAt, endAt)}`, {
        ipcMain: { handle: (name, handler) => retryCallbacks.set(name, handler) },
        searchEngine: engine, saveDocumentOwner: retryOwner,
        isDocumentStoreSourceRootConfigured: () => true,
        nativeRebuildManager: null, store: engine.store,
        require: (name) => name === './ledger-status-registry'
          ? require('../../../src/main/ledger-status-registry') : require(name)
      });
      const retried = await retryCallbacks.get('indexing:retry-failures')();
      assert(retried.started && retried.scheduled && retried.jobId
        && retried.status?.state === 'rebuilding' && retried.status?.rebuildSession?.active,
        'actual Settings retry after failed first rebuild starts another durable owner job');
      await waitForJob(ledgerPath, retried.jobId, 'completed');
      const afterRetry = readCommittedState(keywordPath, storeRoot, 's23uncommittedfaultword');
      assert(afterRetry.generationId !== beforeFault.generationId && afterRetry.hasBodyHit,
        'retry commits the newly validated body-only generation');
      const db = new Database(ledgerPath, { readonly: true });
      try {
        const doc = db.prepare('SELECT document_id, current_job_id FROM documents WHERE document_id = ?')
          .get('s23-document');
        const alias = db.prepare('SELECT alias_id FROM document_source_aliases WHERE alias_id = ?')
          .get('s23-alias');
        const unrelated = db.prepare('SELECT status FROM index_jobs WHERE job_id = ?')
          .get('s23-unrelated-pending');
        const scoped = db.prepare('SELECT job_id FROM index_jobs WHERE job_id = ?')
          .get(`rebuild_${retried.jobId}_s23-document`);
        const staleChunk = db.prepare('SELECT chunk_id FROM chunks WHERE chunk_id = ?')
          .get('s23-old-derived-chunk');
        const ann = db.prepare('SELECT status FROM ann_indexes WHERE ann_index_id = ?').get('s23-ann');
        const committedAnn = db.prepare(`SELECT ann_index_id FROM ann_indexes
          WHERE ann_index_id = ? AND status = 'committed'`).get('s23-ann');
        assert(doc?.document_id === 's23-document' && alias?.alias_id === 's23-alias'
          && unrelated?.status === 'queued' && scoped?.job_id && !staleChunk
          && ann?.status === 'stale' && !committedAnn && fs.existsSync(annArtifact),
          'scoped derived requeue preserves identity, aliases, and unrelated pending job');
      } finally { db.close(); }
    } finally { await retryOwner.shutdown(); }

    const beforeCancel = readCommittedState(keywordPath, storeRoot, 's23uncommittedfaultword');
    evidence.beforeCancel = { generationId: beforeCancel.generationId, checksum: beforeCancel.checksum };
    for (let i = 0; i < 96; i++) {
      fs.writeFileSync(path.join(storeRoot, `cancel-${i}.md`), `# Cancel ${i}\n\ns23cancelcandidate${i}\n`);
    }
    const cancelOwner = new OwnerWorkerController({ ledgerPath, keywordPath, sourceRoot: storeRoot,
      publicationRoot: fs.realpathSync.native(storeRoot), ingressRoot: path.join(root, 'ingress'),
      deriveDocuments: false, keywordTokenizerProvider: 'basic', r3MaintenancePageDelayMs: 30 });
    try {
      await cancelOwner.start();
      await waitForOwnerRecovery(cancelOwner);
      const requested = await requestMaintenanceWhenReady(cancelOwner, 'rebuild');
      assert(requested?.started === true, 'owner admits rebuild after prior document drain settles');
      const active = await waitForOwner(cancelOwner, snapshot => snapshot.kind === 'rebuild'
        && snapshot.active && snapshot.progress?.current >= 16);
      assert(active, 'rebuild reaches a bounded page before cancellation');
      const queryStartedAt = Date.now();
      const [snapshot, hits] = await Promise.all([
        cancelOwner.query('get_status'),
        cancelOwner.query('query_keyword', { query: 's23uncommittedfaultword' })
      ]);
      assert(Date.now() - queryStartedAt < 1000 && snapshot.active === true
        && hits.some(row => row.filePath.endsWith('committed.md')),
        'status and committed body-only query respond during bounded rebuild work');
      const cancelled = await cancelOwner.cancel(requested.jobId);
      assert(cancelled.cancelled === true, 'owner accepts cancel during staged rebuild');
      const cancelling = cancelOwner.getStatus();
      const { composeIndexingStatusPayload } = require('../../../src/main/ledger-status-registry');
      const cancellingSettings = composeIndexingStatusPayload(engine.getStatus(), cancelling, true);
      assert(cancelling.kind === 'rebuild' && cancelling.jobId === requested.jobId
        && cancelling.rebuildSession?.active === true && cancelling.cancelRequested === true
        && cancellingSettings.state === 'rebuilding'
        && cancellingSettings.rebuildSession?.active === true
        && cancellingSettings.cancelRequested === true,
        'cancel request preserves active Settings rebuild identity, live session, and stop policy');
      await waitForJob(ledgerPath, requested.jobId, 'cancelled');
      const afterCancel = readCommittedState(keywordPath, storeRoot, 's23uncommittedfaultword');
      evidence.afterCancel = { generationId: afterCancel.generationId, checksum: afterCancel.checksum };
      assert(afterCancel.generationId === beforeCancel.generationId
        && afterCancel.checksum === beforeCancel.checksum && afterCancel.hasBodyHit,
        'mid-rebuild cancel preserves previous committed generation and body-only hit');
    } finally { await cancelOwner.shutdown(); }

    const missingRoot = path.join(root, 'missing-index');
    const missingStore = path.join(missingRoot, 'store');
    fs.mkdirSync(missingStore, { recursive: true });
    fs.writeFileSync(path.join(missingStore, 'document.md'), '# Missing index\n\ns23missingretrybody\n');
    const missingConfig = { ledgerPath: path.join(missingRoot, 'ledger.sqlite'),
      keywordPath: path.join(missingRoot, 'keyword.sqlite'), sourceRoot: missingStore,
      publicationRoot: fs.realpathSync.native(missingStore),
      ingressRoot: path.join(missingRoot, 'ingress'), deriveDocuments: true,
      keywordTokenizerProvider: 'basic' };
    fs.mkdirSync(missingConfig.ingressRoot);
    const missingFaultOwner = new OwnerWorkerController({ ...missingConfig,
      r3MaintenanceFaultBeforeCommit: true });
    try {
      await missingFaultOwner.start();
      await waitForOwnerRecovery(missingFaultOwner);
      assert(missingFaultOwner.getStatus().state === 'stale',
        'missing keyword index remains stale without automatic rebuild');
      const db = new Database(missingConfig.ledgerPath, { readonly: true });
      const beforeExplicit = db.prepare("SELECT COUNT(*) AS count FROM index_jobs WHERE job_type = 'keyword_rebuild'").get().count;
      db.close();
      assert(beforeExplicit === 0, 'missing index alone never schedules automatic full rebuild');
      const first = await missingFaultOwner.command('manage_index', { operation: 'rebuild' });
      await waitForJob(missingConfig.ledgerPath, first.jobId, 'failed');
    } finally { await missingFaultOwner.shutdown(); }
    const missingRetryOwner = new OwnerWorkerController(missingConfig);
    try {
      await missingRetryOwner.start();
      await waitForOwnerRecovery(missingRetryOwner);
      assert(missingRetryOwner.getStatus().state === 'stale',
        'failed first rebuild still reports missing-index stale state');
      const retry = await missingRetryOwner.command('manage_index', { operation: 'retry' });
      assert(retry.started && retry.scheduled && retry.jobId,
        'retry from failed missing-index state does not return false job-in-progress');
      const completed = await waitForJob(missingConfig.ledgerPath, retry.jobId, 'completed');
      assert(Boolean(completed), 'missing-index retry reaches durable completion');
    } finally { await missingRetryOwner.shutdown(); }

    const interruptedDb = new Database(missingConfig.ledgerPath);
    const interruptedAt = new Date().toISOString();
    interruptedDb.prepare(`INSERT INTO index_jobs(job_id, job_type, status, requested_by,
      created_at, heartbeat_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      's23-interrupted-explicit-rebuild', 'keyword_rebuild', 'indexing',
      'settings.rebuild', interruptedAt, interruptedAt, interruptedAt);
    interruptedDb.close();
    const resumedOwner = new OwnerWorkerController(missingConfig);
    try {
      await resumedOwner.start();
      const closedOld = await waitForJob(missingConfig.ledgerPath,
        's23-interrupted-explicit-rebuild', 'failed');
      assert(Boolean(closedOld), 'startup closes interrupted explicit rebuild with durable failure');
      const newJob = await waitForRequestedJob(missingConfig.ledgerPath,
        'startup.rebuild.interrupted');
      assert(newJob?.status === 'completed' && newJob.job_id !== closedOld.job_id,
        'only interrupted explicit rebuild restarts on owner startup');
    } finally { await resumedOwner.shutdown(); }

    const migrationBarrier = new SharedArrayBuffer(4);
    const gatedOwner = new OwnerWorkerController({ ...missingConfig,
      r3MigrationBarrier: migrationBarrier });
    try {
      await gatedOwner.start();
      const admission = gatedOwner.command('manage_index', { operation: 'rebuild' });
      const early = await Promise.race([
        admission,
        new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 250))
      ]);
      Atomics.store(new Int32Array(migrationBarrier), 0, 1);
      Atomics.notify(new Int32Array(migrationBarrier), 0);
      if (early.timedOut) await admission;
      assert(!early.timedOut && early.started === false && early.scheduled === false
        && early.reason === 'owner-recovery-pending',
        'manage_index rejects immediately while owner migration is incomplete');
    } finally {
      Atomics.store(new Int32Array(migrationBarrier), 0, 1);
      Atomics.notify(new Int32Array(migrationBarrier), 0);
      await gatedOwner.shutdown();
    }

    const unrelatedDb = new Database(missingConfig.ledgerPath);
    const unrelatedAt = new Date().toISOString();
    unrelatedDb.prepare(`INSERT INTO index_jobs(job_id, job_type, status, requested_by,
      created_at, heartbeat_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      's23-nonexplicit-rebuild', 'keyword_rebuild', 'indexing',
      'startup.automatic', unrelatedAt, unrelatedAt, unrelatedAt);
    unrelatedDb.close();
    const noAutoOwner = new OwnerWorkerController(missingConfig);
    try {
      await noAutoOwner.start();
      await waitForJob(missingConfig.ledgerPath, 's23-nonexplicit-rebuild', 'failed');
      const db = new Database(missingConfig.ledgerPath, { readonly: true });
      const autoCount = db.prepare(`SELECT COUNT(*) AS count FROM index_jobs
        WHERE requested_by = 'startup.rebuild.interrupted'`).get().count;
      db.close();
      assert(autoCount === 1,
        'startup resumes only interrupted explicit Settings rebuild jobs');
    } finally { await noAutoOwner.shutdown(); }

    const largeRoot = path.join(root, 'large-rebuild');
    const largeStore = path.join(largeRoot, 'store');
    fs.mkdirSync(largeStore, { recursive: true });
    const largeFile = path.join(largeStore, 'large.md');
    const largeFd = fs.openSync(largeFile, 'w');
    try {
      fs.writeSync(largeFd, '# Large\n\ncobaltquinceharvest\n');
      fs.writeSync(largeFd, '\nmarigoldvelvetgalaxy\n', 11 * 1024 * 1024);
    } finally { fs.closeSync(largeFd); }
    const longFrontmatter = path.join(largeStore, 'long-frontmatter.md');
    const longFd = fs.openSync(longFrontmatter, 'w');
    try {
      fs.writeSync(longFd, `---\nproject: Late\ndescription: ${'x'.repeat(2500)}\n---\n# Late\n`);
      fs.writeSync(longFd, '\nlatefooterword\n', 11 * 1024 * 1024);
    } finally { fs.closeSync(longFd); }
    const boundaryFile = path.join(largeStore, 'boundary.md');
    fs.writeFileSync(boundaryFile, `# Boundary\n${'a'.repeat(65525)}한계\n`);
    const largeConfig = { ledgerPath: path.join(largeRoot, 'ledger.sqlite'),
      keywordPath: path.join(largeRoot, 'keyword.sqlite'), sourceRoot: largeStore,
      publicationRoot: fs.realpathSync.native(largeStore),
      ingressRoot: path.join(largeRoot, 'ingress'), deriveDocuments: false,
      keywordTokenizerProvider: 'basic' };
    fs.mkdirSync(largeConfig.ingressRoot);
    const largeOwner = new OwnerWorkerController(largeConfig);
    try {
      await largeOwner.start();
      await waitForOwnerRecovery(largeOwner);
      const largeJob = await largeOwner.command('manage_index', { operation: 'rebuild' });
      assert(largeJob.started === true, 'owner accepts an 11 MiB sparse Markdown file');
      const completed = await waitForJob(largeConfig.ledgerPath, largeJob.jobId, 'completed');
      assert(Boolean(completed), 'owner completes rebuild of existing 11 MiB Markdown without a size-cap failure');
      const ownerHead = (await largeOwner.query('query_keyword', { query: 'cobaltquinceharvest' })).length > 0;
      const ownerTail = (await largeOwner.query('query_keyword', { query: 'marigoldvelvetgalaxy' })).length > 0;
      const legacy = new SearchEngine({ get: (key, fallback) => key === 'mcpAutoSavePath'
        ? largeStore : fallback }, { indexBackend: 'sqlite',
        indexDataDir: path.join(largeRoot, 'legacy-index'), keywordTokenizerProvider: 'basic',
        disableIndexingWorkerController: true });
      try {
        await legacy.rebuild();
        const legacyHead = legacy.search('cobaltquinceharvest').length > 0;
        const legacyTail = legacy.search('marigoldvelvetgalaxy').length > 0;
        const ownerDb = new (require('better-sqlite3'))(largeConfig.keywordPath, { readonly: true });
        const legacyDb = new (require('better-sqlite3'))(legacy.getIndexPath(), { readonly: true });
        const ownerText = ownerDb.prepare('SELECT search_text FROM keyword_segments WHERE file_path = ?')
          .get(largeFile).search_text;
        const legacyText = legacyDb.prepare('SELECT search_text FROM keyword_segments WHERE file_path = ?')
          .get(largeFile).search_text;
        const documentRows = db => db.prepare(`SELECT file_path, title, project, category, content_hash
          FROM keyword_documents ORDER BY file_path`).all();
        const segmentRows = db => db.prepare(`SELECT file_path, search_text, text_hash
          FROM keyword_segments ORDER BY file_path`).all();
        const ownerDocuments = documentRows(ownerDb);
        const legacyDocuments = documentRows(legacyDb);
        const ownerSegments = segmentRows(ownerDb);
        const legacySegments = segmentRows(legacyDb);
        ownerDb.close();
        legacyDb.close();
        assert(ownerHead === legacyHead
          && ownerTail === legacyTail
          && ownerText === legacyText && ownerText.includes('cobaltquinceharvest')
          && !ownerText.includes('marigoldvelvetgalaxy')
          && JSON.stringify(ownerDocuments) === JSON.stringify(legacyDocuments)
          && JSON.stringify(ownerSegments) === JSON.stringify(legacySegments),
          'owner 11 MiB files, long frontmatter, and UTF-8 boundary match legacy FTS and metadata');
      } finally { legacy.close(); }
    } finally { await largeOwner.shutdown(); }

    const sparseRoot = path.join(root, 'sparse-160-mib');
    const sparseStore = path.join(sparseRoot, 'store');
    fs.mkdirSync(sparseStore, { recursive: true });
    const sparseFile = path.join(sparseStore, 'sparse.md');
    const sparseFd = fs.openSync(sparseFile, 'w');
    try {
      fs.writeSync(sparseFd, '# Sparse\n\nsilverorchardlantern\n');
      fs.writeSync(sparseFd, '\nend\n', 160 * 1024 * 1024);
    } finally { fs.closeSync(sparseFd); }
    const sparseConfig = { ledgerPath: path.join(sparseRoot, 'ledger.sqlite'),
      keywordPath: path.join(sparseRoot, 'keyword.sqlite'), sourceRoot: sparseStore,
      publicationRoot: fs.realpathSync.native(sparseStore),
      ingressRoot: path.join(sparseRoot, 'ingress'), deriveDocuments: false,
      keywordTokenizerProvider: 'basic' };
    fs.mkdirSync(sparseConfig.ingressRoot);
    const sparseOwner = new OwnerWorkerController(sparseConfig);
    try {
      await sparseOwner.start();
      await waitForOwnerRecovery(sparseOwner);
      const sparseJob = await sparseOwner.command('manage_index', { operation: 'rebuild' });
      const complete = await waitForJob(sparseConfig.ledgerPath, sparseJob.jobId, 'completed', 25000);
      assert(Boolean(complete) && (await sparseOwner.query('query_keyword',
        { query: 'silverorchardlantern' })).length > 0,
        'owner rebuild streams a sparse 160 MiB Markdown file and commits its leading keyword');
      evidence.sparse160MiB = { bytes: fs.statSync(sparseFile).size, completed: true };
    } finally { await sparseOwner.shutdown(); }
    console.error(`S23_EVIDENCE ${JSON.stringify(evidence)}`);
  } finally { engine.close(); }
} };

async function waitForJob(ledgerPath, jobId, expected, timeoutMs = 8000) {
  const Database = require('better-sqlite3');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const db = new Database(ledgerPath, { readonly: true, fileMustExist: true });
    const row = db.prepare('SELECT job_id, status FROM index_jobs WHERE job_id = ?').get(jobId);
    db.close();
    if (row?.status === expected) return row;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return null;
}

async function waitForRequestedJob(ledgerPath, requestedBy) {
  const Database = require('better-sqlite3');
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const db = new Database(ledgerPath, { readonly: true, fileMustExist: true });
    const row = db.prepare(`SELECT job_id, status FROM index_jobs WHERE requested_by = ?
      ORDER BY created_at DESC LIMIT 1`).get(requestedBy);
    db.close();
    if (row?.status === 'completed') return row;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return null;
}

async function waitForOwner(owner, predicate) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (predicate(owner.getStatus())) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return false;
}

async function waitForOwnerRecovery(owner) {
  return waitForOwner(owner, snapshot => snapshot.migrationComplete === true
    && snapshot.recoveryComplete === true);
}

async function requestMaintenanceWhenReady(owner, operation) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const result = await owner.command('manage_index', { operation });
    if (result.started) return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return null;
}

async function waitForEngineProjects(engine, project, count) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const projects = engine.searchProjects('');
    if (projects.length === 1 && projects[0].project === project
      && projects[0].documentCount === count) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
}

function readCommittedState(keywordPath, storeRoot, query) {
  const crypto = require('node:crypto');
  const index = new SQLiteKeywordIndex({ dbPath: keywordPath, sourceRoot: storeRoot, readOnly: true });
  try {
    const db = index.open();
    const generationId = index.getCommittedGeneration()?.generationId;
    const rows = db.prepare('SELECT file_path, content_hash FROM keyword_documents ORDER BY file_path').all();
    const segments = db.prepare('SELECT file_path, search_text FROM keyword_segments ORDER BY file_path, ordinal').all();
    return { generationId,
      checksum: crypto.createHash('sha256').update(JSON.stringify({ rows, segments })).digest('hex'),
      hasBodyHit: index.search(query, { limit: 5 }).some(row => row.filePath.endsWith('committed.md')) };
  } finally { index.close(); }
}
