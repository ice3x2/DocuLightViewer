'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { SearchEngine } = require('../../../src/main/search-engine');
const { SQLiteKeywordIndex } = require('../../../src/main/search-sqlite-store');
const { SourceLedgerStore } = require('../../../src/main/source-ledger-store');

// @req FR-DOC-019 AC-6 AC-7 AC-8 AC-9
module.exports = { async run({ fixture, assert }) {
  const root = path.join(fixture.root, 's23');
  const storeRoot = path.join(root, 'store');
  const indexDataDir = path.join(root, 'index');
  fs.mkdirSync(storeRoot, { recursive: true });
  fs.mkdirSync(indexDataDir, { recursive: true });
  const keywordPath = path.join(indexDataDir, 'search-index.sqlite3');
  const writer = new SQLiteKeywordIndex({ dbPath: keywordPath, sourceRoot: storeRoot });
  const marker = 's23retainedcommittedkeyword';
  writer.replaceDocument({
    filePath: path.join(storeRoot, 'committed.md'), contentHash: 'sha256:committed', revision: 1,
    meta: { title: 'Committed', project: '', docName: 'committed', docType: 'markdown',
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
  } finally { engine.close(); }
} };
