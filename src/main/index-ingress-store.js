'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_INTENT_BYTES = 64 * 1024;
const MAX_INTENTS = 1024;
const MAX_INGRESS_BYTES = 16 * 1024 * 1024;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const digest = value => sha(Buffer.from(JSON.stringify(value), 'utf8'));
const canonicalPathHashFor = value => sha(process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function checkedDirectory(root, target, create = true) {
  if (!contained(root, target)) throw fail('path_policy_violation');
  const canonicalRoot = fs.realpathSync.native(root);
  let cursor = root;
  const relative = path.relative(root, target);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor)) {
      if (fs.lstatSync(cursor).isSymbolicLink() || !fs.statSync(cursor).isDirectory()) throw fail('path_policy_violation');
      if (!contained(canonicalRoot, fs.realpathSync.native(cursor))) throw fail('path_policy_violation');
    } else if (create) {
      fs.mkdirSync(cursor);
    } else {
      throw fail('path_policy_violation');
    }
  }
  return canonicalRoot;
}

function directoryFlush(directory) {
  if (process.platform === 'win32') return false;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return true;
}

function writeFlushed(file, bytes, faultWrite, faultFlush, faultAt) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    if (faultAt === faultWrite) throw fail('fault_injected');
    fs.writeFileSync(fd, bytes);
    if (faultAt === faultFlush) throw fail('fault_injected');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function boundedFileHash(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size > MAX_BODY_BYTES) return null;
    const hash = crypto.createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < size) {
      const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
      if (!count) throw fail('published_file_mismatch');
      hash.update(chunk.subarray(0, count));
      offset += count;
    }
    if (fs.fstatSync(fd).size !== size) return null;
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

function provenanceOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('invalid_provenance');
  if (Object.keys(value).some(key => !['aliases', 'metadata'].includes(key))) throw fail('invalid_provenance');
  const aliases = value.aliases == null ? [] : value.aliases;
  if (!Array.isArray(aliases) || aliases.length > 32) throw fail('invalid_provenance');
  const normalizedAliases = aliases.map(alias => {
    if (!alias || Object.keys(alias).some(key => !['lexicalOriginalPath', 'canonicalOriginalPath', 'canonicalPathHash'].includes(key))) throw fail('invalid_provenance');
    const { lexicalOriginalPath, canonicalOriginalPath, canonicalPathHash } = alias;
    if (!path.isAbsolute(lexicalOriginalPath) || !path.isAbsolute(canonicalOriginalPath)
      || !/^[a-f0-9]{64}$/.test(canonicalPathHash) || canonicalPathHash !== canonicalPathHashFor(canonicalOriginalPath)) throw fail('invalid_provenance');
    return { lexicalOriginalPath, canonicalOriginalPath, canonicalPathHash };
  });
  const metadata = value.metadata == null ? {} : value.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
    || Object.keys(metadata).some(key => !['category', 'documentTags', 'project', 'docType', 'description', 'title', 'docName'].includes(key))) throw fail('invalid_provenance');
  for (const item of Object.values(metadata)) {
    if (typeof item === 'string' && item.length <= 1024) continue;
    if (Array.isArray(item) && item.length <= 32 && item.every(tag => typeof tag === 'string' && tag.length <= 64)) continue;
    throw fail('invalid_provenance');
  }
  return { aliases: normalizedAliases, metadata };
}

function rootIdentity(root) {
  const stat = fs.statSync(root);
  return { device: String(stat.dev), fileId: String(stat.ino), canonicalPath: fs.realpathSync.native(root) };
}

function validLocator(value) {
  return typeof value === 'string' && Boolean(value) && !path.isAbsolute(value)
    && !path.win32.isAbsolute(value) && !value.includes('\\') && !value.includes('\0')
    && value.split('/').every(part => Boolean(part) && part !== '.' && part !== '..');
}

function readRecord(intentPath) {
  const fd = fs.openSync(intentPath, 'r');
  let raw;
  try {
    const size = fs.fstatSync(fd).size;
    if (size > MAX_INTENT_BYTES || size < 2) throw fail('invalid_intent');
    raw = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = fs.readSync(fd, raw, offset, size - offset, offset);
      if (!count) throw fail('invalid_intent');
      offset += count;
    }
  } finally { fs.closeSync(fd); }
  let record;
  try { record = JSON.parse(raw.toString('utf8')); } catch { throw fail('invalid_intent'); }
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).some(key => !['schemaVersion', 'intentId', 'operation', 'sourceId', 'rootFingerprint',
      'rootIdentity', 'sourceRelativeLocator', 'contentHash', 'provenance', 'createdTime', 'publicationOrder', 'checksum'].includes(key))) throw fail('invalid_intent');
  const { checksum, ...fields } = record;
  if (record.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(checksum || '') || digest(fields) !== checksum) throw fail('invalid_intent');
  const identity = { operation: record.operation, sourceId: record.sourceId, rootFingerprint: record.rootFingerprint,
    sourceRelativeLocator: record.sourceRelativeLocator, contentHash: record.contentHash, provenance: record.provenance };
  if (![digest(identity), digest({ ...identity, publicationOrder: record.publicationOrder })].includes(record.intentId)
    || !['save_document', 'opened_markdown', 'linked_import', 'update'].includes(record.operation)
    || typeof record.sourceId !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(record.sourceId)
    || !validLocator(record.sourceRelativeLocator) || !/^[a-f0-9]{64}$/.test(record.contentHash || '')
    || !record.rootIdentity || typeof record.rootIdentity !== 'object'
    || !Number.isFinite(Date.parse(record.createdTime))
    || (record.publicationOrder !== undefined && (!Number.isSafeInteger(record.publicationOrder)
      || record.publicationOrder < 1))) throw fail('invalid_intent');
  try { provenanceOf(record.provenance); } catch { throw fail('invalid_intent'); }
  return record;
}

function quarantine(privateRoot, intentPath) {
  const quarantineRoot = path.join(privateRoot, 'quarantine');
  checkedDirectory(privateRoot, quarantineRoot);
  const target = path.join(quarantineRoot, `${path.basename(intentPath)}.${crypto.randomUUID()}.quarantine`);
  fs.renameSync(intentPath, target);
  directoryFlush(quarantineRoot);
  return { quarantined: true, diagnosticCode: 'invalid_intent' };
}

// @req REL-DOC-009 DR-DOC-014
function readPendingSave({ ingressRoot, storeRoot, intentId }) {
  if (!/^[a-f0-9]{64}$/.test(intentId || '')) throw fail('invalid_intent');
  const privateRoot = path.resolve(ingressRoot);
  const documentRoot = path.resolve(storeRoot);
  if (fs.lstatSync(privateRoot).isSymbolicLink()) throw fail('path_policy_violation');
  const intentPath = path.join(privateRoot, `${intentId}.intent.json`);
  if (!fs.existsSync(intentPath)) return null;
  try {
    if (fs.lstatSync(documentRoot).isSymbolicLink() || fs.lstatSync(intentPath).isSymbolicLink()) throw fail('invalid_intent');
    const record = readRecord(intentPath);
    if (record.intentId !== intentId || record.rootFingerprint !== sha(documentRoot)
      || JSON.stringify(record.rootIdentity) !== JSON.stringify(rootIdentity(documentRoot))) throw fail('invalid_intent');
    const destination = path.resolve(documentRoot, record.sourceRelativeLocator);
    if (!contained(documentRoot, destination)) throw fail('invalid_intent');
    if (!fs.existsSync(destination)) return { ...record, intentPath, published: false };
    checkedDirectory(documentRoot, path.dirname(destination), false);
    if (fs.lstatSync(destination).isSymbolicLink()) throw fail('invalid_intent');
    if (boundedFileHash(destination) !== record.contentHash) {
      return { ...record, intentPath, published: false, superseded: true, diagnosticCode: 'stale_final' };
    }
    return { ...record, intentPath, published: true };
  } catch (error) {
    if (error.code === 'invalid_intent' || error.code === 'path_policy_violation') {
      try { return quarantine(privateRoot, intentPath); }
      catch { return { retryable: true, diagnosticCode: 'intent_io_retryable' }; }
    }
    return { retryable: true, diagnosticCode: 'intent_io_retryable' };
  }
}

// @req REL-DOC-009 FR-DOC-028
async function publishSave(input) {
  return withPublicationGate(input.ingressRoot, () => publishSaveLocked(input));
}

async function withPublicationGate(ingressRoot, action) {
  const privateRoot = path.resolve(ingressRoot);
  if (!fs.existsSync(privateRoot) || fs.lstatSync(privateRoot).isSymbolicLink()) throw fail('path_policy_violation');
  let release;
  const deadline = Date.now() + 1000;
  while (!release) {
    try { release = acquirePublicationGate(privateRoot); }
    catch (error) {
      if (error.code !== 'publication_busy' || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  try { return await action(); }
  finally { release(); }
}

function acquirePublicationGate(privateRoot) {
  const { processIdentity, processLiveness } = require('./process-owner-identity');
  const { acquireAtomicOwnerGate } = require('./atomic-owner-gate');
  const lock = path.join(privateRoot, '.publication.lock');
  const token = crypto.randomUUID();
  const temp = path.join(privateRoot, `.publication-owner-${token}.tmp`);
  const owner = { pid: process.pid, identity: processIdentity(process.pid), token };
  const recover = () => {
    const stat = fs.lstatSync(lock);
    if (stat.isSymbolicLink()) throw fail('publication_busy');
    let prior;
    let malformed = false;
    if (stat.isDirectory()) {
      const names = fs.readdirSync(lock);
      if (names.some(name => name !== 'owner.json')) throw fail('publication_busy');
      try { prior = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')); }
      catch { malformed = true; }
    } else if (stat.isFile()) {
      try { prior = JSON.parse(fs.readFileSync(lock, 'utf8')); }
      catch { malformed = true; }
    } else throw fail('publication_busy');
    let dead = false;
    if (malformed) dead = stat.isDirectory() && Date.now() - stat.mtimeMs > 5000;
    else if (Number.isSafeInteger(prior?.pid) && prior.pid > 0 && typeof prior.token === 'string') {
      dead = processLiveness(prior) === 'dead';
    }
    if (!dead) throw fail('publication_busy');
    const abandoned = path.join(privateRoot, `.publication-abandoned-${token}`);
    try { fs.renameSync(lock, abandoned); }
    catch { throw fail('publication_busy'); }
    if (stat.isDirectory()) {
      const oldOwner = path.join(abandoned, 'owner.json');
      if (fs.existsSync(oldOwner)) fs.unlinkSync(oldOwner);
      fs.rmdirSync(abandoned);
    } else fs.unlinkSync(abandoned);
  };
  const releaseGate = acquireAtomicOwnerGate(lock, () => fail('publication_busy'));
  try {
    writeFlushed(temp, Buffer.from(JSON.stringify(owner)), 'gate_owner_write', 'gate_owner_flush', undefined);
    try { fs.linkSync(temp, lock); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      recover();
      try { fs.linkSync(temp, lock); } catch { throw fail('publication_busy'); }
    }
    directoryFlush(privateRoot);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
    releaseGate();
  }
  return () => {
    const current = JSON.parse(fs.readFileSync(lock, 'utf8'));
    if (current.pid !== process.pid || current.token !== token) throw fail('publication_gate_lost');
    fs.unlinkSync(lock);
  };
}

function nextPublicationOrder(privateRoot) {
  const counterPath = path.join(privateRoot, '.publication-order.json');
  let previous = 0;
  if (fs.existsSync(counterPath)) {
    const record = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
    if (!Number.isSafeInteger(record.last) || record.last < 0) throw fail('invalid_publication_order');
    previous = record.last;
  }
  if (previous >= Number.MAX_SAFE_INTEGER) throw fail('publication_order_exhausted');
  const next = previous + 1;
  const temp = path.join(privateRoot, `.publication-order.${crypto.randomUUID()}.tmp`);
  try {
    writeFlushed(temp, Buffer.from(JSON.stringify({ last: next })), 'counter_write', 'counter_flush', undefined);
    fs.renameSync(temp, counterPath);
    directoryFlush(privateRoot);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return next;
}

function publishSaveLocked(input) {
  const { storeRoot, ingressRoot, sourceRelativeLocator, contentBytes, contentHash, operation,
    sourceId, rootFingerprint, faultAt } = input;
  if (!Buffer.isBuffer(contentBytes) || contentBytes.length > MAX_BODY_BYTES) throw fail('content_too_large');
  if (!/^[a-f0-9]{64}$/.test(contentHash || '') || sha(contentBytes) !== contentHash) throw fail('content_hash_mismatch');
  if (!['save_document', 'opened_markdown', 'linked_import', 'update'].includes(operation)
    || typeof sourceId !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(sourceId)) throw fail('invalid_identity');
  const documentRoot = path.resolve(storeRoot);
  const privateRoot = path.resolve(ingressRoot);
  if (rootFingerprint !== sha(documentRoot) || !fs.existsSync(documentRoot) || !fs.existsSync(privateRoot)
    || fs.lstatSync(documentRoot).isSymbolicLink() || fs.lstatSync(privateRoot).isSymbolicLink()
    || fs.statSync(documentRoot).dev !== fs.statSync(privateRoot).dev) throw fail('path_policy_violation');
  if (!validLocator(sourceRelativeLocator)) throw fail('path_policy_violation');
  const destination = path.resolve(documentRoot, sourceRelativeLocator);
  const extension = path.extname(destination).toLowerCase();
  const openedMarkdownLocator = extension === '.markdown'
    && ['opened_markdown', 'linked_import', 'update'].includes(operation)
    && Array.isArray(input.provenance?.aliases) && input.provenance.aliases.length > 0;
  if (!contained(documentRoot, destination)
    || (extension !== '.md' && !openedMarkdownLocator)) throw fail('path_policy_violation');
  checkedDirectory(documentRoot, path.dirname(destination));
  checkedDirectory(privateRoot, privateRoot);
  if (fs.statSync(path.dirname(destination)).dev !== fs.statSync(privateRoot).dev) throw fail('path_policy_violation');
  if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) throw fail('path_policy_violation');
  if (input.requireVacant === true && !input.intentId && fs.existsSync(destination)) throw fail('published_file_mismatch');
  const provenance = provenanceOf(input.provenance || { aliases: [], metadata: {} });
  const identity = { operation, sourceId, rootFingerprint, sourceRelativeLocator, contentHash, provenance };
  const sameLocator = [];
  const sameIdentity = [];
  for (const name of fs.readdirSync(privateRoot).filter(name => /^[a-f0-9]{64}\.intent\.json$/.test(name))) {
    let pending;
    try { pending = readRecord(path.join(privateRoot, name)); } catch { continue; }
    if (pending.rootFingerprint !== rootFingerprint || pending.sourceId !== sourceId
      || pending.sourceRelativeLocator !== sourceRelativeLocator) continue;
    sameLocator.push(pending);
    if (digest({ operation: pending.operation, sourceId: pending.sourceId,
      rootFingerprint: pending.rootFingerprint, sourceRelativeLocator: pending.sourceRelativeLocator,
      contentHash: pending.contentHash, provenance: pending.provenance }) === digest(identity)) sameIdentity.push(pending);
  }
  const highest = Math.max(0, ...sameLocator.map(item => item.publicationOrder || 0));
  const candidate = sameIdentity.sort((a, b) => (b.publicationOrder || 0) - (a.publicationOrder || 0))[0];
  const replay = input.intentId
    ? sameIdentity.find(item => item.intentId === input.intentId)
    : candidate && (candidate.publicationOrder || 0) === highest ? candidate : null;
  if (input.intentId && !replay) throw fail('invalid_intent');
  if (input.expectedExistingHash != null) {
    if (!/^[a-f0-9]{64}$/.test(input.expectedExistingHash)) throw fail('published_file_mismatch');
    const actualHash = fs.existsSync(destination) ? boundedFileHash(destination) : null;
    // A matching private intent already published these bytes before owner ACK failed.
    // Only that exact replay may bypass the old ledger hash; new updates retain the guard.
    if (!(replay && actualHash === contentHash) && actualHash !== input.expectedExistingHash) {
      throw fail('published_file_mismatch');
    }
  }
  const publicationOrder = replay ? replay.publicationOrder : nextPublicationOrder(privateRoot);
  const intentId = replay ? replay.intentId : digest({ ...identity, publicationOrder });
  const intentPath = path.join(privateRoot, `${intentId}.intent.json`);
  const fields = { schemaVersion: 1, intentId, ...identity, rootIdentity: rootIdentity(documentRoot),
    createdTime: replay?.createdTime || new Date().toISOString(), publicationOrder };
  if (faultAt === 'r3_hold_after_order') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  const record = { ...fields, checksum: digest(fields) };
  const bytes = Buffer.from(JSON.stringify(record), 'utf8');
  if (bytes.length > MAX_INTENT_BYTES) throw fail('intent_too_large');
  let intentExists = fs.existsSync(intentPath);
  if (intentExists) {
    const old = readRecord(intentPath);
    if (old.intentId !== intentId || digest(identity) !== digest({ operation: old.operation, sourceId: old.sourceId,
      rootFingerprint: old.rootFingerprint, sourceRelativeLocator: old.sourceRelativeLocator,
      contentHash: old.contentHash, provenance: old.provenance })
      || JSON.stringify(old.rootIdentity) !== JSON.stringify(rootIdentity(documentRoot))) throw fail('invalid_intent');
    if (Number.isSafeInteger(old.publicationOrder)) {
      for (const name of fs.readdirSync(privateRoot).filter(name => /^[a-f0-9]{64}\.intent\.json$/.test(name)
        && name !== `${intentId}.intent.json`)) {
        const other = readRecord(path.join(privateRoot, name));
        if (other.rootFingerprint === rootFingerprint && other.sourceId === sourceId
          && other.sourceRelativeLocator === sourceRelativeLocator
          && Number.isSafeInteger(other.publicationOrder)
          && other.publicationOrder > old.publicationOrder) throw fail('stale_intent');
      }
    }
  } else {
    const files = fs.readdirSync(privateRoot).filter(name => name.endsWith('.intent.json'));
    if (files.length >= MAX_INTENTS || files.reduce((total, name) => total + fs.statSync(path.join(privateRoot, name)).size, 0) + bytes.length > MAX_INGRESS_BYTES) throw fail('ingress_capacity');
  }
  let privateTemp;
  let documentTemp;
  let published = false;
  try {
    if (!intentExists) {
      privateTemp = path.join(privateRoot, `${intentId}.${crypto.randomUUID()}.tmp`);
      writeFlushed(privateTemp, bytes, 'intent_temp_write', 'intent_temp_flush', faultAt);
      if (faultAt === 'intent_rename') throw fail('fault_injected');
      fs.renameSync(privateTemp, intentPath);
      privateTemp = null;
      directoryFlush(privateRoot);
      intentExists = true;
    }
    if (fs.existsSync(destination) && boundedFileHash(destination) === contentHash) {
      published = true;
    } else {
      const replacing = operation === 'update' && fs.existsSync(destination);
      if (!replacing && fs.existsSync(destination)) throw fail('published_file_mismatch');
      const previous = replacing ? { stat: fs.statSync(destination), hash: boundedFileHash(destination) } : null;
      if (replacing && input.expectedExistingHash != null
        && previous.hash !== input.expectedExistingHash) throw fail('published_file_mismatch');
      if (replacing && previous.hash === null) throw fail('published_file_mismatch');
      documentTemp = path.join(path.dirname(destination), `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`);
      writeFlushed(documentTemp, contentBytes, 'document_temp_write', 'document_temp_flush', faultAt);
      checkedDirectory(documentRoot, path.dirname(destination));
      if (fs.statSync(path.dirname(destination)).dev !== fs.statSync(privateRoot).dev) throw fail('path_policy_violation');
      if (faultAt === 'document_rename') throw fail('fault_injected');
      if (replacing) {
        const current = fs.statSync(destination);
        if (current.dev !== previous.stat.dev || current.ino !== previous.stat.ino
          || boundedFileHash(destination) !== previous.hash) throw fail('published_file_mismatch');
        fs.renameSync(documentTemp, destination);
      } else {
        // link is an atomic no-replace publication on this volume; rename would clobber a racing file on Windows.
        try { fs.linkSync(documentTemp, destination); }
        catch (error) { if (error.code === 'EEXIST') throw fail('published_file_mismatch'); throw error; }
        fs.unlinkSync(documentTemp);
      }
      documentTemp = null;
      published = true;
      directoryFlush(path.dirname(destination));
      checkedDirectory(documentRoot, path.dirname(destination));
      if (!contained(fs.realpathSync.native(documentRoot), fs.realpathSync.native(destination))) throw fail('path_policy_violation');
      if (boundedFileHash(destination) !== contentHash) throw fail('published_file_mismatch');
    }
    if (faultAt === 'post_publish') throw fail('fault_injected');
    return { saved: true, intentId, sourceRelativeLocator, contentHash,
      indexing: { state: 'enqueue_failed' },
      warnings: [{ code: 'index_enqueue_failed', message: 'Document was saved but indexing enqueue failed.', retryable: true }] };
  } catch (error) {
    if (privateTemp && fs.existsSync(privateTemp)) fs.unlinkSync(privateTemp);
    if (documentTemp && fs.existsSync(documentTemp)) fs.unlinkSync(documentTemp);
    if (published) error.published = true;
    throw error;
  }
}

// @req FR-DOC-035 REL-DOC-009 SEC-DOC-003
function recordExternalRegistrationFailure({ ingressRoot, storeRoot, originLexicalPathInternal,
  diagnosticCode }) {
  const privateRoot = path.resolve(ingressRoot);
  if (!fs.existsSync(privateRoot) || !fs.statSync(privateRoot).isDirectory()
    || fs.lstatSync(privateRoot).isSymbolicLink()) throw fail('path_policy_violation');
  const names = fs.readdirSync(privateRoot).filter(name => name.endsWith('.registration.json'));
  if (names.length >= MAX_INTENTS) throw fail('ingress_capacity');
  const lexical = path.resolve(originLexicalPathInternal);
  const canonical = fs.realpathSync.native(lexical);
  const contentHash = boundedFileHash(canonical);
  if (!contentHash || lexical.length > 4096 || canonical.length > 4096) throw fail('invalid_identity');
  const record = { schemaVersion: 1, retryable: true,
    diagnosticCode: /^[a-z0-9_]{1,80}$/.test(diagnosticCode || '')
      ? diagnosticCode : 'external_registration_failed',
    originLexicalPathInternal: lexical, originPathInternal: canonical,
    canonicalPathHash: canonicalPathHashFor(canonical),
    rootFingerprint: sha(path.resolve(storeRoot)), contentHash };
  const key = digest(record);
  const destination = path.join(privateRoot, `${key}.registration.json`);
  if (fs.existsSync(destination)) return destination;
  const temp = path.join(privateRoot, `${key}.${crypto.randomUUID()}.tmp`);
  try {
    writeFlushed(temp, Buffer.from(JSON.stringify(record)), 'registration_write',
      'registration_flush', undefined);
    fs.renameSync(temp, destination);
    directoryFlush(privateRoot);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return destination;
}

module.exports = { publishSave, readPendingSave, withPublicationGate,
  recordExternalRegistrationFailure };
