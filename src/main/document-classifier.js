'use strict';

const path = require('path');
const { parseFrontmatter, DOC_TYPE_VALUES } = require('./frontmatter');

const DEFAULT_DOC_TYPE = 'note';
const DEFAULT_CATEGORY = 'general';

// @req FR-DOC-019
class DocumentClassifier {
  // @req FR-DOC-019
  classify({ content = '', filePath = '' } = {}) {
    const parsed = parseFrontmatter(String(content));
    const frontmatter = parsed.data || {};
    const rawFrontmatter = extractFrontmatterBlock(String(content));
    const diagnostics = [];
    const explicitDocType = normalizeDocType(frontmatter.docType);
    const docType = explicitDocType || inferDocType(filePath, parsed.body);
    const explicitCategory = normalizeCategory(frontmatter.category, diagnostics);
    const categoryInfo = explicitCategory
      ? {
        category: explicitCategory,
        assignedBy: 'explicit',
        confidence: 1,
        reason: 'frontmatter.category',
        evidence: { frontmatterCategory: explicitCategory }
      }
      : inferCategory(filePath, docType, parsed.body, {
        explicitDocType,
        rawFrontmatter
      });
    const project = normalizeScalar(frontmatter.project);
    const tagInfo = normalizeTags(
      frontmatter.documentTags ||
      frontmatter.tags ||
      readFrontmatterList(rawFrontmatter, 'documentTags') ||
      readFrontmatterList(rawFrontmatter, 'tags'),
      diagnostics
    );
    return {
      docType,
      project,
      category: categoryInfo.category,
      documentTags: tagInfo.tags,
      assignedBy: categoryInfo.assignedBy,
      confidence: categoryInfo.confidence,
      reason: categoryInfo.reason,
      evidence: categoryInfo.evidence,
      parseStatus: diagnostics.length ? 'diagnostic' : 'ok',
      diagnostic: diagnostics.length
        ? {
          diagnosticCode: 'metadata_parse_diagnostic',
          issues: diagnostics
        }
        : null
    };
  }
}

// @req FR-DOC-019
function createDocumentClassifier(options = {}) {
  return new DocumentClassifier(options);
}

function normalizeDocType(value) {
  const normalized = normalizeScalar(value);
  if (normalized && DOC_TYPE_VALUES.includes(normalized)) return normalized;
  return null;
}

function inferDocType(filePath, body) {
  const text = `${filePath}\n${body}`.toLowerCase();
  if (/\bsrs\b|requirements?|spec/.test(text)) return 'spec';
  if (/guide|manual|사용법|가이드/.test(text)) return 'guide';
  if (/report|analysis|분석|보고/.test(text)) return 'report';
  if (/plan|roadmap|계획/.test(text)) return 'plan';
  if (/review|검토/.test(text)) return 'review';
  if (/log|journal|diary|기록/.test(text)) return 'log';
  return DEFAULT_DOC_TYPE;
}

function inferCategory(filePath, docType, body, { explicitDocType, rawFrontmatter } = {}) {
  if (explicitDocType && explicitDocType !== DEFAULT_DOC_TYPE) {
    return {
      category: explicitDocType,
      assignedBy: 'classifier',
      confidence: 0.8,
      reason: 'frontmatter.docType',
      evidence: { frontmatterDocType: explicitDocType }
    };
  }
  const normalizedPath = String(filePath).replace(/\\/g, '/').toLowerCase();
  const lowerBody = String(body).toLowerCase();
  const segments = normalizedPath.split('/').filter(Boolean);
  for (const segment of segments) {
    if (['research', 'spec', 'test', 'tests', 'work-report'].includes(segment)) {
      return {
        category: segment,
        assignedBy: 'classifier',
        confidence: 0.65,
        reason: 'path.prefix',
        evidence: { pathPrefix: segment }
      };
    }
  }
  const titleCategory = inferCategoryFromTitleAndText(filePath, body);
  if (titleCategory) return titleCategory;
  const tableCategory = readMetadataTableCategory(rawFrontmatter || body);
  if (tableCategory) {
    return {
      category: tableCategory,
      assignedBy: 'classifier',
      confidence: 0.45,
      reason: 'top.metadata_table',
      evidence: { metadataTableCategory: tableCategory }
    };
  }
  if (/embedding|hnsw|bm25|search|retrieval|검색|임베딩/.test(lowerBody)) {
    return {
      category: 'search',
      assignedBy: 'classifier',
      confidence: 0.5,
      reason: 'body.keyword',
      evidence: { keyword: 'search' }
    };
  }
  if (docType && docType !== DEFAULT_DOC_TYPE) {
    return {
      category: docType,
      assignedBy: 'classifier',
      confidence: 0.4,
      reason: 'inferred.docType',
      evidence: { docType }
    };
  }
  return {
    category: DEFAULT_CATEGORY,
    assignedBy: 'fallback',
    confidence: 0.2,
    reason: 'fallback.general',
    evidence: {}
  };
}

function normalizeCategory(value, diagnostics) {
  if (Array.isArray(value)) {
    diagnostics.push({ field: 'category', reason: 'unsupported_list_value' });
    return null;
  }
  if (value && typeof value === 'object') {
    diagnostics.push({ field: 'category', reason: 'unsupported_object_value' });
    return null;
  }
  const normalized = normalizeScalar(value);
  if (!normalized) return null;
  if (looksStructuredYamlScalar(normalized)) {
    diagnostics.push({ field: 'category', reason: 'unsupported_structured_scalar' });
    return null;
  }
  return normalized;
}

function normalizeTags(value, diagnostics) {
  if (Array.isArray(value)) {
    const tags = [];
    for (const item of value) {
      const normalized = normalizeScalar(item);
      if (!normalized) continue;
      if (looksStructuredYamlScalar(normalized)) {
        diagnostics.push({ field: 'documentTags', reason: 'unsupported_structured_scalar' });
        continue;
      }
      tags.push(normalized);
    }
    return { tags: [...new Set(tags)] };
  }
  if (value == null) return { tags: [] };
  const raw = String(value).trim();
  if (!raw) return { tags: [] };
  if (looksStructuredYamlScalar(raw)) {
    diagnostics.push({ field: 'documentTags', reason: 'unsupported_structured_scalar' });
    return { tags: [] };
  }
  const withoutBrackets = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  return { tags: [...new Set(withoutBrackets
    .split(/[,\n]/)
    .map((tag) => normalizeScalar(tag.replace(/^[-\s]+/, '')))
    .filter(Boolean))] };
}

function looksStructuredYamlScalar(value) {
  const raw = String(value || '').trim();
  return (raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']') && /:/.test(raw));
}

function inferCategoryFromTitleAndText(filePath, body) {
  const title = extractTitle(body) || path.basename(String(filePath || ''), path.extname(String(filePath || '')));
  const titleText = String(title || '').toLowerCase();
  if (/embedding|hnsw|bm25|search|retrieval|검색|임베딩/.test(titleText)) {
    return {
      category: 'search',
      assignedBy: 'classifier',
      confidence: 0.55,
      reason: 'title.keyword',
      evidence: { title }
    };
  }
  if (/license|licence|라이선스/.test(titleText)) {
    return {
      category: 'license',
      assignedBy: 'classifier',
      confidence: 0.55,
      reason: 'title.keyword',
      evidence: { title }
    };
  }
  return null;
}

function extractTitle(body) {
  const match = String(body || '').match(/^\s*#\s+(.+?)\s*$/m);
  return match ? match[1].trim() : null;
}

function readMetadataTableCategory(text) {
  const lines = String(text || '').split(/\r?\n/).slice(0, 30);
  for (const line of lines) {
    const cells = line.split('|').map((cell) => cell.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    if (/^category$/i.test(cells[0])) return normalizeScalar(cells[1]);
  }
  return null;
}

function extractFrontmatterBlock(content) {
  const match = String(content || '').match(/^---\r?\n([\s\S]*?\r?\n)?---\r?\n?/);
  return match ? match[1] || '' : '';
}

function readFrontmatterList(yaml, key) {
  if (!yaml) return null;
  const lines = String(yaml).split(/\r?\n/);
  const keyRe = new RegExp(`^${escapeRegExp(key)}\\s*:\\s*(.*)$`);
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(keyRe);
    if (!match) continue;
    const inline = match[1].trim();
    if (inline) return inline;
    const values = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (/^\S[^:]*:\s*/.test(line)) break;
      const item = line.match(/^\s*-\s*(.+?)\s*$/);
      if (item) values.push(item[1]);
      if (!line.trim()) continue;
    }
    return values.length ? values : null;
  }
  return null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeScalar(value) {
  if (value == null) return null;
  const trimmed = String(value).trim().replace(/^['"]|['"]$/g, '');
  return trimmed || null;
}

module.exports = {
  DocumentClassifier,
  createDocumentClassifier
};
