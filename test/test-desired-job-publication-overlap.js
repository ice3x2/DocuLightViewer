'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runClaimedDesiredJob } = require('../src/main/desired-job-processor');
const { publishSave, readPendingSave, locatorGateName } = require('../src/main/index-ingress-store');

// @req REL-DOC-009 AC-2 AC-4 IR-APP-013 AC-13 REL-DOC-007 AC-2
async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-pg04-overlap-'));
  const storeRoot = path.join(root, 'store');
  const ingressRoot = path.join(root, 'ingress');
  fs.mkdirSync(storeRoot);
  fs.mkdirSync(ingressRoot);
  const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const first = Buffer.from('# First indexed document\n');
  const second = Buffer.from('# Second saved during derivation\n');
  fs.writeFileSync(path.join(storeRoot, 'first.md'), first);
  const claim = { documentId: 'doc_first', jobId: 'job_first', requestedRevision: 1,
    desiredContentHash: `sha256:${sha(first)}` };
  const ledger = {
    open: () => ({ prepare: sql => ({ get: () => sql.includes('FROM documents')
      ? { relativePath: 'first.md', metadataJson: '{}', sourceRoot: storeRoot,
        sourceKind: 'save_document' } : { cancel_requested: 0 } }) }),
    failClaimedJob: () => {}, completeClaimedJob: () => true
  };
  let entered;
  const deriving = new Promise(resolve => { entered = resolve; });
  let release;
  const continueDerivation = new Promise(resolve => { release = resolve; });
  let job;
  try {
    job = runClaimedDesiredJob({ ledger, claim, storeRoot, ingressRoot,
      onValidated: async () => null,
      onFinalValidated: async () => { entered(); await continueDerivation; return true; } });
    await Promise.race([deriving, new Promise((_, reject) => setTimeout(() =>
      reject(new Error('fixture did not reach active derivation')), 2000))]);
    let publication;
    let failure;
    try {
      publication = await publishSave({ storeRoot, ingressRoot,
        operation: 'save_document', sourceId: 'src_second',
        rootFingerprint: sha(path.resolve(storeRoot)), sourceRelativeLocator: 'second.md',
        contentBytes: second, contentHash: sha(second),
        provenance: { aliases: [], metadata: {} } });
    } catch (error) { failure = error; }
    assert(publication?.saved === true && !failure,
      `second publication must proceed during derivation; actual ${failure?.code || 'missing'}`);
    assert(fs.readFileSync(path.join(storeRoot, 'second.md')).equals(second)
      && readPendingSave({ ingressRoot, storeRoot,
        intentId: publication.intentId }).published === true,
    'second Markdown and body-free intent remain durable');
    const update = Buffer.from('# First document newer revision\n');
    const updateInput = { storeRoot, ingressRoot, operation: 'update',
      sourceId: 'src_first', rootFingerprint: sha(path.resolve(storeRoot)),
      sourceRelativeLocator: 'first.md', contentBytes: update, contentHash: sha(update),
      provenance: { aliases: [], metadata: {} } };
    let blocked;
    try { await publishSave(updateInput); }
    catch (error) { blocked = error.code; }
    assert.strictEqual(blocked, 'publication_busy',
      'same-locator update waits behind active final-read/commit');
    assert(fs.readFileSync(path.join(storeRoot, 'first.md')).equals(first),
      'old job reads the same bytes through its completion CAS');
    release();
    await job;
    const next = await publishSave(updateInput);
    assert(next.saved === true && fs.readFileSync(path.join(storeRoot, 'first.md')).equals(update)
      && readPendingSave({ ingressRoot, storeRoot, intentId: next.intentId }).published,
    'next revision publishes after old completion and remains durable');
    const deadLocator = 'recovered.md';
    const deadLock = path.join(ingressRoot, locatorGateName(storeRoot, deadLocator));
    fs.writeFileSync(deadLock, JSON.stringify({ pid: 99999999, token: 'dead-owner' }));
    const recovered = await publishSave({ ...updateInput, sourceRelativeLocator: deadLocator });
    assert(recovered.saved === true && !fs.existsSync(deadLock),
      'restart recovers only a proven dead per-locator owner');
  } finally {
    release();
    if (job) await job;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().then(() => console.log('test-desired-job-publication-overlap: all assertions passed'),
  error => { console.error(error.message); process.exitCode = 1; });
