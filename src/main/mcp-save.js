// src/main/mcp-save.js — Shared MCP save module (CJS)
'use strict';

const path = require('path');
const fs = require('fs');

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

module.exports = { sanitizeFilenameWithUrlEncode, extractTitleFromContent, resolveSubDir, saveMcpFile, mcpManualSave };
