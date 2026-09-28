'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runClaimedDesiredJob } = require('../src/main/desired-job-processor');
const { publishSave, readPendingSave } = require('../src/main/index-ingress-store');

// @req REL-DOC-009 AC-1 AC-3 FR-DOC-019 AC-2
async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-publication-witness-'));
  const storeRoot = path.join(root, 'store');
  const ingressRoot = path.join(root, 'ingress');
  fs.mkdirSync(storeRoot);
  fs.mkdirSync(ingressRoot);
  const bytes = Buffer.from('# Identical Markdown bytes\n');
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  fs.writeFileSync(path.join(storeRoot, 'same.md'), bytes);
  const claim = { documentId: 'doc_same', jobId: 'job_old', requestedRevision: 1,
    desiredContentHash: `sha256:${sha(bytes)}` };
  let completeCalls = 0;
  const ledger = {
    open: () => ({ prepare: sql => ({ get: () => sql.includes('FROM documents')
      ? { relativePath: 'same.md', metadataJson: '{}', sourceRoot: storeRoot,
        sourceKind: 'save_document' } : { cancel_requested: 0 } }) }),
    failClaimedJob: () => {},
    completeClaimedJob: () => { completeCalls += 1; return true; }
  };
  try {
    const result = await runClaimedDesiredJob({ ledger, claim, storeRoot, ingressRoot,
      onValidated: async () => {
        await new Promise(resolve => setTimeout(resolve, 1200));
        const published = await publishSave({ storeRoot, ingressRoot,
          operation: 'update', sourceId: 'src_same',
          rootFingerprint: sha(path.resolve(storeRoot)), sourceRelativeLocator: 'same.md',
          contentBytes: bytes, contentHash: sha(bytes),
          provenance: { aliases: [], metadata: { category: 'newer-metadata' } } });
        assert(published.saved === true && readPendingSave({ ingressRoot, storeRoot,
          intentId: published.intentId }).published === true,
        'same-byte newer metadata has a durable published intent before old commit');
      } });
    assert(result.completed === false && completeCalls === 0,
      'old claim cannot commit across same-byte newer metadata publication before ACK');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().then(() => console.log('test-desired-job-publication-witness: all assertions passed'),
  error => { console.error(error.message); process.exitCode = 1; });
