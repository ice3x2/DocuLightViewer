// src/main/window-manager.js — Window lifecycle & navigation management for DocuLight
'use strict';

const { BrowserWindow, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { buildSidebarTree } = require('./link-parser');
const { t } = require('./strings');
const { injectFrontmatter } = require('./frontmatter');

// step28 Phase 4: 사이드바 트리 TTL 캐시 설정
const SIDEBAR_CACHE_TTL_MS = 5 * 60 * 1000;  // 5분
const SIDEBAR_CACHE_MAX_SIZE = 32;            // LRU 상한

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

    /**
     * step28 Phase 2: 창별 진행 중인 사이드바 트리 로드 상태.
     * windowId → { loadId, controller }. 폴더 전환 시 이전 로드 abort용.
     * @type {Map<string, { loadId: number, controller: AbortController }>}
     */
    this._currentLoadIds = new Map();

    /** step28 Phase 2: 전역 트리 로드 ID 카운터 */
    this._treeLoadCounter = 0;

    /**
     * step28 Phase 4: 루트 디렉토리별 트리 TTL 캐시.
     * rootPath → { tree, timestamp }
     * @type {Map<string, { tree: object, timestamp: number }>}
     */
    this.sidebarTreeCache = new Map();

    /** @type {import('electron-store')|null} */
    this.store = null;

    /** @type {Map<string, { watcher: fs.FSWatcher|null, debounceTimer: NodeJS.Timeout|null }>} */
    this.fileWatchers = new Map();

    /** Callback invoked when a file is opened (for recent files tracking) */
    this.onRecentFile = null;

    /** Named window map: windowName → windowId (FR-19-001) */
    this.nameToId = new Map();

    /** Pending named window creations to prevent race conditions (FR-4-001) */
    this._pendingNames = new Set();
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

            const imageBasePath = path.dirname(filePath).replace(/\\/g, '/');

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
            project, docName, description, docType,
            projectPath, gitRemote, gitBranch, gitLastCommit } = opts;
    let { content, filePath } = opts;

    // --- Named window upsert (FR-19-001 + FR-4-001 race guard) -------------
    if (windowName) {
      const existing = this.getWindowByName(windowName);
      if (existing) {
        const updateResult = await this.updateWindow(existing.meta.windowId, opts);
        return { windowId: existing.meta.windowId, title: updateResult.title, upserted: true, windowName };
      }

      // Wait if another concurrent call is creating the same named window
      if (this._pendingNames.has(windowName)) {
        const PENDING_TIMEOUT = 5000;
        const start = Date.now();
        await new Promise((resolve, reject) => {
          const check = () => {
            if (!this._pendingNames.has(windowName)) return resolve();
            if (Date.now() - start > PENDING_TIMEOUT) {
              return reject(new Error(`Timed out waiting for windowName "${windowName}"`));
            }
            setTimeout(check, 50);
          };
          setTimeout(check, 50);
        });
        // Retry: the window should now exist
        return this.createWindow(opts);
      }

      // Acquire name lock
      this._pendingNames.add(windowName);
    }

    try {
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
      if (project || docName || description || docType || projectPath) {
        content = injectFrontmatter(content, {
          project, docName, description, docType,
          projectPath, gitRemote, gitBranch, gitLastCommit
        });
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
      icon: process.platform === 'win32'
        ? path.join(__dirname, '../../assets/icon.ico')
        : path.join(__dirname, '../../assets/icon.png'),
      show: false, // shown after ready-to-show
      paintWhenInitiallyHidden: true,
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
        lastRenderedContent: filePath ? undefined : (content || ''),
        docType: docType || null
      }
    });

    // Register named window and release pending lock
    if (windowName) {
      this.nameToId.set(windowName, windowId);
      this._pendingNames.delete(windowName);
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

    // Re-assert alwaysOnTop z-order when window gains focus (FR-5)
    win.on('focus', () => {
      const entry = this.windows.get(windowId);
      if (entry && entry.meta.alwaysOnTop && !win.isDestroyed()) {
        win.setAlwaysOnTop(true);
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
      // step28 Phase 2: 창 종료 시 진행 중인 사이드바 트리 로드 abort
      const live = this._currentLoadIds.get(windowId);
      if (live) {
        try { live.controller.abort(); } catch { /* ignore */ }
        this._currentLoadIds.delete(windowId);
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
    } catch (err) {
      // Release pending name lock on error (FR-4-001)
      if (windowName) this._pendingNames.delete(windowName);
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // _startSidebarTreeLoad — 사이드바 트리 로드 단일 진입점 (step28 Phase 2)
  // -----------------------------------------------------------------------

  /**
   * 사이드바 트리를 비동기로 로드하며 IPC 배치 이벤트를 렌더러로 스트리밍한다.
   * 이전 로드가 진행 중이면 abort 후 새 loadId 발급.
   * fire-and-forget 패턴: 호출자는 await하지 않아도 됨.
   *
   * IPC 이벤트 흐름:
   *   start → batch × N → done (+ 기존 sidebar-tree 호환 이벤트)
   *   또는 start → (batch × N) → error { reason: 'aborted' | 'error' }
   *
   * @param {string} windowId
   * @param {string} filePath - 열린 파일 절대 경로
   */
  _startSidebarTreeLoad(windowId, filePath) {
    const entry = this.windows.get(windowId);
    if (!entry || entry.win.isDestroyed()) return;
    if (!filePath) return;

    // 이전 로드 즉시 취소 (폴더 전환 시 경합 방지)
    const prev = this._currentLoadIds.get(windowId);
    if (prev) {
      try { prev.controller.abort(); } catch { /* ignore */ }
    }

    const loadId = ++this._treeLoadCounter;
    const controller = new AbortController();
    this._currentLoadIds.set(windowId, { loadId, controller });

    const rootPath = path.resolve(path.dirname(filePath));

    // step28 Phase 4: TTL 캐시 조회 (히트 시 스피너 없이 즉시 done)
    const cached = this.sidebarTreeCache.get(rootPath);
    const now = Date.now();
    if (cached && (now - cached.timestamp) < SIDEBAR_CACHE_TTL_MS) {
      try {
        if (!entry.win.isDestroyed()) {
          entry.win.webContents.send('sidebar-tree-start', { loadId, rootPath, fromCache: true });
          entry.meta.tree = cached.tree;
          entry.win.webContents.send('sidebar-tree-done', { loadId, tree: cached.tree });
          entry.win.webContents.send('sidebar-tree', { tree: cached.tree });  // 호환
          entry.win.webContents.send('sidebar-highlight', { currentPath: filePath });
        }
      } catch { /* ignore */ }
      this._currentLoadIds.delete(windowId);
      return;
    }

    // start 이벤트 (정상 스캔 경로)
    if (!entry.win.isDestroyed()) {
      try { entry.win.webContents.send('sidebar-tree-start', { loadId, rootPath, fromCache: false }); }
      catch { /* isDestroyed 레이스 무시 */ }
    }

    const onBatch = (nodes) => {
      // loadId 경합 가드: 폴더 전환 후 잔여 이벤트 차단
      const cur = this._currentLoadIds.get(windowId);
      if (!cur || cur.loadId !== loadId) return;
      if (entry.win.isDestroyed()) return;
      try { entry.win.webContents.send('sidebar-tree-batch', { loadId, nodes }); }
      catch { /* ignore */ }
    };

    const { buildSidebarTree } = require('./link-parser');

    (async () => {
      try {
        const tree = await buildSidebarTree(filePath, { onBatch, signal: controller.signal });
        // done 전송 직전 loadId 재확인 (레이스 방지)
        const cur = this._currentLoadIds.get(windowId);
        if (!cur || cur.loadId !== loadId) return;
        if (entry.win.isDestroyed()) return;

        entry.meta.tree = tree;
        entry.win.webContents.send('sidebar-tree-done', { loadId, tree });
        // 기존 sidebar-tree 이벤트 호환 유지 (renderer의 기존 수신 경로 보호)
        entry.win.webContents.send('sidebar-tree', { tree });
        entry.win.webContents.send('sidebar-highlight', { currentPath: filePath });

        // step28 Phase 4: 캐시 저장 (LRU 상한 방어)
        this.sidebarTreeCache.set(rootPath, { tree, timestamp: Date.now() });
        if (this.sidebarTreeCache.size > SIDEBAR_CACHE_MAX_SIZE) {
          // 가장 오래된 엔트리 제거
          let oldestKey = null;
          let oldestTs = Infinity;
          for (const [key, val] of this.sidebarTreeCache) {
            if (val.timestamp < oldestTs) { oldestTs = val.timestamp; oldestKey = key; }
          }
          if (oldestKey !== null) this.sidebarTreeCache.delete(oldestKey);
        }
      } catch (err) {
        if (entry.win.isDestroyed()) return;
        const reason = (err && err.name === 'AbortError') ? 'aborted' : 'error';
        try {
          entry.win.webContents.send('sidebar-tree-error', {
            loadId, reason, message: err && err.message
          });
          if (reason === 'error') {
            // IMPL-036 호환: 예외(비-abort) 시 빈 사이드바도 전송
            entry.win.webContents.send('sidebar-tree', { tree: null });
          }
        } catch { /* ignore */ }
      } finally {
        // 현재 loadId인 경우에만 상태 정리 (새 로드가 이미 시작된 경우 삭제 금지)
        const cur = this._currentLoadIds.get(windowId);
        if (cur && cur.loadId === loadId) {
          this._currentLoadIds.delete(windowId);
        }
      }
    })();
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
  async onWindowReady(windowId) {
    const pending = this.pendingReady.get(windowId);
    const entry = this.windows.get(windowId);
    if (!entry) return;

    if (!pending) {
      // 새로고침: pendingReady가 이미 소비됨 → 캐시된 상태 재전송
      await this._resendWindowState(windowId, entry);
      return;
    }

    const { resolve, content, filePath, title,
            severity, flash, progress, autoCloseSeconds } = pending;

    if (content != null) {
      // Normal window: send initial content to the renderer
      const imageBasePath = filePath
        ? path.dirname(filePath).replace(/\\/g, '/')
        : null;
      entry.win.webContents.send('render-markdown', {
        markdown: content,
        filePath: filePath ? filePath.replace(/\\/g, '/') : null,
        windowId: windowId,
        imageBasePath,
        platform: process.platform
      });

      // Build sidebar tree for filePath-based windows (step28 Phase 2: 배치 스트리밍)
      if (filePath) {
        this._startSidebarTreeLoad(windowId, filePath);
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
  // _resendWindowState — re-send state on refresh (F5)
  // -----------------------------------------------------------------------

  /**
   * Re-send the window state after a page refresh (F5).
   * Uses cached meta to restore content, sidebar tree, and severity.
   *
   * @param {string} windowId
   * @param {{ win: BrowserWindow, meta: object }} entry
   */
  async _resendWindowState(windowId, entry) {
    const filePath = entry.meta.filePath;

    if (!filePath) {
      // Content-only 윈도우 (MCP 등)
      if (entry.meta.lastRenderedContent != null) {
        entry.win.webContents.send('render-markdown', {
          markdown: entry.meta.lastRenderedContent,
          filePath: null, windowId,
          imageBasePath: null, platform: process.platform
        });
      } else {
        entry.win.webContents.send('empty-window', { windowId });
      }
      return;
    }

    // 파일 기반 윈도우: 디스크에서 재읽기
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const imageBasePath = path.dirname(filePath).replace(/\\/g, '/');

      entry.win.webContents.send('render-markdown', {
        markdown: content,
        filePath: filePath.replace(/\\/g, '/'),
        windowId, imageBasePath, platform: process.platform
      });

      // ★ 핵심: rootFilePath 기준으로 트리 재빌드 (step28 Phase 2: 배치 스트리밍)
      const rootPath = entry.meta.rootFilePath || filePath;
      this._startSidebarTreeLoad(windowId, rootPath);

      // severity 복원
      if (entry.meta.severity) {
        entry.win.webContents.send('set-severity', { severity: entry.meta.severity });
      }

      // 파일 감시 재시작
      this.startFileWatcher(windowId);
    } catch (err) {
      console.error(`[doculight] Refresh error: ${err.message}`);
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

    let { content, filePath, title, appendMode, separator, foreground,
          severity, flash, progress, tags, autoCloseSeconds,
          project, docName, description, docType,
          projectPath, gitRemote, gitBranch, gitLastCommit } = opts;

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
      if (project || docName || description || docType || projectPath) {
        content = injectFrontmatter(content, {
          project, docName, description, docType,
          projectPath, gitRemote, gitBranch, gitLastCommit
        });
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

    // --- Document type (Step 23) ------------------------------------------
    if (docType !== undefined) {
      entry.meta.docType = docType || null;
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

    // --- Foreground (bring to front) ----------------------------------------
    if (foreground !== false && !entry.win.isDestroyed()) {
      if (entry.win.isMinimized()) entry.win.restore();
      entry.win.show();
      entry.win.focus();
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
    const imageBasePath = path.dirname(filePath).replace(/\\/g, '/');
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

    const imageBasePath = path.dirname(filePath).replace(/\\/g, '/');
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

    const imageBasePath = path.dirname(filePath).replace(/\\/g, '/');
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
      icon: process.platform === 'win32'
        ? path.join(__dirname, '../../assets/icon.ico')
        : path.join(__dirname, '../../assets/icon.png'),
      show: false,
      paintWhenInitiallyHidden: true,
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

    // Re-assert alwaysOnTop z-order when window gains focus (FR-5)
    win.on('focus', () => {
      const entry = this.windows.get(windowId);
      if (entry && entry.meta.alwaysOnTop && !win.isDestroyed()) {
        win.setAlwaysOnTop(true);
      }
    });

    win.on('closed', () => {
      // step28 Phase 2: 창 종료 시 진행 중인 사이드바 트리 로드 abort
      const live = this._currentLoadIds.get(windowId);
      if (live) {
        try { live.controller.abort(); } catch { /* ignore */ }
        this._currentLoadIds.delete(windowId);
      }
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
