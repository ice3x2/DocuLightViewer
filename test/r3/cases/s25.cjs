'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { publishSave, readPendingSave } = require('../../../src/main/index-ingress-store');
const { OwnerWorkerController } = require('../../../src/main/search-owner-controller');
const { SourceLedgerStore } = require('../../../src/main/source-ledger-store');
const { runClaimedDesiredJob } = require('../../../src/main/desired-job-processor');
const { SQLiteKeywordIndex } = require('../../../src/main/search-sqlite-store');
const { createBasicKeywordTokenizer } = require('../../../src/main/search-tokenizer');
const { deriveValidatedDocument } = require('../../../src/main/derived-document-indexer');
const { createLinkedImporter } = require('../../../src/main/linked-import');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const canonicalHash = value => sha(process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));

// @req FR-DOC-019 REL-DOC-009 DR-DOC-014 IR-APP-013
module.exports = { async run({ fixture, assert }) {
  const root = fixture.root;
  const sourceRoot = path.join(root, 'source');
  const storeRoot = path.join(root, 'store');
  const ingressRoot = path.join(root, 'private');
  const ledgerPath = path.join(root, 'ledger.sqlite');
  const keywordPath = path.join(root, 'keyword.sqlite');
  for (const dir of [sourceRoot, storeRoot, ingressRoot]) fs.mkdirSync(dir);
  const rootFingerprint = sha(storeRoot);
  const rootKey = process.platform === 'win32' ? path.resolve(storeRoot).toLowerCase() : path.resolve(storeRoot);
  const sourceId = `src_${sha(`${rootKey}\0${rootFingerprint}`).slice(0, 24)}`;
  const base = { storeRoot, ingressRoot, sourceId, rootFingerprint };
  const ownerConfig = { ledgerPath, keywordPath, sourceRoot: storeRoot, ingressRoot,
    keywordTokenizerProvider: 'basic', deriveDocuments: false };
  const evidence = { seed: 's25-2026-09-25-v1', fixture: path.basename(root),
    layout: ['source', 'store', 'private', 'ledger.sqlite', 'keyword.sqlite'],
    sourceHash: process.env.DOCULIGHT_R3_SOURCE_HASH, node: process.version, abi: process.versions.modules,
    sourceSha256: {}, sourceBytes: {}, documentId: {}, aliasCount: {}, desiredRevision: {},
    jobState: {}, markers: [] };
  const mark = name => { evidence.markers.push(name); console.error(name); };
  const ledger = new SourceLedgerStore({ dbPath: ledgerPath });
  const doc = locator => ledger.open().prepare('SELECT * FROM documents WHERE relative_path = ?').get(locator);
  const job = id => ledger.open().prepare('SELECT * FROM index_jobs WHERE job_id = ?').get(id);
  const publish = (locator, bytes, aliases = [], operation = 'save_document') => publishSave({ ...base,
    sourceRelativeLocator: locator, operation, contentBytes: bytes, contentHash: sha(bytes),
    provenance: { aliases, metadata: {} } });
  const alias = (lexical, canonical) => ({ lexicalOriginalPath: lexical,
    canonicalOriginalPath: canonical, canonicalPathHash: canonicalHash(canonical) });
  let owner;
  try {
    const firstBytes = Buffer.from('# First\n\nelephantine\n');
    const secondBytes = Buffer.from('# Second\n\nquartzite\n');
    const first = await publish('latest.md', firstBytes);
    assert(first.saved && first.indexing.state === 'enqueue_failed' && !first.indexing.jobId,
      'S25_PRE_ACK_NO_QUEUED_JOB: published bytes have no durable job acknowledgement');
    assert(fs.readFileSync(path.join(storeRoot, 'latest.md')).equals(firstBytes)
      && readPendingSave({ ingressRoot, storeRoot, intentId: first.intentId }).published,
    'S25_PRE_ACK_DURABLE_FILE: final file and body-free intent survive before ACK');
    evidence.sourceSha256.first = sha(firstBytes);
    evidence.sourceBytes.first = firstBytes.length;
    mark('S25_PRE_ACK_REACHED');

    ledger.initialize();
    ledger.open().exec(`CREATE TRIGGER s25_fail_job BEFORE INSERT ON index_jobs
      BEGIN SELECT RAISE(ABORT, 's25 source transaction fault'); END`);
    owner = new OwnerWorkerController({ ...ownerConfig, r3SkipStartupReplay: true });
    await owner.start();
    const failedAck = await owner.acceptPublishedSave({ intentId: first.intentId });
    assert(failedAck.saved === true && failedAck.accepted === false
      && failedAck.indexingState === 'enqueue_failed' && !failedAck.indexing.jobId
      && fs.readFileSync(path.join(storeRoot, 'latest.md')).equals(firstBytes)
      && readPendingSave({ ingressRoot, storeRoot, intentId: first.intentId }).published
      && ledger.open().prepare('SELECT COUNT(*) AS n FROM index_jobs').get().n === 0,
    'S25_POST_PUBLISH_PRE_COMMIT: live owner transaction fault keeps file and intent without queued/jobId');
    mark('S25_PRE_COMMIT_FAILURE_REACHED');

    ledger.open().exec('DROP TRIGGER s25_fail_job');
    const acceptedFirst = await owner.acceptPublishedSave({ intentId: first.intentId });
    const replayFirst = await owner.acceptPublishedSave({ intentId: first.intentId });
    assert(acceptedFirst.accepted === true && acceptedFirst.indexing.jobId
      && replayFirst.documentId === acceptedFirst.documentId && replayFirst.desiredRevision === 1
      && replayFirst.indexing.jobId === acceptedFirst.indexing.jobId,
      'S25_PRE_COMMIT_REPLAY: retry assigns one stable document ID and revision');
    await owner.shutdown();
    owner = null;
    const oldClaim = ledger.claimDesiredJob({ documentId: acceptedFirst.documentId, desiredRevision: 1 });
    assert(oldClaim?.requestedRevision === 1, 'S25_OLD_JOB_CLAIM: first revision has a real SQLite job');
    const second = await publish('latest.md', secondBytes, [], 'update');
    const acceptedSecond = ledger.acceptSaveIntent({ current: readPendingSave({ ingressRoot, storeRoot,
      intentId: second.intentId }), storeRoot, finalMetadata: {},
      contentByteLength: secondBytes.length, contentTextLength: secondBytes.toString('utf8').length });
    const oldResult = await runClaimedDesiredJob({ ledger, claim: oldClaim, storeRoot, ingressRoot,
      onValidated: async () => { assert(false, 'S25_STALE_BYTES_REJECTED: old bytes reached downstream'); } });
    const latest = doc('latest.md');
    assert(oldResult.completed === false && latest.desired_revision === 2 && latest.dirty === 1
      && latest.desired_content_hash === `sha256:${sha(secondBytes)}`
      && fs.readFileSync(path.join(storeRoot, 'latest.md')).equals(secondBytes),
    'S25_LATEST_WINS: old job cannot complete or replace the newer saved revision');
    evidence.sourceSha256.latest = sha(secondBytes);
    evidence.sourceBytes.latest = secondBytes.length;
    evidence.documentId.latest = latest.document_id;
    evidence.desiredRevision.latest = latest.desired_revision;
    evidence.jobState.old = job(oldClaim.jobId).status;
    mark('S25_LATEST_WINS_REACHED');

    const currentClaim = ledger.claimDesiredJob({ documentId: latest.document_id, desiredRevision: 2 });
    assert(currentClaim?.requestedRevision === 2, 'S25_CURRENT_CLAIM: new revision is claimable');
    ledger.updateIndexJob(currentClaim.jobId, { status: 'failed', finishedAt: true });
    const retry = ledger.scheduleDesiredRetry({ documentId: latest.document_id,
      nextEligibleAt: '2000-01-01T00:00:00.000Z' });
    assert(retry?.jobId !== currentClaim.jobId && doc('latest.md').dirty === 1
      && fs.readFileSync(path.join(storeRoot, 'latest.md')).equals(secondBytes),
    'S25_D1_FAILURE_RETRY: failed indexing retains saved bytes and retry job');
    evidence.jobState.failed = job(currentClaim.jobId).status;
    evidence.jobState.retry = job(retry.jobId).status;
    mark('S25_D1_FAILURE_RETRY_REACHED');

    const retryClaim = ledger.claimDesiredJob({ documentId: latest.document_id, desiredRevision: 2 });
    const keyword = new SQLiteKeywordIndex({ dbPath: keywordPath, sourceRoot: storeRoot,
      tokenizer: createBasicKeywordTokenizer() });
    try {
      keyword.open();
      const result = await runClaimedDesiredJob({ ledger, claim: retryClaim, storeRoot, ingressRoot,
        onValidated: validated => deriveValidatedDocument({ ledger, keyword, claim: retryClaim,
          storeRoot, validated }) });
      const currentHits = keyword.search('quartzite');
      const oldHits = keyword.search('elephantine');
      assert(result.completed === true && doc('latest.md').completed_revision === 2
        && currentHits.length > 0 && oldHits.length === 0,
      'S25_LATEST_SEARCH_CONVERGED: retry indexes only the newest published revision');
      evidence.jobState.retried = job(retryClaim.jobId).status;
      evidence.searchHits = { latest: currentHits.length, old: oldHits.length };
    } finally { keyword.close(); }
    mark('S25_LATEST_SEARCH_REACHED');

    const importedBytes = Buffer.from('# Completed import\n\ns25 imported needle\n');
    fs.writeFileSync(path.join(sourceRoot, 'imported.md'), importedBytes);
    owner = new OwnerWorkerController({ ...ownerConfig, r3SkipStartupReplay: true });
    await owner.start();
    const importer = createLinkedImporter({ sourceRoot, knowledgeStoreRoot: storeRoot,
      ledger, ownerController: owner, ingressRoot });
    const imported = await importer.importMarkdownGraph(path.join(sourceRoot, 'imported.md'));
    assert(imported.counts.imported === 1 && imported.imported[0].documentId
      && fs.readFileSync(path.join(storeRoot, 'imported.md')).equals(importedBytes),
      'S25_D1_IMPORT_FILE: real linked importer completes a contained Markdown copy');
    const importedAck = { documentId: imported.imported[0].documentId };
    await owner.shutdown();
    owner = null;
    const importClaim = ledger.claimDesiredJob({ documentId: importedAck.documentId, desiredRevision: 1 });
    assert(importClaim?.jobId && job(importClaim.jobId).requested_by === 'local.linked_import',
      'S25_D1_IMPORT_JOB: durable job belongs to the linked import producer');
    ledger.updateIndexJob(importClaim.jobId, { status: 'cancelled', finishedAt: true });
    const importRetry = ledger.scheduleDesiredRetry({ documentId: importedAck.documentId,
      nextEligibleAt: '2000-01-01T00:00:00.000Z' });
    assert(importRetry && doc('imported.md').dirty === 1
      && fs.readFileSync(path.join(storeRoot, 'imported.md')).equals(importedBytes),
    'S25_D1_IMPORT_CANCEL_RETRY: cancelled import indexing retains completed file');
    evidence.sourceSha256.imported = sha(importedBytes);
    evidence.sourceBytes.imported = importedBytes.length;
    evidence.documentId.imported = importedAck.documentId;
    evidence.jobState.importCancelled = job(importClaim.jobId).status;
    mark('S25_D1_IMPORT_REACHED');

    const generatedBytes = Buffer.from('# Content only\n');
    const generated = await publish('generated.md', generatedBytes);
    const generatedAck = ledger.acceptSaveIntent({ current: readPendingSave({ ingressRoot, storeRoot,
      intentId: generated.intentId }), storeRoot, finalMetadata: {},
      contentByteLength: generatedBytes.length, contentTextLength: generatedBytes.toString('utf8').length });
    const generatedAliases = ledger.open().prepare('SELECT * FROM document_source_aliases WHERE document_id = ?')
      .all(generatedAck.documentId);
    assert(generatedAliases.length === 0,
      'S25_CONTENT_ONLY_NO_ORIGIN: generated content has no invented original alias');
    evidence.sourceSha256.generated = sha(generatedBytes);
    evidence.sourceBytes.generated = generatedBytes.length;
    evidence.documentId.generated = generatedAck.documentId;
    evidence.aliasCount.generated = generatedAliases.length;
    mark('S25_CONTENT_ONLY_REACHED');

    const actualDir = path.join(sourceRoot, 'actual');
    fs.mkdirSync(actualDir);
    const canonical = path.join(actualDir, 'original.md');
    fs.writeFileSync(canonical, '# Origin\n');
    const lexicalDir = path.join(root, 'lexical-link');
    fs.symlinkSync(actualDir, lexicalDir, process.platform === 'win32' ? 'junction' : 'dir');
    const lexical = path.join(lexicalDir, 'original.md');
    const originBytes = Buffer.from('# Origin\n');
    const fromCanonical = await publish('origin-copy.md', originBytes,
      [alias(canonical, fs.realpathSync.native(canonical))], 'opened_markdown');
    const canonicalAck = ledger.acceptSaveIntent({ current: readPendingSave({ ingressRoot, storeRoot,
      intentId: fromCanonical.intentId }), storeRoot, finalMetadata: {},
      contentByteLength: originBytes.length, contentTextLength: originBytes.toString('utf8').length });
    const fromLexical = await publish('origin-copy.md', originBytes,
      [alias(lexical, fs.realpathSync.native(lexical))], 'opened_markdown');
    const lexicalAck = ledger.acceptSaveIntent({ current: readPendingSave({ ingressRoot, storeRoot,
      intentId: fromLexical.intentId }), storeRoot, finalMetadata: {},
      contentByteLength: originBytes.length, contentTextLength: originBytes.toString('utf8').length });
    assert(canonicalAck.documentId === lexicalAck.documentId,
      'S25_TWO_ALIASES_ONE_ID: lexical and canonical opens share one document ID');
    ledger.close();
    const restarted = new SourceLedgerStore({ dbPath: ledgerPath });
    try {
      const rows = restarted.open().prepare(`SELECT origin_lexical_path_internal, origin_path_internal,
        canonical_path_hash FROM document_source_aliases WHERE document_id = ? ORDER BY origin_lexical_path_internal`)
        .all(canonicalAck.documentId);
      const persisted = restarted.open().prepare('SELECT document_id FROM documents WHERE relative_path = ?')
        .get('origin-copy.md');
      assert(persisted.document_id === canonicalAck.documentId && rows.length === 2
        && rows.some(row => row.origin_lexical_path_internal === canonical)
        && rows.some(row => row.origin_lexical_path_internal === lexical)
        && rows.every(row => row.origin_path_internal === fs.realpathSync.native(canonical)
          && row.canonical_path_hash === canonicalHash(canonical)),
      'S25_ALIAS_RESTART: two lexical aliases retain one canonical target and stable ID');
      evidence.sourceSha256.origin = sha(originBytes);
      evidence.sourceBytes.origin = originBytes.length;
      evidence.documentId.origin = persisted.document_id;
      evidence.aliasCount.origin = rows.length;
      evidence.canonicalPathHash = canonicalHash(canonical);
    } finally { restarted.close(); }
    mark('S25_ALIAS_RESTART_REACHED');

    owner = new OwnerWorkerController({ ...ownerConfig, r3SchedulerFixture: true });
    await owner.start();
    const active = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { owner.worker.off('message', onMessage); reject(new Error('active owner marker timed out')); }, 4000);
      function onMessage(message) {
        if (message.tag !== 'STATUS' || message.snapshot?.progress?.current < 1) return;
        clearTimeout(timer);
        owner.worker.off('message', onMessage);
        resolve(message);
      }
      owner.worker.on('message', onMessage);
    });
    const work = owner.command('accept_save', { r3SchedulerUnits: 256,
      testTarget: 's25-active-work' }, 's25-work');
    await active;
    const started = Date.now();
    const [status, cancel] = await Promise.all([owner.query('get_status'), owner.cancel('s25-active-work')]);
    const elapsedMs = Date.now() - started;
    const stopped = await work;
    assert(status?.active === true && cancel.cancelled === true && stopped.cancelled === true
      && stopped.current < 256 && elapsedMs < 1000,
      'S25_OWNER_STATUS_CANCEL: status and targeted cancel finish during active worker units');
    evidence.jobState.ownerState = status.state;
    evidence.jobState.ownerCancelled = stopped.cancelled;
    evidence.ownerStatusCancelMs = elapsedMs;
    mark('S25_OWNER_STATUS_CANCEL_REACHED');
    mark('S25_ALL_ASSERTIONS_REACHED');
    console.error(`S25_EVIDENCE ${JSON.stringify(evidence)}`);
  } finally {
    ledger.close();
    if (owner) await owner.shutdown();
  }
} };
