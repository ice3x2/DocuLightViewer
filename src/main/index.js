// src/main/index.js — Electron App Entry Point + IPC Socket Server
// CommonJS module for Electron main process

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, dialog } = require('electron');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { WindowManager } = require('./window-manager');
const Store = require('electron-store');
const { init: initStrings, t, getAll: getAllStrings } = require('./strings');

// === CLI locale override ===
// --flags are consumed by Chromium (--lang) or npm (--locale, --language).
// Use plain keyword: "locale ja"  →  npm run dev -- locale ja
const _langOverride = (() => {
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === 'locale' && process.argv[i + 1] && !process.argv[i + 1].startsWith('-')) {
      return process.argv[i + 1].toLowerCase();
    }
  }
  if (process.env.DOCULIGHT_LOCALE) {
    return process.env.DOCULIGHT_LOCALE.toLowerCase();
  }
  return undefined;
})();

// === Constants ===
const PIPE_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\doculight-ipc'
  : '/tmp/doculight-ipc.sock';

const ICON_PATH = process.platform === 'win32'
  ? path.join(__dirname, '..', '..', 'assets', 'icon.ico')
  : path.join(__dirname, '..', '..', 'assets', 'icon.png');
const MAX_TRAY_ITEMS = 10;

// === Global State ===
let tray = null;
let ipcServer = null;
let mcpHttpServer = null;
let settingsWin = null;
let pendingOpenFile = null; // macOS: buffers open-file events before app.isReady()
let isExporting = false;
const windowManager = new WindowManager();

// =============================================================================
// File argument helpers
// =============================================================================

/**
 * Extract .md file paths from command-line arguments.
 * Skips argv[0] (executable), flags (--*), and '.' (Electron app path).
 * @param {string[]} argv
 * @returns {string[]} Resolved absolute paths of .md files
 */
function extractMdPathsFromArgv(argv) {
  const paths = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--') || arg === '.') continue;
    if (arg.toLowerCase().endsWith('.md')) {
      paths.push(path.resolve(arg));
    }
  }
  return paths;
}

/**
 * Open a .md file in a new viewer window.
 * Validates extension and readability before creating the window.
 * @param {string} filePath
 */
function openFileFromPath(filePath) {
  if (!filePath) return;
  const resolved = path.resolve(filePath);
  if (path.extname(resolved).toLowerCase() !== '.md') return;
  try {
    fs.accessSync(resolved, fs.constants.R_OK);
  } catch {
    console.error(`[doculight] Cannot read file: ${resolved}`);
    return;
  }
  windowManager.createWindow({ filePath: resolved });
  addRecentFile(resolved);
}

const store = new Store({
  schema: {
    theme: { type: 'string', enum: ['light', 'dark'], default: 'light' },
    fontSize: { type: 'number', minimum: 8, maximum: 32, default: 16 },
    fontFamily: { type: 'string', minLength: 1, default: 'system-ui, -apple-system, sans-serif' },
    codeTheme: { type: 'string', default: 'github' },
    mcpPort: { type: 'number', minimum: 1024, maximum: 65535, default: 52580 },
    defaultWindowSize: {
      type: 'string',
      enum: ['auto', 's', 'm', 'l', 'f'],
      default: 'auto'
    },
    lastWindowBounds: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' }
      },
      default: {}
    },
    fileAssociation: { type: 'boolean', default: false },
    fileAssociationPrevProgId: { type: 'string', default: '' },
    autoRefresh: { type: 'boolean', default: true },
    enableTabs: { type: 'boolean', default: false },
    recentFiles: { type: 'array', items: { type: 'string' }, default: [] },
    mcpAutoSave: { type: 'boolean', default: false },
    mcpAutoSavePath: { type: 'string', default: '' },
    lastSaveAsDirectory: { type: 'string', default: '' }
  }
});

// =============================================================================
// macOS open-file event (fires before app.isReady())
// =============================================================================
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (app.isReady()) {
    openFileFromPath(filePath);
  } else {
    pendingOpenFile = filePath;
  }
});

// =============================================================================
// Single Instance Lock
// =============================================================================
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, _workingDirectory) => {
    const mdPaths = extractMdPathsFromArgv(argv);
    if (mdPaths.length > 0) {
      for (const mdPath of mdPaths) {
        openFileFromPath(mdPath);
      }
    } else {
      // No .md files — focus first available viewer window, or open empty viewer
      const windows = windowManager.listWindows();
      if (windows.length > 0) {
        const entry = windowManager.getWindowEntry(windows[0].windowId);
        if (entry && entry.win) {
          if (entry.win.isMinimized()) entry.win.restore();
          entry.win.focus();
        }
      } else {
        windowManager.createEmptyWindow();
      }
    }
  });
}

// =============================================================================
// App Lifecycle
// =============================================================================
app.on('ready', async () => {
  // Use pre-parsed --lang value from module scope
  initStrings(_langOverride);
  Menu.setApplicationMenu(null);
  cleanupStaleSocket();
  createTray();
  startIpcServer();
  registerIpcHandlers();

  // Pass store to windowManager for default window size / auto bounds
  windowManager.setStore(store);

  // Wire up tray menu updates whenever windows change
  windowManager.onTrayUpdate = updateTrayMenu;

  // Wire up recent file tracking
  windowManager.onRecentFile = addRecentFile;

  // Re-register file association on startup (fixes path changes after app updates)
  const fileAssoc = require('./file-association');
  if (store.get('fileAssociation', false) && fileAssoc.isSupported()) {
    fileAssoc.register().catch(err => {
      console.error('[doculight] Failed to re-register file association:', err.message);
    });
  }

  // Start HTTP-based MCP server (ESM module loaded via dynamic import)
  try {
    const { startMcpHttpServer } = await import('./mcp-http.mjs');
    mcpHttpServer = await startMcpHttpServer(windowManager, store, app.getPath('userData'));
  } catch (err) {
    console.error('[doculight] Failed to start MCP HTTP server:', err.message);
  }

  // Open .md files passed via command-line arguments
  const mdPaths = extractMdPathsFromArgv(process.argv);
  for (const mdPath of mdPaths) {
    openFileFromPath(mdPath);
  }

  // macOS: process open-file event that arrived before ready
  if (pendingOpenFile) {
    openFileFromPath(pendingOpenFile);
    pendingOpenFile = null;
  }

  // If no viewer window was opened (no .md args, no pending file), show an empty viewer
  if (windowManager.listWindows().length === 0) {
    windowManager.createEmptyWindow();
  }
});

app.on('window-all-closed', () => {
  // Don't quit — stay alive in tray mode.
  // On macOS this is the default behavior; on Windows/Linux we simply
  // do nothing so the app keeps running with the system tray icon.
});

app.on('before-quit', () => {
  // Stop all file watchers
  windowManager.stopAllFileWatchers();

  // Delete port discovery file
  try {
    const portFilePath = path.join(app.getPath('userData'), 'mcp-port');
    fs.unlinkSync(portFilePath);
  } catch { /* ignore — file may not exist */ }

  // Close every viewer window
  windowManager.closeWindow();

  // Tear down the HTTP MCP server
  if (mcpHttpServer) {
    mcpHttpServer.close();
    mcpHttpServer = null;
  }

  // Tear down the IPC socket server
  if (ipcServer) {
    ipcServer.close();
    ipcServer = null;
  }

  // Cleanup Unix domain socket file (not needed on Windows named pipes)
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(PIPE_PATH); } catch { /* ignore */ }
  }
});

// =============================================================================
// System Tray
// =============================================================================

/**
 * Create the system tray icon and initial context menu.
 */
function createTray() {
  try {
    const icon = nativeImage.createFromPath(ICON_PATH);
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    tray.setToolTip('DocuLight');
    updateTrayMenu();
  } catch (err) {
    console.error('[doculight] createTray ERROR:', err);
  }
}

/**
 * Add a file path to the recent files list.
 * Deduplicates, moves to front, and caps at 7 entries.
 * @param {string} filePath - Absolute path to a .md file.
 */
function addRecentFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return;
  if (!path.isAbsolute(filePath)) return;
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.md' && ext !== '.markdown') return;

  let recent = store.get('recentFiles', []);
  // Remove existing entry (dedup)
  recent = recent.filter(p => p !== filePath);
  // Add to front
  recent.unshift(filePath);
  // Cap at 7
  if (recent.length > 7) recent = recent.slice(0, 7);
  store.set('recentFiles', recent);
  updateTrayMenu();
}

/**
 * Rebuild the tray context menu from the current window list.
 * Called whenever windows are created, closed, or their titles change.
 */
function updateTrayMenu() {
  if (!tray) return;

  const windows = windowManager.listWindows();
  const menuItems = [];

  // List up to MAX_TRAY_ITEMS window titles
  const visible = windows.slice(0, MAX_TRAY_ITEMS);
  for (const info of visible) {
    menuItems.push({
      label: info.title || t('tray.windowFallback', { windowId: info.windowId }),
      click: () => {
        const entry = windowManager.getWindowEntry(info.windowId);
        if (entry && entry.win) {
          if (entry.win.isMinimized()) entry.win.restore();
          entry.win.show();
          entry.win.focus();
        }
      },
    });
  }

  // If there are more windows than the limit, show a count
  if (windows.length > MAX_TRAY_ITEMS) {
    menuItems.push({
      label: t('tray.overflow', { count: windows.length - MAX_TRAY_ITEMS }),
      enabled: false,
    });
  }

  // Separator before global actions
  if (windows.length > 0) {
    menuItems.push({ type: 'separator' });
  }

  menuItems.push({
    label: t('tray.newViewer'),
    click: () => {
      windowManager.createEmptyWindow();
    },
  });

  // Recent Documents submenu
  const recentFiles = store.get('recentFiles', []);
  const recentSubmenu = [];

  if (recentFiles.length > 0) {
    for (const fp of recentFiles) {
      const fileName = path.basename(fp);
      const parentDir = path.basename(path.dirname(fp));
      recentSubmenu.push({
        label: `${fileName} (${parentDir})`,
        click: () => {
          if (fs.existsSync(fp)) {
            windowManager.createWindow({ filePath: fp });
          } else {
            console.log(`[doculight] recent file not found: ${fp}`);
            // Remove from list
            let updated = store.get('recentFiles', []);
            updated = updated.filter(p => p !== fp);
            store.set('recentFiles', updated);
            updateTrayMenu();
          }
        }
      });
    }
    recentSubmenu.push({ type: 'separator' });
    recentSubmenu.push({
      label: t('tray.clearRecent'),
      click: () => {
        store.set('recentFiles', []);
        updateTrayMenu();
      }
    });
  } else {
    recentSubmenu.push({
      label: t('tray.recentEmpty'),
      enabled: false
    });
  }

  menuItems.push({
    label: t('tray.recentDocs'),
    submenu: recentSubmenu
  });

  menuItems.push({
    label: t('tray.closeAll'),
    enabled: windows.length > 0,
    click: () => {
      windowManager.closeWindow(); // close all
    },
  });

  menuItems.push({ type: 'separator' });

  menuItems.push({
    label: t('tray.settings'),
    click: () => {
      openSettingsWindow();
    },
  });

  menuItems.push({
    label: t('tray.about'),
    click: () => {
      showAboutDialog();
    },
  });

  menuItems.push({
    label: t('tray.quit'),
    click: () => {
      app.quit();
    },
  });

  const contextMenu = Menu.buildFromTemplate(menuItems);
  tray.setContextMenu(contextMenu);
}

// =============================================================================
// Settings Window
// =============================================================================

/**
 * Open the settings window. If it's already open, focus it instead.
 */
function openSettingsWindow() {
  if (settingsWin) {
    settingsWin.focus();
    return;
  }

  settingsWin = new BrowserWindow({
    width: 500,
    height: 700,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    title: t('settings.pageTitle'),
    icon: nativeImage.createFromPath(ICON_PATH),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  settingsWin.loadFile(path.join(__dirname, '../renderer/settings.html'));
  settingsWin.setMenu(null);

  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

// =============================================================================
// About Dialog
// =============================================================================

/**
 * Show About dialog with version info and GitHub link.
 */
function showAboutDialog() {
  const version = require('../../package.json').version;
  const githubUrl = 'https://github.com/ice3x2/DocuLightViewer';

  dialog.showMessageBox({
    type: 'info',
    icon: nativeImage.createFromPath(ICON_PATH),
    title: t('tray.about'),
    message: 'DocuLight',
    detail: `Version ${version}`,
    buttons: ['GitHub', t('tray.aboutClose')],
    defaultId: 1,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) {
      shell.openExternal(githubUrl);
    }
  });
}

// =============================================================================
// IPC Socket Server (Named Pipe on Windows, Unix socket elsewhere)
// =============================================================================

/**
 * On Unix platforms, remove a leftover socket file if no live server owns it.
 * On Windows named pipes are managed by the OS and need no cleanup.
 */
function cleanupStaleSocket() {
  if (process.platform === 'win32') return;

  if (!fs.existsSync(PIPE_PATH)) return;

  // Attempt to connect — if something answers, another instance is running.
  const probe = net.connect({ path: PIPE_PATH }, () => {
    probe.end();
    console.error('[doculight] Another DocuLight instance is already listening on the socket. Quitting.');
    app.quit();
  });

  probe.on('error', (err) => {
    if (err.code === 'ECONNREFUSED') {
      // Stale socket file — safe to remove
      try { fs.unlinkSync(PIPE_PATH); } catch { /* ignore */ }
    }
    // Any other error (e.g. ENOENT race) is harmless — ignore
  });
}

/**
 * Start the ndjson IPC server that external processes (e.g. MCP bridge) use
 * to open/update/close viewer windows.
 */
function startIpcServer() {
  ipcServer = net.createServer((socket) => {
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      // Process every complete newline-delimited JSON message
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (line.length === 0) continue;

        let msg;
        try {
          msg = JSON.parse(line);
        } catch (parseErr) {
          // Malformed JSON — send error if we can guess an id
          sendResponse(socket, null, null, `Invalid JSON: ${parseErr.message}`);
          continue;
        }

        handleIpcMessage(socket, msg);
      }
    });

    socket.on('error', (err) => {
      console.error('[doculight] IPC socket connection error:', err.message);
    });
  });

  ipcServer.on('error', (err) => {
    console.error('[doculight] IPC server error:', err.message);
  });

  ipcServer.listen(PIPE_PATH, () => {
    console.log(`[doculight] IPC server listening on ${PIPE_PATH}`);

    // Restrict socket permissions on Unix
    if (process.platform !== 'win32') {
      try { fs.chmodSync(PIPE_PATH, 0o600); } catch { /* ignore */ }
    }
  });
}

// =============================================================================
// MCP Auto-Save Helpers
// =============================================================================

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

async function saveMcpFile({ content, filePath, title, noSave }) {
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

/**
 * Route an incoming IPC message to the appropriate WindowManager method.
 *
 * Message format (ndjson):  { id, action, params }
 * Response format (ndjson): { id, result } or { id, error: { message } }
 */
async function handleIpcMessage(socket, msg) {
  const { id, action, params } = msg;

  try {
    let result;

    switch (action) {
      case 'open_markdown':
        result = await windowManager.createWindow(params);
        try {
          const savedPath = await saveMcpFile({ content: params.content, filePath: params.filePath, title: params.title, noSave: params.noSave });
          if (savedPath) {
            const entry = windowManager.getWindowEntry(result.windowId);
            if (entry) {
              entry.meta.savedFilePath = savedPath;
              if (!entry.win.isDestroyed()) {
                entry.win.webContents.send('set-saved-file-path', { savedFilePath: savedPath });
                entry.win.setTitle(windowManager.formatWindowTitle(entry.meta.title, entry.meta.filePath, savedPath));
              }
            }
          }
        } catch (err) {
          console.error('[doculight] saveMcpFile error:', err.message);
        }
        break;

      case 'update_markdown':
        result = await windowManager.updateWindow(params.windowId, params);
        break;

      case 'close_viewer':
        result = windowManager.closeWindow(params?.windowId, { tag: params?.tag });
        break;

      case 'list_viewers':
        result = { windows: windowManager.listWindows({ tag: params?.tag }) };
        break;

      default:
        sendResponse(socket, id, null, `Unknown action: ${action}`);
        return;
    }

    sendResponse(socket, id, result, null);
  } catch (err) {
    sendResponse(socket, id, null, err.message || String(err));
  }
}

/**
 * Write an ndjson response line back to the socket.
 */
function sendResponse(socket, id, result, errorMessage) {
  if (socket.destroyed) return;

  const payload = errorMessage
    ? { id, error: { message: errorMessage } }
    : { id, result: result ?? {} };

  try {
    socket.write(JSON.stringify(payload) + '\n');
  } catch (err) {
    console.error('[doculight] Failed to write IPC response:', err.message);
  }
}

// =============================================================================
// PDF Export Helpers
// =============================================================================

/**
 * Recursively collect .md/.markdown file paths from a sidebar tree.
 * @param {object} tree - Sidebar tree node
 * @param {number} depth - Current recursion depth
 * @returns {string[]} Array of absolute file paths
 */
function collectMdPaths(tree, depth = 0) {
  if (depth > 20) {
    console.warn('[doculight] collectMdPaths: max depth exceeded');
    return [];
  }
  const result = [];
  if (!tree || !tree.children) return result;
  for (const child of tree.children) {
    if (child.children && child.children.length > 0) {
      result.push(...collectMdPaths(child, depth + 1));
    } else if (child.path) {
      const ext = path.extname(child.path).toLowerCase();
      if (ext === '.md' || ext === '.markdown') {
        result.push(child.path);
      }
    }
  }
  return result;
}

// =============================================================================
// Content Search Helper
// =============================================================================

/**
 * Find content matches in a markdown file for sidebar search.
 * Priority: 0 = filename, 1 = title/H1, 2 = content line.
 * @param {string} content - File content
 * @param {string} fileName - File name without extension
 * @param {string} lowerQuery - Lowercased query string
 * @param {RegExp} queryRegex - Regex for the query (global, case-insensitive)
 * @param {number} maxMatches - Maximum matches per file
 * @param {number} maxSnippetLen - Maximum snippet length
 * @returns {Array<{line: number, snippet: string, priority: number}>}
 */
function findContentMatches(content, fileName, lowerQuery, queryRegex, maxMatches, maxSnippetLen) {
  const matches = [];

  // Priority 0: filename match
  if (fileName.toLowerCase().includes(lowerQuery)) {
    matches.push({ line: 0, snippet: fileName, priority: 0 });
  }

  const lines = content.split('\n');
  for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
    const line = lines[i];
    const lowerLine = line.toLowerCase();
    if (!lowerLine.includes(lowerQuery)) continue;

    // Priority 1: title (H1 heading)
    const isTitle = /^#{1,2}\s+/.test(line);
    const priority = isTitle ? 1 : 2;

    // Build snippet around the match
    const matchIdx = lowerLine.indexOf(lowerQuery);
    let snippetStart = Math.max(0, matchIdx - 30);
    let snippetEnd = Math.min(line.length, matchIdx + lowerQuery.length + 30);

    // Expand to maxSnippetLen if possible
    if (snippetEnd - snippetStart < maxSnippetLen) {
      const remaining = maxSnippetLen - (snippetEnd - snippetStart);
      snippetStart = Math.max(0, snippetStart - Math.floor(remaining / 2));
      snippetEnd = Math.min(line.length, snippetEnd + Math.ceil(remaining / 2));
    }

    let snippet = line.substring(snippetStart, snippetEnd).trim();
    if (snippetStart > 0) snippet = '...' + snippet;
    if (snippetEnd < line.length) snippet = snippet + '...';

    matches.push({ line: i + 1, snippet, priority });
  }

  return matches;
}

// =============================================================================
// IPC Handlers — Renderer ↔ Main Process Communication
// =============================================================================

function registerIpcHandlers() {
  // --- File Association IPC ---
  const fileAssoc = require('./file-association');
  fileAssoc.init(store);

  ipcMain.handle('register-file-association', async () => {
    if (!fileAssoc.isSupported()) {
      return { success: false, message: t('fileAssoc.unsupported') };
    }
    const result = await fileAssoc.register();
    if (result.success) store.set('fileAssociation', true);
    return result;
  });

  ipcMain.handle('unregister-file-association', async () => {
    const result = await fileAssoc.unregister();
    if (result.success) store.set('fileAssociation', false);
    return result;
  });

  ipcMain.handle('get-file-association-status', async () => {
    const supported = fileAssoc.isSupported();
    let registered = false;
    if (supported) {
      try { registered = await fileAssoc.isRegistered(); } catch { /* ignore */ }
    }
    return {
      registered,
      supported,
      platform: process.platform,
      settingValue: store.get('fileAssociation', false)
    };
  });

  ipcMain.on('open-default-apps-settings', () => {
    fileAssoc.openSystemSettings();
  });

  ipcMain.on('show-in-explorer', (event, filePath) => {
    if (filePath) shell.showItemInFolder(filePath);
  });

  ipcMain.handle('pick-directory', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  // Navigate to a linked document within the same viewer window
  ipcMain.on('navigate-to', (event, filePath) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const windowId = windowManager.findWindowId(win);
    if (windowId) windowManager.navigateTo(windowId, filePath);
  });

  // History: go back
  ipcMain.on('navigate-back', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const windowId = windowManager.findWindowId(win);
    if (windowId) windowManager.navigateBack(windowId);
  });

  // History: go forward
  ipcMain.on('navigate-forward', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const windowId = windowManager.findWindowId(win);
    if (windowId) windowManager.navigateForward(windowId);
  });

  // Open an external URL in the user's default browser (http/https only)
  ipcMain.on('open-external', (_event, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        shell.openExternal(url);
      } else {
        console.error(`[doculight] Blocked openExternal for protocol: ${parsed.protocol}`);
      }
    } catch {
      console.error(`[doculight] Invalid URL for openExternal: ${url}`);
    }
  });

  // Renderer signals that it has finished initialising and is ready for content
  ipcMain.on('window-ready', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const windowId = windowManager.findWindowId(win);
    if (windowId) {
      windowManager.onWindowReady(windowId);
      // Send initial settings to newly opened window
      const theme = store.get('theme');
      const codeTheme = store.get('codeTheme');
      const fontSize = store.get('fontSize');
      const fontFamily = store.get('fontFamily');
      if (theme !== 'light') {
        event.sender.send('theme-changed', { theme });
      }
      event.sender.send('settings-changed', { fontSize, fontFamily, codeTheme });
    }
  });

  // i18n: provide locale strings to renderer
  ipcMain.handle('get-strings', () => {
    return getAllStrings();
  });

  // Settings: get all settings
  ipcMain.handle('get-settings', () => {
    return store.store;
  });

  // Settings: save all settings
  ipcMain.handle('save-settings', (_event, settings) => {
    const oldTheme = store.get('theme');
    const oldFontSize = store.get('fontSize');
    const oldFontFamily = store.get('fontFamily');
    const oldCodeTheme = store.get('codeTheme');
    const oldAutoRefresh = store.get('autoRefresh', true);

    // Save to store
    for (const [key, value] of Object.entries(settings)) {
      store.set(key, value);
    }

    // Broadcast theme change to all viewer windows
    if (settings.theme && settings.theme !== oldTheme) {
      for (const [, entry] of windowManager.windows) {
        entry.win.webContents.send('theme-changed', { theme: settings.theme });
      }
    }

    // Broadcast font/settings/codeTheme change to all viewer windows
    if (settings.fontSize !== oldFontSize || settings.fontFamily !== oldFontFamily || settings.codeTheme !== oldCodeTheme) {
      for (const [, entry] of windowManager.windows) {
        entry.win.webContents.send('settings-changed', {
          fontSize: settings.fontSize,
          fontFamily: settings.fontFamily,
          codeTheme: settings.codeTheme
        });
      }
    }

    // Handle autoRefresh setting change
    if ('autoRefresh' in settings) {
      if (settings.autoRefresh && !oldAutoRefresh) {
        // Turned ON: start watchers for all open windows with file paths
        for (const [wid, wEntry] of windowManager.windows) {
          if (wEntry.meta.filePath) {
            windowManager.startFileWatcher(wid);
          }
        }
      } else if (!settings.autoRefresh && oldAutoRefresh) {
        // Turned OFF: stop all watchers
        windowManager.stopAllFileWatchers();
      }
    }

    return { success: true };
  });

  // Zoom in
  ipcMain.on('zoom-in', (event) => {
    const wc = event.sender;
    const current = wc.getZoomLevel();
    if (current < 5.0) {
      wc.setZoomLevel(current + 0.5);
    }
  });

  // Zoom out
  ipcMain.on('zoom-out', (event) => {
    const wc = event.sender;
    const current = wc.getZoomLevel();
    if (current > -3.0) {
      wc.setZoomLevel(current - 0.5);
    }
  });

  // Zoom reset
  ipcMain.on('zoom-reset', (event) => {
    event.sender.setZoomLevel(0);
  });

  // File dropped onto a viewer window (drag & drop)
  ipcMain.on('file-dropped', async (event, filePath) => {
    try {
      // Validate .md extension
      if (path.extname(filePath).toLowerCase() !== '.md') {
        return; // silently ignore non-.md files
      }

      // Validate file exists
      await fs.promises.access(filePath, fs.constants.R_OK);

      const win = BrowserWindow.fromWebContents(event.sender);
      const windowId = windowManager.findWindowId(win);
      if (!windowId) return;

      const entry = windowManager.getWindowEntry(windowId);
      if (!entry) return;

      // Read file content
      const content = await fs.promises.readFile(filePath, 'utf-8');

      // Set rootFilePath and build tree for the dropped file
      entry.meta.rootFilePath = filePath;
      entry.meta.filePath = filePath;
      entry.meta.history.push(filePath);

      // Update window title
      const title = windowManager.extractTitle(content) || path.basename(filePath, '.md');
      entry.meta.title = title;
      entry.win.setTitle(title);

      // Send content to renderer
      entry.win.webContents.send('render-markdown', {
        markdown: content,
        filePath: filePath.replace(/\\/g, '/'),
        windowId,
        imageBasePath: path.dirname(filePath).replace(/\\/g, '/'),
        platform: process.platform
      });

      // Build sidebar tree
      try {
        const { buildDirectoryTree } = require('./link-parser');
        const tree = buildDirectoryTree(path.dirname(filePath));
        entry.meta.tree = tree;
        entry.win.webContents.send('sidebar-tree', { tree });
        entry.win.webContents.send('sidebar-highlight', { currentPath: filePath });
      } catch (treeErr) {
        console.error(`[doculight] Failed to build link tree: ${treeErr.message}`);
      }

      // Update tray menu with new title
      if (typeof windowManager.onTrayUpdate === 'function') {
        windowManager.onTrayUpdate();
      }

      // Start file watcher for dropped file
      windowManager.startFileWatcher(windowId);

      // Track in recent files
      addRecentFile(filePath);
    } catch (err) {
      console.error(`[doculight] file-dropped error: ${err.message}`);
    }
  });

  // File opened in a new tab (track recent + start watcher, no render-markdown sent)
  ipcMain.on('file-opened-in-tab', async (event, filePath) => {
    try {
      if (path.extname(filePath).toLowerCase() !== '.md') return;
      const win = BrowserWindow.fromWebContents(event.sender);
      const windowId = windowManager.findWindowId(win);
      if (!windowId) return;
      const entry = windowManager.getWindowEntry(windowId);
      if (!entry) return;

      // Update meta for the window (root stays the same)
      entry.meta.filePath = filePath;
      if (!entry.meta.rootFilePath) entry.meta.rootFilePath = filePath;

      // Start file watcher
      windowManager.startFileWatcher(windowId);

      // Track in recent files
      addRecentFile(filePath);
    } catch (err) {
      console.error(`[doculight] file-opened-in-tab error: ${err.message}`);
    }
  });

  // Toggle always-on-top
  ipcMain.on('toggle-always-on-top', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    const current = win.isAlwaysOnTop();
    win.setAlwaysOnTop(!current);
    const windowId = windowManager.findWindowId(win);
    if (windowId) {
      const entry = windowManager.getWindowEntry(windowId);
      if (entry) entry.meta.alwaysOnTop = !current;
    }
    event.sender.send('always-on-top-changed', { alwaysOnTop: !current });
  });

  // Set always-on-top (from renderer preferences restore)
  ipcMain.on('set-always-on-top', (event, value) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    win.setAlwaysOnTop(!!value);
    const windowId = windowManager.findWindowId(win);
    if (windowId) {
      const entry = windowManager.getWindowEntry(windowId);
      if (entry) entry.meta.alwaysOnTop = !!value;
    }
    event.sender.send('always-on-top-changed', { alwaysOnTop: !!value });
  });

  // Release always-on-top
  ipcMain.on('release-always-on-top', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.setAlwaysOnTop(false);
      const windowId = windowManager.findWindowId(win);
      if (windowId) {
        const entry = windowManager.getWindowEntry(windowId);
        if (entry) entry.meta.alwaysOnTop = false;
      }
      event.sender.send('always-on-top-changed', { alwaysOnTop: false });
    }
  });

  // PDF Export
  ipcMain.handle('export-pdf', async (event, opts) => {
    if (isExporting) {
      return { error: 'Export already in progress' };
    }

    const { scope, pageSize } = opts || {};
    if (!scope || !['current', 'all'].includes(scope)) {
      return { error: 'Invalid scope' };
    }
    if (!pageSize || !['A4', 'Letter'].includes(pageSize)) {
      return { error: 'Invalid pageSize' };
    }

    const senderWin = BrowserWindow.fromWebContents(event.sender);
    const senderWindowId = windowManager.findWindowId(senderWin);
    if (!senderWindowId) {
      return { error: 'Window not found' };
    }
    const senderEntry = windowManager.getWindowEntry(senderWindowId);

    isExporting = true;
    let cancelled = false;
    let cancelHandler = null;

    try {
      if (scope === 'current') {
        // Single file export
        const currentFilePath = senderEntry.meta.filePath;
        const defaultName = currentFilePath
          ? path.basename(currentFilePath, path.extname(currentFilePath)) + '.pdf'
          : 'document.pdf';

        const saveResult = await dialog.showSaveDialog(senderWin, {
          defaultPath: defaultName,
          filters: [{ name: 'PDF', extensions: ['pdf'] }]
        });

        if (saveResult.canceled || !saveResult.filePath) {
          return { cancelled: true };
        }

        const savePath = saveResult.filePath;

        // Get the markdown content from the active window
        const filePath = senderEntry.meta.filePath;
        let markdown;
        if (filePath) {
          markdown = await fs.promises.readFile(filePath, 'utf-8');
        } else {
          return { error: 'No file to export' };
        }

        // Create hidden BrowserWindow for PDF rendering
        const pdfWin = new BrowserWindow({
          show: false,
          width: 800,
          height: 600,
          webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
          }
        });

        try {
          await pdfWin.loadFile(path.join(__dirname, '../renderer/viewer.html'));

          // Wait for window-ready
          await new Promise((resolve) => {
            const readyHandler = (readyEvent) => {
              const readyWin = BrowserWindow.fromWebContents(readyEvent.sender);
              if (readyWin === pdfWin) {
                ipcMain.removeListener('window-ready', readyHandler);
                resolve();
              }
            };
            ipcMain.on('window-ready', readyHandler);
          });

          // Send settings
          const theme = store.get('theme');
          const codeTheme = store.get('codeTheme');
          const fontSize = store.get('fontSize');
          const fontFamily = store.get('fontFamily');
          if (theme !== 'light') {
            pdfWin.webContents.send('theme-changed', { theme });
          }
          pdfWin.webContents.send('settings-changed', { fontSize, fontFamily, codeTheme });

          // Send markdown with pdfMode flag
          const imageBasePath = senderEntry.meta.tree
            ? path.dirname(senderEntry.meta.tree.path).replace(/\\/g, '/')
            : (filePath ? path.dirname(filePath).replace(/\\/g, '/') : null);
          pdfWin.webContents.send('render-markdown', {
            markdown,
            filePath: filePath ? filePath.replace(/\\/g, '/') : null,
            imageBasePath,
            platform: process.platform,
            pdfMode: true
          });

          // Wait for pdf-render-complete with 30s timeout
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              ipcMain.removeListener('pdf-render-complete', completeHandler);
              reject(new Error('PDF render timeout'));
            }, 30000);

            const completeHandler = (completeEvent) => {
              const completeWin = BrowserWindow.fromWebContents(completeEvent.sender);
              if (completeWin === pdfWin) {
                clearTimeout(timer);
                ipcMain.removeListener('pdf-render-complete', completeHandler);
                resolve();
              }
            };
            ipcMain.on('pdf-render-complete', completeHandler);
          });

          // Print to PDF
          const buffer = await pdfWin.webContents.printToPDF({
            pageSize,
            printBackground: true,
            margins: { marginType: 'default' }
          });

          await fs.promises.writeFile(savePath, buffer);
          return { success: true, path: savePath };
        } finally {
          if (!pdfWin.isDestroyed()) pdfWin.close();
        }

      } else {
        // Batch export (scope === 'all') — merge into single PDF
        const tree = senderEntry.meta.tree;
        if (!tree) {
          return { error: 'No sidebar tree available' };
        }

        const mdPaths = collectMdPaths(tree);
        if (mdPaths.length === 0) {
          return { error: 'No markdown files found' };
        }

        const saveResult = await dialog.showSaveDialog(senderWin, {
          defaultPath: 'all-documents.pdf',
          filters: [{ name: 'PDF', extensions: ['pdf'] }]
        });

        if (saveResult.canceled || !saveResult.filePath) {
          return { cancelled: true };
        }

        const savePath = saveResult.filePath;

        // Register cancel handler
        cancelHandler = () => { cancelled = true; };
        ipcMain.once('cancel-export', cancelHandler);

        // Collect PDF buffers from each file
        const pdfBuffers = [];
        let completed = 0;
        for (const mdPath of mdPaths) {
          if (cancelled) break;

          const fileName = path.basename(mdPath);
          completed++;
          event.sender.send('export-progress', {
            current: completed,
            total: mdPaths.length,
            fileName
          });

          try {
            const markdown = await fs.promises.readFile(mdPath, 'utf-8');

            const pdfWin = new BrowserWindow({
              show: false,
              width: 800,
              height: 600,
              webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true
              }
            });

            try {
              await pdfWin.loadFile(path.join(__dirname, '../renderer/viewer.html'));

              await new Promise((resolve) => {
                const readyHandler = (readyEvent) => {
                  const readyWin = BrowserWindow.fromWebContents(readyEvent.sender);
                  if (readyWin === pdfWin) {
                    ipcMain.removeListener('window-ready', readyHandler);
                    resolve();
                  }
                };
                ipcMain.on('window-ready', readyHandler);
              });

              const theme = store.get('theme');
              const codeTheme = store.get('codeTheme');
              const fontSize = store.get('fontSize');
              const fontFamily = store.get('fontFamily');
              if (theme !== 'light') {
                pdfWin.webContents.send('theme-changed', { theme });
              }
              pdfWin.webContents.send('settings-changed', { fontSize, fontFamily, codeTheme });

              const batchImageBasePath = tree
                ? path.dirname(tree.path).replace(/\\/g, '/')
                : path.dirname(mdPath).replace(/\\/g, '/');
              pdfWin.webContents.send('render-markdown', {
                markdown,
                filePath: mdPath.replace(/\\/g, '/'),
                imageBasePath: batchImageBasePath,
                platform: process.platform,
                pdfMode: true
              });

              await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                  ipcMain.removeListener('pdf-render-complete', completeHandler);
                  reject(new Error('PDF render timeout'));
                }, 30000);

                const completeHandler = (completeEvent) => {
                  const completeWin = BrowserWindow.fromWebContents(completeEvent.sender);
                  if (completeWin === pdfWin) {
                    clearTimeout(timer);
                    ipcMain.removeListener('pdf-render-complete', completeHandler);
                    resolve();
                  }
                };
                ipcMain.on('pdf-render-complete', completeHandler);
              });

              const buffer = await pdfWin.webContents.printToPDF({
                pageSize,
                printBackground: true,
                margins: { marginType: 'default' }
              });

              pdfBuffers.push(buffer);
            } finally {
              if (!pdfWin.isDestroyed()) pdfWin.close();
            }
          } catch (fileErr) {
            console.error(`[doculight] PDF export error for ${mdPath}: ${fileErr.message}`);
          }
        }

        if (cancelled) {
          return { cancelled: true };
        }

        // Merge all PDF buffers into a single PDF using pdf-lib
        const { PDFDocument } = await import('pdf-lib');
        const mergedPdf = await PDFDocument.create();

        for (const buf of pdfBuffers) {
          const srcDoc = await PDFDocument.load(buf);
          const pages = await mergedPdf.copyPages(srcDoc, srcDoc.getPageIndices());
          for (const page of pages) {
            mergedPdf.addPage(page);
          }
        }

        const mergedBytes = await mergedPdf.save();
        await fs.promises.writeFile(savePath, Buffer.from(mergedBytes));

        return { success: true, path: savePath, count: pdfBuffers.length };
      }
    } catch (err) {
      console.error(`[doculight] export-pdf error: ${err.message}`);
      return { error: err.message };
    } finally {
      isExporting = false;
      if (cancelHandler) {
        ipcMain.removeListener('cancel-export', cancelHandler);
      }
    }
  });

  // Tab: read a file for opening in a new tab
  ipcMain.handle('read-file-for-tab', async (_event, filePath) => {
    try {
      // Input validation
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
        return { error: 'Invalid file path' };
      }
      const ext = path.extname(filePath).toLowerCase();
      if (ext !== '.md' && ext !== '.markdown') {
        return { error: 'Invalid file path' };
      }
      // Check file exists
      try {
        await fs.promises.access(filePath, fs.constants.R_OK);
      } catch {
        return { error: 'File not found' };
      }

      const markdown = await fs.promises.readFile(filePath, 'utf-8');

      // Build sidebar tree from file's directory
      let sidebarTree = null;
      try {
        const { buildDirectoryTree } = require('./link-parser');
        sidebarTree = buildDirectoryTree(path.dirname(filePath));
      } catch (err) {
        console.error(`[doculight] Failed to build tree for tab: ${err.message}`);
      }

      // Extract title (first H1)
      const titleMatch = markdown.match(/^#\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : path.basename(filePath, ext);

      return {
        markdown,
        filePath: filePath.replace(/\\/g, '/'),
        title,
        sidebarTree,
        imageBasePath: path.dirname(filePath).replace(/\\/g, '/'),
        platform: process.platform
      };
    } catch (err) {
      return { error: err.message };
    }
  });

  // Tab: check file modification time
  ipcMain.handle('check-file-mtime', async (_event, filePath) => {
    try {
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
        return { mtime: 0, exists: false };
      }
      const ext = path.extname(filePath).toLowerCase();
      if (ext !== '.md' && ext !== '.markdown') {
        return { mtime: 0, exists: false };
      }
      const stat = await fs.promises.stat(filePath);
      return { mtime: stat.mtimeMs, exists: true };
    } catch {
      return { mtime: 0, exists: false };
    }
  });

  // Sidebar content search
  ipcMain.handle('search-sidebar-content', async (_event, query, rootDir) => {
    // Validate inputs
    if (typeof query !== 'string' || query.trim().length < 2) {
      return { results: [] };
    }
    if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) {
      return { results: [] };
    }
    try {
      const stat = await fs.promises.stat(rootDir);
      if (!stat.isDirectory()) return { results: [] };
    } catch {
      return { results: [] };
    }

    const trimmedQuery = query.trim();
    const lowerQuery = trimmedQuery.toLowerCase();
    const escapedQuery = trimmedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const queryRegex = new RegExp(escapedQuery, 'gi');

    const MAX_RESULTS = 20;
    const MAX_MATCHES_PER_FILE = 3;
    const MAX_FILE_SIZE = 1024 * 1024; // 1MB
    const MAX_SNIPPET_LEN = 120;
    const TIMEOUT_MS = 5000;

    const results = [];
    const startTime = Date.now();

    async function walkDir(dir) {
      if (Date.now() - startTime > TIMEOUT_MS) return;
      if (results.length >= MAX_RESULTS) return;

      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (Date.now() - startTime > TIMEOUT_MS) return;
        if (results.length >= MAX_RESULTS) return;
        if (entry.name.startsWith('.')) continue;

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await walkDir(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (ext !== '.md' && ext !== '.markdown') continue;

          try {
            const fileStat = await fs.promises.stat(fullPath);
            if (fileStat.size > MAX_FILE_SIZE) continue;

            const content = await fs.promises.readFile(fullPath, 'utf-8');
            const fileName = path.basename(fullPath, ext);
            const matches = findContentMatches(content, fileName, lowerQuery, queryRegex, MAX_MATCHES_PER_FILE, MAX_SNIPPET_LEN);

            if (matches.length > 0) {
              // Extract title (first H1)
              const titleMatch = content.match(/^#\s+(.+)$/m);
              const title = titleMatch ? titleMatch[1].trim() : fileName;
              results.push({
                filePath: fullPath,
                fileName: entry.name,
                title,
                matches
              });
            }
          } catch {
            // Skip unreadable files
          }
        }
      }
    }

    await walkDir(rootDir);

    // Sort: filename matches first, then title, then content
    results.sort((a, b) => {
      const aPriority = Math.min(...a.matches.map(m => m.priority));
      const bPriority = Math.min(...b.matches.map(m => m.priority));
      return aPriority - bPriority;
    });

    return { results: results.slice(0, MAX_RESULTS) };
  });

  // Tab: open file dialog for new tab
  ipcMain.handle('open-file-dialog', async () => {
    const result = await dialog.showOpenDialog({
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { filePath: null };
    }
    return { filePath: result.filePaths[0] };
  });

  // === Save As (FR-21-002) ===
  ipcMain.handle('save-as', async (event, params) => {
    try {
      const parentWindow = BrowserWindow.fromWebContents(event.sender);
      const lastDir = store.get('lastSaveAsDirectory', '');
      const defaultName = params.defaultFileName || 'untitled.md';
      const defaultPath = lastDir ? path.join(lastDir, defaultName) : defaultName;

      const result = await dialog.showSaveDialog(parentWindow, {
        defaultPath,
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      });

      if (result.canceled) {
        return { success: false };
      }

      const savePath = result.filePath;
      store.set('lastSaveAsDirectory', path.dirname(savePath));

      if (params.filePath) {
        await fs.promises.copyFile(params.filePath, savePath);
      } else {
        await fs.promises.writeFile(savePath, params.content || '', 'utf-8');
      }

      return { success: true, filePath: savePath };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // === Quick Save (FR-21-003) ===
  ipcMain.handle('quick-save', async (_event, params) => {
    try {
      const lastDir = store.get('lastSaveAsDirectory', '');
      if (!lastDir) {
        return { success: false, reason: 'no-directory' };
      }

      const defaultName = params.defaultFileName || 'untitled.md';
      const savePath = path.join(lastDir, defaultName);

      if (params.filePath) {
        await fs.promises.copyFile(params.filePath, savePath);
      } else {
        await fs.promises.writeFile(savePath, params.content || '', 'utf-8');
      }

      return { success: true, filePath: savePath };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // === Delete Auto-Saved File (FR-21-001) ===
  ipcMain.handle('delete-auto-saved-file', async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) {
        return { success: false, error: 'window not found' };
      }

      const windowId = windowManager.findWindowId(win);
      if (!windowId) {
        return { success: false, error: 'window not found' };
      }

      const entry = windowManager.getWindowEntry(windowId);
      if (!entry || !entry.meta.savedFilePath) {
        return { success: false, error: 'no saved file' };
      }

      const deletedPath = entry.meta.savedFilePath;
      try {
        await fs.promises.unlink(deletedPath);
      } catch (err) {
        if (err.code === 'ENOENT') {
          // Already deleted externally — treat as success
          entry.meta.savedFilePath = null;
          return { success: true, deletedPath };
        }
        return { success: false, error: err.message };
      }

      entry.meta.savedFilePath = null;
      if (!entry.win.isDestroyed()) {
        entry.win.setTitle(windowManager.formatWindowTitle(entry.meta.title, entry.meta.filePath, null));
      }
      return { success: true, deletedPath };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Read a local image file and return it as a base64 data URL.
  // This is needed because Electron's sandbox prevents file:// image loading
  // across directories from a file:// page (Chromium same-origin policy).
  ipcMain.handle('read-image-as-data-url', async (_event, rawPath) => {
    try {
      if (typeof rawPath !== 'string' || !rawPath) return { error: 'Invalid path' };

      // Normalize forward slashes to OS path separator and resolve
      const normalized = path.normalize(rawPath.replace(/\//g, path.sep));

      // Must be absolute
      if (!path.isAbsolute(normalized)) return { error: 'Not an absolute path' };

      // Only allow known image extensions
      const ext = path.extname(normalized).toLowerCase();
      const MIME_MAP = {
        '.svg':  'image/svg+xml',
        '.png':  'image/png',
        '.jpg':  'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif':  'image/gif',
        '.webp': 'image/webp',
        '.bmp':  'image/bmp',
        '.ico':  'image/x-icon',
        '.tiff': 'image/tiff',
        '.avif': 'image/avif',
      };
      const mime = MIME_MAP[ext];
      if (!mime) return { error: 'Not an allowed image type' };

      // Check the file is readable
      await fs.promises.access(normalized, fs.constants.R_OK);

      const data = await fs.promises.readFile(normalized);
      return { dataUrl: `data:${mime};base64,${data.toString('base64')}` };
    } catch (err) {
      return { error: err.message };
    }
  });
}
