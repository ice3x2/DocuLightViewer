'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('./frontmatter');
const { createLinkGraphIndexer } = require('./link-graph-indexer');
const { redactToken } = require('./redaction');

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

// @req FR-DOC-034
class LegacyAdopter {
  constructor({ knowledgeStoreRoot, ledger } = {}) {
    if (!knowledgeStoreRoot) throw new Error('knowledgeStoreRoot is required');
    this.knowledgeStoreRoot = path.resolve(knowledgeStoreRoot);
    this.ledger = ledger || null;
  }

  // @req FR-DOC-034
  async adoptKnowledgeStore() {
    const files = [];
    const diagnostics = [];
    await collectMarkdownFiles(this.knowledgeStoreRoot, files, {
      rootPath: this.knowledgeStoreRoot,
      diagnostics
    });
    const adopted = [];
    const seenDocumentIds = new Map();
    const contents = new Map();
    const source = this.ledger ? this.ledger.recordSource({
      rootPathInternal: this.knowledgeStoreRoot,
      sourceKind: 'knowledge_store',
      displayName: 'Knowledge Store',
      rootFingerprint: stableHash(realpathOrPath(this.knowledgeStoreRoot)),
      includeGlobs: ['**/*.md', '**/*.markdown'],
      excludeGlobs: []
    }) : null;
    const docsByPathKey = new Map();

    for (const filePath of files) {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const frontmatter = parseFrontmatter(content).data || {};
      const sourceRelativePath = path.relative(this.knowledgeStoreRoot, filePath).replace(/\\/g, '/');
      const pathKey = normalizePathKey(sourceRelativePath);
      const trustedDocumentId = normalizeTrustedDocumentId(frontmatter.documentId);
      const documentId = trustedDocumentId || stableId('legacy', pathKey);
      if (frontmatter.documentId && !trustedDocumentId) {
        diagnostics.push({
          status: 'skipped',
          diagnosticCode: 'unsafe_document_id',
          sourceRelativePath,
          redactedPath: redactToken('PATH', filePath)
        });
      }
      if (seenDocumentIds.has(documentId)) {
        diagnostics.push({
          status: 'ambiguous',
          diagnosticCode: 'duplicate_document_id',
          sourceRelativePath,
          existingSourceRelativePath: seenDocumentIds.get(documentId),
          redactedPath: redactToken('PATH', filePath)
        });
        continue;
      }
      const existingLedgerDocument = findLedgerDocumentById(this.ledger, documentId);
      if (
        existingLedgerDocument &&
        (existingLedgerDocument.source_id !== (source && source.sourceId) || normalizePathKey(existingLedgerDocument.relative_path) !== pathKey)
      ) {
        diagnostics.push({
          status: 'ambiguous',
          diagnosticCode: 'duplicate_document_id',
          sourceRelativePath,
          existingSourceRelativePath: existingLedgerDocument.relative_path,
          redactedPath: redactToken('PATH', filePath)
        });
        continue;
      }
      seenDocumentIds.set(documentId, sourceRelativePath);
      contents.set(documentId, { filePath, content, sourceRelativePath, pathKey });
      const fingerprint = buildDocumentFingerprint(content);
      const contentHash = fingerprint.contentHash;
      const existingSameSource = this.ledger && source
        ? this.ledger.findDocumentBySourcePath({ sourceId: source.sourceId, sourceRelativePath, pathKey })
        : null;
      const adoptedItem = {
        documentId,
        sourceRelativePath,
        contentHash,
        status: existingSameSource && existingSameSource.contentHash === contentHash ? 'existing' : 'adopted',
        requestedBy: 'knowledge_store.legacy_adoption'
      };
      adopted.push(adoptedItem);
      docsByPathKey.set(pathKey, adoptedItem);

      if (this.ledger && source) {
        this.ledger.upsertDocument({
          sourceId: source.sourceId,
          documentId,
          sourceRelativePath,
          pathKey,
          canonicalPathInternal: filePath,
          contentHash,
          contentByteLength: fingerprint.contentByteLength,
          contentTextLength: fingerprint.contentTextLength,
          normalizedTextHash: fingerprint.normalizedTextHash,
          docType: frontmatter.docType || null,
          category: frontmatter.category || null,
          documentTags: normalizeDocumentTags(frontmatter.documentTags),
          importState: 'legacy_adopted'
        });
        if (!existingSameSource || existingSameSource.contentHash !== contentHash) {
          this.ledger.enqueueIndexJob({
            sourceId: source.sourceId,
            documentId,
            status: 'queued',
            requestedBy: 'knowledge_store.legacy_adoption',
            currentPathInternal: filePath,
            contentHash
          });
        }
      }
    }

    if (this.ledger && source) {
      const linkIndexer = createLinkGraphIndexer({ sourceRoot: this.knowledgeStoreRoot });
      for (const item of adopted) {
        const stored = contents.get(item.documentId);
        if (!stored) continue;
        const edges = linkIndexer.extractLinks(stored.content, {
          filePath: stored.filePath,
          documentId: item.documentId,
          resolveDocument: ({ pathKey, sourceRelativePath }) => docsByPathKey.get(normalizePathKey(pathKey || sourceRelativePath))
        });
        for (const edge of edges) {
          const recorded = this.ledger.recordLinkEdge(edge);
          if (recorded.status !== 'resolved') {
            diagnostics.push({
              status: recorded.status,
              diagnosticCode: recorded.diagnosticCode,
              sourceRelativePath: stored.sourceRelativePath,
              redactedHref: recorded.redactedHref || redactToken('HREF', edge.originalHref || edge.normalizedHref || '')
            });
          }
        }
      }
    }

    return {
      adopted,
      diagnostics,
      rewrittenPaths: []
    };
  }

  // @req FR-DOC-034
  // @req FR-DOC-035
  async adoptMarkdownFile(filePath, contentOverride) {
    const absolutePath = path.resolve(requiredString(filePath, 'filePath'));
    if (!MARKDOWN_EXTENSIONS.has(path.extname(absolutePath).toLowerCase())) {
      return { status: 'skipped', diagnosticCode: 'unsupported_file_type' };
    }
    const containmentDiagnostic = realpathContainmentDiagnostic(absolutePath, this.knowledgeStoreRoot);
    if (containmentDiagnostic) {
      return {
        status: 'skipped',
        diagnosticCode: containmentDiagnostic,
        redactedPath: redactToken('PATH', absolutePath)
      };
    }
    const content = typeof contentOverride === 'string'
      ? contentOverride
      : await fs.promises.readFile(absolutePath, 'utf-8');
    const source = this.ledger ? this.ledger.recordSource({
      rootPathInternal: this.knowledgeStoreRoot,
      sourceKind: 'knowledge_store',
      displayName: 'Knowledge Store',
      rootFingerprint: stableHash(realpathOrPath(this.knowledgeStoreRoot)),
      includeGlobs: ['**/*.md', '**/*.markdown'],
      excludeGlobs: []
    }) : null;
    const frontmatter = parseFrontmatter(content).data || {};
    const sourceRelativePath = path.relative(this.knowledgeStoreRoot, absolutePath).replace(/\\/g, '/');
    const pathKey = normalizePathKey(sourceRelativePath);
    const trustedDocumentId = normalizeTrustedDocumentId(frontmatter.documentId);
    if (frontmatter.documentId && !trustedDocumentId) {
      return {
        status: 'skipped',
        diagnosticCode: 'unsafe_document_id',
        sourceRelativePath,
        redactedPath: redactToken('PATH', absolutePath)
      };
    }
    const documentId = trustedDocumentId || stableId('legacy', pathKey);
    const existingLedgerDocument = findLedgerDocumentById(this.ledger, documentId);
    if (
      existingLedgerDocument &&
      (existingLedgerDocument.source_id !== (source && source.sourceId) || normalizePathKey(existingLedgerDocument.relative_path) !== pathKey)
    ) {
      return {
        status: 'ambiguous',
        diagnosticCode: 'duplicate_document_id',
        sourceRelativePath,
        redactedPath: redactToken('PATH', absolutePath)
      };
    }
    const fingerprint = buildDocumentFingerprint(content);
    const existingSameSource = this.ledger && source
      ? this.ledger.findDocumentBySourcePath({ sourceId: source.sourceId, sourceRelativePath, pathKey })
      : null;
    const unchanged = Boolean(existingSameSource && hasSameContentFingerprint(existingSameSource, fingerprint));
    const document = this.ledger && source
      ? this.ledger.upsertDocument({
        sourceId: source.sourceId,
        documentId,
        sourceRelativePath,
        pathKey,
        canonicalPathInternal: absolutePath,
        contentHash: fingerprint.contentHash,
        contentByteLength: fingerprint.contentByteLength,
        contentTextLength: fingerprint.contentTextLength,
        normalizedTextHash: fingerprint.normalizedTextHash,
        docType: frontmatter.docType || null,
        category: frontmatter.category || null,
        documentTags: normalizeDocumentTags(frontmatter.documentTags),
        importState: 'legacy_adopted'
      })
      : null;
    return {
      status: unchanged ? 'existing' : 'adopted',
      document,
      source,
      documentId,
      sourceRelativePath,
      pathKey,
      contentHash: fingerprint.contentHash,
      requestedBy: 'knowledge_store.legacy_adoption',
      shouldQueue: !unchanged
    };
  }
}

function createLegacyAdopter(options = {}) {
  return new LegacyAdopter(options);
}

function createLegacyAdoptionService(options = {}) {
  return createLegacyAdopter(options);
}

async function collectMarkdownFiles(dirPath, output, state, depth = 0) {
  if (depth > 64) return;
  if (realpathContainmentDiagnostic(dirPath, state.rootPath)) {
    state.diagnostics.push({
      status: 'path_policy_violation',
      diagnosticCode: 'realpath_outside_source_root',
      redactedPath: redactToken('PATH', dirPath)
    });
    return;
  }
  let entries = [];
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = normalizePathKey(path.relative(state.rootPath, fullPath));
    if (isDefaultExcluded(relativePath, entry.name)) continue;
    if (entry.isSymbolicLink()) {
      const diagnosticCode = realpathContainmentDiagnostic(fullPath, state.rootPath);
      if (diagnosticCode) {
        state.diagnostics.push({
          status: 'path_policy_violation',
          diagnosticCode,
          redactedPath: redactToken('PATH', fullPath)
        });
      }
      continue;
    }
    if (entry.isDirectory()) {
      await collectMarkdownFiles(fullPath, output, state, depth + 1);
    } else if (entry.isFile() && MARKDOWN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      const diagnosticCode = realpathContainmentDiagnostic(fullPath, state.rootPath);
      if (diagnosticCode) {
        state.diagnostics.push({
          status: 'path_policy_violation',
          diagnosticCode,
          redactedPath: redactToken('PATH', fullPath)
        });
        continue;
      }
      output.push(fullPath);
    }
  }
}

function normalizeTrustedDocumentId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 128) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(trimmed)) return null;
  if (/[\\/]/.test(trimmed)) return null;
  if (/^[A-Za-z]:/.test(trimmed)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !trimmed.startsWith('doc:')) return null;
  if (/(api[_-]?key|token|password|passwd|secret|credential|bearer)/i.test(trimmed)) return null;
  return trimmed;
}

function isDefaultExcluded(sourceRelativePath, entryName) {
  const key = normalizePathKey(sourceRelativePath);
  const name = String(entryName || '').toLowerCase();
  return key === 'node_modules' ||
    key.startsWith('node_modules/') ||
    key.includes('/node_modules/') ||
    key === '.git' ||
    key.startsWith('.git/') ||
    key.includes('/.git/') ||
    name.startsWith('~$') ||
    name.endsWith('.tmp') ||
    name.endsWith('.swp') ||
    (name.startsWith('.') && MARKDOWN_EXTENSIONS.has(path.extname(name)));
}

function realpathContainmentDiagnostic(targetPath, rootPath) {
  if (!fs.existsSync(targetPath)) return null;
  try {
    const realRoot = fs.realpathSync.native ? fs.realpathSync.native(rootPath) : fs.realpathSync(rootPath);
    const realTarget = fs.realpathSync.native ? fs.realpathSync.native(targetPath) : fs.realpathSync(targetPath);
    return isWithinRoot(realTarget, realRoot) ? null : 'realpath_outside_source_root';
  } catch {
    return 'realpath_failed';
  }
}

function isWithinRoot(filePath, rootPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(filePath));
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizePathKey(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .join('/')
    .normalize('NFC')
    .toLowerCase();
}

function stableId(prefix, value) {
  return `${prefix}_${stableHash(value).slice(0, 24)}`;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
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

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function realpathOrPath(value) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function normalizeDocumentTags(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function findLedgerDocumentById(ledger, documentId) {
  if (!ledger || !documentId || typeof ledger.open !== 'function') return null;
  try {
    return ledger.open().prepare('SELECT document_id, source_id, relative_path FROM documents WHERE document_id = ?').get(documentId) || null;
  } catch {
    return null;
  }
}

module.exports = {
  LegacyAdopter,
  createLegacyAdopter,
  createLegacyAdoptionService
};
