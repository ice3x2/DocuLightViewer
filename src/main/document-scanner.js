'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createRedactor, redactToken } = require('./redaction');

const DEFAULT_INCLUDE_GLOBS = Object.freeze(['**/*.md', '**/*.markdown']);
const DEFAULT_EXCLUDE_GLOBS = Object.freeze([
  'node_modules/**',
  '**/node_modules/**',
  '.git/**',
  '**/.git/**'
]);
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

// @req DR-DOC-009
class DocumentScanner {
  constructor({
    sourceRoot,
    displayName,
    includeGlobs = DEFAULT_INCLUDE_GLOBS,
    excludeGlobs = [],
    enabled = true,
    indexDataDir = null,
    ledger = null,
    maxDepth = 64,
    maxFiles = 100000
  } = {}) {
    if (!sourceRoot) throw new Error('sourceRoot is required');
    this.sourceRoot = path.resolve(sourceRoot);
    this.displayName = displayName || path.basename(this.sourceRoot) || 'Source';
    this.includeGlobs = normalizeGlobList(includeGlobs, DEFAULT_INCLUDE_GLOBS);
    this.excludeGlobs = [...DEFAULT_EXCLUDE_GLOBS, ...normalizeGlobList(excludeGlobs, [])];
    this.enabled = enabled !== false;
    this.indexDataDir = indexDataDir ? path.resolve(indexDataDir) : null;
    this.ledger = ledger || null;
    this.maxDepth = Math.max(0, Number(maxDepth) || 0);
    this.maxFiles = Math.max(1, Number(maxFiles) || 1);
    this.redactor = createRedactor({
      sourceRoots: [this.sourceRoot].filter(Boolean),
      indexDir: this.indexDataDir
    });
  }

  // @req DR-DOC-009
  async scan() {
    const rootFingerprint = fingerprintRoot(this.sourceRoot);
    const diagnostics = [];
    const previousSource = findExistingSourceByRoot(this.ledger, this.sourceRoot);
    if (previousSource && previousSource.root_fingerprint && previousSource.root_fingerprint !== rootFingerprint) {
      diagnostics.push({
        status: 'stale',
        diagnosticCode: 'root_fingerprint_changed',
        rebuildRecommended: true,
        rootPathToken: redactToken('PATH', this.sourceRoot),
        previousRootFingerprint: previousSource.root_fingerprint,
        rootFingerprint
      });
    }

    const source = this.ledger ? this.ledger.recordSource({
      rootPathInternal: this.sourceRoot,
      sourceKind: 'document_source',
      displayName: this.displayName,
      rootFingerprint,
      includeGlobs: this.includeGlobs,
      excludeGlobs: this.excludeGlobs,
      enabled: this.enabled
    }) : {
      sourceId: stableId('src', normalizeInternalPath(this.sourceRoot), rootFingerprint),
      sourceKind: 'document_source',
      displayName: this.displayName,
      rootFingerprint,
      rootPathToken: redactToken('PATH', this.sourceRoot),
      includeGlobs: this.includeGlobs,
      excludeGlobs: this.excludeGlobs,
      enabled: this.enabled
    };

    const documents = [];
    const basenameMap = new Map();
    if (this.enabled) {
      await this.collect(this.sourceRoot, documents, diagnostics, basenameMap, source, 0);
    }
    for (const [basename, items] of basenameMap.entries()) {
      if (items.length <= 1) continue;
      diagnostics.push({
        status: 'ambiguous',
        diagnosticCode: 'duplicate_basename',
        basename,
        candidates: items.map((item) => ({
          documentId: item.documentId,
          sourceRelativePath: item.sourceRelativePath
        }))
      });
    }

    documents.sort((a, b) => a.sourceRelativePath.localeCompare(b.sourceRelativePath, 'en', { numeric: true }));
    return this.redactor.redactValue({
      source,
      documents,
      diagnostics
    });
  }

  async collect(dirPath, documents, diagnostics, basenameMap, source, depth) {
    if (depth > this.maxDepth || documents.length >= this.maxFiles) return;
    const dirDiagnostic = realpathContainmentDiagnostic(dirPath, this.sourceRoot);
    if (dirDiagnostic) {
      diagnostics.push(pathDiagnostic(dirDiagnostic, dirPath));
      return;
    }

    let entries = [];
    try {
      entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      diagnostics.push({
        status: 'skipped',
        diagnosticCode: 'read_failed',
        redactedPath: redactToken('PATH', dirPath),
        message: this.redactor.redactString(err && err.message ? err.message : String(err))
      });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));

    for (const entry of entries) {
      if (documents.length >= this.maxFiles) return;
      const fullPath = path.join(dirPath, entry.name);
      const sourceRelativePath = toSourceRelativePath(fullPath, this.sourceRoot);

      if (isDefaultExcluded(sourceRelativePath, entry.name, fullPath, this.indexDataDir)) continue;
      if (matchesAnyGlob(sourceRelativePath, this.excludeGlobs)) continue;

      if (entry.isSymbolicLink()) {
        const diagnosticCode = realpathContainmentDiagnostic(fullPath, this.sourceRoot);
        if (diagnosticCode) {
          diagnostics.push(pathDiagnostic(diagnosticCode, fullPath));
          continue;
        }
      }

      if (entry.isDirectory()) {
        await this.collect(fullPath, documents, diagnostics, basenameMap, source, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!MARKDOWN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      if (!matchesAnyGlob(sourceRelativePath, this.includeGlobs)) continue;

      const fileDiagnostic = realpathContainmentDiagnostic(fullPath, this.sourceRoot);
      if (fileDiagnostic) {
        diagnostics.push(pathDiagnostic(fileDiagnostic, fullPath));
        continue;
      }

      const pathKey = normalizePathKey(sourceRelativePath);
      const document = {
        documentId: stableId('doc', source.sourceId, pathKey),
        sourceId: source.sourceId,
        sourceRelativePath,
        pathKey,
        contentHash: `sha256:${fileSha256(fullPath)}`,
        redactedPath: redactToken('PATH', fullPath)
      };
      documents.push(document);
      const basename = path.basename(pathKey).toLowerCase();
      if (!basenameMap.has(basename)) basenameMap.set(basename, []);
      basenameMap.get(basename).push(document);
    }
  }
}

function createDocumentScanner(options = {}) {
  return new DocumentScanner(options);
}

function createSourceScanner(options = {}) {
  return createDocumentScanner(options);
}

function normalizeGlobList(value, fallback) {
  const list = Array.isArray(value) ? value : [];
  const normalized = list.map((item) => String(item || '').replace(/\\/g, '/').trim()).filter(Boolean);
  return normalized.length ? normalized : Array.from(fallback);
}

function isDefaultExcluded(sourceRelativePath, entryName, fullPath, indexDataDir) {
  const key = normalizePathKey(sourceRelativePath);
  const name = String(entryName || '');
  if (key === 'node_modules' || key.startsWith('node_modules/') || key.includes('/node_modules/')) return true;
  if (key === '.git' || key.startsWith('.git/') || key.includes('/.git/')) return true;
  if (indexDataDir && isWithinRoot(fullPath, indexDataDir)) return true;
  if (isHiddenTemporaryName(name)) return true;
  return false;
}

function isHiddenTemporaryName(name) {
  const lower = String(name || '').toLowerCase();
  return lower.startsWith('~$') ||
    lower.endsWith('.tmp') ||
    lower.endsWith('.swp') ||
    lower.endsWith('.swx') ||
    (lower.startsWith('.') && MARKDOWN_EXTENSIONS.has(path.extname(lower)));
}

function matchesAnyGlob(sourceRelativePath, globs) {
  const key = normalizePathKey(sourceRelativePath);
  return globs.some((glob) => matchesGlob(key, normalizePathKey(glob)));
}

function matchesGlob(key, glob) {
  if (!glob || glob === '**') return true;
  if (glob === '**/*.md') return key.endsWith('.md');
  if (glob === '**/*.markdown') return key.endsWith('.markdown');
  if (glob.endsWith('/**')) {
    const prefix = glob.slice(0, -3);
    return key === prefix || key.startsWith(`${prefix}/`);
  }
  if (glob.startsWith('**/')) {
    const suffix = glob.slice(3);
    return key === suffix || key.endsWith(`/${suffix}`) || matchesGlob(key, suffix);
  }
  if (glob.includes('*')) {
    const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    return new RegExp(`^${escaped}$`).test(key);
  }
  return key === glob;
}

function findExistingSourceByRoot(ledger, sourceRoot) {
  if (!ledger || typeof ledger.open !== 'function') return null;
  try {
    return ledger.open().prepare('SELECT * FROM sources WHERE root_path_internal = ?').get(normalizeInternalPath(sourceRoot)) || null;
  } catch {
    return null;
  }
}

function pathDiagnostic(diagnosticCode, filePath) {
  return {
    status: 'path_policy_violation',
    diagnosticCode,
    redactedPath: redactToken('PATH', filePath)
  };
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

function toSourceRelativePath(filePath, rootPath) {
  return path.relative(path.resolve(rootPath), path.resolve(filePath)).replace(/\\/g, '/');
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

function normalizeInternalPath(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function fingerprintRoot(sourceRoot) {
  const real = realpathOrPath(sourceRoot);
  let statToken = '';
  try {
    const stat = fs.statSync(real);
    statToken = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  } catch {
    statToken = 'missing';
  }
  return stableHash(`${normalizeInternalPath(real)}\0${statToken}`);
}

function realpathOrPath(value) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function fileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function stableId(prefix, ...parts) {
  return `${prefix}_${stableHash(parts.join('\0')).slice(0, 24)}`;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

module.exports = {
  DocumentScanner,
  createDocumentScanner,
  createSourceScanner
};
