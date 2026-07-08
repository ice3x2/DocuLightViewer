'use strict';

const path = require('path');
const { createRedactor, redactToken } = require('./redaction');

const SMART_SEARCH_ALLOWED_FIELDS = new Set([
  'query',
  'mode',
  'limit',
  'filters',
  'linkedTo',
  'linkedFrom',
  'includeSnippets',
  'includeScores',
  'includeTrace',
  'includeDiagnostics',
  'allowDegraded'
]);
const SMART_SEARCH_FILTER_FIELDS = new Set([
  'project',
  'docType',
  'category',
  'documentTags',
  'tagMode',
  'pathPrefix',
  'linkedTo',
  'linkedFrom',
  'includeStale'
]);
const SMART_SEARCH_MODES = ['auto', 'keyword', 'hybrid'];

// @req IR-MCP-018
// @req SEC-DOC-003
async function buildSmartSearchToolResult(args = {}, { searchEngine, store } = {}) {
  const validation = validateSmartSearchRequest(args);
  const mode = validation.mode || 'auto';
  if (validation.error) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(errorEnvelope({
        mode,
        ...validation.error
      })) }]
    };
  }

  const {
    query,
    filters,
    safeLimit,
    includeScores,
    includeTrace,
    includeDiagnostics,
    allowDegraded
  } = validation;
  const hasLinkFilter = Boolean(filters.linkedTo || filters.linkedFrom);
  const wantsSemantic = mode !== 'keyword';
  const semanticCandidateLimit = Math.min(200, Math.max(safeLimit * 10, safeLimit));
  const semanticCollection = wantsSemantic && searchEngine && typeof searchEngine.getSmartSearchSemanticCandidates === 'function'
    ? await searchEngine.getSmartSearchSemanticCandidates(query, {
      limit: semanticCandidateLimit,
      filters
    })
    : {
      status: 'disabled',
      degradationReason: mode === 'keyword' ? null : 'embedding_disabled',
      backend: null,
      candidates: []
    };
  const semanticCandidates = Array.isArray(semanticCollection.candidates) ? semanticCollection.candidates : [];
  const semanticReady = wantsSemantic && semanticCollection.status === 'ready' && semanticCandidates.length > 0;
  const keywordOnly = wantsSemantic && !semanticReady;
  const semanticDegradationReasons = semanticCollection.degradationReason
    ? [semanticCollection.degradationReason]
    : [];
  if (allowDegraded === false && keywordOnly) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(errorEnvelope({
        mode,
        code: 'degraded_not_allowed',
        message: 'smart_search is currently available through degraded keyword-only retrieval.',
        retryable: false
      })) }]
    };
  }

  const linkFilter = hasLinkFilter && searchEngine && typeof searchEngine.getSmartSearchResolvedLinkFilter === 'function'
    ? searchEngine.getSmartSearchResolvedLinkFilter(filters)
    : null;
  const linkFilterDocumentIds = linkFilter && linkFilter.documentIds ? linkFilter.documentIds : null;
  const linkFilterFilePaths = linkFilter && Array.isArray(linkFilter.filePaths) ? linkFilter.filePaths : null;
  const linkFilterUnavailable = hasLinkFilter && !linkFilter;
  const candidateLimit = Math.min(200, Math.max(safeLimit * 10, safeLimit));
  const searchResults = searchEngine
    ? searchEngine.search(query, {
      limit: candidateLimit,
      project: filters.project,
      docType: filters.docType,
      category: filters.category,
      documentTags: filters.documentTags,
      tagMode: filters.tagMode,
      pathPrefix: filters.pathPrefix,
      filePaths: linkFilterFilePaths
    })
    : [];
  const redactor = createSmartSearchRedactor(store, searchEngine);
  const keywordCandidates = searchResults
    .map((item) => normalizeSearchResult(item, { store, searchEngine, redactor }))
    .map((item) => ({
      ...item,
      keywordScore: normalizeScore(item.score),
      semanticScore: 0
    }));
  const normalizedSemanticCandidates = semanticCandidates
    .map((item) => normalizeSearchResult(item, { store, searchEngine, redactor }))
    .map((item) => ({
      ...item,
      keywordScore: 0,
      semanticScore: normalizeSemanticCandidateScore(item)
    }));
  const candidates = mergeSmartSearchCandidates(keywordCandidates, normalizedSemanticCandidates)
    .map((item) => scoreSearchResult(item, filters, {
      linkFilterDocumentIds,
      semanticEnabled: semanticReady
    }));
  const staleFilteredCount = candidates.filter((item) => isStaleFiltered(item, filters)).length;
  const normalized = candidates
    .filter((item) => matchesFilters(item, filters, { linkFilterDocumentIds }))
    .sort(compareSmartSearchResults);
  const results = linkFilterUnavailable ? [] : normalized.slice(0, safeLimit);
  const status = searchEngine && typeof searchEngine.getStatus === 'function'
    ? redactor.redactValue(searchEngine.getStatus())
    : null;
  const linkStatusCounts = searchEngine && typeof searchEngine.getSmartSearchLinkStatusCounts === 'function'
    ? searchEngine.getSmartSearchLinkStatusCounts() || createEmptyLinkStatusCounts()
    : createEmptyLinkStatusCounts();
  const warnings = [];
  if (linkFilterUnavailable) {
    warnings.push({
      code: 'resolved_link_filter_unavailable',
      message: 'linkedTo and linkedFrom require the persistent resolved link graph and return no keyword-only matches in this degraded mode.',
      retryable: true
    });
  }

  const payload = {
    schemaVersion: 'smart_search.v1',
    mode: { requested: mode, used: semanticReady ? 'hybrid' : 'keyword' },
    degraded: keywordOnly || semanticDegradationReasons.length > 0,
    degradationReasons: keywordOnly ? [semanticCollection.degradationReason || 'keyword_only'] : semanticDegradationReasons,
    results: results.map((item, index) => ({
      rank: index + 1,
      documentId: item.documentId || null,
      title: item.title,
      ...(item.sourceRelativePath ? { sourceRelativePath: item.sourceRelativePath } : { redactedPath: item.redactedPath }),
      docType: item.docType || null,
      category: item.category || null,
      documentTags: item.documentTags || [],
      snippet: {
        text: item.snippet || '',
        headingPath: [],
        lineRange: null
      },
      ...(includeScores ? { scoreDetails: item.scoreDetails } : {})
    })),
    indexFreshness: status && status.state ? status.state : 'unavailable',
    staleFilteredCount,
    ...(includeDiagnostics ? {
      diagnostics: {
        indexStatus: status,
        provider: semanticReady ? (semanticCollection.backend || 'hnsw') : 'keyword',
        policyHash: null,
        linkStatusCounts,
        warnings
      }
    } : {}),
    ...(includeTrace ? {
      trace: {
        items: [{
          stage: 'candidate_collection',
          keywordCandidateCount: searchResults.length,
          semanticCandidateCount: semanticCandidates.length,
          provider: semanticReady ? (semanticCollection.backend || 'hnsw') : 'keyword',
          linkFilterApplied: hasLinkFilter,
          resultCount: results.length
        }]
      }
    } : {})
  };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function errorEnvelope({ mode, code, message, retryable, field, expected, hint }) {
  const safeMode = SMART_SEARCH_MODES.includes(mode) ? mode : 'invalid';
  const error = { code, message, retryable };
  if (field) error.field = field;
  if (expected) error.expected = expected;
  if (hint) error.hint = hint;
  return {
    schemaVersion: 'smart_search.v1',
    mode: { requested: safeMode || 'auto', used: 'none' },
    degraded: true,
    degradationReasons: ['index_unavailable'],
    results: [],
    indexFreshness: 'unknown',
    staleFilteredCount: 0,
    error
  };
}

function validateSmartSearchRequest(args = {}) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const unknownFields = Object.keys(input).filter((key) => !SMART_SEARCH_ALLOWED_FIELDS.has(key));
  if (unknownFields.length > 0) {
    return {
      mode: 'auto',
      error: validationError('smart_search', 'Unsupported smart_search field(s).', {
        field: 'arguments',
        expected: Array.from(SMART_SEARCH_ALLOWED_FIELDS).sort(),
        hint: 'Remove unknown smart_search fields and retry.'
      })
    };
  }

  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (!query) {
    return {
      mode: 'auto',
      error: {
        code: 'missing_query',
        message: 'query is required.',
        field: 'query',
        expected: 'non-empty string',
        hint: 'Provide a non-empty smart_search query.',
        retryable: false
      }
    };
  }
  if (query.length > 500) {
    return {
      mode: 'auto',
      error: validationError('query', 'query exceeds the 500 character smart_search limit.', {
        field: 'query',
        expected: 'string length <= 500',
        hint: 'Shorten the smart_search query.'
      })
    };
  }

  const mode = input.mode == null ? 'auto' : String(input.mode);
  if (!SMART_SEARCH_MODES.includes(mode)) {
    return {
      mode: 'invalid',
      error: validationError('mode', 'Invalid smart_search mode.', {
        field: 'mode',
        expected: SMART_SEARCH_MODES,
        hint: 'Use auto, keyword, or hybrid.'
      })
    };
  }

  const filtersResult = normalizeAndValidateFilters(input);
  if (filtersResult.error) {
    return { mode, error: filtersResult.error };
  }

  return {
    mode,
    query,
    filters: filtersResult.filters,
    safeLimit: Math.max(1, Math.min(Number(input.limit) || 20, 50)),
    includeScores: input.includeScores === true,
    includeTrace: input.includeTrace === true,
    includeDiagnostics: input.includeDiagnostics === true,
    allowDegraded: input.allowDegraded !== false
  };
}

function normalizeAndValidateFilters(input = {}) {
  const rawFilters = input.filters == null ? {} : input.filters;
  if (!rawFilters || typeof rawFilters !== 'object' || Array.isArray(rawFilters)) {
    return {
      error: validationError('filters', 'smart_search.filters must be an object.', {
        field: 'filters',
        expected: 'object',
        hint: 'Provide filters as an object or omit it.'
      })
    };
  }

  const unknownFilterFields = Object.keys(rawFilters).filter((key) => !SMART_SEARCH_FILTER_FIELDS.has(key));
  if (unknownFilterFields.length > 0) {
    return {
      error: validationError('filters', 'Unsupported smart_search.filters field(s).', {
        field: 'filters',
        expected: Array.from(SMART_SEARCH_FILTER_FIELDS).sort(),
        hint: 'Remove unknown filter fields and retry.'
      })
    };
  }

  const filters = {
    ...rawFilters,
    ...(input.linkedTo ? { linkedTo: input.linkedTo } : {}),
    ...(input.linkedFrom ? { linkedFrom: input.linkedFrom } : {})
  };
  if (filters.pathPrefix != null) {
    const normalized = normalizeSourceRelativePathPrefix(filters.pathPrefix);
    if (normalized.error) return { error: normalized.error };
    filters.pathPrefix = normalized.value;
  }
  return { filters };
}

function normalizeSourceRelativePathPrefix(value) {
  if (typeof value !== 'string') {
    return {
      error: validationError('filters.pathPrefix', 'pathPrefix must be a source-relative path string.', {
        field: 'filters.pathPrefix',
        expected: 'source-relative path prefix',
        hint: 'Use a relative prefix such as docs/guide; absolute paths, home paths, traversal, URLs, and credentials are not accepted.'
      })
    };
  }
  const raw = value.trim();
  const normalized = raw.replace(/\\/g, '/');
  const decoded = safeDecodeURIComponent(normalized);
  if (
    !raw ||
    raw.includes('\0') ||
    normalized.startsWith('/') ||
    path.win32.isAbsolute(raw) ||
    path.posix.isAbsolute(raw) ||
    normalized === '~' ||
    normalized.startsWith('~/') ||
    normalized.startsWith('~\\') ||
    hasTraversalSegment(normalized) ||
    hasTraversalSegment(decoded) ||
    isUrlLike(normalized) ||
    isUrlLike(decoded) ||
    isCredentialLike(normalized) ||
    isCredentialLike(decoded)
  ) {
    return {
      error: validationError('filters.pathPrefix', 'pathPrefix must be source-relative and safe.', {
        field: 'filters.pathPrefix',
        expected: 'source-relative path prefix',
        hint: 'Use a relative prefix within the configured document store. Absolute paths, UNC paths, home paths, traversal, URLs, and credentials are rejected.'
      })
    };
  }
  return { value: normalized };
}

function validationError(codeField, message, { field, expected, hint }) {
  return {
    code: 'validation_failed',
    message,
    field: field || codeField,
    expected,
    hint,
    retryable: false
  };
}

function hasTraversalSegment(value) {
  return String(value || '').split('/').some((segment) => segment === '..');
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isUrlLike(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^file:/i.test(value);
}

function isCredentialLike(value) {
  return /[?&](api[_-]?key|token|password|secret)=/i.test(value) || /:\/\/[^/\s]*[:@][^/\s]*@/i.test(value);
}

function createSmartSearchRedactor(store, searchEngine) {
  const sourceRoot = store && typeof store.get === 'function' ? store.get('mcpAutoSavePath', '') : '';
  const indexDir = searchEngine && typeof searchEngine.getIndexDataDir === 'function' ? searchEngine.getIndexDataDir() : null;
  return createRedactor({
    userDataDir: store && typeof store.get === 'function' ? store.get('userDataPath', '') : '',
    indexDir,
    sourceRoots: [sourceRoot].filter(Boolean)
  });
}

function normalizeSearchResult(item, { store, searchEngine, redactor } = {}) {
  const sourceRoot = store && typeof store.get === 'function' ? store.get('mcpAutoSavePath', '') : '';
  const rawSourceRelativePath = item.sourceRelativePath
    ? String(item.sourceRelativePath).replace(/\\/g, '/')
    : null;
  const filePath = item.filePath || (rawSourceRelativePath && sourceRoot
    ? path.resolve(sourceRoot, rawSourceRelativePath)
    : '');
  const identity = searchEngine && typeof searchEngine.getSmartSearchDocumentIdentityForCandidate === 'function'
    ? searchEngine.getSmartSearchDocumentIdentityForCandidate({
      ...item,
      filePath,
      sourceRelativePath: rawSourceRelativePath
    })
    : (searchEngine && typeof searchEngine.getSmartSearchDocumentIdentity === 'function'
      ? searchEngine.getSmartSearchDocumentIdentity(filePath)
      : null);
  const sourceRelativePath = identity && identity.sourceRelativePath
    ? identity.sourceRelativePath
    : rawSourceRelativePath || toSourceRelativePath(filePath, sourceRoot);
  const meta = getIndexedDocumentMeta(searchEngine, filePath, sourceRelativePath, sourceRoot);
  const project = item.project || (meta && meta.project) || null;
  const docType = item.docType || (meta && meta.docType) || null;
  const category = item.category || (meta && meta.category) || null;
  const documentTags = Array.isArray(item.documentTags)
    ? item.documentTags
    : (meta && Array.isArray(meta.documentTags) ? meta.documentTags : []);
  return {
    ...item,
    documentId: identity && identity.documentId ? identity.documentId : item.documentId || null,
    sourceRelativePath,
    pathStatus: identity && identity.pathStatus ? identity.pathStatus : 'active',
    filterProject: project,
    filterDocType: docType,
    filterCategory: category,
    filterDocumentTags: documentTags,
    redactedPath: sourceRelativePath ? null : redactToken('PATH', filePath),
    project,
    category: category ? redactor.redactString(String(category)) : null,
    documentTags: documentTags.map((tag) => redactor.redactString(String(tag || ''))).filter(Boolean),
    title: redactor.redactString(item.title || (sourceRelativePath ? path.basename(sourceRelativePath, '.md') : 'Document')),
    docType: docType ? redactor.redactString(String(docType)) : null,
    snippet: redactor.redactString(item.snippet || '')
  };
}

function getIndexedDocumentMeta(searchEngine, filePath, sourceRelativePath, sourceRoot) {
  if (!searchEngine || !(searchEngine.docMeta instanceof Map)) return null;
  const candidates = [];
  if (filePath) candidates.push(filePath);
  if (filePath) candidates.push(path.resolve(filePath));
  if (sourceRoot && sourceRelativePath) candidates.push(path.resolve(sourceRoot, sourceRelativePath));
  for (const candidate of candidates) {
    if (searchEngine.docMeta.has(candidate)) return searchEngine.docMeta.get(candidate);
  }
  return null;
}

function toSourceRelativePath(filePath, sourceRoot) {
  if (!filePath || !sourceRoot) return null;
  const root = path.resolve(sourceRoot);
  const absolute = path.resolve(filePath);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.replace(/\\/g, '/');
}

function matchesFilters(item, filters = {}, { linkFilterDocumentIds } = {}) {
  if (isStaleFiltered(item, filters)) return false;
  if (filters.project && (item.filterProject || item.project) !== filters.project) return false;
  if (filters.docType && (item.filterDocType || item.docType) !== filters.docType) return false;
  if (filters.pathPrefix && (!item.sourceRelativePath || !item.sourceRelativePath.startsWith(String(filters.pathPrefix).replace(/\\/g, '/')))) {
    return false;
  }
  if (filters.category && (item.filterCategory || item.category) !== filters.category) return false;
  if (Array.isArray(filters.documentTags) && filters.documentTags.length > 0) {
    const tags = new Set(item.filterDocumentTags || item.documentTags || []);
    if ((filters.tagMode || 'any') === 'all') {
      if (!filters.documentTags.every((tag) => tags.has(tag))) return false;
    } else if (!filters.documentTags.some((tag) => tags.has(tag))) {
      return false;
    }
  }
  if (linkFilterDocumentIds && (!item.documentId || !linkFilterDocumentIds.has(item.documentId))) return false;
  return true;
}

function isStaleFiltered(item, filters = {}) {
  return Boolean(item.pathStatus && item.pathStatus !== 'active' && filters.includeStale !== true);
}

function scoreSearchResult(item, filters = {}, { linkFilterDocumentIds, semanticEnabled = false } = {}) {
  const keyword = typeof item.keywordScore === 'number' ? item.keywordScore : normalizeScore(item.score);
  const semantic = semanticEnabled
    ? (typeof item.semanticScore === 'number' ? item.semanticScore : normalizeSemanticScore(item.semanticScore))
    : 0;
  const metadata = metadataScore(item, filters);
  const link = linkFilterDocumentIds && item.documentId && linkFilterDocumentIds.has(item.documentId) ? 1 : 0;
  const freshness = 0;
  const stalePenalty = item.pathStatus && item.pathStatus !== 'active' ? 1 : 0;
  const weights = semanticEnabled
    ? { semantic: 0.48, keyword: 0.32, metadata: 0.10, link: 0.05, freshness: 0.05 }
    : { semantic: 0, keyword: 0.75, metadata: 0.15, link: 0.05, freshness: 0.05 };
  const total = roundScore(
    (semantic * weights.semantic) +
    (keyword * weights.keyword) +
    (metadata * weights.metadata) +
    (link * weights.link) +
    (freshness * weights.freshness) -
    stalePenalty
  );
  return {
    ...item,
    scoreDetails: {
      total,
      keyword,
      semantic,
      metadata,
      link,
      freshness,
      stalePenalty
    }
  };
}

function normalizeSemanticScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return 0;
  if (score < 0) return roundScore(1 / (1 + Math.abs(score)));
  if (score > 1) return roundScore(score / (score + 1));
  return roundScore(score);
}

function normalizeSemanticCandidateScore(item = {}) {
  if (Object.prototype.hasOwnProperty.call(item, 'semanticScore')) {
    return normalizeSemanticScore(item.semanticScore);
  }
  if (Object.prototype.hasOwnProperty.call(item, 'score')) {
    return normalizeSemanticScore(item.score);
  }
  if (Object.prototype.hasOwnProperty.call(item, 'similarity')) {
    return normalizeSemanticScore(item.similarity);
  }
  if (Object.prototype.hasOwnProperty.call(item, 'distance')) {
    return normalizeSemanticDistance(item.distance);
  }
  return 0;
}

function normalizeSemanticDistance(value) {
  const distance = Number(value);
  if (!Number.isFinite(distance)) return 0;
  return roundScore(1 / (1 + Math.max(0, distance)));
}

function mergeSmartSearchCandidates(keywordCandidates, semanticCandidates) {
  const merged = new Map();
  for (const candidate of [...keywordCandidates, ...semanticCandidates]) {
    const key = candidate.documentId || candidate.sourceRelativePath || candidate.filePath || candidate.redactedPath || candidate.title;
    if (!key) continue;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, candidate);
      continue;
    }
    merged.set(key, {
      ...existing,
      ...candidate,
      title: existing.title || candidate.title,
      sourceRelativePath: existing.sourceRelativePath || candidate.sourceRelativePath,
      redactedPath: existing.redactedPath || candidate.redactedPath,
      snippet: candidate.snippet || existing.snippet,
      keywordScore: Math.max(existing.keywordScore || 0, candidate.keywordScore || 0),
      semanticScore: Math.max(existing.semanticScore || 0, candidate.semanticScore || 0),
      score: Math.max(Number(existing.score) || 0, Number(candidate.score) || 0)
    });
  }
  return Array.from(merged.values());
}

function normalizeScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score) || score <= 0) return 0;
  if (score <= 1) return roundScore(score);
  return roundScore(score / (score + 1));
}

function metadataScore(item, filters = {}) {
  let matched = 0;
  let possible = 0;
  if (filters.category) {
    possible += 1;
    if ((item.filterCategory || item.category) === filters.category) matched += 1;
  }
  if (Array.isArray(filters.documentTags) && filters.documentTags.length > 0) {
    possible += 1;
    const tags = new Set(item.filterDocumentTags || item.documentTags || []);
    const ok = (filters.tagMode || 'any') === 'all'
      ? filters.documentTags.every((tag) => tags.has(tag))
      : filters.documentTags.some((tag) => tags.has(tag));
    if (ok) matched += 1;
  }
  if (possible === 0) return 0;
  return roundScore(matched / possible);
}

function compareSmartSearchResults(a, b) {
  const totalDiff = (b.scoreDetails.total || 0) - (a.scoreDetails.total || 0);
  if (Math.abs(totalDiff) > 1e-9) return totalDiff;
  const keywordDiff = (b.scoreDetails.keyword || 0) - (a.scoreDetails.keyword || 0);
  if (Math.abs(keywordDiff) > 1e-9) return keywordDiff;
  const metadataDiff = (b.scoreDetails.metadata || 0) - (a.scoreDetails.metadata || 0);
  if (Math.abs(metadataDiff) > 1e-9) return metadataDiff;
  const linkDiff = (b.scoreDetails.link || 0) - (a.scoreDetails.link || 0);
  if (Math.abs(linkDiff) > 1e-9) return linkDiff;
  return String(a.sourceRelativePath || a.documentId || a.title || '').localeCompare(
    String(b.sourceRelativePath || b.documentId || b.title || ''),
    'en',
    { numeric: true }
  );
}

function roundScore(value) {
  return Math.round((Number(value) || 0) * 1000000) / 1000000;
}

function hasPostSearchFilters(filters = {}) {
  return Boolean(
    filters.pathPrefix ||
    filters.category ||
    (Array.isArray(filters.documentTags) && filters.documentTags.length > 0) ||
    filters.linkedTo ||
    filters.linkedFrom
  );
}

function createEmptyLinkStatusCounts() {
  return {
    resolved: 0,
    missing: 0,
    external: 0,
    path_policy_violation: 0,
    skipped: 0,
    ambiguous: 0,
    stale: 0
  };
}

module.exports = {
  buildSmartSearchToolResult
};
