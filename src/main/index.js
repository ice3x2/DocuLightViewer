// src/main/index.js — Electron App Entry Point + IPC Socket Server
// CommonJS module for Electron main process

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } = require('electron');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { WindowManager } = require('./window-manager');
const Store = require('electron-store');

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
}

const store = new Store({
  schema: {
    theme: { type: 'string', enum: ['light', 'dark'], default: 'light' },
    fontSize: { type: 'number', minimum: 8, maximum: 32, default: 16 },
    fontFamily: { type: 'string', minLength: 1, default: 'system-ui, -apple-system, sans-serif' },
    codeTheme: { type: 'string', default: 'github' },
    mcpPort: { type: 'number', minimum: 1024, maximum: 65535, default: 52580 },
    fileAssociation: { type: 'boolean', default: false },
    fileAssociationPrevProgId: { type: 'string', default: '' }
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
      // No .md files — focus first available viewer window
      const windows = windowManager.listWindows();
      if (windows.length > 0) {
        const entry = windowManager.getWindowEntry(windows[0].windowId);
        if (entry && entry.win) {
          if (entry.win.isMinimized()) entry.win.restore();
          entry.win.focus();
        }
      }
    }
  });
}

// =============================================================================
// App Lifecycle
// =============================================================================
app.on('ready', async () => {
  Menu.setApplicationMenu(null);
  cleanupStaleSocket();
  createTray();
  startIpcServer();
  registerIpcHandlers();

  // Wire up tray menu updates whenever windows change
  windowManager.onTrayUpdate = updateTrayMenu;

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
    mcpHttpServer = await startMcpHttpServer(windowManager, store);
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
});

app.on('window-all-closed', () => {
  // Don't quit — stay alive in tray mode.
  // On macOS this is the default behavior; on Windows/Linux we simply
  // do nothing so the app keeps running with the system tray icon.
});

app.on('before-quit', () => {
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
      label: info.title || `Window ${info.windowId}`,
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
      label: `외 ${windows.length - MAX_TRAY_ITEMS}개...`,
      enabled: false,
    });
  }

  // Separator before global actions
  if (windows.length > 0) {
    menuItems.push({ type: 'separator' });
  }

  menuItems.push({
    label: '새 뷰어',
    click: () => {
      windowManager.createEmptyWindow();
    },
  });

  menuItems.push({
    label: '모든 창 닫기',
    enabled: windows.length > 0,
    click: () => {
      windowManager.closeWindow(); // close all
    },
  });

  menuItems.push({ type: 'separator' });

  menuItems.push({
    label: '설정',
    click: () => {
      openSettingsWindow();
    },
  });

  menuItems.push({
    label: 'DocuLight 종료',
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
    title: 'DocuLight 설정',
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
        break;

      case 'update_markdown':
        result = await windowManager.updateWindow(params.windowId, params);
        break;

      case 'close_viewer':
        result = windowManager.closeWindow(params?.windowId);
        break;

      case 'list_viewers':
        result = { windows: windowManager.listWindows() };
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
// IPC Handlers — Renderer ↔ Main Process Communication
// =============================================================================

function registerIpcHandlers() {
  // --- File Association IPC ---
  const fileAssoc = require('./file-association');
  fileAssoc.init(store);

  ipcMain.handle('register-file-association', async () => {
    if (!fileAssoc.isSupported()) {
      return { success: false, message: '빌드된 앱에서만 사용 가능합니다' };
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
        filePath,
        windowId
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
    } catch (err) {
      console.error(`[doculight] file-dropped error: ${err.message}`);
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
}
