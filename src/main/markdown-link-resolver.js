'use strict';

/**
 * markdown-link-resolver — turns a markdown link into the markdown file it names.
 *
 * The renderer's markdown parser runs every href through encodeURI(), so a link
 * to `한글문서.md` reaches the click handler as `%ED%95%9C%EA%B8%80...md`.  Any
 * consumer that treats that string as a filesystem path fails on every non-ASCII
 * or spaced document name, so link navigation decodes and classifies here and
 * nowhere else; renderer code reaches this module through the
 * `resolve-link-target` IPC channel rather than re-implementing the rules.
 *
 * Two entry points, because the two inputs are different things and mixing them
 * up corrupts file names that legitimately contain percent sequences:
 *
 *   resolveMarkdownLinkTarget(href, base)      raw href from a rendered document
 *   resolveMarkdownDocumentPath(path, base)    a path this module already produced
 *
 * Sidebar tree building (link-parser.js) and the persistent link graph
 * (link-graph-indexer.js) classify links for their own purposes and keep their own
 * rules; only the markdown extension policy is shared with them.
 */

const path = require('path');

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
const DEFAULT_MARKDOWN_EXTENSION = '.md';

// A scheme prefix such as `javascript:` or `data:`, excluding Windows drive
// letters (`C:/`, `C:\`) which are legitimate absolute paths.
const SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:[/\\]/;

/**
 * The one markdown extension policy.
 *
 * @param {string} ext - Extension including the leading dot.
 * @returns {boolean}
 */
function isMarkdownExtension(ext) {
  return typeof ext === 'string' && MARKDOWN_EXTENSIONS.has(ext.toLowerCase());
}

/**
 * Whether a value can serve as the document that relative links resolve against.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isUsableLinkBase(value) {
  return typeof value === 'string' &&
    value !== '' &&
    !value.includes('\0') &&
    path.isAbsolute(value);
}

// A maximal run of complete `%XX` escapes. A bare `%` that is not part of one
// ends the run and stays literal.
const PERCENT_ESCAPE_RUN = /(?:%[0-9A-Fa-f]{2})+/g;

/**
 * Percent-decode a link href.
 *
 * Decoding is per run rather than whole-string because the markdown parser turns
 * an encoded `%` back into a bare one: a file named `진행률 80%.md` arrives as
 * `%EC%A7%84...%2080%.md`, where the trailing `%` is literal. Failing the whole
 * string there would leave the encoded text as the file name and the document
 * would never open. Runs that are not valid UTF-8 keep their original text.
 *
 * @param {string} value
 * @returns {string}
 */
function decodeHrefPath(value) {
  if (typeof value !== 'string' || value.indexOf('%') === -1) return value;
  return value.replace(PERCENT_ESCAPE_RUN, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/**
 * Drop the fragment and query suffixes of an href.
 *
 * encodeURI() leaves `#` and `?` untouched, so an href cannot distinguish a
 * fragment delimiter from those characters inside a file name. They are read as
 * delimiters, which is what browsers do and what this viewer has always done.
 *
 * @param {string} href
 * @returns {string}
 */
function stripHrefSuffix(href) {
  const hashIndex = href.indexOf('#');
  const queryIndex = href.indexOf('?');
  let endIndex = href.length;
  if (hashIndex >= 0) endIndex = Math.min(endIndex, hashIndex);
  if (queryIndex >= 0) endIndex = Math.min(endIndex, queryIndex);
  return href.slice(0, endIndex);
}

/**
 * Reject shapes that must never reach the filesystem: non-path schemes, network
 * locations, and embedded NUL bytes.
 *
 * Checked before decoding, after decoding, and again on the resolved path, so
 * neither percent-encoding nor separator normalization can produce a rejected
 * shape that slipped past an earlier check.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isRejectedPathShape(value) {
  if (typeof value !== 'string' || !value) return true;
  if (value.includes('\0')) return true;
  if (value.startsWith('//') || value.startsWith('\\\\')) return true;
  if (value.includes('://')) return true;
  return SCHEME_PREFIX.test(value) && !WINDOWS_DRIVE_PREFIX.test(value);
}

/**
 * Apply the markdown extension policy: keep markdown targets, add `.md` to
 * extension-less ones, reject everything else.
 *
 * @param {string} target
 * @returns {string|null}
 */
function applyMarkdownExtension(target) {
  const fileName = target.replace(/\\/g, '/').split('/').pop() || '';
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex <= 0) return target + DEFAULT_MARKDOWN_EXTENSION;
  return isMarkdownExtension(fileName.slice(dotIndex)) ? target : null;
}

/**
 * Resolve a markdown document path that is already free of href encoding.
 *
 * Use this for values produced by resolveMarkdownLinkTarget or read from the
 * filesystem. It never decodes and never strips a suffix, so percent sequences
 * and `#` characters that are part of a real file name survive intact.
 *
 * @param {string} filePath - Absolute path, or relative to baseFilePath.
 * @param {string} [baseFilePath] - Absolute path of the document being read.
 * @returns {string|null} Absolute markdown path, or null when the value does not
 *   name a reachable local markdown document.
 */
function resolveMarkdownDocumentPath(filePath, baseFilePath) {
  if (typeof filePath !== 'string') return null;

  const trimmed = filePath.trim();
  if (isRejectedPathShape(trimmed)) return null;

  const target = applyMarkdownExtension(trimmed);
  if (!target) return null;

  let resolved;
  if (path.isAbsolute(target)) {
    resolved = path.normalize(target);
  } else if (isUsableLinkBase(baseFilePath)) {
    resolved = path.resolve(path.dirname(baseFilePath), target);
  } else {
    // A relative target with no document to resolve against is unanswerable.
    // Guessing the working directory would silently open an unrelated file.
    return null;
  }

  return isRejectedPathShape(resolved) ? null : resolved;
}

/**
 * Resolve a markdown link href, exactly as written in a rendered document, to an
 * absolute markdown file path.
 *
 * @param {string} href
 * @param {string} [baseFilePath] - Absolute path of the document containing the
 *   link; relative hrefs resolve against its directory.
 * @returns {string|null} Absolute markdown path, or null when the href is not a
 *   local markdown document link.
 */
function resolveMarkdownLinkTarget(href, baseFilePath) {
  if (typeof href !== 'string') return null;

  const trimmed = href.trim();
  if (trimmed.startsWith('#') || isRejectedPathShape(trimmed)) return null;

  const decoded = decodeHrefPath(stripHrefSuffix(trimmed).trim());
  return resolveMarkdownDocumentPath(decoded, baseFilePath);
}

module.exports = {
  decodeHrefPath,
  isMarkdownExtension,
  isUsableLinkBase,
  resolveMarkdownDocumentPath,
  resolveMarkdownLinkTarget
};
