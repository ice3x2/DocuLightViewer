'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SearchEngine } = require('../src/main/search-engine');

const DOCUMENT_COUNT = 4;
const DOCUMENT_BODY_BYTES = 2 * 1024 * 1024;

function contentHash(content) {
  return `sha256:${crypto.createHash('sha256').update(String(content)).digest('hex')}`;
}

function createStore(sourceRoot) {
  return {
    get(key, defaultValue) {
      if (key === 'mcpAutoSavePath') return sourceRoot;
      return defaultValue;
    }
  };
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-startup-recovery-memory-'));
  const sourceRoot = path.join(tmp, 'docs');
  const indexDataDir = path.join(tmp, 'userData', 'index');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(indexDataDir, { recursive: true });
  const workerInputs = [];
  const controller = {
    enqueueSemanticDocument(input) {
      workerInputs.push(input);
      return { started: true, promise: Promise.resolve({ completed: true }) };
    },
    getStatus() {
      return null;
    },
    close() {}
  };
  const engine = new SearchEngine(createStore(sourceRoot), {
    indexBackend: 'sqlite',
    indexDataDir,
    smartIndexDelayMs: 60000,
    indexingWorkerController: controller
  });

  try {
    const ledger = engine._getSourceLedger();
    const expectedHashes = new Map();
    for (let index = 0; index < DOCUMENT_COUNT; index += 1) {
      const filePath = path.join(sourceRoot, `recover-${index}.md`);
      const content = `# Recover ${index}\n\n${String(index).repeat(DOCUMENT_BODY_BYTES)}`;
      fs.writeFileSync(filePath, content, 'utf8');
      const document = engine.recordSavedDocument({ filePath, content });
      const hash = contentHash(content);
      const jobId = `startup-recover-${index}`;
      expectedHashes.set(jobId, hash);
      ledger.enqueueIndexJob({
        jobId,
        sourceId: document.sourceId,
        documentId: document.documentId,
        jobType: 'index_document',
        status: 'queued',
        requestedBy: 'test.startup.memory',
        currentPathInternal: filePath,
        contentHash: hash
      });
    }

    const mismatchPath = path.join(sourceRoot, 'mismatch.md');
    const mismatchContent = '# Mismatch\n\nchanged content';
    fs.writeFileSync(mismatchPath, mismatchContent, 'utf8');
    const mismatchDocument = engine.recordSavedDocument({ filePath: mismatchPath, content: mismatchContent });
    ledger.enqueueIndexJob({
      jobId: 'startup-mismatch',
      sourceId: mismatchDocument.sourceId,
      documentId: mismatchDocument.documentId,
      jobType: 'index_document',
      status: 'queued',
      requestedBy: 'test.startup.memory',
      currentPathInternal: mismatchPath,
      contentHash: contentHash('stale content')
    });

    const fallbackPath = path.join(sourceRoot, 'fallback-without-document-id.md');
    const fallbackContent = '# Fallback\n\n' + 'fallback-body\n'.repeat(20000);
    const fallbackHash = contentHash(fallbackContent);
    fs.writeFileSync(fallbackPath, fallbackContent, 'utf8');
    expectedHashes.set('startup-fallback', fallbackHash);
    ledger.enqueueIndexJob({
      jobId: 'startup-fallback',
      jobType: 'index_document',
      status: 'queued',
      requestedBy: 'test.startup.memory.fallback',
      currentPathInternal: fallbackPath,
      contentHash: fallbackHash
    });

    const result = await engine.reconcileStartupIndexJobsAsync({ activeHeartbeatMs: 0 });
    assert.strictEqual(result.examined, DOCUMENT_COUNT + 2, 'startup recovery examines every recoverable job');
    assert.strictEqual(result.resumed, DOCUMENT_COUNT + 1, 'startup recovery resumes known and identity-fallback jobs');
    assert.strictEqual(result.failed, 1, 'startup recovery preserves content-hash mismatch failure');
    assert.strictEqual(engine._smartIndexQueue.size, DOCUMENT_COUNT + 1, 'only matching jobs enter the smart index queue');

    let retainedContentBytes = 0;
    for (const item of engine._smartIndexQueue.values()) {
      if (typeof item.content === 'string') retainedContentBytes += Buffer.byteLength(item.content, 'utf8');
      assert.strictEqual(item.content, null, 'startup queue retains no verified Markdown body');
      assert(expectedHashes.has(item.jobId), `startup queue preserves recoverable jobId ${item.jobId}`);
      assert.strictEqual(ledger.getIndexJob(item.jobId).contentHash, expectedHashes.get(item.jobId), 'startup resume preserves the verified durable content hash');
    }
    assert.strictEqual(retainedContentBytes, 0, 'queued payload memory is independent of recovered document body bytes');

    await engine._performSmartIndexDrain();
    assert.strictEqual(workerInputs.length, DOCUMENT_COUNT + 1, 'every recovered item reaches the worker boundary');
    assert(workerInputs.every((input) => input.content === null), 'worker inputs request lazy UTF-8 file loading instead of carrying startup bodies');
    assert.strictEqual(engine._smartIndexQueue.size, 0, 'worker drain removes recovered queue entries');

    const mismatchJob = ledger.getIndexJob('startup-mismatch');
    assert.strictEqual(mismatchJob.status, 'failed', 'mismatched startup job remains failed');
    assert.strictEqual(mismatchJob.diagnosticCode, 'content_hash_changed', 'mismatch diagnostic remains specific');

    console.log(JSON.stringify({
      test: 'test-startup-index-recovery-memory-contract',
      recoveredDocuments: DOCUMENT_COUNT,
      sourceBodyMiB: Number((DOCUMENT_COUNT * DOCUMENT_BODY_BYTES / 1024 / 1024).toFixed(2)),
      retainedContentBytes,
      workerInputs: workerInputs.length
    }));
  } finally {
    engine.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
