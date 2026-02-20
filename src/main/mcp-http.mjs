// src/main/mcp-http.mjs — HTTP JSON-RPC MCP server embedded in Electron
// ESM module, loaded via dynamic import() from index.js (CJS)
//
// Simple JSON-RPC 2.0 implementation over HTTP POST.
// No SDK transport, no SSE, no session management — just request/response.

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB
const PROTOCOL_VERSION = '2025-03-26';
const SERVER_INFO = { name: 'doculight', version: '1.0.0' };

// ============================================================================
// Tool definitions (MCP tools/list format)
// ============================================================================

const TOOLS = [
  {
    name: 'open_markdown',
    description: 'Open a Markdown document in the DocuLight viewer. Provide either content (raw Markdown string) or filePath (absolute path to .md file). Returns windowId for future reference.',
    inputSchema: {
      type: 'object',
      properties: {
        content:    { type: 'string', description: 'Raw Markdown content to display' },
        filePath:   { type: 'string', description: 'Absolute path to a .md file to open' },
        title:      { type: 'string', description: 'Custom window title' },
        foreground:  { type: 'boolean', description: 'Bring window to foreground (default: true)' },
        alwaysOnTop: { type: 'boolean', description: 'Keep window above others (default: true)' },
        size:        { type: 'string', enum: ['s', 'm', 'l', 'f'], description: 'Window size preset' }
      }
    }
  },
  {
    name: 'update_markdown',
    description: 'Update the content of an existing DocuLight viewer window.',
    inputSchema: {
      type: 'object',
      properties: {
        windowId: { type: 'string', description: 'ID of the window to update' },
        content:  { type: 'string', description: 'New Markdown content' },
        filePath: { type: 'string', description: 'Absolute path to a .md file' },
        title:    { type: 'string', description: 'New window title' }
      },
      required: ['windowId']
    }
  },
  {
    name: 'close_viewer',
    description: 'Close DocuLight viewer window(s). If windowId is provided, closes that specific window. Otherwise, closes all.',
    inputSchema: {
      type: 'object',
      properties: {
        windowId: { type: 'string', description: 'ID of a specific window to close (omit to close all)' }
      }
    }
  },
  {
    name: 'list_viewers',
    description: 'List all currently open DocuLight viewer windows.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
];

// ============================================================================
// Tool handlers
// ============================================================================

function createToolHandlers(windowManager) {
  return {
    async open_markdown({ content, filePath, title, foreground, alwaysOnTop, size }) {
      if (!content && !filePath) {
        return { isError: true, content: [{ type: 'text', text: 'content or filePath is required.' }] };
      }
      if (content && Buffer.byteLength(content, 'utf8') > MAX_BODY_SIZE) {
        return { isError: true, content: [{ type: 'text', text: 'Content exceeds 10MB limit.' }] };
      }

      const result = await windowManager.createWindow({
        content, filePath, title,
        foreground: foreground ?? true,
        size: size ?? 'm'
      });

      const entry = windowManager.getWindowEntry(result.windowId);
      if (entry) {
        // alwaysOnTop defaults to true for HTTP MCP
        const pinned = alwaysOnTop ?? true;
        entry.win.setAlwaysOnTop(pinned);
        entry.meta.alwaysOnTop = pinned;
        entry.win.webContents.send('always-on-top-changed', { alwaysOnTop: pinned });

        // Hide sidebar & TOC for size m or smaller
        const resolvedSize = size ?? 'm';
        if (resolvedSize === 's' || resolvedSize === 'm') {
          entry.win.webContents.send('panel-visibility', { sidebar: false, toc: false });
        }
      }

      return {
        content: [{ type: 'text', text: `Opened viewer window.\n  windowId: ${result.windowId}\n  title: ${result.title}` }]
      };
    },

    async update_markdown({ windowId, content, filePath, title }) {
      if (!windowId) {
        return { isError: true, content: [{ type: 'text', text: 'windowId is required.' }] };
      }
      if (!content && !filePath) {
        return { isError: true, content: [{ type: 'text', text: 'content or filePath is required.' }] };
      }

      const result = await windowManager.updateWindow(windowId, { content, filePath, title });
      return {
        content: [{ type: 'text', text: `Updated window ${windowId}.\n  title: ${result.title}` }]
      };
    },

    async close_viewer({ windowId }) {
      const result = windowManager.closeWindow(windowId || undefined);
      const target = windowId ? `window ${windowId}` : 'all windows';
      return {
        content: [{ type: 'text', text: `Closed ${target}. (${result.closed} window(s) closed)` }]
      };
    },

    async list_viewers() {
      const windows = windowManager.listWindows();
      if (windows.length === 0) {
        return { content: [{ type: 'text', text: 'No viewer windows are currently open.' }] };
      }
      const lines = windows.map((w, i) =>
        `  ${i + 1}. [${w.windowId}] "${w.title}"${w.alwaysOnTop ? ' (pinned)' : ''}`
      );
      return {
        content: [{ type: 'text', text: `Open viewer windows (${windows.length}):\n${lines.join('\n')}` }]
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
export async function startMcpHttpServer(windowManager, store, userDataPath) {
  const basePort = store.get('mcpPort') || 52580;
  const handlers = createToolHandlers(windowManager);

  const httpServer = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
      return;
    }

    // Only POST /mcp
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/mcp' || req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'POST /mcp only' }));
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
      const requests = isBatch ? body : [body];
      const responses = [];

      for (const rpcMsg of requests) {
        const result = await handleJsonRpc(rpcMsg, handlers);
        if (result !== null) responses.push(result); // skip notifications
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });

      if (isBatch) {
        res.end(JSON.stringify(responses));
      } else {
        res.end(JSON.stringify(responses[0] || {}));
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
