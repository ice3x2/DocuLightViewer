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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  'Open a Markdown document in the DocuLight viewer. Provide either content (raw Markdown string) or filePath (absolute path to .md file). Returns windowId for future reference.',
  {
    content: z.string().optional().describe('Raw Markdown content to display'),
    filePath: z.string().optional().describe('Absolute path to a .md file to open'),
    title: z.string().optional().describe('Custom window title'),
    foreground: z.boolean().optional().describe('Bring window to foreground (default: true)'),
    size: z.enum(['s', 'm', 'l', 'f']).optional().describe('Window size preset: s(mall), m(edium), l(arge), f(ullscreen)')
  },
  async ({ content, filePath, title, foreground, size }) => {
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

      const result = await sendIpcRequest('open_markdown', {
        content,
        filePath,
        title,
        foreground: foreground ?? true,
        size: size ?? 'm'
      });

      return {
        content: [{
          type: 'text',
          text: `Opened viewer window.\n  windowId: ${result.windowId}\n  title: ${result.title}`
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
    windowId: z.string().describe('ID of the window to update'),
    content: z.string().optional().describe('New Markdown content'),
    filePath: z.string().optional().describe('Absolute path to a .md file'),
    title: z.string().optional().describe('New window title')
  },
  async ({ windowId, content, filePath, title }) => {
    try {
      // Validation
      if (!windowId) {
        return {
          content: [{ type: 'text', text: 'windowId is required.' }],
          isError: true
        };
      }

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

      const result = await sendIpcRequest('update_markdown', {
        windowId,
        content,
        filePath,
        title
      });

      return {
        content: [{
          type: 'text',
          text: `Updated window ${windowId}.\n  title: ${result.title}`
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
  'Close DocuLight viewer window(s). If windowId is provided, closes that specific window. Otherwise, closes all.',
  {
    windowId: z.string().optional().describe('ID of a specific window to close (omit to close all)')
  },
  async ({ windowId }) => {
    try {
      const result = await sendIpcRequest('close_viewer', {
        windowId: windowId || undefined
      });

      const target = windowId ? `window ${windowId}` : 'all windows';
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
  {},
  async () => {
    try {
      const result = await sendIpcRequest('list_viewers', {});

      const windows = result.windows || [];

      if (windows.length === 0) {
        return {
          content: [{ type: 'text', text: 'No viewer windows are currently open.' }]
        };
      }

      const lines = windows.map((w, i) =>
        `  ${i + 1}. [${w.windowId}] "${w.title}"${w.alwaysOnTop ? ' (pinned)' : ''}`
      );

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
