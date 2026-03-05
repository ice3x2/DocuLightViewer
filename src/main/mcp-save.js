// src/main/mcp-save.js — Shared MCP auto-save module (CJS)
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
 * Auto-save MCP content to disk.
 *
 * @param {import('electron-store')} store - Settings store
 * @param {{ content?: string, filePath?: string, title?: string, noSave?: boolean }} opts
 * @returns {Promise<string|null>} Saved file path, or null if skipped
 */
async function saveMcpFile(store, { content, filePath, title, noSave }) {
  if (noSave === true) return null;
  const enabled = store.get('mcpAutoSave', false);
  const savePath = store.get('mcpAutoSavePath', '');
  if (!enabled || !savePath) return null;

  const now = new Date();
  const dateFolder = [
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-');
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
      if (extracted) {
        nameCore = sanitizeFilenameWithUrlEncode(extracted);
      }
    }
    fileName = nameCore ? `${ts}_${nameCore}.md` : `${ts}.md`;
  }

  const dateFolderPath = path.join(savePath, dateFolder);
  const destPath = path.join(dateFolderPath, fileName);
  try {
    await fs.promises.mkdir(dateFolderPath, { recursive: true });
    if (filePath) {
      await fs.promises.copyFile(filePath, destPath);
    } else {
      await fs.promises.writeFile(destPath, content || '', 'utf-8');
    }
    console.log(`[doculight] MCP auto-save: ${destPath}`);
    return destPath;
  } catch (err) {
    console.error(`[doculight] MCP auto-save failed: ${err.message}`);
    return null;
  }
}

module.exports = { sanitizeFilenameWithUrlEncode, extractTitleFromContent, saveMcpFile };
