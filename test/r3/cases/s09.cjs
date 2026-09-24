'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { publishSave } = require('../../../src/main/index-ingress-store');
const { OwnerWorkerController } = require('../../../src/main/search-owner-controller');
const { SourceLedgerStore } = require('../../../src/main/source-ledger-store');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const pathHash = value => sha(process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
function forceIntentTime(ingressRoot, intentId, createdTime) {
  const file = path.join(ingressRoot, `${intentId}.intent.json`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.createdTime = createdTime;
  delete record.publicationOrder;
  const { checksum, ...fields } = record;
  record.checksum = sha(Buffer.from(JSON.stringify(fields), 'utf8'));
  fs.writeFileSync(file, JSON.stringify(record));
}
function legacyIntentId(ingressRoot, intentId) {
  const oldPath = path.join(ingressRoot, `${intentId}.intent.json`);
  const record = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
  const identity = { operation: record.operation, sourceId: record.sourceId,
    rootFingerprint: record.rootFingerprint, sourceRelativeLocator: record.sourceRelativeLocator,
    contentHash: record.contentHash, provenance: record.provenance };
  record.intentId = sha(Buffer.from(JSON.stringify(identity), 'utf8'));
  const { checksum, ...fields } = record;
  record.checksum = sha(Buffer.from(JSON.stringify(fields), 'utf8'));
  fs.renameSync(oldPath, path.join(ingressRoot, `${record.intentId}.intent.json`));
  fs.writeFileSync(path.join(ingressRoot, `${record.intentId}.intent.json`), JSON.stringify(record));
  return record.intentId;
}

// @req FR-DOC-019 REL-DOC-009 DR-DOC-014 IR-APP-013
module.exports = { async run(context) {
  const root = context.fixture.root;
  const storeRoot = path.join(root, 'store');
  const ingressRoot = path.join(root, 'private');
  const ledgerPath = path.join(root, 'ledger.sqlite');
  const keywordPath = path.join(root, 'keyword.sqlite');
  fs.mkdirSync(storeRoot);
  fs.mkdirSync(ingressRoot);
  const finalPath = path.join(storeRoot, 'same.md');
  const oldBytes = Buffer.from('---\ntitle: First title\nproject: P\ndocType: note\n---\n# First\n');
  const newBytes = Buffer.from('---\ntitle: Second title\n---\n# Second\n');
  const oldOrigin = path.join(root, 'origin', 'old.md');
  const newOrigin = path.join(root, 'origin', 'new.md');
  const base = { storeRoot, ingressRoot, sourceRelativeLocator: 'same.md', operation: 'update',
    sourceId: 'source_fixture', rootFingerprint: sha(storeRoot) };
  const old = await publishSave({ ...base, contentBytes: oldBytes, contentHash: sha(oldBytes),
    provenance: { aliases: [{ lexicalOriginalPath: oldOrigin, canonicalOriginalPath: oldOrigin,
      canonicalPathHash: pathHash(oldOrigin) }], metadata: { category: 'manual', documentTags: ['old-tag'], description: 'original description', project: 'P', docType: 'note' } } });
  const newer = await publishSave({ ...base, contentBytes: newBytes, contentHash: sha(newBytes),
    provenance: { aliases: [{ lexicalOriginalPath: newOrigin, canonicalOriginalPath: newOrigin,
      canonicalPathHash: pathHash(newOrigin) }], metadata: { documentTags: ['new-tag'] } } });
  context.assert(fs.readFileSync(finalPath).equals(newBytes), 'newer final bytes published before owner accept');
  const seed = new SourceLedgerStore({ dbPath: ledgerPath });
  seed.initialize();
  const source = seed.recordSource({ sourceId: base.sourceId, rootPathInternal: storeRoot,
    rootFingerprint: base.rootFingerprint, displayName: 'Existing source', includeGlobs: ['*.md'] });
  const prior = seed.upsertDocument({ sourceId: source.sourceId, sourceRelativePath: 'same.md',
    canonicalPathInternal: finalPath, category: 'retained', documentTags: ['existing-tag'],
    classification: { label: 'reviewed' }, sourceMtimeOrRevision: 'original-revision',
    lastImportJobId: null });
  seed.open().prepare('UPDATE documents SET metadata_json = ? WHERE document_id = ?')
    .run(JSON.stringify({ category: 'retained', documentTags: ['existing-tag'], docName: 'Existing name' }), prior.documentId);
  seed.open().exec("CREATE TRIGGER s09_fail_job BEFORE INSERT ON index_jobs BEGIN SELECT RAISE(ABORT, 'constraint fault'); END");
  seed.close();
  const owner = new OwnerWorkerController({ ledgerPath, keywordPath, sourceRoot: storeRoot,
    keywordTokenizerProvider: 'basic' });
  const payload = { storeRoot, ingressRoot, intentId: newer.intentId };
  let first;
  try {
    await owner.start();
    const rejected = await owner.command('accept_save', payload).catch(() => ({ saved: true, indexing: { state: 'enqueue_failed' } }));
    context.assert(rejected.saved === true && rejected.accepted === false && rejected.indexing.state === 'enqueue_failed' && !rejected.indexing.jobId,
      'constraint fault maps to saved true without a false queued ACK');
    context.assert(fs.readFileSync(finalPath).equals(newBytes)
      && fs.existsSync(path.join(ingressRoot, `${newer.intentId}.intent.json`)),
    'constraint fault keeps final bytes and private intent');
    const oldBeforeCurrent = await owner.acceptPublishedSave({ ...payload, intentId: old.intentId });
    context.assert(oldBeforeCurrent.accepted === false && !oldBeforeCurrent.indexing.jobId,
      'older unaccepted intent cannot borrow a newer published but unaccepted job');
    const faultDb = new SourceLedgerStore({ dbPath: ledgerPath });
    const beforeRetry = faultDb.open().prepare('SELECT desired_revision, metadata_json FROM documents WHERE document_id = ?').get(prior.documentId);
    context.assert(beforeRetry.desired_revision === 0 && JSON.parse(beforeRetry.metadata_json).docName === 'Existing name'
      && faultDb.open().prepare('SELECT COUNT(*) AS n FROM index_jobs').get().n === 0,
    'failed transaction rolls back metadata, revision, aliases, and job');
    faultDb.open().exec('DROP TRIGGER s09_fail_job');
    faultDb.close();
    const locked = new SourceLedgerStore({ dbPath: ledgerPath });
    locked.open().exec('BEGIN IMMEDIATE');
    try {
      const busy = await owner.acceptPublishedSave(payload);
      context.assert(busy.saved === true && busy.accepted === false && busy.indexing.state === 'enqueue_failed' && !busy.indexing.jobId,
        'database busy keeps saved true and never claims a queued job');
    } finally { locked.open().exec('ROLLBACK'); locked.close(); }
    first = await owner.command('accept_save', payload).catch(() => ({ saved: true, indexing: { state: 'enqueue_failed' } }));
    context.assert(first.saved === true && first.accepted === true && first.indexing.state === 'queued' && first.indexing.jobId,
      'owner ACK follows durable job and metadata transaction');
    const replay = await owner.command('accept_save', payload);
    context.assert(replay.indexing.jobId === first.indexing.jobId && replay.desiredRevision === first.desiredRevision,
      'same intent replays same revision and job ID');
    const historical = await owner.command('accept_save', { ...payload, intentId: old.intentId });
    context.assert(historical.accepted === true && !historical.indexing?.jobId && historical.desiredRevision === null,
      'provenance-only older intent never borrows the current job receipt');
  } finally { await owner.shutdown(); }
  const stopped = await owner.acceptPublishedSave(payload);
  context.assert(stopped.saved === true && stopped.accepted === false && stopped.indexing.state === 'enqueue_failed' && !stopped.indexing.jobId,
    'owner unavailable maps published save to retryable enqueue failure');
  const ledger = new SourceLedgerStore({ dbPath: ledgerPath });
  try {
    const db = ledger.open();
    const doc = db.prepare('SELECT * FROM documents WHERE source_id = ? AND relative_path = ?').get('source_fixture', 'same.md');
    context.assert(doc && doc.document_id === prior.documentId && doc.content_hash === `sha256:${sha(newBytes)}` && doc.desired_revision === 1,
      'one stable current document and revision use new final bytes');
    context.assert(JSON.parse(doc.classification_json).label === 'reviewed', 'existing classification is preserved');
    context.assert(doc.source_mtime_or_revision === 'original-revision', 'existing source revision is preserved');
    context.assert(db.prepare('SELECT display_name FROM sources WHERE source_id = ?').get(source.sourceId).display_name === 'Existing source',
      'existing source display metadata is preserved');
    const metadata = JSON.parse(doc.metadata_json);
    context.assert(metadata.title === 'Second title' && metadata.description === 'original description'
      && metadata.docName === 'Existing name'
      && metadata.category === 'manual' && metadata.project === 'P' && metadata.docType === 'note',
    'frontmatter and both intents retain omitted metadata');
    context.assert(JSON.stringify(JSON.parse(doc.document_tags_json)) === JSON.stringify(['existing-tag', 'old-tag', 'new-tag']),
      'distinct old and new user tags survive reconciliation');
    const aliases = db.prepare('SELECT * FROM document_source_aliases WHERE document_id = ? ORDER BY origin_lexical_path_internal').all(doc.document_id);
    context.assert(aliases.length === 2 && aliases.some(row => row.origin_lexical_path_internal === oldOrigin)
      && aliases.some(row => row.origin_lexical_path_internal === newOrigin), 'both original aliases belong to one document');
    context.assert(db.prepare('SELECT COUNT(*) AS n FROM index_jobs WHERE document_id = ?').get(doc.document_id).n === 1,
      'one current durable index job');
    context.assert(!fs.existsSync(path.join(ingressRoot, `${old.intentId}.intent.json`))
      && !fs.existsSync(path.join(ingressRoot, `${newer.intentId}.intent.json`)),
      'only durably accepted private intents are removed after ACK');
    context.assert(doc.desired_content_hash === `sha256:${sha(newBytes)}` && doc.active_requested_revision === 1
      && doc.dirty === 1 && doc.keyword_dirty === 1 && doc.accepted_intent_id === newer.intentId,
      'initial acceptance atomically records desired hash, requested revision and dirty state');
    const beforeRestart = JSON.stringify({ metadata: doc.metadata_json, tags: doc.document_tags_json,
      aliases: aliases.map(row => [row.alias_id, row.origin_lexical_path_internal, row.origin_path_internal]),
      desiredRevision: doc.desired_revision, jobId: doc.current_job_id });
    ledger.close();
    const restarted = new OwnerWorkerController({ ledgerPath, keywordPath, sourceRoot: storeRoot,
      keywordTokenizerProvider: 'basic' });
    try {
      await restarted.start();
      const acknowledged = await restarted.acceptPublishedSave(payload);
      context.assert(acknowledged.indexing.jobId === first.indexing.jobId && acknowledged.desiredRevision === 1,
        'restart ACK preserves the accepted revision and job');
    } finally { await restarted.shutdown(); }
    const afterDb = ledger.open();
    const after = afterDb.prepare('SELECT * FROM documents WHERE document_id = ?').get(doc.document_id);
    const afterAliases = afterDb.prepare('SELECT * FROM document_source_aliases WHERE document_id = ? ORDER BY origin_lexical_path_internal').all(doc.document_id);
    context.assert(JSON.stringify({ metadata: after.metadata_json, tags: after.document_tags_json,
      aliases: afterAliases.map(row => [row.alias_id, row.origin_lexical_path_internal, row.origin_path_internal]),
      desiredRevision: after.desired_revision, jobId: after.current_job_id }) === beforeRestart,
    'crash replay is byte equivalent for accepted metadata and provenance');
    const latestBytes = Buffer.from('---\ntitle: Third title\n---\n# Third\n');
    const latest = await publishSave({ ...base, contentBytes: latestBytes, contentHash: sha(latestBytes),
      provenance: { aliases: [], metadata: {} } });
    const laterOwner = new OwnerWorkerController({ ledgerPath, keywordPath, sourceRoot: storeRoot,
      keywordTokenizerProvider: 'basic' });
    try {
      await laterOwner.start();
      const latestAck = await laterOwner.acceptPublishedSave({ ...payload, intentId: latest.intentId });
      context.assert(latestAck.desiredRevision === 2 && latestAck.indexing.jobId !== first.indexing.jobId,
        'new same-path intent advances desired revision once');
      const oldReceipt = await laterOwner.acceptPublishedSave(payload);
      context.assert(oldReceipt.desiredRevision === 1 && oldReceipt.indexing.jobId === first.indexing.jobId,
        'accepted A replay after B returns A original receipt, not B current job');
    } finally { await laterOwner.shutdown(); }
    const current = ledger.open().prepare('SELECT * FROM documents WHERE document_id = ?').get(doc.document_id);
    context.assert(current.content_hash === `sha256:${sha(latestBytes)}` && current.desired_revision === 2
      && fs.readFileSync(finalPath).equals(latestBytes), 'later revision uses latest published bytes');
    context.assert(ledger.open().prepare("SELECT COUNT(*) AS n FROM index_jobs WHERE document_id = ? AND status = 'queued'")
      .get(doc.document_id).n === 1, 'only latest pending job stays queued');
    const equalBody = Buffer.from('# Equal body\n');
    const equalBase = { ...base, sourceRelativeLocator: 'equal.md' };
    const equalAliasA = path.join(root, 'origin', 'equal-a.md');
    const equalAliasB = path.join(root, 'origin', 'equal-b.md');
    const equalA = await publishSave({ ...equalBase, contentBytes: equalBody, contentHash: sha(equalBody),
      provenance: { aliases: [{ lexicalOriginalPath: equalAliasA, canonicalOriginalPath: equalAliasA,
        canonicalPathHash: pathHash(equalAliasA) }], metadata: { category: 'old-equal', documentTags: ['equal-a'] } } });
    await new Promise(resolve => setTimeout(resolve, 5));
    const equalB = await publishSave({ ...equalBase, contentBytes: equalBody, contentHash: sha(equalBody),
      provenance: { aliases: [{ lexicalOriginalPath: equalAliasB, canonicalOriginalPath: equalAliasB,
        canonicalPathHash: pathHash(equalAliasB) }], metadata: { documentTags: ['equal-b'] } } });
    const equalOwner = new OwnerWorkerController({ ledgerPath, keywordPath, sourceRoot: storeRoot,
      keywordTokenizerProvider: 'basic' });
    try {
      await equalOwner.start();
      const olderBeforeCurrent = await equalOwner.acceptPublishedSave({ ...payload, intentId: equalA.intentId });
      context.assert(olderBeforeCurrent.accepted === false && !olderBeforeCurrent.indexing.jobId,
        'same-hash older intent cannot become latest while a newer intent awaits acceptance');
      const transient = await equalOwner.acceptPublishedSave({ ...payload, intentId: equalB.intentId,
        r3ReadFaultIntentId: equalA.intentId });
      context.assert(transient.accepted === false && transient.indexing.state === 'enqueue_failed'
        && !transient.indexing.jobId && fs.existsSync(path.join(ingressRoot, `${equalA.intentId}.intent.json`)),
      'unreadable older private intent blocks current ACK and retains retryable provenance');
      const equalAck = await equalOwner.acceptPublishedSave({ ...payload, intentId: equalB.intentId,
        r3SkipCleanup: true });
      context.assert(equalAck.accepted === true && equalAck.indexing.jobId, 'same-hash newer intent receives durable job ACK');
      context.assert(fs.existsSync(path.join(ingressRoot, `${equalA.intentId}.intent.json`))
        && fs.existsSync(path.join(ingressRoot, `${equalB.intentId}.intent.json`)),
      'crash-window fixture leaves committed intents for receipt replay');
      const equalReplay = await equalOwner.acceptPublishedSave({ ...payload, intentId: equalB.intentId });
      context.assert(equalReplay.indexing.jobId === equalAck.indexing.jobId,
        'post-commit pre-cleanup replay returns the same durable job receipt');
      const olderReceipt = await equalOwner.acceptPublishedSave({ ...payload, intentId: equalA.intentId });
      context.assert(olderReceipt.accepted === true && !olderReceipt.indexing?.jobId,
        'unaccepted older same-hash intent has provenance-only receipt after B reconciliation');
    } finally { await equalOwner.shutdown(); }
    const equalDoc = ledger.open().prepare("SELECT * FROM documents WHERE source_id = ? AND relative_path = 'equal.md'")
      .get(base.sourceId);
    const equalAliases = ledger.open().prepare('SELECT origin_lexical_path_internal FROM document_source_aliases WHERE document_id = ?')
      .all(equalDoc.document_id).map(row => row.origin_lexical_path_internal);
    context.assert(equalAliases.includes(equalAliasA) && equalAliases.includes(equalAliasB)
      && JSON.parse(equalDoc.document_tags_json).includes('equal-a'),
    'same-body distinct intent provenance and metadata are both committed');
    context.assert(!fs.existsSync(path.join(ingressRoot, `${equalA.intentId}.intent.json`))
      && !fs.existsSync(path.join(ingressRoot, `${equalB.intentId}.intent.json`)),
    'same-hash accepted intents are cleaned without deleting final Markdown');
    const tiedBase = { ...base, sourceRelativeLocator: 'tied.md' };
    const tiedAliasA = path.join(root, 'origin', 'tied-a.md');
    const tiedAliasB = path.join(root, 'origin', 'tied-b.md');
    let tiedA = await publishSave({ ...tiedBase, contentBytes: equalBody, contentHash: sha(equalBody),
      provenance: { aliases: [{ lexicalOriginalPath: tiedAliasA, canonicalOriginalPath: tiedAliasA,
        canonicalPathHash: pathHash(tiedAliasA) }], metadata: { documentTags: ['tied-a'] } } });
    let tiedB = await publishSave({ ...tiedBase, contentBytes: equalBody, contentHash: sha(equalBody),
      provenance: { aliases: [{ lexicalOriginalPath: tiedAliasB, canonicalOriginalPath: tiedAliasB,
        canonicalPathHash: pathHash(tiedAliasB) }], metadata: { documentTags: ['tied-b'] } } });
    const time = JSON.parse(fs.readFileSync(path.join(ingressRoot, `${tiedA.intentId}.intent.json`), 'utf8')).createdTime;
    forceIntentTime(ingressRoot, tiedA.intentId, time);
    forceIntentTime(ingressRoot, tiedB.intentId, time);
    tiedA = { ...tiedA, intentId: legacyIntentId(ingressRoot, tiedA.intentId) };
    tiedB = { ...tiedB, intentId: legacyIntentId(ingressRoot, tiedB.intentId) };
    const tiedOwner = new OwnerWorkerController({ ledgerPath, keywordPath, sourceRoot: storeRoot,
      keywordTokenizerProvider: 'basic' });
    try {
      await tiedOwner.start();
      const ambiguousA = await tiedOwner.acceptPublishedSave({ ...payload, intentId: tiedA.intentId });
      context.assert(ambiguousA.accepted === false && !ambiguousA.indexing.jobId
        && ambiguousA.warnings[0].retryable === true,
        'equal timestamp cannot make older same-body intent current');
      const ambiguousB = await tiedOwner.acceptPublishedSave({ ...payload, intentId: tiedB.intentId });
      context.assert(ambiguousB.accepted === false && !ambiguousB.indexing.jobId
        && ambiguousB.warnings[0].retryable === true,
        'equal timestamp cannot claim newer identity without an order witness');
      context.assert(fs.existsSync(path.join(ingressRoot, `${tiedA.intentId}.intent.json`))
        && fs.existsSync(path.join(ingressRoot, `${tiedB.intentId}.intent.json`)),
      'ambiguous intents remain private and retryable');
    } finally { await tiedOwner.shutdown(); }
  } finally { ledger.close(); }
} };
