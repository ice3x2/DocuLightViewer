'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const { redactValue, redactString } = require('../src/main/redaction');
const { SearchEngine } = require('../src/main/search-engine');

function wave2Assert(condition, message) {
  assert(condition, `Wave 2 ledger contract: ${message}`);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function getColumnNames(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name);
}

async function removeTreeWithRetry(targetPath) {
  let lastError = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      return;
    } catch (err) {
      lastError = err;
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(err && err.code)) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  scheduleDeferredRemove(targetPath, lastError);
}

function scheduleDeferredRemove(targetPath, cause) {
  const cleanupScript = `
const fs = require('fs');
const target = process.argv[1];
let attempt = 0;
function cleanup() {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    if (attempt++ < 20) setTimeout(cleanup, 100);
  }
}
setTimeout(cleanup, 100);
`;
  try {
    const child = spawn(process.execPath, ['-e', cleanupScript, targetPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
  } catch {
    console.warn(`[doculight-test] deferred cleanup was not scheduled for ${targetPath}: ${cause && cause.message}`);
  }
}

function tryRequire(relativePath) {
  try {
    return require(relativePath);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(relativePath.replace('../', ''))) {
      return null;
    }
    throw err;
  }
}

function createLedgerFactory(moduleExports) {
  if (!moduleExports) return null;
  if (typeof moduleExports.createSourceLedgerStore === 'function') return moduleExports.createSourceLedgerStore;
  if (typeof moduleExports.createWave2LedgerStore === 'function') return moduleExports.createWave2LedgerStore;
  if (typeof moduleExports.SourceLedgerStore === 'function') {
    return (options) => new moduleExports.SourceLedgerStore(options);
  }
  return null;
}

class FakeAnnHierarchicalNSW {
  constructor(metric, dimensions) {
    this.metric = metric;
    this.dimensions = dimensions;
    this.points = [];
  }

  initIndex(maxElements) {
    this.maxElements = maxElements;
  }

  setEf(efSearch) {
    this.efSearch = efSearch;
  }

  addPoint(vector, label) {
    this.points.push({ vector, label });
  }

  searchKnn(_vector, limit) {
    const points = this.points.slice(0, limit);
    return {
      neighbors: points.map((point) => point.label),
      distances: points.map((_, index) => index)
    };
  }

  writeIndexSync(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ metric: this.metric, dimensions: this.dimensions, points: this.points }), 'utf-8');
  }
}

(async () => {
  const ledgerModule = tryRequire('../src/main/source-ledger-store');
  const chunkerModule = tryRequire('../src/main/chunker');
  const classifierModule = tryRequire('../src/main/document-classifier');
  const linkGraphModule = tryRequire('../src/main/link-graph-indexer');
  const indexingServiceModule = tryRequire('../src/main/indexing-service');
  const ledgerFactory = createLedgerFactory(ledgerModule);

  wave2Assert(
    typeof ledgerFactory === 'function',
    'source-ledger-store must export createSourceLedgerStore/createWave2LedgerStore or SourceLedgerStore'
  );
  wave2Assert(
    chunkerModule && typeof chunkerModule.createHeadingAwareChunker === 'function',
    'chunker module exports createHeadingAwareChunker()'
  );
  wave2Assert(
    classifierModule && typeof classifierModule.createDocumentClassifier === 'function',
    'document-classifier module exports createDocumentClassifier()'
  );
  wave2Assert(
    linkGraphModule && typeof linkGraphModule.createLinkGraphIndexer === 'function',
    'link-graph-indexer module exports createLinkGraphIndexer()'
  );
  wave2Assert(
    indexingServiceModule && typeof indexingServiceModule.createIndexingService === 'function',
    'indexing-service module exports createIndexingService()'
  );

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-wave2-ledger-'));
  try {
    const dbPath = path.join(tmp, 'userData', 'index', 'smart-search.sqlite3');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const ledger = ledgerFactory({ dbPath, userDataDir: path.join(tmp, 'userData') });

    wave2Assert(typeof ledger.initialize === 'function', 'ledger exposes initialize()');
    wave2Assert(typeof ledger.getSchemaInfo === 'function', 'ledger exposes getSchemaInfo()');
    wave2Assert(typeof ledger.recordSource === 'function', 'ledger exposes recordSource()');
    wave2Assert(typeof ledger.upsertDocument === 'function', 'ledger exposes upsertDocument()');
    wave2Assert(typeof ledger.recordLinkEdge === 'function', 'ledger exposes recordLinkEdge()');
    wave2Assert(typeof ledger.getLinkDiagnostics === 'function', 'ledger exposes getLinkDiagnostics()');
    wave2Assert(typeof ledger.upsertEmbeddingModel === 'function', 'ledger exposes upsertEmbeddingModel() for semantic lifecycle');
    wave2Assert(typeof ledger.upsertChunkEmbedding === 'function', 'ledger exposes upsertChunkEmbedding() for chunk vectors');
    wave2Assert(typeof ledger.searchChunkEmbeddings === 'function', 'ledger exposes searchChunkEmbeddings() for built-in semantic retrieval');

    await ledger.initialize();
    const schema = await ledger.getSchemaInfo();
    const requiredTables = [
      'sources',
      'documents',
      'chunks',
      'chunk_search_content',
      'chunk_fts',
      'links',
      'embedding_models',
      'chunk_embeddings',
      'ann_indexes',
      'ann_memberships',
      'index_jobs'
    ];
    for (const tableName of requiredTables) {
      wave2Assert(schema.tables && schema.tables.includes(tableName), `schema includes ${tableName}`);
    }
    const indexJobColumns = getColumnNames(ledger.open(), 'index_jobs');
    wave2Assert(indexJobColumns.includes('content_byte_length'), 'index_jobs stores content_byte_length for restart reconciliation');
    wave2Assert(indexJobColumns.includes('content_text_length'), 'index_jobs stores content_text_length for restart reconciliation');

    const legacyDbPath = path.join(tmp, 'migration-userData', 'index', 'smart-search.sqlite3');
    fs.mkdirSync(path.dirname(legacyDbPath), { recursive: true });
    const legacyDb = new Database(legacyDbPath);
    legacyDb.exec(`
      CREATE TABLE documents (
        document_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        path_key TEXT NOT NULL,
        canonical_path_hash TEXT,
        path_status TEXT NOT NULL DEFAULT 'active',
        path_history_json TEXT NOT NULL DEFAULT '[]',
        content_hash TEXT,
        project TEXT,
        doc_type TEXT,
        source_mtime_or_revision TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_import_job_id TEXT,
        import_state TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source_id, path_key)
      );
      CREATE TABLE document_source_aliases (
        alias_id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        alias_kind TEXT NOT NULL,
        canonical_path_hash TEXT NOT NULL UNIQUE,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE index_jobs (
        job_id TEXT PRIMARY KEY,
        source_id TEXT,
        document_id TEXT,
        job_type TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        requested_by TEXT,
        phase TEXT,
        progress_current INTEGER NOT NULL DEFAULT 0,
        progress_total INTEGER NOT NULL DEFAULT 0,
        current_path_internal TEXT,
        content_hash TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        diagnostic_code TEXT,
        diagnostic_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        heartbeat_at TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    legacyDb.close();
    const migratedLedger = ledgerFactory({ dbPath: legacyDbPath, userDataDir: path.join(tmp, 'migration-userData') });
    try {
      await migratedLedger.initialize();
      const migratedIndexJobColumns = getColumnNames(migratedLedger.open(), 'index_jobs');
      const migratedAliasColumns = getColumnNames(migratedLedger.open(), 'document_source_aliases');
      wave2Assert(migratedIndexJobColumns.includes('content_byte_length'), 'legacy index_jobs gains content_byte_length migration');
      wave2Assert(migratedIndexJobColumns.includes('content_text_length'), 'legacy index_jobs gains content_text_length migration');
      wave2Assert(migratedAliasColumns.includes('origin_lexical_path_internal'), 'legacy aliases gain nullable lexical origin path migration');
      wave2Assert(migratedAliasColumns.includes('origin_path_internal'), 'legacy aliases gain nullable canonical origin path migration');
      const migratedSource = await migratedLedger.recordSource({
        rootPathInternal: path.join(tmp, 'legacy-source'),
        displayName: 'Legacy Source',
        rootFingerprint: 'legacy-root'
      });
      const migratedDoc = await migratedLedger.upsertDocument({
        sourceId: migratedSource.sourceId,
        sourceRelativePath: 'legacy.md',
        pathKey: 'legacy.md',
        contentHash: 'sha256:legacy',
        contentByteLength: 12,
        contentTextLength: 10
      });
      const migratedJob = await migratedLedger.enqueueIndexJob({
        sourceId: migratedSource.sourceId,
        documentId: migratedDoc.documentId,
        jobType: 'index_document',
        status: 'queued',
        requestedBy: 'test.legacy-migration',
        contentHash: 'sha256:legacy',
        contentByteLength: 12,
        contentTextLength: 10
      });
      wave2Assert(migratedJob.contentByteLength === 12, 'queued index job preserves contentByteLength');
      wave2Assert(migratedJob.contentTextLength === 10, 'queued index job preserves contentTextLength');
      const recoverable = migratedLedger.getRecoverableIndexJobs({ statuses: ['queued'] });
      wave2Assert(recoverable.some((job) => (
        job.jobId === migratedJob.jobId
        && job.contentByteLength === 12
        && job.contentTextLength === 10
      )), 'recoverable index jobs expose fingerprint lengths for restart reconciliation');
    } finally {
      migratedLedger.close();
    }

    const source = await ledger.recordSource({
      rootPathInternal: path.join(tmp, 'source'),
      displayName: 'Wave2 Source',
      rootFingerprint: 'root-fingerprint-1',
      includeGlobs: ['**/*.md'],
      excludeGlobs: ['node_modules/**']
    });
    const doc = await ledger.upsertDocument({
      sourceId: source.sourceId,
      sourceRelativePath: 'A.md',
      pathKey: 'a.md',
      contentHash: 'sha256:a',
      docType: 'guide',
      category: 'engineering',
      documentTags: ['wave2']
    });
    await ledger.upsertChunk({
      documentId: doc.documentId,
      ordinal: 0,
      headingPath: ['A'],
      searchText: 'needle phrase for wave two chunk search',
      text: 'needle phrase for wave two chunk search',
      textHash: 'chunk-text-hash'
    });
    const ftsMatch = ledger.open().prepare("SELECT COUNT(*) AS count FROM chunk_fts WHERE chunk_fts MATCH 'needle'").get();
    wave2Assert(ftsMatch.count === 1, 'chunk_fts is populated when chunk_search_content is upserted');
    const embeddingModel = await ledger.upsertEmbeddingModel({
      provider: 'openai-compatible',
      modelName: 'fixture-embedding-model',
      modelFingerprint: 'fixture-fingerprint',
      dimensions: 3
    });
    await ledger.upsertChunkEmbedding({
      chunkId: ledger.open().prepare('SELECT chunk_id FROM chunks WHERE document_id = ? ORDER BY ordinal LIMIT 1').get(doc.documentId).chunk_id,
      modelId: embeddingModel.modelId,
      embedding: [1, 0, 0],
      vectorHash: 'sha256:near',
      status: 'active'
    });
    const semanticCandidates = await ledger.searchChunkEmbeddings({
      modelFingerprint: 'fixture-fingerprint',
      queryVector: [0.98, 0.02, 0],
      limit: 5
    });
    wave2Assert(semanticCandidates.length >= 1, 'ledger returns semantic candidates from stored chunk embeddings');
    wave2Assert(semanticCandidates[0].documentId === doc.documentId, 'semantic candidates include document identity');
    wave2Assert(semanticCandidates[0].score > 0.9, 'semantic candidates expose normalized similarity score');
    wave2Assert(semanticCandidates[0].distance < 0.1, 'semantic candidates expose lower-is-better vector distance');

    let missingWithoutDiagnosticRejected = false;
    try {
      await ledger.recordLinkEdge({
        fromDocumentId: doc.documentId,
        originalHref: './NoDiagnostic.md',
        normalizedHref: './NoDiagnostic.md',
        status: 'missing'
      });
    } catch {
      missingWithoutDiagnosticRejected = true;
    }
    wave2Assert(missingWithoutDiagnosticRejected, 'non-resolved links require diagnostic_code');

    const missingEdge = await ledger.recordLinkEdge({
      fromDocumentId: doc.documentId,
      originalHref: './Missing.md',
      normalizedHref: './Missing.md',
      status: 'missing',
      diagnosticCode: 'target_missing'
    });

    wave2Assert(missingEdge.status === 'missing', 'canonical link status preserves missing');
    wave2Assert(missingEdge.diagnosticCode === 'target_missing', 'broken-link diagnostics preserve diagnostic_code');
    wave2Assert(!missingEdge.toDocumentId, 'broken-link diagnostics do not resolve to a target document');

    const diagnostics = await ledger.getLinkDiagnostics({ documentId: doc.documentId });
    const serialized = JSON.stringify(diagnostics);
    wave2Assert(serialized.includes('"missing"'), 'diagnostics include canonical link status counts');
    wave2Assert(!serialized.includes(tmp), 'diagnostics redact raw absolute paths and userData paths');
    wave2Assert(
      !JSON.stringify(redactValue({ sourceRootInternal: '/etc/doculight/source', api_key: 'secret' })).includes('/etc/doculight/source'),
      'redaction treats sourceRootInternal as an internal path key'
    );
    wave2Assert(
      !redactString('api_key=secret token=abc https://user:pass@example.test/v1').includes('secret'),
      'redaction covers body-style credential strings and URL userinfo'
    );

    const sourceRoot = path.join(tmp, 'source');
    fs.mkdirSync(path.join(sourceRoot, 'docs'), { recursive: true });
    const targetPath = path.join(sourceRoot, 'docs', 'B.md');
    fs.writeFileSync(targetPath, '# Target\n\n링크 대상 문서', 'utf-8');
    const existingTarget = await ledger.upsertDocument({
      sourceId: source.sourceId,
      sourceRelativePath: 'docs/B.md',
      pathKey: 'docs/b.md',
      contentHash: 'sha256:b',
      docType: 'guide',
      category: 'reference',
      documentTags: ['target']
    });

    const chunkFixture = [
      '---',
      'title: Chunk Fixture',
      '---',
      '# Alpha',
      '',
      '한국어 English mixed text keeps tokenizer input stable.',
      '',
      '## Code Policy',
      '',
      '```ts',
      'const value = "keep";',
      '```',
      '',
      '## Long Code',
      '',
      '```text',
      Array.from({ length: 28 }, (_, index) => `code-token-${index}`).join(' '),
      '```',
      '',
      '## Long Body',
      '',
      Array.from({ length: 36 }, (_, index) => `long-token-${index}`).join(' ')
    ].join('\n');
    const fixtureChunker = chunkerModule.createHeadingAwareChunker({ maxTokens: 10, overlapTokens: 2 });
    const fixtureChunks = fixtureChunker.chunkMarkdown(chunkFixture, { documentId: 'fixture-doc' });
    const fixtureChunksAgain = fixtureChunker.chunkMarkdown(chunkFixture, { documentId: 'fixture-doc' });
    wave2Assert(fixtureChunks.length >= 5, 'chunk fixture covers heading-aware and long-body split cases');
    wave2Assert(
      JSON.stringify(fixtureChunks.map((chunk) => chunk.chunkId)) === JSON.stringify(fixtureChunksAgain.map((chunk) => chunk.chunkId)),
      'chunk fixture produces deterministic chunk ids across repeated runs'
    );
    wave2Assert(
      fixtureChunks.every((chunk) => !chunk.text.includes('title: Chunk Fixture')),
      'frontmatter is excluded from chunk text'
    );
    wave2Assert(
      fixtureChunks.some((chunk) => chunk.lineStart > 3 && chunk.headingPath.includes('Alpha') && chunk.text.includes('한국어') && chunk.text.includes('English')),
      'chunk fixture preserves heading offsets for Korean and English mixed text'
    );
    const codeChunks = fixtureChunks.filter((chunk) => chunk.headingPath.includes('Code Policy'));
    wave2Assert(
      codeChunks.length === 1 && codeChunks[0].text.includes('```ts') && codeChunks[0].text.includes('```'),
      'short fenced code block is kept in one chunk when it fits the token limit'
    );
    const longCodeChunks = fixtureChunks.filter((chunk) => chunk.headingPath.includes('Long Code'));
    wave2Assert(longCodeChunks.length > 1, 'long fenced code block is split when it exceeds the token limit');
    wave2Assert(
      longCodeChunks[0].text.includes('```text') && longCodeChunks[longCodeChunks.length - 1].text.includes('```'),
      'long fenced code split preserves the opening and closing fence across deterministic chunks'
    );
    wave2Assert(
      longCodeChunks.every((chunk) => chunk.tokenCount <= 10),
      'long fenced code chunks respect the configured token limit'
    );
    const longBodyChunks = fixtureChunks.filter((chunk) => chunk.headingPath.includes('Long Body'));
    wave2Assert(longBodyChunks.length > 1, 'long body is split deterministically when it exceeds the token limit');
    wave2Assert(
      longBodyChunks.every((chunk) => chunk.tokenCount <= 10),
      'long-body chunks respect the configured token limit'
    );

    const serviceChunker = chunkerModule.createHeadingAwareChunker({ maxTokens: 24, overlapTokens: 4 });
    const serviceClassifier = classifierModule.createDocumentClassifier();
    const serviceLinkGraphIndexer = linkGraphModule.createLinkGraphIndexer({ sourceRoot });
    let hnswYieldCalls = 0;
    const service = indexingServiceModule.createIndexingService({
      ledger,
      source,
      sourceRoot,
      tokenizer: {
        buildSearchText(text) {
          return `${text} 라이선스 사용`;
        }
      },
      chunker: serviceChunker,
      classifier: serviceClassifier,
      linkGraphIndexer: serviceLinkGraphIndexer,
      embeddingConfig: {
        enabled: true,
        provider: 'openai-compatible',
        model: 'fixture-embedding-model',
        modelFingerprint: 'fixture-fingerprint-service',
        dimensions: 3
      },
      hnswOptions: {
        HierarchicalNSW: FakeAnnHierarchicalNSW,
        yieldEvery: 1,
        async yield() {
          hnswYieldCalls += 1;
          await Promise.resolve();
        }
      },
      embeddingProvider: {
        async embed({ inputs, model }) {
          wave2Assert(model === 'fixture-embedding-model', 'indexing service passes configured embedding model');
          return inputs.map((text) => text.includes('라이선스') ? [1, 0, 0] : [0, 1, 0]);
        }
      }
    });

    const markdown = [
      '---',
      'docType: guide',
      'category: research',
      'documentTags:',
      '  - wave2',
      '  - korean',
      '  - smart-search',
      '---',
      '# Root Heading',
      '',
      '라이선스를 사용할 수 없습니다.',
      '',
      '## Deep Section',
      '',
      '[Resolved](./B.md) [QueryResolved](./B.md?x=1) [Missing](./Missing.md) [External](https://example.test/doc) [[WikiMissing]]',
      '[Win](C:/Temp/Secret.md) [File](file:///tmp/Secret.md) [Traversal](..%2fSecret.md)',
      '',
      '추가 본문 '.repeat(40)
      ].join('\n');
    const indexed = await service.indexDocument({
      filePath: path.join(sourceRoot, 'docs', 'A.md'),
      content: markdown,
      requestedBy: 'test.ph5'
    });

    wave2Assert(indexed.job.status === 'completed', 'indexing service completes a bounded background-style job');
    wave2Assert(indexed.document.category === 'research', 'explicit category is preserved');
    wave2Assert(indexed.document.documentTags.includes('wave2'), 'explicit documentTags are normalized');
    wave2Assert(
      indexed.document.classification && indexed.document.classification.assignedBy === 'explicit',
      'explicit frontmatter category stores classifier assignment metadata'
    );
    wave2Assert(
      indexed.document.classification && indexed.document.classification.confidence === 1,
      'explicit frontmatter category stores classifier confidence'
    );
    wave2Assert(indexed.document.parseStatus === 'ok', 'valid frontmatter metadata stores parse_status ok');
    wave2Assert(indexed.chunks.length >= 2, 'heading-aware chunker creates deterministic chunks');
    wave2Assert(indexed.chunks.some((chunk) => chunk.headingPath.includes('Deep Section')), 'chunks preserve heading path');
    wave2Assert(indexed.links.some((edge) => edge.status === 'resolved' && edge.toDocumentId === existingTarget.documentId), 'link graph resolves known local Markdown target');
    wave2Assert(indexed.links.filter((edge) => edge.status === 'resolved' && edge.toDocumentId === existingTarget.documentId).length >= 2, 'link graph resolves local Markdown targets with query strings by path');
    wave2Assert(indexed.links.some((edge) => edge.status === 'missing' && edge.diagnosticCode === 'target_missing'), 'link graph records missing local target as diagnostic edge');
    wave2Assert(indexed.links.some((edge) => edge.status === 'external' && edge.diagnosticCode === 'external_url'), 'link graph records external URL as diagnostic edge');
    wave2Assert(indexed.links.some((edge) => edge.status === 'path_policy_violation' && edge.diagnosticCode === 'windows_absolute_path'), 'link graph treats Windows absolute links as path policy violations');
    wave2Assert(indexed.links.some((edge) => edge.status === 'path_policy_violation' && edge.diagnosticCode === 'file_url'), 'link graph treats file URLs as path policy violations');
    wave2Assert(indexed.links.some((edge) => edge.status === 'path_policy_violation' && edge.diagnosticCode === 'traversal'), 'link graph treats encoded traversal as path policy violations');

    const indexedFtsMatch = ledger.open().prepare("SELECT COUNT(*) AS count FROM chunk_fts WHERE chunk_fts MATCH '라이선스'").get();
    wave2Assert(indexedFtsMatch.count >= 1, 'indexing service writes tokenizer-normalized search_text to FTS');
    const metadataFtsMatch = ledger.open().prepare("SELECT COUNT(*) AS count FROM chunk_fts WHERE chunk_fts MATCH 'wave2'").get();
    wave2Assert(metadataFtsMatch.count >= 1, 'category/documentTags metadata is included in keyword FTS search_text');
    const indexedEmbeddingCount = ledger.open().prepare(`
      SELECT COUNT(*) AS count
      FROM chunk_embeddings ce
      JOIN embedding_models em ON em.model_id = ce.model_id
      JOIN chunks c ON c.chunk_id = ce.chunk_id
      WHERE c.document_id = ? AND em.model_fingerprint = ?
    `).get(indexed.document.documentId, 'fixture-fingerprint-service');
    wave2Assert(indexedEmbeddingCount.count >= 1, 'indexing service stores chunk embeddings after document save indexing');
    const committedAnnIndex = ledger.open().prepare(`
      SELECT ai.*
      FROM ann_indexes ai
      JOIN embedding_models em ON em.model_id = ai.model_id
      WHERE em.model_fingerprint = ? AND ai.status = 'committed'
    `).get('fixture-fingerprint-service');
    wave2Assert(committedAnnIndex && fs.existsSync(committedAnnIndex.index_path_internal), 'indexing service writes committed HNSW index with atomic file path');
    const annMembershipCount = ledger.open().prepare('SELECT COUNT(*) AS count FROM ann_memberships WHERE ann_index_id = ?').get(committedAnnIndex.ann_index_id);
    wave2Assert(annMembershipCount.count >= indexedEmbeddingCount.count, 'indexing service records HNSW ann memberships for stored chunk embeddings');
    wave2Assert(hnswYieldCalls >= 1, 'HNSW build yields during bounded asynchronous indexing work');
    const committedAnnPublic = ledger.getCommittedAnnIndex({ modelFingerprint: 'fixture-fingerprint-service' });
    wave2Assert(
      committedAnnPublic && committedAnnPublic.params && committedAnnPublic.params.m === 16 && committedAnnPublic.params.efSearch === 64,
      'ann_indexes stores HNSW runtime params for persisted load'
    );

    const moveContent = '# Move Me\n\nsame content should keep vectors during path move';
    const moveIndexed = await service.indexDocument({
      filePath: path.join(sourceRoot, 'docs', 'MoveMe.md'),
      content: moveContent,
      requestedBy: 'test.move.before'
    });
    const movedDocument = ledger.upsertDocument({
      sourceId: source.sourceId,
      documentId: moveIndexed.document.documentId,
      sourceRelativePath: 'docs/MovedMe.md',
      pathKey: 'docs/movedme.md',
      canonicalPathInternal: path.join(sourceRoot, 'docs', 'MovedMe.md'),
      contentHash: moveIndexed.document.contentHash,
      pathStatus: 'active',
      docType: moveIndexed.document.docType,
      category: moveIndexed.document.category,
      documentTags: moveIndexed.document.documentTags
    });
    wave2Assert(movedDocument.documentId === moveIndexed.document.documentId, 'document move preserves stable documentId');
    wave2Assert(
      movedDocument.pathHistory.some((entry) => entry.relativePath === 'docs/MoveMe.md'),
      'document move records previous source-relative path history'
    );
    const movedEmbeddingCount = ledger.open().prepare(`
      SELECT COUNT(*) AS count
      FROM chunk_embeddings ce
      JOIN chunks c ON c.chunk_id = ce.chunk_id
      WHERE c.document_id = ?
    `).get(moveIndexed.document.documentId);
    wave2Assert(movedEmbeddingCount.count >= 1, 'document move preserves chunk vectors for same content hash');
    const productionMoveContent = '# Production Move\n\nsame content move through indexDocument';
    const productionMoveBefore = await service.indexDocument({
      filePath: path.join(sourceRoot, 'docs', 'ProductionMove.md'),
      content: productionMoveContent,
      requestedBy: 'test.production.move.before'
    });
    ledger.upsertDocument({
      sourceId: source.sourceId,
      documentId: productionMoveBefore.document.documentId,
      sourceRelativePath: productionMoveBefore.document.sourceRelativePath,
      pathKey: productionMoveBefore.document.pathKey,
      canonicalPathInternal: path.join(sourceRoot, productionMoveBefore.document.sourceRelativePath),
      contentHash: productionMoveBefore.document.contentHash,
      pathStatus: 'missing',
      docType: productionMoveBefore.document.docType,
      category: productionMoveBefore.document.category,
      documentTags: productionMoveBefore.document.documentTags
    });
    const productionMoveAfter = await service.indexDocument({
      filePath: path.join(sourceRoot, 'docs', 'ProductionMoved.md'),
      content: productionMoveContent,
      requestedBy: 'test.production.move.after'
    });
    wave2Assert(
      productionMoveAfter.document.documentId === productionMoveBefore.document.documentId,
      'indexDocument preserves documentId for same-content move candidates without explicit documentId'
    );

    const deleteContent = '# Delete Me\n\nsemantic tombstone target';
    const deleteIndexed = await service.indexDocument({
      filePath: path.join(sourceRoot, 'docs', 'DeleteMe.md'),
      content: deleteContent,
      requestedBy: 'test.delete.before'
    });
    const latestAnnForTombstone = ledger.getCommittedAnnIndex({ modelFingerprint: 'fixture-fingerprint-service' });
    ledger.upsertDocument({
      sourceId: source.sourceId,
      documentId: deleteIndexed.document.documentId,
      sourceRelativePath: deleteIndexed.document.sourceRelativePath,
      pathKey: deleteIndexed.document.pathKey,
      canonicalPathInternal: path.join(sourceRoot, deleteIndexed.document.sourceRelativePath),
      contentHash: deleteIndexed.document.contentHash,
      pathStatus: 'deleted',
      docType: deleteIndexed.document.docType,
      category: deleteIndexed.document.category,
      documentTags: deleteIndexed.document.documentTags
    });
    const deletedMemberships = ledger.getAnnMembershipCandidates({ annIndexId: latestAnnForTombstone.annIndexId })
      .filter((membership) => membership.documentId === deleteIndexed.document.documentId);
    wave2Assert(
      deletedMemberships.length >= 1 && deletedMemberships.every((membership) => membership.tombstoned && membership.deletedAt),
      'deleted document ann_memberships keep unique labels with tombstone deleted_at state'
    );
    const activeMemberships = ledger.getAnnMembershipCandidates({ annIndexId: latestAnnForTombstone.annIndexId })
      .filter((membership) => !membership.tombstoned);
    wave2Assert(
      activeMemberships.every((membership) => membership.documentId !== deleteIndexed.document.documentId),
      'tombstoned memberships are excluded from default semantic candidate inputs'
    );
    const compactionStatus = ledger.getAnnCompactionStatus({ annIndexId: latestAnnForTombstone.annIndexId, threshold: 0.01 });
    wave2Assert(
      compactionStatus.compactionRecommended === true && compactionStatus.staleCount >= deletedMemberships.length,
      'tombstone ratio above configured threshold recommends HNSW compaction'
    );

    class ThrowingWriteHierarchicalNSW extends FakeAnnHierarchicalNSW {
      writeIndexSync() {
        throw new Error('forced hnsw compact failure');
      }
    }
    const priorCommittedAnnId = latestAnnForTombstone.annIndexId;
    const failingCompactService = indexingServiceModule.createIndexingService({
      ledger,
      source,
      sourceRoot,
      tokenizer: {
        buildSearchText(text) {
          return text;
        }
      },
      chunker: serviceChunker,
      classifier: serviceClassifier,
      linkGraphIndexer: serviceLinkGraphIndexer,
      embeddingConfig: {
        enabled: true,
        provider: 'openai-compatible',
        model: 'fixture-embedding-model',
        modelFingerprint: 'fixture-fingerprint-service',
        dimensions: 3
      },
      hnswOptions: {
        HierarchicalNSW: ThrowingWriteHierarchicalNSW
      },
      embeddingProvider: {
        async embed({ inputs }) {
          return inputs.map(() => [1, 0, 0]);
        }
      }
    });
    const failedCompactIndexed = await failingCompactService.indexDocument({
      filePath: path.join(sourceRoot, 'docs', 'FailedCompact.md'),
      content: '# Failed Compact\n\natomic rollback keeps previous committed index',
      requestedBy: 'test.failed.compact'
    });
    wave2Assert(failedCompactIndexed.semantic.degraded === true && failedCompactIndexed.semantic.reason === 'atomic_swap_failed', 'failed HNSW compact/build reports degraded atomic swap');
    const committedAfterFailedCompact = ledger.getCommittedAnnIndex({ modelFingerprint: 'fixture-fingerprint-service' });
    wave2Assert(
      committedAfterFailedCompact && committedAfterFailedCompact.annIndexId === priorCommittedAnnId,
      'failed HNSW compact/build preserves the previous committed ANN index'
    );

    const customHnswService = indexingServiceModule.createIndexingService({
      ledger,
      source,
      sourceRoot,
      tokenizer: {
        buildSearchText(text) {
          return text;
        }
      },
      chunker: serviceChunker,
      classifier: serviceClassifier,
      linkGraphIndexer: serviceLinkGraphIndexer,
      embeddingConfig: {
        enabled: true,
        provider: 'openai-compatible',
        model: 'fixture-custom-hnsw-model',
        modelFingerprint: 'fixture-custom-hnsw-fingerprint',
        dimensions: 3,
        hnsw: { m: 8, efConstruction: 80, efSearch: 24, space: 'cosine' }
      },
      hnswOptions: {
        HierarchicalNSW: FakeAnnHierarchicalNSW
      },
      embeddingProvider: {
        async embed({ inputs }) {
          return inputs.map(() => [0, 1, 0]);
        }
      }
    });
    await customHnswService.indexDocument({
      filePath: path.join(sourceRoot, 'docs', 'CustomHnsw.md'),
      content: '# Custom HNSW\n\ncustom runtime params',
      requestedBy: 'test.custom.hnsw'
    });
    const customCommittedAnn = ledger.getCommittedAnnIndex({ modelFingerprint: 'fixture-custom-hnsw-fingerprint' });
    wave2Assert(
      customCommittedAnn && customCommittedAnn.params.m === 8 && customCommittedAnn.params.efConstruction === 80 && customCommittedAnn.params.efSearch === 24,
      'ann_indexes stores configured HNSW runtime params, not only defaults'
    );

    const serviceModelRow = ledger.open().prepare('SELECT model_id FROM embedding_models WHERE model_fingerprint = ?').get('fixture-fingerprint-service');
    const initialChunkRows = ledger.open().prepare(`
      SELECT chunk_id, ordinal, heading_path_json, text_hash
      FROM chunks
      WHERE document_id = ?
      ORDER BY ordinal
    `).all(indexed.document.documentId);
    const initialStableChunk = initialChunkRows.find((row) => JSON.parse(row.heading_path_json).includes('Root Heading'));
    const initialMutableChunkIds = initialChunkRows
      .filter((row) => JSON.parse(row.heading_path_json).includes('Deep Section'))
      .map((row) => row.chunk_id);
    wave2Assert(initialStableChunk && initialMutableChunkIds.length >= 1, 'chunk stale fixture has stable and mutable heading sections');
    const stableEmbeddingBefore = ledger.open().prepare(`
      SELECT vector_hash, status
      FROM chunk_embeddings
      WHERE chunk_id = ? AND model_id = ?
    `).get(initialStableChunk.chunk_id, serviceModelRow.model_id);
    wave2Assert(stableEmbeddingBefore && stableEmbeddingBefore.status === 'active', 'stable chunk starts with an active embedding');

    const deferredSemanticService = indexingServiceModule.createIndexingService({
      ledger,
      source,
      sourceRoot,
      tokenizer: {
        buildSearchText(text) {
          return `${text} 라이선스 사용`;
        }
      },
      chunker: serviceChunker,
      classifier: serviceClassifier,
      linkGraphIndexer: serviceLinkGraphIndexer,
      embeddingConfig: {
        enabled: false,
        skipReason: 'test_deferred_embedding'
      }
    });
    const changedMarkdown = markdown
      .replace('# Root Heading', '# Inserted Heading\n\n새 임베딩 없는 본문\n\n# Root Heading')
      .replace('추가 본문 '.repeat(40), '변경 본문 '.repeat(40));
    const changedIndexed = await deferredSemanticService.indexDocument({
      filePath: path.join(sourceRoot, 'docs', 'A.md'),
      content: changedMarkdown,
      requestedBy: 'test.ph5.changed'
    });
    const changedChunkRows = ledger.open().prepare(`
      SELECT chunk_id, ordinal, heading_path_json, text_hash
      FROM chunks
      WHERE document_id = ?
      ORDER BY ordinal
    `).all(changedIndexed.document.documentId);
    const stableChunkAfter = changedChunkRows.find((row) => JSON.parse(row.heading_path_json).includes('Root Heading'));
    wave2Assert(
      stableChunkAfter && stableChunkAfter.text_hash === initialStableChunk.text_hash,
      'unchanged chunk keeps its text hash even when a preceding section changes its ordinal'
    );
    wave2Assert(
      stableChunkAfter.chunk_id !== initialStableChunk.chunk_id,
      'ordinal-changing fixture proves unchanged text can receive a new deterministic chunk id'
    );
    const stableEmbeddingAfter = ledger.open().prepare(`
      SELECT vector_hash, status
      FROM chunk_embeddings
      WHERE chunk_id = ? AND model_id = ?
    `).get(stableChunkAfter.chunk_id, serviceModelRow.model_id);
    wave2Assert(
      stableEmbeddingAfter && stableEmbeddingAfter.status === 'active' && stableEmbeddingAfter.vector_hash === stableEmbeddingBefore.vector_hash,
      'unchanged chunk keeps its active embedding when only another chunk changes'
    );
    const committedAnnAfterDeferredRestore = ledger.getCommittedAnnIndex({ modelFingerprint: 'fixture-fingerprint-service' });
    wave2Assert(
      !committedAnnAfterDeferredRestore,
      'deferred ordinal-change embedding restore marks the old committed ANN index stale instead of serving stale memberships'
    );
    const staleAnnAfterDeferredRestore = ledger.open().prepare(`
      SELECT COUNT(*) AS count
      FROM ann_indexes
      WHERE model_id = ? AND status = 'stale'
    `).get(serviceModelRow.model_id);
    wave2Assert(staleAnnAfterDeferredRestore.count >= 1, 'stale ANN state is persisted for rebuilt memberships after deferred semantic indexing');
    const changedDeepChunkIds = changedChunkRows
      .filter((row) => JSON.parse(row.heading_path_json).includes('Deep Section'))
      .map((row) => row.chunk_id);
    wave2Assert(
      changedDeepChunkIds.length >= 1 && changedDeepChunkIds.some((chunkId) => !initialMutableChunkIds.includes(chunkId)),
      'changed text produces new deterministic chunk ids for the changed heading section'
    );
    const removedMutableRows = ledger.open().prepare(`
      SELECT COUNT(*) AS count
      FROM chunks
      WHERE chunk_id IN (${initialMutableChunkIds.map(() => '?').join(',')})
    `).get(...initialMutableChunkIds);
    wave2Assert(removedMutableRows.count === 0, 'old changed chunk rows are removed from the active chunk set');
    const changedEmbeddingRows = ledger.open().prepare(`
      SELECT COUNT(*) AS count
      FROM chunk_embeddings
      WHERE model_id = ? AND chunk_id IN (${changedDeepChunkIds.map(() => '?').join(',')})
    `).get(serviceModelRow.model_id, ...changedDeepChunkIds);
    wave2Assert(changedEmbeddingRows.count === 0, 'changed chunks are left missing embeddings when semantic indexing is deferred');

    const semanticClear = ledger.clearSemanticDerivedState({ modelFingerprint: 'fixture-fingerprint-service' });
    wave2Assert(semanticClear.cleared === true && semanticClear.embeddingCount >= 1, 'semantic model change clears stored chunk embeddings');
    const documentAfterSemanticClear = ledger.getDocument(indexed.document.documentId);
    wave2Assert(documentAfterSemanticClear && documentAfterSemanticClear.documentId === indexed.document.documentId, 'semantic clear does not delete source documents');
    const ftsAfterSemanticClear = ledger.open().prepare("SELECT COUNT(*) AS count FROM chunk_fts WHERE chunk_fts MATCH '라이선스'").get();
    wave2Assert(ftsAfterSemanticClear.count >= 1, 'semantic clear does not delete keyword FTS content');

    const classifierDoc = await service.indexDocument({
      filePath: path.join(sourceRoot, 'docs', 'Classifier.md'),
      content: [
        '---',
        'docType: guide',
        'documentTags: alpha, beta, alpha',
        '---',
        '# Classifier',
        '',
        'No explicit category here.'
      ].join('\n'),
      requestedBy: 'test.classifier.metadata'
    });
    wave2Assert(classifierDoc.document.category === 'guide', 'frontmatter docType can drive category inference when category is absent');
    wave2Assert(
      classifierDoc.document.classification && classifierDoc.document.classification.assignedBy === 'classifier',
      'classifier-inferred category stores assigned_by classifier'
    );
    wave2Assert(
      classifierDoc.document.classification && classifierDoc.document.classification.reason === 'frontmatter.docType',
      'classifier metadata stores category evidence reason'
    );
    wave2Assert(
      JSON.stringify(classifierDoc.document.documentTags) === JSON.stringify(['alpha', 'beta']),
      'comma-separated documentTags normalize deterministically and de-duplicate'
    );

    const fallbackDoc = await service.indexDocument({
      filePath: path.join(sourceRoot, 'misc', 'Plain.md'),
      content: '# Plain\n\nordinary text without metadata',
      requestedBy: 'test.classifier.fallback'
    });
    wave2Assert(fallbackDoc.document.category === 'general', 'category fallback is general');
    wave2Assert(
      fallbackDoc.document.classification && fallbackDoc.document.classification.assignedBy === 'fallback',
      'fallback category stores assigned_by fallback'
    );

    const malformedMetadataDoc = await service.indexDocument({
      filePath: path.join(sourceRoot, 'docs', 'Malformed.md'),
      content: [
        '---',
        'category: {bad: true}',
        'documentTags: {bad: true}',
        '---',
        '# Malformed',
        '',
        'Metadata parse diagnostics should not fail document indexing.'
      ].join('\n'),
      requestedBy: 'test.classifier.malformed'
    });
    wave2Assert(malformedMetadataDoc.job.status === 'completed', 'malformed category/documentTags metadata does not fail indexing');
    wave2Assert(malformedMetadataDoc.document.parseStatus === 'diagnostic', 'malformed category/documentTags metadata records parse diagnostic status');
    wave2Assert(
      malformedMetadataDoc.document.metadataDiagnostic && malformedMetadataDoc.document.metadataDiagnostic.diagnosticCode === 'metadata_parse_diagnostic',
      'malformed category/documentTags metadata stores diagnostic payload'
    );

    const listMalformedMetadataDoc = await service.indexDocument({
      filePath: path.join(sourceRoot, 'docs', 'ListMalformed.md'),
      content: [
        '---',
        'category:',
        '  - research',
        'documentTags:',
        '  - {bad: true}',
        '---',
        '# List Malformed',
        '',
        'List-shaped metadata diagnostics should not fail document indexing.'
      ].join('\n'),
      requestedBy: 'test.classifier.list-malformed'
    });
    wave2Assert(listMalformedMetadataDoc.job.status === 'completed', 'list-shaped malformed metadata does not fail indexing');
    wave2Assert(listMalformedMetadataDoc.document.parseStatus === 'diagnostic', 'list-shaped malformed metadata records parse diagnostic status');
    wave2Assert(
      JSON.stringify(listMalformedMetadataDoc.document.metadataDiagnostic || {}).includes('category') &&
        JSON.stringify(listMalformedMetadataDoc.document.metadataDiagnostic || {}).includes('documentTags'),
      'list-shaped category and documentTags diagnostics are both persisted'
    );

    const tablePriorityDoc = await service.indexDocument({
      filePath: path.join(sourceRoot, 'plain', 'TablePriority.md'),
      content: [
        '# Table Priority',
        '',
        '| Field | Value |',
        '| --- | --- |',
        '| category | policy |',
        '',
        'This body mentions embedding search but the top metadata table should win.'
      ].join('\n'),
      requestedBy: 'test.classifier.table-priority'
    });
    wave2Assert(tablePriorityDoc.document.category === 'policy', 'top metadata table category wins over later body keyword evidence');
    wave2Assert(
      tablePriorityDoc.document.classification && tablePriorityDoc.document.classification.reason === 'top.metadata_table',
      'metadata table category stores table evidence reason'
    );

    const failingEmbeddingService = indexingServiceModule.createIndexingService({
      ledger,
      source,
      sourceRoot,
      tokenizer: {
        buildSearchText(text) {
          return `${text} 실패격리`;
        }
      },
      chunker: chunkerModule.createHeadingAwareChunker({ maxTokens: 24, overlapTokens: 4 }),
      classifier: classifierModule.createDocumentClassifier(),
      linkGraphIndexer: linkGraphModule.createLinkGraphIndexer({ sourceRoot }),
      embeddingConfig: {
        enabled: true,
        provider: 'openai-compatible',
        model: 'failing-embedding-model',
        modelFingerprint: 'fixture-fingerprint-failure',
        dimensions: 3
      },
      embeddingProvider: {
        async embed() {
          const err = new Error('simulated provider failure api_key=secret');
          err.code = 'embedding_batch_failed';
          throw err;
        }
      }
    });
    const failureIndexed = await failingEmbeddingService.indexDocument({
      filePath: path.join(sourceRoot, 'docs', 'C.md'),
      content: '# C\n\n임베딩 실패는 저장 실패가 아닙니다.',
      requestedBy: 'test.embedding.failure'
    });
    wave2Assert(failureIndexed.job.status === 'completed', 'embedding provider failure does not fail document indexing');
    wave2Assert(failureIndexed.semantic.degraded === true, 'embedding provider failure is reported as semantic degradation');
    const failureJob = (await ledger.getIndexJobs({ documentId: failureIndexed.document.documentId }))
      .find((job) => job.requestedBy === 'test.embedding.failure');
    wave2Assert(failureJob && failureJob.diagnosticCode === 'embedding_batch_failed', 'embedding failure is recorded on indexing diagnostics');
    wave2Assert(!JSON.stringify(failureJob).includes('secret'), 'embedding failure diagnostics redact credential-like values');
    const rawFailureJob = ledger.open().prepare('SELECT diagnostic_json FROM index_jobs WHERE job_id = ?').get(failureJob.jobId);
    wave2Assert(!String(rawFailureJob.diagnostic_json || '').includes('secret'), 'embedding failure diagnostics are redacted before SQLite persistence');

    const hnswUnavailableService = indexingServiceModule.createIndexingService({
      ledger,
      source,
      sourceRoot,
      chunker: chunkerModule.createHeadingAwareChunker({ maxTokens: 24, overlapTokens: 4 }),
      classifier: classifierModule.createDocumentClassifier(),
      linkGraphIndexer: linkGraphModule.createLinkGraphIndexer({ sourceRoot }),
      embeddingConfig: {
        enabled: true,
        provider: 'openai-compatible',
        model: 'hnsw-unavailable-model',
        modelFingerprint: 'fixture-fingerprint-hnsw-unavailable',
        dimensions: 3
      },
      hnswOptions: {
        forceUnavailable: true
      },
      embeddingProvider: {
        async embed({ inputs }) {
          return inputs.map(() => [1, 0, 0]);
        }
      }
    });
    const hnswUnavailableIndexed = await hnswUnavailableService.indexDocument({
      filePath: path.join(sourceRoot, 'docs', 'HnswUnavailable.md'),
      content: '# HNSW Unavailable\n\n네이티브 HNSW 실패 진단 문서입니다.',
      requestedBy: 'test.hnsw.unavailable'
    });
    wave2Assert(hnswUnavailableIndexed.job.status === 'completed', 'HNSW native failure does not fail document indexing');
    const hnswUnavailableJob = (await ledger.getIndexJobs({ documentId: hnswUnavailableIndexed.document.documentId }))
      .find((job) => job.requestedBy === 'test.hnsw.unavailable');
    wave2Assert(hnswUnavailableJob && hnswUnavailableJob.diagnosticCode === 'native_unavailable', 'HNSW native failure is recorded on indexing diagnostics');

    let allowListEmbeddingCalls = 0;
    const allowListService = indexingServiceModule.createIndexingService({
      ledger,
      source,
      sourceRoot,
      chunker: chunkerModule.createHeadingAwareChunker({ maxTokens: 24, overlapTokens: 4 }),
      classifier: classifierModule.createDocumentClassifier(),
      linkGraphIndexer: linkGraphModule.createLinkGraphIndexer({ sourceRoot }),
      embeddingConfig: {
        enabled: true,
        provider: 'openai-compatible',
        model: 'policy-model',
        modelFingerprint: 'fixture-fingerprint-policy-allow',
        dimensions: 3,
        projectPolicy: { mode: 'allow-list', projects: ['Alpha'] }
      },
      embeddingProvider: {
        async embed({ inputs }) {
          allowListEmbeddingCalls += inputs.length;
          return inputs.map(() => [1, 0, 0]);
        }
      }
    });
    await allowListService.indexDocument({
      filePath: path.join(sourceRoot, 'docs', 'PolicyAllow.md'),
      content: '---\nproject: Alpha\n---\n# Policy Allow\n\n허용 프로젝트 문서입니다.',
      requestedBy: 'test.policy.allow'
    });
    wave2Assert(allowListEmbeddingCalls >= 1, 'embedding allow-list honors frontmatter project metadata');

    let denyListEmbeddingCalls = 0;
    const denyListService = indexingServiceModule.createIndexingService({
      ledger,
      source,
      sourceRoot,
      chunker: chunkerModule.createHeadingAwareChunker({ maxTokens: 24, overlapTokens: 4 }),
      classifier: classifierModule.createDocumentClassifier(),
      linkGraphIndexer: linkGraphModule.createLinkGraphIndexer({ sourceRoot }),
      embeddingConfig: {
        enabled: true,
        provider: 'openai-compatible',
        model: 'policy-model',
        modelFingerprint: 'fixture-fingerprint-policy-deny',
        dimensions: 3,
        projectPolicy: { mode: 'deny-list', projects: ['Alpha'] }
      },
      embeddingProvider: {
        async embed({ inputs }) {
          denyListEmbeddingCalls += inputs.length;
          return inputs.map(() => [1, 0, 0]);
        }
      }
    });
    const denyIndexed = await denyListService.indexDocument({
      filePath: path.join(sourceRoot, 'docs', 'PolicyDeny.md'),
      content: '---\nproject: Alpha\n---\n# Policy Deny\n\n차단 프로젝트 문서입니다.',
      requestedBy: 'test.policy.deny'
    });
    wave2Assert(denyListEmbeddingCalls === 0, 'embedding deny-list blocks frontmatter project metadata');
    wave2Assert(denyIndexed.semantic.reason === 'project_policy_blocked', 'project policy block is reported as semantic degradation');
    const jobs = await ledger.getIndexJobs({ documentId: indexed.document.documentId });
    wave2Assert(jobs.some((job) => job.requestedBy === 'test.ph5' && job.status === 'completed'), 'index_jobs records requested_by and completed status');
    const completedJob = jobs.find((job) => job.requestedBy === 'test.ph5' && job.status === 'completed');
    const restartedJob = await ledger.enqueueIndexJob({
      jobId: completedJob.jobId,
      sourceId: source.sourceId,
      documentId: indexed.document.documentId,
      status: 'indexing',
      requestedBy: 'test.restart',
      currentPathInternal: path.join(tmp, 'source', 'docs', 'A.md'),
      contentHash: indexed.document.contentHash
    });
    wave2Assert(!restartedJob.finishedAt, 'restarted index job clears stale finishedAt');
    await ledger.updateIndexJob(completedJob.jobId, {
      status: 'failed',
      diagnosticCode: 'forced_failure',
      diagnostic: {
        message: `failed at ${path.join(tmp, 'source', 'docs', 'A.md')} api_key=secret`
      },
      finishedAt: true
    });
    const failedJob = (await ledger.getIndexJobs({ documentId: indexed.document.documentId })).find((job) => job.status === 'failed');
    wave2Assert(!JSON.stringify(failedJob).includes(tmp), 'index job diagnostics redact raw local paths');
    wave2Assert(!JSON.stringify(failedJob).includes('secret'), 'index job diagnostics redact credential-like values');
    const indexedDiagnostics = await ledger.getLinkDiagnostics({ documentId: indexed.document.documentId });
    wave2Assert(indexedDiagnostics.counts.resolved >= 1, 'diagnostics count resolved edges');
    wave2Assert(indexedDiagnostics.counts.missing >= 1, 'diagnostics count missing edges');

    const engineDocs = path.join(tmp, 'engine-docs');
    const engineIndexDir = path.join(tmp, 'engine-userData', 'index');
    fs.mkdirSync(engineDocs, { recursive: true });
    fs.writeFileSync(path.join(engineDocs, 'queued.md'), '# Queued\n\nold content', 'utf-8');
    const engine = new SearchEngine({
      get(key, defaultValue) {
        if (key === 'mcpAutoSavePath') return engineDocs;
        if (key === 'mcpAutoSave') return true;
        return defaultValue;
      }
    }, {
      indexBackend: 'sqlite',
      indexDataDir: engineIndexDir,
      smartIndexDelayMs: 60000
    });
    const queuedPath = path.join(engineDocs, 'queued.md');
    engine.markDirty({ filePath: queuedPath, content: '# Queued\n\nfirst content', requestedBy: 'test.first' });
    engine.markDirty({ filePath: queuedPath, content: '# Queued\n\nlatest content 최신색인 라이선스', requestedBy: 'test.latest' });
    const immediatelyQueuedJobs = engine._getSourceLedger().getIndexJobs({ status: 'queued' });
    wave2Assert(immediatelyQueuedJobs.length === 1, 'post-save indexing is queued before asynchronous drain starts');
    wave2Assert(!engine._smartIndexInFlight, 'queueDocumentIndex does not run long indexing synchronously on the request path');
    await engine._drainSmartIndexQueue();
    const engineLedger = engine._getSourceLedger();
    const engineJobs = engineLedger.getIndexJobs({});
    wave2Assert(engineJobs.length === 1, 'SearchEngine post-save queue merges consecutive saves with latest-wins');
    wave2Assert(engineJobs[0].requestedBy === 'test.latest', 'latest-wins job keeps the latest requested_by');
    const latestFtsMatch = engineLedger.open().prepare("SELECT COUNT(*) AS count FROM chunk_fts WHERE chunk_fts MATCH '최신색인'").get();
    wave2Assert(latestFtsMatch.count >= 1, 'SearchEngine post-save queue writes tokenizer-normalized smart index text');
    const semanticActiveDocumentBefore = engineLedger.findDocumentByCanonicalPath({
      canonicalPathInternal: queuedPath
    });
    wave2Assert(
      semanticActiveDocumentBefore && semanticActiveDocumentBefore.contentHash,
      'active source ledger document has a content fingerprint before semantic reindex enqueue'
    );
    wave2Assert(
      typeof engine.queueSemanticReindexForActiveDocuments === 'function',
      'SearchEngine exposes settings-triggered semantic reindex enqueue for active documents'
    );
    const semanticReindex = engine.queueSemanticReindexForActiveDocuments({ requestedBy: 'test.semantic.registration' });
    wave2Assert(semanticReindex.queued >= 1, 'embedding registration enqueues active documents for semantic indexing');
    wave2Assert(
      semanticReindex.jobs.some((job) => job.documentId),
      'semantic registration preserves active ledger document identity when scanned Markdown paths overlap'
    );
    wave2Assert(
      semanticReindex.jobs.every((job) => job.requestedBy === 'test.semantic.registration'),
      'semantic registration jobs preserve requested_by for settings diagnostics'
    );
    const semanticActiveDocumentAfter = engineLedger.getDocument(semanticActiveDocumentBefore.documentId);
    wave2Assert(
      semanticActiveDocumentAfter &&
        semanticActiveDocumentAfter.contentHash === semanticActiveDocumentBefore.contentHash &&
        semanticActiveDocumentAfter.contentByteLength === semanticActiveDocumentBefore.contentByteLength &&
        semanticActiveDocumentAfter.normalizedTextHash === semanticActiveDocumentBefore.normalizedTextHash,
      'semantic registration does not clear active source ledger document fingerprints while enqueueing reindex jobs'
    );
    const failingQueueDocs = path.join(tmp, 'semantic-failing-docs');
    fs.mkdirSync(failingQueueDocs, { recursive: true });
    const failingQueuePath = path.join(failingQueueDocs, 'failing.md');
    fs.writeFileSync(failingQueuePath, '# Failing\n\nsemantic enqueue failure', 'utf-8');
    const failingQueueEngine = new SearchEngine({
      get(key, defaultValue) {
        if (key === 'mcpAutoSavePath') return failingQueueDocs;
        if (key === 'mcpAutoSave') return true;
        return defaultValue;
      }
    }, {
      indexBackend: 'sqlite',
      indexDataDir: path.join(tmp, 'semantic-failing-userData', 'index'),
      smartIndexDelayMs: 60000
    });
    failingQueueEngine.recordSavedDocument({ filePath: failingQueuePath, content: '# Failing\n\nsemantic enqueue failure' });
    failingQueueEngine.queueKnownDocumentIndex = () => ({ queued: false, reason: 'forced-enqueue-failure' });
    const failedSemanticReindex = failingQueueEngine.queueSemanticReindexForActiveDocuments({
      requestedBy: 'test.semantic.enqueue-failure'
    });
    wave2Assert(
      failedSemanticReindex.reason === 'semantic-reindex-enqueue-failed' &&
        failedSemanticReindex.failures &&
        failedSemanticReindex.failures[0] &&
        failedSemanticReindex.failures[0].reason === 'forced-enqueue-failure',
      'embedding registration reports hard semantic reindex enqueue failures before provider settings are persisted'
    );
    failingQueueEngine.close();
    const partialQueueDocs = path.join(tmp, 'semantic-partial-docs');
    fs.mkdirSync(partialQueueDocs, { recursive: true });
    const partialQueueFirstPath = path.join(partialQueueDocs, 'first.md');
    const partialQueueSecondPath = path.join(partialQueueDocs, 'second.md');
    fs.writeFileSync(partialQueueFirstPath, '# First\n\nsemantic partial success', 'utf-8');
    fs.writeFileSync(partialQueueSecondPath, '# Second\n\nsemantic partial failure', 'utf-8');
    const partialQueueEngine = new SearchEngine({
      get(key, defaultValue) {
        if (key === 'mcpAutoSavePath') return partialQueueDocs;
        if (key === 'mcpAutoSave') return true;
        return defaultValue;
      }
    }, {
      indexBackend: 'sqlite',
      indexDataDir: path.join(tmp, 'semantic-partial-userData', 'index'),
      smartIndexDelayMs: 60000
    });
    partialQueueEngine.recordSavedDocument({ filePath: partialQueueFirstPath, content: '# First\n\nsemantic partial success' });
    partialQueueEngine.recordSavedDocument({ filePath: partialQueueSecondPath, content: '# Second\n\nsemantic partial failure' });
    const originalPartialQueueDocumentIndex = partialQueueEngine.queueKnownDocumentIndex.bind(partialQueueEngine);
    let partialQueueCalls = 0;
    partialQueueEngine.queueKnownDocumentIndex = (input) => {
      partialQueueCalls += 1;
      if (partialQueueCalls === 1) return originalPartialQueueDocumentIndex(input);
      return { queued: false, reason: 'forced-second-enqueue-failure' };
    };
    const partialSemanticReindex = partialQueueEngine.queueSemanticReindexForActiveDocuments({
      requestedBy: 'test.semantic.partial-failure'
    });
    const partialQueuedJobs = partialQueueEngine._getSourceLedger()
      .getIndexJobs({ status: 'queued' })
      .filter((job) => job.requestedBy === 'test.semantic.partial-failure');
    wave2Assert(
      partialSemanticReindex.reason === 'semantic-reindex-enqueue-failed' &&
        partialSemanticReindex.rolledBack === 1 &&
        partialQueuedJobs.length === 0 &&
        partialQueueEngine._smartIndexQueue.size === 0,
      'embedding registration rolls back semantic jobs that were queued before a later enqueue failure'
    );
    partialQueueEngine.close();
    const unconfiguredSourceEngine = new SearchEngine({
      get(key, defaultValue) {
        if (key === 'mcpAutoSavePath') return '';
        if (key === 'mcpAutoSave') return false;
        return defaultValue;
      }
    }, {
      indexBackend: 'sqlite',
      indexDataDir: path.join(tmp, 'unconfigured-source-userData', 'index'),
      smartIndexDelayMs: 60000
    });
    const skippedSemanticReindex = unconfiguredSourceEngine.queueSemanticReindexForActiveDocuments({
      requestedBy: 'test.semantic.unconfigured-source'
    });
    wave2Assert(
      skippedSemanticReindex.skipped === true &&
        skippedSemanticReindex.reason === 'source-root-unconfigured' &&
        skippedSemanticReindex.queued === 0,
      'embedding registration skips semantic reindex without failing when the document store source root is not configured'
    );
    unconfiguredSourceEngine.close();

    const staleRootA = path.join(tmp, 'semantic-stale-root-a');
    const staleRootB = path.join(tmp, 'semantic-stale-root-b');
    fs.mkdirSync(staleRootA, { recursive: true });
    fs.mkdirSync(staleRootB, { recursive: true });
    let currentSemanticRoot = staleRootA;
    const staleOldPath = path.join(staleRootA, 'old.md');
    const staleNewPath = path.join(staleRootB, 'new.md');
    fs.writeFileSync(staleOldPath, '# Old\n\nold source root', 'utf-8');
    fs.writeFileSync(staleNewPath, '# New\n\nnew source root', 'utf-8');
    const staleRootEngine = new SearchEngine({
      get(key, defaultValue) {
        if (key === 'mcpAutoSavePath') return currentSemanticRoot;
        if (key === 'mcpAutoSave') return true;
        return defaultValue;
      }
    }, {
      indexBackend: 'sqlite',
      indexDataDir: path.join(tmp, 'semantic-stale-root-userData', 'index'),
      smartIndexDelayMs: 60000
    });
    staleRootEngine.recordSavedDocument({ filePath: staleOldPath, content: '# Old\n\nold source root' });
    currentSemanticRoot = staleRootB;
    staleRootEngine.resetForSourceRootChange();
    const staleRootSemanticReindex = staleRootEngine.queueSemanticReindexForActiveDocuments({
      requestedBy: 'test.semantic.stale-root'
    });
    wave2Assert(
      staleRootSemanticReindex.queued >= 1 &&
        staleRootSemanticReindex.jobs.some((job) => job.sourceRelativePath === 'new.md'),
      'embedding registration scans the current document store root when stale active ledger rows belong to a previous root'
    );
    staleRootEngine.close();

    const resumeContent = '# Resume\n\nstartup resume content';
    const resumePath = path.join(engineDocs, 'resume.md');
    fs.writeFileSync(resumePath, resumeContent, 'utf-8');
    const resumeDoc = engine.recordSavedDocument({ filePath: resumePath, content: resumeContent });
    const resumeJob = engineLedger.enqueueIndexJob({
      jobId: 'job_startup_resume_fixture',
      sourceId: resumeDoc.sourceId,
      documentId: resumeDoc.documentId,
      status: 'queued',
      requestedBy: 'test.startup.resume',
      currentPathInternal: resumePath,
      contentHash: `sha256:${sha256(resumeContent)}`
    });

    const mismatchContent = '# Mismatch\n\ncurrent content';
    const mismatchPath = path.join(engineDocs, 'mismatch.md');
    fs.writeFileSync(mismatchPath, mismatchContent, 'utf-8');
    const mismatchDoc = engine.recordSavedDocument({ filePath: mismatchPath, content: mismatchContent });
    engineLedger.enqueueIndexJob({
      jobId: 'job_startup_hash_mismatch_fixture',
      sourceId: mismatchDoc.sourceId,
      documentId: mismatchDoc.documentId,
      status: 'indexing',
      requestedBy: 'test.startup.mismatch',
      currentPathInternal: mismatchPath,
      contentHash: `sha256:${sha256('old content')}`
    });

    const cancelContent = '# Cancel\n\ncancel requested content';
    const cancelPath = path.join(engineDocs, 'cancel.md');
    fs.writeFileSync(cancelPath, cancelContent, 'utf-8');
    const cancelDoc = engine.recordSavedDocument({ filePath: cancelPath, content: cancelContent });
    engineLedger.enqueueIndexJob({
      jobId: 'job_startup_cancel_fixture',
      sourceId: cancelDoc.sourceId,
      documentId: cancelDoc.documentId,
      status: 'queued',
      requestedBy: 'test.startup.cancel',
      currentPathInternal: cancelPath,
      contentHash: `sha256:${sha256(cancelContent)}`,
      cancelRequested: true
    });

    const missingContent = '# Missing\n\nmissing source content';
    const missingPath = path.join(engineDocs, 'missing-startup.md');
    fs.writeFileSync(missingPath, missingContent, 'utf-8');
    const missingDoc = engine.recordSavedDocument({ filePath: missingPath, content: missingContent });
    fs.unlinkSync(missingPath);
    engineLedger.enqueueIndexJob({
      jobId: 'job_startup_missing_fixture',
      sourceId: missingDoc.sourceId,
      documentId: missingDoc.documentId,
      status: 'queued',
      requestedBy: 'test.startup.missing',
      currentPathInternal: missingPath,
      contentHash: `sha256:${sha256(missingContent)}`
    });

    engineLedger.enqueueIndexJob({
      jobId: 'job_startup_outside_fixture',
      sourceId: resumeDoc.sourceId,
      documentId: resumeDoc.documentId,
      status: 'queued',
      requestedBy: 'test.startup.outside',
      currentPathInternal: path.join(tmp, 'outside-startup.md'),
      contentHash: `sha256:${sha256('outside')}`
    });

    const freshHeartbeatContent = '# Fresh heartbeat\n\nstill active elsewhere';
    const freshHeartbeatPath = path.join(engineDocs, 'fresh-heartbeat.md');
    fs.writeFileSync(freshHeartbeatPath, freshHeartbeatContent, 'utf-8');
    const freshHeartbeatDoc = engine.recordSavedDocument({ filePath: freshHeartbeatPath, content: freshHeartbeatContent });
    engineLedger.enqueueIndexJob({
      jobId: 'job_startup_fresh_heartbeat_fixture',
      sourceId: freshHeartbeatDoc.sourceId,
      documentId: freshHeartbeatDoc.documentId,
      status: 'indexing',
      requestedBy: 'test.startup.fresh-heartbeat',
      currentPathInternal: freshHeartbeatPath,
      contentHash: `sha256:${sha256(freshHeartbeatContent)}`
    });

    wave2Assert(typeof engine.reconcileStartupIndexJobs === 'function', 'SearchEngine exposes startup index job reconciliation');
    const startupReconcile = engine.reconcileStartupIndexJobs({ activeHeartbeatMs: 60000 });
    wave2Assert(startupReconcile.resumed >= 1, 'startup reconciliation resumes same-content queued/indexing jobs');
    wave2Assert(startupReconcile.failed >= 3, 'startup reconciliation marks content hash, missing-file, and path-policy cases retryable failed');
    wave2Assert(startupReconcile.cancelled >= 2, 'startup reconciliation honours cancel_requested and fresh-heartbeat jobs');
    await engine._drainSmartIndexQueue();
    const startupJobs = engineLedger.getIndexJobs({});
    wave2Assert(
      startupJobs.some((job) => job.jobId === resumeJob.jobId && job.status === 'completed'),
      'resumed startup job completes through the common indexing service'
    );
    const mismatchJob = startupJobs.find((job) => job.jobId === 'job_startup_hash_mismatch_fixture');
    wave2Assert(
      mismatchJob && mismatchJob.status === 'failed' && mismatchJob.diagnosticCode === 'content_hash_changed',
      'content hash mismatch becomes retryable failed startup reconciliation diagnostic'
    );
    const cancelledJob = startupJobs.find((job) => job.jobId === 'job_startup_cancel_fixture');
    wave2Assert(
      cancelledJob && cancelledJob.status === 'cancelled' && cancelledJob.diagnosticCode === 'cancel_requested',
      'cancel requested startup job becomes cancelled during reconciliation'
    );
    const missingJob = startupJobs.find((job) => job.jobId === 'job_startup_missing_fixture');
    wave2Assert(
      missingJob && missingJob.status === 'failed' && missingJob.diagnosticCode === 'source_missing',
      'missing source startup job becomes retryable failed during reconciliation'
    );
    const outsideJob = startupJobs.find((job) => job.jobId === 'job_startup_outside_fixture');
    wave2Assert(
      outsideJob && outsideJob.status === 'failed' && outsideJob.diagnosticCode === 'path_policy_violation',
      'outside-root startup job becomes path policy failed during reconciliation'
    );
    const freshHeartbeatJob = startupJobs.find((job) => job.jobId === 'job_startup_fresh_heartbeat_fixture');
    wave2Assert(
      freshHeartbeatJob && freshHeartbeatJob.status === 'cancelled' && freshHeartbeatJob.diagnosticCode === 'active_heartbeat_at_startup',
      'fresh heartbeat startup job becomes cancelled during reconciliation'
    );
    fs.writeFileSync(path.join(engineDocs, 'compact.md'), '# Compact\n\nworker compact evidence', 'utf-8');
    await engine.rebuild();
    const compactController = engine.getIndexingWorkerController();
    const compactScheduled = await engine.compact();
    wave2Assert(
      compactController && compactScheduled.scheduled === true && compactScheduled.compacted === false && compactController.isActive(),
      'SearchEngine compact schedules SQLite VACUUM in the worker off the request path'
    );
    const compactResult = await engine._compactInFlight;
    wave2Assert(
      compactResult && compactResult.result && compactResult.result.compacted === true && compactResult.result.backupManifest,
      'scheduled worker compact task eventually performs SQLite VACUUM with backup evidence'
    );
    engine.close();

    const legacyDocs = path.join(tmp, 'legacy-docs');
    const legacyIndexDir = path.join(tmp, 'legacy-userData', 'index');
    fs.mkdirSync(legacyDocs, { recursive: true });
    fs.writeFileSync(path.join(legacyDocs, 'legacy.md'), '# Legacy\n\n기존 저장 문서', 'utf-8');
    const legacyEngine = new SearchEngine({
      get(key, defaultValue) {
        if (key === 'mcpAutoSavePath') return legacyDocs;
        if (key === 'mcpAutoSave') return true;
        return defaultValue;
      }
    }, {
      indexBackend: 'sqlite',
      indexDataDir: legacyIndexDir
    });
    await legacyEngine.rebuild();
    const legacySemanticReindex = legacyEngine.queueSemanticReindexForActiveDocuments({ requestedBy: 'test.semantic.legacy' });
    wave2Assert(legacySemanticReindex.queued >= 1, 'embedding registration enqueues existing knowledge-store Markdown after keyword rebuild');
    legacyEngine.close();

    const incompatibleDbPath = path.join(tmp, 'incompatible.sqlite3');
    const incompatibleDb = new Database(incompatibleDbPath);
    incompatibleDb.exec(`
      CREATE TABLE source_ledger_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO source_ledger_meta(key, value) VALUES ('schema_version', '999');
    `);
    incompatibleDb.close();
    const incompatibleLedger = ledgerFactory({ dbPath: incompatibleDbPath, userDataDir: path.join(tmp, 'userData') });
    let incompatibleRejected = false;
    try {
      await incompatibleLedger.initialize();
    } catch (err) {
      incompatibleRejected = err.code === 'SOURCE_LEDGER_SCHEMA_VERSION_UNSUPPORTED';
    }
    wave2Assert(incompatibleRejected, 'incompatible schema version is rejected before migration');
    wave2Assert(!incompatibleLedger.db, 'incompatible schema rejection closes the SQLite handle');

    if (typeof ledger.close === 'function') ledger.close();
  } finally {
    await removeTreeWithRetry(tmp);
  }

  console.log('test-wave2-ledger-contract: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
