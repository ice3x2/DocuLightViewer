'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');

const VALIDATED_MARKDOWN_CONTENT = Symbol('doculight.validated-markdown-content');
const DEFAULT_MAX_MARKDOWN_BYTES = 10 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
const ORIGIN_STATUSES = Object.freeze([
  'readable',
  'readable_changed',
  'not_recorded',
  'missing',
  'unreadable',
  'path_mismatch',
  'not_file',
  'unsupported_extension',
  'read_failed'
]);

// @req FR-DOC-036
class IndexedDocumentOpenError extends Error {
  constructor(code, originStatus = null) {
    super(`errorCode: ${code}`);
    this.name = 'IndexedDocumentOpenError';
    this.code = code;
    this.originStatus = ORIGIN_STATUSES.includes(originStatus) ? originStatus : null;
    this.retryable = code === 'indexed_document_unavailable';
  }
}

// @req FR-DOC-036
async function resolveIndexedMarkdownOpen({
  documentId,
  filePath,
  searchEngine,
  fsPromises = fs.promises
} = {}) {
  const hasDocumentId = documentId !== undefined && documentId !== null;
  const ledger = searchEngine && typeof searchEngine.getSourceLedger === 'function'
    ? searchEngine.getSourceLedger()
    : null;
  if (!ledger || typeof ledger.getIndexedDocumentOpenTargetInternal !== 'function') {
    if (hasDocumentId) throw new IndexedDocumentOpenError('indexed_document_not_found');
    return null;
  }

  const target = ledger.getIndexedDocumentOpenTargetInternal({ documentId, filePath });
  if (!target) {
    if (hasDocumentId) {
      throw new IndexedDocumentOpenError('indexed_document_not_found');
    }
    return null;
  }
  if (target.pathStatus !== 'active') {
    throw new IndexedDocumentOpenError('indexed_document_unavailable', 'missing');
  }

  let originStatus = 'not_recorded';
  const hasAnyOriginPath = Boolean(target.originLexicalPathInternal || target.originPathInternal);
  if (target.originLexicalPathInternal && target.originPathInternal && target.originCanonicalPathHash) {
    const origin = await readValidatedMarkdownCandidate({
      lexicalPathInternal: target.originLexicalPathInternal,
      expectedCanonicalPathInternal: target.originPathInternal,
      expectedCanonicalPathHash: target.originCanonicalPathHash,
      fsPromises
    });
    if (origin.ok) {
      originStatus = matchesStoredFingerprint(origin, target) ? 'readable' : 'readable_changed';
      return {
        documentId: target.documentId,
        sourceUsed: 'origin',
        originStatus,
        content: origin.content,
        filePathInternal: origin.canonicalPathInternal,
        [VALIDATED_MARKDOWN_CONTENT]: true
      };
    }
    originStatus = origin.status;
  } else if (hasAnyOriginPath) {
    originStatus = 'path_mismatch';
  }

  const indexedCopy = await readValidatedMarkdownCandidate({
    lexicalPathInternal: target.indexedPathInternal,
    expectedCanonicalPathHash: target.indexedCanonicalPathHash,
    containmentRootInternal: target.sourceRootInternal,
    fsPromises
  });
  if (indexedCopy.ok) {
    return {
      documentId: target.documentId,
      sourceUsed: 'indexed_copy',
      originStatus,
      content: indexedCopy.content,
      filePathInternal: indexedCopy.canonicalPathInternal,
      [VALIDATED_MARKDOWN_CONTENT]: true
    };
  }

  throw new IndexedDocumentOpenError('indexed_document_unavailable', originStatus);
}

// @req FR-DOC-036
async function readValidatedMarkdownCandidate({
  lexicalPathInternal,
  expectedCanonicalPathInternal,
  expectedCanonicalPathHash,
  containmentRootInternal,
  fsPromises = fs.promises,
  maxBytes = DEFAULT_MAX_MARKDOWN_BYTES
} = {}) {
  const readLimit = Number.isSafeInteger(maxBytes) && maxBytes > 0
    ? Math.min(maxBytes, DEFAULT_MAX_MARKDOWN_BYTES)
    : DEFAULT_MAX_MARKDOWN_BYTES;
  if (!lexicalPathInternal || !path.isAbsolute(lexicalPathInternal)) {
    return failure('path_mismatch');
  }
  if (!MARKDOWN_EXTENSIONS.has(path.extname(lexicalPathInternal).toLowerCase())) {
    return failure('unsupported_extension');
  }

  let canonicalBefore;
  try {
    canonicalBefore = await fsPromises.realpath(lexicalPathInternal);
  } catch (err) {
    return failure(statusForFsError(err));
  }
  if (!path.isAbsolute(canonicalBefore)) return failure('path_mismatch');
  if (expectedCanonicalPathInternal && normalizeInternalPath(canonicalBefore) !== normalizeInternalPath(expectedCanonicalPathInternal)) {
    return failure('path_mismatch');
  }
  if (expectedCanonicalPathHash && hashCanonicalPath(canonicalBefore) !== expectedCanonicalPathHash) {
    return failure('path_mismatch');
  }
  if (containmentRootInternal) {
    let canonicalRoot;
    try {
      canonicalRoot = await fsPromises.realpath(containmentRootInternal);
    } catch (_) {
      return failure('path_mismatch');
    }
    if (!isWithinRoot(canonicalBefore, canonicalRoot)) return failure('path_mismatch');
  }

  let handle;
  try {
    handle = await fsPromises.open(canonicalBefore, 'r');
  } catch (err) {
    return failure(statusForFsError(err));
  }

  try {
    const handleBefore = await handle.stat();
    if (!handleBefore.isFile()) return failure('not_file');
    if (Number(handleBefore.size) > readLimit) return failure('read_failed');
    const pathBefore = await fsPromises.stat(canonicalBefore);
    if (!sameFileIdentity(handleBefore, pathBefore)) return failure('path_mismatch');

    const bytes = await readFileHandleBounded(handle, readLimit);
    if (!bytes) return failure('read_failed');
    const handleAfter = await handle.stat();
    const canonicalAfter = await fsPromises.realpath(lexicalPathInternal);
    const pathAfter = await fsPromises.stat(canonicalAfter);
    if (
      normalizeInternalPath(canonicalAfter) !== normalizeInternalPath(canonicalBefore)
      || (expectedCanonicalPathInternal && normalizeInternalPath(canonicalAfter) !== normalizeInternalPath(expectedCanonicalPathInternal))
      || (expectedCanonicalPathHash && hashCanonicalPath(canonicalAfter) !== expectedCanonicalPathHash)
      || !sameFileIdentity(handleBefore, handleAfter)
      || !sameFileIdentity(handleAfter, pathAfter)
    ) {
      return failure('path_mismatch');
    }

    let content;
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (_) {
      return failure('read_failed');
    }
    return {
      ok: true,
      content,
      bytes,
      canonicalPathInternal: canonicalBefore,
      contentHash: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
      contentByteLength: bytes.length,
      contentTextLength: content.length
    };
  } catch (err) {
    return failure(statusForFsError(err));
  } finally {
    try {
      await handle.close();
    } catch (_) {
      // The selected content is already held in memory; close failures are non-public diagnostics.
    }
  }
}

async function readFileHandleBounded(handle, maxBytes) {
  const chunks = [];
  let totalBytes = 0;
  while (totalBytes <= maxBytes) {
    const bytesToProbe = Math.min(READ_CHUNK_BYTES, maxBytes - totalBytes + 1);
    const buffer = Buffer.allocUnsafe(bytesToProbe);
    const result = await handle.read(buffer, 0, buffer.length, null);
    const bytesRead = result && Number.isInteger(result.bytesRead) ? result.bytesRead : 0;
    if (bytesRead <= 0) break;
    totalBytes += bytesRead;
    if (totalBytes > maxBytes) return null;
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, totalBytes);
}

function matchesStoredFingerprint(candidate, target) {
  return Boolean(
    target.originContentHash
    && candidate.contentHash === target.originContentHash
    && (!Number.isInteger(target.originContentByteLength) || candidate.contentByteLength === target.originContentByteLength)
    && (!Number.isInteger(target.originContentTextLength) || candidate.contentTextLength === target.originContentTextLength)
  );
}

function statusForFsError(err) {
  const code = err && err.code ? String(err.code).toUpperCase() : '';
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
  if (code === 'EACCES' || code === 'EPERM') return 'unreadable';
  return 'read_failed';
}

function sameFileIdentity(left, right) {
  if (!left || !right) return false;
  const stableMetadata = left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.birthtimeMs === right.birthtimeMs;
  if (!stableMetadata) return false;
  const leftIno = Number(left.ino);
  const rightIno = Number(right.ino);
  const leftDev = Number(left.dev);
  const rightDev = Number(right.dev);
  if (Number.isFinite(leftIno) && Number.isFinite(rightIno) && (leftIno !== 0 || rightIno !== 0)) {
    return leftIno === rightIno && leftDev === rightDev;
  }
  return true;
}

function hashCanonicalPath(filePath) {
  return crypto.createHash('sha256').update(normalizeInternalPath(filePath)).digest('hex');
}

function normalizeInternalPath(value) {
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithinRoot(filePath, rootPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(filePath));
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function failure(status) {
  return { ok: false, status: ORIGIN_STATUSES.includes(status) ? status : 'read_failed' };
}

module.exports = {
  DEFAULT_MAX_MARKDOWN_BYTES,
  IndexedDocumentOpenError,
  ORIGIN_STATUSES,
  VALIDATED_MARKDOWN_CONTENT,
  readValidatedMarkdownCandidate,
  resolveIndexedMarkdownOpen
};
