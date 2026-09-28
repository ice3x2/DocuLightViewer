'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { SourceLedgerStore } = require('../src/main/source-ledger-store');
const { SQLiteKeywordIndex } = require('../src/main/search-sqlite-store');
const { createBasicKeywordTokenizer } = require('../src/main/search-tokenizer');
const { publishSave, readPendingSave } = require('../src/main/index-ingress-store');
const { runClaimedDesiredJob } = require('../src/main/desired-job-processor');
const { prepareValidatedDocument, commitPreparedDocument } = require('../src/main/derived-document-indexer');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');

// @req FR-DOC-019 AC-2 REL-DOC-009 AC-1 AC-2 AC-4
async function runCase(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `doculight-guarded-${mode}-`));
  const storeRoot = path.join(root, 'store');
  const ingressRoot = path.join(root, 'ingress');
  fs.mkdirSync(storeRoot);
  fs.mkdirSync(ingressRoot);
  const ledger = new SourceLedgerStore({ dbPath: path.join(root, 'ledger.sqlite') });
  const tokenizer = createBasicKeywordTokenizer();
  const keyword = new SQLiteKeywordIndex({ dbPath: path.join(root, 'keyword.sqlite'),
    sourceRoot: storeRoot, tokenizer });
  const first = mode === 'large'
    ? Buffer.from('# Large\n' + 'activeownerword '.repeat(655359))
    : Buffer.from('# Old\n\noldneedle\n');
  const newer = mode === 'new-bytes' ? Buffer.from('# New\n\nnewneedle\n') : first;
  const base = { storeRoot, ingressRoot, operation: 'save_document',
    sourceId: 'src_fixture', rootFingerprint: sha(path.resolve(storeRoot)),
    sourceRelativeLocator: 'same.md' };
  try {
    const initial = await publishSave({ ...base, contentBytes: first,
      contentHash: sha(first), provenance: { aliases: [], metadata: {} } });
    ledger.initialize();
    const initialIntent = readPendingSave({ ingressRoot, storeRoot, intentId: initial.intentId });
    const accepted = ledger.acceptSaveIntent({ current: initialIntent, storeRoot,
      finalMetadata: {}, contentByteLength: first.length,
      contentTextLength: first.toString('utf8').length });
    const claim = ledger.claimDesiredJob({ documentId: accepted.documentId,
      desiredRevision: accepted.desiredRevision });
    keyword.open();
    let enterPreparation;
    const preparing = new Promise(resolve => { enterPreparation = resolve; });
    const originalBuild = tokenizer.buildSearchText.bind(tokenizer);
    let delayed = false;
    tokenizer.buildSearchText = async text => {
      if (!delayed) {
        delayed = true;
        enterPreparation();
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
      return originalBuild(text);
    };
    let prepared;
    let guardedCommitMs = null;
    const job = runClaimedDesiredJob({ ledger, claim, storeRoot, ingressRoot,
      onValidated: async validated => {
        prepared = await prepareValidatedDocument({ ledger, keyword, claim,
          storeRoot, validated });
        return prepared ? null : { stale: true };
      },
      onFinalValidated: validated => {
        const started = performance.now();
        const committed = commitPreparedDocument({ ledger, keyword, claim,
          storeRoot, validated, prepared });
        guardedCommitMs = performance.now() - started;
        return committed;
      } });
    await preparing;
    let publication;
    if (mode !== 'unchanged' && mode !== 'large') {
      if (mode === 'aba-metadata') {
        const middle = Buffer.from('# Middle\n\nmiddleneedle\n');
        const b = await publishSave({ ...base, operation: 'update', contentBytes: middle,
          contentHash: sha(middle), provenance: { aliases: [],
            metadata: { category: 'middle-metadata' } } });
        assert(b.saved === true && readPendingSave({ ingressRoot, storeRoot,
          intentId: b.intentId }).published,
        'B publishes new bytes and metadata before its ACK');
        publication = await publishSave({ ...base, operation: 'update', contentBytes: first,
          contentHash: sha(first), provenance: { aliases: [], metadata: {} } });
        const supersededB = readPendingSave({ ingressRoot, storeRoot, intentId: b.intentId });
        assert(publication.saved === true && supersededB.superseded === true,
          'C restores A bytes while B metadata intent remains durable but superseded');
        publication.historicalIntentId = b.intentId;
      } else {
      let aliases = [];
      if (mode === 'same-bytes-alias') {
        const lexicalOriginalPath = path.join(root, 'origin.md');
        fs.writeFileSync(lexicalOriginalPath, first);
        const canonicalOriginalPath = fs.realpathSync.native(lexicalOriginalPath);
        aliases = [{ lexicalOriginalPath, canonicalOriginalPath,
          canonicalPathHash: sha(process.platform === 'win32'
            ? path.resolve(canonicalOriginalPath).toLowerCase() : path.resolve(canonicalOriginalPath)) }];
      }
      publication = await publishSave({ ...base, operation: 'update', contentBytes: newer,
        contentHash: sha(newer), provenance: { aliases, metadata:
          mode === 'same-bytes-metadata' ? { category: 'newer-metadata' } : {} } });
      }
      assert(publication.saved === true && readPendingSave({ ingressRoot, storeRoot,
        intentId: publication.intentId }).published,
      'same-locator Markdown and body-free intent publish while tokenizer is delayed');
    }
    const result = await job;
    const row = ledger.open().prepare('SELECT * FROM documents WHERE document_id = ?')
      .get(accepted.documentId);
    const chunks = ledger.open().prepare('SELECT COUNT(*) AS count FROM chunks WHERE document_id = ?')
      .get(accepted.documentId).count;
    if (mode === 'unchanged' || mode === 'large') {
      assert(result.completed === true && row.completed_revision === 1 && chunks > 0
        && keyword.search(mode === 'large' ? 'activeownerword' : 'oldneedle').length > 0,
      'unchanged document completes guarded source and keyword commit');
      if (mode === 'large') {
        assert(first.length >= 10 * 1024 * 1024 - 16 && guardedCommitMs <= 1000,
          `10 MiB guarded commit must finish within 1s; actual ${guardedCommitMs} ms`);
        console.log(JSON.stringify({ fixtureBytes: first.length, guardedCommitMs, chunks }));
      }
    } else {
      assert(result.completed === false && row.completed_revision === 0 && chunks === 0
        && keyword.search('oldneedle').length === 0
        && fs.readFileSync(path.join(storeRoot, 'same.md')).equals(newer),
      'old claim writes no stale chunks or keyword after newer publication');
      const next = readPendingSave({ ingressRoot, storeRoot, intentId: publication.intentId });
      const historical = publication.historicalIntentId
        ? [readPendingSave({ ingressRoot, storeRoot, intentId: publication.historicalIntentId })] : [];
      const acceptedNext = ledger.acceptSaveIntent({ current: next, historical, storeRoot,
        finalMetadata: {}, contentByteLength: newer.length,
        contentTextLength: newer.toString('utf8').length });
      const latest = ledger.open().prepare(`SELECT desired_revision, desired_content_hash, current_job_id
        FROM documents WHERE document_id = ?`).get(accepted.documentId);
      assert(acceptedNext.desiredRevision > 1 && latest.desired_revision === acceptedNext.desiredRevision
        && latest.desired_content_hash === `sha256:${sha(newer)}`
        && latest.current_job_id === acceptedNext.jobId,
      `${mode}: newer intent becomes the latest desired revision after old claim abort`);
      const nextClaim = ledger.claimDesiredJob({ documentId: accepted.documentId,
        desiredRevision: acceptedNext.desiredRevision });
      let nextPrepared;
      const nextResult = await runClaimedDesiredJob({ ledger, claim: nextClaim,
        storeRoot, ingressRoot,
        onValidated: async validated => {
          nextPrepared = await prepareValidatedDocument({ ledger, keyword, claim: nextClaim,
            storeRoot, validated });
          return nextPrepared ? null : { stale: true };
        },
        onFinalValidated: validated => commitPreparedDocument({ ledger, keyword,
          claim: nextClaim, storeRoot, validated, prepared: nextPrepared }) });
      const completed = ledger.open().prepare(`SELECT completed_revision, category FROM documents
        WHERE document_id = ?`).get(accepted.documentId);
      const aliasCount = ledger.open().prepare(`SELECT COUNT(*) AS count FROM document_source_aliases
        WHERE document_id = ?`).get(accepted.documentId).count;
      assert(nextResult.completed === true
        && completed.completed_revision === acceptedNext.desiredRevision
        && (mode !== 'new-bytes' || keyword.search('newneedle').length > 0)
        && (mode !== 'same-bytes-metadata' || completed.category === 'newer-metadata')
        && (mode !== 'same-bytes-alias' || aliasCount === 1)
        && (mode !== 'aba-metadata' || completed.category === 'middle-metadata'),
      `${mode}: only the newest accepted intent converges into derived state`);
    }
  } finally {
    keyword.close();
    ledger.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  for (const mode of ['unchanged', 'new-bytes', 'same-bytes-metadata',
    'same-bytes-alias', 'aba-metadata', 'large']) await runCase(mode);
  console.log('test-derived-prepare-guarded-commit: all assertions passed');
})().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
