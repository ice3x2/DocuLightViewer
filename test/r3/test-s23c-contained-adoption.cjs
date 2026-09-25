'use strict';

// @req FR-DOC-019 AC-10 FR-DOC-035 AC-4 AC-6 AC-7 AC-13
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { OwnerWorkerController } = require('../../src/main/search-owner-controller');
const { createSourceLedgerStore } = require('../../src/main/source-ledger-store');
const { createOpenedMarkdownRegistrar } = require('../../src/main/opened-markdown-registrar');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s23c-'));
  const storeRoot = path.join(root, 'store');
  fs.mkdirSync(storeRoot);
  const ledgerPath = path.join(root, 'index', 'smart-search.sqlite3');
  fs.mkdirSync(path.dirname(ledgerPath));
  const owner = new OwnerWorkerController({ ledgerPath, keywordPath: path.join(root, 'keyword.sqlite3'),
    sourceRoot: storeRoot, ingressRoot: path.join(root, 'ingress'), deriveDocuments: false,
    keywordTokenizerProvider: 'basic' });
  try {
    const seededPath = path.join(storeRoot, 'Seeded.md');
    fs.writeFileSync(seededPath, '# Seeded prior\n');
    const seededLedger = createSourceLedgerStore({ dbPath: ledgerPath });
    seededLedger.initialize();
    const seededSource = seededLedger.recordSource({ rootPathInternal: storeRoot,
      sourceKind: 'knowledge_store' });
    seededLedger.upsertDocument({ sourceId: seededSource.sourceId, documentId: 'doc_seeded',
      sourceRelativePath: 'Seeded.md', canonicalPathInternal: seededPath,
      contentHash: `sha256:${require('node:crypto').createHash('sha256').update('# Seeded prior\n').digest('hex')}`,
      contentByteLength: Buffer.byteLength('# Seeded prior\n'), contentTextLength: '# Seeded prior\n'.length,
      category: 'retained', documentTags: ['saved'],
      pathHistory: [{ relativePath: 'Older.md', pathKey: 'older.md', pathStatus: 'moved' }] });
    const originalPath = path.join(root, 'original.md');
    seededLedger.upsertDocumentSourceAlias({ documentId: 'doc_seeded', aliasKind: 'opened_path',
      originLexicalPathInternal: originalPath, originPathInternal: originalPath });
    seededLedger.close();
    await owner.start();
    const registrar = createOpenedMarkdownRegistrar({ store: { get(key) {
      if (key === 'registerOpenedMarkdown') return true;
      if (key === 'mcpAutoSavePath') return storeRoot;
      return null;
    } }, searchEngine: { getSourceLedger() { throw new Error('main ledger access'); },
      async getSaveDocumentOwner() { return owner; } } });
    const registeredPath = path.join(storeRoot, 'Registered.md');
    fs.writeFileSync(registeredPath, '# Registered\n');
    const registered = await registrar.register(registeredPath);
    assert.equal(registered.status, 'queued');
    assert.equal((await registrar.register(registeredPath)).status, 'existing');
    fs.mkdirSync(path.join(storeRoot, 'canonical'));
    const a = path.join(storeRoot, 'canonical', 'A.md');
    const b = path.join(storeRoot, 'B.markdown');
    fs.writeFileSync(a, '# A\n');
    const first = await owner.command('adopt_contained', { sourceRelativeLocator: 'canonical/A.md' });
    assert.equal(first.status, 'queued');
    assert.ok(first.document.documentId);
    assert.equal(fs.readFileSync(a, 'utf8'), '# A\n');
    const beforeUnchanged = createSourceLedgerStore({ dbPath: ledgerPath, readOnly: true });
    const sourceUpdatedAt = beforeUnchanged.open().prepare('SELECT updated_at FROM sources').get().updated_at;
    beforeUnchanged.close();
    await new Promise(resolve => setTimeout(resolve, 25));
    const second = await owner.command('adopt_contained', { sourceRelativeLocator: 'canonical/A.md' });
    assert.equal(second.status, 'existing');
    assert.equal(second.document.documentId, first.document.documentId);
    assert.equal(second.jobId, undefined);
    const afterUnchanged = createSourceLedgerStore({ dbPath: ledgerPath, readOnly: true });
    try {
      assert.equal(afterUnchanged.open().prepare('SELECT updated_at FROM sources').get().updated_at,
        sourceUpdatedAt, 'unchanged adoption does not rewrite source metadata');
    } finally { afterUnchanged.close(); }
    fs.symlinkSync(path.join(storeRoot, 'canonical'), path.join(storeRoot, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir');
    const aliased = await owner.command('adopt_contained', { sourceRelativeLocator: 'alias/A.md' });
    assert.equal(aliased.status, 'existing');
    assert.equal(aliased.document.documentId, first.document.documentId);
    fs.writeFileSync(b, '# A\n');
    const duplicate = await owner.command('adopt_contained', { sourceRelativeLocator: 'B.markdown' });
    assert.equal(duplicate.status, 'duplicate_candidate');
    assert.equal(duplicate.documentId, first.document.documentId);
    assert.equal(duplicate.diagnosticCode, 'duplicate_content_active_path');
    assert.notEqual(fs.realpathSync.native(a), fs.realpathSync.native(b),
      'same bytes belong to distinct canonical paths');
    const canonicalHash = value => crypto.createHash('sha256').update(process.platform === 'win32'
      ? path.resolve(value).toLowerCase() : path.resolve(value)).digest('hex');
    assert.notEqual(canonicalHash(fs.realpathSync.native(a)), canonicalHash(fs.realpathSync.native(b)));
    assert.equal(fs.readFileSync(a, 'utf8'), '# A\n', 'candidate rejection leaves A bytes unchanged');
    assert.equal(fs.readFileSync(b, 'utf8'), '# A\n', 'candidate rejection leaves B bytes unchanged');
    assert(!JSON.stringify(duplicate).includes(storeRoot), 'candidate result redacts raw store path');
    await owner.shutdown();
    await owner.start();
    const afterRestart = await owner.command('adopt_contained', { sourceRelativeLocator: 'canonical/A.md' });
    assert.equal(afterRestart.document.documentId, first.document.documentId,
      'restarted owner keeps canonical document identity');
    assert.equal(afterRestart.status, 'existing');
    fs.writeFileSync(a, '# A changed\n');
    const changed = await owner.command('adopt_contained', { sourceRelativeLocator: 'canonical/A.md' });
    assert.equal(changed.status, 'queued');
    assert.equal(changed.document.documentId, first.document.documentId);
    assert.notEqual(changed.jobId, first.jobId);
    const retry = await owner.command('adopt_contained', { sourceRelativeLocator: 'canonical/A.md' });
    assert.equal(retry.status, 'existing');
    const trustedPath = path.join(storeRoot, 'Trusted.md');
    fs.writeFileSync(trustedPath, '---\ndocumentId: doc:trusted\ncategory: product\ndocumentTags: alpha\n---\n# Trusted\n');
    const trusted = await owner.command('adopt_contained', { sourceRelativeLocator: 'Trusted.md' });
    assert.equal(trusted.document.documentId, 'doc:trusted');
    assert.equal(trusted.document.category, 'product');
    assert.deepEqual(trusted.document.documentTags, ['alpha']);
    fs.writeFileSync(seededPath, '# Seeded changed\n');
    const seededChanged = await owner.command('adopt_contained', { sourceRelativeLocator: 'Seeded.md' });
    assert.equal(seededChanged.document.documentId, 'doc_seeded');
    assert.equal(seededChanged.document.category, 'retained');
    assert.deepEqual(seededChanged.document.documentTags, ['saved']);
    assert.equal(seededChanged.document.pathHistory.length, 1);
    const ledger = createSourceLedgerStore({ dbPath: ledgerPath, readOnly: true });
    try {
      assert.equal(ledger.open().prepare('SELECT count(*) AS count FROM documents').get().count, 4);
      assert.equal(ledger.open().prepare('SELECT count(*) AS count FROM index_jobs').get().count, 5);
      assert.equal(ledger.open().prepare("SELECT count(*) AS count FROM document_source_aliases WHERE document_id = 'doc_seeded'").get().count, 1);
    } finally { ledger.close(); }
    await assert.rejects(owner.command('adopt_contained', { sourceRelativeLocator: '../A.md' }));
    await assert.rejects(owner.command('adopt_contained', { sourceRelativeLocator: 'canonical/A.md', sourceRoot: storeRoot }));
  } finally {
    await owner.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
