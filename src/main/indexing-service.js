'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createHeadingAwareChunker } = require('./chunker');
const { createDocumentClassifier } = require('./document-classifier');
const { createLinkGraphIndexer } = require('./link-graph-indexer');
const { createHnswIndex } = require('./hnsw-index');

// @req FR-DOC-019
class IndexingService {
  constructor({
    ledger,
    source,
    sourceId,
    sourceRoot,
    tokenizer,
    chunker,
    classifier,
    linkGraphIndexer,
    embeddingProvider,
    embeddingConfig,
    embeddingConfigProvider,
    hnswOptions,
    shouldCancel
  } = {}) {
    if (!ledger) throw new Error('IndexingService requires ledger');
    if (!sourceRoot) throw new Error('IndexingService requires sourceRoot');
    this.ledger = ledger;
    this.source = source || null;
    this.sourceId = sourceId || (source && source.sourceId);
    if (!this.sourceId) throw new Error('IndexingService requires sourceId');
    this.sourceRoot = path.resolve(sourceRoot);
    this.tokenizer = tokenizer || null;
    this.chunker = chunker || createHeadingAwareChunker();
    this.classifier = classifier || createDocumentClassifier();
    this.linkGraphIndexer = linkGraphIndexer || createLinkGraphIndexer({ sourceRoot: this.sourceRoot });
    this.embeddingProvider = embeddingProvider || null;
    this.embeddingConfig = embeddingConfig || null;
    this.embeddingConfigProvider = typeof embeddingConfigProvider === 'function' ? embeddingConfigProvider : null;
    this.hnswOptions = hnswOptions || {};
    this.shouldCancel = typeof shouldCancel === 'function' ? shouldCancel : null;
  }

  // @req FR-DOC-019
  // @req DR-DOC-008
  // @req FR-TREE-009
  async indexDocument({ filePath, content, requestedBy = 'indexing-service', jobId } = {}) {
    const absolutePath = path.resolve(requiredString(filePath, 'filePath'));
    const sourceRelativePath = relativePathWithin(this.sourceRoot, absolutePath);
    const pathKey = normalizePathKey(sourceRelativePath);
    const markdown = typeof content === 'string' ? content : '';
    const fingerprint = buildDocumentFingerprint(markdown);
    const contentHash = fingerprint.contentHash;
    this._throwIfCancelled('read', absolutePath);
    const classification = this.classifier.classify({ content: markdown, filePath: absolutePath });
    const semanticConfig = this.getEmbeddingConfig();
    const semanticEnabled = isEmbeddingEnabledForDocument(semanticConfig, classification);
    const progressTotal = semanticEnabled ? 4 : 3;
    const moveCandidate = this.findMoveCandidate({ pathKey, contentHash });
    let job = null;
    try {
      const document = this.ledger.upsertDocument({
        documentId: moveCandidate && moveCandidate.documentId,
        sourceId: this.sourceId,
        sourceRelativePath,
        pathKey,
        canonicalPathInternal: absolutePath,
        contentHash,
        contentByteLength: fingerprint.contentByteLength,
        contentTextLength: fingerprint.contentTextLength,
        normalizedTextHash: fingerprint.normalizedTextHash,
        project: classification.project,
        docType: classification.docType,
        category: classification.category,
        documentTags: classification.documentTags,
        classification: {
          assignedBy: classification.assignedBy,
          confidence: classification.confidence,
          reason: classification.reason,
          evidence: classification.evidence || {}
        },
        parseStatus: classification.parseStatus,
        metadataDiagnostic: classification.diagnostic
      });
      job = this.ledger.enqueueIndexJob({
        jobId,
        sourceId: this.sourceId,
        documentId: document.documentId,
        jobType: 'index_document',
        status: 'indexing',
        requestedBy,
        phase: 'chunk',
        progressCurrent: 0,
        progressTotal,
        currentPathInternal: absolutePath,
        contentHash
      });
      this.ledger.updateIndexJob(job.jobId, { status: 'indexing', startedAt: true, phase: 'chunk' });
      clearDocumentLinkState(this.ledger, document.documentId);

      const chunks = this.chunker.chunkMarkdown(markdown, { documentId: document.documentId });
      const reusableChunkEmbeddings = snapshotReusableChunkEmbeddings(this.ledger, document.documentId);
      const storedChunks = [];
      for (const chunk of chunks) {
        this._throwIfCancelled('tokenize', absolutePath);
        const searchText = await this.buildSearchText(chunk.text, { document, chunk, classification });
        this.ledger.upsertChunk({
          documentId: document.documentId,
          chunkId: chunk.chunkId,
          ordinal: chunk.ordinal,
          kind: chunk.kind,
          headingPath: chunk.headingPath,
          headingLevel: chunk.headingLevel,
          lineStart: chunk.lineStart,
          lineEnd: chunk.lineEnd,
          offsetStart: chunk.offsetStart,
          offsetEnd: chunk.offsetEnd,
          tokenCount: chunk.tokenCount,
          textHash: chunk.textHash,
          metadata: chunk.metadata,
          text: chunk.text,
          searchText
        });
        storedChunks.push(chunk);
      }
      pruneStaleDocumentChunks(this.ledger, document.documentId, storedChunks.map((chunk) => chunk.chunkId));
      const restoredEmbeddings = restoreReusableChunkEmbeddings(this.ledger, reusableChunkEmbeddings, storedChunks);
      markAnnIndexesStaleForRestoredEmbeddings(this.ledger, restoredEmbeddings.modelIds);
      this.ledger.updateIndexJob(job.jobId, {
        status: 'indexing',
        phase: 'links',
        progressCurrent: 2,
        progressTotal
      });

      const links = this.linkGraphIndexer.extractLinks(markdown, {
        filePath: absolutePath,
        documentId: document.documentId,
        resolveDocument: ({ pathKey: targetPathKey, sourceRelativePath: targetRelativePath }) => (
          this.ledger.findDocumentBySourcePath({
            sourceId: this.sourceId,
            pathKey: targetPathKey,
            sourceRelativePath: targetRelativePath
          })
        )
      });
      const storedLinks = links.map((link) => this.ledger.recordLinkEdge({
        ...link,
        fromChunkId: findChunkForLine(storedChunks, link.sourceLine)
      }));

      const semanticResult = semanticEnabled
        ? await this.indexEmbeddings({
          document,
          chunks: storedChunks,
          classification,
          config: semanticConfig,
          jobId: job.jobId
        })
        : { skipped: true, reason: semanticConfig && semanticConfig.skipReason ? semanticConfig.skipReason : 'embedding_disabled' };

      job = this.ledger.updateIndexJob(job.jobId, {
        status: 'completed',
        phase: 'done',
        progressCurrent: progressTotal,
        progressTotal,
        finishedAt: true
      });
      return {
        job,
        document,
        classification,
        chunks: storedChunks,
        links: storedLinks,
        semantic: semanticResult
      };
    } catch (err) {
      if (job && job.jobId) {
        if (err && err.code === 'INDEXING_WORKER_CANCELLED') {
          this.ledger.updateIndexJob(job.jobId, {
            status: 'cancelled',
            phase: err.phase || 'cancelled',
            diagnosticCode: 'cancel_requested',
            diagnostic: { message: 'Indexing worker job cancelled' },
            finishedAt: true
          });
          throw err;
        }
        this.ledger.updateIndexJob(job.jobId, {
          status: 'failed',
          phase: 'failed',
          diagnosticCode: err && err.code ? err.code : 'index_document_failed',
          diagnostic: { message: err && err.message ? err.message : String(err) },
          finishedAt: true
        });
      }
      throw err;
    }
  }

  async buildSearchText(text, metadata) {
    let searchText = String(text || '');
    if (this.tokenizer && typeof this.tokenizer.buildSearchText === 'function') {
      const value = await this.tokenizer.buildSearchText(text, metadata);
      if (typeof value === 'string') searchText = value;
      else if (value && typeof value.searchText === 'string') searchText = value.searchText;
    }
    return appendMetadataSearchText(searchText, metadata);
  }

  getEmbeddingConfig() {
    const raw = this.embeddingConfigProvider ? this.embeddingConfigProvider() : this.embeddingConfig;
    const config = raw && typeof raw === 'object' ? raw : {};
    return {
      enabled: config.enabled === true,
      provider: config.provider || 'openai-compatible',
      baseURL: config.baseURL || '',
      model: config.model || config.modelName || '',
      modelFingerprint: config.modelFingerprint || null,
      dimensions: Number.isInteger(config.dimensions) ? config.dimensions : null,
      batchSize: Number.isInteger(config.batchSize) && config.batchSize > 0 ? config.batchSize : 16,
      timeout: Number.isInteger(config.timeout) ? config.timeout : (Number.isInteger(config.timeoutMs) ? config.timeoutMs : 30000),
      hnsw: config.hnsw || {},
      projectPolicy: normalizeProjectPolicy(config.projectPolicy),
      offlineOnly: config.offlineOnly === true,
      skipReason: config.skipReason || null
    };
  }

  findMoveCandidate({ pathKey, contentHash } = {}) {
    if (!this.ledger || typeof this.ledger.findMoveCandidateByContentHash !== 'function') return null;
    try {
      return this.ledger.findMoveCandidateByContentHash({
        sourceId: this.sourceId,
        contentHash,
        excludePathKey: pathKey
      });
    } catch {
      return null;
    }
  }

  async indexEmbeddings({ document, chunks, classification, config, jobId } = {}) {
    if (!config || !config.model || !config.modelFingerprint) {
      return this.recordEmbeddingDiagnostic(jobId, 'embedding_model_unconfigured', {
        message: 'Embedding model or fingerprint is missing'
      });
    }
    const activeChunks = Array.isArray(chunks) ? chunks.filter((chunk) => chunk && chunk.chunkId && chunk.text) : [];
    if (activeChunks.length === 0) {
      return { skipped: true, reason: 'no_chunks' };
    }
    this.ledger.updateIndexJob(jobId, {
      status: 'indexing',
      phase: 'embedding',
      progressCurrent: 3,
      progressTotal: 4
    });
    try {
      this._throwIfCancelled('embedding', document && document.canonicalPathInternal);
      const model = this.ledger.upsertEmbeddingModel({
        provider: config.provider,
        modelName: config.model,
        modelFingerprint: config.modelFingerprint,
        dimensions: config.dimensions,
        status: 'active'
      });
      const chunksNeedingEmbedding = filterChunksMissingActiveEmbedding(this.ledger, activeChunks, model.modelId);
      if (chunksNeedingEmbedding.length > 0 && (!this.embeddingProvider || typeof this.embeddingProvider.embed !== 'function')) {
        return this.recordEmbeddingDiagnostic(jobId, 'embedding_provider_unavailable', {
          message: 'Embedding provider is not available'
        });
      }
      let stored = 0;
      const batchSize = Math.max(1, Number(config.batchSize) || 16);
      for (let offset = 0; offset < chunksNeedingEmbedding.length; offset += batchSize) {
        this._throwIfCancelled('embedding', document && document.canonicalPathInternal);
        const batch = chunksNeedingEmbedding.slice(offset, offset + batchSize);
        const embeddings = await this.requestEmbeddings({
          inputs: batch.map((chunk) => chunk.text),
          model: config.model,
          baseURL: config.baseURL,
          modelFingerprint: config.modelFingerprint,
          dimensions: config.dimensions,
          timeoutMs: config.timeout,
          document,
          classification
        });
        this._throwIfCancelled('embedding', document && document.canonicalPathInternal);
        for (let i = 0; i < batch.length; i += 1) {
          this._throwIfCancelled('embedding', document && document.canonicalPathInternal);
          const vector = embeddings[i];
          if (!Array.isArray(vector) || vector.length === 0) continue;
          if (config.dimensions && vector.length !== config.dimensions) {
            const err = new Error(`Embedding dimensions mismatch: expected ${config.dimensions}, got ${vector.length}`);
            err.code = 'embedding_dimensions_mismatch';
            throw err;
          }
          this.ledger.upsertChunkEmbedding({
            chunkId: batch[i].chunkId,
            modelId: model.modelId,
            embedding: vector,
            vectorHash: `sha256:${stableHash(vector.join(','))}`,
            status: 'active'
          });
          stored += 1;
        }
      }
      const ann = await this.buildAndCommitAnnIndex({
        model,
        config
      });
      if (ann && ann.committed === false && !ann.reason) {
        ann.reason = 'ann_not_committed';
      }
      if (ann && ann.reason && jobId && (ann.degraded || ann.committed === false)) {
        this.ledger.updateIndexJob(jobId, {
          status: 'indexing',
          phase: 'hnsw',
          diagnosticCode: ann.reason,
          diagnostic: { message: ann.reason }
        });
      }
      return {
        indexed: stored,
        modelId: model.modelId,
        modelFingerprint: model.modelFingerprint,
        degraded: Boolean(ann && ann.degraded),
        reason: ann && ann.degraded ? ann.reason : null,
        ann
      };
    } catch (err) {
      if (err && err.code === 'INDEXING_WORKER_CANCELLED') throw err;
      return this.recordEmbeddingDiagnostic(jobId, err && err.code ? err.code : 'embedding_batch_failed', {
        message: err && err.message ? err.message : String(err)
      });
    }
  }

  async buildAndCommitAnnIndex({ model, config } = {}) {
    this._throwIfCancelled('hnsw', null);
    if (!model || !model.modelId || !model.modelFingerprint) {
      return { committed: false, reason: 'embedding_model_missing' };
    }
    if (!this.ledger || typeof this.ledger.listChunkEmbeddingVectors !== 'function') {
      return { committed: false, reason: 'source_ledger_unavailable' };
    }
    const rows = this.ledger.listChunkEmbeddingVectors({ modelFingerprint: model.modelFingerprint })
      .filter((row) => Array.isArray(row.vector) && row.vector.length > 0);
    this._throwIfCancelled('hnsw', null);
    if (rows.length === 0) return { committed: false, reason: 'no_embeddings' };
    const dimensions = config.dimensions || rows[0].vector.length;
    const validRows = rows.filter((row) => row.vector.length === dimensions);
    if (validRows.length === 0) return { committed: false, reason: 'embedding_dimensions_mismatch' };
    const hnswParams = {
      m: Number(config.hnsw && config.hnsw.m) || this.hnswOptions.m || 16,
      efConstruction: Number(config.hnsw && config.hnsw.efConstruction) || this.hnswOptions.efConstruction || 200,
      efSearch: Number(config.hnsw && config.hnsw.efSearch) || this.hnswOptions.efSearch || 64,
      space: (config.hnsw && (config.hnsw.space || config.hnsw.metric)) || 'cosine',
      metric: (config.hnsw && (config.hnsw.metric || config.hnsw.space)) || 'cosine',
      dimensions
    };
    const hnsw = createHnswIndex({
      dimensions,
      maxElements: validRows.length,
      metric: hnswParams.metric,
      m: hnswParams.m,
      efConstruction: hnswParams.efConstruction,
      efSearch: hnswParams.efSearch,
      HierarchicalNSW: this.hnswOptions.HierarchicalNSW,
      hnswlib: this.hnswOptions.hnswlib,
      forceUnavailable: this.hnswOptions.forceUnavailable === true
    });
    const initStatus = hnsw.init(validRows.length);
    this._throwIfCancelled('hnsw', null);
    if (!initStatus.available || initStatus.status !== 'ready') {
      return { committed: false, degraded: true, reason: initStatus.degradationReason || 'native_unavailable' };
    }
    const yieldEvery = Math.max(1, Number(this.hnswOptions.yieldEvery) || 100);
    for (let index = 0; index < validRows.length; index += 1) {
      this._throwIfCancelled('hnsw', null);
      hnsw.addPoint(validRows[index].vector, index);
      if ((index + 1) % yieldEvery === 0) {
        await yieldToEventLoop(this.hnswOptions.yield);
      }
    }
    const indexDir = path.join(this.ledger.indexDir || path.dirname(this.ledger.dbPath), 'hnsw');
    const indexPath = path.join(indexDir, `${sanitizeFileName(model.modelId)}.bin`);
    this._throwIfCancelled('commit', indexPath);
    const writeResult = hnsw.writeIndexAtomic(indexPath);
    if (!writeResult.ok) {
      return { committed: false, degraded: true, reason: writeResult.reason || 'atomic_swap_failed' };
    }
    const checksum = fileSha256(indexPath);
    this._throwIfCancelled('commit', indexPath);
    const annIndex = this.ledger.recordAnnIndex({
      modelId: model.modelId,
      indexPathInternal: indexPath,
      params: hnswParams,
      checksum,
      status: 'committed'
    });
    this.ledger.replaceAnnMemberships({
      annIndexId: annIndex.ann_index_id,
      modelId: model.modelId,
      memberships: validRows.map((row, index) => ({
        chunkId: row.chunkId,
        annLabel: index
      }))
    });
    this._throwIfCancelled('commit', indexPath);
    return {
      committed: true,
      annIndexId: annIndex.ann_index_id,
      membershipCount: validRows.length,
      checksum
    };
  }

  async requestEmbeddings(request = {}) {
    const result = await this.embeddingProvider.embed({
      ...request,
      purpose: 'document'
    });
    const embeddings = Array.isArray(result)
      ? result
      : (Array.isArray(result && result.embeddings) ? result.embeddings : []);
    return embeddings.map((vector) => Array.from(vector || []).map((value) => Number(value)));
  }

  recordEmbeddingDiagnostic(jobId, diagnosticCode, diagnostic) {
    if (jobId) {
      this.ledger.updateIndexJob(jobId, {
        status: 'indexing',
        phase: 'embedding',
        diagnosticCode,
        diagnostic
      });
    }
    return { skipped: true, degraded: true, reason: diagnosticCode };
  }

  _throwIfCancelled(phase, currentPath) {
    if (!this.shouldCancel || this.shouldCancel() !== true) return;
    const err = new Error('Indexing worker job cancelled');
    err.code = 'INDEXING_WORKER_CANCELLED';
    err.phase = phase;
    err.currentPath = currentPath || null;
    throw err;
  }
}

// @req FR-DOC-019
function createIndexingService(options = {}) {
  return new IndexingService(options);
}

function clearDocumentLinkState(ledger, documentId) {
  const db = ledger.open();
  const clear = db.transaction((id) => {
    db.prepare('DELETE FROM links WHERE from_document_id = ?').run(id);
  });
  clear(documentId);
}

function pruneStaleDocumentChunks(ledger, documentId, activeChunkIds) {
  const db = ledger.open();
  const active = new Set((Array.isArray(activeChunkIds) ? activeChunkIds : []).filter(Boolean));
  const prune = db.transaction((id) => {
    const rows = db.prepare('SELECT chunk_id FROM chunks WHERE document_id = ?').all(id);
    const deleteChunk = db.prepare('DELETE FROM chunks WHERE chunk_id = ?');
    for (const row of rows) {
      if (!active.has(row.chunk_id)) deleteChunk.run(row.chunk_id);
    }
  });
  prune(documentId);
}

function snapshotReusableChunkEmbeddings(ledger, documentId) {
  const rows = ledger.open().prepare(`
    SELECT c.text_hash, c.metadata_json, ce.model_id, ce.embedding, ce.vector_hash, ce.status
    FROM chunks c
    JOIN chunk_embeddings ce ON ce.chunk_id = c.chunk_id
    WHERE c.document_id = ? AND c.text_hash IS NOT NULL AND ce.status = 'active'
    ORDER BY c.ordinal, c.chunk_id, ce.model_id
  `).all(documentId);
  const reusable = new Map();
  for (const row of rows) {
    const metadata = safeJsonObject(row.metadata_json);
    const key = reusableChunkEmbeddingKey(row.text_hash, metadata.chunkerVersion);
    if (!key) continue;
    if (!reusable.has(key)) reusable.set(key, []);
    reusable.get(key).push({
      modelId: row.model_id,
      embedding: row.embedding,
      vectorHash: row.vector_hash,
      status: row.status
    });
  }
  return reusable;
}

function restoreReusableChunkEmbeddings(ledger, reusableChunkEmbeddings, chunks) {
  if (!(reusableChunkEmbeddings instanceof Map) || reusableChunkEmbeddings.size === 0) {
    return { restored: 0, modelIds: [] };
  }
  const db = ledger.open();
  const now = typeof ledger._now === 'function' ? ledger._now() : new Date().toISOString();
  let restored = 0;
  const restoredModelIds = new Set();
  const restore = db.transaction(() => {
    const insert = db.prepare(`
      INSERT INTO chunk_embeddings(
        chunk_id, model_id, embedding, vector_hash, status, created_at, updated_at
      )
      VALUES (
        @chunkId, @modelId, @embedding, @vectorHash, @status, @now, @now
      )
      ON CONFLICT(chunk_id, model_id) DO NOTHING
    `);
    for (const chunk of Array.isArray(chunks) ? chunks : []) {
      if (!chunk || !chunk.chunkId || !chunk.textHash) continue;
      const key = reusableChunkEmbeddingKey(chunk.textHash, chunk.metadata && chunk.metadata.chunkerVersion);
      const entries = key ? reusableChunkEmbeddings.get(key) : null;
      if (!entries || !entries.length) continue;
      for (const entry of entries) {
        const result = insert.run({
          chunkId: chunk.chunkId,
          modelId: entry.modelId,
          embedding: entry.embedding,
          vectorHash: entry.vectorHash,
          status: entry.status || 'active',
          now
        });
        if (result.changes) {
          restored += result.changes;
          restoredModelIds.add(entry.modelId);
        }
      }
    }
  });
  restore();
  return { restored, modelIds: Array.from(restoredModelIds) };
}

function markAnnIndexesStaleForRestoredEmbeddings(ledger, modelIds) {
  const ids = Array.isArray(modelIds) ? Array.from(new Set(modelIds.filter(Boolean))) : [];
  if (!ids.length) return 0;
  const db = ledger.open();
  const placeholders = ids.map((_, index) => `@id${index}`).join(', ');
  const params = Object.fromEntries(ids.map((id, index) => [`id${index}`, id]));
  const result = db.prepare(`
    UPDATE ann_indexes
    SET status = 'stale', updated_at = @now
    WHERE status = 'committed' AND model_id IN (${placeholders})
  `).run({ ...params, now: typeof ledger._now === 'function' ? ledger._now() : new Date().toISOString() });
  return result.changes || 0;
}

function appendMetadataSearchText(searchText, metadata = {}) {
  const document = metadata.document || {};
  const classification = metadata.classification || {};
  const tags = Array.isArray(document.documentTags)
    ? document.documentTags
    : (Array.isArray(classification.documentTags) ? classification.documentTags : []);
  const terms = [
    document.project || classification.project,
    document.docType || classification.docType,
    document.category || classification.category,
    ...tags
  ]
    .map((term) => String(term || '').trim())
    .filter(Boolean);
  if (!terms.length) return String(searchText || '');
  return `${String(searchText || '')}\n${Array.from(new Set(terms)).join(' ')}`.trim();
}

async function yieldToEventLoop(yieldHook) {
  if (typeof yieldHook === 'function') {
    await yieldHook();
    return;
  }
  await new Promise((resolve) => {
    if (typeof setImmediate === 'function') setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

function reusableChunkEmbeddingKey(textHash, chunkerVersion) {
  if (!textHash || !chunkerVersion) return null;
  return `${chunkerVersion}\0${textHash}`;
}

function safeJsonObject(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function filterChunksMissingActiveEmbedding(ledger, chunks, modelId) {
  const rows = Array.isArray(chunks) ? chunks.filter((chunk) => chunk && chunk.chunkId) : [];
  if (!rows.length || !modelId) return rows;
  const existing = new Set();
  const db = ledger.open();
  for (let offset = 0; offset < rows.length; offset += 400) {
    const batch = rows.slice(offset, offset + 400).map((chunk) => chunk.chunkId);
    const placeholders = batch.map(() => '?').join(',');
    const matches = db.prepare(`
      SELECT chunk_id
      FROM chunk_embeddings
      WHERE model_id = ? AND status = 'active' AND chunk_id IN (${placeholders})
    `).all(modelId, ...batch);
    for (const match of matches) existing.add(match.chunk_id);
  }
  return rows.filter((chunk) => !existing.has(chunk.chunkId));
}

function normalizeProjectPolicy(rawPolicy = {}) {
  const policy = rawPolicy && typeof rawPolicy === 'object' ? rawPolicy : {};
  const mode = ['allow-all', 'allow-list', 'deny-list'].includes(policy.mode) ? policy.mode : 'allow-all';
  const projects = Array.isArray(policy.projects)
    ? policy.projects.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  return { mode, projects };
}

function isEmbeddingEnabledForDocument(config = {}, classification = {}) {
  if (!config.enabled) return false;
  if (config.offlineOnly) {
    config.skipReason = 'offline-only';
    return false;
  }
  const project = String(classification.project || classification.metadata?.project || '').trim();
  const policy = normalizeProjectPolicy(config.projectPolicy);
  if (policy.mode === 'allow-list' && !policy.projects.includes(project)) {
    config.skipReason = 'project_policy_blocked';
    return false;
  }
  if (policy.mode === 'deny-list' && policy.projects.includes(project)) {
    config.skipReason = 'project_policy_blocked';
    return false;
  }
  return true;
}

function findChunkForLine(chunks, lineNumber) {
  const found = chunks.find((chunk) => (
    Number.isInteger(chunk.lineStart) &&
    Number.isInteger(chunk.lineEnd) &&
    Number.isInteger(lineNumber) &&
    lineNumber >= chunk.lineStart &&
    lineNumber <= chunk.lineEnd
  ));
  return found ? found.chunkId : null;
}

function relativePathWithin(rootPath, filePath) {
  const relative = path.relative(rootPath, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Indexed file must be inside sourceRoot');
  }
  return relative.replace(/\\/g, '/');
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

function fileSha256(filePath) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

function sanitizeFileName(value) {
  return String(value || 'model').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 120) || 'model';
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

module.exports = {
  IndexingService,
  createIndexingService
};
