'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLegacyAdopter } = require('./legacy-adoption');
const { redactToken } = require('./redaction');

const DEFAULT_OPENED_NAMESPACE = '.opened';

// @req FR-DOC-035
function createOpenedMarkdownRegistrar({
  store,
  searchEngine,
  namespace = DEFAULT_OPENED_NAMESPACE,
  logger = console
} = {}) {
  return new OpenedMarkdownRegistrar({ store, searchEngine, namespace, logger });
}

// @req FR-DOC-035
class OpenedMarkdownRegistrar {
  constructor({ store, searchEngine, namespace, logger } = {}) {
    this.store = store;
    this.searchEngine = searchEngine;
    this.namespace = sanitizePathSegment(namespace || DEFAULT_OPENED_NAMESPACE) || DEFAULT_OPENED_NAMESPACE;
    this.logger = logger || console;
    this.inFlight = new Map();
  }

  schedule(filePath) {
    const key = safePathKey(filePath);
    if (!key) return Promise.resolve({ status: 'skipped', reason: 'invalid-path' });
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = this.register(filePath)
      .catch((err) => {
        if (this.logger && typeof this.logger.warn === 'function') {
          this.logger.warn('[doculight] Opened Markdown registration failed:', normalizeDiagnosticCode(err));
        }
        return { status: 'skipped', reason: 'registration-failed', diagnosticCode: normalizeDiagnosticCode(err) };
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  async register(filePath) {
    if (!this.isEnabled()) return { status: 'skipped', reason: 'disabled' };
    if (!this.searchEngine || typeof this.searchEngine.queueDocumentIndexIfChanged !== 'function') {
      return { status: 'skipped', reason: 'search-index-unavailable' };
    }
    const sourceRoot = this.getSourceRoot();
    if (!sourceRoot) return { status: 'skipped', reason: 'document-store-unconfigured' };

    const absolutePath = path.resolve(requiredString(filePath, 'filePath'));
    if (!isMarkdownFilePath(absolutePath)) {
      return { status: 'skipped', reason: 'unsupported-file-type' };
    }

    const canonicalPath = realpathOrPath(absolutePath);
    const content = await fs.promises.readFile(canonicalPath, 'utf8');
    const fingerprint = buildDocumentFingerprint(content);
    const ledger = this.searchEngine.getSourceLedger();

    const canonicalSourceRoot = realpathOrPath(sourceRoot);
    const lexicalPathIsContained = isWithinRoot(absolutePath, sourceRoot);
    const canonicalPathIsContained = isWithinRoot(canonicalPath, canonicalSourceRoot);
    if (lexicalPathIsContained && !canonicalPathIsContained) {
      return pathContainmentFailure(absolutePath, 'realpath_outside_source_root');
    }
    if (canonicalPathIsContained) {
      const sourceRelativePath = path.relative(canonicalSourceRoot, canonicalPath);
      const containedPath = path.resolve(sourceRoot, sourceRelativePath);
      if (
        !isWithinRoot(containedPath, sourceRoot) ||
        normalizeInternalPath(realpathOrPath(containedPath)) !== normalizeInternalPath(canonicalPath)
      ) {
        return pathContainmentFailure(absolutePath, 'realpath_changed');
      }
      return this.registerContainedPath({ filePath: containedPath, content, fingerprint, ledger, sourceRoot });
    }
    return this.registerExternalPath({ filePath: canonicalPath, content, fingerprint, ledger, sourceRoot });
  }

  isEnabled() {
    return Boolean(this.store && typeof this.store.get === 'function' && this.store.get('registerOpenedMarkdown', false));
  }

  getSourceRoot() {
    const value = this.store && typeof this.store.get === 'function'
      ? this.store.get('mcpAutoSavePath', '')
      : '';
    return value ? path.resolve(String(value)) : '';
  }

  async registerContainedPath({ filePath, content, ledger, sourceRoot }) {
    const fingerprint = buildDocumentFingerprint(content);
    const existing = typeof ledger.findDocumentByCanonicalPath === 'function'
      ? ledger.findDocumentByCanonicalPath({ canonicalPathInternal: filePath })
      : null;
    if (!existing) {
      const duplicate = this.findDuplicateActiveDocument({ ledger, fingerprint, excludeDocumentId: null });
      if (duplicate) {
        return duplicateCandidateResult(duplicate);
      }
    }
    const adopter = createLegacyAdopter({
      knowledgeStoreRoot: sourceRoot,
      ledger
    });
    const adoption = await adopter.adoptMarkdownFile(filePath, content);
    if (!adoption || adoption.status === 'skipped' || adoption.status === 'ambiguous') {
      return {
        status: 'skipped',
        reason: 'legacy-adoption-skipped',
        diagnosticCode: adoption && adoption.diagnosticCode ? adoption.diagnosticCode : 'legacy_adoption_failed',
        redactedPath: redactToken('PATH', filePath)
      };
    }
    if (adoption.status === 'existing' || adoption.shouldQueue === false) {
      return {
        status: 'existing',
        indexedPath: filePath,
        document: adoption.document || null
      };
    }
    const queued = this.searchEngine.queueKnownDocumentIndex({
      filePath,
      content,
      document: adoption.document,
      requestedBy: adoption.requestedBy || 'knowledge_store.legacy_adoption'
    });
    return queueResultToRegistrationResult(queued, filePath);
  }

  async registerExternalPath({ filePath, content, fingerprint, ledger, sourceRoot }) {
    const alias = typeof ledger.findDocumentSourceAliasByCanonicalPath === 'function'
      ? ledger.findDocumentSourceAliasByCanonicalPath({ canonicalPathInternal: filePath })
      : null;
    const destinationPath = alias && alias.linkedSourceRelativePath
      ? path.join(sourceRoot, alias.linkedSourceRelativePath)
      : destinationForOpenedFile({
        sourceRoot,
        namespace: this.namespace,
        filePath
      });
    const deterministicDestinationPath = destinationForOpenedFile({
      sourceRoot,
      namespace: this.namespace,
      filePath
    });
    if (alias && normalizeInternalPath(destinationPath) !== normalizeInternalPath(deterministicDestinationPath)) {
      return {
        status: 'skipped',
        reason: 'stale-opened-destination',
        diagnosticCode: 'opened_destination_policy_mismatch',
        pathToken: redactToken('PATH', destinationPath)
      };
    }
    if (hasSameContentFingerprint(alias, fingerprint)) {
      const aliasDestinationStatus = validateExistingAliasDestination({
        sourceRoot,
        destinationPath,
        content
      });
      if (aliasDestinationStatus.status !== 'existing') {
        return aliasDestinationStatus;
      }
      return {
        status: 'existing',
        indexedPath: destinationPath,
        documentId: alias.documentId || null
      };
    }

    if (!alias) {
      const duplicate = this.findDuplicateActiveDocument({
        ledger,
        fingerprint,
        excludeDocumentId: null
      });
      if (duplicate) {
        return duplicateCandidateResult(duplicate);
      }
    } else if (!alias.linkedSourceRelativePath || !fs.existsSync(destinationPath)) {
      return {
        status: 'skipped',
        reason: 'stale-opened-destination',
        diagnosticCode: 'opened_destination_missing',
        pathToken: redactToken('PATH', destinationPath)
      };
    }

    const destination = prepareOpenedDestination({
      sourceRoot,
      namespace: this.namespace,
      filePath,
      content,
      allowOverwrite: Boolean(alias)
    });
    if (destination.status !== 'writable' && destination.status !== 'existing') {
      return {
        status: 'skipped',
        reason: 'destination-unavailable',
        diagnosticCode: destination.diagnosticCode || 'destination_unavailable',
        pathToken: destination.pathToken || null
      };
    }
    await copyIfChanged({ destinationPath: destination.targetPath, content });
    const queued = this.searchEngine.queueDocumentIndexIfChanged({
      filePath: destination.targetPath,
      content,
      requestedBy: 'viewer.opened_markdown'
    });
    if (!queued || (!queued.queued && queued.reason !== 'unchanged')) {
      return queueResultToRegistrationResult(queued, destination.targetPath, destination.targetPath);
    }
    const document = queued.document || null;
    if (document && typeof ledger.upsertDocumentSourceAlias === 'function') {
      ledger.upsertDocumentSourceAlias({
        documentId: document.documentId,
        canonicalPathInternal: filePath,
        aliasKind: 'opened_path',
        contentHash: fingerprint.contentHash,
        contentByteLength: fingerprint.contentByteLength,
        contentTextLength: fingerprint.contentTextLength
      });
    }
    return queueResultToRegistrationResult(queued, destination.targetPath, destination.targetPath);
  }

  findDuplicateActiveDocument({ ledger, fingerprint, excludeDocumentId } = {}) {
    if (!ledger || typeof ledger.findActiveDocumentByContentFingerprint !== 'function') return null;
    return ledger.findActiveDocumentByContentFingerprint({
      contentHash: fingerprint.contentHash,
      contentByteLength: fingerprint.contentByteLength,
      contentTextLength: fingerprint.contentTextLength,
      excludeDocumentId
    });
  }
}

function queueResultToRegistrationResult(queued, indexedPath, destinationPath = null) {
  if (queued && queued.queued) {
    return {
      status: 'queued',
      indexedPath,
      destinationPath,
      document: queued.document || null,
      jobId: queued.jobId || null
    };
  }
  if (queued && queued.reason === 'unchanged') {
    return {
      status: 'existing',
      indexedPath,
      destinationPath,
      document: queued.document || null
    };
  }
  return {
    status: 'skipped',
    reason: queued && queued.reason ? queued.reason : 'index-queue-failed',
    indexedPath,
    destinationPath,
    document: queued && queued.document ? queued.document : null
  };
}

function duplicateCandidateResult(document) {
  return {
    status: 'duplicate_candidate',
    diagnosticCode: 'duplicate_content_active_path',
    documentId: document && document.documentId ? document.documentId : null
  };
}

function destinationForOpenedFile({ sourceRoot, namespace, filePath }) {
  const canonicalPath = realpathOrPath(filePath);
  const dirHash = stableHash(normalizeInternalPath(path.dirname(canonicalPath))).slice(0, 16);
  const baseName = sanitizeFileName(path.basename(canonicalPath)) || `opened-${stableHash(canonicalPath).slice(0, 12)}.md`;
  return path.join(sourceRoot, namespace, dirHash, baseName);
}

function prepareOpenedDestination({ sourceRoot, namespace, filePath, content, allowOverwrite = false }) {
  const targetPath = destinationForOpenedFile({ sourceRoot, namespace, filePath });
  const normalizedRoot = path.resolve(sourceRoot);
  if (normalizeInternalPath(targetPath) === normalizeInternalPath(normalizedRoot) || !isWithinRoot(targetPath, normalizedRoot)) {
    return destinationDiagnostic('destination_path_policy_violation', targetPath);
  }
  try {
    fs.mkdirSync(normalizedRoot, { recursive: true });
  } catch {
    return destinationDiagnostic('destination_root_unwritable', targetPath);
  }
  const rootReal = tryRealpath(normalizedRoot);
  if (!rootReal.ok) return destinationDiagnostic('destination_root_realpath_failed', targetPath);

  const parentPath = path.dirname(targetPath);
  const existingAncestor = findExistingAncestor(parentPath);
  if (!existingAncestor || !isWithinRoot(existingAncestor, normalizedRoot)) {
    return destinationDiagnostic('destination_path_policy_violation', targetPath);
  }
  const ancestorReal = tryRealpath(existingAncestor);
  if (!ancestorReal.ok) return destinationDiagnostic('destination_realpath_failed', targetPath);
  if (!isWithinRoot(ancestorReal.value, rootReal.value)) {
    return destinationDiagnostic('destination_realpath_outside_store', targetPath);
  }
  try {
    fs.mkdirSync(parentPath, { recursive: true });
  } catch {
    return destinationDiagnostic('destination_parent_unwritable', targetPath);
  }
  const parentReal = tryRealpath(parentPath);
  if (!parentReal.ok) return destinationDiagnostic('destination_realpath_failed', targetPath);
  if (!isWithinRoot(parentReal.value, rootReal.value)) {
    return destinationDiagnostic('destination_realpath_outside_store', targetPath);
  }

  const targetStat = lstatIfPresent(targetPath);
  if (!targetStat) return { status: 'writable', targetPath };
  if (targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    return destinationDiagnostic('destination_not_file', targetPath);
  }
  const targetReal = tryRealpath(targetPath);
  if (!targetReal.ok) return destinationDiagnostic('destination_realpath_failed', targetPath);
  if (!isWithinRoot(targetReal.value, rootReal.value)) {
    return destinationDiagnostic('destination_realpath_outside_store', targetPath);
  }
  const existing = fs.readFileSync(targetPath, 'utf8');
  if (allowOverwrite) return { status: 'writable', targetPath };
  return destinationDiagnostic(
    existing === content ? 'legacy_destination_without_source_identity' : 'destination_collision',
    targetPath
  );
}

function validateExistingAliasDestination({ sourceRoot, destinationPath, content }) {
  const safety = validateDestinationPathSafety({ sourceRoot, targetPath: destinationPath });
  if (safety.status !== 'safe') {
    return {
      status: 'skipped',
      reason: 'stale-opened-destination',
      diagnosticCode: safety.status === 'missing' ? 'opened_destination_missing' : safety.diagnosticCode,
      pathToken: safety.pathToken || redactToken('PATH', destinationPath || sourceRoot)
    };
  }
  try {
    const existing = fs.readFileSync(destinationPath, 'utf8');
    if (existing === content) return { status: 'existing', targetPath: destinationPath };
  } catch {
    return {
      status: 'skipped',
      reason: 'stale-opened-destination',
      diagnosticCode: 'opened_destination_missing',
      pathToken: redactToken('PATH', destinationPath)
    };
  }
  return {
    status: 'skipped',
    reason: 'stale-opened-destination',
    diagnosticCode: 'opened_destination_content_mismatch',
    pathToken: redactToken('PATH', destinationPath)
  };
}

function validateDestinationPathSafety({ sourceRoot, targetPath }) {
  const normalizedRoot = path.resolve(sourceRoot || '');
  if (!targetPath) return destinationDiagnostic('destination_path_policy_violation', normalizedRoot);
  if (normalizeInternalPath(targetPath) === normalizeInternalPath(normalizedRoot) || !isWithinRoot(targetPath, normalizedRoot)) {
    return destinationDiagnostic('destination_path_policy_violation', targetPath);
  }
  const rootReal = tryRealpath(normalizedRoot);
  if (!rootReal.ok) return destinationDiagnostic('destination_root_realpath_failed', targetPath);
  const parentPath = path.dirname(targetPath);
  const existingAncestor = findExistingAncestor(parentPath);
  if (!existingAncestor || !isWithinRoot(existingAncestor, normalizedRoot)) {
    return destinationDiagnostic('destination_path_policy_violation', targetPath);
  }
  const ancestorReal = tryRealpath(existingAncestor);
  if (!ancestorReal.ok) return destinationDiagnostic('destination_realpath_failed', targetPath);
  if (!isWithinRoot(ancestorReal.value, rootReal.value)) {
    return destinationDiagnostic('destination_realpath_outside_store', targetPath);
  }
  const parentReal = fs.existsSync(parentPath) ? tryRealpath(parentPath) : ancestorReal;
  if (!parentReal.ok) return destinationDiagnostic('destination_realpath_failed', targetPath);
  if (!isWithinRoot(parentReal.value, rootReal.value)) {
    return destinationDiagnostic('destination_realpath_outside_store', targetPath);
  }
  const targetStat = lstatIfPresent(targetPath);
  if (!targetStat) return { status: 'missing', pathToken: redactToken('PATH', targetPath) };
  if (targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    return destinationDiagnostic('destination_not_file', targetPath);
  }
  const targetReal = tryRealpath(targetPath);
  if (!targetReal.ok) return destinationDiagnostic('destination_realpath_failed', targetPath);
  if (!isWithinRoot(targetReal.value, rootReal.value)) {
    return destinationDiagnostic('destination_realpath_outside_store', targetPath);
  }
  return { status: 'safe', targetPath };
}

function destinationDiagnostic(diagnosticCode, targetPath) {
  return {
    status: 'ambiguous',
    diagnosticCode,
    pathToken: redactToken('PATH', targetPath)
  };
}

function pathContainmentFailure(filePath, diagnosticCode) {
  return {
    status: 'skipped',
    reason: 'path-containment-failed',
    diagnosticCode,
    pathToken: redactToken('PATH', filePath)
  };
}

async function copyIfChanged({ destinationPath, content }) {
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  try {
    const existing = await fs.promises.readFile(destinationPath, 'utf8');
    if (existing === content) return { copied: false, reason: 'unchanged' };
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  const tempPath = `${destinationPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tempPath, content, 'utf8');
  await fs.promises.rename(tempPath, destinationPath);
  return { copied: true };
}

function buildDocumentFingerprint(content) {
  const text = typeof content === 'string' ? content : '';
  const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return {
    contentHash: `sha256:${stableHash(text)}`,
    contentByteLength: Buffer.byteLength(text, 'utf8'),
    contentTextLength: text.length,
    normalizedTextHash: `sha256:${stableHash(normalizedText)}`
  };
}

function hasSameContentFingerprint(record, fingerprint) {
  if (!record || !fingerprint) return false;
  if (record.contentHash !== fingerprint.contentHash) return false;
  if (Number.isInteger(record.contentByteLength) && record.contentByteLength !== fingerprint.contentByteLength) return false;
  if (Number.isInteger(record.contentTextLength) && record.contentTextLength !== fingerprint.contentTextLength) return false;
  return true;
}

function isMarkdownFilePath(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return ext === '.md' || ext === '.markdown';
}

function isWithinRoot(filePath, rootPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(filePath));
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function tryRealpath(filePath) {
  try {
    return { ok: true, value: fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function lstatIfPresent(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

function findExistingAncestor(filePath) {
  let current = path.resolve(filePath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

function realpathOrPath(value) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);
  } catch {
    return path.resolve(String(value));
  }
}

function normalizeInternalPath(value) {
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function safePathKey(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  return normalizeInternalPath(realpathOrPath(filePath));
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function sanitizeFileName(value) {
  const parsed = path.parse(String(value || 'opened.md'));
  const name = sanitizePathSegment(parsed.name || 'opened');
  const lowerExt = String(parsed.ext || '').toLowerCase();
  const ext = lowerExt === '.md' || lowerExt === '.markdown' ? lowerExt : '.md';
  return `${name || 'opened'}${ext}`;
}

function sanitizePathSegment(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+$/, '_')
    .slice(0, 120);
}

function normalizeDiagnosticCode(err) {
  return err && err.code ? String(err.code).toLowerCase() : 'opened_markdown_registration_failed';
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

module.exports = {
  OpenedMarkdownRegistrar,
  createOpenedMarkdownRegistrar
};
