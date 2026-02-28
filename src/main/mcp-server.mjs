// src/main/mcp-server.mjs — MCP Bridge Process (stdio <-> IPC Socket)
// Runs as a separate process from Electron. Communicates with the Electron
// main process via Named Pipe (Windows) / Unix Domain Socket.
//
// Usage:  node src/main/mcp-server.mjs
//         (or via "npm run mcp")

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { platform } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const require = createRequire(import.meta.url);
const { injectFrontmatter } = require('./frontmatter.js');

// =============================================================================
// Constants
// =============================================================================

const PIPE_PATH = platform() === 'win32'
  ? '\\\\.\\pipe\\doculight-ipc'
  : '/tmp/doculight-ipc.sock';

const IPC_TIMEOUT = 10_000;        // 10 seconds per request
const MAX_CONTENT_SIZE = 10 * 1024 * 1024;  // 10 MB
const MAX_RETRIES = 10;
const RETRY_INTERVAL = 500;        // ms between connection retries
const SHUTDOWN_GRACE = 5_000;      // max wait for pending requests on shutdown

// =============================================================================
// IPC Socket Client State
// =============================================================================

/** @type {net.Socket | null} */
let ipcSocket = null;

/** @type {Map<string, { resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout> }>} */
const pendingRequests = new Map();

let ipcBuffer = '';

// =============================================================================
// Helpers
// =============================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Log to stderr only. stdout is reserved for the MCP JSON-RPC protocol.
 */
const log = (...args) => console.error('[doculight-mcp]', ...args);

// =============================================================================
// IPC Socket Client Implementation
// =============================================================================

/**
 * Attempt a single connection to the Electron IPC server.
 * Resolves when connected; rejects on error.
 */
function tryConnect() {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: PIPE_PATH }, () => {
      resolve(socket);
    });

    socket.once('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Connect to the Electron main process IPC socket.
 * If the socket is not available, attempts to auto-launch the Electron app
 * and retries up to MAX_RETRIES times.
 */
async function connectToElectron() {
  // If already connected, do nothing
  if (ipcSocket && !ipcSocket.destroyed) {
    return;
  }

  // First attempt: try direct connection
  try {
    const socket = await tryConnect();
    attachSocket(socket);
    log('Connected to Electron IPC server');
    return;
  } catch {
    log('Electron IPC server not found, attempting auto-launch...');
  }

  // Auto-launch the Electron app
  autoLaunchElectron();

  // Retry loop
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await sleep(RETRY_INTERVAL);
    try {
      const socket = await tryConnect();
      attachSocket(socket);
      log(`Connected to Electron IPC server (attempt ${attempt})`);
      return;
    } catch {
      log(`Connection attempt ${attempt}/${MAX_RETRIES} failed`);
    }
  }

  throw new Error(
    `Failed to connect to DocuLight after ${MAX_RETRIES} attempts. ` +
    'Is the Electron app installed? Set DOCLIGHT_APP_PATH env var to the executable path.'
  );
}

/**
 * Wire up event handlers on a newly connected socket.
 */
function attachSocket(socket) {
  ipcSocket = socket;
  ipcBuffer = '';

  socket.setEncoding('utf8');
  socket.on('data', onIpcData);
  socket.on('error', onIpcError);
  socket.on('close', onIpcClose);
}

/**
 * Attempt to launch the DocuLight Electron app as a detached process.
 *
 * Resolution order for the executable path:
 *   1. DOCLIGHT_APP_PATH environment variable
 *   2. Platform-specific default install locations
 *   3. Dev fallback: npx electron <project-root>
 */
function autoLaunchElectron() {
  const envPath = process.env.DOCLIGHT_APP_PATH;

  if (envPath) {
    log(`Launching from DOCLIGHT_APP_PATH: ${envPath}`);
    spawnDetached(envPath, []);
    return;
  }

  // Platform defaults
  const os = platform();
  let electronPath = null;

  if (os === 'win32') {
    electronPath = path.join(
      process.env.LOCALAPPDATA || '',
      'Programs',
      'doculight',
      'DocuLight.exe'
    );
  } else if (os === 'darwin') {
    electronPath = '/Applications/DocuLight.app/Contents/MacOS/DocuLight';
  } else {
    // Linux
    electronPath = '/usr/bin/doculight';
  }

  // Check if the platform default exists
  if (electronPath && fs.existsSync(electronPath)) {
    log(`Launching from platform default: ${electronPath}`);
    spawnDetached(electronPath, []);
    return;
  }

  // Dev fallback: run "npx electron ." from the project root
  // __dirname is src/main, project root is two levels up
  const projectRoot = path.resolve(__dirname, '..', '..');
  log(`Dev fallback: launching "npx electron" in ${projectRoot}`);

  const npxCmd = os === 'win32' ? 'npx.cmd' : 'npx';
  spawnDetached(npxCmd, ['electron', projectRoot]);
}

/**
 * Spawn a process in detached mode so it outlives this MCP bridge.
 */
function spawnDetached(command, args) {
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (err) {
    log(`Failed to spawn "${command}":`, err.message);
  }
}

// =============================================================================
// IPC Request / Response
// =============================================================================

/**
 * Send a JSON-RPC-like request to the Electron IPC server and wait for the
 * corresponding response.
 *
 * @param {string} action  - IPC action name (open_markdown, update_markdown, etc.)
 * @param {object} params  - Action parameters
 * @returns {Promise<object>} Resolved with the result from Electron
 */
async function sendIpcRequest(action, params) {
  // Ensure we have a live connection
  if (!ipcSocket || ipcSocket.destroyed) {
    await connectToElectron();
  }

  const id = randomUUID();

  return new Promise((resolve, reject) => {
    // Timeout guard
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`IPC request timed out after ${IPC_TIMEOUT}ms (action: ${action})`));
    }, IPC_TIMEOUT);

    pendingRequests.set(id, { resolve, reject, timer });

    // ndjson: one JSON object per line
    const payload = JSON.stringify({ id, action, params }) + '\n';

    try {
      ipcSocket.write(payload);
    } catch (err) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      reject(new Error(`Failed to write to IPC socket: ${err.message}`));
    }
  });
}

/**
 * Handle incoming data from the IPC socket.
 * Buffers partial lines and processes complete ndjson messages.
 */
function onIpcData(chunk) {
  ipcBuffer += chunk;

  let newlineIdx;
  while ((newlineIdx = ipcBuffer.indexOf('\n')) !== -1) {
    const line = ipcBuffer.slice(0, newlineIdx).trim();
    ipcBuffer = ipcBuffer.slice(newlineIdx + 1);

    if (line.length === 0) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      log('Failed to parse IPC response:', err.message);
      continue;
    }

    const pending = pendingRequests.get(msg.id);
    if (!pending) {
      log('Received response for unknown request id:', msg.id);
      continue;
    }

    clearTimeout(pending.timer);
    pendingRequests.delete(msg.id);

    if (msg.error) {
      pending.reject(new Error(msg.error.message || 'Unknown IPC error'));
    } else {
      pending.resolve(msg.result ?? {});
    }
  }
}

/**
 * Handle socket errors.
 */
function onIpcError(err) {
  log('IPC socket error:', err.message);
  cleanupSocket();
}

/**
 * Handle socket close.
 */
function onIpcClose() {
  log('IPC socket closed');
  cleanupSocket();
}

/**
 * Clean up the socket and reject all pending requests.
 */
function cleanupSocket() {
  ipcSocket = null;
  ipcBuffer = '';

  for (const [, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error('IPC connection lost'));
  }
  pendingRequests.clear();
}

// =============================================================================
// MCP Server + Tool Registration
// =============================================================================

const server = new McpServer({
  name: 'doculight',
  version: '1.0.0'
});

// ---------------------------------------------------------------------------
// Tool: open_markdown
// ---------------------------------------------------------------------------
server.tool(
  'open_markdown',
  'Open a Markdown document in the DocuLight viewer. Provide either content (raw Markdown string) or filePath (absolute path to .md file). Returns windowId for future reference. IMPORTANT: Always provide project, docName, and description when the context is known to improve document traceability and organization.',
  {
    content:          z.string().optional().describe('Raw Markdown content to display'),
    filePath:         z.string().optional().describe('Absolute path to a .md file to open'),
    title:            z.string().optional().describe('Custom window title'),
    foreground:       z.boolean().optional().describe('Bring window to foreground (default: true)'),
    size:             z.enum(['s', 'm', 'l', 'f']).optional().describe('Window size preset: s(mall), m(edium), l(arge), f(ullscreen)'),
    windowName:       z.string().optional().describe('Named window key — reuses existing window if name matches (upsert)'),
    severity:         z.enum(['info', 'success', 'warning', 'error']).optional().describe('Severity color bar at window top'),
    tags:             z.array(z.string()).optional().describe('Tags for grouping windows'),
    flash:            z.boolean().optional().describe('Flash taskbar button to notify user'),
    progress:         z.number().min(-1).max(1).optional().describe('Taskbar progress bar value (-1 to remove, 0.0–1.0)'),
    autoCloseSeconds: z.number().int().min(1).max(3600).optional().describe('Auto-close window after N seconds'),
    project:          z.string().optional().describe('[Recommended] Project or repository name this document belongs to (e.g., "DocuLight", "MyApp"). Used for frontmatter metadata.'),
    docName:          z.string().optional().describe('[Recommended] Document name or type (e.g., "API Reference", "Bug Report", "Step 20 SRS"). Used for frontmatter metadata.'),
    description:      z.string().optional().describe('[Recommended] One-line summary of the document purpose and content. STRONGLY RECOMMENDED: Always provide a brief summary for better document organization.'),
    noSave:           z.boolean().default(false).describe('Skip auto-save for this call even if mcpAutoSave is enabled')
  },
  async ({ content, filePath, title, foreground, size,
           windowName, severity, tags, flash, progress, autoCloseSeconds,
           project, docName, description, noSave }) => {
    try {
      // Validation: at least one of content or filePath is required
      if (!content && !filePath) {
        return {
          content: [{ type: 'text', text: 'content or filePath is required.' }],
          isError: true
        };
      }

      // Content size check
      if (content && Buffer.byteLength(content, 'utf8') > MAX_CONTENT_SIZE) {
        return {
          content: [{
            type: 'text',
            text: `Content exceeds maximum size of ${MAX_CONTENT_SIZE / (1024 * 1024)}MB.`
          }],
          isError: true
        };
      }

      // Frontmatter injection: prepend YAML metadata if any meta params provided
      if (content && (project || docName || description)) {
        content = injectFrontmatter(content, { project, docName, description });
      }

      const result = await sendIpcRequest('open_markdown', {
        content, filePath, title,
        foreground: foreground ?? true,
        size: size ?? 'm',
        windowName, severity, tags, flash, progress, autoCloseSeconds, noSave,
        project, docName, description
      });

      if (result.upserted) {
        return {
          content: [{
            type: 'text',
            text: `Updated existing window (named: ${result.windowName}).\n  windowId: ${result.windowId}\n  title: ${result.title}`
          }]
        };
      }
      return {
        content: [{
          type: 'text',
          text: `Opened viewer window.\n  windowId: ${result.windowId}\n  title: ${result.title}${result.windowName ? `\n  windowName: ${result.windowName}` : ''}`
        }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: update_markdown
// ---------------------------------------------------------------------------
server.tool(
  'update_markdown',
  'Update the content of an existing DocuLight viewer window.',
  {
    windowId:         z.string().describe('ID of the window to update'),
    content:          z.string().optional().describe('New Markdown content'),
    filePath:         z.string().optional().describe('Absolute path to a .md file'),
    title:            z.string().optional().describe('New window title'),
    appendMode:       z.boolean().default(false).describe('Append content to existing window content instead of replacing'),
    separator:        z.string().default('\n\n').describe('Separator between existing and new content'),
    severity:         z.string().optional().describe('Update severity color bar (info/success/warning/error, empty to clear)'),
    tags:             z.array(z.string()).optional().describe('Replace window tags'),
    flash:            z.boolean().optional().describe('Flash taskbar button'),
    progress:         z.number().min(-1).max(1).optional().describe('Update taskbar progress bar'),
    autoCloseSeconds: z.number().int().min(1).max(3600).optional().describe('Reset/set auto-close timer'),
    project:          z.string().optional().describe('[Recommended] Project name for frontmatter metadata'),
    docName:          z.string().optional().describe('[Recommended] Document name for frontmatter metadata'),
    description:      z.string().optional().describe('[Recommended] Document description for frontmatter metadata'),
    noSave:           z.boolean().default(false).describe('Skip auto-save for this call even if mcpAutoSave is enabled')
  },
  async ({ windowId, content, filePath, title, appendMode, separator,
           severity, tags, flash, progress, autoCloseSeconds,
           project, docName, description, noSave }) => {
    try {
      if (!windowId) {
        return {
          content: [{ type: 'text', text: 'windowId is required.' }],
          isError: true
        };
      }

      // Content size check
      if (content && Buffer.byteLength(content, 'utf8') > MAX_CONTENT_SIZE) {
        return {
          content: [{
            type: 'text',
            text: `Content exceeds maximum size of ${MAX_CONTENT_SIZE / (1024 * 1024)}MB.`
          }],
          isError: true
        };
      }

      // Frontmatter injection (skip for appendMode)
      if (content && !appendMode && (project || docName || description)) {
        content = injectFrontmatter(content, { project, docName, description });
      }

      const result = await sendIpcRequest('update_markdown', {
        windowId, content, filePath, title, appendMode, separator,
        severity, tags, flash, progress, autoCloseSeconds, noSave,
        project, docName, description
      });

      const action = appendMode ? 'Appended to' : 'Updated';
      return {
        content: [{
          type: 'text',
          text: `${action} window ${windowId}.\n  title: ${result.title}`
        }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: close_viewer
// ---------------------------------------------------------------------------
server.tool(
  'close_viewer',
  'Close DocuLight viewer window(s). If windowId is provided, closes that specific window. If tag is provided, closes all matching windows. Otherwise, closes all.',
  {
    windowId: z.string().optional().describe('ID of a specific window to close (omit to close all)'),
    tag:      z.string().optional().describe('Close all windows with this tag')
  },
  async ({ windowId, tag }) => {
    try {
      const result = await sendIpcRequest('close_viewer', {
        windowId: windowId || undefined,
        tag: tag || undefined
      });

      let target;
      if (windowId) target = `window ${windowId}`;
      else if (tag) target = `windows with tag "${tag}"`;
      else target = 'all windows';

      return {
        content: [{
          type: 'text',
          text: `Closed ${target}. (${result.closed} window(s) closed)`
        }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: list_viewers
// ---------------------------------------------------------------------------
server.tool(
  'list_viewers',
  'List all currently open DocuLight viewer windows.',
  {
    tag: z.string().optional().describe('Filter windows by tag')
  },
  async ({ tag } = {}) => {
    try {
      const result = await sendIpcRequest('list_viewers', { tag });

      const windows = result.windows || [];

      if (windows.length === 0) {
        return {
          content: [{ type: 'text', text: 'No viewer windows are currently open.' }]
        };
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
        content: [{
          type: 'text',
          text: `Open viewer windows (${windows.length}):\n${lines.join('\n')}`
        }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: search_documents
// ---------------------------------------------------------------------------
server.tool(
  'search_documents',
  'Search saved markdown documents using BM25 full-text search. Searches across document body and frontmatter metadata (title, project, description). Requires mcpAutoSave to be enabled with a configured save path.',
  {
    query:   z.string().describe('Search query (Korean and English supported)'),
    limit:   z.number().int().min(1).max(100).default(20).describe('Max results'),
    project: z.string().optional().describe('Filter by project name')
  },
  async ({ query, limit, project }) => {
    try {
      const result = await sendIpcRequest('search_documents', { query, limit, project });
      const results = result.results || [];
      const totalIndexed = result.totalIndexed || 0;

      if (results.length === 0) {
        return {
          content: [{ type: 'text', text: `No results found for "${query}". (${totalIndexed} documents indexed)` }]
        };
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
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: search_projects
// ---------------------------------------------------------------------------
server.tool(
  'search_projects',
  'Search or list projects from saved document frontmatter metadata. Returns project names with descriptions and associated document counts. Requires mcpAutoSave to be enabled with a configured save path.',
  {
    query: z.string().optional().describe('Search query for project name/description (omit for full list)'),
    limit: z.number().int().min(1).max(100).default(20).describe('Max results')
  },
  async ({ query, limit }) => {
    try {
      const result = await sendIpcRequest('search_projects', { query, limit });
      const projects = result.projects || [];

      if (projects.length === 0) {
        return {
          content: [{ type: 'text', text: query ? `No projects found for "${query}".` : 'No projects found.' }]
        };
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
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// =============================================================================
// Start and Shutdown
// =============================================================================

async function start() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('MCP server started (stdio transport)');
}

async function shutdown() {
  log('Shutting down...');

  // Wait for pending IPC requests to complete (up to SHUTDOWN_GRACE ms)
  if (pendingRequests.size > 0) {
    log(`Waiting for ${pendingRequests.size} pending request(s)...`);

    const deadline = Date.now() + SHUTDOWN_GRACE;
    while (pendingRequests.size > 0 && Date.now() < deadline) {
      await sleep(100);
    }
  }

  // Reject any remaining pending requests
  for (const [, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error('MCP server shutting down'));
  }
  pendingRequests.clear();

  // Destroy IPC socket
  if (ipcSocket && !ipcSocket.destroyed) {
    ipcSocket.destroy();
    ipcSocket = null;
  }

  // Close MCP server
  try {
    await server.close();
  } catch {
    // Ignore close errors during shutdown
  }

  log('Shutdown complete');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Signal handlers
// ---------------------------------------------------------------------------

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.stdin.on('end', shutdown);

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

start().catch((err) => {
  log('Fatal:', err.message);
  process.exit(1);
});
