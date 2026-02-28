// src/main/window-manager.js — Window lifecycle & navigation management for DocuLight
'use strict';

const { BrowserWindow, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { buildDirectoryTree } = require('./link-parser');
const { t } = require('./strings');
const { injectFrontmatter } = require('./frontmatter');

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

    /** @type {Map<string, { watcher: fs.FSWatcher|null, debounceTimer: NodeJS.Timeout|null }>} */
    this.fileWatchers = new Map();

    /** Callback invoked when a file is opened (for recent files tracking) */
    this.onRecentFile = null;

    /** Named window map: windowName → windowId (FR-19-001) */
    this.nameToId = new Map();
  }

  /**
   * Set the electron-store instance for reading default window size settings.
   * @param {import('electron-store')} store
   */
  setStore(store) {
    this.store = store;
  }

  // -----------------------------------------------------------------------
  // File Watcher — auto-refresh on disk changes
  // -----------------------------------------------------------------------

  /**
   * Start watching the file associated with a window for changes.
   * @param {string} windowId
   */
  startFileWatcher(windowId) {
    const entry = this.windows.get(windowId);
    if (!entry) return;

    const filePath = entry.meta.filePath;
    if (!filePath) return; // content-only mode

    // Check autoRefresh setting
    if (this.store && !this.store.get('autoRefresh', true)) return;

    // Stop existing watcher first
    this.stopFileWatcher(windowId);

    try {
      const watcher = fs.watch(filePath, { persistent: false }, (eventType, filename) => {
        // macOS may pass filename=null, use original filePath as fallback
        const changedFile = filename || path.basename(filePath);

        // Debounce 300ms
        const existing = this.fileWatchers.get(windowId);
        if (existing && existing.debounceTimer) {
          clearTimeout(existing.debounceTimer);
        }

        const timer = setTimeout(async () => {
          try {
            // For rename events (atomic save), check if file still exists
            if (eventType === 'rename' && !fs.existsSync(filePath)) {
              console.log(`[doculight] file-deleted: ${filePath}`);
              this.stopFileWatcher(windowId);
              return;
            }

            console.log(`[doculight] file-changed: ${filePath}`);
            const markdown = await fs.promises.readFile(filePath, 'utf-8');

            const currentEntry = this.windows.get(windowId);
            if (!currentEntry || currentEntry.win.isDestroyed()) return;

            const imageBasePath = currentEntry.meta.tree
              ? path.dirname(currentEntry.meta.tree.path).replace(/\\/g, '/')
              : path.dirname(filePath).replace(/\\/g, '/');

            currentEntry.win.webContents.send('render-markdown', {
              markdown,
              filePath: filePath.replace(/\\/g, '/'),
              windowId,
              imageBasePath,
              platform: process.platform
            });
          } catch (err) {
            console.error(`[doculight] file-watch read error: ${err.message}`);
          }
        }, 300);

        const watcherEntry = this.fileWatchers.get(windowId);
        if (watcherEntry) {
          watcherEntry.debounceTimer = timer;
        }
      });

      watcher.on('error', (err) => {
        console.error(`[doculight] file-watch error: ${err.message}`);
        this.stopFileWatcher(windowId);
      });

      this.fileWatchers.set(windowId, { watcher, debounceTimer: null });
    } catch (err) {
      console.error(`[doculight] file-watch start error: ${err.message}`);
      this.fileWatchers.set(windowId, { watcher: null, debounceTimer: null });
    }
  }

  /**
   * Stop watching the file associated with a window.
   * @param {string} windowId
   */
  stopFileWatcher(windowId) {
    const entry = this.fileWatchers.get(windowId);
    if (!entry) return;

    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
    }
    if (entry.watcher) {
      try { entry.watcher.close(); } catch { /* ignore */ }
    }
    this.fileWatchers.delete(windowId);
  }

  /**
   * Stop all file watchers (called on quit or when autoRefresh is disabled).
   */
  stopAllFileWatchers() {
    for (const windowId of this.fileWatchers.keys()) {
      this.stopFileWatcher(windowId);
    }
  }

  // -----------------------------------------------------------------------
  // getWindowByName (FR-19-001)
  // -----------------------------------------------------------------------

  /**
   * Find a window entry by its windowName.
   * Returns null if not found or window has been destroyed.
   *
   * @param {string} windowName
   * @returns {{ win: BrowserWindow, meta: object }|null}
   */
  getWindowByName(windowName) {
    const id = this.nameToId.get(windowName);
    if (id === undefined) return null;
    const entry = this.windows.get(id);
    if (!entry || entry.win.isDestroyed()) {
      this.nameToId.delete(windowName);
      return null;
    }
    return entry;
  }

  // -----------------------------------------------------------------------
  // createWindow
  // -----------------------------------------------------------------------

  /**
   * Create a new viewer window.
   *
   * @param {object}  opts
   * @param {string}  [opts.content]          - Raw markdown string to render.
   * @param {string}  [opts.filePath]         - Path to a .md file on disk.
   * @param {boolean} [opts.foreground]       - If false the window will not steal focus (default true).
   * @param {string}  [opts.title]            - Explicit window title override.
   * @param {string}  [opts.size]             - One of 's', 'm', 'l', 'f' (default 'm').
   * @param {string}  [opts.windowName]       - Named window key for upsert (FR-19-001).
   * @param {string}  [opts.severity]         - Severity theme: 'info'|'success'|'warning'|'error' (FR-19-003).
   * @param {string[]}[opts.tags]             - Window tags for grouping (FR-19-005).
   * @param {boolean} [opts.flash]            - Flash taskbar button (FR-19-006).
   * @param {number}  [opts.progress]         - Progress bar value 0.0–1.0 (FR-19-007).
   * @param {number}  [opts.autoCloseSeconds] - Auto-close after N seconds (FR-19-004).
   * @returns {Promise<{ windowId: string, title: string, windowName?: string, upserted?: boolean }>}
   */
  async createWindow(opts = {}) {
    const { foreground, title: explicitTitle, size, windowName,
            severity, tags, flash, progress, autoCloseSeconds,
            project, docName, description } = opts;
    let { content, filePath } = opts;

    // --- Named window upsert (FR-19-001) -----------------------------------
    if (windowName) {
      const existing = this.getWindowByName(windowName);
      if (existing) {
        // Update the existing window and return its id
        const updateResult = await this.updateWindow(existing.meta.windowId, opts);
        return { windowId: existing.meta.windowId, title: updateResult.title, upserted: true, windowName };
      }
    }

    // --- Validate inputs ---------------------------------------------------
    if (!content && !filePath) {
      throw new Error(t('error.contentRequired'));
    }

    // If filePath is supplied, read from disk
    if (filePath) {
      if (path.extname(filePath).toLowerCase() !== '.md') {
        throw new Error(t('error.mdOnly', { filePath }));
      }
      content = await fs.promises.readFile(filePath, 'utf-8');

      // Inject frontmatter if metadata params provided (filePath mode)
      if (project || docName || description) {
        content = injectFrontmatter(content, { project, docName, description });
      }
    }

    // Enforce window cap
    if (this.windows.size >= MAX_WINDOWS) {
      throw new Error(t('error.maxWindows', { max: MAX_WINDOWS }));
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
    const displayTitle = this.formatWindowTitle(resolvedTitle, filePath, null);

    // --- Create BrowserWindow ----------------------------------------------
    const win = new BrowserWindow({
      width,
      height,
      x,
      y,
      title: displayTitle,
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
        tree: null,
        history,
        // Step 19 new fields
        savedFilePath: null,
        windowName: windowName || null,
        tags: Array.isArray(tags) ? [...tags] : [],
        severity: severity || null,
        autoCloseTimer: undefined,
        progress: (progress !== undefined && progress !== null) ? progress : undefined,
        lastRenderedContent: filePath ? undefined : (content || '')
      }
    });

    // Register named window
    if (windowName) {
      this.nameToId.set(windowName, windowId);
    }

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
      const entry = this.windows.get(windowId);
      if (entry) {
        if (entry.meta.windowName) {
          this.nameToId.delete(entry.meta.windowName);
        }
        if (entry.meta.autoCloseTimer) {
          clearTimeout(entry.meta.autoCloseTimer);
          entry.meta.autoCloseTimer = undefined;
        }
      }
      this.stopFileWatcher(windowId);
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

    // Track in recent files
    if (filePath && typeof this.onRecentFile === 'function') {
      this.onRecentFile(filePath);
    }

    // --- Return promise that resolves on window-ready IPC ------------------
    return new Promise((resolve) => {
      this.pendingReady.set(windowId, {
        resolve,
        content,
        filePath: filePath || null,
        title: resolvedTitle,
        // Step 19 pending fields
        severity: severity || null,
        flash: flash || false,
        progress: (progress !== undefined && progress !== null) ? progress : undefined,
        autoCloseSeconds: autoCloseSeconds || null
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

    const { resolve, content, filePath, title,
            severity, flash, progress, autoCloseSeconds } = pending;

    if (content != null) {
      // Normal window: send initial content to the renderer
      const imageBasePath = filePath
        ? (entry.meta.tree
          ? path.dirname(entry.meta.tree.path).replace(/\\/g, '/')
          : path.dirname(filePath).replace(/\\/g, '/'))
        : null;
      entry.win.webContents.send('render-markdown', {
        markdown: content,
        filePath: filePath ? filePath.replace(/\\/g, '/') : null,
        windowId: windowId,
        imageBasePath,
        platform: process.platform
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

      // Severity theme (FR-19-003)
      if (severity) {
        entry.win.webContents.send('set-severity', { severity });
      }

      // Auto-close timer (FR-19-004)
      if (autoCloseSeconds) {
        const seconds = Math.floor(autoCloseSeconds);
        entry.meta.autoCloseTimer = setTimeout(() => {
          const e = this.windows.get(windowId);
          if (e && !e.win.isDestroyed()) {
            this.closeWindow(windowId);
          }
        }, seconds * 1000);
        entry.meta.autoCloseSeconds = seconds;
        entry.win.webContents.send('auto-close-start', { seconds });
      }

      // Taskbar flash (FR-19-006)
      if (flash && !entry.win.isFocused()) {
        entry.win.flashFrame(true);
      }

      // Progress bar (FR-19-007)
      if (progress !== undefined && progress !== null) {
        entry.win.setProgressBar(progress);
      }
    } else {
      // Empty window: notify renderer to show drop zone
      entry.win.webContents.send('empty-window', { windowId });
    }

    // Clean up pending state
    this.pendingReady.delete(windowId);

    // Start file watcher if filePath exists
    if (pending.filePath) {
      this.startFileWatcher(windowId);
    }

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
   * @param {string} [windowId]  - Specific window to close. Omit to close all (or use tag).
   * @param {object} [opts]      - Options for tag-based close (FR-19-005).
   * @param {string} [opts.tag]  - Close all windows with this tag.
   * @returns {{ closed: number }}
   */
  closeWindow(windowId, opts = {}) {
    // Tag-based bulk close (FR-19-005)
    if (!windowId && opts.tag) {
      const tag = opts.tag;
      const toClose = [];
      for (const [id, entry] of this.windows) {
        if (entry.meta.tags && entry.meta.tags.includes(tag)) {
          toClose.push(id);
        }
      }
      let count = 0;
      for (const id of toClose) {
        const entry = this.windows.get(id);
        if (entry && !entry.win.isDestroyed()) {
          this.stopFileWatcher(id);
          entry.win.close();
          count++;
        }
      }
      return { closed: count };
    }

    // Close all windows
    if (!windowId) {
      this.stopAllFileWatchers();
      const count = this.windows.size;
      for (const [, entry] of this.windows) {
        entry.win.close();
      }
      return { closed: count };
    }

    // Close specific window
    const entry = this.windows.get(windowId);
    if (!entry) {
      throw new Error(t('error.windowNotFound', { windowId }));
    }
    this.stopFileWatcher(windowId);
    entry.win.close();
    return { closed: 1 };
  }

  // -----------------------------------------------------------------------
  // updateWindow
  // -----------------------------------------------------------------------

  /**
   * Update the content and/or metadata of an existing window.
   *
   * @param {string} windowId
   * @param {object} opts
   * @param {string}  [opts.content]          - New markdown content.
   * @param {string}  [opts.filePath]         - Path to .md file (overrides content).
   * @param {string}  [opts.title]            - New window title.
   * @param {boolean} [opts.appendMode]       - Append content to existing (FR-19-002).
   * @param {string}  [opts.separator]        - Separator for appendMode (default: '\n\n').
   * @param {string}  [opts.severity]         - Severity theme update (FR-19-003).
   * @param {boolean} [opts.flash]            - Flash taskbar button (FR-19-006).
   * @param {number}  [opts.progress]         - Progress bar value 0.0–1.0 (FR-19-007).
   * @param {string[]}[opts.tags]             - Replace window tags (FR-19-005).
   * @param {number}  [opts.autoCloseSeconds] - Reset/set auto-close timer (FR-19-004).
   * @returns {Promise<{ title: string }>}
   */
  async updateWindow(windowId, opts = {}) {
    const entry = this.windows.get(windowId);
    if (!entry) {
      throw new Error(t('error.windowNotFound', { windowId }));
    }

    let { content, filePath, title, appendMode, separator,
          severity, flash, progress, tags, autoCloseSeconds,
          project, docName, description } = opts;

    // --- Append mode (FR-19-002) -------------------------------------------
    if (appendMode) {
      if (entry.meta.filePath) {
        throw new Error('appendMode is not supported for file-based windows.');
      }
      if (content == null) {
        throw new Error('content is required for appendMode.');
      }
      const sep = (separator !== undefined) ? separator : '\n\n';
      const existing = entry.meta.lastRenderedContent || '';
      const newContent = existing ? existing + sep + content : content;
      if (Buffer.byteLength(newContent, 'utf8') > 10 * 1024 * 1024) {
        throw new Error('Accumulated content exceeds 10MB limit.');
      }
      content = newContent;
      appendMode = false;
    }

    // --- Read from disk if filePath provided -------------------------------
    if (filePath) {
      if (path.extname(filePath).toLowerCase() !== '.md') {
        throw new Error(t('error.mdOnly', { filePath }));
      }
      content = await fs.promises.readFile(filePath, 'utf-8');
      // Inject frontmatter metadata for filePath mode (Step 20)
      if (project || docName || description) {
        content = injectFrontmatter(content, { project, docName, description });
      }
    }

    // --- Content update ----------------------------------------------------
    if (content != null) {
      const resolvedTitle =
        title ||
        this.extractTitle(content) ||
        (filePath ? path.basename(filePath, '.md') : null) ||
        entry.meta.title;

      entry.win.webContents.send('update-markdown', {
        markdown: content,
        filePath: filePath || entry.meta.filePath,
        windowId
      });

      entry.meta.title = resolvedTitle;
      if (filePath) {
        entry.meta.filePath = filePath;
        entry.meta.lastRenderedContent = undefined; // becomes file-based
        this.startFileWatcher(windowId);
      } else {
        // Update lastRenderedContent for content-based windows
        if (!entry.meta.filePath) {
          entry.meta.lastRenderedContent = content;
        }
      }
      entry.win.setTitle(this.formatWindowTitle(resolvedTitle, entry.meta.filePath, entry.meta.savedFilePath));
    } else if (title) {
      // Title-only update
      entry.meta.title = title;
      entry.win.setTitle(this.formatWindowTitle(title, entry.meta.filePath, entry.meta.savedFilePath));
    }

    // --- Severity theme (FR-19-003) ----------------------------------------
    if (severity !== undefined) {
      entry.meta.severity = severity || null;
      entry.win.webContents.send('set-severity', { severity: entry.meta.severity });
    }

    // --- Taskbar flash (FR-19-006) -----------------------------------------
    if (flash && !entry.win.isFocused()) {
      entry.win.flashFrame(true);
    }

    // --- Progress bar (FR-19-007) ------------------------------------------
    if (progress !== undefined && progress !== null) {
      entry.meta.progress = progress;
      entry.win.setProgressBar(progress);
    }

    // --- Tags (FR-19-005) --------------------------------------------------
    if (Array.isArray(tags)) {
      entry.meta.tags = [...tags];
    }

    // --- Auto-close timer (FR-19-004) -------------------------------------
    if (autoCloseSeconds !== undefined && autoCloseSeconds !== null) {
      if (entry.meta.autoCloseTimer) {
        clearTimeout(entry.meta.autoCloseTimer);
        entry.meta.autoCloseTimer = undefined;
      }
      const seconds = Math.floor(autoCloseSeconds);
      entry.meta.autoCloseTimer = setTimeout(() => {
        const e = this.windows.get(windowId);
        if (e && !e.win.isDestroyed()) {
          this.closeWindow(windowId);
        }
      }, seconds * 1000);
      entry.meta.autoCloseSeconds = seconds;
      entry.win.webContents.send('auto-close-start', { seconds });
    }

    return { title: entry.meta.title };
  }

  // -----------------------------------------------------------------------
  // listWindows
  // -----------------------------------------------------------------------

  /**
   * List all open windows with their metadata.
   *
   * @param {object} [opts]
   * @param {string} [opts.tag] - Filter by tag (FR-19-005).
   * @returns {Array<{ windowId: string, title: string, alwaysOnTop: boolean, windowName?: string, tags?: string[], severity?: string, progress?: number }>}
   */
  listWindows(opts = {}) {
    const result = [];
    for (const [windowId, entry] of this.windows) {
      // Tag filter (FR-19-005)
      if (opts.tag) {
        if (!entry.meta.tags || !entry.meta.tags.includes(opts.tag)) {
          continue;
        }
      }
      const item = {
        windowId,
        title: entry.meta.title,
        alwaysOnTop: entry.meta.alwaysOnTop
      };
      if (entry.meta.windowName) item.windowName = entry.meta.windowName;
      if (entry.meta.tags && entry.meta.tags.length > 0) item.tags = [...entry.meta.tags];
      if (entry.meta.severity) item.severity = entry.meta.severity;
      if (entry.meta.progress !== undefined && entry.meta.progress !== null) item.progress = entry.meta.progress;
      result.push(item);
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
      throw new Error(t('error.windowNotFound', { windowId }));
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
    const imageBasePath = entry.meta.tree
      ? path.dirname(entry.meta.tree.path).replace(/\\/g, '/')
      : path.dirname(filePath).replace(/\\/g, '/');
    entry.win.webContents.send('render-markdown', {
      markdown: content,
      filePath: filePath.replace(/\\/g, '/'),
      windowId,
      imageBasePath,
      platform: process.platform
    });

    // Highlight current file in sidebar (Root-Preserving: tree structure doesn't change)
    entry.win.webContents.send('sidebar-highlight', {
      currentPath: filePath
    });

    // Update metadata
    entry.meta.filePath = filePath;

    // Track in recent files
    if (typeof this.onRecentFile === 'function') {
      this.onRecentFile(filePath);
    }

    // Restart file watcher for new file
    this.startFileWatcher(windowId);

    // Update window title
    const navTitle = this.extractTitle(content) || path.basename(filePath, '.md');
    entry.meta.title = navTitle;
    entry.win.setTitle(this.formatWindowTitle(navTitle, filePath, entry.meta.savedFilePath));
  }

  /**
   * Navigate back in the window's history.
   *
   * @param {string} windowId
   */
  async navigateBack(windowId) {
    const entry = this.windows.get(windowId);
    if (!entry) {
      throw new Error(t('error.windowNotFound', { windowId }));
    }

    const filePath = entry.meta.history.back();
    if (!filePath) return; // no more history

    const content = await fs.promises.readFile(filePath, 'utf-8');

    const imageBasePath = entry.meta.tree
      ? path.dirname(entry.meta.tree.path).replace(/\\/g, '/')
      : path.dirname(filePath).replace(/\\/g, '/');
    entry.win.webContents.send('render-markdown', {
      markdown: content,
      filePath: filePath.replace(/\\/g, '/'),
      windowId,
      imageBasePath,
      platform: process.platform
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
      throw new Error(t('error.windowNotFound', { windowId }));
    }

    const filePath = entry.meta.history.forward();
    if (!filePath) return; // no more forward history

    const content = await fs.promises.readFile(filePath, 'utf-8');

    const imageBasePath = entry.meta.tree
      ? path.dirname(entry.meta.tree.path).replace(/\\/g, '/')
      : path.dirname(filePath).replace(/\\/g, '/');
    entry.win.webContents.send('render-markdown', {
      markdown: content,
      filePath: filePath.replace(/\\/g, '/'),
      windowId,
      imageBasePath,
      platform: process.platform
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
      throw new Error(t('error.maxWindows', { max: MAX_WINDOWS }));
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
      this.stopFileWatcher(windowId);
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
   * Format the window title with file path information.
   *
   * @param {string|null} title - Base title text.
   * @param {string|null} filePath - Path to file on disk.
   * @param {string|null} savedFilePath - Auto-saved file path.
   * @returns {string}
   */
  formatWindowTitle(title, filePath, savedFilePath) {
    if (!title) return 'DocuLight';
    if (filePath) return `DocuLight - ${path.basename(filePath)} (${path.dirname(filePath)})`;
    if (savedFilePath) return `DocuLight - ${title} (${savedFilePath})`;
    return `DocuLight - ${title}`;
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
