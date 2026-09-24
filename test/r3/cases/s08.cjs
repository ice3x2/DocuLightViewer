'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { publishSave, readPendingSave } = require('../../../src/main/index-ingress-store');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const pathHash = value => sha(process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
const rejection = async (work, code, context) => {
  const error = await work().then(() => null, value => value);
  context.assert(error?.code === code, `expected ${code} rejection`);
};

// @req REL-DOC-009 FR-DOC-019 FR-DOC-028 DR-DOC-014
module.exports = { async run(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s08-'));
  const storeRoot = path.join(root, 'documents');
  const ingressRoot = path.join(root, 'private');
  fs.mkdirSync(storeRoot);
  fs.mkdirSync(ingressRoot);
  const body = Buffer.from('---\ntitle: fixture\n---\n# Saved content\n', 'utf8');
  const origin = path.join(root, 'origin', 'lexical.md');
  const input = {
    storeRoot, ingressRoot, sourceRelativeLocator: 'notes/final.md',
    contentBytes: body, contentHash: sha(body), operation: 'save_document',
    sourceId: 'source_fixture', rootFingerprint: sha(storeRoot),
    provenance: { aliases: [{ lexicalOriginalPath: origin, canonicalOriginalPath: origin, canonicalPathHash: pathHash(origin) }],
      metadata: { category: 'manual', documentTags: ['x'] } }
  };
  try {
    await rejection(() => publishSave({ ...input, contentHash: '0'.repeat(64) }), 'content_hash_mismatch', context);
    context.assert(!fs.existsSync(path.join(storeRoot, 'notes', 'final.md')), 'hash mismatch leaves no final file');
    for (const point of ['intent_temp_write', 'intent_temp_flush', 'intent_rename', 'document_temp_write', 'document_temp_flush', 'document_rename']) {
      const locator = `fault/${point}.md`;
      await rejection(() => publishSave({ ...input, sourceRelativeLocator: locator, faultAt: point }), 'fault_injected', context);
      context.assert(!fs.existsSync(path.join(storeRoot, locator)), `${point} has no final file`);
    }
    const prePublish = await publishSave({ ...input, sourceRelativeLocator: 'fault/document_rename.md' });
    context.assert(fs.readFileSync(path.join(storeRoot, 'fault', 'document_rename.md')).equals(body),
      'pre-publication intent can publish the same final bytes on retry');
    context.assert(readPendingSave({ ingressRoot, storeRoot, intentId: prePublish.intentId }).published,
      'replayed intent becomes published without a second intent');
    const saved = await publishSave(input);
    const finalPath = path.join(storeRoot, 'notes', 'final.md');
    context.assert(fs.readFileSync(finalPath).equals(body), 'published final bytes equal ephemeral input');
    context.assert(saved.saved === true && saved.indexing.state === 'enqueue_failed' && !saved.indexing.jobId,
      'pre-ACK publication never claims a queued job');
    const pending = readPendingSave({ ingressRoot, storeRoot, intentId: saved.intentId });
    context.assert(pending?.contentHash === sha(body) && pending?.provenance.aliases[0].lexicalOriginalPath === origin,
      'restart can recover exact hash and lexical origin');
    context.assert(pending.provenance.metadata.category === 'manual', 'private metadata survives restart');
    const raw = fs.readFileSync(pending.intentPath, 'utf8');
    context.assert(!raw.includes('# Saved content') && !raw.includes(body.toString('base64')), 'intent is body free');
    context.assert(!JSON.stringify(saved).includes(origin), 'public result redacts origin');
    const replay = await publishSave(input);
    context.assert(replay.intentId === saved.intentId && fs.readFileSync(finalPath).equals(body), 'replay reuses published identity');
    context.assert(fs.readdirSync(path.dirname(pending.intentPath)).filter(name => name === `${saved.intentId}.intent.json`).length === 1,
      'replay does not duplicate intent');
    await rejection(() => publishSave({ ...input, sourceRelativeLocator: 'fault/post_publish.md', faultAt: 'post_publish' }), 'fault_injected', context);
    context.assert(fs.existsSync(path.join(storeRoot, 'fault', 'post_publish.md')),
      'post-publication failure retains final file');
    const postPublish = await publishSave({ ...input, sourceRelativeLocator: 'fault/post_publish.md' });
    context.assert(readPendingSave({ ingressRoot, storeRoot, intentId: postPublish.intentId }).published,
      'post-publication fault can restart from its durable private intent');
    const alternateOrigin = path.join(root, 'origin', 'different.md');
    const alternate = await publishSave({ ...input, sourceRelativeLocator: 'notes/other.md',
      provenance: { aliases: [{ lexicalOriginalPath: alternateOrigin, canonicalOriginalPath: alternateOrigin,
        canonicalPathHash: pathHash(alternateOrigin) }], metadata: input.provenance.metadata } });
    context.assert(alternate.intentId !== saved.intentId, 'different original identity has a different intent');
    const poisonId = 'a'.repeat(64);
    const poisonPath = path.join(ingressRoot, `${poisonId}.intent.json`);
    fs.writeFileSync(poisonPath, Buffer.alloc(70 * 1024, 65));
    const oversized = (() => { try { return readPendingSave({ ingressRoot, storeRoot, intentId: poisonId }); } catch { return null; } })();
    context.assert(oversized?.quarantined === true && oversized.diagnosticCode === 'invalid_intent',
      'oversized private intent is quarantined with bounded diagnostic');
    context.assert(!fs.existsSync(poisonPath) && fs.readFileSync(finalPath).equals(body),
      'quarantine leaves published user file intact');
    const tamperedId = 'b'.repeat(64);
    const tamperedPath = path.join(ingressRoot, `${tamperedId}.intent.json`);
    const tampered = { ...JSON.parse(raw), intentId: tamperedId, schemaVersion: 2 };
    const { checksum: ignored, ...tamperedFields } = tampered;
    tampered.checksum = sha(Buffer.from(JSON.stringify(tamperedFields)));
    fs.writeFileSync(tamperedPath, JSON.stringify(tampered));
    const unknown = (() => { try { return readPendingSave({ ingressRoot, storeRoot, intentId: tamperedId }); } catch { return null; } })();
    context.assert(unknown?.quarantined === true && !fs.existsSync(tamperedPath),
      'unknown schema is not executable even with a matching checksum');
    const malicious = { ...JSON.parse(raw), provenance: { aliases: [], metadata: { credential: 'secret' } } };
    const maliciousIdentity = { operation: malicious.operation, sourceId: malicious.sourceId,
      rootFingerprint: malicious.rootFingerprint, sourceRelativeLocator: malicious.sourceRelativeLocator,
      contentHash: malicious.contentHash, provenance: malicious.provenance };
    malicious.intentId = sha(Buffer.from(JSON.stringify(maliciousIdentity)));
    const { checksum: oldChecksum, ...maliciousFields } = malicious;
    malicious.checksum = sha(Buffer.from(JSON.stringify(maliciousFields)));
    const maliciousPath = path.join(ingressRoot, `${malicious.intentId}.intent.json`);
    fs.writeFileSync(maliciousPath, JSON.stringify(malicious));
    const unsafe = readPendingSave({ ingressRoot, storeRoot, intentId: malicious.intentId });
    context.assert(unsafe?.quarantined === true && !fs.existsSync(maliciousPath),
      'checksum-valid but unsafe private provenance is quarantined');
    const movedStore = path.join(root, 'moved-store');
    const replacementInput = { ...input, storeRoot: path.join(root, 'replace-store'),
      ingressRoot: path.join(root, 'replace-private'), sourceRelativeLocator: 'pending.md' };
    fs.mkdirSync(replacementInput.storeRoot);
    fs.mkdirSync(replacementInput.ingressRoot);
    replacementInput.rootFingerprint = sha(replacementInput.storeRoot);
    await rejection(() => publishSave({ ...replacementInput, faultAt: 'document_rename' }), 'fault_injected', context);
    const pendingId = fs.readdirSync(replacementInput.ingressRoot)
      .find(name => name.endsWith('.intent.json')).slice(0, 64);
    fs.renameSync(replacementInput.storeRoot, movedStore);
    fs.mkdirSync(replacementInput.storeRoot);
    const replacedRoot = readPendingSave({ ingressRoot: replacementInput.ingressRoot,
      storeRoot: replacementInput.storeRoot, intentId: pendingId });
    context.assert(replacedRoot?.quarantined === true, 'same lexical root replaced with different directory identity cannot replay');
    const capacityRoot = path.join(root, 'capacity-private');
    fs.mkdirSync(capacityRoot);
    for (let index = 0; index < 1024; index += 1) {
      fs.writeFileSync(path.join(capacityRoot, `${String(index).padStart(4, '0')}.intent.json`), 'x');
    }
    await rejection(() => publishSave({ ...input, ingressRoot: capacityRoot,
      sourceRelativeLocator: 'capacity/blocked.md' }), 'ingress_capacity', context);
    context.assert(!fs.existsSync(path.join(storeRoot, 'capacity', 'blocked.md')),
      'full private ingress does not publish a final file');
    const mountLikeDir = path.join(storeRoot, 'mount-like');
    fs.mkdirSync(mountLikeDir);
    const originalStat = fs.statSync;
    let volumeFailure;
    try {
      fs.statSync = function(file, ...options) {
        const stat = originalStat.call(this, file, ...options);
        if (path.resolve(file) === mountLikeDir) stat.dev += 1;
        return stat;
      };
      volumeFailure = await publishSave({ ...input, sourceRelativeLocator: 'mount-like/blocked.md' })
        .then(() => null, error => error);
    } finally { fs.statSync = originalStat; }
    context.assert(volumeFailure?.code === 'path_policy_violation',
      'destination parent on a different reported volume is rejected');
    context.assert(!fs.existsSync(path.join(mountLikeDir, 'blocked.md')),
      'cross-volume destination has no published file');
    const updatedBody = Buffer.from('# Updated same document\n');
    const updatedOrigin = path.join(root, 'origin', 'updated.md');
    const update = { ...input, operation: 'update', contentBytes: updatedBody, contentHash: sha(updatedBody),
      provenance: { aliases: [{ lexicalOriginalPath: updatedOrigin, canonicalOriginalPath: updatedOrigin,
        canonicalPathHash: pathHash(updatedOrigin) }], metadata: { category: 'updated' } } };
    await rejection(() => publishSave({ ...update, faultAt: 'document_rename' }), 'fault_injected', context);
    context.assert(fs.readFileSync(finalPath).equals(body), 'pre-rename update fault preserves old final bytes');
    const updated = await publishSave(update).catch(() => null);
    context.assert(updated?.saved === true && fs.readFileSync(finalPath).equals(updatedBody),
      'retry atomically replaces same document with new bytes');
    context.assert(updated.intentId !== saved.intentId, 'new content has a distinct retryable intent');
    const oldAfterUpdate = readPendingSave({ ingressRoot, storeRoot, intentId: saved.intentId });
    context.assert(oldAfterUpdate?.superseded === true && oldAfterUpdate?.published === false
      && oldAfterUpdate.provenance.aliases[0].lexicalOriginalPath === origin,
    'older pending intent stays readable with original alias while new final bytes supersede it');
    context.assert(fs.existsSync(pending.intentPath), 'valid older pending intent is not quarantined or deleted');
    const originalRead = fs.readSync;
    let transient;
    try {
      fs.readSync = () => { throw Object.assign(new Error('transient'), { code: 'EBUSY' }); };
      transient = readPendingSave({ ingressRoot, storeRoot, intentId: saved.intentId });
    } finally { fs.readSync = originalRead; }
    context.assert(transient?.retryable === true && transient?.diagnosticCode === 'intent_io_retryable',
      'transient read failure produces a stable retryable diagnostic');
    context.assert(fs.existsSync(pending.intentPath), 'transient read failure retains private intent');
    const hugePath = path.join(storeRoot, 'notes', 'huge.md');
    fs.writeFileSync(hugePath, Buffer.alloc(10 * 1024 * 1024 + 1, 65));
    const hugeInput = { ...input, sourceRelativeLocator: 'notes/huge.md' };
    const originalReadFile = fs.readFileSync;
    let hugeFailure;
    let hugePending;
    try {
      fs.readFileSync = function(file, ...options) {
        if (path.resolve(file) === hugePath) throw Object.assign(new Error('unbounded read'), { code: 'UNBOUNDED_READ' });
        return originalReadFile.call(this, file, ...options);
      };
      hugeFailure = await publishSave(hugeInput).then(() => null, error => error);
      const hugeIntentId = fs.readdirSync(ingressRoot).filter(name => name.endsWith('.intent.json'))
        .map(name => JSON.parse(fs.readFileSync(path.join(ingressRoot, name), 'utf8')))
        .find(record => record.sourceRelativeLocator === 'notes/huge.md')?.intentId;
      hugePending = readPendingSave({ ingressRoot, storeRoot, intentId: hugeIntentId });
    } finally { fs.readFileSync = originalReadFile; }
    context.assert(hugeFailure?.code === 'published_file_mismatch', 'oversized existing final is rejected without full read');
    context.assert(hugePending?.superseded === true && hugePending.provenance.aliases[0].lexicalOriginalPath === origin,
      'oversized final leaves private provenance retryable without unbounded replay read');
    context.assert(fs.statSync(hugePath).size === 10 * 1024 * 1024 + 1, 'oversized existing final is preserved');
    await rejection(() => publishSave({ ...input, sourceRelativeLocator: '../escape.md' }), 'path_policy_violation', context);
    await rejection(() => publishSave({ ...input, sourceRelativeLocator: 'notes/final.md', contentBytes: Buffer.alloc(11 * 1024 * 1024), contentHash: sha(Buffer.alloc(11 * 1024 * 1024)) }), 'content_too_large', context);
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(storeRoot, 'linked'), 'junction');
    await rejection(() => publishSave({ ...input, sourceRelativeLocator: 'linked/escape.md' }), 'path_policy_violation', context);
    context.assert(!fs.existsSync(path.join(outside, 'escape.md')), 'symlink escape writes nothing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
} };
