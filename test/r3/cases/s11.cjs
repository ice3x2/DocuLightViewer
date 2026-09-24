'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { publishSave, readPendingSave } = require('../../../src/main/index-ingress-store');
const { SourceLedgerStore } = require('../../../src/main/source-ledger-store');
const { OwnerWorkerController } = require('../../../src/main/search-owner-controller');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// @req FR-DOC-019 REL-DOC-009
module.exports = { async run(context) {
  const root = context.fixture.root;
  const storeRoot = path.join(root, 'store');
  const ingressRoot = path.join(root, 'private');
  fs.mkdirSync(storeRoot);
  fs.mkdirSync(ingressRoot);
  const ledger = new SourceLedgerStore({ dbPath: path.join(root, 'ledger.sqlite') });
  ledger.initialize();
  const bodies = Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map(key =>
    [key, Buffer.from(`# ${key}\n`)]));
  try {
    const save = async (key, acknowledge = true) => {
      const bytes = bodies[key];
      const saved = await publishSave({ storeRoot, ingressRoot, sourceRelativeLocator: 'doc.md',
        operation: 'update', sourceId: 'source_fixture', rootFingerprint: sha(storeRoot),
        contentBytes: bytes, contentHash: sha(bytes), provenance: { aliases: [], metadata: {} } });
      if (!acknowledge) return saved;
      const current = readPendingSave({ ingressRoot, storeRoot, intentId: saved.intentId });
      return ledger.acceptSaveIntent({ current, storeRoot, finalMetadata: {},
        contentByteLength: bytes.length, contentTextLength: bytes.toString('utf8').length });
    };
    const row = () => ledger.open().prepare("SELECT * FROM documents WHERE relative_path = 'doc.md'").get();
    const job = id => ledger.open().prepare('SELECT * FROM index_jobs WHERE job_id = ?').get(id);
    const claimCurrent = () => ledger.claimDesiredJob({ documentId: row().document_id,
      desiredRevision: row().desired_revision });
    const a = await save('A');
    const claimA = claimCurrent();
    context.assert(claimA && claimA.requestedRevision === 1 && claimA.desiredContentHash === `sha256:${sha(bodies.A)}`,
      'claim captures requested revision and desired hash for completion guard');
    const { runClaimedDesiredJob } = require('../../../src/main/desired-job-processor');
    const aResult = await runClaimedDesiredJob({ ledger, claim: claimA, storeRoot, ingressRoot,
      onValidated: async input => {
        context.assert(input.content === bodies.A.toString('utf8') && input.hash === claimA.desiredContentHash,
          'downstream receives validated A bytes, hash and revision');
        await save('B');
      } });
    context.assert(aResult.completed === false && row().desired_revision === 2 && row().dirty === 1
      && job(claimA.jobId).status !== 'completed', 'old A terminal result cannot complete or clear B');
    const claimB = claimCurrent();
    const bResult = await runClaimedDesiredJob({ ledger, claim: claimB, storeRoot, ingressRoot,
      onValidated: async input => {
        context.assert(input.revision === 2 && input.content === bodies.B.toString('utf8'),
          'B processing uses current file bytes');
        await save('C');
      } });
    context.assert(bResult.completed === false && row().desired_revision === 3 && row().dirty === 1
      && job(claimB.jobId).status !== 'completed', 'B completion leaves newest C pending');
    const claimC = claimCurrent();
    await save('D', false);
    const changed = await runClaimedDesiredJob({ ledger, claim: claimC, storeRoot, ingressRoot,
      onValidated: async () => { context.assert(false, 'stale C must not reach downstream'); } });
    context.assert(changed.completed === false && row().desired_revision === 4
      && row().desired_content_hash === `sha256:${sha(bodies.D)}` && row().dirty === 1,
      'changed-after-ACK file assigns observed D one new desired revision');
    const repeat = ledger.observeClaimedFileMismatch({ claim: claimC,
      actualFileHash: `sha256:${sha(bodies.D)}`, contentByteLength: bodies.D.length,
      contentTextLength: bodies.D.length });
    context.assert(repeat?.desiredRevision === 4 && row().desired_revision === 4,
      'same observed mismatch cannot keep incrementing desired revision');
    const claimD = claimCurrent();
    const dResult = await runClaimedDesiredJob({ ledger, claim: claimD, storeRoot, ingressRoot,
      onValidated: async input => {
        context.assert(input.hash === `sha256:${sha(bodies.D)}` && input.documentId === a.documentId,
          'S12 handoff has current identity and hash');
      } });
    context.assert(dResult.completed === true && row().completed_revision === 4 && row().dirty === 0
      && row().keyword_dirty === 1 && job(claimD.jobId).status === 'completed'
      && ledger.getPendingDesiredPage().length === 0,
      'current D completion leaves derivative keyword work for S12');
    await save('F');
    const claimF = claimCurrent();
    const rejected = ledger.completeClaimedJob({ claim: claimF,
      actualFileHash: `sha256:${sha(bodies.D)}` });
    context.assert(rejected === false && row().desired_revision === 5 && row().dirty === 1
      && job(claimF.jobId).status === 'cancelled'
      && ledger.getPendingDesiredPage().some(item => item.documentId === a.documentId),
      'completion CAS rejects wrong actual hash and retains retryable F');
    const retryF = claimCurrent();
    const fResult = await runClaimedDesiredJob({ ledger, claim: retryF, storeRoot, ingressRoot,
      onValidated: async input => context.assert(input.content === bodies.F.toString('utf8'),
        'retry F uses actual file bytes') });
    context.assert(fResult.completed === true && row().completed_revision === 5,
      'current F retry completes after rejected hash');
    await save('G');
    const claimG = claimCurrent();
    ledger.updateIndexJob(claimG.jobId, { cancelRequested: true });
    const cancelRequested = await runClaimedDesiredJob({ ledger, claim: claimG, storeRoot, ingressRoot,
      onValidated: async () => { context.assert(false, 'cancel-requested G must not reach downstream'); } });
    context.assert(cancelRequested.completed === false && job(claimG.jobId).status === 'cancelled'
      && ledger.getPendingDesiredPage().length === 1 && row().completed_revision === 5,
      'same-claim cancel_requested cannot complete and leaves G retryable');
    const retryG = claimCurrent();
    const gResult = await runClaimedDesiredJob({ ledger, claim: retryG, storeRoot, ingressRoot,
      onValidated: async () => {} });
    context.assert(gResult.completed === true && row().completed_revision === 6,
      'cancelled G can be retried');
    await save('E');
    const claimE = claimCurrent();
    const cancelled = await runClaimedDesiredJob({ ledger, claim: claimE, storeRoot, ingressRoot,
      onValidated: async () => ({ cancelled: true }) });
    context.assert(cancelled.completed === false && job(claimE.jobId).status === 'cancelled'
      && row().dirty === 1 && ledger.getPendingDesiredPage().length === 1
      && fs.readFileSync(path.join(storeRoot, 'doc.md')).equals(bodies.E),
      'cancel retains E file and retryable dirty work');
    const retryE = claimCurrent();
    const failed = await runClaimedDesiredJob({ ledger, claim: retryE, storeRoot, ingressRoot,
      onValidated: async () => { throw new Error('injected downstream failure'); } });
    context.assert(failed.completed === false && job(retryE.jobId).status === 'failed'
      && row().dirty === 1 && ledger.getPendingDesiredPage().length === 1
      && fs.readFileSync(path.join(storeRoot, 'doc.md')).equals(bodies.E),
      'failure retains E file and retryable dirty work');
    const gapPath = path.join(storeRoot, 'gap.md');
    const gapInput = { storeRoot, ingressRoot, sourceRelativeLocator: 'gap.md', operation: 'update',
      sourceId: 'source_fixture', rootFingerprint: sha(storeRoot), provenance: { aliases: [], metadata: {} } };
    const gapA = await publishSave({ ...gapInput, contentBytes: bodies.A, contentHash: sha(bodies.A) });
    const gapAIntent = readPendingSave({ ingressRoot, storeRoot, intentId: gapA.intentId });
    const gapAck = ledger.acceptSaveIntent({ current: gapAIntent, storeRoot, finalMetadata: {},
      contentByteLength: bodies.A.length, contentTextLength: bodies.A.length });
    const gapClaim = ledger.claimDesiredJob({ documentId: gapAck.documentId, desiredRevision: 1 });
    let gapPublication;
    let guardedAtGap = false;
    const gapChild = fork(path.join(__dirname, '../fixtures/s11-publisher.cjs'), [], { silent: true });
    const childMessage = type => new Promise((resolve, reject) => {
      const listener = message => {
        if (message.type !== type && message.type !== 'failed') return;
        gapChild.off('message', listener);
        if (message.type === 'failed') reject(new Error(`publisher failed: ${message.code}`));
        else resolve(message);
      };
      gapChild.on('message', listener);
    });
    let gapB;
    try {
      await childMessage('ready');
      const gapResult = await runClaimedDesiredJob({ ledger, claim: gapClaim, storeRoot, ingressRoot,
        onValidated: async () => {},
        afterFinalRead: async () => {
          const locked = fs.existsSync(path.join(ingressRoot, '.publication.lock'));
          gapPublication = childMessage('published');
          const attempting = childMessage('attempting');
          gapChild.send({ type: 'publish', input: { ...gapInput, contentHash: sha(bodies.B) },
            bodyBase64: bodies.B.toString('base64') });
          await attempting;
          if (!locked) await gapPublication;
          guardedAtGap = fs.readFileSync(gapPath).equals(bodies.A);
        } });
      context.assert(guardedAtGap && gapResult.completed === true,
        'root publication gate keeps A file current through final-read completion CAS');
      gapB = (await gapPublication).saved;
    } finally {
      if (gapChild.connected) gapChild.disconnect();
    }
    const gapBIntent = readPendingSave({ ingressRoot, storeRoot, intentId: gapB.intentId });
    const gapBAck = ledger.acceptSaveIntent({ current: gapBIntent, storeRoot, finalMetadata: {},
      contentByteLength: bodies.B.length, contentTextLength: bodies.B.length });
    const gapRow = ledger.open().prepare('SELECT * FROM documents WHERE document_id = ?').get(gapAck.documentId);
    context.assert(gapBAck.desiredRevision === 2 && gapRow.dirty === 1
      && gapRow.current_job_id === gapBAck.jobId && fs.readFileSync(gapPath).equals(bodies.B),
      'post-CAS publication becomes a newer pending revision');
  } finally { ledger.close(); }
  let olderWinnerJobId;
  let currentWinnerJobId;
  const restarted = new SourceLedgerStore({ dbPath: path.join(root, 'ledger.sqlite') });
  try {
    const { runClaimedDesiredJob } = require('../../../src/main/desired-job-processor');
    const doc = restarted.open().prepare("SELECT * FROM documents WHERE relative_path = 'doc.md'").get();
    const claim = restarted.claimDesiredJob({ documentId: doc.document_id,
      desiredRevision: doc.desired_revision });
    const result = await runClaimedDesiredJob({ ledger: restarted, claim, storeRoot, ingressRoot,
      onValidated: async input => context.assert(input.content === '# E\n',
        'restart retry reads saved E file') });
    const final = restarted.open().prepare('SELECT * FROM documents WHERE document_id = ?').get(doc.document_id);
    context.assert(result.completed === true && final.completed_revision === final.desired_revision
      && final.dirty === 0 && fs.readFileSync(path.join(storeRoot, 'doc.md')).equals(bodies.E),
      'restart completes retry without rolling back user file');
    const h = await publishSave({ storeRoot, ingressRoot, sourceRelativeLocator: 'restart.md',
      operation: 'update', sourceId: 'source_fixture', rootFingerprint: sha(storeRoot),
      contentBytes: bodies.H, contentHash: sha(bodies.H), provenance: { aliases: [], metadata: {} } });
    const hIntent = readPendingSave({ ingressRoot, storeRoot, intentId: h.intentId });
    const hAck = restarted.acceptSaveIntent({ current: hIntent, storeRoot, finalMetadata: {},
      contentByteLength: bodies.H.length, contentTextLength: bodies.H.length });
    const hClaim = restarted.claimDesiredJob({ documentId: hAck.documentId,
      desiredRevision: hAck.desiredRevision });
    context.assert(hClaim && !restarted.getPendingDesiredPage().some(item => item.documentId === hAck.documentId)
      && typeof restarted.reconcileInterruptedDesiredPage === 'function',
      'abrupt indexing claim has owner startup recovery contract');
    const winnerInput = { storeRoot, ingressRoot, sourceRelativeLocator: 'winner.md',
      operation: 'update', sourceId: 'source_fixture', rootFingerprint: sha(storeRoot),
      provenance: { aliases: [], metadata: {} } };
    const winnerA = await publishSave({ ...winnerInput, contentBytes: bodies.C, contentHash: sha(bodies.C) });
    const winnerAIntent = readPendingSave({ ingressRoot, storeRoot, intentId: winnerA.intentId });
    const winnerAAck = restarted.acceptSaveIntent({ current: winnerAIntent, storeRoot,
      finalMetadata: {}, contentByteLength: bodies.C.length, contentTextLength: bodies.C.length });
    olderWinnerJobId = restarted.claimDesiredJob({ documentId: winnerAAck.documentId,
      desiredRevision: 1 }).jobId;
    const winnerB = await publishSave({ ...winnerInput, contentBytes: bodies.D, contentHash: sha(bodies.D) });
    const winnerBIntent = readPendingSave({ ingressRoot, storeRoot, intentId: winnerB.intentId });
    currentWinnerJobId = restarted.acceptSaveIntent({ current: winnerBIntent, storeRoot,
      finalMetadata: {}, contentByteLength: bodies.D.length, contentTextLength: bodies.D.length }).jobId;
    restarted.enqueueIndexJob({ jobId: 'job_keyword_rebuild_fixture', jobType: 'keyword_rebuild',
      status: 'indexing', requestedBy: 'settings' });
  } finally { restarted.close(); }
  const owner = new OwnerWorkerController({ ledgerPath: path.join(root, 'ledger.sqlite'),
    keywordPath: path.join(root, 'keyword.sqlite'), sourceRoot: storeRoot,
    keywordTokenizerProvider: 'basic' });
  try { await owner.start(); } finally { await owner.shutdown(); }
  const recoveredLedger = new SourceLedgerStore({ dbPath: path.join(root, 'ledger.sqlite') });
  try {
    const pending = recoveredLedger.getPendingDesiredPage();
    const hRow = recoveredLedger.open().prepare("SELECT * FROM documents WHERE relative_path = 'restart.md'").get();
    context.assert(pending.some(item => item.documentId === hRow.document_id)
      && hRow.dirty === 1 && fs.readFileSync(path.join(storeRoot, 'restart.md')).equals(bodies.H),
      'owner restart makes abrupt claim pending without deleting H file');
    const winnerRow = recoveredLedger.open().prepare("SELECT * FROM documents WHERE relative_path = 'winner.md'").get();
    const oldWinner = recoveredLedger.open().prepare('SELECT * FROM index_jobs WHERE job_id = ?').get(olderWinnerJobId);
    context.assert(winnerRow.current_job_id === currentWinnerJobId && winnerRow.desired_revision === 2
      && pending.some(item => item.documentId === winnerRow.document_id)
      && oldWinner.status === 'cancelled' && fs.readFileSync(path.join(storeRoot, 'winner.md')).equals(bodies.D),
      'startup reconciliation cancels older claim without replacing latest queued winner');
    const keywordJob = recoveredLedger.open().prepare('SELECT status FROM index_jobs WHERE job_id = ?')
      .get('job_keyword_rebuild_fixture');
    context.assert(keywordJob.status === 'indexing',
      'document recovery never mutates unrelated keyword rebuild indexing job');
  } finally { recoveredLedger.close(); }
} };
