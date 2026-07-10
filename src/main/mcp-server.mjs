#!/usr/bin/env node
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
import { injectFrontmatter, DOC_TYPE_VALUES } from './frontmatter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const {
  normalizeProfileName,
  resolveMcpIpcPath
} = require('./runtime-profile.js');
const { redactString } = require('./redaction.js');

// =============================================================================
// Constants
// =============================================================================

const MCP_PROFILE_NAME = normalizeProfileName(
  process.env.DOCULIGHT_MCP_PROFILE ||
  process.env.DOCULIGHT_PROFILE ||
  process.env.DOCULIGHT_RUNTIME_PROFILE ||
  ''
);
const MCP_EXPLICIT_IPC_PATH = Boolean(process.env.DOCULIGHT_MCP_IPC_PATH);
const PIPE_PATH = resolveMcpIpcPath({
  env: process.env,
  platform: platform()
});
const MCP_PACKAGED_STDIO_ENTRYPOINT = process.env.DOCULIGHT_PACKAGED_MCP_STDIO === '1';

const IPC_TIMEOUT = 10_000;        // 10 seconds per request
const MAX_CONTENT_SIZE = 10 * 1024 * 1024;  // 10 MB
const MAX_RETRIES = 20;
const RETRY_INTERVAL = 500;        // ms between connection retries
const SHUTDOWN_GRACE = 5_000;      // max wait for pending requests on shutdown

const SAVE_DOCUMENT_ARG_SHAPE = {
  content: z.string().min(1).max(MAX_CONTENT_SIZE).describe('Markdown content to save to DocuLight persistent document metadata. Required.'),
  title: z.string().min(1).max(200).optional().describe('Optional title and filename hint.'),
  project: z.string().min(1).max(120).optional().describe('Optional persistent project metadata.'),
  docName: z.string().min(1).max(160).optional().describe('Optional persistent document name and preferred filename hint.'),
  description: z.string().min(0).max(1000).optional().describe('Optional persistent document description.'),
  docType: z.enum(DOC_TYPE_VALUES).optional().describe('Optional persistent document type.'),
  category: z.string().min(1).max(120).optional().describe('Optional persistent knowledge category metadata.'),
  documentTags: z.array(z.string().min(1).max(64)).max(32).optional().describe('Optional persistent document metadata tags. Viewer/window grouping tags are named tags and are not accepted by save_document.'),
  gitContextPath: z.string().min(1).max(1024).optional().describe('Optional local-only filesystem path used only to collect git metadata. It is not a destination path or save root override.')
};
const SAVE_DOCUMENT_ZOD_SCHEMA = z.object(SAVE_DOCUMENT_ARG_SHAPE).strict();

const SMART_SEARCH_ARG_SHAPE = {
  query: z.string().min(1).max(500).describe('Search query.'),
  mode: z.enum(['auto', 'keyword', 'hybrid']).default('auto').describe('Retrieval mode.'),
  limit: z.number().int().min(1).max(50).default(20).describe('Maximum results. Omit for 20; increase only when more results are needed, up to 50.'),
  linkedTo: z.string().max(256).optional().describe('Top-level resolved documentId filter accepted by runtime; equivalent to filters.linkedTo.'),
  linkedFrom: z.string().max(256).optional().describe('Top-level resolved documentId filter accepted by runtime; equivalent to filters.linkedFrom.'),
  filters: z.object({
    project: z.string().optional(),
    docType: z.enum(DOC_TYPE_VALUES).optional(),
    category: z.string().optional(),
    documentTags: z.array(z.string()).optional(),
    tagMode: z.enum(['any', 'all']).default('any').optional(),
    pathPrefix: z.string().max(512).refine(isSafeSmartSearchPathPrefix, {
      message: 'pathPrefix must be source-relative; absolute paths, UNC paths, home paths, traversal, URLs, and credentials are rejected.'
    }).optional().describe('Source-relative path prefix filter. Absolute paths, UNC paths, home paths, traversal, URLs, and credentials are rejected with a redacted validation error.'),
    linkedTo: z.string().optional().describe('Resolved documentId filter only.'),
    linkedFrom: z.string().optional().describe('Resolved documentId filter only.'),
    includeStale: z.boolean().default(false).optional()
  }).strict().optional(),
  includeSnippets: z.boolean().default(true).optional(),
  includeScores: z.boolean().default(false).optional(),
  includeTrace: z.boolean().default(false).optional(),
  includeDiagnostics: z.boolean().default(false).optional(),
  allowDegraded: z.boolean().default(true).optional()
};
const SMART_SEARCH_ZOD_SCHEMA = z.object(SMART_SEARCH_ARG_SHAPE).strict();

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

function isSafeSmartSearchPathPrefix(value) {
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  const normalized = raw.replace(/\\/g, '/');
  const decoded = safeDecodeURIComponent(normalized);
  return Boolean(raw) &&
    !raw.includes('\0') &&
    !normalized.startsWith('/') &&
    !path.win32.isAbsolute(raw) &&
    !path.posix.isAbsolute(raw) &&
    normalized !== '~' &&
    !normalized.startsWith('~/') &&
    !normalized.startsWith('~\\') &&
    !hasTraversalSegment(normalized) &&
    !hasTraversalSegment(decoded) &&
    !isUrlLike(normalized) &&
    !isUrlLike(decoded) &&
    !isCredentialLike(normalized) &&
    !isCredentialLike(decoded);
}

function hasTraversalSegment(value) {
  return String(value || '').split('/').some((segment) => segment === '..');
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isUrlLike(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^file:/i.test(value);
}

function isCredentialLike(value) {
  return /[?&](api[_-]?key|token|password|secret)=/i.test(value) || /:\/\/[^/\s]*[:@][^/\s]*@/i.test(value);
}

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
let _connectPromise = null;

async function connectToElectron() {
  // If already connected, do nothing
  if (ipcSocket && !ipcSocket.destroyed) {
    return;
  }
  // Deduplicate concurrent connection attempts (FR-4-002)
  if (_connectPromise) return _connectPromise;
  _connectPromise = _doConnect().finally(() => { _connectPromise = null; });
  return _connectPromise;
}

async function _doConnect() {
  if (ipcSocket && !ipcSocket.destroyed) return;

  // First attempt: try direct connection
  try {
    const socket = await tryConnect();
    attachSocket(socket);
    log('Connected to Electron IPC server');
    return;
  } catch {
    if (MCP_EXPLICIT_IPC_PATH) {
      throw new Error(
        `DocuLight explicit MCP IPC server not found at ${describeIpcEndpoint('explicit')}. ` +
        'Start the intended DocuLight instance, or update DOCULIGHT_MCP_IPC_PATH.'
      );
    }
    if (MCP_PROFILE_NAME === 'dev') {
      throw new Error(
        `DocuLight dev profile IPC server not found at ${describeIpcEndpoint('dev')}. ` +
        'Start the dev app with npm run dev, or set DOCULIGHT_MCP_IPC_PATH to the intended dev IPC endpoint.'
      );
    }
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
  const envPath = process.env.DOCLIGHT_APP_PATH || (MCP_PACKAGED_STDIO_ENTRYPOINT ? process.execPath : '');

  if (envPath) {
    log(`Launching configured DocuLight app: ${redactProcessPath(envPath)}`);
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
    log(`Launching from platform default: ${redactProcessPath(electronPath)}`);
    spawnDetached(electronPath, []);
    return;
  }

  // Dev fallback: run "npx electron ." from the project root
  // __dirname is src/main, project root is two levels up
  const projectRoot = path.resolve(__dirname, '..', '..');
  log(`Dev fallback: launching "npx electron" in ${redactProcessPath(projectRoot)}`);

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
      env: buildAutoLaunchEnv(),
    });
    child.unref();
  } catch (err) {
    log(`Failed to spawn ${redactProcessPath(command)}:`, sanitizeMcpErrorMessage(err));
  }
}

function buildAutoLaunchEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DOCULIGHT_PACKAGED_MCP_STDIO;
  delete env.DOCULIGHT_MCP_STDIO;
  delete env.DOCULIGHT_MCP_ENTRYPOINT;
  return env;
}

function describeIpcEndpoint(kind) {
  const normalizedKind = kind === 'dev' ? 'dev' : kind === 'explicit' ? 'explicit' : 'default';
  return `[REDACTED_MCP_IPC:${normalizedKind}]`;
}

function redactProcessPath(value) {
  const text = String(value || '');
  if (!text) return '[REDACTED_PATH:empty]';
  return `[REDACTED_PATH:${platform()}]`;
}

function sanitizeMcpDiagnosticText(value) {
  return redactString(String(value == null ? 'Unknown MCP error' : value));
}

function sanitizeMcpErrorMessage(err, fallback = 'Unknown MCP error') {
  if (!err) return sanitizeMcpDiagnosticText(fallback);
  return sanitizeMcpDiagnosticText(err && err.message ? err.message : String(err));
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
async function sendIpcRequest(action, params, _retried = false) {
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
      const ok = ipcSocket.write(payload);
      if (!ok) {
        ipcSocket.once('drain', () => {
          log(`IPC write buffer drained for action: ${action}`);
        });
      }
    } catch (err) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      if (!_retried) {
        if (ipcSocket && !ipcSocket.destroyed) {
          ipcSocket.destroy();
        }
        ipcSocket = null;
        return sendIpcRequest(action, params, true).then(resolve, reject);
      }
      reject(new Error(`Failed to write to IPC socket: ${sanitizeMcpErrorMessage(err)}`));
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
      log('Failed to parse IPC response:', sanitizeMcpErrorMessage(err));
      continue;
    }

    const pending = pendingRequests.get(msg.id);
    if (!pending) {
      log('Received response for unknown request id:', sanitizeMcpDiagnosticText(msg.id));
      continue;
    }

    clearTimeout(pending.timer);
    pendingRequests.delete(msg.id);

    if (msg.error) {
      pending.reject(new Error(sanitizeMcpDiagnosticText(msg.error.message || 'Unknown IPC error')));
    } else {
      pending.resolve(msg.result ?? {});
    }
  }
}

/**
 * Handle socket errors.
 */
function onIpcError(err) {
  log('IPC socket error:', sanitizeMcpErrorMessage(err));
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
  'Open or update a visible DocuLight viewer window for Markdown content. Use save_document instead when you only want to save Markdown to the persistent document store without showing a viewer. Provide either content or filePath. Returns windowId for future viewer updates.',
  {
    content:          z.string().optional().describe('Raw Markdown content to display'),
    filePath:         z.string().optional().describe('Absolute path to a .md file to open'),
    title:            z.string().optional().describe('Custom window title'),
    foreground:       z.boolean().optional().describe('Bring window to foreground (default: true)'),
    size:             z.enum(['s', 'm', 'l', 'f']).optional().describe('Window size preset: s(mall), m(edium), l(arge), f(ullscreen)'),
    windowName:       z.string().optional().describe('Named window key — reuses existing window if name matches (upsert)'),
    severity:         z.enum(['info', 'success', 'warning', 'error']).optional().describe('Document status/urgency indicator shown as a colored bar at the top. info (blue — general notes, in-progress reports, neutral information), success (green — completed tasks, final reports, passed validations, positive outcomes), warning (yellow — needs attention, potential issues, review required), error (red — failures, critical bugs, blocked tasks)'),
    tags:             z.array(z.string()).optional().describe('Tags for grouping windows'),
    progress:         z.number().min(-1).max(1).optional().describe('Taskbar progress bar value (-1 to remove, 0.0–1.0)'),
    project:          z.string().optional().describe('[Recommended] Project or repository name this document belongs to (e.g., "DocuLight", "MyApp"). Used for frontmatter metadata.'),
    docName:          z.string().optional().describe('[Recommended] Document name or type (e.g., "API Reference", "Bug Report", "Step 20 SRS"). Used for frontmatter metadata.'),
    description:      z.string().optional().describe('[Recommended] One-line summary of the document purpose and content. STRONGLY RECOMMENDED: Always provide a brief summary for better document organization.'),
    noSave:           z.boolean().default(false).describe('Skip auto-save for this call even if mcpAutoSave is enabled'),
    docType:          z.enum(DOC_TYPE_VALUES).optional().describe('[Recommended] Document type. Match to content: plan (plans/designs), report (analysis/status), completion (finished work), issue (bugs/problems), review (code/doc review), log (progress/changelog), reference (API/config docs), guide (tutorials/howto), spec (specifications/SRS), note (default/general)'),
    projectPath:      z.string().optional().describe('Absolute path to project directory. Auto-collects git metadata when mcpGitInfo setting is enabled.')
  },
  async ({ content, filePath, title, foreground, size,
           windowName, severity, tags, progress,
           project, docName, description, noSave, docType, projectPath }) => {
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
      // Skip when projectPath is present — index.js handles git collection + frontmatter injection
      if (content && !projectPath && (project || docName || description || docType)) {
        content = injectFrontmatter(content, { project, docName, description, docType });
      }

      const result = await sendIpcRequest('open_markdown', {
        content, filePath, title,
        foreground: foreground ?? true,
        size: size ?? 'm',
        windowName, severity, tags, progress, noSave,
        project, docName, description, docType,
        projectPath
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
        content: [{ type: 'text', text: `Error: ${sanitizeMcpErrorMessage(err)}` }],
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
  'Update the content of an existing visible DocuLight viewer window by windowId.',
  {
    windowId:         z.string().describe('ID of the window to update'),
    content:          z.string().optional().describe('New Markdown content'),
    filePath:         z.string().optional().describe('Absolute path to a .md file'),
    title:            z.string().optional().describe('New window title'),
    foreground:       z.boolean().optional().describe('Bring window to foreground (default: true)'),
    appendMode:       z.boolean().default(false).describe('Append content to existing window content instead of replacing'),
    severity:         z.enum(['info', 'success', 'warning', 'error', '']).optional().describe('Document status/urgency indicator shown as a colored bar at the top. info (blue — general notes, in-progress reports, neutral information), success (green — completed tasks, final reports, passed validations, positive outcomes), warning (yellow — needs attention, potential issues, review required), error (red — failures, critical bugs, blocked tasks). Empty string to clear.'),
    tags:             z.array(z.string()).optional().describe('Replace window tags'),
    progress:         z.number().min(-1).max(1).optional().describe('Update taskbar progress bar'),
    project:          z.string().optional().describe('[Recommended] Project name for frontmatter metadata'),
    docName:          z.string().optional().describe('[Recommended] Document name for frontmatter metadata'),
    description:      z.string().optional().describe('[Recommended] Document description for frontmatter metadata'),
    noSave:           z.boolean().default(false).describe('Skip auto-save for this call even if mcpAutoSave is enabled'),
    docType:          z.enum(DOC_TYPE_VALUES).optional().describe('[Recommended] Document type. Match to content: plan (plans/designs), report (analysis/status), completion (finished work), issue (bugs/problems), review (code/doc review), log (progress/changelog), reference (API/config docs), guide (tutorials/howto), spec (specifications/SRS), note (default/general)'),
    projectPath:      z.string().optional().describe('Absolute path to project directory. Auto-collects git metadata when mcpGitInfo setting is enabled.')
  },
  async ({ windowId, content, filePath, title, foreground, appendMode,
           severity, tags, progress,
           project, docName, description, noSave, docType, projectPath }) => {
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
      // Skip when projectPath is present — index.js handles git collection + frontmatter injection
      if (content && !appendMode && !projectPath && (project || docName || description || docType)) {
        content = injectFrontmatter(content, { project, docName, description, docType });
      }

      const result = await sendIpcRequest('update_markdown', {
        windowId, content, filePath, title, foreground, appendMode,
        severity, tags, progress, noSave,
        project, docName, description, docType,
        projectPath
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
        content: [{ type: 'text', text: `Error: ${sanitizeMcpErrorMessage(err)}` }],
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
        content: [{ type: 'text', text: `Error: ${sanitizeMcpErrorMessage(err)}` }],
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
        content: [{ type: 'text', text: `Error: ${sanitizeMcpErrorMessage(err)}` }],
        isError: true
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: save_document
// ---------------------------------------------------------------------------
server.registerTool(
  'save_document',
  {
    description: "Save Markdown content to DocuLight's persistent document store for future retrieval by search_documents and smart_search. This document-only tool does not open, show, focus, update, or close any viewer window.",
    inputSchema: SAVE_DOCUMENT_ZOD_SCHEMA
  },
  async (args) => {
    try {
      SAVE_DOCUMENT_ZOD_SCHEMA.parse(args);
      const result = await sendIpcRequest('save_document', args);
      return result;
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          schemaVersion: 'save_document.v1',
          saved: false,
          error: { code: 'validation_failed', message: sanitizeMcpErrorMessage(err), retryable: false },
          warnings: []
        }) }],
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
  'Search existing saved markdown documents using keyword full-text search. This tool does not save new content. Requires mcpAutoSave to be enabled with a configured save path.',
  {
    query:   z.string().describe('Search query (Korean and English supported)'),
    limit:   z.number().int().min(1).max(100).default(20).describe('Max results'),
    project: z.string().optional().describe('Filter by project name'),
    docType: z.enum(DOC_TYPE_VALUES).optional().describe('Filter by document type')
  },
  async ({ query, limit, project, docType }) => {
    try {
      const result = await sendIpcRequest('search_documents', { query, limit, project, docType });
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
      return { content: [{ type: 'text', text: `Error: ${sanitizeMcpErrorMessage(err)}` }], isError: true };
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
      return { content: [{ type: 'text', text: `Error: ${sanitizeMcpErrorMessage(err)}` }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: smart_search
// ---------------------------------------------------------------------------
server.registerTool(
  'smart_search',
  {
    description: 'Search existing saved documents with read-only smart retrieval. This tool does not save content or perform indexing controls. limit defaults to 20 and may be increased to 50 only when more results are needed. Response envelope includes schemaVersion, degradationReasons, indexFreshness, staleFilteredCount, and optional diagnostics.',
    inputSchema: SMART_SEARCH_ZOD_SCHEMA
  },
  async (args) => {
    try {
      SMART_SEARCH_ZOD_SCHEMA.parse(args);
      const result = await sendIpcRequest('smart_search', args);
      return result;
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          schemaVersion: 'smart_search.v1',
          mode: { requested: sanitizeSmartSearchRequestedMode(args && args.mode), used: 'none' },
          degraded: true,
          degradationReasons: ['index_unavailable'],
          results: [],
          indexFreshness: 'unknown',
          staleFilteredCount: 0,
          error: {
            code: 'validation_failed',
            message: 'smart_search arguments failed validation.',
            field: 'arguments',
            expected: ['auto', 'keyword', 'hybrid'],
            hint: 'Use the advertised smart_search schema and source-relative pathPrefix values.',
            retryable: false
          }
        }) }],
        isError: true
      };
    }
  }
);

function sanitizeSmartSearchRequestedMode(value) {
  return ['auto', 'keyword', 'hybrid'].includes(value) ? value : 'invalid';
}

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
  log('Fatal:', sanitizeMcpErrorMessage(err));
  process.exit(1);
});
