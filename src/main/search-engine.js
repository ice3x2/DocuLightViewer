// src/main/search-engine.js — BM25 full-text search engine (CJS)
'use strict';

const bm25 = require('wink-bm25-text-search');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { tokenize } = require('./tokenizer');
const { parseSimpleYaml } = require('./frontmatter');
const { SQLiteKeywordIndex, SQLITE_INDEX_FILENAME } = require('./search-sqlite-store');
const { createKeywordTokenizer } = require('./search-tokenizer');
const { createSourceLedgerStore } = require('./source-ledger-store');
const { createIndexingService } = require('./indexing-service');
const { buildSmartSearchToolResult } = require('./smart-search-response');
const { createHnswIndex } = require('./hnsw-index');
const { IndexingWorkerController } = require('./search-index-worker-controller');

const INDEX_FILENAME = '.doculight-search-index.json';
const FM_REGEX = /^---\r?\n([\s\S]*?\r?\n)?---\r?\n?/;
const MIN_DOCS_FOR_CONSOLIDATE = 3;
const MAX_MAIN_SEARCH_TEXT_CHARS = 1200;

class SearchEngine {
  constructor(store, options = {}) {
    this.store = store;
    this.options = options || {};
    this.indexBackend = this.options.indexBackend === 'sqlite' && this.options.indexDataDir ? 'sqlite' : 'json';
    this.indexDataDir = this.options.indexDataDir || null;
    if (this.indexBackend === 'sqlite' && this.indexDataDir) {
      fs.mkdirSync(this.indexDataDir, { recursive: true });
    }
    this.keywordTokenizer = this.options.keywordTokenizer || createKeywordTokenizer({
      provider: this.options.keywordTokenizerProvider || 'garu',
      maxAnalysisChars: this.options.keywordTokenizerMaxAnalysisChars
    });
    this.sqliteIndex = null;
    this.engine = null;
    this.docMeta = new Map(); // docId → { title, project, docName, description, date, snippet }
    this.dirty = false;
    this.initialized = false;
    this._rebuildPromise = null;
    this._cancelRequested = false;
    this._sourceLedger = null;
    this._indexingService = null;
    this._smartIndexQueue = new Map();
    this._smartIndexTimer = null;
    this._smartIndexInFlight = null;
    this._compactInFlight = null;
    this._clearInFlight = null;
    this._startupReconcileTimer = null;
    this._startupReconcileInFlight = null;
    this._indexingWorkerController = this.options.indexingWorkerController || null;
    this._smartIndexDelayMs = Number.isInteger(this.options.smartIndexDelayMs)
      ? Math.max(0, this.options.smartIndexDelayMs)
      : 25;
    this._lastDegradedReason = null;
    this._status = {
      state: 'uninitialized',
      phase: null,
      currentPath: null,
      lastIndexedAt: null,
      errorSummary: null,
      failedFiles: []
    };
    if (!this._indexingWorkerController && this.options.disableIndexingWorkerController !== true) {
      this._indexingWorkerController = this._createIndexingWorkerController();
    }
  }

  // ─── Initialization ──────────────────────────────────────

  /**
   * Initialize search engine. Load existing index or build from scratch.
   */
  async initialize() {
    const savePath = this.store.get('mcpAutoSavePath', '');
    if (!savePath) return;

    const indexPath = this.getIndexPath();
    try {
      await this._initializeKeywordTokenizer();
      if (fs.existsSync(indexPath)) {
        await this._loadIndex(indexPath);
        this.initialized = true;
      } else {
        this._markIndexRebuildRequired(
          'index_missing',
          indexPath,
          new Error('Search index is missing; rebuild it from Settings > Search Index Management.')
        );
      }
      this._scheduleStartupIndexJobReconciliation();
    } catch (err) {
      if (err.code === 'SQLITE_INDEX_INCOMPLETE') {
        this._markIndexRebuildRequired('index_incomplete', indexPath, err);
        this._scheduleStartupIndexJobReconciliation();
        return;
      }
      if (err.code === 'SQLITE_INDEX_SOURCE_MISMATCH' || err.code === 'SQLITE_INDEX_TOKENIZER_MISMATCH') {
        console.warn('[doculight] SQLite search index metadata changed; settings rebuild required:', err.message);
        this._markIndexRebuildRequired('index_metadata_mismatch', indexPath, err);
        this._scheduleStartupIndexJobReconciliation();
        return;
      }
      console.warn('[doculight] Search index load failed; settings rebuild required:', err.message);
      this._createFreshEngine();
      this.initialized = true;
      this.dirty = true;
      this._recordFailure('load', null, err, []);
    }
  }

  // ─── Index Build ─────────────────────────────────────────

  /**
   * Full rebuild: scan all .md files under mcpAutoSavePath.
   */
  async rebuild() {
    if (this._rebuildPromise) return this._rebuildPromise;
    this._cancelRequested = false;
    this._rebuildPromise = this._performRebuild().finally(() => {
      this._rebuildPromise = null;
      this._cancelRequested = false;
    });
    return this._rebuildPromise;
  }

  async _performRebuild() {
    const savePath = this.store.get('mcpAutoSavePath', '');
    if (!savePath) throw new Error('mcpAutoSavePath not configured');
    await this._initializeKeywordTokenizer();

    const previousEngine = this.engine;
    const previousDocMeta = this.docMeta;
    const previousInitialized = this.initialized;
    const indexPath = this.getIndexPath();
    const failedFiles = [];
    let phase = 'scan';
    let currentPath = null;

    this._status = {
      ...this._status,
      state: 'rebuilding',
      phase,
      currentPath: null,
      progress: { current: 0, total: 0 },
      rebuildSession: { active: true, indexedCount: 0, pendingCount: 0, totalCount: 0, currentPath: null },
      errorSummary: null,
      failedFiles: []
    };
    this._emitRebuildStatus();

    this.dirty = false;
    const nextEngine = this._usesSQLiteBackend() ? null : this._createEngine();
    const nextDocMeta = new Map();
    const nextSearchDocuments = [];

    try {
      const rebuildStartedAt = Date.now();
      const mdFiles = await this._scanMarkdownFiles(savePath);
      let rebuildTotalCount = mdFiles.length;
      this._status.progress = { current: 0, total: rebuildTotalCount };
      this._status.rebuildSession = {
        active: true,
        indexedCount: 0,
        pendingCount: rebuildTotalCount,
        totalCount: rebuildTotalCount,
        currentPath: null
      };
      this._emitRebuildStatus();
      const BATCH_SIZE = 20;
      for (let i = 0; i < mdFiles.length; i += BATCH_SIZE) {
        this._throwIfCancelled('scan', currentPath);
        const batch = mdFiles.slice(i, i + BATCH_SIZE);
        phase = 'read';
        const contents = await Promise.all(
          batch.map(async (f) => {
            currentPath = f;
            this._status.phase = phase;
            this._status.currentPath = f;
            this._status.rebuildSession = {
              active: true,
              indexedCount: nextDocMeta.size,
              pendingCount: Math.max(0, rebuildTotalCount - nextDocMeta.size),
              totalCount: rebuildTotalCount,
              currentPath: f
            };
            this._emitRebuildStatus();
            this._throwIfCancelled(phase, f);
            try {
              return await fs.promises.readFile(f, 'utf-8');
            } catch (err) {
              failedFiles.push({ filePath: f, phase: 'read', error: err.message });
              return null;
            }
          })
        );
        phase = 'index';
        for (let j = 0; j < batch.length; j++) {
          currentPath = batch[j];
          this._status.phase = phase;
          this._status.currentPath = currentPath;
          this._throwIfCancelled(phase, currentPath);
          if (contents[j]) {
            try {
              const indexedDocument = this._indexDocument(batch[j], contents[j], nextEngine, nextDocMeta);
              nextSearchDocuments.push(indexedDocument);
              const indexedCount = nextDocMeta.size;
              const totalCount = rebuildTotalCount;
              this._status.progress = { current: indexedCount, total: totalCount };
              this._status.rebuildSession = {
                active: true,
                indexedCount,
                pendingCount: Math.max(0, totalCount - indexedCount),
                totalCount,
                currentPath
              };
              this._emitRebuildStatus();
            } catch (err) {
              failedFiles.push({ filePath: batch[j], phase: 'index', error: err.message });
              console.error(`[doculight] Failed to index ${batch[j]}:`, err.message);
            }
          }
        }
      }

      if (failedFiles.length > 0) {
        const err = new Error(`${failedFiles.length} file(s) failed during rebuild`);
        err.code = 'INDEX_REBUILD_PARTIAL_FAILURE';
        throw err;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
      for (let catchUpPass = 0; catchUpPass < 2; catchUpPass += 1) {
        const scanned = await this._scanMarkdownFiles(savePath);
        const catchUpFiles = scanned.filter((filePath) => !nextDocMeta.has(filePath) || (!nextEngine && fileModifiedAfter(filePath, rebuildStartedAt)));
        if (catchUpFiles.length === 0) break;
        rebuildTotalCount = Math.max(rebuildTotalCount, scanned.length);
        phase = `catch-up-${catchUpPass + 1}`;
        for (const filePath of catchUpFiles) {
          currentPath = filePath;
          this._status.phase = phase;
          this._status.currentPath = currentPath;
          this._status.progress = { current: nextDocMeta.size, total: rebuildTotalCount };
          this._status.rebuildSession = {
            active: true,
            indexedCount: nextDocMeta.size,
            pendingCount: Math.max(0, rebuildTotalCount - nextDocMeta.size),
            totalCount: rebuildTotalCount,
            currentPath
          };
          this._emitRebuildStatus();
          this._throwIfCancelled(phase, currentPath);
          try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const existingIndex = nextSearchDocuments.findIndex((doc) => doc && doc.filePath === filePath);
            if (existingIndex >= 0) nextSearchDocuments.splice(existingIndex, 1);
            const indexedDocument = this._indexDocument(filePath, content, nextEngine, nextDocMeta);
            nextSearchDocuments.push(indexedDocument);
            this._status.progress = { current: nextDocMeta.size, total: rebuildTotalCount };
            this._status.rebuildSession = {
              active: true,
              indexedCount: nextDocMeta.size,
              pendingCount: Math.max(0, rebuildTotalCount - nextDocMeta.size),
              totalCount: rebuildTotalCount,
              currentPath
            };
            this._emitRebuildStatus();
          } catch (err) {
            failedFiles.push({ filePath, phase, error: err.message });
            console.error(`[doculight] Failed to catch up index ${filePath}:`, err.message);
          }
        }
      }

      if (failedFiles.length > 0) {
        const err = new Error(`${failedFiles.length} file(s) failed during rebuild`);
        err.code = 'INDEX_REBUILD_PARTIAL_FAILURE';
        throw err;
      }

      phase = 'consolidate';
      this._status.phase = phase;
      this._status.currentPath = null;
      this._throwIfCancelled(phase, null);

      if (nextEngine && nextDocMeta.size >= MIN_DOCS_FOR_CONSOLIDATE) {
        nextEngine.consolidate();
      }

      phase = 'save';
      this._status.phase = phase;
      currentPath = indexPath;
      this._status.currentPath = indexPath;
      this._status.progress = { current: nextDocMeta.size, total: rebuildTotalCount };
      this._status.rebuildSession = {
        active: true,
        indexedCount: nextDocMeta.size,
        pendingCount: 0,
        totalCount: rebuildTotalCount,
        currentPath: indexPath
      };
      this._emitRebuildStatus();
      this._throwIfCancelled('commit', indexPath);
      const saveResult = await this._saveIndex(indexPath, nextEngine, nextDocMeta, nextSearchDocuments);

      const dirtiedDuringRebuild = this.dirty;
      this.engine = nextEngine;
      this.docMeta = nextDocMeta;
      this.initialized = true;
      this.dirty = dirtiedDuringRebuild || failedFiles.length > 0;
      this._lastDegradedReason = failedFiles.length > 0 ? 'partial-index' : null;
      this._status = {
        state: this.dirty ? 'stale' : 'ready',
        phase: null,
        currentPath: null,
        progress: { current: nextDocMeta.size, total: rebuildTotalCount },
        rebuildSession: {
          active: false,
          indexedCount: nextDocMeta.size,
          pendingCount: 0,
          totalCount: rebuildTotalCount,
          currentPath: null
        },
        lastIndexedAt: new Date().toISOString(),
        errorSummary: failedFiles.length > 0 ? `${failedFiles.length} file(s) failed during rebuild` : null,
        failedFiles
      };
      this._emitRebuildStatus();

      return { indexed: nextDocMeta.size, scanned: rebuildTotalCount, failed: failedFiles.length, failedFiles, saveResult };
    } catch (err) {
      this.engine = previousEngine;
      this.docMeta = previousDocMeta;
      this.initialized = previousInitialized;
      this.dirty = true;
      if (failedFiles.length === 0) {
        failedFiles.push({ filePath: currentPath, phase, error: err.message });
      }
      this._recordFailure(err.code === 'INDEX_REBUILD_CANCELLED' ? 'cancelled' : phase, currentPath, err, failedFiles);
      throw err;
    }
  }

  // ─── Search: search_documents ────────────────────────────

  /**
   * BM25 full-text search across body + frontmatter fields.
   *
   * @param {string} query
   * @param {{ limit?: number, project?: string }} [options]
   * @returns {Array<{ filePath, score, title, project, docName, description, date, snippet }>}
   */
  search(query, { limit = 20, project, docType, category, documentTags, tagMode, pathPrefix, filePaths } = {}) {
    const searchPathPrefix = pathPrefix
      ? path.resolve(this._getSourceRoot(), String(pathPrefix).replace(/\\/g, path.sep))
      : undefined;
    if (this._usesSQLiteBackend() && this.sqliteIndex && this.sqliteIndex.available) {
      try {
        const results = this.sqliteIndex.search(query, {
          limit,
          project,
          docType,
          category,
          documentTags,
          tagMode,
          pathPrefix: searchPathPrefix,
          filePaths
        });
        this._lastDegradedReason = null;
        return results;
      } catch (err) {
        console.error('[doculight] SQLite keyword search error:', err.message);
        this._lastDegradedReason = 'sqlite-error';
        return this._fallbackSearch(query, { limit, project, docType, category, documentTags, tagMode, pathPrefix: searchPathPrefix, filePaths });
      }
    }

    if (!this.engine || this.docMeta.size < MIN_DOCS_FOR_CONSOLIDATE) {
      // Not enough docs for BM25 — fallback to simple token matching
      this._lastDegradedReason = 'keyword-fallback';
      return this._fallbackSearch(query, { limit, project, docType, category, documentTags, tagMode, pathPrefix: searchPathPrefix, filePaths });
    }

    if (Array.isArray(filePaths)) {
      this._lastDegradedReason = 'keyword-fallback';
      return this._fallbackSearch(query, { limit, project, docType, category, documentTags, tagMode, pathPrefix: searchPathPrefix, filePaths });
    }

    try {
      let filterFn;
      if (project && docType) {
        filterFn = (ov) => (
          ov.project === project &&
          ov.docType === docType &&
          matchesSearchHardFilters(ov, { category, documentTags, tagMode, pathPrefix: searchPathPrefix, filePaths })
        );
      } else if (project) {
        filterFn = (ov) => ov.project === project && matchesSearchHardFilters(ov, { category, documentTags, tagMode, pathPrefix: searchPathPrefix, filePaths });
      } else if (docType) {
        filterFn = (ov) => ov.docType === docType && matchesSearchHardFilters(ov, { category, documentTags, tagMode, pathPrefix: searchPathPrefix, filePaths });
      } else if (category || hasDocumentTagFilter(documentTags) || searchPathPrefix || (Array.isArray(filePaths) && filePaths.length > 0)) {
        filterFn = (ov) => matchesSearchHardFilters(ov, { category, documentTags, tagMode, pathPrefix: searchPathPrefix, filePaths });
      } else if (Array.isArray(filePaths) && filePaths.length === 0) {
        return [];
      }

      const results = this.engine.search(query, limit, filterFn);
      this._lastDegradedReason = null;

      return results.map(([docId, score]) => {
        const meta = this.docMeta.get(docId) || {};
        return {
          filePath: docId,
          score: Math.round(score * 1000) / 1000,
          title: meta.title || path.basename(docId, '.md'),
          project: meta.project || null,
          docName: meta.docName || null,
          docType: meta.docType || null,
          category: meta.category || null,
          documentTags: Array.isArray(meta.documentTags) ? meta.documentTags : [],
          description: meta.description || null,
          date: meta.date || null,
          snippet: meta.snippet || null
        };
      });
    } catch (err) {
      console.error('[doculight] BM25 search error:', err.message);
      this._lastDegradedReason = 'bm25-error';
      return this._fallbackSearch(query, { limit, project, docType, category, documentTags, tagMode, pathPrefix: searchPathPrefix, filePaths });
    }
  }

  // @req IR-MCP-018
  // @req FR-DOC-025
  async smartSearch(args = {}) {
    const filters = normalizeSmartSearchFilters(args);
    const result = await buildSmartSearchToolResult({ ...args, filters }, {
      searchEngine: this,
      store: this.store
    });
    return JSON.parse(result.content[0].text);
  }

  // @req FR-DOC-025
  async getSmartSearchSemanticCandidates(query, { limit = 20, filters = {} } = {}) {
    const provider = this.options.semanticCandidateProvider;
    if (provider && typeof provider.search === 'function') {
      try {
        const result = await provider.search({
          query,
          limit,
          filters,
          searchEngine: this,
          sourceRoot: this._getSourceRoot()
        });
        const candidates = Array.isArray(result)
          ? result
          : (Array.isArray(result && result.candidates) ? result.candidates : []);
        return {
          status: result && result.status ? result.status : (candidates.length > 0 ? 'ready' : 'empty'),
          degradationReason: result && result.degradationReason ? result.degradationReason : (candidates.length > 0 ? null : 'semantic_stale'),
          backend: result && result.backend ? result.backend : 'hnsw',
          candidates: candidates.slice(0, Math.max(1, Number(limit) || 20))
        };
      } catch (err) {
        return {
          status: 'failed',
          degradationReason: err && err.code ? err.code : 'provider_unavailable',
          backend: 'hnsw',
          candidates: []
        };
      }
    }

    const semanticConfig = this._getSemanticSearchConfig();
    if (!semanticConfig.enabled || !semanticConfig.modelFingerprint || !semanticConfig.model) {
      return {
        status: 'disabled',
        degradationReason: 'embedding_disabled',
        backend: null,
        candidates: []
      };
    }
    if (!this.options.embeddingProvider || typeof this.options.embeddingProvider.embed !== 'function') {
      return {
        status: 'disabled',
        degradationReason: 'embedding_provider_unavailable',
        backend: null,
        candidates: []
      };
    }
    const ledger = this._getAvailableSourceLedger();
    if (!ledger || typeof ledger.searchChunkEmbeddings !== 'function') {
      return {
        status: 'disabled',
        degradationReason: 'semantic_ledger_unavailable',
        backend: null,
        candidates: []
      };
    }
    try {
      const queryVector = await this._embedSemanticQuery(query, semanticConfig);
      const hnswResult = this._searchSemanticCandidatesWithHnsw({
        ledger,
        semanticConfig,
        queryVector,
        limit
      });
      if (hnswResult.status === 'ready') {
        return hnswResult;
      }
      const hnswDegradationReason = hnswResult.status === 'degraded'
        ? (hnswResult.degradationReason || 'native_unavailable')
        : null;
      const candidates = ledger.searchChunkEmbeddings({
        modelFingerprint: semanticConfig.modelFingerprint,
        queryVector,
        limit
      });
      return {
        status: candidates.length > 0 ? 'ready' : 'empty',
        degradationReason: candidates.length > 0 ? hnswDegradationReason : (hnswDegradationReason || 'semantic_stale'),
        backend: 'sqlite-vector',
        candidates: candidates.slice(0, Math.max(1, Number(limit) || 20))
      };
    } catch (err) {
      return {
        status: 'failed',
        degradationReason: err && err.code ? err.code : 'provider_unavailable',
        backend: 'hnsw',
        candidates: []
      };
    }
  }

  _searchSemanticCandidatesWithHnsw({ ledger, semanticConfig, queryVector, limit } = {}) {
    if (!ledger) {
      return { status: 'disabled', degradationReason: 'semantic_ledger_unavailable', backend: null, candidates: [] };
    }
    const committedResult = this._searchSemanticCandidatesWithCommittedHnsw({
      ledger,
      semanticConfig,
      queryVector,
      limit
    });
    if (committedResult.status === 'ready' || committedResult.status === 'degraded') {
      return committedResult;
    }
    return {
      status: 'empty',
      degradationReason: committedResult.degradationReason || 'ann_index_missing',
      backend: 'hnsw-persisted',
      candidates: []
    };
  }

  _searchSemanticCandidatesWithCommittedHnsw({ ledger, semanticConfig, queryVector, limit } = {}) {
    if (!ledger || typeof ledger.getCommittedAnnIndex !== 'function' || typeof ledger.getAnnMembershipCandidates !== 'function') {
      return { status: 'disabled', degradationReason: 'ann_ledger_unavailable', backend: 'hnsw-persisted', candidates: [] };
    }
    const annIndex = ledger.getCommittedAnnIndex({ modelFingerprint: semanticConfig.modelFingerprint });
    if (!annIndex || !annIndex.indexPathInternal || !fs.existsSync(annIndex.indexPathInternal)) {
      return { status: 'empty', degradationReason: 'ann_index_missing', backend: 'hnsw-persisted', candidates: [] };
    }
    if (annIndex.checksum && fileSha256(annIndex.indexPathInternal) !== annIndex.checksum) {
      return { status: 'degraded', degradationReason: 'hnsw_checksum_mismatch', backend: 'hnsw-persisted', candidates: [] };
    }
    const memberships = ledger.getAnnMembershipCandidates({ annIndexId: annIndex.annIndexId })
      .filter((item) => !item.tombstoned);
    if (memberships.length === 0) {
      return { status: 'empty', degradationReason: 'ann_membership_missing', backend: 'hnsw-persisted', candidates: [] };
    }
    const dimensions = semanticConfig.dimensions || annIndex.dimensions || queryVector.length;
    const params = annIndex.params || {};
    const hnsw = createHnswIndex({
      dimensions,
      maxElements: memberships.length,
      membershipCount: memberships.length,
      metric: params.metric || params.space || 'cosine',
      m: Number(params.m) || this.options.hnswM || 16,
      efConstruction: Number(params.efConstruction) || this.options.hnswEfConstruction || 200,
      efSearch: Number(params.efSearch) || this.options.hnswEfSearch || 64,
      HierarchicalNSW: this.options.HierarchicalNSW,
      hnswlib: this.options.hnswlib,
      forceUnavailable: this.options.forceHnswUnavailable === true
    });
    let status;
    try {
      status = hnsw.readIndex(annIndex.indexPathInternal);
    } catch (err) {
      return {
        status: 'degraded',
        degradationReason: 'hnsw_read_failed',
        backend: 'hnsw-persisted',
        candidates: []
      };
    }
    if (!status.available || status.status !== 'ready') {
      return {
        status: 'degraded',
        degradationReason: status.degradationReason || 'native_unavailable',
        backend: 'hnsw-persisted',
        candidates: []
      };
    }
    const searchResult = hnsw.search(queryVector, Math.max(1, Number(limit) || 20));
    if (!searchResult.ok) {
      return {
        status: 'degraded',
        degradationReason: searchResult.reason || 'hnsw_search_failed',
        backend: 'hnsw-persisted',
        candidates: []
      };
    }
    const byLabel = new Map(memberships.map((item) => [item.annLabel, item]));
    const candidates = searchResult.labels.map((label, index) => {
      const row = byLabel.get(label);
      if (!row) return null;
      return {
        chunkId: row.chunkId,
        documentId: row.documentId,
        sourceRelativePath: row.sourceRelativePath,
        filePath: row.filePath,
        title: row.title,
        snippet: row.snippet,
        distance: Number(searchResult.distances[index]),
        modelId: row.modelId,
        modelFingerprint: semanticConfig.modelFingerprint,
        project: row.project,
        docType: row.docType,
        category: row.category,
        documentTags: row.documentTags,
        pathStatus: row.pathStatus
      };
    }).filter(Boolean);
    return {
      status: candidates.length > 0 ? 'ready' : 'empty',
      degradationReason: candidates.length > 0 ? null : 'semantic_stale',
      backend: 'hnsw-persisted',
      candidates
    };
  }

  async _embedSemanticQuery(query, semanticConfig) {
    const result = await this.options.embeddingProvider.embed({
      inputs: [String(query || '')],
      model: semanticConfig.model,
      baseURL: semanticConfig.baseURL,
      modelFingerprint: semanticConfig.modelFingerprint,
      dimensions: semanticConfig.dimensions,
      timeoutMs: semanticConfig.timeout,
      purpose: 'query',
      searchEngine: this
    });
    const embeddings = Array.isArray(result)
      ? result
      : (Array.isArray(result && result.embeddings) ? result.embeddings : []);
    const vector = embeddings[0];
    if (!Array.isArray(vector) && !ArrayBuffer.isView(vector)) {
      const err = new Error('Embedding provider returned no query vector');
      err.code = 'embedding_query_failed';
      throw err;
    }
    const normalized = Array.from(vector).map((value) => Number(value));
    if (semanticConfig.dimensions && normalized.length !== semanticConfig.dimensions) {
      const err = new Error(`Embedding query dimensions mismatch: expected ${semanticConfig.dimensions}, got ${normalized.length}`);
      err.code = 'embedding_dimensions_mismatch';
      throw err;
    }
    return normalized;
  }

  // ─── Search: search_projects ─────────────────────────────

  /**
   * Search or list projects from frontmatter metadata.
   *
   * @param {string} [query]
   * @param {number} [limit=20]
   * @returns {Array<{ project, description, documentCount, documents }>}
   */
  searchProjects(query, limit = 20) {
    const projectMap = new Map();
    for (const [docId, meta] of this.docMeta) {
      const proj = meta.project || '(no project)';
      if (!projectMap.has(proj)) {
        projectMap.set(proj, {
          project: proj,
          description: meta.description || '',
          documents: []
        });
      }
      projectMap.get(proj).documents.push({
        filePath: docId,
        title: meta.title || path.basename(docId, '.md'),
        docName: meta.docName || null,
        date: meta.date || null
      });
    }

    let projects = Array.from(projectMap.values());

    if (query && query.trim()) {
      const queryTokens = tokenize(query.toLowerCase());
      projects = projects
        .map(p => {
          const targetTokens = tokenize(`${p.project} ${p.description}`.toLowerCase());
          let score = 0;
          for (const qt of queryTokens) {
            for (const tt of targetTokens) {
              if (tt.includes(qt) || qt.includes(tt)) score++;
            }
          }
          return { ...p, _score: score };
        })
        .filter(p => p._score > 0)
        .sort((a, b) => b._score - a._score);
    }

    return projects.slice(0, limit).map(p => ({
      project: p.project,
      description: p.description,
      documentCount: p.documents.length,
      documents: p.documents
    }));
  }

  // ─── Index Update ────────────────────────────────────────

  markDirty(input = {}) {
    this.dirty = true;
    if (typeof input === 'string') {
      this.queueDocumentIndex({ filePath: input, requestedBy: 'markDirty' });
    } else if (input && input.filePath) {
      this.queueDocumentIndex(input);
    }
  }

  // @req FR-DOC-019
  queueDocumentIndex({ filePath, content, requestedBy = 'post-save', metadata = {}, jobId } = {}) {
    const sourceRoot = this._getSourceRoot();
    if (!filePath || !sourceRoot || !this.indexDataDir) {
      return { queued: false, reason: 'smart-index-unavailable' };
    }

    const absolutePath = path.resolve(filePath);
    if (!isWithinRoot(absolutePath, sourceRoot)) {
      return { queued: false, reason: 'outside-source-root' };
    }

    let document = null;
    try {
      document = this.recordSavedDocument({
        filePath: absolutePath,
        content,
        metadata
      });
    } catch (err) {
      return { queued: false, reason: err && err.message ? err.message : 'document-identity-failed' };
    }

    const queueKey = normalizeInternalPath(absolutePath);
    const existingQueuedItem = this._smartIndexQueue.get(queueKey);
    const fingerprint = buildDocumentFingerprint(content);
    const contentHash = fingerprint ? fingerprint.contentHash : null;
    const selectedJobId = jobId || this._selectSmartIndexJobId({
        document,
        absolutePath,
        queueKey,
        contentHash,
        existingJobId: existingQueuedItem && existingQueuedItem.jobId
      });

    let job = null;
    try {
      job = this._getSourceLedger().enqueueIndexJob({
        jobId: selectedJobId,
        sourceId: document.sourceId,
        documentId: document.documentId,
        jobType: 'index_document',
        status: 'queued',
        requestedBy,
        currentPathInternal: absolutePath,
        contentHash
      });
    } catch (err) {
      return {
        queued: false,
        reason: err && err.message ? err.message : 'index-enqueue-failed',
        document
      };
    }

    this._smartIndexQueue.set(queueKey, {
      filePath: absolutePath,
      content: typeof content === 'string' ? content : null,
      requestedBy,
      jobId: job && job.jobId ? job.jobId : null,
      queuedAt: new Date().toISOString()
    });
    if (!this._smartIndexTimer) {
      this._smartIndexTimer = setTimeout(() => {
        this._smartIndexTimer = null;
        this._drainSmartIndexQueue().catch((err) => {
          console.warn('[doculight] Smart indexing queue failed:', err.message);
        });
      }, this._smartIndexDelayMs);
      if (typeof this._smartIndexTimer.unref === 'function') {
        this._smartIndexTimer.unref();
      }
    }
    return {
      queued: true,
      pending: this._smartIndexQueue.size,
      document,
      jobId: job && job.jobId ? job.jobId : null
    };
  }

  // @req FR-DOC-035
  queueDocumentIndexIfChanged({ filePath, content, requestedBy = 'post-save', metadata = {}, jobId } = {}) {
    if (typeof content !== 'string') {
      return this.queueDocumentIndex({ filePath, content, requestedBy, metadata, jobId });
    }
    const sourceRoot = this._getSourceRoot();
    if (!filePath || !sourceRoot || !this.indexDataDir) {
      return { queued: false, reason: 'smart-index-unavailable' };
    }
    const absolutePath = path.resolve(filePath);
    if (!isWithinRoot(absolutePath, sourceRoot)) {
      return { queued: false, reason: 'outside-source-root' };
    }

    try {
      const service = this._getIndexingService();
      const ledger = this._getSourceLedger();
      const sourceRelativePath = path.relative(sourceRoot, absolutePath).replace(/\\/g, '/');
      const existing = ledger.findDocumentBySourcePath({
        sourceId: service.sourceId,
        sourceRelativePath
      });
      const fingerprint = buildDocumentFingerprint(content);
      if (hasSameContentFingerprint(existing, fingerprint)) {
        return {
          queued: false,
          reason: 'unchanged',
          document: existing
        };
      }
    } catch {
      // Fall through to the normal queue path so registration remains best-effort.
    }

    return this.queueDocumentIndex({ filePath: absolutePath, content, requestedBy, metadata, jobId });
  }

  // @req FR-DOC-035
  queueKnownDocumentIndex({ filePath, content, document, requestedBy = 'post-save', jobId } = {}) {
    const sourceRoot = this._getSourceRoot();
    if (!filePath || !sourceRoot || !this.indexDataDir || !document || !document.documentId || !document.sourceId) {
      return { queued: false, reason: 'smart-index-unavailable', document: document || null };
    }
    const absolutePath = path.resolve(filePath);
    if (!isWithinRoot(absolutePath, sourceRoot)) {
      return { queued: false, reason: 'outside-source-root', document };
    }

    const queueKey = normalizeInternalPath(absolutePath);
    const existingQueuedItem = this._smartIndexQueue.get(queueKey);
    const fingerprint = buildDocumentFingerprint(content);
    const contentHash = fingerprint ? fingerprint.contentHash : null;
    const selectedJobId = jobId || this._selectSmartIndexJobId({
      document,
      absolutePath,
      queueKey,
      contentHash,
      existingJobId: existingQueuedItem && existingQueuedItem.jobId
    });

    let job = null;
    try {
      job = this._getSourceLedger().enqueueIndexJob({
        jobId: selectedJobId,
        sourceId: document.sourceId,
        documentId: document.documentId,
        jobType: 'index_document',
        status: 'queued',
        requestedBy,
        currentPathInternal: absolutePath,
        contentHash
      });
    } catch (err) {
      return {
        queued: false,
        reason: err && err.message ? err.message : 'index-enqueue-failed',
        document
      };
    }

    this._smartIndexQueue.set(queueKey, {
      filePath: absolutePath,
      content: typeof content === 'string' ? content : null,
      requestedBy,
      jobId: job && job.jobId ? job.jobId : null,
      queuedAt: new Date().toISOString()
    });
    if (!this._smartIndexTimer) {
      this._smartIndexTimer = setTimeout(() => {
        this._smartIndexTimer = null;
        this._drainSmartIndexQueue().catch((err) => {
          console.warn('[doculight] Smart indexing queue failed:', err.message);
        });
      }, this._smartIndexDelayMs);
      if (typeof this._smartIndexTimer.unref === 'function') {
        this._smartIndexTimer.unref();
      }
    }
    return {
      queued: true,
      pending: this._smartIndexQueue.size,
      document,
      jobId: job && job.jobId ? job.jobId : null
    };
  }

  // @req FR-DOC-019
  _scheduleStartupIndexJobReconciliation() {
    if (this._startupReconcileTimer || this._startupReconcileInFlight) {
      return { scheduled: false, reason: 'already-scheduled' };
    }
    if (!this.indexDataDir) {
      return { scheduled: false, reason: 'index-data-dir-unavailable' };
    }
    if (!this._hasSourceLedgerDb()) {
      return { scheduled: false, reason: 'source-ledger-unavailable' };
    }
    const delayMs = Number.isInteger(this.options.startupReconcileDelayMs)
      ? Math.max(0, this.options.startupReconcileDelayMs)
      : 250;
    this._startupReconcileTimer = setTimeout(() => {
      this._startupReconcileTimer = null;
      this._startupReconcileInFlight = runBoundedAsyncTask(() => this.reconcileStartupIndexJobsAsync())
        .catch((err) => {
          console.warn('[doculight] Startup index job reconciliation failed:', err.message);
        })
        .finally(() => {
          this._startupReconcileInFlight = null;
        });
    }, delayMs);
    if (typeof this._startupReconcileTimer.unref === 'function') {
      this._startupReconcileTimer.unref();
    }
    return { scheduled: true };
  }

  // @req FR-DOC-019
  async reconcileStartupIndexJobsAsync({ activeHeartbeatMs } = {}) {
    if (!this.indexDataDir) return { examined: 0, resumed: 0, failed: 0, cancelled: 0, reason: 'index-data-dir-unavailable' };
    const sourceRoot = this._getSourceRoot();
    if (!sourceRoot) return { examined: 0, resumed: 0, failed: 0, cancelled: 0, reason: 'source-root-unavailable' };
    const ledger = this._getAvailableSourceLedger();
    if (!ledger || typeof ledger.getRecoverableIndexJobs !== 'function') {
      return { examined: 0, resumed: 0, failed: 0, cancelled: 0, reason: 'source-ledger-unavailable' };
    }

    let jobs = ledger.getRecoverableIndexJobs({ statuses: ['queued', 'indexing'] });
    const heartbeatMs = Number.isFinite(Number(activeHeartbeatMs))
      ? Math.max(0, Number(activeHeartbeatMs))
      : Math.max(0, Number(this.options.indexJobActiveHeartbeatMs) || 60000);
    const result = { examined: jobs.length, resumed: 0, failed: 0, cancelled: 0 };
    const interruptedKeywordRebuilds = this.getInterruptedKeywordRebuildJobs();
    const restartResult = this._restartInterruptedKeywordRebuildJobs(ledger, interruptedKeywordRebuilds);
    if (restartResult.count > 0) {
      result.failed += restartResult.count;
      result.restartedRebuilds = restartResult.started ? 1 : 0;
      const interruptedIds = new Set(interruptedKeywordRebuilds.map((job) => job.jobId));
      jobs = jobs.filter((job) => !interruptedIds.has(job.jobId));
    }

    for (let index = 0; index < jobs.length; index += 1) {
      if (index > 0) await yieldToEventLoop();
      const job = jobs[index];
      if (!job || !job.jobId) continue;
      if (job.cancelRequested) {
        this._settleStartupIndexJob(ledger, job, 'cancelled', 'cancel_requested', {
          message: 'Index job was cancelled before startup reconciliation'
        });
        result.cancelled += 1;
        continue;
      }

      const absolutePath = job.currentPathInternal ? path.resolve(job.currentPathInternal) : null;
      if (!absolutePath || !isWithinRoot(absolutePath, sourceRoot)) {
        this._settleStartupIndexJob(ledger, job, 'failed', 'path_policy_violation', {
          message: 'Index job path is unavailable or outside source root',
          currentPathInternal: absolutePath
        });
        result.failed += 1;
        continue;
      }
      if (!fs.existsSync(absolutePath)) {
        this._settleStartupIndexJob(ledger, job, 'failed', 'source_missing', {
          message: 'Index job source file is missing',
          currentPathInternal: absolutePath
        });
        result.failed += 1;
        continue;
      }

      let content = '';
      try {
        content = await fs.promises.readFile(absolutePath, 'utf-8');
      } catch (err) {
        this._settleStartupIndexJob(ledger, job, 'failed', 'source_read_failed', {
          message: err && err.message ? err.message : String(err),
          currentPathInternal: absolutePath
        });
        result.failed += 1;
        continue;
      }
      const actualContentHash = `sha256:${stableHash(content)}`;
      if (job.contentHash && job.contentHash !== actualContentHash) {
        this._settleStartupIndexJob(ledger, job, 'failed', 'content_hash_changed', {
          message: 'Index job content hash no longer matches source file',
          expectedContentHash: job.contentHash,
          actualContentHash,
          currentPathInternal: absolutePath
        });
        result.failed += 1;
        continue;
      }
      if (job.status === 'indexing' && heartbeatMs > 0 && isFreshHeartbeat(job.heartbeatAt, heartbeatMs)) {
        this._settleStartupIndexJob(ledger, job, 'cancelled', 'active_heartbeat_at_startup', {
          message: 'Index job heartbeat was still fresh at startup reconciliation'
        });
        result.cancelled += 1;
        continue;
      }

      const queued = this.queueDocumentIndex({
        filePath: absolutePath,
        content,
        requestedBy: job.requestedBy || 'startup-reconcile',
        jobId: job.jobId
      });
      if (queued && queued.queued) {
        result.resumed += 1;
      } else {
        this._settleStartupIndexJob(ledger, job, 'failed', 'startup_resume_failed', {
          message: queued && queued.reason ? queued.reason : 'Startup resume failed',
          currentPathInternal: absolutePath
        });
        result.failed += 1;
      }
    }
    return result;
  }

  // @req FR-DOC-019
  reconcileStartupIndexJobs({ activeHeartbeatMs } = {}) {
    if (!this.indexDataDir) return { examined: 0, resumed: 0, failed: 0, cancelled: 0, reason: 'index-data-dir-unavailable' };
    const sourceRoot = this._getSourceRoot();
    if (!sourceRoot) return { examined: 0, resumed: 0, failed: 0, cancelled: 0, reason: 'source-root-unavailable' };
    const ledger = this._getAvailableSourceLedger();
    if (!ledger || typeof ledger.getRecoverableIndexJobs !== 'function') {
      return { examined: 0, resumed: 0, failed: 0, cancelled: 0, reason: 'source-ledger-unavailable' };
    }

    let jobs = ledger.getRecoverableIndexJobs({ statuses: ['queued', 'indexing'] });
    const heartbeatMs = Number.isFinite(Number(activeHeartbeatMs))
      ? Math.max(0, Number(activeHeartbeatMs))
      : Math.max(0, Number(this.options.indexJobActiveHeartbeatMs) || 60000);
    const result = { examined: jobs.length, resumed: 0, failed: 0, cancelled: 0 };
    const interruptedKeywordRebuilds = this.getInterruptedKeywordRebuildJobs();
    const restartResult = this._restartInterruptedKeywordRebuildJobs(ledger, interruptedKeywordRebuilds);
    if (restartResult.count > 0) {
      result.failed += restartResult.count;
      result.restartedRebuilds = restartResult.started ? 1 : 0;
      const interruptedIds = new Set(interruptedKeywordRebuilds.map((job) => job.jobId));
      jobs = jobs.filter((job) => !interruptedIds.has(job.jobId));
    }

    for (const job of jobs) {
      if (!job || !job.jobId) continue;
      if (job.cancelRequested) {
        this._settleStartupIndexJob(ledger, job, 'cancelled', 'cancel_requested', {
          message: 'Index job was cancelled before startup reconciliation'
        });
        result.cancelled += 1;
        continue;
      }

      const absolutePath = job.currentPathInternal ? path.resolve(job.currentPathInternal) : null;
      if (!absolutePath || !isWithinRoot(absolutePath, sourceRoot)) {
        this._settleStartupIndexJob(ledger, job, 'failed', 'path_policy_violation', {
          message: 'Index job path is unavailable or outside source root',
          currentPathInternal: absolutePath
        });
        result.failed += 1;
        continue;
      }
      if (!fs.existsSync(absolutePath)) {
        this._settleStartupIndexJob(ledger, job, 'failed', 'source_missing', {
          message: 'Index job source file is missing',
          currentPathInternal: absolutePath
        });
        result.failed += 1;
        continue;
      }

      let content = '';
      try {
        content = fs.readFileSync(absolutePath, 'utf-8');
      } catch (err) {
        this._settleStartupIndexJob(ledger, job, 'failed', 'source_read_failed', {
          message: err && err.message ? err.message : String(err),
          currentPathInternal: absolutePath
        });
        result.failed += 1;
        continue;
      }
      const actualContentHash = `sha256:${stableHash(content)}`;
      if (job.contentHash && job.contentHash !== actualContentHash) {
        this._settleStartupIndexJob(ledger, job, 'failed', 'content_hash_changed', {
          message: 'Index job content hash no longer matches source file',
          expectedContentHash: job.contentHash,
          actualContentHash,
          currentPathInternal: absolutePath
        });
        result.failed += 1;
        continue;
      }
      if (job.status === 'indexing' && heartbeatMs > 0 && isFreshHeartbeat(job.heartbeatAt, heartbeatMs)) {
        this._settleStartupIndexJob(ledger, job, 'cancelled', 'active_heartbeat_at_startup', {
          message: 'Index job heartbeat was still fresh at startup reconciliation'
        });
        result.cancelled += 1;
        continue;
      }

      const queued = this.queueDocumentIndex({
        filePath: absolutePath,
        content,
        requestedBy: job.requestedBy || 'startup-reconcile',
        jobId: job.jobId
      });
      if (queued && queued.queued) {
        result.resumed += 1;
      } else {
        this._settleStartupIndexJob(ledger, job, 'failed', 'startup_resume_failed', {
          message: queued && queued.reason ? queued.reason : 'Startup resume failed',
          currentPathInternal: absolutePath
        });
        result.failed += 1;
      }
    }
    return result;
  }

  _settleStartupIndexJob(ledger, job, status, diagnosticCode, diagnostic) {
    ledger.updateIndexJob(job.jobId, {
      status,
      phase: 'startup-reconcile',
      diagnosticCode,
      diagnostic,
      finishedAt: true
    });
  }

  // @req REL-DOC-008
  getInterruptedKeywordRebuildJobs() {
    const ledger = this._getAvailableSourceLedger();
    if (!ledger || typeof ledger.getRecoverableIndexJobs !== 'function') return [];
    return ledger.getRecoverableIndexJobs({ statuses: ['queued', 'indexing'] })
      .filter((job) => job && job.jobType === 'keyword_rebuild' && job.cancelRequested !== true);
  }

  // @req REL-DOC-008
  _restartInterruptedKeywordRebuildJobs(ledger, jobs = []) {
    const interrupted = Array.isArray(jobs) ? jobs.filter((job) => job && job.jobId) : [];
    if (interrupted.length === 0 || !ledger || typeof ledger.updateIndexJob !== 'function') {
      return { count: 0, started: false };
    }
    for (const job of interrupted) {
      ledger.updateIndexJob(job.jobId, {
        status: 'failed',
        phase: 'startup-rebuild-recovery',
        diagnosticCode: 'interrupted_rebuild_restarted',
        diagnostic: {
          code: 'interrupted_rebuild_restarted',
          message: 'Interrupted full rebuild was restarted on app startup'
        },
        finishedAt: true
      });
    }
    const scheduled = this.startRebuild({ requestedBy: 'startup.rebuild.interrupted' });
    return {
      count: interrupted.length,
      started: Boolean(scheduled && (scheduled.started || scheduled.scheduled)),
      jobId: scheduled && scheduled.jobId ? scheduled.jobId : null
    };
  }

  // @req FR-DOC-028
  recordSavedDocument({ filePath, content, metadata = {} } = {}) {
    const sourceRoot = this._getSourceRoot();
    const absolutePath = path.resolve(requiredString(filePath, 'filePath'));
    if (!sourceRoot || !isWithinRoot(absolutePath, sourceRoot)) {
      throw new Error('Saved document path is outside source root');
    }
    const service = this._getIndexingService();
    const sourceRelativePath = path.relative(sourceRoot, absolutePath).replace(/\\/g, '/');
    const pathKey = normalizePathKey(sourceRelativePath);
    const fingerprint = buildDocumentFingerprint(content);
    return this._getSourceLedger().upsertDocument({
      sourceId: service.sourceId,
      sourceRelativePath,
      pathKey,
      canonicalPathInternal: absolutePath,
      contentHash: fingerprint ? fingerprint.contentHash : null,
      contentByteLength: fingerprint ? fingerprint.contentByteLength : null,
      contentTextLength: fingerprint ? fingerprint.contentTextLength : null,
      normalizedTextHash: fingerprint ? fingerprint.normalizedTextHash : null,
      project: metadata.project || null,
      docType: metadata.docType || null,
      category: metadata.category || null,
      documentTags: metadata.documentTags || []
    });
  }

  // @req FR-DOC-025
  getSmartSearchDocumentIdentity(filePath) {
    const sourceRoot = this._getSourceRoot();
    if (!sourceRoot || !this.indexDataDir || !filePath) return null;
    const absolutePath = path.resolve(filePath);
    if (!isWithinRoot(absolutePath, sourceRoot)) return null;
    const ledger = this._getAvailableSourceLedger();
    if (!ledger) return null;
    if (typeof ledger.findDocumentByCanonicalPath === 'function') {
      const byCanonicalPath = ledger.findDocumentByCanonicalPath({ canonicalPathInternal: absolutePath });
      if (byCanonicalPath) return byCanonicalPath;
    }
    const service = this._indexingService;
    if (!service || !service.sourceId) return null;
    const sourceRelativePath = path.relative(sourceRoot, absolutePath).replace(/\\/g, '/');
    return ledger.findDocumentBySourcePath({
      sourceId: service.sourceId,
      sourceRelativePath
    });
  }

  // @req FR-DOC-025
  getSmartSearchDocumentIdentityForCandidate(candidate = {}) {
    const sourceRoot = this._getSourceRoot();
    if (!sourceRoot || !this.indexDataDir) return null;
    const ledger = this._getAvailableSourceLedger();
    if (!ledger) return null;
    if (candidate.documentId && typeof ledger.getDocument === 'function') {
      const byDocumentId = ledger.getDocument(candidate.documentId);
      if (byDocumentId) return byDocumentId;
    }
    if (candidate.filePath) {
      const byFilePath = this.getSmartSearchDocumentIdentity(candidate.filePath);
      if (byFilePath) return byFilePath;
    }
    if (candidate.sourceRelativePath) {
      const absolutePath = path.resolve(sourceRoot, String(candidate.sourceRelativePath).replace(/\\/g, path.sep));
      return this.getSmartSearchDocumentIdentity(absolutePath);
    }
    return null;
  }

  // @req CON-DOC-006
  getSmartSearchResolvedLinkDocumentIds(filters = {}) {
    const linkFilter = this.getSmartSearchResolvedLinkFilter(filters);
    return linkFilter ? linkFilter.documentIds : null;
  }

  // @req CON-DOC-006
  getSmartSearchResolvedLinkFilter(filters = {}) {
    if (!this.indexDataDir || (!filters.linkedTo && !filters.linkedFrom)) return null;
    const ledger = this._getAvailableSourceLedger();
    if (!ledger) return null;
    try {
      const documents = typeof ledger.getResolvedLinkFilterDocuments === 'function'
        ? ledger.getResolvedLinkFilterDocuments(filters)
        : [];
      return {
        documentIds: new Set(documents.map((document) => document.documentId)),
        filePaths: documents.map((document) => document.filePathInternal).filter(Boolean)
      };
    } catch {
      return null;
    }
  }

  // @req CON-DOC-006
  getSmartSearchLinkStatusCounts() {
    if (!this.indexDataDir) return null;
    const ledger = this._getAvailableSourceLedger();
    if (!ledger) return null;
    try {
      return ledger.getLinkStatusCounts();
    } catch {
      return null;
    }
  }

  async ensureFresh() {
    if (this.dirty || !this.initialized) {
      if (!this.initialized) {
        this._createFreshEngine();
        this.initialized = true;
        this.dirty = true;
      }
      if (this._status.state === 'ready' || this._status.state === 'uninitialized') {
        this._status = {
          ...this._status,
          state: 'stale',
          phase: 'freshness-check',
          errorSummary: 'Search index requires an explicit rebuild from Settings.'
        };
      }
      return { rebuilt: false, stale: true, status: this.getStatus() };
    }
    return { rebuilt: false, stale: false, status: this.getStatus() };
  }

  // ─── Internal Methods ────────────────────────────────────

  // @req FR-DOC-019
  async _drainSmartIndexQueue() {
    if (this._smartIndexInFlight) return this._smartIndexInFlight;
    this._smartIndexInFlight = this._performSmartIndexDrain().finally(() => {
      this._smartIndexInFlight = null;
      if (this._smartIndexQueue.size > 0 && !this._smartIndexTimer) {
        this._smartIndexTimer = setTimeout(() => {
          this._smartIndexTimer = null;
          this._drainSmartIndexQueue().catch((err) => {
            console.warn('[doculight] Smart indexing queue failed:', err.message);
          });
        }, this._smartIndexDelayMs);
        if (typeof this._smartIndexTimer.unref === 'function') {
          this._smartIndexTimer.unref();
        }
      }
    });
    return this._smartIndexInFlight;
  }

  // @req FR-DOC-019
  async _performSmartIndexDrain() {
    const controller = typeof this.getIndexingWorkerController === 'function'
      ? this.getIndexingWorkerController()
      : this._indexingWorkerController;
    if (controller && typeof controller.enqueueSemanticDocument === 'function') {
      while (this._smartIndexQueue.size > 0) {
        const [queueKey, item] = this._smartIndexQueue.entries().next().value;
        try {
          const result = controller.enqueueSemanticDocument({
            filePath: item.filePath,
            content: item.content,
            requestedBy: item.requestedBy || 'post-save',
            jobId: item.jobId || undefined
          });
          if (result && result.reason === 'job-in-progress' && result.promise) {
            await result.promise.catch((err) => {
              console.warn('[doculight] Smart indexing worker wait failed:', err.message);
            });
            continue;
          }
          this._smartIndexQueue.delete(queueKey);
          if (result && result.promise) {
            await result.promise;
          }
          if (!result || result.started !== true) {
            const reason = result && result.reason ? result.reason : 'worker-unavailable';
            this._markSmartIndexJobRetryable(item, reason);
            console.warn('[doculight] Smart indexing worker was not scheduled:', reason);
          }
        } catch (err) {
          this._smartIndexQueue.delete(queueKey);
          if (this._isRetryableSmartIndexWorkerError(err)) {
            this._markSmartIndexJobRetryable(item, err && err.code ? err.code : 'worker-start-failed');
          }
          console.warn('[doculight] Smart indexing worker failed:', err.message);
        }
      }
      return;
    }

    const service = this._getIndexingService();
    if (!service) return;
    while (this._smartIndexQueue.size > 0) {
      const [queueKey, item] = this._smartIndexQueue.entries().next().value;
      this._smartIndexQueue.delete(queueKey);
      try {
        const content = typeof item.content === 'string'
          ? item.content
          : await fs.promises.readFile(item.filePath, 'utf-8');
        await service.indexDocument({
          filePath: item.filePath,
          content,
          requestedBy: item.requestedBy || 'post-save',
          jobId: item.jobId || undefined
        });
      } catch (err) {
        console.warn('[doculight] Smart indexing failed:', err.message);
      }
    }
  }

  // @req FR-DOC-019
  // @req REL-DOC-007
  _selectSmartIndexJobId({ document, absolutePath, queueKey, contentHash, existingJobId } = {}) {
    const baseJobId = stableSmartQueueJobId(
      document && document.sourceId,
      document && document.documentId,
      absolutePath
    );
    const controller = typeof this.getIndexingWorkerController === 'function'
      ? this.getIndexingWorkerController()
      : this._indexingWorkerController;
    let active = null;
    try {
      if (controller && typeof controller.getActiveJobSnapshot === 'function') {
        active = controller.getActiveJobSnapshot();
      } else if (controller && typeof controller.getStatus === 'function') {
        active = controller.getStatus();
      }
    } catch {
      active = null;
    }
    const activePath = active && (active.currentPath || active.currentPathInternal);
    const sameActiveDocument = active && active.active !== false
      && (!active.kind || active.kind === 'semantic-document')
      && (
        active.jobId === baseJobId ||
        (activePath && normalizeInternalPath(activePath) === queueKey)
      );
    if (!sameActiveDocument) return existingJobId || baseJobId;
    if (existingJobId && existingJobId !== active.jobId) return existingJobId;
    const revisionSeed = [
      baseJobId,
      contentHash || '',
      Date.now().toString(36),
      Math.random().toString(36).slice(2)
    ].join('\0');
    return `${baseJobId}_${stableHash(revisionSeed).slice(0, 12)}`;
  }

  // @req REL-DOC-007
  _markSmartIndexJobRetryable(item = {}, reason = 'worker-unavailable') {
    if (!item.jobId || !this.indexDataDir) return null;
    let ledger = null;
    try {
      ledger = this._getSourceLedger();
    } catch {
      return null;
    }
    if (!ledger || typeof ledger.updateIndexJob !== 'function') return null;
    try {
      return ledger.updateIndexJob(item.jobId, {
        status: 'queued',
        phase: 'queued',
        currentPathInternal: item.filePath || null,
        diagnosticCode: reason,
        diagnostic: { message: reason },
        startedAt: null,
        finishedAt: null
      });
    } catch {
      return null;
    }
  }

  // @req REL-DOC-007
  _isRetryableSmartIndexWorkerError(err) {
    const code = String(err && err.code ? err.code : '').toLowerCase();
    if (!code) return false;
    return [
      'indexing_worker_exited',
      'indexing_worker_failed',
      'worker_start_failed',
      'module_not_found'
    ].some((needle) => code.includes(needle));
  }

  // @req FR-DOC-019
  _getIndexingService() {
    const sourceRoot = this._getSourceRoot();
    if (!sourceRoot || !this.indexDataDir) return null;
    if (this._indexingService) return this._indexingService;
    const ledger = this._getSourceLedger();
    const source = ledger.recordSource({
      rootPathInternal: sourceRoot,
      sourceKind: 'knowledge_store',
      displayName: path.basename(sourceRoot) || 'Knowledge Store',
      rootFingerprint: stableHash(sourceRoot),
      includeGlobs: ['**/*.md', '**/*.markdown'],
      excludeGlobs: ['node_modules/**', '.git/**']
    });
    this._indexingService = createIndexingService({
      ledger,
      source,
      sourceRoot,
      tokenizer: this.keywordTokenizer,
      embeddingProvider: this.options.embeddingProvider || null,
      embeddingConfigProvider: () => this._getSemanticSearchConfig(),
      shouldCancel: typeof this.options.indexingShouldCancel === 'function'
        ? this.options.indexingShouldCancel
        : () => this._cancelRequested === true,
      hnswOptions: {
        HierarchicalNSW: this.options.HierarchicalNSW,
        hnswlib: this.options.hnswlib,
        forceUnavailable: this.options.forceHnswUnavailable === true,
        m: this.options.hnswM || 16,
        efConstruction: this.options.hnswEfConstruction || 200,
        efSearch: this.options.hnswEfSearch || 64
      }
    });
    return this._indexingService;
  }

  _getSemanticSearchConfig() {
    const fromProvider = typeof this.options.embeddingConfigProvider === 'function'
      ? this.options.embeddingConfigProvider()
      : null;
    const config = (fromProvider && typeof fromProvider === 'object')
      ? fromProvider
      : (this.options.semanticSearch || {});
    const chunker = config.chunker || {};
    return {
      enabled: config.enabled === true,
      provider: config.provider || 'openai-compatible',
      baseURL: config.baseURL || '',
      model: config.model || config.modelName || '',
      modelFingerprint: config.modelFingerprint || null,
      dimensions: Number.isInteger(config.dimensions) ? config.dimensions : null,
      batchSize: Number.isInteger(config.batchSize) && config.batchSize > 0 ? config.batchSize : 16,
      maxConcurrency: Number.isInteger(config.maxConcurrency) && config.maxConcurrency > 0 ? config.maxConcurrency : 2,
      timeout: Number.isInteger(config.timeout) ? config.timeout : (Number.isInteger(config.timeoutMs) ? config.timeoutMs : 30000),
      chunker,
      chunkSize: Number(chunker.chunkSize) || Number(config.chunkSize) || null,
      chunkOverlap: Number(chunker.chunkOverlap) || Number(config.chunkOverlap) || null,
      hnsw: config.hnsw || {},
      offlineOnly: config.offlineOnly === true,
      projectPolicy: config.projectPolicy || { mode: 'allow-all', projects: [] }
    };
  }

  // @req DR-DOC-006
  _getSourceLedger() {
    if (this._sourceLedger) return this._sourceLedger;
    const dbPath = path.join(this.indexDataDir, 'smart-search.sqlite3');
    this._sourceLedger = createSourceLedgerStore({
      dbPath,
      userDataDir: path.dirname(this.indexDataDir)
    });
    this._sourceLedger.initialize();
    return this._sourceLedger;
  }

  getSourceLedger() {
    return this._getSourceLedger();
  }

  _getAvailableSourceLedger() {
    if (this._sourceLedger) return this._sourceLedger;
    if (!this.indexDataDir) return null;
    const dbPath = path.join(this.indexDataDir, 'smart-search.sqlite3');
    if (!fs.existsSync(dbPath)) return null;
    this._sourceLedger = createSourceLedgerStore({
      dbPath,
      userDataDir: path.dirname(this.indexDataDir)
    });
    this._sourceLedger.initialize();
    return this._sourceLedger;
  }

  _hasSourceLedgerDb() {
    if (this._sourceLedger) return true;
    if (!this.indexDataDir) return false;
    return fs.existsSync(path.join(this.indexDataDir, 'smart-search.sqlite3'));
  }

  _createEngine() {
    const engine = bm25();

    engine.defineConfig({
      fldWeights: {
        title: 5,
        project: 4,
        docName: 3,
        docType: 3,
        description: 2,
        body: 1
      },
      bm25Params: { k1: 1.2, b: 0.75, k: 1 },
      ovFldNames: ['project', 'docName', 'docType', 'gitBranch', 'gitLastCommit']
    });

    engine.definePrepTasks([tokenize]);
    return engine;
  }

  _createFreshEngine() {
    this.engine = this._usesSQLiteBackend() ? null : this._createEngine();
    this.docMeta = new Map();
  }

  _indexDocument(filePath, content, engine = this.engine, docMeta = this.docMeta) {
    const frontmatterSource = content.slice(0, MAX_MAIN_SEARCH_TEXT_CHARS);
    const fmMatch = frontmatterSource.match(FM_REGEX);
    let fmData = {};
    let body = content;

    if (fmMatch) {
      fmData = parseSimpleYaml(fmMatch[1] || '');
      body = content.slice(fmMatch[0].length);
    }

    const title = fmData.title || fmData.docName || this._extractTitle(body) || path.basename(filePath, '.md');

    const doc = {
      title: title,
      project: fmData.project || '',
      docName: fmData.docName || '',
      docType: fmData.docType || '',
      category: fmData.category || '',
      documentTags: normalizeDocumentTags(fmData.documentTags),
      description: fmData.description || '',
      gitBranch: fmData.gitBranch || '',
      gitLastCommit: fmData.gitLastCommit || '',
      body: body
    };

    if (engine) {
      engine.addDoc(doc, filePath);
    }

    const meta = {
      title,
      project: fmData.project || null,
      docName: fmData.docName || null,
      docType: fmData.docType || null,
      category: fmData.category || null,
      documentTags: normalizeDocumentTags(fmData.documentTags),
      description: fmData.description || null,
      date: fmData.date || null,
      gitBranch: fmData.gitBranch || null,
      gitLastCommit: fmData.gitLastCommit || null,
      snippet: this._extractSnippet(body)
    };

    docMeta.set(filePath, meta);
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    const textHash = crypto.createHash('sha256').update(body).digest('hex');
    return { filePath, meta, body, contentHash, textHash };
  }

  _extractTitle(content) {
    const prefix = String(content || '').slice(0, MAX_MAIN_SEARCH_TEXT_CHARS);
    const m = prefix.match(/^#{1,6}\s+(.+)/m);
    return m ? m[1].trim() : null;
  }

  // @req REL-DOC-007
  _extractSnippet(content) {
    return String(content || '')
      .slice(0, MAX_MAIN_SEARCH_TEXT_CHARS)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
  }

  /**
   * Fallback search for when BM25 index is not available (< 3 docs).
   * Uses simple token matching on docMeta.
   */
  _fallbackSearch(query, { limit = 20, project, docType, category, documentTags, tagMode, pathPrefix, filePaths } = {}) {
    if (!query || !query.trim()) return [];
    const queryTokens = tokenize(query.toLowerCase());
    const results = [];

    for (const [docId, meta] of this.docMeta) {
      if (project && meta.project !== project) continue;
      if (docType && meta.docType !== docType) continue;
      if (!matchesSearchHardFilters(meta, { docId, category, documentTags, tagMode, pathPrefix, filePaths })) continue;

      const target = `${meta.title || ''} ${meta.project || ''} ${meta.docName || ''} ${meta.description || ''} ${meta.snippet || ''}`.toLowerCase();
      const targetTokens = tokenize(target);

      let score = 0;
      for (const qt of queryTokens) {
        for (const tt of targetTokens) {
          if (tt.includes(qt) || qt.includes(tt)) score++;
        }
      }

      if (score > 0) {
        results.push({
          filePath: docId,
          score: Math.round(score * 100) / 100,
          title: meta.title || path.basename(docId, '.md'),
          project: meta.project || null,
          docName: meta.docName || null,
          docType: meta.docType || null,
          category: meta.category || null,
          documentTags: Array.isArray(meta.documentTags) ? meta.documentTags : [],
          description: meta.description || null,
          date: meta.date || null,
          snippet: meta.snippet || null
        });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async _scanMarkdownFiles(dirPath, depth = 0) {
    const MAX_SCAN_DEPTH = 10;
    if (depth >= MAX_SCAN_DEPTH) {
      console.warn(`[doculight] Scan depth limit (${MAX_SCAN_DEPTH}) reached at: ${dirPath}`);
      return [];
    }
    const results = [];
    let entries;
    try {
      entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch {
      return results;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const sub = await this._scanMarkdownFiles(fullPath, depth + 1);
        results.push(...sub);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  async _saveIndex(indexPath, engine = this.engine, docMeta = this.docMeta, searchDocuments = []) {
    if (this._usesSQLiteBackend()) {
      const sqliteIndex = this._getSQLiteIndex(indexPath);
      const committedGeneration = sqliteIndex.rebuild(searchDocuments, {
        backupReason: 'rebuild-before-commit',
        skipBackup: true,
        onProgress: (event) => {
          const total = Math.max(0, Number(event && event.total) || searchDocuments.length || docMeta.size || 0);
          const current = Math.max(0, Math.min(Number(event && event.current) || 0, total));
          const currentProgressPath = event && event.currentPath ? event.currentPath : indexPath;
          this._status.phase = event && event.phase === 'commit' ? 'commit' : 'save';
          this._status.currentPath = currentProgressPath;
          this._status.progress = { current, total };
          this._status.rebuildSession = {
            active: true,
            indexedCount: current,
            pendingCount: Math.max(0, total - current),
            totalCount: total,
            currentPath: currentProgressPath
          };
          this._emitRebuildStatus();
        },
        shouldCancel: (phase, currentPath) => {
          if (!this._cancelRequested) return false;
          const err = new Error('Index rebuild cancelled');
          err.code = 'INDEX_REBUILD_CANCELLED';
          err.phase = phase;
          err.currentPath = currentPath || indexPath;
          throw err;
        }
      });
      console.log(`[doculight] SQLite search index saved: ${indexPath} (${docMeta.size} docs, generation ${committedGeneration.generationId})`);
      return committedGeneration;
    }

    const indexJson = engine.exportJSON();
    const metaJson = JSON.stringify(Object.fromEntries(docMeta));
    const combined = JSON.stringify({ index: indexJson, meta: metaJson });
    const tmpPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.promises.writeFile(tmpPath, combined, 'utf-8');
      await fs.promises.rename(tmpPath, indexPath);
      console.log(`[doculight] Search index saved: ${indexPath} (${docMeta.size} docs)`);
      return { saved: true };
    } catch (err) {
      try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
      console.error(`[doculight] Failed to save index: ${err.message}`);
      throw err;
    }
  }

  async _loadIndex(indexPath) {
    if (this._usesSQLiteBackend()) {
      const sqliteIndex = this._getSQLiteIndex(indexPath);
      sqliteIndex.assertSourceRoot();
      this._assertSQLiteTokenizerMetadata(sqliteIndex);
      this.docMeta = sqliteIndex.loadMeta();
      this.engine = null;
      console.log(`[doculight] SQLite search index loaded: ${this.docMeta.size} documents`);
      this._status = {
        ...this._status,
        state: 'ready',
        phase: null,
        currentPath: null,
        errorSummary: null,
        failedFiles: []
      };
      return;
    }

    const raw = await fs.promises.readFile(indexPath, 'utf-8');
    const { index: indexJson, meta: metaJson } = JSON.parse(raw);

    this.engine = bm25();
    // importJSON restores config, then definePrepTasks re-registers tokenizer
    this.engine.importJSON(indexJson);
    this.engine.definePrepTasks([tokenize]);

    const metaObj = JSON.parse(metaJson);
    this.docMeta = new Map(Object.entries(metaObj));

    console.log(`[doculight] Search index loaded: ${this.docMeta.size} documents`);
    this._status = {
      ...this._status,
      state: 'ready',
      phase: null,
      currentPath: null,
      errorSummary: null,
      failedFiles: []
    };
  }

  getIndexPath() {
    if (this._usesSQLiteBackend()) {
      return path.join(this.indexDataDir, SQLITE_INDEX_FILENAME);
    }
    const savePath = this.store.get('mcpAutoSavePath', '');
    return savePath ? path.join(savePath, INDEX_FILENAME) : null;
  }

  getIndexDataDir() {
    if (this._usesSQLiteBackend()) {
      return this.indexDataDir;
    }
    return this.store.get('mcpAutoSavePath', '') || null;
  }

  // @req FR-DOC-024
  getSemanticIndexingProgress() {
    const ledger = this._getAvailableSourceLedger();
    if (!ledger || typeof ledger.getIndexJobs !== 'function') return null;
    let jobs = [];
    try {
      jobs = ledger.getIndexJobs({});
    } catch {
      return null;
    }
    const activeJobs = jobs.filter((job) =>
      job &&
      job.jobType === 'index_document' &&
      ['queued', 'indexing'].includes(job.status)
    );
    if (activeJobs.length === 0) return null;
    let progressCurrent = 0;
    let progressTotal = 0;
    let phase = null;
    for (const job of activeJobs) {
      const current = Number(job.progressCurrent) || 0;
      const total = Number(job.progressTotal) || 0;
      progressCurrent += current;
      progressTotal += total > 0 ? total : 1;
      if (!phase && job.phase) phase = job.phase;
    }
    return {
      state: activeJobs.some((job) => job.status === 'indexing') ? 'indexing' : 'queued',
      phase,
      progress_current: progressCurrent,
      progress_total: progressTotal,
      pendingCount: activeJobs.length
    };
  }

  getStatus(options = {}) {
    const publicPaths = !(options && options.publicPaths === false);
    const workerStatus = this._indexingWorkerController && typeof this._indexingWorkerController.getStatus === 'function'
      ? this._indexingWorkerController.getStatus()
      : null;
    const activeWorkerStatus = workerStatus && workerStatus.active ? workerStatus : null;
    let state = this._status.state;
    if (activeWorkerStatus && activeWorkerStatus.state) {
      state = activeWorkerStatus.state;
    } else if (this._rebuildPromise) {
      state = 'rebuilding';
    } else if (this._status.state === 'failed') {
      state = 'degraded';
    } else if (this.dirty) {
      state = 'stale';
    } else if (!this.initialized) {
      state = 'uninitialized';
    } else if (state === 'uninitialized') {
      state = 'ready';
    }

    const failedFiles = this._status.failedFiles || [];
    const workerRebuildSession = workerStatus && workerStatus.kind === 'rebuild'
      ? normalizeRebuildSession(workerStatus.rebuildSession)
      : null;
    const rebuildSession = activeWorkerStatus && activeWorkerStatus.kind === 'rebuild'
      ? (workerRebuildSession || normalizeRebuildSession(this._status.rebuildSession))
      : (normalizeRebuildSession(this._status.rebuildSession) || workerRebuildSession);
    const publicRebuildSession = rebuildSession
      ? {
          ...rebuildSession,
          currentPath: publicPaths ? this._toPublicIndexingPath(rebuildSession.currentPath) : rebuildSession.currentPath
        }
      : null;
    const visibleIndexedCount = rebuildSession && rebuildSession.active ? rebuildSession.indexedCount : this.docMeta.size;
    const visiblePendingCount = rebuildSession && rebuildSession.active
      ? rebuildSession.pendingCount
      : (activeWorkerStatus ? 1 : (this.dirty ? 1 : 0));
    const rawCurrentPath = rebuildSession && rebuildSession.currentPath
      ? rebuildSession.currentPath
      : (activeWorkerStatus ? activeWorkerStatus.currentPath : this._status.currentPath);
    const statusPayload = {
      state,
      indexedCount: visibleIndexedCount,
      pendingCount: visiblePendingCount,
      failedCount: failedFiles.length,
      currentPath: publicPaths ? this._toPublicIndexingPath(rawCurrentPath) : rawCurrentPath,
      phase: activeWorkerStatus ? activeWorkerStatus.phase : this._status.phase,
      progress: activeWorkerStatus ? activeWorkerStatus.progress : (this._status.progress || null),
      rebuildSession: publicRebuildSession,
      heartbeatAt: activeWorkerStatus ? activeWorkerStatus.heartbeatAt : null,
      cancelRequested: activeWorkerStatus ? activeWorkerStatus.cancelRequested : false,
      diagnostic: activeWorkerStatus ? activeWorkerStatus.diagnostic : null,
      lastIndexedTime: this._status.lastIndexedAt,
      lastIndexedAt: this._status.lastIndexedAt,
      errorSummary: this._status.errorSummary,
      failedFiles,
      dirty: this.dirty,
      degradedReason: this._lastDegradedReason,
      indexPath: publicPaths ? this._toPublicIndexingPath(this.getIndexPath()) : this.getIndexPath(),
      dataDir: publicPaths ? this._toPublicIndexingPath(this.getIndexDataDir()) : this.getIndexDataDir(),
      indexBackend: this._getBackendStatusName(),
      tokenizer: this.keywordTokenizer && typeof this.keywordTokenizer.getStatus === 'function'
        ? this.keywordTokenizer.getStatus()
        : null,
      indexingWorker: workerStatus,
      hnswCompaction: this.getHnswCompactionStatus()
    };
    return publicPaths ? this._sanitizePublicStatusPayload(statusPayload) : statusPayload;
  }

  _toPublicIndexingPath(filePath) {
    if (!filePath) return null;
    const sourceRoot = this._getSourceRoot();
    const absolute = path.resolve(filePath);
    if (sourceRoot && isWithinRoot(absolute, sourceRoot)) {
      return path.relative(sourceRoot, absolute).replace(/\\/g, '/');
    }
    return redactIndexPathToken(absolute);
  }

  _emitRebuildStatus() {
    if (typeof this.options.onRebuildStatus !== 'function') return;
    try {
      this.options.onRebuildStatus(this.getStatus({ publicPaths: false }));
    } catch {
      // Status callbacks are best-effort and must not fail indexing work.
    }
  }

  _sanitizePublicStatusPayload(value) {
    return this._sanitizePublicStatusValue(value, new WeakSet());
  }

  _sanitizePublicStatusValue(value, seen) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return this._sanitizePublicStatusString(value);
    if (Array.isArray(value)) {
      return value.map((item) => this._sanitizePublicStatusValue(item, seen));
    }
    if (typeof value === 'object') {
      if (seen.has(value)) return null;
      seen.add(value);
      const output = {};
      for (const [key, item] of Object.entries(value)) {
        output[key] = this._sanitizePublicStatusValue(item, seen);
      }
      return output;
    }
    return value;
  }

  _sanitizePublicStatusString(value) {
    const raw = String(value);
    const trimmed = raw.trim();
    if (trimmed && path.isAbsolute(trimmed)) {
      return this._toPublicIndexingPath(trimmed);
    }
    let sanitized = raw;
    const indexDataDir = this.getIndexDataDir();
    const candidates = [
      this.getIndexPath(),
      indexDataDir,
      indexDataDir ? path.dirname(indexDataDir) : '',
      this._getSourceRoot()
    ]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    for (const candidate of candidates) {
      const replacement = this._toPublicIndexingPath(candidate);
      sanitized = sanitized.split(candidate).join(replacement);
      const slashCandidate = candidate.replace(/\\/g, '/');
      if (slashCandidate !== candidate) {
        sanitized = sanitized.split(slashCandidate).join(replacement);
      }
    }
    return sanitized;
  }

  // @req REL-DOC-007
  _createIndexingWorkerController() {
    return new IndexingWorkerController({
      store: this.store,
      indexBackend: this.indexBackend,
      indexDataDir: this.indexDataDir,
      keywordTokenizerProvider: this.options.keywordTokenizerProvider || 'garu',
      keywordTokenizerMaxAnalysisChars: this.options.keywordTokenizerMaxAnalysisChars,
      semanticSearch: this.options.semanticSearch || null,
      semanticConfigProvider: () => this._getSemanticSearchConfig(),
      embeddingApiKeyProvider: typeof this.options.embeddingApiKeyProvider === 'function'
        ? this.options.embeddingApiKeyProvider
        : null,
      workerPath: this.options.indexingWorkerPath || this.options.workerPath,
      sourceRootProvider: () => this._getSourceRoot(),
      ledgerProvider: () => (this.indexDataDir ? this._getSourceLedger() : null),
      onJobCompleted: (job) => this._handleIndexingWorkerCompleted(job),
      onJobFailed: (job) => this._handleIndexingWorkerFailed(job)
    });
  }

  // @req REL-DOC-007
  getIndexingWorkerController() {
    return this._indexingWorkerController;
  }

  // @req REL-DOC-007
  async _handleIndexingWorkerCompleted(job = {}) {
    if (job.kind === 'rebuild') {
      const indexPath = this.getIndexPath();
      if (indexPath && fs.existsSync(indexPath)) {
        await this._loadIndex(indexPath);
      }
      this.initialized = true;
      this.dirty = false;
      this._lastDegradedReason = null;
      const result = job.result || {};
      const indexedCount = Number.isFinite(Number(result.indexed)) ? Math.max(0, Number(result.indexed)) : this.docMeta.size;
      const totalCount = Number.isFinite(Number(result.scanned)) ? Math.max(indexedCount, Number(result.scanned)) : indexedCount;
      const fullReset = this._resetSearchDerivedStateAfterFullRebuild();
      this._status = {
        ...this._status,
        state: 'ready',
        phase: null,
        currentPath: null,
        progress: { current: indexedCount, total: totalCount },
        rebuildSession: {
          active: false,
          indexedCount,
          pendingCount: 0,
          totalCount,
          currentPath: null,
          requestedBy: null
        },
        lastIndexedAt: new Date().toISOString(),
        errorSummary: null,
        failedFiles: [],
        fullReset
      };
    } else if (job.kind === 'clear') {
      if (this.sqliteIndex) {
        this.sqliteIndex.close();
        this.sqliteIndex = null;
      }
      this._createFreshEngine();
      this.initialized = true;
      this.dirty = false;
      this._lastDegradedReason = null;
      this._status = {
        ...this._status,
        state: 'ready',
        phase: null,
        currentPath: null,
        lastIndexedAt: null,
        errorSummary: null,
        failedFiles: []
      };
    }
  }

  // @req REL-DOC-007
  _resetSearchDerivedStateAfterFullRebuild() {
    const ledger = this._getAvailableSourceLedger();
    if (!ledger || typeof ledger.clearSearchDerivedState !== 'function') {
      return { cleared: false, reason: 'source-ledger-unavailable' };
    }
    const cleared = ledger.clearSearchDerivedState({ reason: 'settings-rebuild-full-reset' });
    const reindex = this.queueSemanticReindexForActiveDocuments({
      requestedBy: 'settings.rebuild.full-reset'
    });
    return {
      ...cleared,
      reindexQueued: reindex && Number.isInteger(reindex.queued) ? reindex.queued : 0
    };
  }

  // @req REL-DOC-007
  _handleIndexingWorkerFailed(job = {}) {
    const status = job.status || {};
    const error = job.error || {};
    this.dirty = true;
    this._recordFailure(
      status.phase || (status.state === 'cancelled' ? 'cancelled' : 'worker'),
      status.currentPath || null,
      error && error.message ? error : new Error('Indexing worker failed'),
      []
    );
  }

  // @req FR-DOC-022
  getHnswCompactionStatus() {
    const ledger = this._getAvailableSourceLedger();
    if (!ledger || typeof ledger.getCommittedAnnIndex !== 'function' || typeof ledger.getAnnCompactionStatus !== 'function') return null;
    const semanticConfig = this._getSemanticSearchConfig();
    if (!semanticConfig || !semanticConfig.modelFingerprint) return null;
    const annIndex = ledger.getCommittedAnnIndex({ modelFingerprint: semanticConfig.modelFingerprint });
    if (!annIndex) return null;
    const threshold = Number(semanticConfig.hnsw && semanticConfig.hnsw.compactionThreshold);
    return ledger.getAnnCompactionStatus({
      annIndexId: annIndex.annIndexId,
      threshold: Number.isFinite(threshold) ? threshold : 0.20
    });
  }

  // @req REL-DOC-008
  _beginFullRebuildStatus(requestedBy) {
    this._lastDegradedReason = null;
    this._status = {
      ...this._status,
      state: 'rebuilding',
      phase: 'queued',
      currentPath: null,
      progress: { current: 0, total: 0 },
      rebuildSession: {
        active: true,
        indexedCount: 0,
        pendingCount: 0,
        totalCount: 0,
        currentPath: null,
        requestedBy: requestedBy || 'settings.rebuild'
      },
      errorSummary: null,
      failedFiles: []
    };
  }

  // @req REL-DOC-008
  _markRebuildStartFailed(result = {}, requestedBy = 'settings.rebuild') {
    const status = result && result.status && typeof result.status === 'object' ? result.status : {};
    const diagnostic = status.diagnostic && typeof status.diagnostic === 'object' ? status.diagnostic : null;
    const reason = result.reason || (diagnostic && diagnostic.code) || 'rebuild-start-failed';
    const detail = result.message || result.error || (diagnostic && diagnostic.message) || reason;
    const message = detail && detail !== reason ? `${reason}: ${detail}` : detail;
    this.dirty = true;
    this._lastDegradedReason = reason;
    this._status = {
      ...this._status,
      state: 'failed',
      phase: 'start',
      currentPath: null,
      progress: { current: 0, total: 0 },
      rebuildSession: {
        active: false,
        indexedCount: 0,
        pendingCount: 0,
        totalCount: 0,
        currentPath: null,
        requestedBy
      },
      errorSummary: message || 'Search index rebuild could not be started',
      failedFiles: []
    };
    return this.getStatus();
  }

  startRebuild(options = {}) {
    const requestedBy = options.requestedBy || 'settings.rebuild';
    const sourceRootStatus = this._getSourceRootStatus();
    if (!sourceRootStatus.ok) {
      if (sourceRootStatus.reason === 'source-root-unavailable' && this._lastDegradedReason === 'index_missing') {
        const failedStatus = this._markRebuildStartFailed({
          started: false,
          scheduled: false,
          reason: sourceRootStatus.reason
        }, requestedBy);
        return {
          started: false,
          scheduled: false,
          reason: sourceRootStatus.reason,
          status: failedStatus
        };
      }
      return {
        started: false,
        scheduled: false,
        reason: sourceRootStatus.reason,
        status: this.getStatus()
      };
    }
    const controller = this.getIndexingWorkerController();
    if (controller && typeof controller.enqueueRebuild === 'function') {
      if (controller.isActive && controller.isActive()) {
        return { started: false, status: this.getStatus() };
      }
      this._beginFullRebuildStatus(requestedBy);
      const result = controller.enqueueRebuild({ requestedBy });
      if (!(result && (result.started === true || result.scheduled === true))) {
        const failedStatus = this._markRebuildStartFailed(result || {}, requestedBy);
        return {
          started: result && result.started === true,
          scheduled: result && result.scheduled === true,
          jobId: result && result.jobId ? result.jobId : null,
          reason: result && result.reason ? result.reason : 'rebuild-start-failed',
          status: failedStatus
        };
      }
      if (result.promise) {
        this._rebuildPromise = result.promise
          .catch((err) => {
            console.error('[doculight] Worker search index rebuild failed:', err.message);
          })
          .finally(() => {
            this._rebuildPromise = null;
          });
      }
      return {
        started: result.started === true,
        scheduled: result.scheduled === true,
        jobId: result.jobId || null,
        reason: result.reason,
        status: this.getStatus()
      };
    }
    return this._startRebuildInCurrentRuntime({ requestedBy });
  }

  // @req REL-DOC-007
  _startRebuildInCurrentRuntime(options = {}) {
    if (this._rebuildPromise) {
      return { started: false, status: this.getStatus() };
    }
    this._beginFullRebuildStatus(options.requestedBy || 'settings.rebuild');
    this.rebuild().catch((err) => {
      console.error('[doculight] Background search index rebuild failed:', err.message);
    });
    return { started: true, status: this.getStatus() };
  }

  cancelRebuild() {
    const controller = this.getIndexingWorkerController();
    if (controller && typeof controller.cancelActiveJob === 'function' && controller.isActive && controller.isActive()) {
      const result = controller.cancelActiveJob();
      return { cancelled: result.cancelled === true, jobId: result.jobId || null, status: this.getStatus() };
    }
    if (!this._rebuildPromise) {
      return { cancelled: false, status: this.getStatus() };
    }
    this._cancelRequested = true;
    return { cancelled: true, status: this.getStatus() };
  }

  retryFailures() {
    return this.startRebuild();
  }

  async compact() {
    const controller = this.getIndexingWorkerController();
    if (controller && typeof controller.enqueueCompact === 'function') {
      if (this._rebuildPromise || (controller.isActive && controller.isActive())) {
        return { compacted: false, reason: 'rebuild-in-progress', status: this.getStatus() };
      }
      const indexPath = this.getIndexPath();
      if (!indexPath) {
        return { compacted: false, reason: 'index-unavailable', status: this.getStatus() };
      }
      if (!this.engine && !(this._usesSQLiteBackend() && fs.existsSync(indexPath))) {
        return { compacted: false, reason: 'index-unavailable', status: this.getStatus() };
      }
      const result = controller.enqueueCompact({ requestedBy: 'settings.compact' });
      if (result.promise) {
        this._compactInFlight = result.promise
          .catch((err) => {
            console.warn('[doculight] Worker search index compact failed:', err.message);
          })
          .finally(() => {
            this._compactInFlight = null;
          });
      }
      return {
        compacted: false,
        scheduled: result.scheduled === true,
        jobId: result.jobId || null,
        reason: result.reason,
        status: this.getStatus()
      };
    }
    if (this._usesSQLiteBackend()) {
      return { compacted: false, reason: 'worker-unavailable', status: this.getStatus() };
    }
    return this._compactInCurrentRuntime();
  }

  // @req REL-DOC-007
  async _compactInCurrentRuntime() {
    if (this._rebuildPromise) {
      return { compacted: false, reason: 'rebuild-in-progress', status: this.getStatus() };
    }
    if (this._compactInFlight) {
      return { compacted: false, scheduled: true, reason: 'compact-in-progress', status: this.getStatus() };
    }
    const indexPath = this.getIndexPath();
    if (!indexPath) {
      return { compacted: false, reason: 'index-unavailable', status: this.getStatus() };
    }
    if (!this.engine && !(this._usesSQLiteBackend() && fs.existsSync(indexPath))) {
      return { compacted: false, reason: 'index-unavailable', status: this.getStatus() };
    }
    if (this._usesSQLiteBackend()) {
      return { compacted: false, reason: 'worker-unavailable', status: this.getStatus() };
    }
    this._compactInFlight = runBoundedAsyncTask(async () => {
      await this._saveIndex(indexPath);
    }).catch((err) => {
      console.warn('[doculight] Search index compact failed:', err.message);
      this._recordFailure('compact', indexPath, err, []);
    }).finally(() => {
      this._compactInFlight = null;
    });
    return { compacted: false, scheduled: true, status: this.getStatus() };
  }

  // @req REL-DOC-007
  async clear() {
    const controller = this.getIndexingWorkerController();
    if (this._rebuildPromise || this._compactInFlight || this._clearInFlight || (controller && controller.isActive && controller.isActive())) {
      return { cleared: false, reason: 'job-in-progress', status: this.getStatus() };
    }
    const indexPath = this.getIndexPath();
    if (this._usesSQLiteBackend() && controller && typeof controller.enqueueClear === 'function') {
      if (!indexPath || !fs.existsSync(indexPath)) {
        this._createFreshEngine();
        this.initialized = true;
        this.dirty = false;
        return { cleared: true, reason: 'index-unavailable', status: this.getStatus() };
      }
      if (this.sqliteIndex) {
        this.sqliteIndex.close();
        this.sqliteIndex = null;
      }
      const result = controller.enqueueClear({ requestedBy: 'settings.clear' });
      if (result.promise) {
        this._clearInFlight = result.promise
          .catch((err) => {
            console.warn('[doculight] Worker search index clear failed:', err.message);
          })
          .finally(() => {
            this._clearInFlight = null;
          });
      }
      return {
        cleared: false,
        scheduled: result.scheduled === true,
        jobId: result.jobId || null,
        reason: result.reason,
        status: this.getStatus()
      };
    }
    let backupPath = null;
    let backupManifest = null;
    if (indexPath && fs.existsSync(indexPath)) {
      if (this._usesSQLiteBackend()) {
        const sqliteIndex = this._getSQLiteIndex(indexPath);
        backupManifest = sqliteIndex.createBackupManifest({ reason: 'clear-before-delete' });
        backupPath = backupManifest.backupPathToken || null;
        const deleteResult = sqliteIndex.deleteFiles();
        if (!deleteResult.deleted) {
          return { cleared: false, reason: 'delete-failed', backupManifest, deleteResult, status: this.getStatus() };
        }
      } else {
        const jsonBackupPath = `${indexPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        await fs.promises.copyFile(indexPath, jsonBackupPath);
        await fs.promises.unlink(indexPath);
        backupManifest = {
          version: 'doculight-search-index-backup.v1',
          kind: 'json-index',
          reason: 'clear-before-delete',
          createdAt: new Date().toISOString(),
          backupSkipped: false,
          backupPathToken: redactIndexPathToken(jsonBackupPath),
          files: [
            {
              role: 'json',
              suffix: '',
              present: true,
              copied: true,
              pathToken: redactIndexPathToken(jsonBackupPath)
            }
          ]
        };
        backupPath = backupManifest.backupPathToken;
      }
    }
    this._createFreshEngine();
    this.initialized = true;
    this.dirty = false;
    this._lastDegradedReason = null;
    this._status = {
      state: 'ready',
      phase: null,
      currentPath: null,
      lastIndexedAt: null,
      errorSummary: null,
      failedFiles: []
    };
    return { cleared: true, backupPath, backupManifest, status: this.getStatus() };
  }

  // @req FR-DOC-024
  clearSemanticDerivedState({ modelFingerprint, modelId } = {}) {
    if (!this.indexDataDir) return { cleared: false, reason: 'index-data-dir-unavailable' };
    const ledger = this._getAvailableSourceLedger();
    if (!ledger || typeof ledger.clearSemanticDerivedState !== 'function') {
      return { cleared: false, reason: 'source-ledger-unavailable' };
    }
    return ledger.clearSemanticDerivedState({ modelFingerprint, modelId });
  }

  // @req FR-DOC-024
  queueSemanticReindexForActiveDocuments({ requestedBy = 'embedding-registration' } = {}) {
    const sourceRoot = this._getSourceRoot();
    if (!sourceRoot) {
      return { queued: 0, jobs: [], skipped: true, reason: 'source-root-unconfigured' };
    }
    const ledger = this.indexDataDir ? this._getSourceLedger() : null;
    if (!ledger || typeof ledger.listActiveDocuments !== 'function') {
      return { queued: 0, jobs: [], reason: 'source-ledger-unavailable' };
    }
    const sourceDocumentsByPath = new Map();
    const addSourceDocument = (document, { overwrite = true } = {}) => {
      if (!document || !document.filePathInternal || !isWithinRoot(document.filePathInternal, sourceRoot)) return;
      const key = normalizeInternalPath(document.filePathInternal);
      if (!overwrite && sourceDocumentsByPath.has(key)) return;
      sourceDocumentsByPath.set(key, document);
    };
    const documents = ledger.listActiveDocuments({});
    for (const document of documents) {
      addSourceDocument(document);
    }
    for (const document of this._getLegacyKnowledgeStoreDocumentsForSemanticReindex(sourceRoot)) {
      addSourceDocument(document, { overwrite: false });
    }
    const sourceDocuments = Array.from(sourceDocumentsByPath.values());
    const jobs = [];
    const queuedRecords = [];
    const failures = [];
    for (const document of sourceDocuments) {
      if (!document || !document.filePathInternal || !isWithinRoot(document.filePathInternal, sourceRoot)) continue;
      const queueInput = {
        filePath: document.filePathInternal,
        requestedBy,
        metadata: {
          docType: document.docType,
          category: document.category,
          documentTags: document.documentTags || []
        }
      };
      const queued = document.documentId && document.sourceId
        ? this.queueKnownDocumentIndex({ ...queueInput, document })
        : this.queueDocumentIndex(queueInput);
      if (queued && queued.queued) {
        jobs.push({
          jobId: queued.jobId || null,
          documentId: document.documentId,
          sourceRelativePath: document.sourceRelativePath,
          requestedBy
        });
        queuedRecords.push({
          jobId: queued.jobId || null,
          filePathInternal: document.filePathInternal,
          sourceRelativePath: document.sourceRelativePath || null
        });
      } else {
        failures.push({
          documentId: document.documentId || null,
          sourceRelativePath: document.sourceRelativePath || null,
          reason: queued && queued.reason ? queued.reason : 'not-queued'
        });
      }
    }
    if (failures.length > 0) {
      const rollback = this._rollbackSemanticReindexQueuedJobs(ledger, queuedRecords, requestedBy);
      return {
        queued: 0,
        jobs: [],
        rolledBackJobs: jobs,
        rolledBack: rollback.rolledBack,
        rollbackFailures: rollback.failures,
        failures,
        reason: 'semantic-reindex-enqueue-failed'
      };
    }
    return { queued: jobs.length, jobs };
  }

  _rollbackSemanticReindexQueuedJobs(ledger, queuedRecords = [], requestedBy = 'embedding-registration') {
    const result = { rolledBack: 0, failures: [] };
    for (const record of queuedRecords) {
      if (!record) continue;
      try {
        if (record.filePathInternal) {
          this._smartIndexQueue.delete(normalizeInternalPath(record.filePathInternal));
        }
        if (record.jobId && ledger && typeof ledger.updateIndexJob === 'function') {
          const updated = ledger.updateIndexJob(record.jobId, {
            status: 'cancelled',
            cancelRequested: true,
            diagnosticCode: 'semantic_reindex_enqueue_rollback',
            diagnostic: {
              message: 'Semantic reindex enqueue failed; queued job rolled back',
              requestedBy,
              sourceRelativePath: record.sourceRelativePath || null
            },
            finishedAt: true
          });
          if (updated) {
            result.rolledBack += 1;
          }
        } else {
          result.rolledBack += 1;
        }
      } catch (err) {
        result.failures.push({
          jobId: record.jobId || null,
          sourceRelativePath: record.sourceRelativePath || null,
          reason: err && err.message ? err.message : 'rollback-failed'
        });
      }
    }
    return result;
  }

  _getLegacyKnowledgeStoreDocumentsForSemanticReindex(sourceRoot) {
    const fromMeta = Array.from(this.docMeta.entries())
      .map(([filePath, meta]) => ({
        documentId: null,
        sourceRelativePath: path.relative(sourceRoot, filePath).replace(/\\/g, '/'),
        filePathInternal: filePath,
        docType: meta && meta.docType,
        category: meta && meta.category,
        documentTags: meta && meta.documentTags
      }))
      .filter((document) => document.filePathInternal && document.filePathInternal.endsWith('.md'));
    if (fromMeta.length > 0) return fromMeta;
    return this._scanMarkdownFilesSync(sourceRoot).map((filePath) => ({
      documentId: null,
      sourceRelativePath: path.relative(sourceRoot, filePath).replace(/\\/g, '/'),
      filePathInternal: filePath,
      docType: null,
      category: null,
      documentTags: []
    }));
  }

  _scanMarkdownFilesSync(dirPath, depth = 0) {
    const MAX_SCAN_DEPTH = 10;
    if (depth >= MAX_SCAN_DEPTH) return [];
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return [];
    }
    const results = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        results.push(...this._scanMarkdownFilesSync(fullPath, depth + 1));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  _throwIfCancelled(phase, currentPath) {
    if (!this._cancelRequested) return;
    const err = new Error('Index rebuild cancelled');
    err.code = 'INDEX_REBUILD_CANCELLED';
    err.phase = phase;
    err.currentPath = currentPath;
    throw err;
  }

  _recordFailure(phase, currentPath, err, failedFiles) {
    const rebuildSession = normalizeRebuildSession(this._status.rebuildSession);
    const nextStatus = {
      ...this._status,
      state: phase === 'cancelled' ? 'cancelled' : 'failed',
      phase,
      currentPath,
      errorSummary: err.message,
      failedFiles
    };
    if (rebuildSession) {
      nextStatus.rebuildSession = {
        ...rebuildSession,
        active: false,
        pendingCount: 0,
        currentPath: null
      };
    }
    this._status = nextStatus;
  }

  close() {
    if (this._indexingWorkerController && typeof this._indexingWorkerController.close === 'function') {
      this._indexingWorkerController.close();
    }
    if (this._smartIndexTimer) {
      clearTimeout(this._smartIndexTimer);
      this._smartIndexTimer = null;
    }
    if (this._startupReconcileTimer) {
      clearTimeout(this._startupReconcileTimer);
      this._startupReconcileTimer = null;
    }
    if (this.sqliteIndex) {
      this.sqliteIndex.close();
    }
    if (this._sourceLedger) {
      this._sourceLedger.close();
      this._sourceLedger = null;
      this._indexingService = null;
    }
  }

  resetForSourceRootChange() {
    this.close();
    this.sqliteIndex = null;
    this._indexingWorkerController = this.options.disableIndexingWorkerController === true
      ? null
      : this._createIndexingWorkerController();
    this._smartIndexQueue.clear();
    this._createFreshEngine();
    this.initialized = false;
    this.dirty = true;
    this._lastDegradedReason = null;
    this._status = {
      state: 'stale',
      phase: null,
      currentPath: null,
      lastIndexedAt: null,
      errorSummary: null,
      failedFiles: []
    };
  }

  _markIndexRebuildRequired(reason, currentPath, err) {
    const message = err && err.message ? err.message : 'Search index rebuild required';
    if (this.sqliteIndex) {
      this.sqliteIndex.close();
      this.sqliteIndex = null;
    }
    this._createFreshEngine();
    this.initialized = true;
    this.dirty = true;
    this._lastDegradedReason = reason;
    this._status = {
      state: 'stale',
      phase: 'startup',
      currentPath,
      lastIndexedAt: null,
      errorSummary: message,
      failedFiles: currentPath ? [{ filePath: currentPath, phase: 'startup', error: message }] : []
    };
  }

  _usesSQLiteBackend() {
    return this.indexBackend === 'sqlite';
  }

  _getSQLiteIndex(indexPath = this.getIndexPath()) {
    if (this.sqliteIndex && this.sqliteIndex.dbPath === indexPath) {
      return this.sqliteIndex;
    }
    this.sqliteIndex = new SQLiteKeywordIndex({
      dbPath: indexPath,
      sourceRoot: this._getSourceRoot(),
      loadDatabase: this.options.sqliteLoadDatabase,
      tokenizer: this.keywordTokenizer
    });
    return this.sqliteIndex;
  }

  async _initializeKeywordTokenizer() {
    if (!this._usesSQLiteBackend()) return;
    if (this.keywordTokenizer && typeof this.keywordTokenizer.initialize === 'function') {
      await this.keywordTokenizer.initialize();
    }
  }

  _assertSQLiteTokenizerMetadata(sqliteIndex) {
    if (!sqliteIndex || !this.keywordTokenizer || typeof this.keywordTokenizer.getIndexMetadata !== 'function') {
      return;
    }

    const current = this.keywordTokenizer.getIndexMetadata();
    const stored = sqliteIndex.loadIndexMetadata();
    const expectedProvider = String(current.tokenizer_provider || '');
    const expectedVersion = String(current.tokenizer_version || '');
    const expectedDegradedReason = String(current.tokenizer_degraded_reason || '');
    const actualProvider = String(stored.tokenizer_provider || '');
    const actualVersion = String(stored.tokenizer_version || '');
    const actualDegradedReason = String(stored.tokenizer_degraded_reason || '');

    if (!expectedProvider) return;
    if (
      actualProvider === expectedProvider &&
      actualVersion === expectedVersion &&
      actualDegradedReason === expectedDegradedReason
    ) {
      return;
    }

    const expected = `${expectedProvider}@${expectedVersion || '(unknown)'}`;
    const actual = `${actualProvider || '(missing)'}@${actualVersion || '(missing)'}`;
    const expectedReason = expectedDegradedReason || '(none)';
    const actualReason = actualDegradedReason || '(none)';
    const err = new Error(`SQLite keyword index tokenizer mismatch: expected ${expected} degraded=${expectedReason}, found ${actual} degraded=${actualReason}`);
    err.code = 'SQLITE_INDEX_TOKENIZER_MISMATCH';
    err.expectedTokenizerProvider = expectedProvider;
    err.expectedTokenizerVersion = expectedVersion;
    err.actualTokenizerProvider = actualProvider;
    err.actualTokenizerVersion = actualVersion;
    err.expectedTokenizerDegradedReason = expectedDegradedReason;
    err.actualTokenizerDegradedReason = actualDegradedReason;
    throw err;
  }

  _getSourceRoot() {
    const savePath = this.store.get('mcpAutoSavePath', '');
    return savePath ? path.resolve(savePath) : '';
  }

  _getSourceRootStatus() {
    const sourceRoot = this._getSourceRoot();
    if (!sourceRoot) {
      return { ok: false, reason: 'source-root-unconfigured', sourceRoot: '' };
    }
    try {
      if (fs.statSync(sourceRoot).isDirectory()) {
        return { ok: true, reason: null, sourceRoot };
      }
    } catch {
      return { ok: false, reason: 'source-root-unavailable', sourceRoot };
    }
    return { ok: false, reason: 'source-root-unavailable', sourceRoot };
  }

  _getBackendStatusName() {
    if (!this._usesSQLiteBackend()) return 'json-bm25';
    return this.sqliteIndex && this.sqliteIndex.available ? 'sqlite-fts5' : 'sqlite-fts5-unavailable';
  }
}

function isWithinRoot(filePath, rootPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(filePath));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function matchesSearchHardFilters(meta = {}, { docId, category, documentTags, tagMode, pathPrefix, filePaths } = {}) {
  if (category && meta.category !== category) return false;
  if (hasDocumentTagFilter(documentTags)) {
    const actualTags = new Set(Array.isArray(meta.documentTags) ? meta.documentTags : []);
    const expectedTags = documentTags.map((tag) => String(tag || '').trim()).filter(Boolean);
    if ((tagMode || 'any') === 'all') {
      if (!expectedTags.every((tag) => actualTags.has(tag))) return false;
    } else if (!expectedTags.some((tag) => actualTags.has(tag))) {
      return false;
    }
  }
  if (Array.isArray(filePaths)) {
    const allowed = new Set(filePaths.map((item) => normalizeInternalPath(item)));
    if (!docId || !allowed.has(normalizeInternalPath(docId))) return false;
  }
  if (pathPrefix && docId) {
    const normalizedDocId = normalizeInternalPath(docId);
    const normalizedPrefix = normalizeInternalPath(pathPrefix);
    if (!normalizedDocId.startsWith(normalizedPrefix)) return false;
  }
  return true;
}

function hasDocumentTagFilter(documentTags) {
  return Array.isArray(documentTags) && documentTags.some((tag) => String(tag || '').trim());
}

function normalizeInternalPath(value) {
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
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
  if (typeof content !== 'string') return null;
  const normalizedText = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return {
    contentHash: `sha256:${stableHash(content)}`,
    contentByteLength: Buffer.byteLength(content, 'utf8'),
    contentTextLength: content.length,
    normalizedTextHash: `sha256:${stableHash(normalizedText)}`
  };
}

function hasSameContentFingerprint(document, fingerprint) {
  if (!document || !fingerprint) return false;
  if (document.contentHash !== fingerprint.contentHash) return false;
  if (Number.isInteger(document.contentByteLength) && document.contentByteLength !== fingerprint.contentByteLength) return false;
  if (Number.isInteger(document.contentTextLength) && document.contentTextLength !== fingerprint.contentTextLength) return false;
  return true;
}

function fileSha256(filePath) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

function stableSmartQueueJobId(sourceId, documentId, filePath) {
  const key = ['smart-queue', sourceId || '', documentId || '', normalizeInternalPath(filePath || '')].join('\0');
  return `job_${stableHash(key).slice(0, 24)}`;
}

function isFreshHeartbeat(value, maxAgeMs) {
  const time = Date.parse(String(value || ''));
  if (!Number.isFinite(time)) return false;
  return Date.now() - time <= Math.max(0, Number(maxAgeMs) || 0);
}

function runBoundedAsyncTask(task) {
  return new Promise((resolve, reject) => {
    const schedule = typeof setImmediate === 'function' ? setImmediate : (fn) => setTimeout(fn, 0);
    schedule(() => {
      Promise.resolve()
        .then(task)
        .then(resolve, reject);
    });
  });
}

function yieldToEventLoop() {
  return new Promise((resolve) => {
    const schedule = typeof setImmediate === 'function' ? setImmediate : (fn) => setTimeout(fn, 0);
    schedule(resolve);
  });
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

function redactIndexPathToken(filePath) {
  const hash = crypto.createHash('sha256').update(String(filePath || '')).digest('hex').slice(0, 12);
  const base = path.basename(String(filePath || 'index'));
  return `[REDACTED_PATH:${base}:${hash}]`;
}

function normalizeRebuildSession(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    active: value.active === true,
    indexedCount: Math.max(0, Number(value.indexedCount) || 0),
    pendingCount: Math.max(0, Number(value.pendingCount) || 0),
    totalCount: Math.max(0, Number(value.totalCount) || 0),
    currentPath: value.currentPath || null,
    requestedBy: value.requestedBy || null
  };
}

function fileModifiedAfter(filePath, timestampMs) {
  try {
    const stat = fs.statSync(filePath);
    return Number(stat.mtimeMs) > Number(timestampMs);
  } catch {
    return false;
  }
}

function normalizeSmartSearchFilters(args = {}) {
  return {
    ...(args.filters || {}),
    ...(args.linkedTo ? { linkedTo: args.linkedTo } : {}),
    ...(args.linkedFrom ? { linkedFrom: args.linkedFrom } : {})
  };
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

module.exports = { SearchEngine };
