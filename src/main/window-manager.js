// src/main/window-manager.js — Window lifecycle & navigation management for DocuLight
'use strict';

const { BrowserWindow, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { buildDirectoryTree } = require('./link-parser');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SIZE_PRESETS = {
  s: { width: 480, height: 680 },
  m: { width: 720, height: 1024 },
  l: { width: 1080, height: 1440 }
};

const MAX_WINDOWS = 20;

// ---------------------------------------------------------------------------
// NavigationHistory — per-window back/forward stack
// ---------------------------------------------------------------------------

class NavigationHistory {
  constructor() {
    this.stack = [];
    this.index = -1;
    this.MAX_SIZE = 50;
  }

  /**
   * Push a new filePath, discarding any forward history.
   * Trims the oldest entry when the stack exceeds MAX_SIZE.
   */
  push(filePath) {
    // Remove forward history beyond current position
    this.stack.splice(this.index + 1);
    this.stack.push(filePath);
    this.index = this.stack.length - 1;

    // Trim oldest if exceeding MAX_SIZE
    if (this.stack.length > this.MAX_SIZE) {
      this.stack.shift();
      this.index--;
    }
  }

  /** Move back one step. Returns the filePath or null if at the beginning. */
  back() {
    if (this.index > 0) {
      this.index--;
      return this.stack[this.index];
    }
    return null;
  }

  /** Move forward one step. Returns the filePath or null if at the end. */
  forward() {
    if (this.index < this.stack.length - 1) {
      this.index++;
      return this.stack[this.index];
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// WindowManager
// ---------------------------------------------------------------------------

class WindowManager {
  constructor() {
    /** @type {Map<string, { win: BrowserWindow, meta: object }>} */
    this.windows = new Map();

    /** Last window position for cascading placement */
    this.lastPosition = { x: 0, y: 0 };

    /** Callback invoked whenever the window list changes (set by index.js) */
    this.onTrayUpdate = null;

    /**
     * Pending promises for windows that have been created but have not yet
     * sent the 'window-ready' IPC message from the renderer.
     * @type {Map<string, { resolve: Function, content: string, filePath: string|null, title: string }>}
     */
    this.pendingReady = new Map();

    /** @type {import('electron-store')|null} */
    this.store = null;
  }

  /**
   * Set the electron-store instance for reading default window size settings.
   * @param {import('electron-store')} store
   */
  setStore(store) {
    this.store = store;
  }

  // -----------------------------------------------------------------------
  // createWindow
  // -----------------------------------------------------------------------

  /**
   * Create a new viewer window.
   *
   * @param {object}  opts
   * @param {string}  [opts.content]    - Raw markdown string to render.
   * @param {string}  [opts.filePath]   - Path to a .md file on disk.
   * @param {boolean} [opts.foreground] - If false the window will not steal focus (default true).
   * @param {string}  [opts.title]      - Explicit window title override.
   * @param {string}  [opts.size]       - One of 's', 'm', 'l', 'f' (default 'm').
   * @returns {Promise<{ windowId: string, title: string }>}
   */
  async createWindow(opts = {}) {
    const { foreground, title: explicitTitle, size } = opts;
    let { content, filePath } = opts;

    // --- Validate inputs ---------------------------------------------------
    if (!content && !filePath) {
      throw new Error('Either content or filePath must be provided');
    }

    // If filePath is supplied, read from disk
    if (filePath) {
      if (path.extname(filePath).toLowerCase() !== '.md') {
        throw new Error(`Only .md files are supported: ${filePath}`);
      }
      content = await fs.promises.readFile(filePath, 'utf-8');
    }

    // Enforce window cap
    if (this.windows.size >= MAX_WINDOWS) {
      throw new Error(`Maximum number of windows (${MAX_WINDOWS}) reached`);
    }

    // --- Window identity ---------------------------------------------------
    const windowId = crypto.randomUUID();

    // --- Size & position ---------------------------------------------------
    // If size is not explicitly provided (file open, drag & drop, etc.),
    // read the default from settings
    const effectiveSize = size || (this.store ? this.store.get('defaultWindowSize', 'auto') : 'm');
    const { width, height } = this.resolveWindowSize(effectiveSize);

    // For 'auto' mode with saved bounds and first window, restore position
    let resolvedPos;
    if (effectiveSize === 'auto' && this.store && this.windows.size === 0) {
      const saved = this.store.get('lastWindowBounds', {});
      if (saved.x !== undefined && saved.y !== undefined) {
        resolvedPos = { x: saved.x, y: saved.y };
      }
    }
    if (!resolvedPos) {
      resolvedPos = this.getNextPosition(width, height);
    }
    const { x, y } = resolvedPos;

    // --- Title -------------------------------------------------------------
    const resolvedTitle =
      explicitTitle ||
      this.extractTitle(content) ||
      (filePath ? path.basename(filePath, '.md') : null) ||
      'DocuLight';

    // --- Create BrowserWindow ----------------------------------------------
    const win = new BrowserWindow({
      width,
      height,
      x,
      y,
      title: resolvedTitle,
      icon: path.join(__dirname, '../../assets/icon.png'),
      show: false, // shown after ready-to-show
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    // Fullscreen preset: maximize after creation
    if (effectiveSize === 'f') {
      win.maximize();
    }

    // Load the viewer HTML
    win.loadFile(path.join(__dirname, '../renderer/viewer.html'));

    // --- Navigation history ------------------------------------------------
    const history = new NavigationHistory();
    if (filePath) {
      history.push(filePath);
    }

    // --- Store window entry ------------------------------------------------
    this.windows.set(windowId, {
      win,
      meta: {
        windowId,
        filePath: filePath || null,
        title: resolvedTitle,
        alwaysOnTop: false,
        rootFilePath: filePath || null,
        tree: null, // populated in Phase 5
        history
      }
    });

    // --- Lifecycle events --------------------------------------------------
    // Save window bounds when closing (for 'auto' default size mode)
    win.on('close', () => {
      if (this.store && this.store.get('defaultWindowSize') === 'auto') {
        if (!win.isMaximized() && !win.isMinimized()) {
          this.store.set('lastWindowBounds', win.getBounds());
        }
      }
    });

    win.on('closed', () => {
      this.windows.delete(windowId);
      this.pendingReady.delete(windowId);
      if (typeof this.onTrayUpdate === 'function') {
        this.onTrayUpdate();
      }
    });

    // Show behaviour depends on foreground flag
    if (foreground !== false) {
      win.once('ready-to-show', () => {
        win.show();
        win.focus();
      });
    } else {
      win.once('ready-to-show', () => {
        win.show();
      });
    }

    // Notify tray / listeners that window list changed
    if (typeof this.onTrayUpdate === 'function') {
      this.onTrayUpdate();
    }

    // --- Return promise that resolves on window-ready IPC ------------------
    return new Promise((resolve) => {
      this.pendingReady.set(windowId, {
        resolve,
        content,
        filePath: filePath || null,
        title: resolvedTitle
      });
    });
  }

  // -----------------------------------------------------------------------
  // onWindowReady — called when renderer sends 'window-ready' IPC
  // -----------------------------------------------------------------------

  /**
   * Handle the 'window-ready' IPC message from a renderer process.
   * Sends the initial markdown payload and resolves the createWindow promise.
   *
   * @param {string} windowId
   */
  onWindowReady(windowId) {
    const pending = this.pendingReady.get(windowId);
    if (!pending) return;

    const entry = this.windows.get(windowId);
    if (!entry) return;

    const { resolve, content, filePath, title } = pending;

    if (content != null) {
      // Normal window: send initial content to the renderer
      entry.win.webContents.send('render-markdown', {
        markdown: content,
        filePath: filePath,
        windowId: windowId
      });

      // Build sidebar tree for filePath-based windows
      if (filePath) {
        try {
          const tree = buildDirectoryTree(path.dirname(filePath));
          entry.meta.tree = tree;
          entry.win.webContents.send('sidebar-tree', { tree });
          entry.win.webContents.send('sidebar-highlight', { currentPath: filePath });
        } catch (err) {
          console.error(`[doculight] Failed to build link tree: ${err.message}`);
        }
      }
    } else {
      // Empty window: notify renderer to show drop zone
      entry.win.webContents.send('empty-window', { windowId });
    }

    // Clean up pending state
    this.pendingReady.delete(windowId);

    // Ensure the window is visible
    if (!entry.win.isVisible()) {
      entry.win.show();
    }

    // Resolve the createWindow promise (may be null for empty windows)
    if (typeof resolve === 'function') {
      resolve({ windowId, title });
    }
  }

  // -----------------------------------------------------------------------
  // closeWindow
  // -----------------------------------------------------------------------

  /**
   * Close one or all windows.
   *
   * @param {string} [windowId] - Specific window to close. Omit to close all.
   * @returns {{ closed: number }}
   */
  closeWindow(windowId) {
    if (!windowId) {
      const count = this.windows.size;
      for (const [, entry] of this.windows) {
        entry.win.close();
      }
      return { closed: count };
    }

    const entry = this.windows.get(windowId);
    if (!entry) {
      throw new Error(`Window not found: ${windowId}`);
    }
    entry.win.close();
    return { closed: 1 };
  }

  // -----------------------------------------------------------------------
  // updateWindow
  // -----------------------------------------------------------------------

  /**
   * Update the content of an existing window.
   *
   * @param {string} windowId
   * @param {object} opts
   * @param {string} [opts.content]  - New markdown content.
   * @param {string} [opts.filePath] - Path to .md file (overrides content).
   * @param {string} [opts.title]    - New window title.
   * @returns {Promise<{ title: string }>}
   */
  async updateWindow(windowId, opts = {}) {
    const entry = this.windows.get(windowId);
    if (!entry) {
      throw new Error(`Window not found: ${windowId}`);
    }

    let { content, filePath, title } = opts;

    // Read from disk if filePath provided
    if (filePath) {
      if (path.extname(filePath).toLowerCase() !== '.md') {
        throw new Error(`Only .md files are supported: ${filePath}`);
      }
      content = await fs.promises.readFile(filePath, 'utf-8');
    }

    if (content == null) {
      throw new Error('Either content or filePath must be provided for update');
    }

    // Resolve title
    const resolvedTitle =
      title ||
      this.extractTitle(content) ||
      (filePath ? path.basename(filePath, '.md') : null) ||
      entry.meta.title;

    // Send updated content to renderer
    entry.win.webContents.send('update-markdown', {
      markdown: content,
      filePath: filePath || entry.meta.filePath,
      windowId
    });

    // Update metadata
    entry.meta.title = resolvedTitle;
    if (filePath) {
      entry.meta.filePath = filePath;
    }
    entry.win.setTitle(resolvedTitle);

    return { title: resolvedTitle };
  }

  // -----------------------------------------------------------------------
  // listWindows
  // -----------------------------------------------------------------------

  /**
   * List all open windows with their metadata.
   *
   * @returns {Array<{ windowId: string, title: string, alwaysOnTop: boolean }>}
   */
  listWindows() {
    const result = [];
    for (const [windowId, entry] of this.windows) {
      result.push({
        windowId,
        title: entry.meta.title,
        alwaysOnTop: entry.meta.alwaysOnTop
      });
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // findWindowId
  // -----------------------------------------------------------------------

  /**
   * Find the windowId for a given BrowserWindow instance.
   *
   * @param {BrowserWindow} win
   * @returns {string|null}
   */
  findWindowId(win) {
    for (const [windowId, entry] of this.windows) {
      if (entry.win === win) {
        return windowId;
      }
    }
    return null;
  }

  // -----------------------------------------------------------------------
  // getWindowEntry
  // -----------------------------------------------------------------------

  /**
   * Get the full window entry (win + meta) for a given windowId.
   *
   * @param {string} windowId
   * @returns {{ win: BrowserWindow, meta: object }|undefined}
   */
  getWindowEntry(windowId) {
    return this.windows.get(windowId);
  }

  // -----------------------------------------------------------------------
  // Navigation
  // -----------------------------------------------------------------------

  /**
   * Navigate a window to a different markdown file.
   *
   * @param {string} windowId
   * @param {string} rawPath - Relative or absolute path to the .md file.
   */
  async navigateTo(windowId, rawPath) {
    const entry = this.windows.get(windowId);
    if (!entry) {
      throw new Error(`Window not found: ${windowId}`);
    }

    // Resolve relative paths against current file's directory
    let filePath = rawPath;
    if (!path.isAbsolute(rawPath) && entry.meta.filePath) {
      filePath = path.resolve(path.dirname(entry.meta.filePath), rawPath);
    }

    // Ensure .md extension
    if (!filePath.endsWith('.md')) {
      filePath += '.md';
    }

    const content = await fs.promises.readFile(filePath, 'utf-8');

    // Push to history
    entry.meta.history.push(filePath);

    // Send content to renderer
    entry.win.webContents.send('render-markdown', {
      markdown: content,
      filePath,
      windowId
    });

    // Highlight current file in sidebar (Root-Preserving: tree structure doesn't change)
    entry.win.webContents.send('sidebar-highlight', {
      currentPath: filePath
    });

    // Update metadata
    entry.meta.filePath = filePath;

    // Update window title
    const title = this.extractTitle(content) || path.basename(filePath, '.md');
    entry.meta.title = title;
    entry.win.setTitle(title);
  }

  /**
   * Navigate back in the window's history.
   *
   * @param {string} windowId
   */
  async navigateBack(windowId) {
    const entry = this.windows.get(windowId);
    if (!entry) {
      throw new Error(`Window not found: ${windowId}`);
    }

    const filePath = entry.meta.history.back();
    if (!filePath) return; // no more history

    const content = await fs.promises.readFile(filePath, 'utf-8');

    entry.win.webContents.send('render-markdown', {
      markdown: content,
      filePath,
      windowId
    });

    entry.win.webContents.send('sidebar-highlight', {
      currentPath: filePath
    });

    entry.meta.filePath = filePath;
  }

  /**
   * Navigate forward in the window's history.
   *
   * @param {string} windowId
   */
  async navigateForward(windowId) {
    const entry = this.windows.get(windowId);
    if (!entry) {
      throw new Error(`Window not found: ${windowId}`);
    }

    const filePath = entry.meta.history.forward();
    if (!filePath) return; // no more forward history

    const content = await fs.promises.readFile(filePath, 'utf-8');

    entry.win.webContents.send('render-markdown', {
      markdown: content,
      filePath,
      windowId
    });

    entry.win.webContents.send('sidebar-highlight', {
      currentPath: filePath
    });

    entry.meta.filePath = filePath;
  }

  // -----------------------------------------------------------------------
  // createEmptyWindow
  // -----------------------------------------------------------------------

  /**
   * Create an empty viewer window (no content). The user can drag & drop
   * a .md file onto it to open a document.
   *
   * @param {object} [opts]
   * @param {string} [opts.size] - One of 's', 'm', 'l', 'f' (default 'm').
   * @returns {Promise<{ windowId: string, title: string }>}
   */
  async createEmptyWindow(opts = {}) {
    const { size } = opts;

    // Enforce window cap
    if (this.windows.size >= MAX_WINDOWS) {
      throw new Error(`Maximum number of windows (${MAX_WINDOWS}) reached`);
    }

    const windowId = crypto.randomUUID();
    const effectiveSize = size || (this.store ? this.store.get('defaultWindowSize', 'auto') : 'm');
    const { width, height } = this.resolveWindowSize(effectiveSize);

    let resolvedPos;
    if (effectiveSize === 'auto' && this.store && this.windows.size === 0) {
      const saved = this.store.get('lastWindowBounds', {});
      if (saved.x !== undefined && saved.y !== undefined) {
        resolvedPos = { x: saved.x, y: saved.y };
      }
    }
    if (!resolvedPos) {
      resolvedPos = this.getNextPosition(width, height);
    }
    const { x, y } = resolvedPos;
    const resolvedTitle = 'DocuLight';

    const win = new BrowserWindow({
      width,
      height,
      x,
      y,
      title: resolvedTitle,
      icon: path.join(__dirname, '../../assets/icon.png'),
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    if (effectiveSize === 'f') {
      win.maximize();
    }

    win.loadFile(path.join(__dirname, '../renderer/viewer.html'));

    const history = new NavigationHistory();

    this.windows.set(windowId, {
      win,
      meta: {
        windowId,
        filePath: null,
        title: resolvedTitle,
        alwaysOnTop: false,
        rootFilePath: null,
        tree: null,
        history
      }
    });

    win.on('close', () => {
      if (this.store && this.store.get('defaultWindowSize') === 'auto') {
        if (!win.isMaximized() && !win.isMinimized()) {
          this.store.set('lastWindowBounds', win.getBounds());
        }
      }
    });

    win.on('closed', () => {
      this.windows.delete(windowId);
      this.pendingReady.delete(windowId);
      if (typeof this.onTrayUpdate === 'function') {
        this.onTrayUpdate();
      }
    });

    win.once('ready-to-show', () => {
      win.show();
      win.focus();
    });

    if (typeof this.onTrayUpdate === 'function') {
      this.onTrayUpdate();
    }

    // Store pending with null content so onWindowReady knows this is empty
    this.pendingReady.set(windowId, {
      resolve: null,
      content: null,
      filePath: null,
      title: resolvedTitle
    });

    return { windowId, title: resolvedTitle };
  }

  // -----------------------------------------------------------------------
  // Helpers (private)
  // -----------------------------------------------------------------------

  /**
   * Resolve a size preset to concrete pixel dimensions, clamped to the
   * primary display's work area.
   *
   * @param {string} [size] - 's', 'm', 'l', or 'f'. Defaults to 'm'.
   * @returns {{ width: number, height: number }}
   */
  resolveWindowSize(size) {
    const primaryDisplay = screen.getPrimaryDisplay();
    const workArea = primaryDisplay.workAreaSize;

    // Fullscreen: return entire work area
    if (size === 'f') {
      return { width: workArea.width, height: workArea.height };
    }

    // Auto: use saved bounds if available, otherwise fall back to 'm'
    if (size === 'auto' && this.store) {
      const saved = this.store.get('lastWindowBounds', {});
      if (saved.width && saved.height) {
        return {
          width: Math.min(saved.width, workArea.width),
          height: Math.min(saved.height, workArea.height)
        };
      }
      size = 'm';
    }

    const preset = SIZE_PRESETS[size] || SIZE_PRESETS.m;

    return {
      width: Math.min(preset.width, workArea.width),
      height: Math.min(preset.height, workArea.height)
    };
  }

  /**
   * Calculate the next cascading window position.
   * First window is centred; subsequent windows are offset by (30, 30).
   * Wraps back to (0, 0) when the window would extend beyond the screen.
   *
   * @param {number} winWidth  - Width of the window being placed.
   * @param {number} winHeight - Height of the window being placed.
   * @returns {{ x: number, y: number }}
   */
  getNextPosition(winWidth, winHeight) {
    const primaryDisplay = screen.getPrimaryDisplay();
    const workArea = primaryDisplay.workArea; // { x, y, width, height }

    if (this.windows.size === 0) {
      // Centre the first window
      const x = workArea.x + Math.round((workArea.width - winWidth) / 2);
      const y = workArea.y + Math.round((workArea.height - winHeight) / 2);
      this.lastPosition = { x, y };
      return { x, y };
    }

    // Cascade offset
    let x = this.lastPosition.x + 30;
    let y = this.lastPosition.y + 30;

    // Wrap if the window would go beyond the screen edge
    if (x + winWidth > workArea.x + workArea.width ||
        y + winHeight > workArea.y + workArea.height) {
      x = workArea.x;
      y = workArea.y;
    }

    this.lastPosition = { x, y };
    return { x, y };
  }

  /**
   * Extract the first H1 heading from markdown content.
   *
   * @param {string} content - Raw markdown text.
   * @returns {string|null}
   */
  extractTitle(content) {
    if (!content) return null;
    const match = content.match(/^#\s+(.+)$/m);
    return match ? match[1].trim() : null;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { WindowManager };
