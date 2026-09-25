'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');
const { SQLiteKeywordIndex } = require('../src/main/search-sqlite-store');
const { SourceLedgerStore } = require('../src/main/source-ledger-store');
const { OwnerWorkerController } = require('../src/main/search-owner-controller');
const { SearchEngine } = require('../src/main/search-engine');
const { composeIndexingStatusPayload, fromOwnerSnapshot } = require('../src/main/ledger-status-registry');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ready(owner) {
  for (let i = 0; i < 400; i += 1) {
    if (owner.getStatus().recoveryComplete) return;
    await delay(10);
  }
  throw new Error('owner recovery timeout');
}
async function terminal(owner, jobId) {
  for (let i = 0; i < 400; i += 1) {
    const state = owner.getStatus();
    if (state.jobId === jobId && state.active === false) return state;
    await delay(10);
  }
  throw new Error('owner maintenance timeout');
}
function committedKeywordSha256(dbPath, marker) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return crypto.createHash('sha256').update(JSON.stringify({
      generation: db.prepare("SELECT value FROM keyword_index_meta WHERE key = 'committed_generation'").get()?.value,
      documents: db.prepare('SELECT file_path, title, project, content_hash FROM keyword_documents ORDER BY file_path').all(),
      hitCount: db.prepare('SELECT COUNT(*) AS count FROM keyword_fts WHERE keyword_fts MATCH ?').get(marker).count
    })).digest('hex');
  } finally { db.close(); }
}
function sourceIdentitySha256(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return crypto.createHash('sha256').update(JSON.stringify({
      sources: db.prepare('SELECT source_id, root_fingerprint FROM sources ORDER BY source_id').all(),
      documents: db.prepare(`SELECT document_id, source_id, relative_path, path_key,
        project, category, document_tags_json, path_history_json
        FROM documents ORDER BY document_id`).all(),
      aliases: db.prepare(`SELECT alias_id, document_id, alias_kind, canonical_path_hash,
        origin_lexical_path_internal, origin_path_internal
        FROM document_source_aliases ORDER BY alias_id`).all()
    })).digest('hex');
  } finally { db.close(); }
}

async function main() {
  const ownerSource = fs.readFileSync(path.join(__dirname, '../src/main/search-owner-worker.js'), 'utf8');
  const compactStart = ownerSource.indexOf('function beginMaintenance(');
  const compactEnd = ownerSource.indexOf('\nfunction resumeLegacyMigration', compactStart);
  assert(compactStart >= 0 && compactEnd > compactStart, 'owner maintenance command is extractable');
  for (const mode of [0, 2]) {
    let inspected = 0;
    const context = { recoveryReady: true, recoveryComplete: true,
      lastSnapshot: { state: 'ready', active: false }, maintenanceJob: null,
      draining: false, sourceRoot: 'configured', ledger: {},
      keyword: { open: () => ({ pragma: name => {
        assert.equal(name, 'auto_vacuum');
        inspected += 1;
        return mode;
      } }) } };
    const reply = vm.runInNewContext(`${ownerSource.slice(compactStart, compactEnd)}\nbeginMaintenance('compact')`, context);
    assert.equal(inspected, 1, `compact inspects SQLite auto_vacuum mode ${mode}`);
    assert(reply.compacted === false && reply.started === false,
      'compact does not claim physical reclamation in either inspected mode');
    assert.equal(reply.reason, mode === 0 ? 'compact-rebuild-required' : 'compact-deferred',
      'NONE requires explicit rebuild guidance while other modes remain deferred');
  }
  const productSource = fs.readFileSync(path.join(__dirname, '../src/main/index.js'), 'utf8');
  const guardStart = productSource.indexOf('const settingsIndexingWindow = (event) => {');
  const guardEnd = productSource.indexOf("ipcMain.handle('indexing:start-rebuild'", guardStart);
  assert(guardStart >= 0 && guardEnd > guardStart);
  const realSettings = { webContents: { getURL: () => 'file:///settings.html' } };
  const settingsLikeViewer = { webContents: { getURL: () => 'file:///settings.html' } };
  const guardContext = { settingsWin: realSettings, r3SettingsProbeWindow: null,
    BrowserWindow: { fromWebContents: sender => sender.window },
    process: { env: {}, argv: [] } };
  const settingsGuard = vm.runInNewContext(`${productSource.slice(guardStart, guardEnd)}\nsettingsIndexingWindow`, guardContext);
  assert.equal(settingsGuard({ sender: { window: realSettings } }), realSettings,
    'tracked Settings window may invoke maintenance');
  assert.equal(settingsGuard({ sender: { window: settingsLikeViewer } }), null,
    'settings-like viewer URL cannot invoke maintenance');
  guardContext.r3SettingsProbeWindow = settingsLikeViewer;
  assert.equal(settingsGuard({ sender: { window: settingsLikeViewer } }), null,
    'R3 probe window is refused outside lifecycle test gate');
  guardContext.process.env.DOCULIGHT_R3_TEST_LIFECYCLE = '1';
  guardContext.process.argv.push('--r3-test-lifecycle');
  assert.equal(settingsGuard({ sender: { window: settingsLikeViewer } }), settingsLikeViewer,
    'R3 probe window is accepted only under gated test lifecycle');
  const compactIpcStart = productSource.indexOf("ipcMain.handle('indexing:compact'");
  const compactIpcEnd = productSource.indexOf("ipcMain.handle('indexing:clear'", compactIpcStart);
  assert(compactIpcStart >= 0 && compactIpcEnd > compactIpcStart);
  const compactHandlers = new Map();
  let compactOwnerCalls = 0;
  vm.runInNewContext(productSource.slice(compactIpcStart, compactIpcEnd), {
    ipcMain: { handle: (name, handler) => compactHandlers.set(name, handler) },
    BrowserWindow: { fromWebContents: sender => sender?.settings === true
      ? { webContents: { getURL: () => 'file:///settings.html' } }
      : { webContents: { getURL: () => 'file:///viewer.html' } } },
    isDocumentStoreSourceRootConfigured: () => true,
    getIndexingStatusPayload: () => ({ state: 'ready' }),
    settingsIndexingWindow: event => event?.sender?.settings === true,
    startOwnerIndexMaintenance: () => { compactOwnerCalls += 1; return { started: false,
      compacted: false, reason: 'compact-rebuild-required' }; }
  });
  const compactHandler = compactHandlers.get('indexing:compact');
  assert((await compactHandler()).reason === 'settings-only' && compactOwnerCalls === 0,
    'unattributed compact IPC cannot enter owner maintenance');
  assert((await compactHandler({ sender: { settings: false } })).reason === 'settings-only'
    && compactOwnerCalls === 0, 'viewer compact IPC cannot enter owner maintenance');
  assert((await compactHandler({ sender: { settings: true } })).reason === 'compact-rebuild-required'
    && compactOwnerCalls === 1, 'Settings compact IPC reaches owner once');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s23b-'));
  process.once('exit', () => {
    const tempRoot = fs.realpathSync.native(os.tmpdir());
    const target = path.resolve(root);
    if (path.dirname(target) === tempRoot && path.basename(target).startsWith('doculight-s23b-')) {
      try { fs.rmSync(target, { recursive: true, force: true }); }
      catch { /* an early assertion can leave a SQLite handle open on Windows */ }
    }
  });
  const storeRoot = path.join(root, 'store');
  const dataRoot = path.join(root, 'index');
  fs.mkdirSync(storeRoot);
  fs.mkdirSync(dataRoot);
  const keywordPath = path.join(dataRoot, 'search-index.sqlite3');
  const ledgerPath = path.join(dataRoot, 'smart-search.sqlite3');
  const marker = 's23bbodyonlymarker';
  const documentPath = path.join(storeRoot, 'document.md');
  fs.writeFileSync(documentPath, `# Visible title\n\n${marker}\n`);
  const keyword = new SQLiteKeywordIndex({ dbPath: keywordPath, sourceRoot: storeRoot });
  keyword.replaceDocument({ filePath: documentPath, contentHash: 'body-hash', revision: 1,
    meta: { title: 'Visible title', project: 'Visible project', docName: 'document',
      docType: 'markdown', description: '', snippet: 'Visible snippet', documentTags: [] },
    segments: [{ ordinal: 0, searchText: marker, textHash: 'body-hash' }] });
  const db = keyword.open();
  db.exec('CREATE TABLE s23b_freelist_probe (content BLOB)');
  db.prepare('INSERT INTO s23b_freelist_probe VALUES (?)').run(Buffer.alloc(32 * 1024 * 1024, 7));
  db.exec('DELETE FROM s23b_freelist_probe');
  const before = { mode: db.pragma('auto_vacuum', { simple: true }),
    free: db.pragma('freelist_count', { simple: true }), bytes: fs.statSync(keywordPath).size,
    generation: keyword.getCommittedGeneration().generationId,
    journalMode: db.pragma('journal_mode', { simple: true }),
    logicalSha256: crypto.createHash('sha256').update(JSON.stringify({
      generation: keyword.getCommittedGeneration().generationId,
      documents: db.prepare('SELECT file_path, title, project, content_hash FROM keyword_documents ORDER BY file_path').all(),
      hitCount: keyword.search(marker).length
    })).digest('hex') };
  assert.equal(before.mode, 0, 'existing SQLite index uses auto_vacuum=NONE');
  assert(before.free > 0, 'real index has pages available to reclaim');
  assert(keyword.search(marker).some(row => row.filePath === documentPath), 'committed body-only FTS hit exists');
  keyword.close();
  const ledger = new SourceLedgerStore({ dbPath: ledgerPath });
  ledger.initialize();
  const seededAt = new Date().toISOString();
  const sourceDb = ledger.open();
  sourceDb.prepare(`INSERT INTO sources(source_id, root_path_internal, root_fingerprint,
    created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
    's23b-source', storeRoot, 's23b-root', seededAt, seededAt);
  sourceDb.prepare(`INSERT INTO documents(document_id, source_id, relative_path, path_key,
    project, category, document_tags_json, first_seen_at, last_seen_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    's23b-document', 's23b-source', 'document.md', 'document.md',
    'Visible project', 'research', '["stable-tag"]', seededAt, seededAt, seededAt, seededAt);
  sourceDb.prepare(`INSERT INTO document_source_aliases(alias_id, document_id, alias_kind,
    canonical_path_hash, origin_lexical_path_internal, origin_path_internal,
    first_seen_at, last_seen_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    's23b-alias', 's23b-document', 'opened_path', 's23b-canonical',
    documentPath, documentPath, seededAt, seededAt, seededAt, seededAt);
  ledger.enqueueIndexJob({ jobId: 'unrelated-job', jobType: 'index_document', status: 'queued',
    requestedBy: 'test.unrelated' });
  ledger.close();
  const sourceIdentityBefore = sourceIdentitySha256(ledgerPath);
  const ingressRoot = path.join(root, 'ingress');
  fs.mkdirSync(ingressRoot);
  const engine = new SearchEngine({ get: (key, fallback) => key === 'mcpAutoSavePath'
    ? storeRoot : key === 'mcpAutoSave' ? true : fallback },
    { indexBackend: 'sqlite', indexDataDir: dataRoot, ownerManaged: true,
      keywordTokenizerProvider: 'basic' });
  await engine.initialize();
  assert(engine.search(marker).some(row => row.filePath === documentPath),
    'product facade starts with the committed body-only hit');
  const { createToolHandlers } = await import('../src/main/mcp-http.mjs');
  const publicSearch = createToolHandlers(null, engine.store, engine);
  const publicBefore = {
    documents: await publicSearch.search_documents({ query: marker }),
    projects: await publicSearch.search_projects({ query: 'Visible project' }),
    smart: await publicSearch.smart_search({ query: marker, mode: 'keyword' })
  };
  assert(publicBefore.documents.content[0].text.includes(marker)
    && publicBefore.projects.content[0].text.includes('Visible project')
    && publicBefore.smart.content[0].text.includes('Visible title'),
  'all three public search tools find the committed body-only marker or its project');
  const ownerSnapshots = [];
  const owner = new OwnerWorkerController({ ledgerPath, keywordPath, sourceRoot: storeRoot,
    publicationRoot: fs.realpathSync.native(storeRoot), ingressRoot,
    deriveDocuments: false, keywordTokenizerProvider: 'basic',
    onStatus: snapshot => { ownerSnapshots.push(snapshot); engine.onOwnerStatus(snapshot); } });
  let firstClearJobId;
  try {
    await owner.start();
    await ready(owner);
    const compact = process.env.S23B_ONLY_CLEAR === '1'
      ? { started: false, reason: 'compact-rebuild-required' }
      : await owner.command('manage_index', { operation: 'compact' });
    if (process.env.S23B_ONLY_CLEAR !== '1') assert(compact.started || compact.reason === 'compact-rebuild-required',
      'NONE-mode compact must schedule real reclamation or explicitly require rebuild');
    if (compact.started) {
      assert(compact.scheduled && compact.compacted === false, 'compact acknowledges scheduled work, not completion');
      const during = await owner.query('query_keyword', { query: marker });
      assert(during.some(row => row.filePath === documentPath), 'old body-only FTS remains during compact');
      const end = await terminal(owner, compact.jobId);
      assert(['completed', 'failed', 'cancelled'].includes(end.phase), 'compact reaches terminal status');
    }
    const after = new Database(keywordPath, { readonly: true, fileMustExist: true });
    try {
      const actual = { mode: after.pragma('auto_vacuum', { simple: true }),
        free: after.pragma('freelist_count', { simple: true }), bytes: fs.statSync(keywordPath).size,
        journalMode: after.pragma('journal_mode', { simple: true }),
        logicalSha256: crypto.createHash('sha256').update(JSON.stringify({
          generation: after.prepare("SELECT value FROM keyword_index_meta WHERE key = 'committed_generation'").get()?.value,
          documents: after.prepare('SELECT file_path, title, project, content_hash FROM keyword_documents ORDER BY file_path').all(),
          hitCount: after.prepare('SELECT COUNT(*) AS count FROM keyword_fts WHERE keyword_fts MATCH ?').get(marker).count
        })).digest('hex') };
      if (compact.reason === 'compact-rebuild-required') {
        assert.equal(actual.logicalSha256, before.logicalSha256,
          'NONE-mode compact preserves committed logical keyword rows and generation');
        assert.equal(actual.bytes, before.bytes, 'NONE-mode compact does not claim physical reclamation');
      }
      if (compact.started && owner.getStatus().phase === 'completed') {
        assert(actual.free < before.free || actual.bytes < before.bytes,
          'successful NONE-mode compact physically reclaims free pages');
      }
      console.error(`S23B_COMPACT_ORACLE ${JSON.stringify({ before, after: actual, compact })}`);
    } finally { after.close(); }
    const publicAfterCompact = {
      documents: await publicSearch.search_documents({ query: marker }),
      projects: await publicSearch.search_projects({ query: 'Visible project' }),
      smart: await publicSearch.smart_search({ query: marker, mode: 'keyword' })
    };
    assert.deepEqual(publicAfterCompact, publicBefore,
      'deferred compact preserves all three public search envelopes');
    assert((await owner.query('query_keyword', { query: marker })).some(row => row.filePath === documentPath),
      'deferred compact preserves owner body-only query');
    const clear = await owner.command('manage_index', { operation: 'clear' });
    firstClearJobId = clear.jobId;
    assert(clear.started === true && clear.scheduled === true && typeof clear.jobId === 'string',
      'confirmed owner clear starts a durable maintenance job');
    const querySamplesMs = [];
    const statusSamplesMs = [];
    let oldHit;
    let duringStatus;
    let activeStatus;
    for (let sample = 0; sample < 16; sample += 1) {
      const queryStarted = performance.now();
      oldHit = await owner.query('query_keyword', { query: marker });
      querySamplesMs.push(performance.now() - queryStarted);
      const statusStarted = performance.now();
      duringStatus = await owner.query('get_status');
      if (duringStatus.kind === 'clear' && duringStatus.active === true) activeStatus = duringStatus;
      statusSamplesMs.push(performance.now() - statusStarted);
      assert(oldHit.some(row => row.filePath === documentPath),
        'committed body-only FTS hit remains queryable while clear runs');
    }
    const queryMs = Math.max(...querySamplesMs);
    const statusMs = Math.max(...statusSamplesMs);
    const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
    assert(activeStatus && Number.isFinite(Date.parse(activeStatus.heartbeatAt)),
    'clear status includes a live owner heartbeat during backup');
    assert(queryMs <= 1000 && statusMs <= 1000,
      'owner query and status remain responsive while backup runs');
    assert(oldHit.some(row => row.filePath === documentPath), 'old body-only hit remains visible during clear backup');
    assert(engine.search(marker).some(row => row.filePath === documentPath),
      'product read-only facade remains visible until clear terminal success');
    const publicDuring = {
      documents: await publicSearch.search_documents({ query: marker }),
      projects: await publicSearch.search_projects({ query: 'Visible project' }),
      smart: await publicSearch.smart_search({ query: marker, mode: 'keyword' })
    };
    assert.deepEqual(publicDuring, publicBefore,
      'all three public search envelopes remain unchanged while clear is pending');
    const end = await terminal(owner, clear.jobId);
    assert.equal(end.phase, 'completed', 'clear commits only after backup validation');
    const activeClear = ownerSnapshots.find(snapshot => snapshot.kind === 'clear' && snapshot.active);
    assert(activeClear && composeIndexingStatusPayload(engine.getStatus(), activeClear, true).state === 'clearing',
      'Settings status reports clearing while owner clear is active');
    assert.equal(fromOwnerSnapshot(activeClear, true).ledgerState, 'READY_MAINTENANCE_PENDING',
      'active owner clear does not map to a misleading cold ledger state');
    assert.equal(typeof end.backupPath, 'string', 'terminal clear publishes a redacted backup path token');
    const backups = fs.readdirSync(dataRoot).filter(name => name.includes('.backup-clear-') && name.endsWith('.sqlite3'));
    assert.equal(backups.length, 1, 'clear leaves one restorable SQLite backup');
    const backup = new SQLiteKeywordIndex({ dbPath: path.join(dataRoot, backups[0]), sourceRoot: storeRoot,
      readOnly: true });
    try {
      assert.equal(backup.open().pragma('quick_check(1)', { simple: true }), 'ok');
      assert(backup.search(marker).some(row => row.filePath === documentPath),
        'backup restores the previous committed body-only hit');
    } finally { backup.close(); }
    const cleared = new SQLiteKeywordIndex({ dbPath: keywordPath, sourceRoot: storeRoot, readOnly: true });
    try {
      assert.equal(cleared.getCommittedGeneration(), null, 'clear removes the committed keyword generation');
      assert.equal(cleared.search(marker).length, 0, 'clear removes only the keyword cache');
    } finally { cleared.close(); }
    assert(fs.existsSync(documentPath), 'clear leaves Markdown intact');
    assert.equal(sourceIdentitySha256(ledgerPath), sourceIdentityBefore,
      'successful clear preserves source ID, metadata, and original alias');
    const sourceLedger = new SourceLedgerStore({ dbPath: ledgerPath, readOnly: true });
    try {
      assert.equal(sourceLedger.open().prepare("SELECT status FROM index_jobs WHERE job_id = 'unrelated-job'").get()?.status,
        'queued', 'clear leaves unrelated jobs intact');
    } finally { sourceLedger.close(); }
    for (let i = 0; i < 100 && engine.search(marker).length; i += 1) await delay(10);
    assert.equal(engine.search(marker).length, 0,
      'product read-only facade invalidates only after successful clear');
    assert.equal(engine.searchProjects('').length, 0,
      'product project metadata invalidates after successful clear');
    const clearHeartbeats = ownerSnapshots.filter(snapshot => snapshot.kind === 'clear'
      && snapshot.active && Number.isFinite(Date.parse(snapshot.heartbeatAt)))
      .map(snapshot => Date.parse(snapshot.heartbeatAt));
    const maxHeartbeatGapMs = clearHeartbeats.slice(1).reduce((max, at, index) =>
      Math.max(max, at - clearHeartbeats[index]), 0);
    assert(clearHeartbeats.length > 1 && maxHeartbeatGapMs <= 1000,
      'substantial backup publishes bounded owner heartbeat opportunities');
    console.error(`S23B_CLEAR_EVIDENCE ${JSON.stringify({ querySamplesMs, statusSamplesMs,
      queryP95Ms: percentile(querySamplesMs, 0.95), queryP99Ms: percentile(querySamplesMs, 0.99),
      queryMaxMs: queryMs, statusP95Ms: percentile(statusSamplesMs, 0.95),
      statusP99Ms: percentile(statusSamplesMs, 0.99), statusMaxMs: statusMs,
      heartbeatCount: clearHeartbeats.length, maxHeartbeatGapMs,
      activeHeartbeatAt: activeStatus.heartbeatAt, backupToken: end.backupPath,
      backupBytes: fs.statSync(path.join(dataRoot, backups[0])).size,
      sourceJobPreserved: true, markdownSha256: crypto.createHash('sha256')
        .update(fs.readFileSync(documentPath)).digest('hex') })}`);
  } finally { await owner.shutdown(); engine.close(); }

  const reseed = new SQLiteKeywordIndex({ dbPath: keywordPath, sourceRoot: storeRoot });
  reseed.replaceDocument({ filePath: documentPath, contentHash: 'body-hash-restored', revision: 2,
    meta: { title: 'Visible title', project: 'Visible project', docName: 'document',
      docType: 'markdown', description: '', snippet: 'Visible snippet', documentTags: [] },
    segments: [{ ordinal: 0, searchText: marker, textHash: 'body-hash-restored' }] });
  const retainedGeneration = reseed.getCommittedGeneration().generationId;
  assert.equal(reseed.open().prepare('SELECT job_id FROM keyword_clear_receipts WHERE job_id = ?')
    .get(firstClearJobId)?.job_id, firstClearJobId,
  'append-only clear receipt survives a later keyword generation');
  reseed.close();
  const retainedLogicalSha256 = committedKeywordSha256(keywordPath, marker);
  const faultOwner = new OwnerWorkerController({ ledgerPath, keywordPath, sourceRoot: storeRoot,
    publicationRoot: fs.realpathSync.native(storeRoot), ingressRoot,
    deriveDocuments: false, keywordTokenizerProvider: 'basic', r3MaintenanceFaultBeforeCommit: true });
  try {
    await faultOwner.start();
    await ready(faultOwner);
    const faultClear = await faultOwner.command('manage_index', { operation: 'clear' });
    assert.equal(faultClear.started, true);
    const failed = await terminal(faultOwner, faultClear.jobId);
    assert.equal(failed.phase, 'failed', 'precommit clear fault has a terminal failed status');
    assert((await faultOwner.query('query_keyword', { query: marker })).some(row => row.filePath === documentPath),
      'precommit clear fault preserves old body-only owner query');
    const inspect = new SQLiteKeywordIndex({ dbPath: keywordPath, sourceRoot: storeRoot, readOnly: true });
    try { assert.equal(inspect.getCommittedGeneration().generationId, retainedGeneration); }
    finally { inspect.close(); }
    assert.equal(committedKeywordSha256(keywordPath, marker), retainedLogicalSha256,
      'precommit clear fault preserves committed keyword rows and body-only hit checksum');
    assert.equal(sourceIdentitySha256(ledgerPath), sourceIdentityBefore,
      'precommit clear fault preserves source ID, metadata, and original alias');
  } finally { await faultOwner.shutdown(); }

  const cancelOwner = new OwnerWorkerController({ ledgerPath, keywordPath, sourceRoot: storeRoot,
    publicationRoot: fs.realpathSync.native(storeRoot), ingressRoot,
    deriveDocuments: false, keywordTokenizerProvider: 'basic' });
  try {
    await cancelOwner.start();
    await ready(cancelOwner);
    const cancelClear = await cancelOwner.command('manage_index', { operation: 'clear' });
    assert.equal(cancelClear.started, true);
    const cancelStarted = Date.now();
    const cancellation = await cancelOwner.cancel(cancelClear.jobId);
    const cancelMs = Date.now() - cancelStarted;
    assert(cancellation.cancelled && cancelMs <= 1000, 'clear cancel is acknowledged within one second');
    const cancelled = await terminal(cancelOwner, cancelClear.jobId);
    assert.equal(cancelled.phase, 'cancelled', 'cancel rolls back clear before commit');
    assert((await cancelOwner.query('query_keyword', { query: marker })).some(row => row.filePath === documentPath),
      'cancelled clear preserves the old committed body-only hit');
    const afterCancelLogicalSha256 = committedKeywordSha256(keywordPath, marker);
    assert.equal(afterCancelLogicalSha256, retainedLogicalSha256,
      'cancelled clear preserves committed keyword rows and body-only hit checksum');
    const afterCancelSourceSha256 = sourceIdentitySha256(ledgerPath);
    assert.equal(afterCancelSourceSha256, sourceIdentityBefore,
      'cancelled clear preserves source ID, metadata, and original alias');
    console.error(`S23B_CANCEL_EVIDENCE ${JSON.stringify({ cancelMs, phase: cancelled.phase,
      beforeLogicalSha256: retainedLogicalSha256, afterLogicalSha256: afterCancelLogicalSha256,
      beforeSourceSha256: sourceIdentityBefore, afterSourceSha256: afterCancelSourceSha256 })}`);
  } finally { await cancelOwner.shutdown(); }
  const interruptedLedger = new SourceLedgerStore({ dbPath: ledgerPath });
  interruptedLedger.initialize();
  interruptedLedger.enqueueIndexJob({ jobId: 'interrupted-clear', jobType: 'keyword_clear',
    status: 'indexing', requestedBy: 'settings.clear' });
  interruptedLedger.close();
  const restarted = new OwnerWorkerController({ ledgerPath, keywordPath, sourceRoot: storeRoot,
    publicationRoot: fs.realpathSync.native(storeRoot), ingressRoot,
    deriveDocuments: false, keywordTokenizerProvider: 'basic' });
  try {
    await restarted.start();
    await ready(restarted);
    const read = new SourceLedgerStore({ dbPath: ledgerPath, readOnly: true });
    try {
      assert.equal(read.open().prepare("SELECT status FROM index_jobs WHERE job_id = 'interrupted-clear'").get()?.status,
        'failed', 'owner restart marks interrupted clear retryable without deleting the index');
    } finally { read.close(); }
    assert((await restarted.query('query_keyword', { query: marker })).some(row => row.filePath === documentPath),
      'interrupted clear preserves the previous committed body hit');
  } finally { await restarted.shutdown(); }
  let postCommitJobId;
  const postCommitOwner = new OwnerWorkerController({ ledgerPath, keywordPath, sourceRoot: storeRoot,
    publicationRoot: fs.realpathSync.native(storeRoot), ingressRoot,
    deriveDocuments: false, keywordTokenizerProvider: 'basic', r3MaintenanceFaultAfterCommit: true });
  try {
    await postCommitOwner.start();
    await ready(postCommitOwner);
    const clear = await postCommitOwner.command('manage_index', { operation: 'clear' });
    assert(clear.started && clear.scheduled);
    postCommitJobId = clear.jobId;
    const done = await terminal(postCommitOwner, clear.jobId);
    assert.equal(done.phase, 'completed', 'postcommit ledger failure must not report clear as rolled back');
    assert.equal(done.diagnostic?.code, 'index_clear_ledger_finalize_pending',
      'postcommit ledger failure is an explicit repair-pending diagnostic');
    assert.equal((await postCommitOwner.query('query_keyword', { query: marker })).length, 0,
      'postcommit clear accurately reports the old generation gone');
    const marked = new SQLiteKeywordIndex({ dbPath: keywordPath, sourceRoot: storeRoot, readOnly: true });
    try {
      assert.equal(marked.open().prepare('SELECT job_id FROM keyword_clear_receipts WHERE job_id = ?')
        .get(clear.jobId)?.job_id, clear.jobId,
        'keyword transaction persists a clear commit marker for restart reconciliation');
    } finally { marked.close(); }
  } finally { await postCommitOwner.shutdown(); }
  const finalized = new OwnerWorkerController({ ledgerPath, keywordPath, sourceRoot: storeRoot,
    publicationRoot: fs.realpathSync.native(storeRoot), ingressRoot,
    deriveDocuments: false, keywordTokenizerProvider: 'basic' });
  try {
    await finalized.start();
    await ready(finalized);
    const read = new SourceLedgerStore({ dbPath: ledgerPath, readOnly: true });
    try {
      assert.equal(read.open().prepare('SELECT status FROM index_jobs WHERE job_id = ?')
        .get(postCommitJobId)?.status, 'completed',
      'restart finalizes a committed clear rather than claiming rollback');
    } finally { read.close(); }
  } finally { await finalized.shutdown(); }

  const product = fs.readFileSync(path.join(__dirname, '../src/main/index.js'), 'utf8');
  const maintenanceStart = product.indexOf('const startOwnerIndexMaintenance = async (operation) => {');
  const maintenanceEnd = product.indexOf("ipcMain.handle('indexing:compact'", maintenanceStart);
  assert(maintenanceStart > 0 && maintenanceEnd > maintenanceStart);
  const maintenanceHandlers = new Map();
  let ownerCommands = 0;
  let ownerCancels = 0;
  let legacyCancels = 0;
  const fakeOwner = { getStatus: () => ({ state: 'stale', active: false }),
    command: async () => { ownerCommands += 1; return { started: true, scheduled: true }; },
    cancel: async () => { ownerCancels += 1; return { cancelled: true }; } };
  const maintenanceContext = {
    ipcMain: { handle: (name, handler) => maintenanceHandlers.set(name, handler) },
    BrowserWindow: { fromWebContents: sender => sender?.settings === true
      ? realSettings
      : { webContents: { getURL: () => 'file:///viewer.html' } } },
    settingsWin: realSettings, r3SettingsProbeWindow: null,
    process: { env: {}, argv: [] },
    searchEngine: { getSaveDocumentOwner: async () => fakeOwner,
      cancelRebuild: () => { legacyCancels += 1; return { cancelled: false }; } },
    saveDocumentOwner: fakeOwner,
    isDocumentStoreSourceRootConfigured: () => true,
    getIndexingStatusPayload: () => ({ state: 'ready' }),
    store: { get: () => storeRoot },
    require: name => name === './ledger-status-registry'
      ? require('../src/main/ledger-status-registry') : require(name)
  };
  const rejectedCompact = await vm.runInNewContext(`${product.slice(maintenanceStart, maintenanceEnd)}\nstartOwnerIndexMaintenance('compact')`,
    maintenanceContext);
  assert.equal(rejectedCompact.started, false, 'degraded keyword state rejects Settings compact');
  assert.equal(ownerCommands, 0, 'rejected compact sends no owner command');
  fakeOwner.getStatus = () => ({ state: 'ready', active: false });
  for (const channel of ['indexing:start-rebuild', 'indexing:retry-failures']) {
    for (const event of [undefined, { sender: { settings: false } }]) {
      const denied = await maintenanceHandlers.get(channel)(event);
      assert(denied.started === false && denied.reason === 'settings-only' && ownerCommands === 0,
        `${channel} rejects non-Settings sender without owner work`);
    }
  }
  fakeOwner.getStatus = () => ({ state: 'clearing', active: true, kind: 'clear', jobId: 'clear-1' });
  for (const event of [undefined, { sender: { settings: false } }]) {
    const denied = await maintenanceHandlers.get('indexing:cancel-job')(event);
    assert(denied.cancelled === false && denied.reason === 'settings-only' && ownerCancels === 0,
      'cancel rejects non-Settings sender without owner work');
  }
  const cancelledFromSettings = await maintenanceHandlers.get('indexing:cancel-job')({ sender: { settings: true } });
  assert(cancelledFromSettings.cancelled && ownerCancels === 1 && legacyCancels === 0,
    'Settings cancel routes active clear to owner, not the short worker');

  const start = product.indexOf("ipcMain.handle('indexing:clear'");
  const end = product.indexOf("ipcMain.handle('indexing:open-data-dir'", start);
  assert(start >= 0 && end > start, 'real Settings clear IPC handler is extractable');
  const handlers = new Map();
  let clearCalls = 0;
  let confirmationResponse = 1;
  let prompts = 0;
  vm.runInNewContext(product.slice(start, end), {
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    settingsIndexingWindow: event => event?.sender
      ? { webContents: { getURL: () => 'file:///settings.html' } } : null,
    searchEngine: { clear: () => { clearCalls += 1; return { cleared: true }; } },
    startOwnerIndexMaintenance: () => { clearCalls += 1; return { started: true }; },
    dialog: { showMessageBox: async () => { prompts += 1; return { response: confirmationResponse }; } },
    BrowserWindow: { fromWebContents: () => ({ webContents: { getURL: () => 'file:///settings.html' } }) },
    t: key => key,
    getIndexingStatusPayload: () => ({ state: 'ready' })
  });
  const direct = await handlers.get('indexing:clear')();
  assert.equal(clearCalls, 0, 'direct unconfirmed clear IPC cannot start a mutation');
  assert.equal(direct.cleared, false, 'unconfirmed clear reports no deletion');
  assert.equal(prompts, 0, 'IPC without a Settings sender does not open a confirmation prompt');
  const sender = { sender: {} };
  const declined = await handlers.get('indexing:clear')(sender);
  assert.equal(declined.cleared, false);
  assert.equal(clearCalls, 0, 'declined main confirmation cannot start owner clear');
  confirmationResponse = 0;
  const confirmed = await handlers.get('indexing:clear')(sender);
  assert.equal(clearCalls, 1, 'confirmed Settings clear enters the owner maintenance adapter once');
  assert.equal(confirmed.started, true);
  const settingsSource = fs.readFileSync(path.join(__dirname, '../src/renderer/settings.js'), 'utf8');
  const rebuildRule = settingsSource.match(/if \(indexingRebuildBtn\) indexingRebuildBtn\.disabled = ([\s\S]*?);/);
  assert(rebuildRule, 'Settings rebuild enablement rule is extractable');
  assert.equal(vm.runInNewContext(rebuildRule[1], { busy: false,
    ledgerState: 'READY_KEYWORD_DEGRADED', active: false, sourceRootConfigured: true }), false,
  'keyword rebuild remains available after successful clear');
  const cancelStart = settingsSource.indexOf('const legacyCancelAvailable =');
  const cancelEnd = settingsSource.indexOf('const legacyRetryAvailable =', cancelStart);
  assert(cancelStart > 0 && cancelEnd > cancelStart);
  const clearCancelAvailable = vm.runInNewContext(`${settingsSource.slice(cancelStart, cancelEnd)}\nlegacyCancelAvailable`, {
    nativeRepairActive: false, rebuildActive: false, state: 'clearing',
    status: { indexingWorker: { active: false } }
  });
  assert(clearCancelAvailable, 'Settings enables Stop while owner clear is active');
  const formatStart = settingsSource.indexOf('function formatIndexingActionResult(result) {');
  const formatEnd = settingsSource.indexOf('function formatLinkedImportMessage(', formatStart);
  assert(formatStart > 0 && formatEnd > formatStart);
  const formatResult = vm.runInNewContext(`${settingsSource.slice(formatStart, formatEnd)}\nformatIndexingActionResult`, {
    t: (key, params) => key === 'settings.indexingCompactRebuildRequired'
      ? 'Rebuild the search index to reclaim database space.' : `${key} ${params?.reason || ''}`,
    formatIndexingDiagnostic: value => value
  });
  assert.equal(formatResult({ cleared: false, scheduled: true }).type, 'notice',
    'Settings treats accepted asynchronous clear as scheduled');
  assert(formatResult({ compacted: false, reason: 'compact-rebuild-required' }).message
    .includes('Rebuild the search index to reclaim database space.'),
  'deferred compact presents localized rebuild guidance');
  assert(formatResult({ compacted: false, reason: 'compact-deferred' }).message
    .includes('Rebuild the search index to reclaim database space.'),
  'other auto_vacuum modes also receive localized deferred guidance');
  for (const locale of ['ko', 'en', 'ja', 'es']) {
    const strings = JSON.parse(fs.readFileSync(path.join(__dirname, `../src/locales/${locale}.json`), 'utf8'));
    assert(strings['settings.indexingCompactRebuildRequired'], `${locale} has compact fallback guidance`);
  }
  console.error(`S23B_RED_GREEN ${crypto.createHash('sha256').update(JSON.stringify(before)).digest('hex')}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
