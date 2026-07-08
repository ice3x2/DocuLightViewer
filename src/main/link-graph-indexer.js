'use strict';

const fs = require('fs');
const path = require('path');

// @req CON-DOC-006
// @req FR-TREE-009
class LinkGraphIndexer {
  constructor({ sourceRoot } = {}) {
    this.sourceRoot = sourceRoot ? path.resolve(sourceRoot) : null;
  }

  // @req CON-DOC-006
  // @req FR-TREE-009
  extractLinks(content, { filePath, documentId, resolveDocument } = {}) {
    const source = String(content || '');
    const masked = maskCode(source);
    const links = [
      ...extractInlineLinks(masked),
      ...extractWikiLinks(masked)
    ].sort((a, b) => a.index - b.index);

    return links.map((link, ordinal) => this.classifyLink(link, {
      filePath,
      documentId,
      resolveDocument,
      source,
      ordinal
    }));
  }

  classifyLink(link, { filePath, documentId, resolveDocument, source, ordinal }) {
    const originalHref = link.href;
    const sourceLine = lineNumberAt(source, link.index);
    const base = filePath ? path.dirname(path.resolve(filePath)) : process.cwd();
    const split = splitHref(originalHref);
    const href = split.href;
    const targetAnchor = split.anchor;

    if (!href) {
      return edge({
        documentId,
        link,
        ordinal,
        sourceLine,
        targetAnchor,
        normalizedHref: originalHref,
        status: 'skipped',
        diagnosticCode: 'anchor_only'
      });
    }

    if (isPathPolicyHref(href)) {
      return edge({
        documentId,
        link,
        ordinal,
        sourceLine,
        targetAnchor,
        normalizedHref: href,
        status: 'path_policy_violation',
        diagnosticCode: pathPolicyDiagnostic(href)
      });
    }

    if (isExternalHref(href)) {
      return edge({
        documentId,
        link,
        ordinal,
        sourceLine,
        targetAnchor,
        normalizedHref: href,
        status: 'external',
        diagnosticCode: 'external_url'
      });
    }

    const pathHref = split.pathHref;
    if (!isMarkdownHref(pathHref)) {
      return edge({
        documentId,
        link,
        ordinal,
        sourceLine,
        targetAnchor,
        normalizedHref: pathHref || href,
        status: 'skipped',
        diagnosticCode: 'non_markdown_target'
      });
    }

    const decodedHref = decodeRepeated(pathHref);
    if (hasEncodedTraversal(href) || hasTraversalSegment(decodedHref)) {
      return edge({
        documentId,
        link,
        ordinal,
        sourceLine,
        targetAnchor,
        normalizedHref: pathHref,
        status: 'path_policy_violation',
        diagnosticCode: 'traversal'
      });
    }

    const resolvedPath = path.resolve(base, decodedHref);
    if (this.sourceRoot && !isWithinRoot(resolvedPath, this.sourceRoot)) {
      return edge({
        documentId,
        link,
        ordinal,
        sourceLine,
        targetAnchor,
        normalizedHref: href,
        status: 'path_policy_violation',
        diagnosticCode: 'outside_source_root'
      });
    }
    if (this.sourceRoot) {
      const realpathDiagnostic = realpathContainmentDiagnostic(resolvedPath, this.sourceRoot);
      if (realpathDiagnostic) {
        return edge({
          documentId,
          link,
          ordinal,
          sourceLine,
          targetAnchor,
          normalizedHref: pathHref,
          status: 'path_policy_violation',
          diagnosticCode: realpathDiagnostic
        });
      }
    }

    const normalizedHref = this.sourceRoot
      ? normalizePathKey(path.relative(this.sourceRoot, resolvedPath))
      : normalizePathKey(resolvedPath);
    const target = typeof resolveDocument === 'function'
      ? resolveDocument({ pathKey: normalizedHref, sourceRelativePath: normalizedHref, filePath: resolvedPath })
      : null;
    if (target && target.documentId) {
      return edge({
        documentId,
        link,
        ordinal,
        sourceLine,
        targetAnchor,
        normalizedHref,
        status: 'resolved',
        toDocumentId: target.documentId
      });
    }

    return edge({
      documentId,
      link,
      ordinal,
      sourceLine,
      targetAnchor,
      normalizedHref,
      status: 'missing',
      diagnosticCode: 'target_missing'
    });
  }
}

// @req CON-DOC-006
// @req FR-TREE-009
function createLinkGraphIndexer(options = {}) {
  return new LinkGraphIndexer(options);
}

function extractInlineLinks(content) {
  const results = [];
  const regex = /(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    if (match[1] === '!') continue;
    const href = stripTitle(match[3]);
    results.push({
      kind: 'markdown',
      index: match.index,
      originalHref: match[3],
      href,
      linkText: match[2]
    });
  }
  return results;
}

function extractWikiLinks(content) {
  const results = [];
  const regex = /(?<!!)\[\[([^\]\n]+)\]\]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const raw = match[1].trim();
    const [target, alias] = raw.split('|');
    const href = ensureMarkdownExtension(target.trim());
    results.push({
      kind: 'wikilink',
      index: match.index,
      originalHref: raw,
      href,
      linkText: (alias || target).trim()
    });
  }
  return results;
}

function edge({ documentId, link, ordinal, sourceLine, targetAnchor, normalizedHref, status, diagnosticCode, toDocumentId }) {
  return {
    fromDocumentId: documentId,
    originalHref: link.href,
    normalizedHref,
    linkText: link.linkText || null,
    targetAnchor: targetAnchor || null,
    sourceLine,
    ordinal,
    status,
    diagnosticCode: diagnosticCode || null,
    toDocumentId: toDocumentId || null
  };
}

function splitHref(value) {
  const raw = String(value || '').trim();
  const hashIndex = raw.indexOf('#');
  const withoutAnchor = hashIndex < 0 ? raw : raw.slice(0, hashIndex);
  const queryIndex = withoutAnchor.indexOf('?');
  const pathHref = queryIndex < 0 ? withoutAnchor : withoutAnchor.slice(0, queryIndex);
  return {
    href: withoutAnchor,
    pathHref,
    query: queryIndex < 0 ? null : withoutAnchor.slice(queryIndex + 1),
    anchor: hashIndex < 0 ? null : raw.slice(hashIndex + 1) || null
  };
}

function isExternalHref(value) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(String(value || ''));
}

function isPathPolicyHref(value) {
  const raw = String(value || '');
  return /[\0]/.test(raw) ||
    /^file:/i.test(raw) ||
    /^[A-Za-z]:[\\/]/.test(raw) ||
    /^\\\\/.test(raw) ||
    /^\//.test(raw);
}

function pathPolicyDiagnostic(value) {
  const raw = String(value || '');
  if (/[\0]/.test(raw)) return 'nul_input';
  if (/^file:/i.test(raw)) return 'file_url';
  if (/^[A-Za-z]:[\\/]/.test(raw)) return 'windows_absolute_path';
  if (/^\\\\/.test(raw)) return 'unc_path';
  if (/^\//.test(raw)) return 'posix_absolute_path';
  return 'path_policy_violation';
}

function isMarkdownHref(value) {
  const withoutQuery = String(value || '').split('?')[0];
  return /\.md(?:own)?$/i.test(withoutQuery);
}

function ensureMarkdownExtension(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (/\.md(?:own)?(?:#.*)?$/i.test(trimmed)) return trimmed;
  return `${trimmed}.md`;
}

function stripTitle(value) {
  const raw = String(value || '').trim();
  if (raw.startsWith('<') && raw.endsWith('>')) return raw.slice(1, -1);
  const quotedTitle = raw.match(/^(\S+)\s+['"].*['"]$/);
  return quotedTitle ? quotedTitle[1] : raw;
}

function isWithinRoot(targetPath, rootPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function hasTraversalSegment(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .some((segment) => segment === '..');
}

function hasEncodedTraversal(value) {
  let current = String(value || '').toLowerCase();
  for (let i = 0; i < 4; i += 1) {
    if (/%2e|%2f|%5c/.test(current) && hasTraversalSegment(decodeSafe(current))) {
      return true;
    }
    const decoded = decodeSafe(current);
    if (decoded === current) return false;
    current = decoded.toLowerCase();
  }
  return hasTraversalSegment(current);
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

function decodeSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeRepeated(value) {
  let current = String(value || '');
  for (let i = 0; i < 4; i += 1) {
    const decoded = decodeSafe(current);
    if (decoded === current) break;
    current = decoded;
  }
  return current;
}

function lineNumberAt(content, index) {
  return String(content || '').slice(0, index).split(/\r?\n/).length;
}

function maskCode(content) {
  return String(content || '')
    .replace(/```[\s\S]*?```/g, (match) => match.replace(/[^\r\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (match) => ' '.repeat(match.length));
}

module.exports = {
  LinkGraphIndexer,
  createLinkGraphIndexer
};
