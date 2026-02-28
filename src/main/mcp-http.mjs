// src/main/mcp-http.mjs — HTTP JSON-RPC MCP server embedded in Electron
// ESM module, loaded via dynamic import() from index.js (CJS)
//
// Simple JSON-RPC 2.0 implementation over HTTP POST.
// No SDK transport, no SSE, no session management — just request/response.

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const { injectFrontmatter } = _require('./frontmatter.js');

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB
const PROTOCOL_VERSION = '2025-03-26';
const SERVER_INFO = { name: 'doculight', version: '1.0.0' };

// ============================================================================
// MCP Auto-Save Helpers
// ============================================================================

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

async function saveMcpFile({ content, filePath, title, noSave }, store) {
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

// ============================================================================
// Tool definitions (MCP tools/list format)
// ============================================================================

const TOOLS = [
  {
    name: 'open_markdown',
    description: 'Open a Markdown document in the DocuLight viewer. Provide either content (raw Markdown string) or filePath (absolute path to .md file). Returns windowId for future reference. IMPORTANT: Always provide project, docName, and description when the context is known.',
    inputSchema: {
      type: 'object',
      properties: {
        content:          { type: 'string', description: 'Raw Markdown content to display' },
        filePath:         { type: 'string', description: 'Absolute path to a .md file to open' },
        title:            { type: 'string', description: 'Custom window title' },
        foreground:       { type: 'boolean', description: 'Bring window to foreground (default: true)' },
        alwaysOnTop:      { type: 'boolean', description: 'Keep window above others (default: true)' },
        size:             { type: 'string', enum: ['s', 'm', 'l', 'f'], description: 'Window size preset' },
        windowName:       { type: 'string', description: 'Named window key — reuses existing window if name matches (upsert)' },
        severity:         { type: 'string', enum: ['info', 'success', 'warning', 'error'], description: 'Severity color bar at window top' },
        tags:             { type: 'array', items: { type: 'string' }, description: 'Tags for grouping windows' },
        flash:            { type: 'boolean', description: 'Flash taskbar button to notify user' },
        progress:         { type: 'number', minimum: -1, maximum: 1, description: 'Taskbar progress bar value (-1 to remove, 0.0–1.0)' },
        autoCloseSeconds: { type: 'integer', minimum: 1, maximum: 3600, description: 'Auto-close window after N seconds' },
        project:          { type: 'string', description: '[Recommended] Project or repository name for frontmatter metadata' },
        docName:          { type: 'string', description: '[Recommended] Document name or type for frontmatter metadata' },
        description:      { type: 'string', description: '[Recommended] One-line summary of document purpose. STRONGLY RECOMMENDED.' },
        noSave:           { type: 'boolean', description: 'Skip auto-save for this call even if mcpAutoSave is enabled (default: false)' }
      }
    }
  },
  {
    name: 'update_markdown',
    description: 'Update the content of an existing DocuLight viewer window.',
    inputSchema: {
      type: 'object',
      properties: {
        windowId:         { type: 'string', description: 'ID of the window to update' },
        content:          { type: 'string', description: 'New Markdown content' },
        filePath:         { type: 'string', description: 'Absolute path to a .md file' },
        title:            { type: 'string', description: 'New window title' },
        appendMode:       { type: 'boolean', description: 'Append content to existing window content instead of replacing' },
        separator:        { type: 'string', description: 'Separator between existing and new content (default: \\n\\n)' },
        severity:         { type: 'string', enum: ['info', 'success', 'warning', 'error', ''], description: 'Update severity color bar (empty string to clear)' },
        tags:             { type: 'array', items: { type: 'string' }, description: 'Replace window tags' },
        flash:            { type: 'boolean', description: 'Flash taskbar button' },
        progress:         { type: 'number', minimum: -1, maximum: 1, description: 'Update taskbar progress bar' },
        autoCloseSeconds: { type: 'integer', minimum: 1, maximum: 3600, description: 'Reset/set auto-close timer' },
        project:          { type: 'string', description: '[Recommended] Project name for frontmatter metadata' },
        docName:          { type: 'string', description: '[Recommended] Document name for frontmatter metadata' },
        description:      { type: 'string', description: '[Recommended] Document description for frontmatter metadata' },
        noSave:           { type: 'boolean', description: 'Skip auto-save for this call even if mcpAutoSave is enabled (default: false)' }
      },
      required: ['windowId']
    }
  },
  {
    name: 'close_viewer',
    description: 'Close DocuLight viewer window(s). If windowId is provided, closes that specific window. If tag is provided, closes all matching windows. Otherwise, closes all.',
    inputSchema: {
      type: 'object',
      properties: {
        windowId: { type: 'string', description: 'ID of a specific window to close (omit to close all)' },
        tag:      { type: 'string', description: 'Close all windows with this tag' }
      }
    }
  },
  {
    name: 'list_viewers',
    description: 'List all currently open DocuLight viewer windows.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Filter windows by tag' }
      }
    }
  },
  {
    name: 'search_documents',
    description: 'Search saved markdown documents using BM25 full-text search. Searches across document body and frontmatter metadata (title, project, description). Requires mcpAutoSave to be enabled with a configured save path.',
    inputSchema: {
      type: 'object',
      properties: {
        query:   { type: 'string', description: 'Search query (Korean and English supported)' },
        limit:   { type: 'integer', minimum: 1, maximum: 100, description: 'Max results (default: 20)' },
        project: { type: 'string', description: 'Filter by project name' }
      },
      required: ['query']
    }
  },
  {
    name: 'search_projects',
    description: 'Search or list projects from saved document frontmatter metadata. Returns project names with descriptions and associated document counts. Requires mcpAutoSave to be enabled with a configured save path.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query for project name/description (omit for full list)' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max results (default: 20)' }
      }
    }
  }
];

// ============================================================================
// Tool handlers
// ============================================================================

function createToolHandlers(windowManager, store, searchEngine) {
  return {
    async open_markdown({ content, filePath, title, foreground, alwaysOnTop, size,
                          windowName, severity, tags, flash, progress, autoCloseSeconds, noSave,
                          project, docName, description }) {
      if (!content && !filePath) {
        return { isError: true, content: [{ type: 'text', text: 'content or filePath is required.' }] };
      }
      if (content && Buffer.byteLength(content, 'utf8') > MAX_BODY_SIZE) {
        return { isError: true, content: [{ type: 'text', text: 'Content exceeds 10MB limit.' }] };
      }

      // Frontmatter injection
      if (content && (project || docName || description)) {
        content = injectFrontmatter(content, { project, docName, description });
      }

      const result = await windowManager.createWindow({
        content, filePath, title,
        foreground: foreground ?? true,
        size: size ?? 'm',
        windowName, severity, tags, flash, progress, autoCloseSeconds,
        project, docName, description
      });

      let savedPath = null;
      try {
        savedPath = await saveMcpFile({ content, filePath, title, noSave }, store);
        if (savedPath && searchEngine) searchEngine.markDirty();
      } catch (err) {
        console.error('[doculight] MCP auto-save error:', err.message);
      }

      const entry = windowManager.getWindowEntry(result.windowId);
      if (entry) {
        // Store savedFilePath in meta and notify renderer (FR-21-001)
        if (savedPath) {
          entry.meta.savedFilePath = savedPath;
          if (!entry.win.isDestroyed()) {
            entry.win.webContents.send('set-saved-file-path', { savedFilePath: savedPath });
          }
        }

        // alwaysOnTop defaults to true for HTTP MCP
        const pinned = alwaysOnTop ?? true;
        entry.win.setAlwaysOnTop(pinned);
        entry.meta.alwaysOnTop = pinned;
        entry.win.webContents.send('always-on-top-changed', { alwaysOnTop: pinned });

        // Hide sidebar & TOC for size m or smaller (only for newly created windows)
        if (!result.upserted) {
          const resolvedSize = size ?? 'm';
          if (resolvedSize === 's' || resolvedSize === 'm') {
            entry.win.webContents.send('panel-visibility', { sidebar: false, toc: false });
          }
        }
      }

      if (result.upserted) {
        return {
          content: [{ type: 'text', text: `Updated existing window (named: ${result.windowName}).\n  windowId: ${result.windowId}\n  title: ${result.title}` }]
        };
      }
      return {
        content: [{ type: 'text', text: `Opened viewer window.\n  windowId: ${result.windowId}\n  title: ${result.title}${result.windowName ? `\n  windowName: ${result.windowName}` : ''}` }]
      };
    },

    async update_markdown({ windowId, content, filePath, title, appendMode, separator,
                            severity, tags, flash, progress, autoCloseSeconds,
                            project, docName, description }) {
      if (!windowId) {
        return { isError: true, content: [{ type: 'text', text: 'windowId is required.' }] };
      }

      // Frontmatter injection (skip for appendMode)
      if (content && !appendMode && (project || docName || description)) {
        content = injectFrontmatter(content, { project, docName, description });
      }

      const result = await windowManager.updateWindow(windowId, {
        content, filePath, title, appendMode, separator,
        severity, tags, flash, progress, autoCloseSeconds,
        project, docName, description
      });

      const action = appendMode ? 'Appended to' : 'Updated';
      return {
        content: [{ type: 'text', text: `${action} window ${windowId}.\n  title: ${result.title}` }]
      };
    },

    async close_viewer({ windowId, tag }) {
      const result = windowManager.closeWindow(windowId || undefined, { tag });
      let target;
      if (windowId) target = `window ${windowId}`;
      else if (tag) target = `windows with tag "${tag}"`;
      else target = 'all windows';
      return {
        content: [{ type: 'text', text: `Closed ${target}. (${result.closed} window(s) closed)` }]
      };
    },

    async list_viewers({ tag } = {}) {
      const windows = windowManager.listWindows({ tag });
      if (windows.length === 0) {
        return { content: [{ type: 'text', text: 'No viewer windows are currently open.' }] };
      }
      const lines = windows.map((w, i) => {
        let line = `  ${i + 1}. [${w.windowId}] "${w.title}"`;
        if (w.alwaysOnTop) line += ' (pinned)';
        if (w.windowName) line += ` (named: ${w.windowName})`;
        if (w.severity) line += ` (severity: ${w.severity})`;
        if (w.tags && w.tags.length > 0) line += ` [tags: ${w.tags.join(', ')}]`;
        if (w.progress !== undefined) line += ` (progress: ${Math.round(w.progress * 100)}%)`;
        return line;
      });
      return {
        content: [{ type: 'text', text: `Open viewer windows (${windows.length}):\n${lines.join('\n')}` }]
      };
    },

    async search_documents({ query, limit, project }) {
      if (!query) {
        return { isError: true, content: [{ type: 'text', text: 'query is required.' }] };
      }
      if (!searchEngine) {
        return { isError: true, content: [{ type: 'text', text: 'Search engine not available. Ensure mcpAutoSave is enabled.' }] };
      }
      await searchEngine.ensureFresh();
      const results = searchEngine.search(query, { limit: limit || 20, project });
      const totalIndexed = searchEngine.docMeta.size;

      if (results.length === 0) {
        return { content: [{ type: 'text', text: `No results found for "${query}". (${totalIndexed} documents indexed)` }] };
      }

      const lines = results.map((r, i) =>
        `${i + 1}. [${r.score}] ${r.title}${r.project ? ` (${r.project})` : ''}\n   ${r.filePath}\n   ${r.snippet || ''}`
      );
      return {
        content: [{
          type: 'text',
          text: `Found ${results.length} result(s) for "${query}" (${totalIndexed} indexed):\n\n${lines.join('\n\n')}`
        }]
      };
    },

    async search_projects({ query, limit } = {}) {
      if (!searchEngine) {
        return { isError: true, content: [{ type: 'text', text: 'Search engine not available. Ensure mcpAutoSave is enabled.' }] };
      }
      await searchEngine.ensureFresh();
      const projects = searchEngine.searchProjects(query, limit || 20);

      if (projects.length === 0) {
        return { content: [{ type: 'text', text: query ? `No projects found for "${query}".` : 'No projects found.' }] };
      }

      const lines = projects.map(p =>
        `- **${p.project}** (${p.documentCount} docs)${p.description ? `: ${p.description}` : ''}`
      );
      return {
        content: [{
          type: 'text',
          text: `${query ? `Projects matching "${query}"` : 'All projects'} (${projects.length}):\n\n${lines.join('\n')}`
        }]
      };
    }
  };
}

// ============================================================================
// JSON-RPC 2.0 helpers
// ============================================================================

function jsonrpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonrpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

// ============================================================================
// Request body reader
// ============================================================================

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ============================================================================
// JSON-RPC method router
// ============================================================================

async function handleJsonRpc(msg, handlers) {
  const { id, method, params } = msg;

  if (!method || typeof method !== 'string') {
    return jsonrpcError(id, -32600, 'Invalid Request: missing method');
  }

  switch (method) {
    // --- MCP lifecycle ---
    case 'initialize':
      return jsonrpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      });

    case 'notifications/initialized':
      // Notification — no response required
      return null;

    case 'ping':
      return jsonrpcResult(id, {});

    // --- MCP tools ---
    case 'tools/list':
      return jsonrpcResult(id, { tools: TOOLS });

    case 'tools/call': {
      const toolName = params?.name;
      const args = params?.arguments || {};

      const handler = handlers[toolName];
      if (!handler) {
        return jsonrpcResult(id, {
          isError: true,
          content: [{ type: 'text', text: `Unknown tool: ${toolName}` }]
        });
      }

      try {
        const result = await handler(args);
        return jsonrpcResult(id, result);
      } catch (err) {
        return jsonrpcResult(id, {
          isError: true,
          content: [{ type: 'text', text: `Error: ${err.message}` }]
        });
      }
    }

    default:
      return jsonrpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ============================================================================
// Exported entry point
// ============================================================================

/**
 * Start an HTTP JSON-RPC MCP server inside the Electron main process.
 *
 * @param {import('./window-manager').WindowManager} windowManager
 * @param {import('electron-store')} store
 * @returns {Promise<http.Server>}
 */
export async function startMcpHttpServer(windowManager, store, userDataPath, searchEngine) {
  const basePort = store.get('mcpPort') || 52580;
  const handlers = createToolHandlers(windowManager, store, searchEngine);

  const httpServer = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id'
      });
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // GET /mcp — SSE stream for server-to-client notifications (MCP Streamable HTTP spec)
    // Claude Code HTTP transport requires this endpoint to be available.
    // DocuLight has no server-initiated messages, so the stream stays open silently.
    if (url.pathname === '/mcp' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      // Flush headers immediately so clients can detect the SSE connection
      res.write(': ok\n\n');
      // Send a comment every 15 s to prevent proxies from closing the connection
      const keepAlive = setInterval(() => {
        if (!res.writableEnded) res.write(': keep-alive\n\n');
      }, 15000);
      req.on('close', () => clearInterval(keepAlive));
      return;
    }

    // DELETE /mcp — session termination (stateless: just acknowledge)
    if (url.pathname === '/mcp' && req.method === 'DELETE') {
      res.writeHead(405, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ error: 'Session termination not supported (stateless server)' }));
      return;
    }

    // Only POST /mcp for JSON-RPC
    if (url.pathname !== '/mcp' || req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'GET, POST, or DELETE /mcp only' }));
      return;
    }

    try {
      const bodyStr = await readBody(req);
      let body;
      try {
        body = JSON.parse(bodyStr);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jsonrpcError(null, -32700, 'Parse error')));
        return;
      }

      // Support JSON-RPC batch
      const isBatch = Array.isArray(body);
      const messages = isBatch ? body : [body];

      // Classify: messages with both id and method are requests; others are notifications
      const hasRequest = messages.some(m => m.id !== undefined && m.method);

      // Process all messages
      const responses = [];
      let isInitialize = false;

      for (const rpcMsg of messages) {
        const result = await handleJsonRpc(rpcMsg, handlers);
        if (result !== null) responses.push(result);
        if (rpcMsg.method === 'initialize') isInitialize = true;
      }

      // If no requests (only notifications), return 202 Accepted with empty body
      if (!hasRequest) {
        res.writeHead(202, { 'Access-Control-Allow-Origin': '*' });
        res.end();
        return;
      }

      // Determine response format based on Accept header
      const acceptHeader = req.headers['accept'] || '';
      const wantsSSE = acceptHeader.includes('text/event-stream');

      // Build response headers
      const resHeaders = {
        'Content-Type': wantsSSE ? 'text/event-stream' : 'application/json',
        'Access-Control-Allow-Origin': '*'
      };
      if (wantsSSE) {
        resHeaders['Cache-Control'] = 'no-cache';
        resHeaders['Connection'] = 'keep-alive';
      }

      // Include Mcp-Session-Id on initialize response
      if (isInitialize) {
        resHeaders['Mcp-Session-Id'] = randomUUID();
      }

      res.writeHead(200, resHeaders);

      if (wantsSSE) {
        // SSE format: each JSON-RPC response as a separate event
        for (const r of responses) {
          res.write(`event: message\ndata: ${JSON.stringify(r)}\n\n`);
        }
        res.end();
      } else if (isBatch) {
        res.end(JSON.stringify(responses));
      } else {
        res.end(JSON.stringify(responses[0]));
      }
    } catch (err) {
      console.error('[doculight] MCP HTTP error:', err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jsonrpcError(null, -32603, 'Internal error')));
      }
    }
  });

  // Port binding helper
  function tryListen(port) {
    return new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, '127.0.0.1', () => {
        httpServer.removeListener('error', reject);
        resolve(port);
      });
    });
  }

  // Port discovery: basePort → up to 65535, then basePort-1 → down to 1024
  let boundPort;

  // Phase 1: basePort upward
  for (let p = basePort; p <= 65535; p++) {
    try {
      boundPort = await tryListen(p);
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }

  // Phase 2: below basePort if still not bound
  if (!boundPort) {
    for (let p = basePort - 1; p >= 1024; p--) {
      try {
        boundPort = await tryListen(p);
        break;
      } catch (err) {
        if (err.code !== 'EADDRINUSE') throw err;
      }
    }
  }

  if (!boundPort) throw new Error('No available port found (1024-65535)');

  // Write port discovery file
  if (userDataPath) {
    try {
      const portFilePath = path.join(userDataPath, 'mcp-port');
      fs.writeFileSync(portFilePath, String(boundPort), 'utf-8');
      console.log(`[doculight] Port discovery file written: ${portFilePath}`);
    } catch (err) {
      console.error('[doculight] Failed to write port file:', err.message);
    }
  }

  console.log(`[doculight] MCP HTTP server listening on http://127.0.0.1:${boundPort}/mcp`);
  return httpServer;
}
