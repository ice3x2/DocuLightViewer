// src/main/preload.js — contextBridge API for DocuLight viewers
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('doclight', {
  // === Listeners (Main → Renderer) ===

  // Called when main signals this is an empty window (show drop zone)
  onEmptyWindow: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('empty-window', handler);
    return () => ipcRenderer.removeListener('empty-window', handler);
  },

  // Called when main sends markdown content to render
  onRenderMarkdown: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('render-markdown', handler);
    return () => ipcRenderer.removeListener('render-markdown', handler);
  },

  // Called when main sends updated markdown content
  onUpdateMarkdown: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('update-markdown', handler);
    return () => ipcRenderer.removeListener('update-markdown', handler);
  },

  // Called when main sends sidebar tree data (유지: 호환 경로 및 캐시 히트 fallback)
  onSidebarTree: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('sidebar-tree', handler);
    return () => ipcRenderer.removeListener('sidebar-tree', handler);
  },

  // step28 Phase 2: 사이드바 배치 스트리밍 이벤트 (start/batch/done/error)
  onSidebarTreeStart: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('sidebar-tree-start', handler);
    return () => ipcRenderer.removeListener('sidebar-tree-start', handler);
  },
  onSidebarTreeBatch: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('sidebar-tree-batch', handler);
    return () => ipcRenderer.removeListener('sidebar-tree-batch', handler);
  },
  onSidebarTreeDone: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('sidebar-tree-done', handler);
    return () => ipcRenderer.removeListener('sidebar-tree-done', handler);
  },
  onSidebarTreeError: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('sidebar-tree-error', handler);
    return () => ipcRenderer.removeListener('sidebar-tree-error', handler);
  },
  cancelSidebarTreeLoad: (loadId) => ipcRenderer.invoke('cancel-sidebar-tree-load', { loadId }),

  // Called when sidebar highlight should change (navigation within same tree)
  onSidebarHighlight: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('sidebar-highlight', handler);
    return () => ipcRenderer.removeListener('sidebar-highlight', handler);
  },

  // Called when theme or settings change
  onThemeChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('theme-changed', handler);
    return () => ipcRenderer.removeListener('theme-changed', handler);
  },

  onSettingsChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('settings-changed', handler);
    return () => ipcRenderer.removeListener('settings-changed', handler);
  },

  // === Senders (Renderer → Main) ===

  navigateTo: (filePath) => ipcRenderer.send('navigate-to', filePath),
  navigateBack: () => ipcRenderer.send('navigate-back'),
  navigateForward: () => ipcRenderer.send('navigate-forward'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  notifyReady: () => ipcRenderer.send('window-ready'),

  // Zoom controls (Phase 6)
  zoomIn: () => ipcRenderer.send('zoom-in'),
  zoomOut: () => ipcRenderer.send('zoom-out'),
  zoomReset: () => ipcRenderer.send('zoom-reset'),
  releaseAlwaysOnTop: () => ipcRenderer.send('release-always-on-top'),
  toggleAlwaysOnTop: () => ipcRenderer.send('toggle-always-on-top'),
  setAlwaysOnTop: (value) => ipcRenderer.send('set-always-on-top', value),
  onAlwaysOnTopChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('always-on-top-changed', handler);
    return () => ipcRenderer.removeListener('always-on-top-changed', handler);
  },

  // Called when main wants to control panel visibility
  onPanelVisibility: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('panel-visibility', handler);
    return () => ipcRenderer.removeListener('panel-visibility', handler);
  },

  // Called when main sets severity theme (FR-19-003)
  onSetSeverity: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('set-severity', handler);
    return () => ipcRenderer.removeListener('set-severity', handler);
  },

  // Called when main starts auto-close countdown (FR-19-004)
  onAutoCloseStart: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('auto-close-start', handler);
    return () => ipcRenderer.removeListener('auto-close-start', handler);
  },

  // Drag & drop: notify main process that a file was dropped
  fileDropped: (filePath) => ipcRenderer.send('file-dropped', filePath),

  // Notify main that a file was opened in a new tab (for watcher + recent tracking)
  fileOpenedInTab: (filePath) => ipcRenderer.send('file-opened-in-tab', filePath),

  // Resolve real file path from a dropped File object (sandbox-safe)
  getFilePath: (file) => webUtils.getPathForFile(file),

  // Port availability check
  checkPortAvailable: (port) => ipcRenderer.invoke('check-port-available', port),

  // Settings (Phase 6)
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  getIndexingStatus: () => ipcRenderer.invoke('indexing:get-status'),
  startIndexingRebuild: () => ipcRenderer.invoke('indexing:start-rebuild'),
  cancelIndexingJob: () => ipcRenderer.invoke('indexing:cancel-job'),
  retryIndexingFailures: () => ipcRenderer.invoke('indexing:retry-failures'),
  compactSearchIndex: () => ipcRenderer.invoke('indexing:compact'),
  clearSearchIndex: () => ipcRenderer.invoke('indexing:clear'),
  openIndexDataDir: () => ipcRenderer.invoke('indexing:open-data-dir'),
  importLinkedMarkdown: () => ipcRenderer.invoke('document-import:linked-markdown'),
  getEmbeddingModelStatus: () => ipcRenderer.invoke('embedding:get-status'),
  validateEmbeddingModel: (settings) => ipcRenderer.invoke('embedding:validate-model', settings),
  saveEmbeddingModelSettings: (settings) => ipcRenderer.invoke('embedding:save-model-settings', settings),
  clearEmbeddingModelSettings: () => ipcRenderer.invoke('embedding:clear-model-settings'),

  // i18n
  getStrings: () => ipcRenderer.invoke('get-strings'),

  // File association
  registerFileAssociation: () => ipcRenderer.invoke('register-file-association'),
  unregisterFileAssociation: () => ipcRenderer.invoke('unregister-file-association'),
  getFileAssociationStatus: () => ipcRenderer.invoke('get-file-association-status'),
  openDefaultAppsSettings: () => ipcRenderer.send('open-default-apps-settings'),
  showFileInExplorer: (filePath) => ipcRenderer.send('show-in-explorer', filePath),
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),

  // PDF Export
  exportPdf: (opts) => ipcRenderer.invoke('export-pdf', opts),
  cancelExport: () => ipcRenderer.send('cancel-export'),
  pdfRenderComplete: () => ipcRenderer.send('pdf-render-complete'),
  onExportProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('export-progress', handler);
    return () => ipcRenderer.removeListener('export-progress', handler);
  },

  // Tab management
  readFileForTab: (filePath) => ipcRenderer.invoke('read-file-for-tab', filePath),
  checkFileMtime: (filePath) => ipcRenderer.invoke('check-file-mtime', filePath),
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  searchContent: (query, rootDir) => ipcRenderer.invoke('search-sidebar-content', query, rootDir),

  // Read a local image file as a base64 data URL (bypasses file:// sandbox restriction)
  readImageAsDataUrl: (filePath) => ipcRenderer.invoke('read-image-as-data-url', filePath),

  // Save As / Quick Save / Delete auto-saved file (FR-21)
  saveAs: (params) => ipcRenderer.invoke('save-as', params),
  quickSave: (params) => ipcRenderer.invoke('quick-save', params),
  deleteAutoSavedFile: () => ipcRenderer.invoke('delete-auto-saved-file'),
  onSetSavedFilePath: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('set-saved-file-path', handler);
    return () => ipcRenderer.removeListener('set-saved-file-path', handler);
  },

  // MCP Manual Save / Paste (FR-22)
  mcpManualSave: (params) => ipcRenderer.invoke('mcp-manual-save', params),
  renderPastedContent: (content) => ipcRenderer.invoke('render-pasted-content', content),
  onSetMcpState: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('set-mcp-state', handler);
    return () => ipcRenderer.removeListener('set-mcp-state', handler);
  },
});
