'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { publishSave } = require('../../../src/main/index-ingress-store');
const { OwnerWorkerController } = require('../../../src/main/search-owner-controller');
const { SourceLedgerStore } = require('../../../src/main/source-ledger-store');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const pathHash = value => sha(process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
function forceIntentTime(file, createdTime) {
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.createdTime = createdTime;
  const { checksum, ...fields } = record;
  record.checksum = sha(Buffer.from(JSON.stringify(fields), 'utf8'));
  fs.writeFileSync(file, JSON.stringify(record));
}

// @req FR-DOC-019 REL-DOC-009 DR-DOC-014
module.exports = { async run(context) {
  const root = context.fixture.root;
  const storeRoot = path.join(root, 'store');
  const ingressRoot = path.join(root, 'private');
  const ledgerPath = path.join(root, 'ledger.sqlite');
  const keywordPath = path.join(root, 'keyword.sqlite');
  fs.mkdirSync(storeRoot);
  fs.mkdirSync(ingressRoot);
  const base = { storeRoot, ingressRoot, sourceRelativeLocator: 'same.md', operation: 'update',
    sourceId: 'source_fixture', rootFingerprint: sha(storeRoot) };
  const body = Buffer.from('---\ntitle: Current\n---\n# Same body\n');
  const publish = async (suffix, metadata = {}) => {
    const origin = path.join(root, 'origin', `${suffix}.md`);
    return publishSave({ ...base, contentBytes: body, contentHash: sha(body),
      provenance: { aliases: [{ lexicalOriginalPath: origin, canonicalOriginalPath: origin,
        canonicalPathHash: pathHash(origin) }], metadata } });
  };
  const a = await publish('a', { category: 'first', documentTags: ['a'] });
  const b = await publish('b', { category: 'latest', documentTags: ['b'] });
  const aPath = path.join(ingressRoot, `${a.intentId}.intent.json`);
  const bPath = path.join(ingressRoot, `${b.intentId}.intent.json`);
  const older = JSON.parse(fs.readFileSync(aPath, 'utf8'));
  forceIntentTime(bPath, older.createdTime);
  const newer = JSON.parse(fs.readFileSync(bPath, 'utf8'));
  context.assert(fs.readFileSync(path.join(storeRoot, 'same.md')).equals(body),
    'same-body saves are both published to the real store');
  context.assert(older.createdTime === newer.createdTime,
    'distinct private intents have an actual equal-time ambiguity');
  const owner = new OwnerWorkerController({ ledgerPath, keywordPath, sourceRoot: storeRoot,
    keywordTokenizerProvider: 'basic' });
  try {
    await owner.start();
    const ack = await owner.acceptPublishedSave({ storeRoot, ingressRoot, intentId: b.intentId });
    context.assert(ack.accepted === true && ack.indexingState === 'queued' && ack.desiredRevision === 1,
      'owner accepts latest published same-body intent despite equal wall time');
  } finally { await owner.shutdown(); }
  const ledger = new SourceLedgerStore({ dbPath: ledgerPath });
  try {
    const db = ledger.open();
    const doc = db.prepare("SELECT * FROM documents WHERE source_id = 'source_fixture' AND relative_path = 'same.md'").get();
    context.assert(doc && doc.content_hash === `sha256:${sha(body)}` && doc.desired_revision === 1,
      'real SQLite desired state points to current final body');
    context.assert(JSON.parse(doc.metadata_json).category === 'latest'
      && JSON.parse(doc.document_tags_json).includes('a') && JSON.parse(doc.document_tags_json).includes('b'),
      'latest scalar metadata and both alias tags survive');
    context.assert(db.prepare('SELECT COUNT(*) AS n FROM document_source_aliases WHERE document_id = ?').get(doc.document_id).n === 2,
      'both original aliases remain linked after coalescing');
    const page = typeof ledger.getPendingDesiredPage === 'function'
      ? ledger.getPendingDesiredPage({ limit: 2 }) : [];
    context.assert(page.length === 1 && page[0].documentId === doc.document_id
      && page[0].desiredRevision === 1,
      'current desired state is enumerable independently of terminal job history');
    const claimed = typeof ledger.claimDesiredJob === 'function'
      ? ledger.claimDesiredJob({ documentId: doc.document_id, desiredRevision: 1 }) : null;
    context.assert(claimed && claimed.jobId === doc.current_job_id,
      'one durable current job can be claimed by document and revision');
    context.assert(ledger.claimDesiredJob({ documentId: doc.document_id, desiredRevision: 1 }) === null,
      'a second claim cannot activate another job for the same document');
    ledger.close();
    const changed = Buffer.from('---\ntitle: D\n---\n# Changed while indexing\n');
    const d = await publishSave({ ...base, contentBytes: changed, contentHash: sha(changed),
      provenance: { aliases: [], metadata: { documentTags: ['d'] } } });
    const later = new OwnerWorkerController({ ledgerPath, keywordPath, sourceRoot: storeRoot,
      keywordTokenizerProvider: 'basic' });
    try {
      await later.start();
      const dAck = await later.acceptPublishedSave({ storeRoot, ingressRoot, intentId: d.intentId });
      context.assert(dAck.accepted && dAck.desiredRevision === 2,
        'a save during active indexing advances desired revision');
      const replay = await later.acceptPublishedSave({ storeRoot, ingressRoot, intentId: d.intentId });
      context.assert(replay.desiredRevision === 2 && replay.indexing.jobId === dAck.indexing.jobId,
        'duplicate intent does not advance revision or create another job');
    } finally { await later.shutdown(); }
    const afterDb = ledger.open();
    const afterD = afterDb.prepare('SELECT * FROM documents WHERE document_id = ?').get(doc.document_id);
    context.assert(afterD.desired_content_hash === `sha256:${sha(changed)}` && afterD.dirty === 1
      && afterD.keyword_dirty === 1 && afterD.active_requested_revision === 1,
      'active revision stays old while D remains dirty and keyword dirty');
    context.assert(afterDb.prepare("SELECT COUNT(*) AS n FROM index_jobs WHERE document_id = ? AND status = 'indexing'")
      .get(doc.document_id).n === 1,
      'only one active indexing job exists while D waits');
    context.assert(ledger.claimDesiredJob({ documentId: doc.document_id, desiredRevision: 2 }) === null,
      'D cannot claim a second active job before the old job ends');
    ledger.updateIndexJob(claimed.jobId, { status: 'cancelled', finishedAt: true });
    context.assert(fs.readFileSync(path.join(storeRoot, 'same.md')).equals(changed),
      'cancelling old indexing does not delete the saved D file');
    const dClaim = ledger.claimDesiredJob({ documentId: doc.document_id, desiredRevision: 2 });
    context.assert(dClaim && dClaim.jobId === afterD.current_job_id,
      'dirty D becomes claimable after the old active job is cancelled');
    ledger.updateIndexJob(dClaim.jobId, { status: 'failed', finishedAt: true });
    const retry = typeof ledger.scheduleDesiredRetry === 'function'
      ? ledger.scheduleDesiredRetry({ documentId: doc.document_id, nextEligibleAt: '2000-01-01T00:00:00.000Z' }) : null;
    context.assert(retry && retry.jobId !== dClaim.jobId && retry.desiredRevision === 2,
      'failed current attempt creates a fresh retry job without reviving terminal history');
    const retried = afterDb.prepare('SELECT * FROM documents WHERE document_id = ?').get(doc.document_id);
    context.assert(retried.retry_count === 1 && retried.dirty === 1 && retried.keyword_dirty === 1
      && fs.readFileSync(path.join(storeRoot, 'same.md')).equals(changed),
      'retry retains durable dirty state and the published file');
  } finally { ledger.close(); }
  const restartBase = { ...base, sourceRelativeLocator: 'restart.md' };
  const firstOrigin = path.join(root, 'origin', 'restart-first.md');
  const lastOrigin = path.join(root, 'origin', 'restart-last.md');
  const first = await publishSave({ ...restartBase, contentBytes: body, contentHash: sha(body),
    provenance: { aliases: [{ lexicalOriginalPath: firstOrigin, canonicalOriginalPath: firstOrigin,
      canonicalPathHash: pathHash(firstOrigin) }], metadata: { category: 'before', documentTags: ['before'] } } });
  const last = await publishSave({ ...restartBase, contentBytes: body, contentHash: sha(body),
    provenance: { aliases: [{ lexicalOriginalPath: lastOrigin, canonicalOriginalPath: lastOrigin,
      canonicalPathHash: pathHash(lastOrigin) }], metadata: { category: 'after', documentTags: ['after'] } } });
  const firstTime = JSON.parse(fs.readFileSync(path.join(ingressRoot, `${first.intentId}.intent.json`), 'utf8')).createdTime;
  forceIntentTime(path.join(ingressRoot, `${last.intentId}.intent.json`), firstTime);
  context.assert(fs.existsSync(path.join(ingressRoot, `${first.intentId}.intent.json`))
    && fs.existsSync(path.join(ingressRoot, `${last.intentId}.intent.json`)),
    'both pre-ACK intents survive before owner restart');
  const recovering = new OwnerWorkerController({ ledgerPath, keywordPath, sourceRoot: storeRoot,
    ingressRoot, keywordTokenizerProvider: 'basic' });
  try {
    await recovering.start();
    let recovered;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const probe = new SourceLedgerStore({ dbPath: ledgerPath });
      try { recovered = probe.open().prepare("SELECT * FROM documents WHERE source_id = 'source_fixture' AND relative_path = 'restart.md'").get(); }
      finally { probe.close(); }
      if (recovered) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    context.assert(recovered && recovered.desired_revision === 1 && recovered.accepted_intent_id === last.intentId,
      'restart automatically accepts durable latest intent without a user re-save');
  } finally { await recovering.shutdown(); }
  const finalLedger = new SourceLedgerStore({ dbPath: ledgerPath });
  try {
    const db = finalLedger.open();
    const recovered = db.prepare("SELECT * FROM documents WHERE relative_path = 'restart.md'").get();
    context.assert(JSON.parse(recovered.metadata_json).category === 'after'
      && JSON.parse(recovered.document_tags_json).includes('before')
      && JSON.parse(recovered.document_tags_json).includes('after'),
      'restart preserves both metadata sets and the true published scalar winner');
    context.assert(db.prepare('SELECT COUNT(*) AS n FROM document_source_aliases WHERE document_id = ?')
      .get(recovered.document_id).n === 2,
      'restart keeps both original aliases');
    context.assert(!fs.existsSync(path.join(ingressRoot, `${first.intentId}.intent.json`))
      && !fs.existsSync(path.join(ingressRoot, `${last.intentId}.intent.json`)),
      'owner cleans private intents only after durable receipts');
  } finally { finalLedger.close(); }
  const transientBytes = Buffer.from('# Retry after startup fault\n');
  const transient = await publishSave({ ...base, sourceRelativeLocator: 'retry-startup.md',
    contentBytes: transientBytes, contentHash: sha(transientBytes),
    provenance: { aliases: [], metadata: {} } });
  const faultDb = new SourceLedgerStore({ dbPath: ledgerPath });
  faultDb.open().exec("CREATE TRIGGER s10_transient BEFORE INSERT ON index_jobs BEGIN SELECT RAISE(ABORT, 'transient'); END");
  faultDb.close();
  const retryingOwner = new OwnerWorkerController({ ledgerPath, keywordPath, sourceRoot: storeRoot,
    ingressRoot, keywordTokenizerProvider: 'basic' });
  try {
    await retryingOwner.start();
    await new Promise(resolve => setTimeout(resolve, 100));
    context.assert(fs.existsSync(path.join(ingressRoot, `${transient.intentId}.intent.json`)),
      'transient owner commit failure keeps the private intent and published file');
    faultDb.open().exec('DROP TRIGGER s10_transient');
    faultDb.close();
    let recovered;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      recovered = faultDb.open().prepare("SELECT * FROM documents WHERE relative_path = 'retry-startup.md'").get();
      faultDb.close();
      if (recovered) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    context.assert(recovered && recovered.desired_content_hash === `sha256:${sha(transientBytes)}`,
      'owner retries a transient startup acceptance failure without a caller re-save');
  } finally { faultDb.close(); await retryingOwner.shutdown(); }
  const paging = new OwnerWorkerController({ ledgerPath, keywordPath, sourceRoot: storeRoot,
    keywordTokenizerProvider: 'basic' });
  try {
    await paging.start();
    for (let i = 0; i < 5; i += 1) {
      const locator = `page-${i}.md`;
      const bytes = Buffer.from(`# Page ${i}\n`);
      const intent = await publishSave({ ...base, sourceRelativeLocator: locator,
        contentBytes: bytes, contentHash: sha(bytes), provenance: { aliases: [], metadata: {} } });
      const reply = await paging.acceptPublishedSave({ storeRoot, ingressRoot, intentId: intent.intentId });
      context.assert(reply.accepted === true, `page fixture ${i} is durably accepted`);
    }
  } finally { await paging.shutdown(); }
  const pageLedger = new SourceLedgerStore({ dbPath: ledgerPath });
  try {
    const seen = [];
    let cursor = '';
    while (true) {
      const page = pageLedger.getPendingDesiredPage({ afterDocumentId: cursor, limit: 2 });
      if (page.length === 0) break;
      seen.push(...page.map(item => item.documentId));
      cursor = page.at(-1).documentId;
    }
    context.assert(seen.length === 8 && new Set(seen).size === 8,
      'keyset paging visits every pending document exactly once across more than one page');
  } finally { pageLedger.close(); }
  const lock = path.join(ingressRoot, '.publication.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'live-fixture' }));
  const guardedBytes = Buffer.from('# Guarded\n');
  let busy = false;
  try {
    await publishSave({ ...base, sourceRelativeLocator: 'guarded.md', contentBytes: guardedBytes,
      contentHash: sha(guardedBytes), provenance: { aliases: [], metadata: {} } });
  } catch (error) { busy = error.code === 'publication_busy'; }
  context.assert(busy && !fs.existsSync(path.join(storeRoot, 'guarded.md')),
    'a live publication owner prevents a concurrent publisher from reordering final bytes');
  fs.rmSync(lock, { recursive: true });
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 99999999, token: 'dead-fixture' }));
  const recoveredLock = await publishSave({ ...base, sourceRelativeLocator: 'guarded.md',
    contentBytes: guardedBytes, contentHash: sha(guardedBytes),
    provenance: { aliases: [], metadata: {} } }).catch(() => null);
  context.assert(recoveredLock && fs.readFileSync(path.join(storeRoot, 'guarded.md')).equals(guardedBytes)
    && !fs.existsSync(lock),
    'dead publisher lock is recovered before a new durable publication');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), '{"pid":');
  const oldTime = new Date(Date.now() - 6000);
  fs.utimesSync(lock, oldTime, oldTime);
  const partialBytes = Buffer.from('# After partial owner crash\n');
  const afterPartial = await publishSave({ ...base, sourceRelativeLocator: 'after-partial.md',
    contentBytes: partialBytes, contentHash: sha(partialBytes),
    provenance: { aliases: [], metadata: {} } }).catch(() => null);
  context.assert(afterPartial && fs.readFileSync(path.join(storeRoot, 'after-partial.md')).equals(partialBytes),
    'stale partial legacy owner record cannot permanently block later publication');
  const concurrentBase = { ...base, sourceRelativeLocator: 'concurrent.md' };
  const childBytes = Buffer.from('# Child publishes first\n');
  const parentBytes = Buffer.from('# Parent publishes last\n');
  const child = fork(path.join(__dirname, 's10-publisher-child.cjs'), [JSON.stringify({
    ...concurrentBase, contentBytes: { type: 'Buffer', data: [...childBytes] }, contentHash: sha(childBytes),
    provenance: { aliases: [], metadata: {} }, faultAt: 'r3_hold_after_order'
  })], { stdio: 'ignore' });
  try {
    let held = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      held = fs.existsSync(lock) && fs.existsSync(path.join(ingressRoot, '.publication-order.json'));
      if (held) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    context.assert(held, 'concurrent publisher holds the publication gate after order reservation');
    const atomicOwner = JSON.parse(fs.readFileSync(lock, 'utf8'));
    context.assert(fs.statSync(lock).isFile() && atomicOwner.pid === child.pid,
      'visible new publication gate always contains a complete flushed owner record');
    const parent = await publishSave({ ...concurrentBase, contentBytes: parentBytes,
      contentHash: sha(parentBytes), provenance: { aliases: [], metadata: {} } }).catch(() => null);
    context.assert(parent && parent.saved === true,
      'second publisher waits asynchronously and publishes without a caller re-save');
    const exitCode = child.exitCode === null ? await new Promise(resolve => child.once('exit', resolve)) : child.exitCode;
    context.assert(exitCode === 0,
      'first process finishes its publication while the second waits');
    const childIntent = fs.readdirSync(ingressRoot).find(name => name.endsWith('.intent.json')
      && JSON.parse(fs.readFileSync(path.join(ingressRoot, name), 'utf8')).contentHash === sha(childBytes));
    const firstOrder = JSON.parse(fs.readFileSync(path.join(ingressRoot, childIntent), 'utf8')).publicationOrder;
    const lastOrder = JSON.parse(fs.readFileSync(path.join(ingressRoot, `${parent.intentId}.intent.json`), 'utf8')).publicationOrder;
    context.assert(lastOrder > firstOrder && fs.readFileSync(path.join(storeRoot, 'concurrent.md')).equals(parentBytes),
      'durable order witness follows actual cross-process final publication order');
    let staleRejected = false;
    try {
      await publishSave({ ...concurrentBase, contentBytes: childBytes, contentHash: sha(childBytes),
        intentId: childIntent.slice(0, 64), provenance: { aliases: [], metadata: {} } });
    } catch (error) { staleRejected = error.code === 'stale_intent'; }
    context.assert(staleRejected && fs.readFileSync(path.join(storeRoot, 'concurrent.md')).equals(parentBytes),
      'late retry of an older private intent cannot republish older bytes over the newer final');
  } finally { if (child.exitCode === null) child.kill(); }
  const clockBase = { ...base, sourceRelativeLocator: 'clock.md' };
  const clockIntents = [];
  for (const [letter, time] of [['A', '2030-01-01T00:00:00.000Z'],
    ['B', '2020-01-01T00:00:00.000Z'], ['C', '2000-01-01T00:00:00.000Z']]) {
    const bytes = Buffer.from(`# ${letter}\n`);
    const intent = await publishSave({ ...clockBase, contentBytes: bytes, contentHash: sha(bytes),
      provenance: { aliases: [], metadata: { documentTags: [letter] } } });
    forceIntentTime(path.join(ingressRoot, `${intent.intentId}.intent.json`), time);
    clockIntents.push(intent);
  }
  const concurrentOwner = new OwnerWorkerController({ ledgerPath, keywordPath, sourceRoot: storeRoot,
    keywordTokenizerProvider: 'basic' });
  try {
    await concurrentOwner.start();
    const replies = await Promise.all(clockIntents.map(intent => concurrentOwner.acceptPublishedSave({
      storeRoot, ingressRoot, intentId: intent.intentId
    })));
    context.assert(replies[2].accepted === true && replies[2].desiredRevision === 1
      && replies.slice(0, 2).every(reply => !reply.indexing?.jobId),
      'concurrent ACCEPT respects publication order despite wall-clock rollback');
  } finally { await concurrentOwner.shutdown(); }
  const clockLedger = new SourceLedgerStore({ dbPath: ledgerPath });
  try {
    const row = clockLedger.open().prepare("SELECT * FROM documents WHERE relative_path = 'clock.md'").get();
    context.assert(row && row.desired_content_hash === `sha256:${sha(Buffer.from('# C\n'))}`
      && fs.readFileSync(path.join(storeRoot, 'clock.md'), 'utf8') === '# C\n',
      'A to B to C converges on C actual file bytes, independent of timestamp');
    context.assert(clockLedger.open().prepare("SELECT COUNT(*) AS n FROM index_jobs WHERE document_id = ? AND status = 'queued'")
      .get(row.document_id).n === 1,
      'concurrent ACCEPT leaves one current queued job');
  } finally { clockLedger.close(); }
  const revertBase = { ...base, sourceRelativeLocator: 'revert.md' };
  const originalBytes = Buffer.from('# Original\n');
  const intermediateBytes = Buffer.from('# Intermediate\n');
  const originalInput = { ...revertBase, contentBytes: originalBytes, contentHash: sha(originalBytes),
    provenance: { aliases: [], metadata: {} } };
  const original = await publishSave(originalInput);
  await publishSave({ ...revertBase, contentBytes: intermediateBytes,
    contentHash: sha(intermediateBytes), provenance: { aliases: [], metadata: {} } });
  const reverted = await publishSave(originalInput).catch(() => null);
  context.assert(reverted && reverted.intentId !== original.intentId
    && fs.readFileSync(path.join(storeRoot, 'revert.md')).equals(originalBytes),
    'A to B to A publication gets a fresh intent identity for the final A');
  const revertOwner = new OwnerWorkerController({ ledgerPath, keywordPath, sourceRoot: storeRoot,
    keywordTokenizerProvider: 'basic' });
  try {
    await revertOwner.start();
    const reply = await revertOwner.acceptPublishedSave({ storeRoot, ingressRoot, intentId: reverted.intentId });
    context.assert(reply.accepted === true && reply.desiredRevision === 1,
      'final A receives its own desired revision after A to B to A');
  } finally { await revertOwner.shutdown(); }
  const revertLedger = new SourceLedgerStore({ dbPath: ledgerPath });
  try {
    const row = revertLedger.open().prepare("SELECT * FROM documents WHERE relative_path = 'revert.md'").get();
    context.assert(row.accepted_intent_id === reverted.intentId
      && row.desired_content_hash === `sha256:${sha(originalBytes)}`,
      'reverted body is authoritative through the newest publication receipt');
  } finally { revertLedger.close(); }
} };
