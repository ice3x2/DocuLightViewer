'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SearchEngine } = require('../src/main/search-engine');

function wave2Assert(condition, message) {
  assert(condition, `Wave 2 smart_search contract: ${message}`);
}

function createStore(docsDir) {
  return {
    get(key, defaultValue) {
      if (key === 'mcpAutoSave') return true;
      if (key === 'mcpAutoSavePath') return docsDir;
      return defaultValue;
    }
  };
}

function writeDoc(dir, name, frontmatter, body) {
  const filePath = path.join(dir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${frontmatter}\n${body}`, 'utf-8');
  return filePath;
}

class FakeHierarchicalNSW {
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

  searchKnn(vector, limit) {
    const scored = this.points
      .map((point) => ({
        label: point.label,
        distance: 1 - cosineSimilarity(vector, point.vector)
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
    return {
      neighbors: scored.map((item) => item.label),
      distances: scored.map((item) => item.distance)
    };
  }

  writeIndexSync(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ points: this.points, dimensions: this.dimensions }), 'utf-8');
  }

  readIndexSync(filePath) {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    this.points = payload.points || [];
  }
}

class ThrowingReadHierarchicalNSW extends FakeHierarchicalNSW {
  readIndexSync() {
    throw new Error('simulated committed hnsw read failure');
  }
}

class ThrowingFreshBuildHierarchicalNSW extends FakeHierarchicalNSW {
  initIndex() {
    throw new Error('query-time HNSW build attempted');
  }

  addPoint() {
    throw new Error('query-time HNSW point population attempted');
  }
}

function cosineSimilarity(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i] * right[i];
    leftNorm += left[i] * left[i];
    rightNorm += right[i] * right[i];
  }
  if (leftNorm <= 0 || rightNorm <= 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

async function removeTreeWithRetry(targetPath) {
  let lastError = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      return;
    } catch (err) {
      lastError = err;
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(err && err.code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-wave2-smart-search-'));
  let engine = null;
  try {
    const docsDir = path.join(tmp, 'docs');
    const indexDataDir = path.join(tmp, 'userData', 'index');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.mkdirSync(indexDataDir, { recursive: true });

    const targetPath = writeDoc(docsDir, 'target.md', '---\nproject: Alpha\ndocType: guide\ncategory: api\n---', '# Target\n\ntarget landing shared term');
    const alphaPath = writeDoc(docsDir, 'alpha.md', '---\nproject: Alpha\ndocType: guide\ncategory: api\ndocumentTags:\n  - wave2\n---', '# Alpha\n\nshared term resolved target 한국어검색\n\n[Target](./target.md)');
    const betaPath = writeDoc(docsDir, 'beta.md', '---\nproject: Alpha\ndocType: guide\ncategory: api\ndocumentTags:\n  - wave2\n---', '# Beta\n\nshared term same score');
    const brokenPath = writeDoc(docsDir, 'broken.md', '---\nproject: Alpha\ndocType: guide\n---', '# Broken\n\nmissing diagnostic text\n\n[missing](./Missing.md)\n');
    const lateLinkedPath = writeDoc(docsDir, 'zz-linked.md', '---\nproject: Alpha\ndocType: guide\ncategory: api\n---', '# ZZ Linked\n\nshared term late linked candidate\n\n[Target](./target.md)');
    const rareTaggedPath = writeDoc(docsDir, 'zz-rare.md', '---\nproject: Alpha\ndocType: guide\ncategory: api\ndocumentTags:\n  - rare\n---', '# ZZ Rare\n\nshared term rare tagged candidate');
    const semanticOnlyPath = writeDoc(docsDir, 'semantic-only.md', '---\nproject: Alpha\ndocType: guide\ncategory: api\n---', '# Semantic Only\n\nnearest neighbor concept without the literal query tokens');
    const semanticFarPath = writeDoc(docsDir, 'semantic-far.md', '---\nproject: Alpha\ndocType: guide\ncategory: api\n---', '# Semantic Far\n\nremote vector neighbor without the literal query tokens');
    const semanticOtherProjectPath = writeDoc(docsDir, 'semantic-other-project.md', '---\nproject: Beta\ndocType: note\ncategory: api\n---', '# Semantic Other Project\n\nout of scope semantic neighbor without the literal query tokens');
    writeDoc(docsDir, 'foo_rare.md', '---\nproject: Alpha\ndocType: guide\ncategory: api\n---', '# Foo Rare\n\nwildcard term exact underscore prefix');
    for (let i = 0; i < 205; i += 1) {
      writeDoc(docsDir, `filler-${String(i).padStart(3, '0')}.md`, '---\nproject: Alpha\ndocType: guide\ncategory: api\n---', `# Filler ${i}\n\nshared term filler candidate ${i}`);
      writeDoc(docsDir, `fooX-${String(i).padStart(3, '0')}.md`, '---\nproject: Alpha\ndocType: guide\ncategory: api\n---', `# Foo X ${i}\n\nwildcard term overmatch candidate ${i}`);
    }

    engine = new SearchEngine(createStore(docsDir), {
      indexBackend: 'sqlite',
      indexDataDir,
      disableIndexingWorkerController: true,
      semanticSearch: {
        enabled: true,
        provider: 'openai-compatible',
        model: 'fixture-embedding-model',
        modelFingerprint: 'fixture-smart-fingerprint',
        dimensions: 3
      },
      HierarchicalNSW: FakeHierarchicalNSW,
      embeddingProvider: {
        async embed({ inputs, model, purpose }) {
          wave2Assert(model === 'fixture-embedding-model', 'built-in semantic provider uses configured embedding model');
          return inputs.map((text) => {
            const normalized = String(text || '').toLowerCase();
            if (purpose === 'query') return [1, 0, 0];
            if (normalized.includes('nearest neighbor concept')) return [1, 0, 0];
            if (normalized.includes('fresh semantic project-only')) return [1, 0, 0];
            if (normalized.includes('remote vector neighbor')) return [0.6, 0.4, 0];
            return [0, 1, 0];
          });
        }
      }
    });

    wave2Assert(typeof engine.smartSearch === 'function', 'SearchEngine exposes smartSearch() for read-only hybrid retrieval');
    wave2Assert(typeof engine.getSmartSearchDocumentIdentity === 'function', 'SearchEngine exposes document identity lookup for smart_search link filters');
    await engine.rebuild();
    for (const filePath of [targetPath, alphaPath, betaPath, brokenPath, lateLinkedPath, semanticOnlyPath, semanticFarPath, semanticOtherProjectPath]) {
      const queued = engine.queueDocumentIndex({
        filePath,
        content: fs.readFileSync(filePath, 'utf-8'),
        requestedBy: 'test.smart_search'
      });
      wave2Assert(queued.queued, `smart indexing queue accepts ${path.basename(filePath)}`);
    }
    await engine._drainSmartIndexQueue();

    const targetIdentity = engine.getSmartSearchDocumentIdentity(targetPath);
    const alphaIdentity = engine.getSmartSearchDocumentIdentity(alphaPath);
    const betaIdentity = engine.getSmartSearchDocumentIdentity(betaPath);
    const lateLinkedIdentity = engine.getSmartSearchDocumentIdentity(lateLinkedPath);
    const semanticOnlyIdentity = engine.getSmartSearchDocumentIdentity(semanticOnlyPath);
    const semanticFarIdentity = engine.getSmartSearchDocumentIdentity(semanticFarPath);
    const semanticOtherProjectIdentity = engine.getSmartSearchDocumentIdentity(semanticOtherProjectPath);
    wave2Assert(targetIdentity && targetIdentity.documentId, 'target document receives a stable smart_search documentId');
    wave2Assert(alphaIdentity && alphaIdentity.documentId, 'alpha document receives a stable smart_search documentId');
    wave2Assert(betaIdentity && betaIdentity.documentId, 'beta document receives a stable smart_search documentId');
    wave2Assert(lateLinkedIdentity && lateLinkedIdentity.documentId, 'late linked document receives a stable smart_search documentId');
    wave2Assert(semanticOnlyIdentity && semanticOnlyIdentity.documentId, 'semantic-only document receives a stable smart_search documentId');
    wave2Assert(semanticFarIdentity && semanticFarIdentity.documentId, 'semantic distance fixture receives a stable smart_search documentId');
    wave2Assert(semanticOtherProjectIdentity && semanticOtherProjectIdentity.documentId, 'out-of-scope semantic fixture receives a stable smart_search documentId');

    const defaultResult = await engine.smartSearch({ query: 'shared term' });
    wave2Assert(defaultResult.schemaVersion === 'smart_search.v1', 'response uses smart_search.v1 envelope');
    wave2Assert(defaultResult.mode && defaultResult.mode.requested === 'auto', 'default requested mode is auto');
    wave2Assert(defaultResult.results.length <= 20, 'default limit returns at most 20 results');
    wave2Assert(Array.isArray(defaultResult.degradationReasons), 'degradationReasons is always an array');
    wave2Assert(Object.prototype.hasOwnProperty.call(defaultResult, 'indexFreshness'), 'response includes indexFreshness');
    wave2Assert(Object.prototype.hasOwnProperty.call(defaultResult, 'staleFilteredCount'), 'response includes staleFilteredCount');

    const builtInSemanticResult = await engine.smartSearch({ query: 'semantic concept', mode: 'hybrid', includeScores: true, includeTrace: true });
    wave2Assert(builtInSemanticResult.mode.used === 'hybrid', 'built-in semantic index switches smart_search to hybrid mode without an injected provider');
    const builtInSemanticHit = builtInSemanticResult.results.find((item) => item.documentId === semanticOnlyIdentity.documentId);
    wave2Assert(builtInSemanticHit, 'built-in semantic index returns a semantic-only document without keyword overlap');
    wave2Assert(builtInSemanticHit.scoreDetails.semantic > 0.9, 'built-in semantic hit contributes a high semantic score');
    wave2Assert(builtInSemanticResult.trace.items[0].semanticCandidateCount >= 1, 'built-in semantic trace reports semantic candidate count');
    wave2Assert(builtInSemanticResult.trace.items[0].provider === 'hnsw-persisted', 'built-in semantic retrieval uses committed HNSW artifact when available');

    const freshSemanticPath = writeDoc(docsDir, 'fresh-semantic.md', '---\nproject: Alpha\ndocType: guide\ncategory: api\n---', '# Fresh Semantic\n\nfresh semantic project-only content without keyword rebuild');
    const freshQueued = engine.queueDocumentIndex({
      filePath: freshSemanticPath,
      content: fs.readFileSync(freshSemanticPath, 'utf-8'),
      requestedBy: 'test.fresh.semantic'
    });
    wave2Assert(freshQueued.queued, 'fresh post-save semantic document is queued without keyword rebuild');
    await engine._drainSmartIndexQueue();
    const freshIdentity = engine.getSmartSearchDocumentIdentity(freshSemanticPath);
    const freshProjectFiltered = await engine.smartSearch({
      query: 'fresh semantic concept',
      mode: 'hybrid',
      filters: { project: 'Alpha' },
      includeScores: true
    });
    wave2Assert(
      freshProjectFiltered.results.some((item) => item.documentId === freshIdentity.documentId),
      'fresh post-save semantic candidates satisfy project hard filters before keyword rebuild'
    );
    const semanticLedger = engine._getAvailableSourceLedger();
    const freshAnn = semanticLedger.getCommittedAnnIndex({ modelFingerprint: 'fixture-smart-fingerprint' });
    const freshTombstone = semanticLedger.setAnnMembershipTombstonesForDocument({
      documentId: freshIdentity.documentId,
      tombstoned: true
    });
    wave2Assert(freshAnn && freshTombstone.count >= 1, 'semantic tombstone fixture marks persisted ANN memberships');
    const tombstonedSemanticResult = await engine.smartSearch({
      query: 'fresh semantic concept',
      mode: 'hybrid',
      filters: { project: 'Alpha' }
    });
    wave2Assert(
      tombstonedSemanticResult.results.every((item) => item.documentId !== freshIdentity.documentId),
      'smart_search excludes tombstoned semantic memberships by default'
    );

    engine.options.forceHnswUnavailable = true;
    const hnswFallbackResult = await engine.smartSearch({
      query: 'semantic concept',
      mode: 'hybrid',
      includeDiagnostics: true
    });
    engine.options.forceHnswUnavailable = false;
    wave2Assert(hnswFallbackResult.mode.used === 'hybrid', 'HNSW unavailable can fall back to stored vector semantic retrieval');
    wave2Assert(hnswFallbackResult.degraded === true, 'HNSW unavailable fallback is still reported as degraded');
    wave2Assert(
      hnswFallbackResult.degradationReasons.includes('native_unavailable'),
      'HNSW unavailable fallback includes native_unavailable degradation reason'
    );

    const missingAnn = semanticLedger.getCommittedAnnIndex({ modelFingerprint: 'fixture-smart-fingerprint' });
    const hiddenAnnPath = `${missingAnn.indexPathInternal}.query-time-hidden`;
    fs.renameSync(missingAnn.indexPathInternal, hiddenAnnPath);
    engine.options.HierarchicalNSW = ThrowingFreshBuildHierarchicalNSW;
    try {
      const requestPathFallback = await engine.getSmartSearchSemanticCandidates('semantic concept', { limit: 20 });
      wave2Assert(
        requestPathFallback.status === 'ready' && requestPathFallback.backend === 'sqlite-vector',
        'missing committed HNSW falls back to SQLite vectors instead of fresh query-time HNSW build'
      );
      wave2Assert(
        requestPathFallback.candidates.some((item) => item.documentId === semanticOnlyIdentity.documentId),
        'SQLite vector fallback preserves semantic request-path candidates when committed HNSW is missing'
      );
    } finally {
      engine.options.HierarchicalNSW = FakeHierarchicalNSW;
      fs.renameSync(hiddenAnnPath, missingAnn.indexPathInternal);
    }

    const checksumLedger = engine._getAvailableSourceLedger();
    const checksumAnn = checksumLedger.getCommittedAnnIndex({ modelFingerprint: 'fixture-smart-fingerprint' });
    const originalAnnBytes = fs.readFileSync(checksumAnn.indexPathInternal);
    fs.writeFileSync(checksumAnn.indexPathInternal, Buffer.from('readable but wrong checksum'));
    const checksumMismatchResult = await engine.smartSearch({
      query: 'semantic concept',
      mode: 'hybrid',
      includeDiagnostics: true
    });
    fs.writeFileSync(checksumAnn.indexPathInternal, originalAnnBytes);
    wave2Assert(
      checksumMismatchResult.degradationReasons.includes('hnsw_checksum_mismatch'),
      'committed HNSW checksum mismatch is detected before persisted index load'
    );

    engine.options.HierarchicalNSW = ThrowingReadHierarchicalNSW;
    const corruptCommittedHnswResult = await engine.smartSearch({
      query: 'semantic concept',
      mode: 'hybrid',
      includeDiagnostics: true
    });
    engine.options.HierarchicalNSW = FakeHierarchicalNSW;
    wave2Assert(corruptCommittedHnswResult.mode.used === 'hybrid', 'corrupt committed HNSW artifact falls back to semantic vector retrieval');
    wave2Assert(corruptCommittedHnswResult.degraded === true, 'corrupt committed HNSW fallback is reported as degraded');
    wave2Assert(
      corruptCommittedHnswResult.degradationReasons.includes('hnsw_read_failed'),
      'corrupt committed HNSW fallback includes hnsw_read_failed degradation reason'
    );

    const originalSearch = engine.search.bind(engine);
    let observedKeywordCandidateLimit = 0;
    engine.search = (query, options = {}) => {
      observedKeywordCandidateLimit = Number(options.limit) || 0;
      return originalSearch(query, options);
    };
    await engine.smartSearch({ query: 'shared term', mode: 'keyword', limit: 20 });
    engine.search = originalSearch;
    wave2Assert(observedKeywordCandidateLimit > 20, 'keyword retrieval uses an internal candidate cap larger than the output limit');

    engine.options.semanticCandidateProvider = {
      search({ query, limit }) {
        wave2Assert(query === 'shared term', 'semantic provider receives the smart_search query');
        wave2Assert(limit > 20, 'semantic provider receives an internal candidate cap larger than the output limit');
        return {
          status: 'ready',
          backend: 'hnsw',
          candidates: [{
            filePath: semanticOnlyPath,
            score: 0.98,
            title: 'Semantic Only',
            snippet: 'nearest neighbor semantic candidate'
          }]
        };
      }
    };
    const hybridResult = await engine.smartSearch({ query: 'shared term', mode: 'hybrid', includeScores: true, includeTrace: true });
    wave2Assert(hybridResult.mode.used === 'hybrid', 'available semantic candidates switch smart_search to hybrid mode');
    wave2Assert(hybridResult.degraded === false, 'available semantic candidates are not keyword-only degraded');
    wave2Assert(hybridResult.trace.items[0].semanticCandidateCount === 1, 'trace reports semantic candidate pool size');
    const semanticHit = hybridResult.results.find((item) => item.documentId === semanticOnlyIdentity.documentId);
    wave2Assert(semanticHit, 'semantic-only HNSW candidate is merged into smart_search results even without keyword match');
    wave2Assert(semanticHit.scoreDetails.semantic > 0, 'semantic candidate contributes a normalized semantic score');
    wave2Assert(semanticHit.scoreDetails.keyword === 0, 'semantic-only candidate can have no keyword score');
    engine.options.semanticCandidateProvider = null;

    engine.options.semanticCandidateProvider = {
      search() {
        return {
          status: 'ready',
          backend: 'hnsw',
          candidates: [{
            filePath: semanticOtherProjectPath,
            score: 0.99,
            title: 'Semantic Other Project',
            snippet: 'out of project semantic candidate'
          }, {
            filePath: semanticOnlyPath,
            score: 0.60,
            title: 'Semantic Only',
            snippet: 'in project semantic candidate'
          }]
        };
      }
    };
    const filteredHybridResult = await engine.smartSearch({
      query: 'semantic scope',
      mode: 'hybrid',
      filters: { project: 'Alpha', docType: 'guide' },
      includeScores: true
    });
    wave2Assert(
      filteredHybridResult.results.some((item) => item.documentId === semanticOnlyIdentity.documentId),
      'semantic candidates inside project/docType hard filters remain eligible'
    );
    wave2Assert(
      !filteredHybridResult.results.some((item) => item.documentId === semanticOtherProjectIdentity.documentId),
      'semantic candidates outside project/docType hard filters are excluded after provider collection'
    );
    engine.options.semanticCandidateProvider = null;

    engine.options.semanticCandidateProvider = {
      search() {
        return {
          status: 'ready',
          backend: 'hnsw',
          candidates: [{
            sourceRelativePath: 'semantic-only.md',
            score: 0.91,
            title: 'Semantic Only',
            snippet: 'source-relative semantic candidate'
          }, {
            documentId: semanticFarIdentity.documentId,
            score: 0.90,
            title: 'Semantic Far',
            snippet: 'document-id semantic candidate'
          }]
        };
      }
    };
    const identityOnlyHybridResult = await engine.smartSearch({
      query: 'semantic identity',
      mode: 'hybrid',
      filters: { project: 'Alpha', docType: 'guide' },
      includeScores: true
    });
    wave2Assert(
      identityOnlyHybridResult.results.some((item) => item.documentId === semanticOnlyIdentity.documentId),
      'source-relative semantic candidates can recover identity and metadata for hard filters'
    );
    wave2Assert(
      identityOnlyHybridResult.results.some((item) => item.documentId === semanticFarIdentity.documentId),
      'documentId-only semantic candidates can recover source path and metadata for hard filters'
    );
    engine.options.semanticCandidateProvider = null;

    engine.options.semanticCandidateProvider = {
      search() {
        return {
          status: 'ready',
          backend: 'hnsw',
          candidates: [{
            filePath: semanticFarPath,
            distance: 8,
            title: 'Semantic Far',
            snippet: 'far vector distance'
          }, {
            filePath: semanticOnlyPath,
            distance: 0.1,
            title: 'Semantic Only',
            snippet: 'near vector distance'
          }]
        };
      }
    };
    const distanceHybridResult = await engine.smartSearch({ query: 'vector distance', mode: 'hybrid', includeScores: true });
    const semanticOnlyDistanceHit = distanceHybridResult.results.find((item) => item.documentId === semanticOnlyIdentity.documentId);
    const semanticFarDistanceHit = distanceHybridResult.results.find((item) => item.documentId === semanticFarIdentity.documentId);
    wave2Assert(semanticOnlyDistanceHit && semanticFarDistanceHit, 'distance-only HNSW candidates are merged into hybrid results');
    wave2Assert(
      semanticOnlyDistanceHit.scoreDetails.semantic > semanticFarDistanceHit.scoreDetails.semantic,
      'lower HNSW distance normalizes to a higher semantic score'
    );
    wave2Assert(
      distanceHybridResult.results.findIndex((item) => item.documentId === semanticOnlyIdentity.documentId) <
        distanceHybridResult.results.findIndex((item) => item.documentId === semanticFarIdentity.documentId),
      'lower HNSW distance ranks above a larger distance when keyword scores are equal'
    );
    engine.options.semanticCandidateProvider = null;

    const invalidMode = await engine.smartSearch({ query: 'shared term', mode: 'semantic' });
    wave2Assert(invalidMode.error && invalidMode.error.code === 'validation_failed', 'invalid smart_search.mode is rejected by the shared runtime validator');
    wave2Assert(invalidMode.error.field === 'mode', 'invalid mode error identifies the safe field');
    wave2Assert(Array.isArray(invalidMode.error.expected) && invalidMode.error.expected.join('|') === 'auto|keyword|hybrid', 'invalid mode error points to the accepted mode enum');
    wave2Assert(!JSON.stringify(invalidMode).includes('semantic'), 'invalid mode response does not echo the unsafe raw mode value');

    const unsafePathPrefixes = [
      'C:\\Users\\Example\\secret.md',
      '\\\\server\\share\\secret.md',
      '/etc/passwd',
      '~/private.md',
      '../outside.md',
      'folder/../../outside.md',
      'https://user:token@example.test/doc.md',
      'https%3A%2F%2Fuser%3Atoken%40example.test%2Fdoc.md',
      'docs?api_key=secret'
    ];
    for (const unsafePrefix of unsafePathPrefixes) {
      const invalidPathPrefix = await engine.smartSearch({
        query: 'shared term',
        filters: { pathPrefix: unsafePrefix },
        includeDiagnostics: true
      });
      const serializedInvalidPathPrefix = JSON.stringify(invalidPathPrefix);
      wave2Assert(
        invalidPathPrefix.error && invalidPathPrefix.error.field === 'filters.pathPrefix',
        `unsafe pathPrefix ${unsafePrefix} is rejected with a field-specific validation error`
      );
      wave2Assert(invalidPathPrefix.error.code === 'validation_failed', 'unsafe pathPrefix uses canonical validation_failed code');
      wave2Assert(invalidPathPrefix.results.length === 0, 'unsafe pathPrefix returns no results');
      wave2Assert(!serializedInvalidPathPrefix.includes(unsafePrefix), 'unsafe pathPrefix response does not echo the raw input');
      wave2Assert(!serializedInvalidPathPrefix.includes(tmp), 'unsafe pathPrefix validation error does not leak temp/userData paths');
    }

    const expandedResult = await engine.smartSearch({ query: 'shared term', limit: 50, includeScores: true });
    wave2Assert(expandedResult.results.length <= 50, 'explicit limit hard maximum is 50');
    wave2Assert(
      expandedResult.results.every((item, index) => item.rank === index + 1),
      'results have deterministic rank fields'
    );

    const repeated = await engine.smartSearch({ query: 'shared term', limit: 20, includeScores: true });
    wave2Assert(
      JSON.stringify(expandedResult.results.slice(0, repeated.results.length).map((item) => item.documentId || item.sourceRelativePath)) ===
        JSON.stringify(repeated.results.map((item) => item.documentId || item.sourceRelativePath)),
      'same-score candidates use stable deterministic tie breakers'
    );

    const linkedToTarget = await engine.smartSearch({
      query: 'shared term',
      linkedTo: targetIdentity.documentId,
      includeScores: true,
      includeDiagnostics: true
    });
    wave2Assert(linkedToTarget.results.length >= 2, 'linkedTo filter returns documents with a resolved edge to the target document');
    wave2Assert(
      linkedToTarget.results.some((item) => item.documentId === alphaIdentity.documentId),
      'linkedTo filter includes the direct resolved alpha edge'
    );
    wave2Assert(
      !linkedToTarget.results.some((item) => item.documentId === betaIdentity.documentId),
      'linkedTo filter excludes same-keyword documents without a resolved edge'
    );
    wave2Assert(
      linkedToTarget.results[0].scoreDetails && linkedToTarget.results[0].scoreDetails.link > 0,
      'resolved link relations can contribute only resolved-link scoreDetails.link'
    );
    wave2Assert(
      linkedToTarget.diagnostics.linkStatusCounts.resolved >= 1,
      'includeDiagnostics exposes resolved link status counts from the persistent graph'
    );
    wave2Assert(
      linkedToTarget.results.some((item) => item.documentId === lateLinkedIdentity.documentId),
      'linkedTo hard filter applies before keyword candidate caps and finds resolved documents beyond top keyword candidates'
    );

    const rareTaggedResult = await engine.smartSearch({
      query: 'shared term',
      filters: { documentTags: ['rare'] },
      includeScores: true
    });
    wave2Assert(
      rareTaggedResult.results.some((item) => item.sourceRelativePath === 'zz-rare.md'),
      'documentTags hard filter applies before keyword candidate caps'
    );
    wave2Assert(
      rareTaggedResult.results.every((item) => item.scoreDetails && item.scoreDetails.metadata > 0),
      'documentTags filters contribute metadata ranking scoreDetails'
    );
    const categoryFilteredResult = await engine.smartSearch({
      query: 'shared term',
      filters: { category: 'api' },
      includeScores: true
    });
    wave2Assert(
      categoryFilteredResult.results.length > 0 && categoryFilteredResult.results.every((item) => item.category === 'api'),
      'category hard filter applies to smart_search results'
    );
    wave2Assert(
      categoryFilteredResult.results.every((item) => item.scoreDetails && item.scoreDetails.metadata > 0),
      'category filters contribute metadata ranking scoreDetails'
    );

    const partialPrefixResult = await engine.smartSearch({ query: 'shared term', filters: { pathPrefix: 'zz-lin' } });
    wave2Assert(
      partialPrefixResult.results.some((item) => item.documentId === lateLinkedIdentity.documentId),
      'pathPrefix uses source-relative startsWith semantics, not directory-only matching'
    );
    const escapedPrefixResult = await engine.smartSearch({ query: 'wildcard term', filters: { pathPrefix: 'foo_' } });
    wave2Assert(
      escapedPrefixResult.results.some((item) => item.sourceRelativePath === 'foo_rare.md'),
      'pathPrefix escapes SQL LIKE wildcard characters before candidate caps'
    );

    const linkedFromAlpha = await engine.smartSearch({ query: 'target', linkedFrom: alphaIdentity.documentId });
    wave2Assert(
      linkedFromAlpha.results.some((item) => item.documentId === targetIdentity.documentId),
      'linkedFrom filter returns documents reached by a resolved edge from the source document'
    );

    const canonicalStatusLedger = engine._getAvailableSourceLedger();
    const nonResolvedStatusFixtures = [
      ['missing', 'target_missing'],
      ['external', 'external_url'],
      ['path_policy_violation', 'encoded_traversal'],
      ['skipped', 'depth_limit'],
      ['ambiguous', 'ambiguous_target'],
      ['stale', 'target_stale']
    ];
    nonResolvedStatusFixtures.forEach(([status, diagnosticCode], index) => {
      canonicalStatusLedger.recordLinkEdge({
        fromDocumentId: alphaIdentity.documentId,
        status,
        originalHref: `../private/${status}.md?api_key=rawsecret`,
        normalizedHref: `../private/${status}.md?api_key=rawsecret`,
        diagnosticCode,
        ordinal: 700 + index
      });
    });

    const diagnosticsResult = await engine.smartSearch({ query: 'missing', includeDiagnostics: true, linkedTo: 'doc-missing' });
    const serializedDiagnostics = JSON.stringify(diagnosticsResult);
    const linkStatusCounts = diagnosticsResult.diagnostics && diagnosticsResult.diagnostics.linkStatusCounts;
    for (const status of ['resolved', 'missing', 'external', 'path_policy_violation', 'skipped', 'ambiguous', 'stale']) {
      wave2Assert(Number.isInteger(linkStatusCounts[status]), `includeDiagnostics exposes canonical ${status} link status count`);
    }
    wave2Assert(!Object.prototype.hasOwnProperty.call(linkStatusCounts, 'unresolved'), 'includeDiagnostics does not expose non-canonical unresolved status');
    wave2Assert(!serializedDiagnostics.includes('api_key=rawsecret'), 'smart_search diagnostics do not echo raw href credential query values');
    wave2Assert(!serializedDiagnostics.includes('../private/'), 'smart_search diagnostics do not echo raw href path segments');
    wave2Assert(!serializedDiagnostics.includes(tmp), 'smart_search diagnostics redact raw local and userData paths');
    wave2Assert(diagnosticsResult.results.length === 0, 'non-resolved broken edges never satisfy linkedTo filters');
    wave2Assert(
      diagnosticsResult.results.every((item) => !JSON.stringify(item).includes('Missing.md') || !item.scoreDetails || !item.scoreDetails.link),
      'non-resolved broken edges do not create resolved-link ranking boosts'
    );

    const previousSemanticSearch = engine.options.semanticSearch;
    engine.options.semanticSearch = { ...previousSemanticSearch, enabled: false };
    const strictMode = await engine.smartSearch({ query: 'shared term', allowDegraded: false });
    engine.options.semanticSearch = previousSemanticSearch;
    wave2Assert(strictMode.error && strictMode.error.code === 'degraded_not_allowed', 'allowDegraded=false rejects keyword-only degraded smart_search');

    const ledger = engine._getAvailableSourceLedger();
    ledger.upsertDocument({
      sourceId: betaIdentity.sourceId,
      documentId: betaIdentity.documentId,
      sourceRelativePath: betaIdentity.sourceRelativePath,
      pathKey: betaIdentity.pathKey,
      canonicalPathInternal: betaPath,
      pathStatus: 'missing'
    });
    const staleResult = await engine.smartSearch({ query: 'same score', includeDiagnostics: true });
    wave2Assert(staleResult.staleFilteredCount >= 1, 'staleFilteredCount reports active-only stale filtering');
    wave2Assert(
      staleResult.results.every((item) => item.documentId !== betaIdentity.documentId),
      'stale documents are filtered unless includeStale is true'
    );

    engine.dirty = true;
    const originalRebuild = engine.rebuild.bind(engine);
    engine.rebuild = async () => {
      throw new Error('smartSearch attempted rebuild side effect');
    };
    const staleRead = await engine.smartSearch({ query: 'shared term' });
    wave2Assert(staleRead.indexFreshness === 'stale', 'dirty smart_search reports stale freshness without rebuilding');
    engine.rebuild = originalRebuild;
    engine.dirty = false;

    const keywordCompatibility = engine.search('same score', { limit: 20 });
    wave2Assert(
      keywordCompatibility.some((item) => item.filePath === betaPath),
      'search_documents keyword compatibility remains unchanged by smart_search link filtering'
    );
  } finally {
    if (engine) engine.close();
    await removeTreeWithRetry(tmp);
  }

  console.log('test-wave2-smart-search-contract: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
