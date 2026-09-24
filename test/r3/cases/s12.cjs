'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SourceLedgerStore } = require('../../../src/main/source-ledger-store');
const { SQLiteKeywordIndex } = require('../../../src/main/search-sqlite-store');
const { publishSave, readPendingSave } = require('../../../src/main/index-ingress-store');
const { createBasicKeywordTokenizer } = require('../../../src/main/search-tokenizer');
const { OwnerWorkerController } = require('../../../src/main/search-owner-controller');
const { deriveValidatedDocument } = require('../../../src/main/derived-document-indexer');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function waitForCompletedJob(owner, jobId) {
  if (owner.getStatus().jobId === jobId && owner.getStatus().phase === 'completed') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { owner.worker.off('message', onMessage); reject(new Error('document completion marker missing')); }, 10000);
    function onMessage(message) {
      if (message.tag !== 'STATUS' || message.snapshot?.jobId !== jobId
        || message.snapshot.phase !== 'completed') return;
      clearTimeout(timer);
      owner.worker.off('message', onMessage);
      resolve();
    }
    owner.worker.on('message', onMessage);
  });
}

// @req FR-DOC-019 REL-DOC-004 DR-DOC-007 DR-DOC-008 DR-DOC-014
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
  const body = '---\ntitle: User title\ncategory: research\ndocumentTags: [한글, English]\n---\n# Heading\n한국어 alpha [link](other.md)\n```js\nconst value = 1;\n```\n';
  try {
    const save = async (content, locator = 'doc.md', userMetadata = {
      title: 'User title', category: 'research', documentTags: ['한글', 'English']
    }) => {
      const bytes = Buffer.from(content);
      const published = await publishSave({ storeRoot, ingressRoot,
      sourceRelativeLocator: locator, operation: 'update', sourceId: 'source_fixture',
      rootFingerprint: sha(storeRoot), contentBytes: bytes, contentHash: sha(bytes),
      provenance: { aliases: [], metadata: userMetadata } });
      const intent = readPendingSave({ ingressRoot, storeRoot, intentId: published.intentId });
      return ledger.acceptSaveIntent({ current: intent, storeRoot,
        finalMetadata: userMetadata,
        contentByteLength: bytes.length, contentTextLength: content.length });
    };
    const accepted = await save(body);
    ledger.upsertDocumentSourceAlias({ documentId: accepted.documentId,
      canonicalPathHash: sha('existing-original-alias'), aliasKind: 'opened_path' });
    const originalMetadata = ledger.open().prepare('SELECT metadata_json FROM documents WHERE document_id = ?')
      .get(accepted.documentId).metadata_json;
    const claim = ledger.claimDesiredJob({ documentId: accepted.documentId, desiredRevision: accepted.desiredRevision });
    if (typeof deriveValidatedDocument === 'function') {
      await deriveValidatedDocument({ ledger, keyword, claim, storeRoot,
        validated: { documentId: claim.documentId, revision: claim.requestedRevision,
          hash: claim.desiredContentHash, content: body } });
    }
    const row = ledger.open().prepare('SELECT * FROM documents WHERE document_id = ?').get(accepted.documentId);
    const chunks = ledger.open().prepare('SELECT * FROM chunks WHERE document_id = ?').all(accepted.documentId);
    const links = ledger.open().prepare('SELECT * FROM links WHERE from_document_id = ?').all(accepted.documentId);
    context.assert(row.category === 'research' && JSON.parse(row.document_tags_json).includes('English')
      && chunks.length > 0 && links.length === 1 && row.keyword_dirty === 0,
    'validated document atomically derives metadata, chunks, links and keyword cache');
    context.assert(keyword.search('alpha').length > 0
      && keyword.search('alpha', { category: 'research', documentTags: ['English'] }).length > 0,
    'explicit category and tags participate in keyword search');
    const otherFile = path.join(storeRoot, 'other.md');
    keyword.replaceDocument({ filePath: otherFile, contentHash: 'sha256:other', revision: 1,
      meta: { title: 'Other', project: null, docName: null, docType: 'note', category: 'general',
        documentTags: [], description: null, date: null, gitBranch: null, gitLastCommit: null,
        snippet: null }, segments: [{ ordinal: 0, searchText: 'untouchedneedle', textHash: 'other' }] });
    ledger.completeClaimedJob({ claim, actualFileHash: claim.desiredContentHash });
    const changed = body.replace('alpha', 'beta');
    const second = await save(changed);
    const secondClaim = ledger.claimDesiredJob({ documentId: second.documentId,
      desiredRevision: second.desiredRevision });
    const stale = await deriveValidatedDocument({ ledger, keyword, claim, storeRoot,
      validated: { documentId: claim.documentId, revision: claim.requestedRevision,
        hash: claim.desiredContentHash, content: body } });
    context.assert(stale === false && keyword.search('alpha').length > 0,
      'old revision cannot replace current derivative state');
    const next = { documentId: secondClaim.documentId, revision: secondClaim.requestedRevision,
      hash: secondClaim.desiredContentHash, content: changed };
    try {
      await deriveValidatedDocument({ ledger, keyword, claim: secondClaim, storeRoot,
        validated: next, faults: { beforeLedgerCommitEnd: () => { throw new Error('ledger fault'); } } });
    } catch (error) { context.assert(error.message === 'ledger fault', 'ledger fault injected'); }
    context.assert(keyword.search('alpha').length > 0 && keyword.search('beta').length === 0
      && ledger.open().prepare('SELECT search_text FROM chunk_search_content WHERE document_id = ? LIMIT 1')
        .get(second.documentId).search_text.includes('alpha'),
    'ledger transaction rollback leaves prior chunks and FTS visible');
    try {
      await deriveValidatedDocument({ ledger, keyword, claim: secondClaim, storeRoot,
        validated: next, faults: { beforeKeywordCommit: () => { throw new Error('keyword fault'); } } });
    } catch (error) { context.assert(error.message === 'keyword fault', 'keyword fault injected'); }
    context.assert(keyword.search('alpha').length > 0 && keyword.search('beta').length === 0
      && ledger.open().prepare('SELECT keyword_dirty FROM documents WHERE document_id = ?')
        .get(second.documentId).keyword_dirty === 1,
    'keyword transaction rollback keeps old FTS and durable dirty retry marker');
    await deriveValidatedDocument({ ledger, keyword, claim: secondClaim, storeRoot, validated: next });
    const betaCount = keyword.search('beta').length;
    const alphaCount = keyword.open().prepare('SELECT count(*) AS n FROM keyword_fts WHERE keyword_fts MATCH ?')
      .get('"alpha"').n;
    const keywordDirty = ledger.open().prepare('SELECT keyword_dirty FROM documents WHERE document_id = ?')
      .get(second.documentId).keyword_dirty;
    context.assert(betaCount > 0 && alphaCount === 0 && keywordDirty === 0,
    `retry replaces old FTS rows and clears dirty for current revision beta=${betaCount} alpha=${alphaCount} dirty=${keywordDirty}`);
    context.assert(keyword.open().prepare('SELECT count(*) AS n FROM keyword_fts WHERE keyword_fts MATCH ?')
      .get('"untouchedneedle"').n === 1,
    'document replace preserves another document keyword row');
    const preserved = ledger.open().prepare('SELECT metadata_json FROM documents WHERE document_id = ?')
      .get(accepted.documentId).metadata_json;
    context.assert(preserved === originalMetadata && ledger.open().prepare(
      'SELECT count(*) AS n FROM document_source_aliases WHERE document_id = ?').get(accepted.documentId).n === 1,
    'derivative failures and retry preserve user metadata and original alias');
    ledger.completeClaimedJob({ claim: secondClaim, actualFileHash: secondClaim.desiredContentHash });
    const malformedUpdate = await save('---\ncategory: {bad: true}\ndocumentTags:\n  - {bad: true}\n---\n# Updated\n',
      'doc.md', { category: '{bad: true}', documentTags: ['{bad: true}'] });
    const malformedUpdateClaim = ledger.claimDesiredJob({ documentId: malformedUpdate.documentId,
      desiredRevision: malformedUpdate.desiredRevision });
    await deriveValidatedDocument({ ledger, keyword, claim: malformedUpdateClaim, storeRoot,
      validated: { documentId: malformedUpdate.documentId,
        revision: malformedUpdateClaim.requestedRevision,
        hash: malformedUpdateClaim.desiredContentHash,
        content: '---\ncategory: {bad: true}\ndocumentTags:\n  - {bad: true}\n---\n# Updated\n' } });
    const afterMalformedUpdate = ledger.open().prepare('SELECT * FROM documents WHERE document_id = ?')
      .get(accepted.documentId);
    context.assert(afterMalformedUpdate.category === 'research'
      && JSON.parse(afterMalformedUpdate.metadata_json).category === 'research'
      && JSON.parse(afterMalformedUpdate.document_tags_json).includes('English')
      && !JSON.parse(afterMalformedUpdate.document_tags_json).includes('{bad: true}'),
    'malformed later category and tags cannot erase or pollute prior valid user metadata');
    ledger.completeClaimedJob({ claim: malformedUpdateClaim,
      actualFileHash: malformedUpdateClaim.desiredContentHash });
    const listShaped = await save('---\ncategory: [bad]\ndocumentTags:\n  - [bad]\n---\n# List shaped\n',
      'doc.md', { category: '[bad]', documentTags: ['[bad]'] });
    const listClaim = ledger.claimDesiredJob({ documentId: listShaped.documentId,
      desiredRevision: listShaped.desiredRevision });
    await deriveValidatedDocument({ ledger, keyword, claim: listClaim, storeRoot,
      validated: { documentId: listClaim.documentId, revision: listClaim.requestedRevision,
        hash: listClaim.desiredContentHash,
        content: '---\ncategory: [bad]\ndocumentTags:\n  - [bad]\n---\n# List shaped\n' } });
    const listRow = ledger.open().prepare('SELECT * FROM documents WHERE document_id = ?')
      .get(accepted.documentId);
    context.assert(listRow.category === 'research'
      && JSON.parse(listRow.metadata_json).category === 'research'
      && JSON.parse(listRow.document_tags_json).includes('English')
      && !JSON.parse(listRow.document_tags_json).includes('[bad]'),
    'list-shaped malformed category and tag cannot erase or pollute prior valid metadata');
    const malformed = await save('---\ncategory: {bad: true}\ndocumentTags: {bad: true}\n---\n# Malformed\n',
      'malformed.md', {});
    const malformedClaim = ledger.claimDesiredJob({ documentId: malformed.documentId,
      desiredRevision: malformed.desiredRevision });
    await deriveValidatedDocument({ ledger, keyword, claim: malformedClaim, storeRoot,
      validated: { documentId: malformed.documentId, revision: malformedClaim.requestedRevision,
        hash: malformedClaim.desiredContentHash,
        content: '---\ncategory: {bad: true}\ndocumentTags: {bad: true}\n---\n# Malformed\n' } });
    const malformedRow = ledger.open().prepare('SELECT * FROM documents WHERE document_id = ?')
      .get(malformed.documentId);
    context.assert(malformedRow.category === 'general' && malformedRow.metadata_parse_status === 'diagnostic',
    'invalid category and tags use fallback and retain parse diagnostics');
    const inline = await save('---\ndocumentTags: [alpha, beta]\n---\n# Inline tags\n',
      'inline.md', {});
    const inlineClaim = ledger.claimDesiredJob({ documentId: inline.documentId,
      desiredRevision: inline.desiredRevision });
    await deriveValidatedDocument({ ledger, keyword, claim: inlineClaim, storeRoot,
      validated: { documentId: inlineClaim.documentId, revision: inlineClaim.requestedRevision,
        hash: inlineClaim.desiredContentHash,
        content: '---\ndocumentTags: [alpha, beta]\n---\n# Inline tags\n' } });
    const inlineRow = ledger.open().prepare('SELECT * FROM documents WHERE document_id = ?')
      .get(inline.documentId);
    context.assert(JSON.stringify(JSON.parse(inlineRow.document_tags_json)) === JSON.stringify(['alpha', 'beta'])
      && inlineRow.metadata_parse_status === 'ok',
    'valid inline YAML tag list normalizes without separate accepted metadata');
    const nested = await save('---\ndocumentTags: [alpha, [bad, nested], beta]\n---\n# Nested tags\n',
      'nested.md', {});
    const nestedClaim = ledger.claimDesiredJob({ documentId: nested.documentId,
      desiredRevision: nested.desiredRevision });
    await deriveValidatedDocument({ ledger, keyword, claim: nestedClaim, storeRoot,
      validated: { documentId: nestedClaim.documentId, revision: nestedClaim.requestedRevision,
        hash: nestedClaim.desiredContentHash,
        content: '---\ndocumentTags: [alpha, [bad, nested], beta]\n---\n# Nested tags\n' } });
    const nestedRow = ledger.open().prepare('SELECT * FROM documents WHERE document_id = ?')
      .get(nested.documentId);
    const objectList = await save('---\ndocumentTags: [alpha, {bad: true, other: false}, beta]\n---\n# Object tags\n',
      'object-list.md', {});
    const objectClaim = ledger.claimDesiredJob({ documentId: objectList.documentId,
      desiredRevision: objectList.desiredRevision });
    await deriveValidatedDocument({ ledger, keyword, claim: objectClaim, storeRoot,
      validated: { documentId: objectClaim.documentId, revision: objectClaim.requestedRevision,
        hash: objectClaim.desiredContentHash,
        content: '---\ndocumentTags: [alpha, {bad: true, other: false}, beta]\n---\n# Object tags\n' } });
    const objectRow = ledger.open().prepare('SELECT * FROM documents WHERE document_id = ?')
      .get(objectList.documentId);
    context.assert(JSON.parse(objectRow.document_tags_json).length === 0
      && objectRow.metadata_parse_status === 'diagnostic',
    'malformed inline object list indexes no fragment tags and records a diagnostic');
    context.assert(JSON.parse(nestedRow.document_tags_json).length === 0
      && nestedRow.metadata_parse_status === 'diagnostic',
    'malformed nested inline list indexes no fragment tags and records a diagnostic');
  } finally { keyword.close(); ledger.close(); }
  const ownerRoot = path.join(root, 'owner');
  const ownerStore = path.join(ownerRoot, 'store');
  const ownerIngress = path.join(ownerRoot, 'private');
  fs.mkdirSync(ownerStore, { recursive: true });
  fs.mkdirSync(ownerIngress);
  const owner = new OwnerWorkerController({ ledgerPath: path.join(ownerRoot, 'ledger.sqlite'),
    keywordPath: path.join(ownerRoot, 'keyword.sqlite'), sourceRoot: ownerStore,
    ingressRoot: ownerIngress, keywordTokenizerProvider: 'basic', deriveDocuments: true });
  const ownerBody = Buffer.from('# Owner\nowneruniqueterm [link](missing.md)\n');
  try {
    await owner.start();
    const saved = await publishSave({ storeRoot: ownerStore, ingressRoot: ownerIngress,
      sourceRelativeLocator: 'owner.md', operation: 'update', sourceId: 'owner_source',
      rootFingerprint: sha(ownerStore), contentBytes: ownerBody, contentHash: sha(ownerBody),
      provenance: { aliases: [], metadata: { category: 'research', documentTags: ['owner'] } } });
    const response = await owner.acceptPublishedSave({ ingressRoot: ownerIngress,
      intentId: saved.intentId, storeRoot: ownerStore });
    context.assert(response.accepted === true && response.indexingState === 'queued',
      'private owner accepts saved document before background derivation');
    let hits = [];
    for (let i = 0; i < 30; i += 1) {
      hits = await owner.query('query_keyword', { query: 'owneruniqueterm' });
      if (hits.length) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    context.assert(hits.length > 0, 'owner drains internal work item into searchable keyword cache');
  } finally { await owner.shutdown(); }
  const finished = new SourceLedgerStore({ dbPath: path.join(ownerRoot, 'ledger.sqlite') });
  try {
    const row = finished.open().prepare("SELECT * FROM documents WHERE relative_path = 'owner.md'").get();
    context.assert(row.completed_revision === row.desired_revision && row.keyword_dirty === 0
      && finished.open().prepare('SELECT count(*) AS n FROM links WHERE from_document_id = ?')
        .get(row.document_id).n === 1,
    'owner completion records same revision, clean keyword marker and link');
  } finally { finished.close(); }

  const mismatchRoot = path.join(root, 'mismatch');
  const oldStore = path.join(mismatchRoot, 'old-store');
  const newStore = path.join(mismatchRoot, 'new-store');
  const newIngress = path.join(mismatchRoot, 'private');
  fs.mkdirSync(oldStore, { recursive: true });
  fs.mkdirSync(newStore);
  fs.mkdirSync(newIngress);
  const mismatchKeywordPath = path.join(mismatchRoot, 'keyword.sqlite');
  const oldKeyword = new SQLiteKeywordIndex({ dbPath: mismatchKeywordPath, sourceRoot: oldStore,
    tokenizer: createBasicKeywordTokenizer() });
  oldKeyword.replaceDocument({ filePath: path.join(oldStore, 'old.md'),
    contentHash: 'sha256:old', revision: 1,
    meta: { title: 'Old', project: null, docName: null, docType: 'note', category: 'general',
      documentTags: [], description: null, date: null, gitBranch: null, gitLastCommit: null,
      snippet: null }, segments: [{ ordinal: 0, searchText: 'oldrootmarker', textHash: 'old' }] });
  oldKeyword.close();
  const mismatched = new OwnerWorkerController({ ledgerPath: path.join(mismatchRoot, 'ledger.sqlite'),
    keywordPath: mismatchKeywordPath, sourceRoot: newStore, ingressRoot: newIngress,
    keywordTokenizerProvider: 'basic', deriveDocuments: true });
  try {
    await mismatched.start();
    context.assert(mismatched.getStatus().diagnostic?.code === 'keyword_source_mismatch',
      'owner detects existing keyword cache source mismatch');
    const bytes = Buffer.from('# New\nnewrootmarker\n');
    const published = await publishSave({ storeRoot: newStore, ingressRoot: newIngress,
      sourceRelativeLocator: 'new.md', operation: 'update', sourceId: 'new_source',
      rootFingerprint: sha(newStore), contentBytes: bytes, contentHash: sha(bytes),
      provenance: { aliases: [], metadata: {} } });
    const accepted = await mismatched.acceptPublishedSave({ ingressRoot: newIngress,
      intentId: published.intentId, storeRoot: newStore });
    context.assert(accepted.accepted === true, 'mismatch still accepts the saved document');
    await waitForCompletedJob(mismatched, accepted.indexing.jobId);
    context.assert(mismatched.getStatus().diagnostic?.code === 'keyword_source_mismatch'
      && (await mismatched.query('query_keyword', { query: 'oldrootmarker' })).length === 0,
    'new save cannot make incompatible old-root keyword rows queryable');
  } finally { await mismatched.shutdown(); }
  const inspected = new SQLiteKeywordIndex({ dbPath: mismatchKeywordPath, sourceRoot: oldStore,
    tokenizer: createBasicKeywordTokenizer() });
  try {
    const metaRoot = inspected.loadIndexMetadata().source_root;
    const docCount = inspected.open().prepare('SELECT count(*) AS n FROM keyword_documents').get().n;
    context.assert(metaRoot === path.resolve(oldStore).toLowerCase() && docCount === 1,
    'mismatch preserves committed old-root cache without incremental adoption');
  } finally { inspected.close(); }
  const mismatchLedger = new SourceLedgerStore({ dbPath: path.join(mismatchRoot, 'ledger.sqlite') });
  try {
    const row = mismatchLedger.open().prepare("SELECT * FROM documents WHERE relative_path = 'new.md'").get();
    context.assert(row.completed_revision === row.desired_revision && row.keyword_dirty === 1,
      'incompatible cache leaves durable keyword dirty while ledger derivation completes');
  } finally { mismatchLedger.close(); }

  const tokenIngress = path.join(mismatchRoot, 'token-private');
  fs.mkdirSync(tokenIngress);
  const tokenCache = new SQLiteKeywordIndex({ dbPath: mismatchKeywordPath, sourceRoot: oldStore,
    tokenizer: createBasicKeywordTokenizer() });
  tokenCache.open().prepare("UPDATE keyword_index_meta SET value = 'incompatible-tokenizer' WHERE key = 'tokenizer_provider'").run();
  tokenCache.close();
  const tokenOwner = new OwnerWorkerController({ ledgerPath: path.join(mismatchRoot, 'token-ledger.sqlite'),
    keywordPath: mismatchKeywordPath, sourceRoot: oldStore, ingressRoot: tokenIngress,
    keywordTokenizerProvider: 'basic', deriveDocuments: true });
  try {
    await tokenOwner.start();
    context.assert(tokenOwner.getStatus().diagnostic?.code === 'keyword_tokenizer_mismatch',
      'owner detects existing keyword cache tokenizer mismatch');
    const bytes = Buffer.from('# Token\ntokennewmarker\n');
    const published = await publishSave({ storeRoot: oldStore, ingressRoot: tokenIngress,
      sourceRelativeLocator: 'token-new.md', operation: 'update', sourceId: 'token_source',
      rootFingerprint: sha(oldStore), contentBytes: bytes, contentHash: sha(bytes),
      provenance: { aliases: [], metadata: {} } });
    const tokenAccepted = await tokenOwner.acceptPublishedSave({ ingressRoot: tokenIngress, intentId: published.intentId,
      storeRoot: oldStore });
    await waitForCompletedJob(tokenOwner, tokenAccepted.indexing.jobId);
    context.assert(tokenOwner.getStatus().diagnostic?.code === 'keyword_tokenizer_mismatch'
      && (await tokenOwner.query('query_keyword', { query: 'oldrootmarker' })).length === 0,
    'new save cannot expose incompatible tokenizer cache');
  } finally { await tokenOwner.shutdown(); }
  const afterToken = new SQLiteKeywordIndex({ dbPath: mismatchKeywordPath, sourceRoot: oldStore,
    tokenizer: createBasicKeywordTokenizer() });
  try {
    context.assert(afterToken.loadIndexMetadata().tokenizer_provider === 'incompatible-tokenizer'
      && afterToken.open().prepare('SELECT count(*) AS n FROM keyword_documents').get().n === 1,
    'tokenizer mismatch keeps committed cache intact until explicit rebuild');
  } finally { afterToken.close(); }

  const aheadRoot = path.join(root, 'ahead');
  const aheadStore = path.join(aheadRoot, 'store');
  const aheadIngress = path.join(aheadRoot, 'private');
  fs.mkdirSync(aheadStore, { recursive: true });
  fs.mkdirSync(aheadIngress);
  const aheadLedger = new SourceLedgerStore({ dbPath: path.join(aheadRoot, 'ledger.sqlite') });
  const aheadKeyword = new SQLiteKeywordIndex({ dbPath: path.join(aheadRoot, 'keyword.sqlite'),
    sourceRoot: aheadStore, tokenizer: createBasicKeywordTokenizer() });
  aheadLedger.initialize();
  try {
    const bytes = Buffer.from('# Current\nauthoritativemarker\n');
    const published = await publishSave({ storeRoot: aheadStore, ingressRoot: aheadIngress,
      sourceRelativeLocator: 'current.md', operation: 'update', sourceId: 'ahead_source',
      rootFingerprint: sha(aheadStore), contentBytes: bytes, contentHash: sha(bytes),
      provenance: { aliases: [], metadata: {} } });
    const intent = readPendingSave({ ingressRoot: aheadIngress, storeRoot: aheadStore,
      intentId: published.intentId });
    const accepted = aheadLedger.acceptSaveIntent({ current: intent, storeRoot: aheadStore,
      finalMetadata: {}, contentByteLength: bytes.length, contentTextLength: bytes.toString().length });
    const claim = aheadLedger.claimDesiredJob({ documentId: accepted.documentId,
      desiredRevision: accepted.desiredRevision });
    aheadKeyword.replaceDocument({ filePath: path.join(aheadStore, 'current.md'),
      contentHash: 'sha256:cache-ahead', revision: 2,
      meta: { title: 'Ahead', project: null, docName: null, docType: 'note', category: 'general',
        documentTags: [], description: null, date: null, gitBranch: null, gitLastCommit: null,
        snippet: null }, segments: [{ ordinal: 0, searchText: 'cacheaheadmarker', textHash: 'ahead' }] });
    await deriveValidatedDocument({ ledger: aheadLedger, keyword: aheadKeyword, claim,
      storeRoot: aheadStore, validated: { documentId: claim.documentId,
        revision: claim.requestedRevision, hash: claim.desiredContentHash,
        content: bytes.toString() } });
    const cached = aheadKeyword.open().prepare('SELECT source_revision, content_hash FROM keyword_documents WHERE file_path = ?')
      .get(path.join(aheadStore, 'current.md'));
    context.assert(cached.source_revision === 1 && cached.content_hash === claim.desiredContentHash
      && aheadLedger.open().prepare('SELECT keyword_dirty FROM documents WHERE document_id = ?')
        .get(claim.documentId).keyword_dirty === 0,
    'authoritative ledger revision replaces derivative cache revision ahead of it');
  } finally { aheadKeyword.close(); aheadLedger.close(); }
} };
