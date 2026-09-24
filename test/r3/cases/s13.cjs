'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SourceLedgerStore } = require('../../../src/main/source-ledger-store');
const { SQLiteKeywordIndex } = require('../../../src/main/search-sqlite-store');
const { createBasicKeywordTokenizer } = require('../../../src/main/search-tokenizer');
const { publishSave, readPendingSave } = require('../../../src/main/index-ingress-store');
const { deriveValidatedDocument } = require('../../../src/main/derived-document-indexer');
const { SearchEngine } = require('../../../src/main/search-engine');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');

// @req DR-DOC-013 CON-DOC-006 FR-TREE-009 FR-DOC-025 FR-DOC-019
module.exports = { async run(context) {
  const root = context.fixture.root;
  const storeRoot = path.join(root, 'store');
  const ingressRoot = path.join(root, 'private');
  fs.mkdirSync(storeRoot);
  fs.mkdirSync(ingressRoot);
  const ledger = new SourceLedgerStore({ dbPath: path.join(root, 'ledger.sqlite') });
  const keyword = new SQLiteKeywordIndex({ dbPath: path.join(root, 'keyword.sqlite'),
    sourceRoot: storeRoot, tokenizer: createBasicKeywordTokenizer() });
  ledger.initialize();
  keyword.open();
  const save = async (locator, content) => {
    const bytes = Buffer.from(content);
    const published = await publishSave({ storeRoot, ingressRoot,
      sourceRelativeLocator: locator, operation: 'update', sourceId: 's13_source',
      rootFingerprint: sha(storeRoot), contentBytes: bytes, contentHash: sha(bytes),
      provenance: { aliases: [], metadata: {} } });
    const intent = readPendingSave({ ingressRoot, storeRoot, intentId: published.intentId });
    return ledger.acceptSaveIntent({ current: intent, storeRoot, finalMetadata: {},
      contentByteLength: bytes.length, contentTextLength: content.length });
  };
  const derive = async (accepted, content) => {
    const claim = ledger.claimDesiredJob({ documentId: accepted.documentId,
      desiredRevision: accepted.desiredRevision });
    context.assert(Boolean(claim), 'current document job is claimable');
    await deriveValidatedDocument({ ledger, keyword, claim, storeRoot,
      validated: { documentId: claim.documentId, revision: claim.requestedRevision,
        hash: claim.desiredContentHash, content } });
    ledger.completeClaimedJob({ claim, actualFileHash: claim.desiredContentHash });
  };
  const drainLinks = () => {
    let resolved = 0;
    let stale = 0;
    let page;
    for (let i = 0; i < 10; i += 1) {
      page = ledger.reconcilePendingLinkTargets();
      resolved += page.counts.resolved;
      stale += page.counts.stale;
      if (!page.hasMore) break;
    }
    return { resolved, stale, hasMore: page.hasMore };
  };
  try {
    const source = await save('a.md', '# A\n[Target](b.md)\n');
    await derive(source, '# A\n[Target](b.md)\n');
    const before = ledger.getLinkDiagnostics({ documentId: source.documentId });
    context.assert(before.counts.missing === 1 && before.counts.resolved === 0,
      'source revision records missing target in SQLite');
    const target = await save('b.md', '# B\n');
    await derive(target, '# B\n');
    const reconciled = drainLinks();
    context.assert(reconciled.resolved === 1 && !reconciled.hasMore,
      'background target work reconciles the pending source edge');
    const after = ledger.getLinkDiagnostics({ documentId: source.documentId });
    context.assert(after.counts.resolved === 1 && after.edges[0].toDocumentId === target.documentId,
      'target addition reconciles source edge after background indexing');
    context.assert(JSON.stringify(after).includes('b.md') === false
      && JSON.stringify(after).includes(storeRoot) === false,
    'public diagnostics do not disclose raw href or absolute store root');
    context.assert(JSON.stringify(ledger.getResolvedLinkFilterDocumentIds({ linkedTo: target.documentId }))
      === JSON.stringify([source.documentId]), 'resolved target participates in linkedTo filter');
    ledger.upsertDocument({ documentId: target.documentId, sourceId: 's13_source',
      sourceRelativePath: 'b.md', pathStatus: 'deleted', contentHash: `sha256:${sha('# B\n')}` });
    context.assert(ledger.getResolvedLinkFilterDocumentIds({ linkedTo: target.documentId }).length === 0,
      'read-only linkedTo filter excludes inactive targets even before reconciliation');
    const removed = drainLinks();
    const stale = ledger.getLinkDiagnostics({ documentId: source.documentId });
    context.assert(removed.stale === 1 && stale.counts.stale === 1
      && stale.edges[0].toDocumentId === null,
    'target tombstone converges resolved edge to stale diagnostic without target identity');
    const statuses = Object.keys(stale.counts);
    context.assert(JSON.stringify(statuses) === JSON.stringify([
      'resolved', 'missing', 'external', 'path_policy_violation', 'skipped', 'ambiguous', 'stale'
    ]), 'diagnostic counts expose exactly the seven canonical statuses');
    const oldRevision = await save('a.md', '# A\n[Old](old.md)\n');
    const oldClaim = ledger.claimDesiredJob({ documentId: oldRevision.documentId,
      desiredRevision: oldRevision.desiredRevision });
    context.assert(Boolean(oldClaim), 'older source revision is claimable before superseding save');
    const latest = await save('a.md', '# A latest with zero links\n');
    const oldApplied = await deriveValidatedDocument({ ledger, keyword, claim: oldClaim, storeRoot,
      validated: { documentId: oldClaim.documentId, revision: oldClaim.requestedRevision,
        hash: oldClaim.desiredContentHash, content: '# A\n[Old](old.md)\n' } });
    context.assert(oldApplied === false, 'stale source completion cannot replace latest edge set');
    ledger.completeClaimedJob({ claim: oldClaim, actualFileHash: oldClaim.desiredContentHash });
    await derive(latest, '# A latest with zero links\n');
    context.assert(ledger.getLinkDiagnostics({ documentId: source.documentId }).edges.length === 0,
      'latest zero-link revision atomically removes the old edge set');
    const changesBeforeRead = ledger.open().prepare('SELECT total_changes() AS n').get().n;
    ledger.getResolvedLinkFilterDocumentIds({ linkedTo: target.documentId, linkedFrom: source.documentId });
    context.assert(ledger.open().prepare('SELECT total_changes() AS n').get().n === changesBeforeRead,
      'resolved link lookup is read-only');
    const search = Object.create(SearchEngine.prototype);
    search.indexDataDir = root;
    search._getAvailableSourceLedger = () => null;
    const unavailable = search.getSmartSearchResolvedLinkFilter({ linkedTo: target.documentId });
    context.assert(unavailable.documentIds.size === 0 && unavailable.filePaths.length === 0,
      'unavailable ledger fails closed for requested linked filter');
    drainLinks();
    for (let ordinal = 0; ordinal < 130; ordinal += 1) {
      ledger.recordLinkEdge({ fromDocumentId: source.documentId, ordinal,
        originalHref: 'b.md', normalizedHref: 'b.md', status: 'missing',
        diagnosticCode: 'target_missing' });
    }
    ledger.recordLinkEdge({ fromDocumentId: source.documentId, ordinal: 130,
      originalHref: 'b.md', normalizedHref: 'b.md', status: 'ambiguous',
      diagnosticCode: 'multiple_active_targets' });
    ledger.upsertDocument({ documentId: target.documentId, sourceId: 's13_source',
      sourceRelativePath: 'b.md', pathStatus: 'active', contentHash: `sha256:${sha('# B\n')}` });
    const firstBatch = ledger.reconcilePendingLinkTargets();
    context.assert(firstBatch.counts.resolved <= 64 && firstBatch.hasMore,
      'popular target reconciliation bounds one SQLite transaction by edge count');
    let totalResolved = firstBatch.counts.resolved;
    let page = firstBatch;
    for (let i = 0; i < 5 && page.hasMore; i += 1) {
      page = ledger.reconcilePendingLinkTargets();
      totalResolved += page.counts.resolved;
    }
    context.assert(totalResolved === 130 && page.hasMore === false,
      'bounded target batches eventually resolve every unambiguous edge');
    const ambiguous = ledger.open().prepare('SELECT status, to_document_id FROM links WHERE from_document_id = ? AND ordinal = 130')
      .get(source.documentId);
    context.assert(ambiguous.status === 'ambiguous' && ambiguous.to_document_id === null,
      'ambiguous edge stays unresolved without unique stable identity evidence');
    const legacyDir = path.join(root, 'legacy');
    fs.mkdirSync(legacyDir);
    const legacyPath = path.join(legacyDir, 'smart-search.sqlite3');
    const legacy = new SourceLedgerStore({ dbPath: legacyPath });
    legacy.initialize();
    legacy.close();
    const Database = require('better-sqlite3');
    const raw = new Database(legacyPath);
    raw.exec('DROP TABLE link_reconcile_queue; DROP INDEX idx_links_reconcile_target');
    raw.close();
    const firstRead = Object.create(SearchEngine.prototype);
    firstRead.indexDataDir = legacyDir;
    firstRead._sourceLedger = null;
    firstRead._getSourceRoot = () => storeRoot;
    firstRead.getSmartSearchResolvedLinkFilter({ linkedTo: target.documentId });
    firstRead.getSmartSearchDocumentIdentityForCandidate({ documentId: 'missing-id' });
    const readBack = new Database(legacyPath, { readonly: true, fileMustExist: true });
    const created = readBack.prepare(`SELECT count(*) AS n FROM sqlite_master
      WHERE name IN ('link_reconcile_queue', 'idx_links_reconcile_target')`).get().n;
    readBack.close();
    firstRead._sourceLedger?.close();
    context.assert(created === 0,
      'first linked smart-search candidate and filter read do not migrate an older ledger schema');
  } finally { keyword.close(); ledger.close(); }
} };
