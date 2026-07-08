// src/main/mcp-save.js — Shared MCP save module (CJS)
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { injectFrontmatter, parseFrontmatter, buildYamlBlock, DOC_TYPE_VALUES } = require('./frontmatter');
const { createRedactor, redactToken } = require('./redaction');

const MAX_SAVE_DOCUMENT_BYTES = 10 * 1024 * 1024;
const SAVE_DOCUMENT_SCHEMA_VERSION = 'save_document.v1';
const SAVE_DOCUMENT_ALLOWED_FIELDS = new Set([
  'content',
  'title',
  'project',
  'docName',
  'description',
  'docType',
  'category',
  'documentTags',
  'gitContextPath'
]);
const SAVE_DOCUMENT_ERROR_CODES = new Set([
  'missing_content',
  'storage_not_configured',
  'validation_failed',
  'write_failed',
  'path_policy_violation'
]);
const SAVE_DOCUMENT_GIT_FRONTMATTER_FIELDS = new Set(['projectpath', 'gitremote', 'gitbranch', 'gitlastcommit']);
const CREDENTIAL_ASSIGNMENT_RE = /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|bearer|client[_-]?secret|password|passwd|pwd|secret|token)\s*=/i;

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

function hasCredentialAssignmentPathSegment(value) {
  const decoded = safeDecodeURIComponent(String(value || ''));
  return decoded.split(/[\\/]+/).some((segment) => CREDENTIAL_ASSIGNMENT_RE.test(segment));
}

function sanitizeFilenameWithUrlEncode(str) {
  const ENCODE_MAP = {
    '<': '%3C', '>': '%3E', ':': '%3A', '"': '%22',
    '/': '%2F', '\\': '%5C', '|': '%7C', '?': '%3F', '*': '%2A'
  };
  return str.replace(/[<>:"/\\|?*\x00-\x1f]/g, c => ENCODE_MAP[c] || encodeURIComponent(c));
}

function extractTitleFromContent(content) {
  if (!content) return null;
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^#{1,6}\s+(.+)/);
    if (m) return m[1].trim();
  }
  for (const line of lines) {
    const t = line.trim();
    if (t) return t.slice(0, 50);
  }
  return null;
}

function normalizeDocumentTags(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw saveDocumentError('validation_failed', 'documentTags must be an array of strings.', false);
  }
  if (value.length > 32) {
    throw saveDocumentError('validation_failed', 'documentTags may include at most 32 items.', false);
  }
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string') {
      throw saveDocumentError('validation_failed', 'documentTags items must be strings.', false);
    }
    const tag = raw.trim();
    if (!tag || tag.length > 64) {
      throw saveDocumentError('validation_failed', 'documentTags items must be 1..64 characters.', false);
    }
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

function sanitizeGitRemoteForSave(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.includes('\0')) return null;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch (_) {
      return null;
    }
    if (url.protocol === 'file:') return null;
    if (hasCredentialAssignmentPathSegment(url.pathname)) return null;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  if (path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw) || /^~(?:[/\\]|$)/.test(raw)) {
    return null;
  }
  if (CREDENTIAL_ASSIGNMENT_RE.test(safeDecodeURIComponent(raw))) {
    return null;
  }
  const scpLike = raw.match(/^([^@\s]+)@([^:\s]+):(.+)$/);
  if (!scpLike) return null;
  const scpPath = scpLike[3];
  if (!scpPath
    || path.win32.isAbsolute(scpPath)
    || path.posix.isAbsolute(scpPath)
    || scpPath.includes('\\')
    || scpPath.includes(':')
    || /^~(?:[/\\]|$)/.test(scpPath)
    || scpPath.includes('..')
    || hasCredentialAssignmentPathSegment(scpPath)
    || /[?&#]/.test(scpPath)) {
    return null;
  }
  return raw;
}

function sanitizeSaveDocumentGitInfo(gitInfo = {}) {
  const safe = { ...gitInfo };
  delete safe.projectPath;

  const gitRemote = sanitizeGitRemoteForSave(safe.gitRemote);
  if (gitRemote) {
    safe.gitRemote = gitRemote;
  } else {
    delete safe.gitRemote;
  }
  return safe;
}

function stripSaveDocumentGitFrontmatter(content) {
  if (typeof content !== 'string') return content;
  const parsed = parseFrontmatter(content);
  if (!parsed || !parsed.data || Object.keys(parsed.data).length === 0) return content;

  const safeFields = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (SAVE_DOCUMENT_GIT_FRONTMATTER_FIELDS.has(String(key).toLowerCase())) continue;
    safeFields[key] = value;
  }
  return buildYamlBlock(safeFields) + parsed.body;
}

/**
 * Resolve subdirectory format tokens into an actual path segment.
 * Supported tokens: {yyyy}, {mm}, {dd}, {yyyy-mm-dd}, {HH}, {MM}, {ss}, {project}, {severity}, {type}
 */
function resolveSubDir(format, { project, severity, docType } = {}) {
  if (!format) return '';
  const now = new Date();
  const tokens = {
    '{yyyy}': String(now.getFullYear()),
    '{mm}': String(now.getMonth() + 1).padStart(2, '0'),
    '{dd}': String(now.getDate()).padStart(2, '0'),
    '{yyyy-mm-dd}': [
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')
    ].join('-'),
    '{HH}': String(now.getHours()).padStart(2, '0'),
    '{MM}': String(now.getMinutes()).padStart(2, '0'),
    '{ss}': String(now.getSeconds()).padStart(2, '0'),
    '{project}': sanitizeFilenameWithUrlEncode(project || 'default'),
    '{severity}': sanitizeFilenameWithUrlEncode(severity || 'general'),
    '{type}': sanitizeFilenameWithUrlEncode(docType || 'note')
  };
  let result = format;
  for (const [token, value] of Object.entries(tokens)) {
    result = result.split(token).join(value);
  }
  // Normalize separators to OS-native
  result = result.replace(/[/\\]+/g, path.sep);
  // Strip leading/trailing separators
  result = result.replace(new RegExp(`^\\${path.sep}+|\\${path.sep}+$`, 'g'), '');
  return result;
}

/**
 * Build destination path and filename — shared by saveMcpFile and mcpManualSave.
 * @returns {{ destDir: string, destPath: string, fileName: string }}
 */
function buildDestPath(basePath, subDirFormat, { filePath, title, content, project, severity, docType }) {
  const subDir = resolveSubDir(subDirFormat, { project, severity, docType });
  const now = new Date();
  const ts = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('');

  let fileName;
  if (filePath) {
    fileName = `${ts}_${path.basename(filePath)}`;
  } else {
    let nameCore = null;
    if (title) {
      nameCore = sanitizeFilenameWithUrlEncode(title.trim());
    } else {
      const extracted = extractTitleFromContent(content);
      if (extracted) nameCore = sanitizeFilenameWithUrlEncode(extracted);
    }
    fileName = nameCore ? `${ts}_${nameCore}.md` : `${ts}.md`;
  }

  const destDir = subDir ? path.join(basePath, subDir) : basePath;
  const destPath = path.join(destDir, fileName);
  return { destDir, destPath, fileName };
}

function buildSaveDocumentDestPath(basePath, subDirFormat, { resolvedTitle, content, project, docType }) {
  const subDir = resolveSubDir(subDirFormat, { project, docType });
  assertSafeRelativePath(subDir, 'save subdirectory');
  const now = new Date();
  const ts = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
    String(now.getMilliseconds()).padStart(3, '0')
  ].join('');
  const title = resolvedTitle || extractTitleFromContent(content) || 'document';
  const safeTitle = sanitizeFilenameWithUrlEncode(title).slice(0, 120) || 'document';
  const fileName = `${ts}_${safeTitle}.md`;
  assertSafeRelativePath(fileName, 'save filename');
  const destDir = subDir ? path.join(basePath, subDir) : basePath;
  return { destDir, destPath: path.join(destDir, fileName), fileName };
}

/**
 * Write content to dest path (shared core).
 * @returns {Promise<string>} saved file path
 */
async function writeToDestPath(destDir, destPath, { filePath, content }) {
  await fs.promises.mkdir(destDir, { recursive: true });
  if (filePath) {
    await fs.promises.copyFile(filePath, destPath);
  } else {
    await fs.promises.writeFile(destPath, content || '', 'utf-8');
  }
  return destPath;
}

async function writeContainedMarkdown(basePath, destDir, destPath, content) {
  const root = path.resolve(basePath);
  const initialDest = path.resolve(destPath);
  if (!isWithinOrEqual(initialDest, root)) {
    throw saveDocumentError('path_policy_violation', 'Resolved save path is outside the configured document store.', false);
  }
  await fs.promises.mkdir(root, { recursive: true });
  assertExistingAncestorContained(root, destDir);
  await fs.promises.mkdir(destDir, { recursive: true });
  assertExistingAncestorContained(root, destDir);
  const rootReal = realpath(root);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = attempt === 0 ? initialDest : withCollisionSuffix(initialDest, attempt + 1);
    if (!isWithinOrEqual(candidate, root)) {
      throw saveDocumentError('path_policy_violation', 'Resolved save path is outside the configured document store.', false);
    }
    const candidateDir = path.dirname(candidate);
    assertNoSymlinkAncestors(rootReal, candidateDir);
    let handle = null;
    try {
      handle = await fs.promises.open(candidate, 'wx');
      assertSavedFileContained(rootReal, candidate);
      await handle.writeFile(content || '', 'utf-8');
      await handle.close();
      assertSavedFileContained(rootReal, candidate);
      return candidate;
    } catch (err) {
      if (handle) {
        try { await handle.close(); } catch {}
      }
      if (err && err.code === 'EEXIST') continue;
      throw err;
    }
  }
  throw saveDocumentError('write_failed', 'Could not allocate a unique save_document filename.', true);
}

/**
 * Auto-save MCP content to disk (only when mcpAutoSave is enabled).
 *
 * @param {import('electron-store')} store
 * @param {{ content?: string, filePath?: string, title?: string, noSave?: boolean, project?: string }} opts
 * @returns {Promise<string|null>} Saved file path, or null if skipped
 */
async function saveMcpFile(store, { content, filePath, title, noSave, project, severity, docType }) {
  if (noSave === true) return null;
  const enabled = store.get('mcpAutoSave', false);
  const basePath = store.get('mcpAutoSavePath', '');
  if (!enabled || !basePath) return null;

  const subDirFormat = store.get('mcpSaveSubDir', '');
  const { destDir, destPath } = buildDestPath(basePath, subDirFormat, { filePath, title, content, project, severity, docType });

  try {
    const saved = await writeToDestPath(destDir, destPath, { filePath, content });
    console.log(`[doculight] MCP auto-save: ${saved}`);
    return saved;
  } catch (err) {
    console.error(`[doculight] MCP auto-save failed: ${err.message}`);
    return null;
  }
}

async function saveMcpUpdatedContent(store, entry, params = {}, searchEngine) {
  if (!entry || params.noSave === true) {
    return { savedPath: null, skipped: true };
  }

  const enabled = store.get('mcpAutoSave', false);
  const content = entry.meta.lastRenderedContent || params.content || '';
  const sourceFilePath = params.filePath || entry.meta.filePath || null;
  if (!enabled || (!content && !sourceFilePath)) {
    return { savedPath: null, skipped: true };
  }

  let savedPath = entry.meta.savedFilePath || null;
  if (savedPath) {
    if (content) {
      await fs.promises.writeFile(savedPath, content, 'utf-8');
    } else if (sourceFilePath) {
      await fs.promises.copyFile(sourceFilePath, savedPath);
    }
  } else {
    savedPath = await saveMcpFile(store, {
      content,
      filePath: content ? undefined : sourceFilePath,
      title: params.title || entry.meta.title,
      noSave: params.noSave,
      project: params.project || entry.meta.project,
      severity: params.severity || entry.meta.severity,
      docType: params.docType || entry.meta.docType
    });
  }

  if (savedPath) {
    entry.meta.savedFilePath = savedPath;
    if (searchEngine && typeof searchEngine.markDirty === 'function') {
      searchEngine.markDirty({
        filePath: savedPath,
        content: content || null,
        requestedBy: 'mcp.update_markdown'
      });
    }
  }

  return { savedPath, skipped: !savedPath };
}

/**
 * Manual save MCP content (works regardless of mcpAutoSave setting).
 *
 * @param {import('electron-store')} store
 * @param {{ content?: string, filePath?: string, title?: string, project?: string }} opts
 * @returns {Promise<{success: boolean, filePath?: string, errorKey?: string, errorDetail?: string}>}
 */
async function mcpManualSave(store, { content, filePath, title, project, severity, docType }) {
  const basePath = store.get('mcpAutoSavePath', '');
  if (!basePath) {
    return { success: false, errorKey: 'viewer.saveErrorNoDir' };
  }

  const subDirFormat = store.get('mcpSaveSubDir', '');
  const { destDir, destPath } = buildDestPath(basePath, subDirFormat, { filePath, title, content, project, severity, docType });

  try {
    const saved = await writeToDestPath(destDir, destPath, { filePath, content });
    console.log(`[doculight] MCP manual save: ${saved}`);
    return { success: true, filePath: saved };
  } catch (err) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      return { success: false, errorKey: 'viewer.saveErrorPermission' };
    }
    return { success: false, errorKey: 'viewer.saveErrorGeneric', errorDetail: err.message };
  }
}

// @req FR-DOC-028
async function saveDocumentToStore(store, params = {}, searchEngine) {
  const redactor = createRedactor({
    userDataDir: store.get('userDataPath', ''),
    sourceRoots: [store.get('mcpAutoSavePath', '')].filter(Boolean)
  });
  try {
    const input = validateSaveDocumentParams(params, store, redactor);
    const enabled = store.get('mcpAutoSave', false);
    const basePath = store.get('mcpAutoSavePath', '');
    if (!enabled || !basePath) {
      throw saveDocumentError('storage_not_configured', 'DocuLight document store is not configured.', true);
    }

    let gitInfo = {};
    if (input.gitContextPath && store.get('mcpGitInfo', true)) {
      const { collectGitInfo } = require('./git-info');
      gitInfo = sanitizeSaveDocumentGitInfo(await collectGitInfo(input.gitContextPath));
    }
    if (input.project) gitInfo.project = input.project;

    const parsed = parseFrontmatter(input.content);
    const resolvedTitle = input.docName || input.title || parsed.data.docName || parsed.data.title || extractTitleFromContent(parsed.body) || timestampTitle();
    const docType = input.docType || parsed.data.docType || 'note';
    const category = input.category || parsed.data.category || null;
    const documentTags = input.documentTags.length > 0
      ? input.documentTags
      : normalizeLooseDocumentTags(parsed.data.documentTags || parsed.data.tags || readFrontmatterList(input.content, 'documentTags') || readFrontmatterList(input.content, 'tags'));
    const content = injectFrontmatter(stripSaveDocumentGitFrontmatter(input.content), {
      project: input.project || gitInfo.project,
      docName: input.docName || resolvedTitle,
      description: input.description,
      docType,
      category,
      documentTags,
      ...gitInfo
    });

    const subDirFormat = store.get('mcpSaveSubDir', '');
    const { destDir, destPath } = buildSaveDocumentDestPath(basePath, subDirFormat, {
      resolvedTitle,
      content,
      project: input.project || gitInfo.project,
      docType
    });
    const savedPath = await writeContainedMarkdown(basePath, destDir, destPath, content);
    const sourceRelativePath = path.relative(path.resolve(basePath), savedPath).replace(/\\/g, '/');
    let document = null;
    let queueResult = null;
    const warnings = [];
    if (searchEngine && typeof searchEngine.queueDocumentIndex === 'function') {
      queueResult = searchEngine.queueDocumentIndex({
        filePath: savedPath,
        content,
        requestedBy: 'mcp.save_document',
        metadata: { docType, category, documentTags }
      });
      document = queueResult.document || null;
      if (!queueResult.queued) {
        warnings.push({ code: 'index_enqueue_failed', message: 'Document was saved but indexing enqueue failed.', retryable: true });
      }
    } else if (searchEngine && typeof searchEngine.markDirty === 'function') {
      searchEngine.markDirty({ filePath: savedPath, content, requestedBy: 'mcp.save_document' });
    }

    const documentId = document && document.documentId
      ? document.documentId
      : `doc_${stableHash(sourceRelativePath).slice(0, 24)}`;
    const payload = {
      schemaVersion: SAVE_DOCUMENT_SCHEMA_VERSION,
      saved: true,
      documentId,
      sourceRelativePath,
      resolvedTitle,
      project: input.project || gitInfo.project || null,
      docType,
      category,
      documentTags,
      indexing: {
        state: queueResult && queueResult.queued ? 'queued' : (warnings.length ? 'enqueue_failed' : 'degraded')
      },
      warnings
    };
    if (queueResult && queueResult.jobId) payload.indexing.jobId = queueResult.jobId;
    return { content: [{ type: 'text', text: canonicalJson(payload) }] };
  } catch (err) {
    const rawCode = err && err.code ? err.code : 'write_failed';
    const code = SAVE_DOCUMENT_ERROR_CODES.has(rawCode) ? rawCode : 'write_failed';
    const retryable = err && Object.prototype.hasOwnProperty.call(err, 'retryable') ? err.retryable : code === 'write_failed';
    const message = redactor.redactString(err && err.message ? err.message : String(err));
    return {
      isError: true,
      content: [{
        type: 'text',
        text: canonicalJson({
          schemaVersion: SAVE_DOCUMENT_SCHEMA_VERSION,
          saved: false,
          error: { code, message, retryable },
          warnings: []
        })
      }]
    };
  }
}

function validateSaveDocumentParams(params, store, redactor) {
  const keys = Object.keys(params || {});
  const extras = keys.filter((key) => !SAVE_DOCUMENT_ALLOWED_FIELDS.has(key));
  if (extras.length > 0) {
    throw saveDocumentError('validation_failed', `Unsupported save_document field(s): ${extras.join(', ')}`, false);
  }
  const content = params.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw saveDocumentError('missing_content', 'save_document requires non-empty Markdown content.', false);
  }
  if (Buffer.byteLength(content, 'utf-8') > MAX_SAVE_DOCUMENT_BYTES) {
    throw saveDocumentError('validation_failed', 'content exceeds the 10MB save_document limit.', false);
  }
  const input = {
    content,
    title: optionalString(params.title, 'title', 1, 200),
    project: optionalString(params.project, 'project', 1, 120),
    docName: optionalString(params.docName, 'docName', 1, 160),
    description: optionalString(params.description, 'description', 0, 1000),
    docType: params.docType == null ? null : String(params.docType),
    category: optionalString(params.category, 'category', 1, 120),
    documentTags: normalizeDocumentTags(params.documentTags),
    gitContextPath: optionalString(params.gitContextPath, 'gitContextPath', 1, 1024)
  };
  if (input.docType && !DOC_TYPE_VALUES.includes(input.docType)) {
    throw saveDocumentError('validation_failed', 'docType must be one of DOC_TYPE_VALUES.', false);
  }
  if (input.gitContextPath) validateGitContextPath(input.gitContextPath, store, redactor);
  return input;
}

function normalizeLooseDocumentTags(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  const raw = String(value).trim();
  if (!raw) return [];
  const withoutBrackets = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  return [...new Set(withoutBrackets
    .split(/[,\n]/)
    .map((item) => item.trim().replace(/^[-\s]+/, '').replace(/^['"]|['"]$/g, ''))
    .filter(Boolean))];
}

function readFrontmatterList(content, key) {
  const match = String(content || '').match(/^---\r?\n([\s\S]*?\r?\n)?---\r?\n?/);
  if (!match) return null;
  const lines = String(match[1] || '').split(/\r?\n/);
  const keyRe = new RegExp(`^${escapeRegExp(key)}\\s*:\\s*(.*)$`);
  for (let i = 0; i < lines.length; i += 1) {
    const keyMatch = lines[i].match(keyRe);
    if (!keyMatch) continue;
    if (keyMatch[1].trim()) return keyMatch[1].trim();
    const values = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (/^\S[^:]*:\s*/.test(line)) break;
      const item = line.match(/^\s*-\s*(.+?)\s*$/);
      if (item) values.push(item[1]);
    }
    return values.length ? values : null;
  }
  return null;
}

function validateGitContextPath(value, store, redactor) {
  const raw = String(value);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^file:/i.test(raw) || /[?&](api[_-]?key|token|password|secret)=/i.test(raw)) {
    throw saveDocumentError('validation_failed', 'gitContextPath must be a local filesystem path.', false);
  }
  if (hasCredentialAssignmentPathSegment(raw)) {
    throw saveDocumentError('validation_failed', 'gitContextPath must not contain credential-like path segments.', false);
  }
  if (!path.isAbsolute(raw)) {
    throw saveDocumentError('validation_failed', 'gitContextPath must be absolute local filesystem path.', false);
  }
  const basePath = store.get('mcpAutoSavePath', '');
  if (basePath) {
    const resolvedBase = path.resolve(basePath);
    const resolvedGit = path.resolve(raw);
    if (isWithinOrEqual(resolvedGit, resolvedBase)) {
      throw saveDocumentError('validation_failed', `gitContextPath must not override the configured document store ${redactor.redactPath(resolvedBase)}`, false);
    }
  }
}

function optionalString(value, name, min, max) {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw saveDocumentError('validation_failed', `${name} must be a string.`, false);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw saveDocumentError('validation_failed', `${name} must be ${min}..${max} characters.`, false);
  }
  return trimmed;
}

function assertSafeRelativePath(value, label) {
  if (!value) return;
  const normalized = String(value).replace(/\\/g, '/');
  if (path.isAbsolute(value) || normalized.includes('\0') || normalized.split('/').some((segment) => segment === '..')) {
    throw saveDocumentError('path_policy_violation', `${label} violates the document store path policy.`, false);
  }
}

function assertExistingAncestorContained(root, destDir) {
  let current = path.resolve(destDir);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const rootReal = fs.realpathSync.native ? fs.realpathSync.native(root) : fs.realpathSync(root);
  const currentReal = fs.realpathSync.native ? fs.realpathSync.native(current) : fs.realpathSync(current);
  if (!isWithinOrEqual(currentReal, rootReal)) {
    throw saveDocumentError('path_policy_violation', 'Existing save ancestor escapes the configured document store.', false);
  }
}

function assertSavedFileContained(root, savedPath) {
  const rootReal = fs.existsSync(root) ? realpath(root) : root;
  const savedReal = realpath(savedPath);
  if (!isWithinOrEqual(savedReal, rootReal)) {
    throw saveDocumentError('path_policy_violation', 'Saved file escapes the configured document store.', false);
  }
}

function assertNoSymlinkAncestors(rootReal, targetDir) {
  const resolvedTargetDir = path.resolve(targetDir);
  if (!isWithinOrEqual(resolvedTargetDir, rootReal)) {
    throw saveDocumentError('path_policy_violation', 'Save directory escapes the configured document store.', false);
  }
  let current = rootReal;
  const relative = path.relative(rootReal, resolvedTargetDir);
  if (!relative) return;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw saveDocumentError('path_policy_violation', 'Save path contains a symlink ancestor.', false);
    }
  }
}

function withCollisionSuffix(filePath, suffix) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  return path.join(dir, `${base}-${suffix}${ext}`);
}

function realpath(value) {
  return fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);
}

function isWithinOrEqual(targetPath, rootPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function saveDocumentError(code, message, retryable) {
  const err = new Error(message);
  err.code = code;
  err.retryable = retryable;
  return err;
}

function timestampTitle() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  sanitizeFilenameWithUrlEncode,
  extractTitleFromContent,
  resolveSubDir,
  saveMcpFile,
  saveMcpUpdatedContent,
  mcpManualSave,
  saveDocumentToStore
};
