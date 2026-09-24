'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLinkGraphIndexer } = require('./link-graph-indexer');
const { publishSave, readPendingSave } = require('./index-ingress-store');
const { createRedactor, redactToken } = require('./redaction');

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
const MAX_IMPORT_DIAGNOSTICS = 100;

// @req FR-DOC-033
// @req CON-DOC-007
class LinkedImporter {
  constructor({
    sourceRoot,
    knowledgeStoreRoot,
    ledger = null,
    ownerController = null,
    ingressRoot = null,
    signal = null,
    maxDepth = 4,
    maxFiles = 100,
    maxTotalBytes = 50 * 1024 * 1024
  } = {}) {
    if (!sourceRoot) throw new Error('sourceRoot is required');
    this.sourceRoot = realpathOrPath(sourceRoot);
    this.knowledgeStoreRoot = knowledgeStoreRoot ? realpathOrPath(knowledgeStoreRoot) : null;
    this.ledger = ledger || null;
    this.ownerController = ownerController;
    this.ingressRoot = ingressRoot;
    this.signal = signal;
    this.acknowledgedImports = new Set();
    this.inFlight = new Map();
    this.maxDepth = Math.max(0, Number(maxDepth) || 0);
    this.maxFiles = Math.max(1, Number(maxFiles) || 1);
    this.maxTotalBytes = Math.max(1, Number(maxTotalBytes) || 1);
    this.redactor = createRedactor({
      sourceRoots: [this.sourceRoot, this.knowledgeStoreRoot].filter(Boolean)
    });
  }

  // @req FR-DOC-033
  async importMarkdownGraph(entryPath) {
    const source = this.recordSource();
    const sourceIndex = await buildSourceIndex(this.sourceRoot, {
      maxDepth: this.maxDepth,
      maxFiles: this.maxFiles,
      maxTotalBytes: this.maxTotalBytes
    }, source);
    const linkIndexer = createLinkGraphIndexer({ sourceRoot: this.sourceRoot });
    const counts = createCounts();
    const diagnosticCounts = Object.create(null);
    const diagnostics = [];
    const unconfirmed = [];
    const recordDiagnostic = item => {
      diagnosticCounts[item.diagnosticCode] = (diagnosticCounts[item.diagnosticCode] || 0) + 1;
      if (diagnostics.length < MAX_IMPORT_DIAGNOSTICS) diagnostics.push(item);
    };
    const imported = [];
    const visited = new Set();
    const pending = [{
      filePath: fs.existsSync(entryPath) ? realpathOrPath(entryPath) : path.resolve(entryPath),
      lexicalPath: path.resolve(entryPath),
      depth: 0
    }];
    let totalBytes = 0;

    while (pending.length > 0) {
      if (this.signal?.aborted) {
        recordDiagnostic(diagnostic('skipped', 'cancelled', '', this.redactor));
        break;
      }
      const current = pending.shift();
      const containment = containmentDiagnostic(current.filePath, this.sourceRoot);
      if (containment) {
        counts.path_policy_violation += 1;
        recordDiagnostic(diagnostic('path_policy_violation', containment, current.filePath, this.redactor));
        continue;
      }
      const canonicalKey = canonicalIdentityKey(current.filePath);
      if (visited.has(canonicalKey)) {
        counts.skipped += 1;
        recordDiagnostic(diagnostic('skipped', 'skipped_cycle', current.filePath, this.redactor));
        continue;
      }
      if (current.depth > this.maxDepth || imported.length >= this.maxFiles) {
        counts.skipped += 1;
        recordDiagnostic(diagnostic('skipped', current.depth > this.maxDepth
          ? 'skipped_depth' : 'skipped_file_count', current.filePath, this.redactor));
        continue;
      }
      if (!fs.existsSync(current.filePath)) {
        counts.missing += 1;
        recordDiagnostic(diagnostic('missing', 'target_missing', current.filePath, this.redactor));
        continue;
      }

      let sourceRelativePath;
      let content;
      let candidateBytes;
      let persistResult;
      try {
        const stat = fs.statSync(current.filePath);
        if (totalBytes + stat.size > this.maxTotalBytes) {
          counts.skipped += 1;
          recordDiagnostic(diagnostic('skipped', 'skipped_total_bytes', current.filePath, this.redactor));
          continue;
        }
        sourceRelativePath = toSourceRelativePath(current.filePath, this.sourceRoot);
        const destinationCheck = this.resolveKnowledgeStoreDestination(sourceRelativePath);
        if (destinationCheck?.status === 'ambiguous') {
          counts.ambiguous += 1;
          recordDiagnostic(diagnostic('ambiguous', destinationCheck.diagnosticCode,
            destinationCheck.targetPath, this.redactor));
          continue;
        }
        content = await fs.promises.readFile(current.filePath, 'utf-8');
        candidateBytes = Buffer.byteLength(content, 'utf8');
        if (totalBytes + candidateBytes > this.maxTotalBytes) {
          counts.skipped += 1;
          recordDiagnostic(diagnostic('skipped', 'skipped_total_bytes', current.filePath, this.redactor));
          continue;
        }
        visited.add(canonicalKey);
        persistResult = await this.persistCandidate({ source, filePath: current.filePath,
          lexicalPath: current.lexicalPath || current.filePath, sourceRelativePath, content });
      } catch (error) {
        counts.stale += 1;
        recordDiagnostic(diagnostic('stale', error.code || 'import_candidate_failed',
          current.filePath, this.redactor));
        break;
      }
      if (persistResult && persistResult.status === 'ambiguous') {
        counts.ambiguous += 1;
        recordDiagnostic(diagnostic('ambiguous', persistResult.diagnosticCode, persistResult.targetPath, this.redactor));
        visited.add(canonicalKey);
        continue;
      }
      if (persistResult?.status === 'unconfirmed') {
        diagnosticCounts.ack_unknown = (diagnosticCounts.ack_unknown || 0) + 1;
        unconfirmed.push({ sourceRelativePath, diagnosticCode: 'ack_unknown' });
        break;
      }
      if (!persistResult || persistResult.status === 'failed') {
        counts.stale += 1;
        recordDiagnostic(diagnostic('stale', persistResult?.diagnosticCode || 'index_enqueue_failed',
          current.filePath, this.redactor));
        break;
      }
      const documentId = persistResult.documentId;
      if (persistResult.status === 'existing') {
        counts.existing += 1;
      } else if (persistResult.status === 'updated') {
        counts.updated += 1;
      } else {
        counts.imported += 1;
      }
      imported.push({ documentId, sourceRelativePath, status: persistResult.status });
      totalBytes += candidateBytes;

      const edges = linkIndexer.extractLinks(content, {
        filePath: current.filePath,
        documentId,
        resolveDocument: ({ pathKey, filePath }) => resolveIndexedDocument(sourceIndex, pathKey, filePath)
      });

      for (const edge of edges) {
        const adjusted = adjustAmbiguous(edge, sourceIndex);
        if (adjusted.status === 'resolved') {
          const targetPath = sourceIndex.byDocumentId.get(adjusted.toDocumentId);
          if (targetPath && !visited.has(canonicalIdentityKey(targetPath))) {
            pending.push({ filePath: targetPath, lexicalPath: targetPath, depth: current.depth + 1 });
          } else {
            counts.skipped += 1;
            recordDiagnostic(diagnostic('skipped', 'skipped_cycle', targetPath || adjusted.normalizedHref, this.redactor));
            continue;
          }
          continue;
        }
        incrementCount(counts, adjusted.status);
        recordDiagnostic(edgeDiagnostic(adjusted, sourceRelativePath, this.redactor));
      }
    }
    return {
      source,
      counts,
      diagnosticCounts,
      unconfirmedCount: unconfirmed.length,
      unconfirmed,
      imported,
      diagnostics
    };
  }

  recordSource() {
    return {
      sourceId: stableId('src', normalizeInternalPath(this.sourceRoot), stableHash(this.sourceRoot)),
      sourceKind: 'local_import_source',
      rootFingerprint: stableHash(this.sourceRoot)
    };
  }

  async persistCandidate({ source, filePath, lexicalPath, sourceRelativePath, content }) {
    const key = canonicalIdentityKey(filePath);
    const active = this.inFlight.get(key);
    if (active) {
      const result = await active;
      return result?.documentId ? { ...result, status: 'existing' } : result;
    }
    const pending = this.persistCandidateOnce({ source, filePath, lexicalPath, sourceRelativePath, content });
    this.inFlight.set(key, pending);
    try { return await pending; }
    finally { this.inFlight.delete(key); }
  }

  async persistCandidateOnce({ source, filePath, lexicalPath, sourceRelativePath, content }) {
    const pathKey = normalizePathKey(sourceRelativePath);
    const sourceId = source.sourceId;
    const fingerprint = buildDocumentFingerprint(content);
    const canonicalPathInternal = realpathOrPath(filePath);
    const destination = this.resolveKnowledgeStoreDestination(sourceRelativePath);
    if (destination.status === 'ambiguous') return destination;
    const { targetPath } = destination;
    const existingByPath = this.ledger?.findDocumentBySourcePath({ sourceId, sourceRelativePath, pathKey });
    const existingByCanonical = this.ledger?.findDocumentByCanonicalPath({ canonicalPathInternal });
    if (existingByCanonical?.sourceId && existingByCanonical.sourceId !== sourceId) {
      return { status: 'ambiguous', diagnosticCode: 'canonical_source_collision', targetPath: filePath };
    }
    const existing = existingByPath || existingByCanonical || null;
    const canonicalPathHash = stableHash(normalizeInternalPath(canonicalPathInternal));
    const hasExactAlias = existing && this.ledger?.hasExactDocumentSourceAlias({
      documentId: existing.documentId, originLexicalPathInternal: lexicalPath,
      canonicalPathHash, contentHash: fingerprint.contentHash });
    const destinationExists = fs.existsSync(targetPath);
    const ingressRoot = this.ingressRoot || this.ownerController?.config?.ingressRoot;
    const pendingPublication = !existing && destinationExists && ingressRoot && fs.existsSync(ingressRoot)
      ? fs.readdirSync(ingressRoot).filter(name => /^[a-f0-9]{64}\.intent\.json$/.test(name))
        .map(name => readPendingSave({ ingressRoot, storeRoot: this.knowledgeStoreRoot,
          intentId: name.slice(0, 64) }))
        .find(intent => intent?.published && intent.sourceId === sourceId
          && intent.sourceRelativeLocator === sourceRelativePath
          && intent.contentHash === stableHash(Buffer.from(content, 'utf8')))
      : null;
    if (!existing && destinationExists && !pendingPublication) return { status: 'ambiguous',
      diagnosticCode: fs.readFileSync(targetPath, 'utf8') === content
        ? 'legacy_destination_without_source_identity' : 'destination_collision', targetPath };
    if (existing && hasSameContentFingerprint(existing, fingerprint)) {
      if (!destinationExists || fs.readFileSync(targetPath, 'utf8') !== content) return {
        status: 'ambiguous', diagnosticCode: 'destination_content_mismatch', targetPath };
      if (hasExactAlias) return { status: 'existing', documentId: existing.documentId,
        contentHash: fingerprint.contentHash };
    }
    if (existing && !destinationExists) return { status: 'ambiguous',
      diagnosticCode: 'destination_missing', targetPath };
    if (!this.ownerController?.acceptPublishedSave || !this.knowledgeStoreRoot) return {
      status: 'failed', diagnosticCode: 'owner_unavailable' };
    const contentBytes = Buffer.from(content, 'utf8');
    const contentHash = stableHash(contentBytes);
    const operation = existing && !hasSameContentFingerprint(existing, fingerprint) ? 'update' : 'linked_import';
    const rootFingerprint = stableHash(path.resolve(this.knowledgeStoreRoot));
    const provenance = { aliases: [{ lexicalOriginalPath: path.resolve(lexicalPath),
      canonicalOriginalPath: canonicalPathInternal,
      canonicalPathHash }], metadata: {} };
    let publication;
    try {
      publication = await publishSave({ storeRoot: this.knowledgeStoreRoot, ingressRoot,
        contentBytes, contentHash, operation, sourceId, rootFingerprint,
        sourceRelativeLocator: sourceRelativePath, provenance,
        faultAt: typeof this.r3PublishFaultAt === 'function'
          ? this.r3PublishFaultAt({ sourceRelativePath }) : undefined,
        expectedExistingHash: existing && operation === 'update'
          ? existing.contentHash?.replace(/^sha256:/, '') : undefined,
        requireVacant: !existing && !pendingPublication });
    } catch (error) {
      if (!existing && error.code === 'published_file_mismatch') {
        const raced = this.ledger?.findDocumentBySourcePath({ sourceId, sourceRelativePath, pathKey });
        if (hasSameContentFingerprint(raced, fingerprint)) return {
          status: 'existing', documentId: raced.documentId, contentHash: fingerprint.contentHash };
      }
      return { status: 'failed', diagnosticCode: error.code || 'index_enqueue_failed' };
    }
    const acceptance = { intentId: publication.intentId,
      operation, sourceId, rootFingerprint, sourceRelativeLocator: sourceRelativePath,
      contentHash, provenance };
    let accepted;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { accepted = await this.ownerController.acceptPublishedSave(acceptance); }
      catch { accepted = null; }
      if (accepted?.accepted) break;
    }
    if (!accepted?.accepted) return { status: 'unconfirmed', diagnosticCode: 'ack_unknown' };
    const alreadyAcknowledged = this.acknowledgedImports.has(publication.intentId);
    this.acknowledgedImports.add(publication.intentId);
    return { status: alreadyAcknowledged || accepted.indexingState === 'provenance_only'
      ? 'existing' : existing ? 'updated' : 'imported', documentId: accepted.documentId,
      desiredRevision: accepted.desiredRevision, contentHash: fingerprint.contentHash };
  }

  checkKnowledgeStoreDestination(sourceRelativePath, content, { allowOverwrite = false } = {}) {
    if (!this.knowledgeStoreRoot) return null;
    const destination = this.resolveKnowledgeStoreDestination(sourceRelativePath);
    if (!destination) return null;
    if (destination.status === 'ambiguous') return destination;
    const { targetPath } = destination;
    if (!fs.existsSync(targetPath)) return { status: 'writable', targetPath };
    const existing = fs.readFileSync(targetPath, 'utf-8');
    if (allowOverwrite && existing === content) return { status: 'existing', targetPath };
    if (allowOverwrite) return { status: 'writable', targetPath };
    return {
      status: 'ambiguous',
      diagnosticCode: existing === content ? 'legacy_destination_without_source_identity' : 'destination_collision',
      targetPath
    };
  }

  resolveKnowledgeStoreDestination(sourceRelativePath) {
    if (!this.knowledgeStoreRoot) return null;
    const relativePathDiagnostic = destinationRelativePathDiagnostic(sourceRelativePath);
    if (relativePathDiagnostic) {
      const diagnosticPath = String(sourceRelativePath || '').includes('\0')
        ? this.knowledgeStoreRoot
        : path.resolve(this.knowledgeStoreRoot, String(sourceRelativePath || ''));
      return destinationPolicyDiagnostic(relativePathDiagnostic, diagnosticPath);
    }
    const targetPath = path.resolve(this.knowledgeStoreRoot, sourceRelativePath);
    if (
      normalizeInternalPath(targetPath) === normalizeInternalPath(this.knowledgeStoreRoot) ||
      !isWithinRoot(targetPath, this.knowledgeStoreRoot)
    ) {
      return destinationPolicyDiagnostic('destination_path_policy_violation', targetPath);
    }

    try {
      fs.mkdirSync(this.knowledgeStoreRoot, { recursive: true });
    } catch {
      return destinationPolicyDiagnostic('destination_root_unwritable', targetPath);
    }

    const rootReal = tryRealpath(this.knowledgeStoreRoot);
    if (!rootReal.ok) return destinationPolicyDiagnostic('destination_root_realpath_failed', targetPath);

    const parentPath = path.dirname(targetPath);
    const existingAncestor = findExistingAncestor(parentPath);
    if (!existingAncestor || !isWithinRoot(existingAncestor, this.knowledgeStoreRoot)) {
      return destinationPolicyDiagnostic('destination_path_policy_violation', targetPath);
    }

    const ancestorReal = tryRealpath(existingAncestor);
    if (!ancestorReal.ok) return destinationPolicyDiagnostic('destination_realpath_failed', targetPath);
    if (!isWithinRoot(ancestorReal.value, rootReal.value)) {
      return destinationPolicyDiagnostic('destination_realpath_outside_store', targetPath);
    }

    try {
      fs.mkdirSync(parentPath, { recursive: true });
    } catch {
      return destinationPolicyDiagnostic('destination_parent_unwritable', targetPath);
    }

    const parentReal = tryRealpath(parentPath);
    if (!parentReal.ok) return destinationPolicyDiagnostic('destination_realpath_failed', targetPath);
    if (!isWithinRoot(parentReal.value, rootReal.value)) {
      return destinationPolicyDiagnostic('destination_realpath_outside_store', targetPath);
    }

    const targetStat = lstatIfPresent(targetPath);
    if (targetStat && targetStat.isDirectory()) {
      return destinationPolicyDiagnostic('destination_not_file', targetPath);
    }
    if (targetStat) {
      const targetReal = tryRealpath(targetPath);
      if (!targetReal.ok) return destinationPolicyDiagnostic('destination_realpath_failed', targetPath);
      if (!isWithinRoot(targetReal.value, rootReal.value)) {
        return destinationPolicyDiagnostic('destination_realpath_outside_store', targetPath);
      }
    }

    return { status: 'writable', targetPath };
  }
}

function createLinkedImporter(options = {}) {
  return new LinkedImporter(options);
}

function createLinkedImportService(options = {}) {
  return createLinkedImporter(options);
}

async function buildSourceIndex(sourceRoot, limits = {}, source = null) {
  const files = [];
  const scanLimits = {
    sourceRoot,
    maxDepth: Math.max(0, Number(limits.maxDepth) || 0),
    maxFiles: Math.max(1, Number(limits.maxFiles) || 1),
    maxTotalBytes: Math.max(1, Number(limits.maxTotalBytes) || 1),
    totalBytes: 0
  };
  await collectMarkdownFiles(sourceRoot, files, scanLimits);
  const byPathKey = new Map();
  const byDocumentId = new Map();
  const byBasename = new Map();
  for (const filePath of files) {
    const relative = toSourceRelativePath(filePath, sourceRoot);
    const pathKey = normalizePathKey(relative);
    const documentId = stableDocumentId(source && source.sourceId, pathKey);
    byPathKey.set(pathKey, { documentId, filePath, sourceRelativePath: relative });
    byDocumentId.set(documentId, filePath);
    const base = path.basename(pathKey).toLowerCase();
    if (!byBasename.has(base)) byBasename.set(base, []);
    byBasename.get(base).push({ documentId, filePath, sourceRelativePath: relative });
  }
  return { sourceRoot, sourceId: source && source.sourceId ? source.sourceId : null, limits: scanLimits, byPathKey, byDocumentId, byBasename };
}

async function collectMarkdownFiles(dirPath, output, limits, depth = 0) {
  if (depth > limits.maxDepth || output.length >= limits.maxFiles) return;
  if (realpathContainmentDiagnostic(dirPath, limits.sourceRoot)) return;
  let entries = [];
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  for (const entry of entries) {
    if (output.length >= limits.maxFiles) return;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await collectMarkdownFiles(fullPath, output, limits, depth + 1);
    } else if (entry.isFile() && MARKDOWN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      const candidateContainment = realpathContainmentDiagnostic(fullPath, limits.sourceRoot);
      if (candidateContainment) continue;
      const stat = fs.statSync(fullPath);
      if (limits.totalBytes + stat.size > limits.maxTotalBytes) return;
      limits.totalBytes += stat.size;
      output.push(fullPath);
    }
  }
}

function resolveIndexedDocument(sourceIndex, pathKey, filePath) {
  const normalizedPathKey = normalizePathKey(pathKey || '');
  const base = path.basename(normalizedPathKey || String(filePath || '')).toLowerCase();
  if (base && !normalizedPathKey.includes('/') && hasMultipleBasenameCandidates(sourceIndex, base)) {
    return null;
  }
  if (sourceIndex.byPathKey.has(normalizedPathKey)) return sourceIndex.byPathKey.get(normalizedPathKey);
  const dynamic = resolveDynamicDocument(sourceIndex, filePath);
  if (dynamic) return dynamic;
  const candidates = sourceIndex.byBasename.get(base) || [];
  if (candidates.length === 1 && hasMultipleBasenameCandidates(sourceIndex, base)) return null;
  return candidates.length === 1 ? candidates[0] : null;
}

function resolveDynamicDocument(sourceIndex, filePath) {
  if (!filePath || !sourceIndex.sourceRoot) return null;
  const absolutePath = path.resolve(filePath);
  if (!isWithinRoot(absolutePath, sourceIndex.sourceRoot) || realpathContainmentDiagnostic(absolutePath, sourceIndex.sourceRoot)) {
    return null;
  }
  if (!fs.existsSync(absolutePath) || !MARKDOWN_EXTENSIONS.has(path.extname(absolutePath).toLowerCase())) {
    return null;
  }
  const sourceRelativePath = toSourceRelativePath(absolutePath, sourceIndex.sourceRoot);
  const pathKey = normalizePathKey(sourceRelativePath);
  const document = {
    documentId: stableDocumentId(sourceIndex.sourceId, pathKey),
    filePath: absolutePath,
    sourceRelativePath
  };
  sourceIndex.byPathKey.set(pathKey, document);
  sourceIndex.byDocumentId.set(document.documentId, absolutePath);
  const base = path.basename(pathKey).toLowerCase();
  if (!sourceIndex.byBasename.has(base)) sourceIndex.byBasename.set(base, []);
  if (!sourceIndex.byBasename.get(base).some((item) => item.documentId === document.documentId)) {
    sourceIndex.byBasename.get(base).push(document);
  }
  return document;
}

function adjustAmbiguous(edge, sourceIndex) {
  if (edge.status !== 'missing') return edge;
  const base = path.basename(normalizePathKey(edge.normalizedHref || edge.originalHref || '')).toLowerCase();
  const candidates = sourceIndex.byBasename.get(base) || [];
  if (candidates.length <= 1 && !hasMultipleBasenameCandidates(sourceIndex, base)) return edge;
  return {
    ...edge,
    status: 'ambiguous',
    diagnosticCode: 'ambiguous_target'
  };
}

function hasMultipleBasenameCandidates(sourceIndex, basename) {
  if (!basename || !sourceIndex.sourceRoot) return false;
  const normalizedBasename = String(basename).toLowerCase();
  const known = sourceIndex.byBasename.get(normalizedBasename) || [];
  if (known.length > 1) return true;

  const found = [];
  const maxVisited = Math.max(256, (sourceIndex.limits && sourceIndex.limits.maxFiles ? sourceIndex.limits.maxFiles : 100) * 4);
  scanForBasename(sourceIndex.sourceRoot, normalizedBasename, found, {
    sourceRoot: sourceIndex.sourceRoot,
    sourceId: sourceIndex.sourceId || null,
    visited: 0,
    maxVisited
  });

  const merged = new Map();
  for (const item of known) merged.set(normalizeInternalPath(item.filePath), item);
  for (const item of found) {
    merged.set(normalizeInternalPath(item.filePath), item);
    const pathKey = normalizePathKey(item.sourceRelativePath);
    if (!sourceIndex.byPathKey.has(pathKey)) sourceIndex.byPathKey.set(pathKey, item);
    if (!sourceIndex.byDocumentId.has(item.documentId)) sourceIndex.byDocumentId.set(item.documentId, item.filePath);
  }
  const values = Array.from(merged.values());
  sourceIndex.byBasename.set(normalizedBasename, values);
  return values.length > 1;
}

function scanForBasename(dirPath, basename, found, state) {
  if (found.length > 1 || state.visited >= state.maxVisited) return;
  if (realpathContainmentDiagnostic(dirPath, state.sourceRoot)) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  for (const entry of entries) {
    if (found.length > 1 || state.visited >= state.maxVisited) return;
    const fullPath = path.join(dirPath, entry.name);
    state.visited += 1;
    if (entry.isDirectory()) {
      scanForBasename(fullPath, basename, found, state);
    } else if (
      entry.isFile() &&
      path.basename(entry.name).toLowerCase() === basename &&
      MARKDOWN_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) &&
      !realpathContainmentDiagnostic(fullPath, state.sourceRoot)
    ) {
      const sourceRelativePath = toSourceRelativePath(fullPath, state.sourceRoot);
      found.push({
        documentId: stableDocumentId(state.sourceId, normalizePathKey(sourceRelativePath)),
        filePath: fullPath,
        sourceRelativePath
      });
    }
  }
}

function edgeDiagnostic(edge, sourceRelativePath, redactor) {
  return {
    status: edge.status,
    diagnosticCode: edge.diagnosticCode || `${edge.status}_diagnostic`,
    sourceRelativePath,
    redactedHref: redactToken('HREF', edge.originalHref || edge.normalizedHref || ''),
    message: redactor.redactString(`${edge.status}:${edge.diagnosticCode || ''}`)
  };
}

function diagnostic(status, diagnosticCode, value, redactor) {
  return {
    status,
    diagnosticCode,
    redactedPath: redactToken('PATH', value || ''),
    message: redactor.redactString(`${status}:${diagnosticCode}`)
  };
}

function containmentDiagnostic(filePath, rootPath) {
  const absolutePath = path.resolve(filePath);
  if (!isWithinRoot(absolutePath, rootPath) && normalizeInternalPath(absolutePath) !== normalizeInternalPath(rootPath)) {
    return 'outside_source_root';
  }
  return realpathContainmentDiagnostic(absolutePath, rootPath);
}

function realpathContainmentDiagnostic(filePath, rootPath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const realRoot = fs.realpathSync.native ? fs.realpathSync.native(rootPath) : fs.realpathSync(rootPath);
    const realTarget = fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
    return isWithinRoot(realTarget, realRoot) ? null : 'realpath_outside_source_root';
  } catch {
    return 'realpath_failed';
  }
}

function createCounts() {
  return {
    imported: 0,
    updated: 0,
    existing: 0,
    skipped: 0,
    missing: 0,
    external: 0,
    path_policy_violation: 0,
    ambiguous: 0,
    stale: 0
  };
}

function incrementCount(counts, status) {
  if (Object.prototype.hasOwnProperty.call(counts, status)) {
    counts[status] += 1;
  }
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

function canonicalIdentityKey(value) {
  return stableHash(realpathOrPath(value));
}

function realpathOrPath(value) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function tryRealpath(value) {
  try {
    return {
      ok: true,
      value: fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value)
    };
  } catch {
    return { ok: false, value: path.resolve(value) };
  }
}

function lstatIfPresent(value) {
  try {
    return fs.lstatSync(value);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

function findExistingAncestor(value) {
  let current = path.resolve(value);
  while (true) {
    try {
      fs.lstatSync(current);
      return current;
    } catch (err) {
      if (!err || err.code !== 'ENOENT') return null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function destinationPolicyDiagnostic(diagnosticCode, targetPath) {
  return {
    status: 'ambiguous',
    diagnosticCode,
    targetPath
  };
}

function destinationRelativePathDiagnostic(sourceRelativePath) {
  const normalized = String(sourceRelativePath || '').replace(/\\/g, '/');
  if (!normalized || normalized.includes('\0')) return 'destination_nul_or_empty_segment';
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return 'destination_path_policy_violation';
    if (segment.includes('\0')) return 'destination_nul_or_empty_segment';
    if (isReservedDeviceSegment(segment)) return 'destination_reserved_name';
  }
  return null;
}

function isReservedDeviceSegment(segment) {
  const base = String(segment || '')
    .replace(/[. ]+$/g, '')
    .split('.')[0]
    .toLowerCase();
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)$/.test(base);
}

function isWithinRoot(filePath, rootPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(filePath));
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function stableDocumentId(sourceId, pathKey) {
  return sourceId
    ? stableId('doc', sourceId, pathKey)
    : stableId('doc', pathKey);
}

function stableId(prefix, ...parts) {
  return `${prefix}_${stableHash(parts.join('\0')).slice(0, 24)}`;
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

module.exports = {
  LinkedImporter,
  createLinkedImporter,
  createLinkedImportService
};
