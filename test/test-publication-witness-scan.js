'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { publishSave, readPendingSave, withLocatorGate,
  hasUnacceptedPublishedLocatorIntent } = require('../src/main/index-ingress-store');

// @req REL-DOC-009 AC-5 FR-DOC-019 AC-2
async function run() {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, 'doculight-witness-scan-'));
  const storeRoot = path.join(root, 'store');
  const ingressRoot = path.join(root, 'ingress');
  fs.mkdirSync(storeRoot);
  fs.mkdirSync(ingressRoot);
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  const bytes = Buffer.from('# same small document\n');
  const base = { storeRoot, ingressRoot, sourceId: 'src_scan',
    rootFingerprint: sha(path.resolve(storeRoot)), operation: 'save_document',
    contentBytes: bytes, contentHash: sha(bytes),
    provenance: { aliases: [], metadata: {} } };
  try {
    const target = await publishSave({ ...base, sourceRelativeLocator: 'target.md' });
    assert(target.saved === true, 'one real seed intent and Markdown are published');
    const seed = JSON.parse(fs.readFileSync(path.join(ingressRoot,
      `${target.intentId}.intent.json`), 'utf8'));
    for (let index = 1; index < 1024; index++) {
      const identity = { operation: seed.operation, sourceId: seed.sourceId,
        rootFingerprint: seed.rootFingerprint, sourceRelativeLocator: `other-${index}.md`,
        contentHash: seed.contentHash, provenance: seed.provenance };
      const publicationOrder = index + 1;
      const intentId = sha(JSON.stringify({ ...identity, publicationOrder }));
      const fields = { schemaVersion: 1, intentId, ...identity,
        rootIdentity: seed.rootIdentity, createdTime: seed.createdTime, publicationOrder };
      const record = { ...fields, checksum: sha(JSON.stringify(fields)) };
      fs.writeFileSync(path.join(ingressRoot, `${intentId}.intent.json`), JSON.stringify(record));
      const parsed = readPendingSave({ ingressRoot, storeRoot, intentId });
      assert(parsed?.intentId === intentId && parsed.published === false,
        `unrelated synthetic intent ${index} passes the production parser`);
    }
    assert(fs.readdirSync(ingressRoot).filter(name => name.endsWith('.intent.json')).length === 1024,
      'capacity fixture has 1024 checksum-valid intent records');
    const started = performance.now();
    const stale = await withLocatorGate(ingressRoot, storeRoot, 'target.md', () =>
      hasUnacceptedPublishedLocatorIntent({ ingressRoot, storeRoot,
        locator: 'target.md', expectedContentHash: `sha256:${sha(bytes)}`,
        hasReceipt: () => false }));
    const scanMs = performance.now() - started;
    assert(stale === false && scanMs <= 1000,
      `1024-intent guarded witness scan must stay within 1s; actual ${scanMs} ms`);
    console.log(JSON.stringify({ intentCount: 1024, scanMs }));
  } finally {
    const resolved = fs.realpathSync.native(root);
    assert.strictEqual(path.dirname(resolved).toLowerCase(), tempRoot.toLowerCase(),
      'only the owned direct temp child may be removed');
    fs.rmSync(root, { recursive: true });
  }
}

run().then(() => console.log('test-publication-witness-scan: all assertions passed'),
  error => { console.error(error.stack || String(error)); process.exitCode = 1; });
