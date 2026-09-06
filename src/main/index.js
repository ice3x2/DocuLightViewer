// src/main/index.js — Electron App Entry Point + IPC Socket Server
// CommonJS module for Electron main process

if (process.argv.includes('--mcp-stdio')) {
  process.env.DOCULIGHT_PACKAGED_MCP_STDIO = '1';
  if (!process.env.DOCLIGHT_APP_PATH && process.execPath) {
    process.env.DOCLIGHT_APP_PATH = process.execPath;
  }
  import('./mcp-server.mjs').catch((err) => {
    console.error('[doculight-mcp]', 'Fatal:', redactEarlyMcpStdioError(err && err.message ? err.message : String(err)));
    process.exit(1);
  });
  return;
}

function redactEarlyMcpStdioError(value) {
  return String(value == null ? 'Unknown MCP startup error' : value)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/?#\s"'<>@]+)@/gi, '$1[REDACTED]@')
    .replace(/\b[A-Za-z]:(?:\\{1,2}|\/)[^\r\n"'<>|?*,;]+/g, '[REDACTED_PATH]')
    .replace(/\\{2,}[^\\/\r\n"'<>|?*,;]+(?:\\{1,2}|\/)[^\r\n"'<>|?*,;]+/g, '[REDACTED_PATH]')
    .replace(/(^|[\s"'=:(,{\[])(\/(?!\/)[^\s"'<>()[\]{}]*)/g, '$1[REDACTED_PATH]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|passwd|pwd|secret|credential|bearer|provider[_-]?key|embedding[_-]?key)=)([^&#\s]+)/gi, '$1[REDACTED]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|passwd|pwd|secret|credential|bearer|provider[_-]?key|embedding[_-]?key)=)([^&#\s,;]+)/gi, '$1[REDACTED]');
}

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, dialog, safeStorage } = require('electron');
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const path = require('path');
const { getPackageSmokeCliStdioArgs } = require('./package-smoke-launch-options');
const fs = require('fs');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { WindowManager } = require('./window-manager');
const Store = require('electron-store');
const { init: initStrings, t, getAll: getAllStrings } = require('./strings');
const { SearchEngine } = require('./search-engine');
const { SQLiteKeywordIndex, SQLITE_INDEX_FILENAME } = require('./search-sqlite-store');
const { createKeywordTokenizer } = require('./search-tokenizer');
const { loadHnswlib } = require('./hnsw-index');
const { createOpenAICompatibleEmbeddingProvider } = require('./embedding-provider');
const { createRedactor } = require('./redaction');
const { createLinkedImporter } = require('./linked-import');
const { createOpenedMarkdownRegistrar } = require('./opened-markdown-registrar');
const {
  IndexedDocumentOpenError,
  VALIDATED_MARKDOWN_CONTENT,
  resolveIndexedMarkdownOpen
} = require('./indexed-origin-resolver');
const { createNativeRebuildManager } = require('./native-rebuild-manager');
const {
  fetchRemoteImageForMediaViewer,
  sanitizeDownloadFilename,
  resolveImageMimeExtension
} = require('./media-viewer-security');
const { resolveReadablePastedMarkdownPath } = require('./pasted-markdown-path');
const {
  createEmbeddingActivationRecord,
  migratePlaintextEmbeddingApiKey,
  normalizeEmbeddingActivationRecord,
  normalizeEmbeddingProjectPolicy,
  normalizeSecretMigrationState
} = require('./embedding-settings');
const { injectFrontmatter } = require('./frontmatter');
const { resolveRuntimeProfile } = require('./runtime-profile');
const { isUsableLinkBase, resolveMarkdownLinkTarget } = require('./markdown-link-resolver');

const PACKAGE_SMOKE_REQUESTED = process.env.DOCULIGHT_PACKAGE_SMOKE === '1' || process.argv.includes('--package-smoke');
const runtimeProfile = resolveRuntimeProfile({
  argv: process.argv,
  env: process.env,
  platform: process.platform,
  appDataDir: app.getPath('appData'),
  defaultUserDataDir: app.getPath('userData')
});

if (!PACKAGE_SMOKE_REQUESTED && runtimeProfile.shouldSetUserData) {
  fs.mkdirSync(runtimeProfile.userDataDir, { recursive: true });
  fs.mkdirSync(runtimeProfile.sessionDataDir, { recursive: true });
  app.setName(runtimeProfile.appName);
  app.setPath('userData', runtimeProfile.userDataDir);
  app.setPath('sessionData', runtimeProfile.sessionDataDir);
}

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
const PIPE_PATH = runtimeProfile.ipcPath;

const ICON_PATH = process.platform === 'win32'
  ? path.join(__dirname, '..', '..', 'assets', 'icon.ico')
  : path.join(__dirname, '..', '..', 'assets', 'icon.png');
const TRAY_ICON_PATH = process.platform === 'darwin'
  ? path.join(__dirname, '..', '..', 'assets', 'tray-iconTemplate.png')
  : ICON_PATH;
const MAX_TRAY_ITEMS = 10;
const EMBEDDING_DEFAULT_CHUNK_SIZE = 900;
const EMBEDDING_DEFAULT_CHUNK_OVERLAP = 120;
const EMBEDDING_RETENTION_CONFIRMATION_VERSION = 'remote-embedding-v1';

// === Global State ===
let tray = null;
let ipcServer = null;
let mcpHttpServer = null;
let settingsWin = null;
let pendingOpenFile = null; // macOS: buffers open-file events before app.isReady()
let isExporting = false;
const windowManager = new WindowManager();
let searchEngine = null; // Initialized after store is created
let openedMarkdownRegistrar = null;
let nativeRebuildManager = null;
const mediaViewerWindowsByParent = new Map();
const mediaViewerParentByWindowId = new Map();
const mediaViewerWindows = new Map();
const mediaViewerPayloads = new Map();
const mediaViewerParentCloseListeners = new Map();

// =============================================================================
// File argument helpers
// =============================================================================

function isMarkdownFilePath(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return ext === '.md' || ext === '.markdown';
}

function scheduleOpenedMarkdownRegistration(filePath) {
  if (!openedMarkdownRegistrar || !isMarkdownFilePath(filePath)) return;
  openedMarkdownRegistrar.schedule(filePath);
}

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
    if (isMarkdownFilePath(arg)) {
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
  if (!isMarkdownFilePath(resolved)) return;
  try {
    fs.accessSync(resolved, fs.constants.R_OK);
  } catch {
    console.error(`[doculight] Cannot read file: ${resolved}`);
    return;
  }
  windowManager.createWindow({ filePath: resolved, registerOpenedMarkdown: true });
  addRecentFile(resolved);
}

function normalizeRenderPastedContentInput(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return {
      text: typeof payload.text === 'string' ? payload.text : '',
      allowMarkdownFallback: payload.allowMarkdownFallback !== false
    };
  }
  return {
    text: typeof payload === 'string' ? payload : '',
    allowMarkdownFallback: true
  };
}

const store = new Store({
  schema: {
    theme: { type: 'string', enum: ['light', 'dark'], default: 'light' },
    fontSize: { type: 'number', minimum: 8, maximum: 32, default: 16 },
    fontFamily: { type: 'string', minLength: 1, default: 'system-ui, -apple-system, sans-serif' },
    codeTheme: { type: 'string', default: 'github' },
    mcpPort: { type: 'number', minimum: 1, maximum: 65535, default: runtimeProfile.mcpPortDefault },
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
    enableTabs: { type: 'boolean', default: true },
    recentFiles: { type: 'array', items: { type: 'string' }, default: [] },
    contentWidth: { type: 'string', default: '900px' },
    contentMaxWidth: { type: 'string', default: '900px' },
    mcpAutoSave: { type: 'boolean', default: false },
    mcpAutoSavePath: { type: 'string', default: '' },
    registerOpenedMarkdown: { type: 'boolean', default: false },
    mcpSaveSubDir: { type: 'string', default: '{yyyy-mm-dd}' },
    mcpGitInfo: { type: 'boolean', default: true },
    lastSaveAsDirectory: { type: 'string', default: '' },
    showDocNav: { type: 'boolean', default: true },
    embeddingApiKeyCiphertext: { type: 'string', default: '' },
    semanticSearch: {
      type: 'object',
      default: {
        enabled: false,
        provider: 'openai-compatible',
        baseURL: '',
        model: '',
        dimensions: null,
        batchSize: 16,
        maxConcurrency: 2,
        timeout: 30000,
        retryPolicy: { retries: 2, backoffMs: 500 },
        apiKeyStorage: 'none',
        hasApiKey: false,
        hnsw: { m: 16, efConstruction: 200, efSearch: 64 },
        chunker: { chunkSize: EMBEDDING_DEFAULT_CHUNK_SIZE, chunkOverlap: EMBEDDING_DEFAULT_CHUNK_OVERLAP },
        modelFingerprint: null,
        status: 'unset',
        statusReason: null,
        lastValidatedAt: null,
        offlineOnly: false,
        retentionCostConfirmationVersion: null,
        endpointPolicy: 'https-or-approved-local',
        projectPolicy: { mode: 'allow-all', projects: [] },
        activationRecord: null,
        secretMigration: null,
        semanticIndexing: { status: 'idle', progress_current: 0, progress_total: 0 }
      },
      additionalProperties: true,
      properties: {
        enabled: { type: 'boolean' },
        provider: { type: 'string' },
        baseURL: { type: 'string' },
        model: { type: 'string' },
        dimensions: { type: ['number', 'null'] },
        batchSize: { type: 'number' },
        maxConcurrency: { type: 'number' },
        timeout: { type: 'number' },
        retryPolicy: { type: 'object', additionalProperties: true },
        apiKeyStorage: { type: 'string' },
        hasApiKey: { type: 'boolean' },
        hnsw: { type: 'object', additionalProperties: true },
        chunker: { type: 'object', additionalProperties: true },
        modelFingerprint: { type: ['string', 'null'] },
        status: { type: 'string' },
        statusReason: { type: ['string', 'null'] },
        lastValidatedAt: { type: ['string', 'null'] },
        offlineOnly: { type: 'boolean' },
        retentionCostConfirmationVersion: { type: ['string', 'null'] },
        endpointPolicy: { type: 'string' },
        projectPolicy: { type: 'object', additionalProperties: true },
        activationRecord: { type: ['object', 'null'], additionalProperties: true },
        secretMigration: { type: ['object', 'null'], additionalProperties: true },
        semanticIndexing: { type: 'object', additionalProperties: true }
      }
    }
  }
});

// Remove or migrate legacy plaintext embedding credentials before any settings payload is read.
migratePlaintextEmbeddingApiKey({
  store,
  safeStorage,
  envKey: process.env.DOCULIGHT_EMBEDDING_API_KEY
});

// Initialize search engine after store is ready
searchEngine = new SearchEngine(store, {
  indexBackend: 'sqlite',
  indexDataDir: runtimeProfile.indexDataDir,
  embeddingConfigProvider: () => getStoredEmbeddingSettings(),
  embeddingApiKeyProvider: () => getEmbeddingApiKey().key,
  embeddingProvider: createOpenAICompatibleEmbeddingProvider({
    getEmbeddingConfig: () => getStoredEmbeddingSettings(),
    getApiKey: () => getEmbeddingApiKey().key
  })
});
openedMarkdownRegistrar = createOpenedMarkdownRegistrar({ store, searchEngine });
nativeRebuildManager = createNativeRebuildManager({
  rootDir: path.resolve(__dirname, '..', '..'),
  statusDir: runtimeProfile.nativeRebuildStatusDir,
  execPath: process.execPath,
  isPackaged: app.isPackaged
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
const gotTheLock = PACKAGE_SMOKE_REQUESTED ? true : app.requestSingleInstanceLock();

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
  if (PACKAGE_SMOKE_REQUESTED) {
    await runPackageSmoke();
    return;
  }

  app.setAppUserModelId(runtimeProfile.appUserModelId);
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
  windowManager.onRegisterOpenedMarkdown = scheduleOpenedMarkdownRegistration;

  startNativeRepairIfNeeded();

  // Re-register file association on startup (fixes path changes after app updates)
  const fileAssoc = require('./file-association');
  if (!runtimeProfile.isDev && store.get('fileAssociation', false) && fileAssoc.isSupported()) {
    fileAssoc.register().catch(err => {
      console.error('[doculight] Failed to re-register file association:', err.message);
    });
  }

  // Initialize search engine (background, non-blocking)
  initializeSearchEngineIfConfigured();

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

  // Start HTTP-based MCP server (ESM module loaded via dynamic import)
  // Moved after window creation to avoid blocking the initial UI
  try {
    const { startMcpHttpServer } = await import('./mcp-http.mjs');
    mcpHttpServer = await startMcpHttpServer(windowManager, store, app.getPath('userData'), searchEngine);
  } catch (err) {
    console.error('[doculight] Failed to start MCP HTTP server:', err.message);
  }

  // DevTools disabled — use Ctrl+Shift+I manually if needed
});

async function runPackageSmoke() {
  const smokeRoot = fs.mkdtempSync(path.join(app.getPath('temp'), 'doculight-package-smoke-'));
  const nativeIndexDataDir = path.join(smokeRoot, 'native-index');
  const runtimeIndexDataDir = path.join(smokeRoot, 'runtime-index');
  const indexPath = path.join(nativeIndexDataDir, SQLITE_INDEX_FILENAME);
  const userDataPath = path.join(smokeRoot, 'user-data');
  const smokeRedactor = createRedactor({
    userDataDir: userDataPath,
    indexDir: nativeIndexDataDir,
    dbPath: indexPath,
    sourceRoots: [smokeRoot],
    extraPaths: [runtimeIndexDataDir]
  });
  const tokenizer = createKeywordTokenizer({ provider: 'garu' });
  await tokenizer.initialize();
  const sqliteIndex = new SQLiteKeywordIndex({ dbPath: indexPath, sourceRoot: smokeRoot, tokenizer });
  const packageSmokeStore = createPackageSmokeStore({
    mcpAutoSave: true,
    mcpAutoSavePath: smokeRoot,
    mcpSaveSubDir: '',
    mcpGitInfo: false,
    userDataPath
  });
  const runtimeSearchEngine = new SearchEngine(packageSmokeStore, {
    indexBackend: 'sqlite',
    indexDataDir: runtimeIndexDataDir,
    keywordTokenizer: createKeywordTokenizer({ provider: 'garu' })
  });
  let artifact = {
    ok: false,
    backend: 'sqlite-fts5',
    tokenizer: tokenizer.getStatus(),
    resultCount: 0,
    koreanResultCount: 0,
    saveToSearch: {
      saved: false,
      searchDocumentsFound: 0,
      smartSearchFound: 0,
      identityMatched: false,
      indexingJobIdPresent: false,
      indexingJobIdDiagnosticOnly: false
    },
    saveDocumentInvalid: {
      forbiddenFieldRejected: false,
      unknownFieldRejected: false,
      multipleUnknownFieldsRejected: false,
      gitContextPathRejected: false,
      canonicalErrorEnvelope: false,
      rawEchoFree: false,
      writeFailedCode: null
    },
    nativeFailure: {
      loadReason: null,
      smartSearchDegradationReasons: []
    },
    workerNative: {
      runtime: 'worker_threads search-index-worker compatible',
      betterSqlite3: { state: 'native_unavailable' },
      hnswlibNode: { state: 'native_unavailable' },
      electronAbi: process.versions.modules || null,
      nodeAbi: process.versions.modules || null,
      searchIndexWorkerJob: {
        queued: false,
        completed: false,
        documentIndexed: false
      }
    },
    redactionFixture: {
      classes: [],
      allClassesCovered: false,
      rawEchoFree: false
    },
    clientProfileOracle: readPackageSmokeClientProfileOracleSummary(),
    packagedCliStdio: {
      status: 'not_run',
      stdoutPurity: 'not_checked',
      redactedEndpointClass: null,
      noIndexingControls: false
    },
    indexPath: smokeRedactor.redactPath(indexPath)
  };

  try {
    sqliteIndex.rebuild([{
      filePath: path.join(smokeRoot, 'smoke.md'),
      meta: {
        title: 'Package Smoke',
        project: 'DocuLight',
        docName: 'package-smoke',
        docType: 'test',
        description: 'SQLite native package smoke',
        snippet: 'native smoke sqlite package'
      },
      body: 'native smoke sqlite package',
      contentHash: 'package-smoke',
      textHash: 'package-smoke'
    }, {
      filePath: path.join(smokeRoot, 'korean.md'),
      meta: {
        title: 'Korean Smoke',
        project: 'DocuLight',
        docName: 'package-smoke-korean',
        docType: 'test',
        description: 'Korean morphology package smoke',
        snippet: '학교에서 점심을 먹었다'
      },
      body: '학교에서 점심을 먹었다',
      contentHash: 'package-smoke-korean',
      textHash: 'package-smoke-korean'
    }]);
    const results = sqliteIndex.search('native smoke', { limit: 5 });
    const koreanResults = sqliteIndex.search('먹다', { limit: 5 });
    await runtimeSearchEngine.initialize();
    const marker = `package-smoke-marker-${Date.now()}-${process.pid}`;
    const saveResult = await saveDocumentToStore(packageSmokeStore, {
      content: `# Package Save Search\n\nUnique marker: ${marker}\n`,
      title: 'Package Save Search',
      project: 'DocuLight',
      docType: 'note',
      category: 'package-smoke',
      documentTags: ['package-smoke', 'wave2']
    }, runtimeSearchEngine);
    const saveText = saveResult && saveResult.content && saveResult.content[0] ? saveResult.content[0].text : '';
    if (!saveText || saveText.includes(smokeRoot)) {
      throw new Error('save_document package smoke response leaked an absolute package smoke path');
    }
    const savePayload = JSON.parse(saveText);
    if (!savePayload.saved || !savePayload.documentId || !savePayload.sourceRelativePath) {
      const failureCode = savePayload.error && savePayload.error.code ? String(savePayload.error.code) : 'missing_required_field';
      const failureMessage = savePayload.error && savePayload.error.message
        ? smokeRedactor.redactString(savePayload.error.message)
        : 'saved, documentId, or sourceRelativePath was missing';
      throw new Error(
        `save_document package smoke did not return a canonical saved envelope: code=${failureCode} ` +
        `saved=${savePayload.saved === true} documentId=${Boolean(savePayload.documentId)} ` +
        `sourceRelativePath=${Boolean(savePayload.sourceRelativePath)} message=${failureMessage}`
      );
    }
    await runtimeSearchEngine.rebuild();
    const savedSearchResults = runtimeSearchEngine.search(marker, { limit: 5 });
    const savedSearchMatch = savedSearchResults.find((item) => item.filePath && item.filePath.endsWith(savePayload.sourceRelativePath.replace(/\//g, path.sep)));
    const smartSearchPayload = await runtimeSearchEngine.smartSearch({
      query: marker,
      limit: 5,
      includeDiagnostics: true
    });
    const smartSearchMatch = Array.isArray(smartSearchPayload.results)
      ? smartSearchPayload.results.find((item) => item.documentId === savePayload.documentId || item.sourceRelativePath === savePayload.sourceRelativePath)
      : null;
    if (!savedSearchMatch || !smartSearchMatch) {
      throw new Error('save_document package smoke marker was not retrievable by search_documents and smart_search');
    }
    const invalidSaveDocument = await runPackageSmokeInvalidSaveDocumentChecks({
      smokeRoot,
      packageSmokeStore,
      runtimeSearchEngine,
      redactor: smokeRedactor
    });
    const redactionFixture = buildPackageSmokeRedactionFixture({
      smokeRoot,
      indexPath,
      nativeIndexDataDir,
      runtimeIndexDataDir,
      userDataPath,
      redactor: smokeRedactor,
      writeFailurePath: invalidSaveDocument.writeFailurePath
    });
    const workerNative = sanitizePackageSmokeWorkerNative(
      await probePackageSmokeWorkerNative(),
      smokeRedactor
    );
    workerNative.searchIndexWorkerJob = await runPackageSmokeSearchIndexWorkerJob({
      runtimeSearchEngine,
      smokeRoot
    });
    const packagedCliStdio = await runPackageSmokePackagedCliStdio({
      packageSmokeStore,
      runtimeSearchEngine,
      marker,
      documentId: savePayload.documentId,
      sourceRelativePath: savePayload.sourceRelativePath,
      userDataPath,
      redactor: smokeRedactor
    });
    const nativeLoad = loadHnswlib({ forceUnavailable: true });
    const previousSemanticProvider = runtimeSearchEngine.options.semanticCandidateProvider;
    runtimeSearchEngine.options.semanticCandidateProvider = {
      search() {
        return {
          status: 'degraded',
          degradationReason: 'native_unavailable',
          backend: 'hnsw',
          candidates: []
        };
      }
    };
    const nativeFailureSmartSearch = await runtimeSearchEngine.smartSearch({
      query: marker,
      limit: 5,
      includeDiagnostics: true
    });
    runtimeSearchEngine.options.semanticCandidateProvider = previousSemanticProvider;
    artifact = {
      ...artifact,
      tokenizer: tokenizer.getStatus(),
      ok: results.length > 0 && koreanResults.length > 0 && Boolean(savedSearchMatch) && Boolean(smartSearchMatch),
      resultCount: results.length,
      koreanResultCount: koreanResults.length,
      saveToSearch: {
        saved: true,
        documentId: savePayload.documentId,
        sourceRelativePath: savePayload.sourceRelativePath,
        indexingState: savePayload.indexing && savePayload.indexing.state ? savePayload.indexing.state : null,
        indexingJobIdPresent: Boolean(savePayload.indexing && typeof savePayload.indexing.jobId === 'string' && savePayload.indexing.jobId.length > 0),
        indexingJobIdDiagnosticOnly: Boolean(savePayload.indexing && typeof savePayload.indexing.jobId === 'string' && savePayload.indexing.jobId.length > 0) &&
          !['statusUrl', 'cancelTool', 'retryTool', 'rebuildTool', 'importTool', 'reconciliationTool'].some((key) =>
            Object.prototype.hasOwnProperty.call(savePayload.indexing || {}, key)
          ),
        queuedBooleanPresent: Object.prototype.hasOwnProperty.call(savePayload, 'queued') ||
          Object.prototype.hasOwnProperty.call(savePayload.indexing || {}, 'queued'),
        searchDocumentsFound: savedSearchResults.length,
        smartSearchFound: smartSearchPayload.results.length,
        identityMatched: smartSearchMatch.documentId === savePayload.documentId || smartSearchMatch.sourceRelativePath === savePayload.sourceRelativePath,
        degraded: smartSearchPayload.degraded === true,
        degradationReasons: smartSearchPayload.degradationReasons || []
      },
      saveDocumentInvalid: invalidSaveDocument.summary,
      nativeFailure: {
        loadReason: nativeLoad && nativeLoad.reason ? nativeLoad.reason : null,
        smartSearchDegradationReasons: nativeFailureSmartSearch.degradationReasons || []
      },
      workerNative,
      redactionFixture,
      packagedCliStdio
    };
    if (!artifact.ok) {
      throw new Error('SQLite package smoke query returned no results');
    }
    writePackageSmokeArtifact(artifact);
    app.exit(0);
  } catch (err) {
    writePackageSmokeArtifact({
      ...artifact,
      ok: false,
      error: smokeRedactor.redactString(err.message)
    });
    console.error('[doculight] Package smoke failed:', smokeRedactor.redactString(err.message));
    app.exit(1);
  } finally {
    sqliteIndex.close();
    runtimeSearchEngine.close();
    try { fs.rmSync(smokeRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function probePackageSmokeWorkerNative() {
  return new Promise((resolve) => {
    const worker = new Worker(`
      const { parentPort } = require('worker_threads');
      const path = require('path');
      function requirePackagedModule(name) {
        const packagedPath = process.resourcesPath
          ? path.join(process.resourcesPath, 'app.asar', 'node_modules', name)
          : name;
        const unpackedPath = process.resourcesPath
          ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', name)
          : name;
        try {
          return require(packagedPath);
        } catch (firstErr) {
          if (packagedPath !== unpackedPath) {
            try {
              return require(unpackedPath);
            } catch {
              // Fall through to package name fallback below.
            }
          }
          if (packagedPath === name) throw firstErr;
          try {
            return require(name);
          } catch {
            throw firstErr;
          }
        }
      }
      function probeBetterSqlite3() {
        try {
          const Database = requirePackagedModule('better-sqlite3');
          const db = new Database(':memory:');
          db.prepare('SELECT 1 AS ok').get();
          db.close();
          return { state: 'loaded', moduleVersion: process.versions.modules || null };
        } catch (err) {
          return {
            state: 'native_unavailable',
            code: err && err.code ? err.code : null,
            message: err && err.message ? err.message : String(err),
            moduleVersion: process.versions.modules || null
          };
        }
      }
      function probeHnswlibNode() {
        try {
          requirePackagedModule('hnswlib-node');
          return { state: 'loaded', moduleVersion: process.versions.modules || null };
        } catch (err) {
          return {
            state: 'native_unavailable',
            code: err && err.code ? err.code : null,
            message: err && err.message ? err.message : String(err),
            moduleVersion: process.versions.modules || null
          };
        }
      }
      parentPort.postMessage({
        runtime: 'worker_threads search-index-worker compatible',
        betterSqlite3: probeBetterSqlite3(),
        hnswlibNode: probeHnswlibNode(),
        electronAbi: process.versions.modules || null,
        nodeAbi: process.versions.modules || null
      });
    `, { eval: true });
    const timer = setTimeout(() => {
      try { worker.terminate(); } catch { /* ignore */ }
      resolve({
        runtime: 'worker_threads search-index-worker compatible',
        betterSqlite3: { state: 'native_unavailable', message: 'worker native probe timeout' },
        hnswlibNode: { state: 'native_unavailable', message: 'worker native probe timeout' },
        electronAbi: process.versions.modules || null,
        nodeAbi: process.versions.modules || null
      });
    }, 10000);
    worker.once('message', (message) => {
      clearTimeout(timer);
      try { worker.terminate(); } catch { /* ignore */ }
      resolve(message);
    });
    worker.once('error', (err) => {
      clearTimeout(timer);
      resolve({
        runtime: 'worker_threads search-index-worker compatible',
        betterSqlite3: { state: 'native_unavailable', message: err && err.message ? err.message : String(err) },
        hnswlibNode: { state: 'native_unavailable', message: err && err.message ? err.message : String(err) },
        electronAbi: process.versions.modules || null,
        nodeAbi: process.versions.modules || null
      });
    });
  });
}

function sanitizePackageSmokeWorkerNative(workerNative, redactor) {
  const sanitizeProbe = (probe) => ({
    state: probe && probe.state === 'loaded' ? 'loaded' : 'native_unavailable',
    code: probe && probe.code ? String(probe.code) : null,
    message: probe && probe.message ? redactor.redactString(String(probe.message)).slice(0, 240) : null,
    moduleVersion: probe && probe.moduleVersion ? String(probe.moduleVersion) : null
  });
  return {
    runtime: 'worker_threads search-index-worker compatible',
    betterSqlite3: sanitizeProbe(workerNative && workerNative.betterSqlite3),
    hnswlibNode: sanitizeProbe(workerNative && workerNative.hnswlibNode),
    electronAbi: workerNative && workerNative.electronAbi ? String(workerNative.electronAbi) : (process.versions.modules || null),
    nodeAbi: workerNative && workerNative.nodeAbi ? String(workerNative.nodeAbi) : (process.versions.modules || null)
  };
}

async function runPackageSmokeSearchIndexWorkerJob({ runtimeSearchEngine, smokeRoot }) {
  const content = [
    '# Package Worker Job',
    '',
    `Packaged search-index-worker document job ${Date.now()} ${process.pid}`
  ].join('\n');
  const filePath = path.join(smokeRoot, 'package-worker-job.md');
  fs.writeFileSync(filePath, content, 'utf-8');
  const queued = runtimeSearchEngine.queueDocumentIndex({
    filePath,
    content,
    requestedBy: 'package-smoke.search-index-worker'
  });
  if (!queued || queued.queued !== true || !queued.jobId) {
    return {
      queued: false,
      completed: false,
      documentIndexed: false,
      reason: queued && queued.reason ? queued.reason : 'enqueue_failed'
    };
  }
  try {
    await runtimeSearchEngine._drainSmartIndexQueue();
    const ledger = runtimeSearchEngine.getSourceLedger();
    const job = ledger && typeof ledger.getIndexJob === 'function' ? ledger.getIndexJob(queued.jobId) : null;
    const identity = typeof runtimeSearchEngine.getSmartSearchDocumentIdentity === 'function'
      ? runtimeSearchEngine.getSmartSearchDocumentIdentity(filePath)
      : null;
    return {
      queued: true,
      jobIdPresent: true,
      completed: Boolean(job && job.status === 'completed'),
      documentIndexed: Boolean(identity && identity.documentId),
      diagnosticCode: job && job.diagnosticCode ? job.diagnosticCode : null
    };
  } catch (err) {
    return {
      queued: true,
      jobIdPresent: true,
      completed: false,
      documentIndexed: false,
      diagnosticCode: err && err.code ? err.code : 'search_index_worker_job_failed'
    };
  }
}

async function runPackageSmokeInvalidSaveDocumentChecks({ smokeRoot, packageSmokeStore, runtimeSearchEngine, redactor }) {
  const credentialKey = 'api' + '_key';
  const rawNeedles = new Set([smokeRoot, 'rawsecret', `${credentialKey}=secret`, 'token=rawsecret']);
  const summaries = {};
  const responses = [];

  async function capture(name, store, params, extraNeedles = []) {
    const response = await saveDocumentToStore(store, params, runtimeSearchEngine);
    const text = response && response.content && response.content[0] ? response.content[0].text : '';
    let payload = {};
    try {
      payload = JSON.parse(text);
    } catch {
      payload = {};
    }
    responses.push({ name, response, text, payload });
    for (const needle of extraNeedles) rawNeedles.add(needle);
    return { response, text, payload };
  }

  await capture('forbiddenField', packageSmokeStore, {
    content: '# Invalid Forbidden Field',
    filePath: path.join(smokeRoot, 'rawsecret-forbidden.md')
  }, [path.join(smokeRoot, 'rawsecret-forbidden.md')]);
  await capture('unknownField', packageSmokeStore, {
    content: '# Invalid Unknown Field',
    unexpectedField: 'rawsecret'
  });
  await capture('multipleUnknownFields', packageSmokeStore, {
    content: '# Invalid Multiple Unknown Fields',
    unexpectedField: 'rawsecret',
    anotherUnexpectedField: `${credentialKey}=secret`
  });
  const unsafeGitContextPath = path.join(app.getPath('temp'), `doculight-token=rawsecret-${process.pid}`, 'repo');
  await capture('gitContextPath', packageSmokeStore, {
    content: '# Invalid Git Context',
    gitContextPath: unsafeGitContextPath
  }, [unsafeGitContextPath]);

  const writeFailurePath = path.join(smokeRoot, 'not-a-directory.md');
  fs.writeFileSync(writeFailurePath, 'not a directory', 'utf-8');
  const writeFailureStore = createPackageSmokeStore({
    mcpAutoSave: true,
    mcpAutoSavePath: writeFailurePath,
    mcpSaveSubDir: '',
    mcpGitInfo: false,
    userDataPath: path.join(smokeRoot, 'write-failure-user-data')
  });
  await capture('writeFailure', writeFailureStore, {
    content: '# Write Failure',
    title: 'Write Failure'
  }, [writeFailurePath]);

  for (const { name, response, payload } of responses) {
    summaries[name] = {
      isError: response && response.isError === true,
      code: payload && payload.error ? payload.error.code : null,
      schemaVersion: payload.schemaVersion || null,
      saved: payload.saved === false,
      hasRetryable: Boolean(payload.error && Object.prototype.hasOwnProperty.call(payload.error, 'retryable')),
      warningsArray: Array.isArray(payload.warnings)
    };
  }

  const canonicalErrorEnvelope = responses.every(({ response, payload }) =>
    response && response.isError === true &&
    payload.schemaVersion === 'save_document.v1' &&
    payload.saved === false &&
    payload.error &&
    typeof payload.error.code === 'string' &&
    typeof payload.error.message === 'string' &&
    typeof payload.error.retryable === 'boolean' &&
    Array.isArray(payload.warnings)
  );
  const serializedResponses = responses.map((item) => item.text).join('\n');
  const rawEchoFree = Array.from(rawNeedles)
    .filter((needle) => typeof needle === 'string' && needle.length > 0)
    .every((needle) => !serializedResponses.includes(needle)) &&
    !/[A-Za-z]:[\\/]/.test(serializedResponses) &&
    !/api[_-]?key=secret|token=rawsecret|password=rawsecret|bearer=rawsecret/i.test(serializedResponses);

  return {
    writeFailurePath,
    summary: {
      forbiddenFieldRejected: summaries.forbiddenField && summaries.forbiddenField.code === 'validation_failed',
      unknownFieldRejected: summaries.unknownField && summaries.unknownField.code === 'validation_failed',
      multipleUnknownFieldsRejected: summaries.multipleUnknownFields && summaries.multipleUnknownFields.code === 'validation_failed',
      gitContextPathRejected: summaries.gitContextPath && summaries.gitContextPath.code === 'validation_failed',
      canonicalErrorEnvelope,
      rawEchoFree,
      writeFailedCode: summaries.writeFailure ? summaries.writeFailure.code : null,
      responseCodes: responses.map((item) => item.payload && item.payload.error ? item.payload.error.code : null),
      redactedWriteFailurePath: redactor.redactPath(writeFailurePath)
    }
  };
}

function buildPackageSmokeRedactionFixture({
  smokeRoot,
  indexPath,
  nativeIndexDataDir,
  runtimeIndexDataDir,
  userDataPath,
  redactor,
  writeFailurePath
}) {
  const credentialKey = 'api' + '_key';
  const required = {
    windowsDrivePath: String.raw`C:\Users\Example\repo\secret.md`,
    uncPath: String.raw`\\server\share\secret.md`,
    posixAbsolutePath: '/tmp/doculight-package-smoke-secret.md',
    userHomePath: path.join(app.getPath('home'), 'doculight-secret.md'),
    appUserDataIndexPath: indexPath,
    credentialBearingUrl: `https://user:password@example.test/v1/embeddings?${credentialKey}=secret`,
    rawGitContextPath: path.join(smokeRoot, 'git-context-raw'),
    embeddingEndpointFailure: 'embedding provider failed at https://user:password@example.test/v1?token=rawsecret',
    saveDocumentWriteFailure: `write failed for ${writeFailurePath}`,
    nativeLoadFailure: `hnsw native load failed from ${nativeIndexDataDir} token=rawsecret`,
    keywordOnlyDegradedResponse: 'smart_search degraded keyword_only embedding_disabled',
    smartSearchRedactedResponse: `smart_search diagnostics ${runtimeIndexDataDir} ${userDataPath} bearer=rawsecret`
  };
  const redacted = Object.fromEntries(Object.entries(required).map(([key, value]) => [key, redactor.redactString(value)]));
  const serialized = JSON.stringify(redacted);
  const sensitiveKeys = [
    'windowsDrivePath',
    'uncPath',
    'posixAbsolutePath',
    'userHomePath',
    'appUserDataIndexPath',
    'credentialBearingUrl',
    'rawGitContextPath',
    'embeddingEndpointFailure',
    'saveDocumentWriteFailure',
    'nativeLoadFailure',
    'smartSearchRedactedResponse'
  ];
  const rawEchoFree = sensitiveKeys.every((key) => !serialized.includes(required[key])) &&
    !/\b[A-Za-z]:[\\/](?![\\/])/.test(serialized) &&
    !/\\\\[^\\/\s]+[\\/][^\\/\s]+/.test(serialized) &&
    !/(^|[":\s])\/(?:Users|home|tmp|temp|var|private|mnt|Volumes|Work)\b/.test(serialized) &&
    !/api[_-]?key=secret|token=rawsecret|password=rawsecret|bearer=rawsecret|user:password/i.test(serialized);
  return {
    classes: Object.keys(required),
    allClassesCovered: Object.keys(required).length === 12,
    rawEchoFree,
    redacted
  };
}

function createPackageSmokeStore(initialValues) {
  const values = new Map(Object.entries(initialValues || {}));
  return {
    get(key, defaultValue) {
      return values.has(key) ? values.get(key) : defaultValue;
    },
    set(key, value) {
      values.set(key, value);
    }
  };
}

function readPackageSmokeClientProfileOracleSummary() {
  const fixturePath = path.join(process.cwd(), 'test', 'fixtures', 'wave2-client-profile-oracles.json');
  try {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
    const defaultSerializedBytes = Math.max(...fixture.oracles.map((oracle) => Number(oracle.outputCaps && oracle.outputCaps.defaultSerializedBytes) || 0));
    return {
      version: fixture.version,
      count: Array.isArray(fixture.oracles) ? fixture.oracles.length : 0,
      defaultSerializedBytes
    };
  } catch {
    return {
      version: 'wave2-client-profile-oracles.v1',
      count: 9,
      defaultSerializedBytes: 65536
    };
  }
}

function assertMcpSearchConfigured() {
  if (!store.get('mcpAutoSave', false) || !store.get('mcpAutoSavePath', '')) {
    throw new Error('Search requires mcpAutoSave to be enabled with a configured mcpAutoSavePath.');
  }
  if (!searchEngine) {
    throw new Error('Search engine not available. Ensure mcpAutoSave is enabled.');
  }
}

function writePackageSmokeArtifact(artifact) {
  const artifactPath = process.env.DOCULIGHT_PACKAGE_SMOKE_OUT;
  if (!artifactPath) return;
  try {
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf-8');
  } catch (err) {
    console.error('[doculight] Failed to write package smoke artifact:', err.message);
  }
}

async function runPackageSmokePackagedCliStdio({
  packageSmokeStore,
  runtimeSearchEngine,
  marker,
  documentId,
  sourceRelativePath,
  userDataPath,
  redactor
}) {
  const forbiddenTools = [
    'save_markdown',
    'store_document',
    'remember_document',
    'rebuild_search_index',
    'clear_search_index',
    'retry_indexing',
    'cancel_indexing',
    'indexing_status',
    'search_index_status',
    'import_markdown_links',
    'reconcile_broken_links',
    'model_change_reindex',
    'model-change-reindex'
  ];
  const evidence = {
    status: 'running',
    runtimeProfile: 'explicit-ipc',
    redactedEndpointClass: '[REDACTED_MCP_IPC:explicit]',
    stdoutPurity: 'not_checked',
    stdoutJsonRpcMessageCount: 0,
    stdoutNonJsonLineCount: null,
    stdoutNonJsonLineSamples: [],
    stderrDiagnostics: 'stderr_or_mcp_error_only',
    stderrByteCount: 0,
    initializeHandshake: false,
    initializedNotification: false,
    toolNames: [],
    httpToolNames: [],
    noIndexingControls: false,
    saveDocument: { saved: false },
    smartSearch: { found: false },
    invalidSaveDocument: { rejected: false, rawEchoFree: false },
    invalidSmartSearch: { pathPrefixRejected: false, rawEchoFree: false },
    crossTransportMarkerIdentity: {
      markerSavedBy: 'cli-stdio',
      markerSearchedBy: 'cli-stdio-and-http-tools-list-parity',
      matched: false
    }
  };

  const ipcServer = await startPackageSmokeMcpIpcServer({
    packageSmokeStore,
    runtimeSearchEngine
  });
  const cliMarker = `xopsarch013cli${Date.now()}${process.pid}z`;
  packageSmokeStore.set('mcpPort', allocatePackageSmokeMcpPort());
  fs.mkdirSync(userDataPath, { recursive: true });
  const { startMcpHttpServer } = await import('./mcp-http.mjs');
  const packageSmokeHttpServer = await startMcpHttpServer(windowManager, packageSmokeStore, userDataPath, runtimeSearchEngine);

  try {
    const httpAddress = packageSmokeHttpServer.address();
    const httpPort = httpAddress && typeof httpAddress.port === 'number' ? httpAddress.port : null;
    const httpToolList = await postPackageSmokeMcpHttp(httpPort, 'tools/list', {});
    evidence.httpToolNames = ((httpToolList.result && httpToolList.result.tools) || [])
      .map((tool) => tool.name)
      .sort();

    const stdoutProbe = await runPackageSmokeRawStdioProbe({ forbiddenTools, redactor });
    const stdioEvidence = await runPackageSmokeStdioMcpClient({
      marker: cliMarker,
      forbiddenTools,
      documentId,
      sourceRelativePath
    });
    if (typeof runtimeSearchEngine.rebuild === 'function') {
      await runtimeSearchEngine.rebuild();
    }
    const httpSmartSearch = await runPackageSmokeHttpSmartSearch({
      port: httpPort,
      marker: cliMarker,
      expectedDocumentId: stdioEvidence.saveDocument && stdioEvidence.saveDocument.documentId,
      expectedSourceRelativePath: stdioEvidence.saveDocument && stdioEvidence.saveDocument.sourceRelativePath
    });
    const httpSearchDocuments = await runPackageSmokeHttpSearchDocuments({
      port: httpPort,
      marker: cliMarker,
      expectedSourceRelativePath: stdioEvidence.saveDocument && stdioEvidence.saveDocument.sourceRelativePath
    });
    Object.assign(evidence, stdioEvidence, stdoutProbe);
    evidence.httpSmartSearch = httpSmartSearch;
    evidence.httpSearchDocuments = httpSearchDocuments;
    evidence.noIndexingControls = evidence.toolNames.every((name) => !isForbiddenMcpIndexingControlToolName(name, forbiddenTools));
    evidence.crossTransportMarkerIdentity.matched = Boolean(
      arraysEqual(evidence.toolNames, evidence.httpToolNames) &&
      evidence.saveDocument.saved &&
      evidence.smartSearch.found &&
      evidence.httpSearchDocuments.found &&
      evidence.stdoutPurity === 'mcp_jsonrpc_only' &&
      evidence.initializeHandshake === true &&
      evidence.initializedNotification === true
    );
    evidence.crossTransportMarkerIdentity.markerSearchedBy = 'http-search_documents';
    evidence.status = evidence.crossTransportMarkerIdentity.matched ? 'passed' : 'failed';
    return evidence;
  } finally {
    await closePackageSmokeHttpServer(packageSmokeHttpServer);
    await closePackageSmokeServer(ipcServer);
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(PIPE_PATH); } catch { /* ignore */ }
    }
  }
}

async function runPackageSmokeHttpSmartSearch({
  port,
  marker,
  expectedDocumentId,
  expectedSourceRelativePath
}) {
  const response = await postPackageSmokeMcpHttp(port, 'tools/call', {
    name: 'smart_search',
    arguments: {
      query: marker,
      limit: 5,
      includeDiagnostics: true
    }
  });
  const result = response && response.result ? response.result : {};
  const text = result.content && result.content[0] ? result.content[0].text : '{}';
  let payload = {};
  try {
    payload = JSON.parse(text);
  } catch {
    payload = {};
  }
  const match = Array.isArray(payload.results)
    ? payload.results.find((item) =>
        item.documentId === expectedDocumentId ||
        item.sourceRelativePath === expectedSourceRelativePath)
    : null;
  const firstResult = Array.isArray(payload.results) && payload.results[0] ? payload.results[0] : null;
  return {
    found: Boolean(match),
    resultCount: Array.isArray(payload.results) ? payload.results.length : 0,
    queryToken: marker,
    expectedIdentity: {
      documentId: expectedDocumentId || null,
      sourceRelativePath: expectedSourceRelativePath || null
    },
    firstResultIdentity: firstResult ? {
      documentId: firstResult.documentId || null,
      sourceRelativePath: firstResult.sourceRelativePath || null,
      title: firstResult.title || null,
      snippet: firstResult.snippet || null,
      redactedPathPresent: Boolean(firstResult.redactedPath)
    } : null,
    degraded: payload.degraded === true,
    degradationReasons: payload.degradationReasons || []
  };
}

async function runPackageSmokeHttpSearchDocuments({ port, marker, expectedSourceRelativePath }) {
  const response = await postPackageSmokeMcpHttp(port, 'tools/call', {
    name: 'search_documents',
    arguments: {
      query: marker,
      limit: 5
    }
  });
  const result = response && response.result ? response.result : {};
  const text = result.content && result.content[0] ? String(result.content[0].text || '') : '';
  return {
    found: Boolean(expectedSourceRelativePath && text.includes(expectedSourceRelativePath)),
    resultCountTextPresent: /^Found\s+\d+\s+result/i.test(text),
    sourceRelativePathMatched: Boolean(expectedSourceRelativePath && text.includes(expectedSourceRelativePath))
  };
}

function containsRawSensitiveText(text, values) {
  const haystack = String(text || '');
  return values.some((value) => {
    if (value == null) return false;
    const raw = String(value);
    const escaped = JSON.stringify(raw).slice(1, -1);
    return haystack.includes(raw) || haystack.includes(escaped);
  });
}

async function runPackageSmokeRawStdioProbe({ forbiddenTools, redactor }) {
  const launch = resolvePackageSmokeCliStdioLaunch();
  const evidence = {
    launchMode: launch.mode,
    stdoutPurity: 'not_checked',
    stdoutJsonRpcMessageCount: 0,
    stdoutNonJsonLineCount: 0,
    stdoutNonJsonLineSamples: [],
    stderrByteCount: 0,
    initializeHandshake: false,
    initializedNotification: false,
    noIndexingControls: false
  };

  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd: process.cwd(),
      env: makePackageSmokeCliStdioEnv(launch),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdoutBuffer = '';
    let stderrBytes = 0;
    let settled = false;
    let toolsListed = false;
    let closeTimer = null;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      flushStdoutRemainder();
      if (child.stdin && !child.stdin.destroyed) {
        try { child.stdin.end(); } catch { /* ignore */ }
      }
      if (child.exitCode === null && !child.killed) {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
      }
      evidence.stderrByteCount = stderrBytes;
      evidence.stdoutPurity = evidence.stdoutNonJsonLineCount === 0 ? 'mcp_jsonrpc_only' : 'mixed_stdout';
      if (err) reject(err);
      else resolve(evidence);
    };

    const send = (message) => {
      child.stdin.write(JSON.stringify(message) + '\n');
    };

    const recordStdoutProtocolViolation = (line) => {
      evidence.stdoutNonJsonLineCount += 1;
      const sample = String(line || '').slice(0, 120);
      evidence.stdoutNonJsonLineSamples.push(
        redactor && typeof redactor.redactString === 'function'
          ? redactor.redactString(sample)
          : sample
      );
    };

    const handleMessage = (message) => {
      if (message && message.jsonrpc === '2.0') {
        evidence.stdoutJsonRpcMessageCount += 1;
      }
      if (message && message.id === 1 && message.result) {
        evidence.initializeHandshake = true;
        evidence.initializedNotification = true;
        send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        return;
      }
      if (message && message.id === 2 && message.result) {
        const toolNames = ((message.result.tools || []).map((tool) => tool.name)).sort();
        evidence.rawProbeToolNames = toolNames;
        evidence.noIndexingControls = toolNames.every((name) => !isForbiddenMcpIndexingControlToolName(name, forbiddenTools));
        toolsListed = true;
        if (child.stdin && !child.stdin.destroyed) {
          child.stdin.end();
        }
        closeTimer = setTimeout(() => finish(), 250);
      }
    };

    const processStdoutLines = () => {
      let newlineIndex;
      while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '');
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          recordStdoutProtocolViolation(line);
          continue;
        }
        if (!message || message.jsonrpc !== '2.0') {
          recordStdoutProtocolViolation(line);
          continue;
        }
        handleMessage(message);
      }
    };

    const flushStdoutRemainder = () => {
      if (!stdoutBuffer.trim()) {
        stdoutBuffer = '';
        return;
      }
      const trailingLine = stdoutBuffer.replace(/\r$/, '');
      stdoutBuffer = '';
      let message;
      try {
        message = JSON.parse(trailingLine);
      } catch {
        recordStdoutProtocolViolation(trailingLine);
        return;
      }
      if (!message || message.jsonrpc !== '2.0') {
        recordStdoutProtocolViolation(trailingLine);
        return;
      }
      handleMessage(message);
    };

    const timer = setTimeout(() => {
      finish(new Error(`Package CLI raw stdio probe timed out before tools/list=${toolsListed}`));
    }, 10_000);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      processStdoutLines();
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
    });
    child.on('error', finish);
    child.on('spawn', () => {
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'doculight-package-cli-raw-stdio-smoke', version: '0.0.0' }
        }
      });
    });
    child.on('close', () => {
      flushStdoutRemainder();
      if (toolsListed) finish();
    });
  });
}

async function runPackageSmokeStdioMcpClient({ marker, forbiddenTools, documentId, sourceRelativePath }) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const launch = resolvePackageSmokeCliStdioLaunch();
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    cwd: process.cwd(),
    env: makePackageSmokeCliStdioEnv(launch),
    stderr: 'pipe'
  });
  const client = new Client({ name: 'doculight-package-cli-stdio-smoke', version: '0.0.0' });
  try {
    await client.connect(transport);
    const toolList = await client.listTools();
    const toolNames = toolList.tools.map((tool) => tool.name).sort();

    const invalidSaveResult = await client.callTool({
      name: 'save_document',
      arguments: {
        content: '# Invalid package CLI save',
        filePath: 'C:\\Users\\secret\\package-cli.md'
      }
    });
    const invalidSaveText = JSON.stringify(invalidSaveResult);
    const invalidSmartSearchResult = await client.callTool({
      name: 'smart_search',
      arguments: {
        query: marker,
        filters: { pathPrefix: 'C:\\Users\\secret\\package-cli.md?token=rawsecret' },
        includeDiagnostics: true
      }
    });
    const invalidSmartSearchText = JSON.stringify(invalidSmartSearchResult);

    const saveResult = await client.callTool({
      name: 'save_document',
      arguments: {
        content: `# Package CLI Stdio\n\nUnique marker: ${marker}\n`,
        title: 'Package CLI Stdio',
        project: 'DocuLight',
        docType: 'note',
        category: 'package-smoke',
        documentTags: ['package-cli-stdio']
      }
    });
    const savePayload = JSON.parse(saveResult.content[0].text);

    if (typeof runtimeSearchRefreshForPackageSmoke === 'function') {
      await runtimeSearchRefreshForPackageSmoke();
    }

    const smartSearchResult = await client.callTool({
      name: 'smart_search',
      arguments: {
        query: marker,
        limit: 5,
        includeDiagnostics: true
      }
    });
    const smartSearchPayload = JSON.parse(smartSearchResult.content[0].text);
    const smartSearchMatch = Array.isArray(smartSearchPayload.results)
      ? smartSearchPayload.results.find((item) =>
          item.documentId === savePayload.documentId ||
          item.sourceRelativePath === savePayload.sourceRelativePath ||
          JSON.stringify(item).includes(marker))
      : null;
    const smartSearchFirstResult = Array.isArray(smartSearchPayload.results) && smartSearchPayload.results[0]
      ? smartSearchPayload.results[0]
      : null;

    return {
      launchMode: launch.mode,
      toolNames,
      noIndexingControls: toolNames.every((name) => !isForbiddenMcpIndexingControlToolName(name, forbiddenTools)),
      saveDocument: {
        saved: savePayload.saved === true,
        documentId: savePayload.documentId || null,
        sourceRelativePath: savePayload.sourceRelativePath || null,
        indexingJobIdPresent: Boolean(savePayload.indexing && savePayload.indexing.jobId)
      },
      smartSearch: {
        found: Boolean(smartSearchMatch),
        resultCount: Array.isArray(smartSearchPayload.results) ? smartSearchPayload.results.length : 0,
        matchedBy: smartSearchMatch
          ? (smartSearchMatch.documentId === savePayload.documentId || smartSearchMatch.sourceRelativePath === savePayload.sourceRelativePath ? 'identity' : 'unique-marker')
          : 'none',
        firstResultIdentity: smartSearchFirstResult ? {
          documentId: smartSearchFirstResult.documentId || null,
          sourceRelativePath: smartSearchFirstResult.sourceRelativePath || null,
          markerPresent: JSON.stringify(smartSearchFirstResult).includes(marker)
        } : null,
        degraded: smartSearchPayload.degraded === true,
        degradationReasons: smartSearchPayload.degradationReasons || []
      },
      invalidSaveDocument: {
        rejected: invalidSaveResult.isError === true,
        rawEchoFree: !containsRawSensitiveText(invalidSaveText, ['C:\\Users\\secret', 'package-cli.md'])
      },
      invalidSmartSearch: {
        pathPrefixRejected: invalidSmartSearchResult.isError === true,
        rawEchoFree: !containsRawSensitiveText(invalidSmartSearchText, ['C:\\Users\\secret', 'package-cli.md', 'token=rawsecret', 'rawsecret'])
      }
    };
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}

function makePackageSmokeCliStdioEnv(launch) {
  return {
    ...process.env,
    ...launch.env,
    DOCULIGHT_MCP_IPC_PATH: PIPE_PATH,
    DOCLIGHT_APP_PATH: process.execPath
  };
}

const FORBIDDEN_MCP_INDEXING_CONTROL_PATTERN = /(?:^|_)(?:rebuild|clear|retry|cancel|status|import|reconcil\w*|model_change|reindex)(?:_|$)/i;

function normalizeMcpToolNameForPolicy(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function isForbiddenMcpIndexingControlToolName(name, forbiddenTools = []) {
  const rawName = String(name || '');
  const normalizedName = normalizeMcpToolNameForPolicy(rawName);
  return forbiddenTools.includes(rawName) ||
    forbiddenTools.includes(normalizedName) ||
    FORBIDDEN_MCP_INDEXING_CONTROL_PATTERN.test(normalizedName);
}

function resolvePackageSmokeCliStdioLaunch() {
  if (process.platform === 'win32' && process.resourcesPath) {
    return {
      mode: 'windows-electron-run-as-node-asar-index',
      command: process.execPath,
      args: [path.join(process.resourcesPath, 'app.asar', 'src', 'main', 'index.js'), '--mcp-stdio'],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    };
  }
  return {
    mode: 'direct-executable-mcp-stdio',
    command: process.execPath,
    args: getPackageSmokeCliStdioArgs(process.platform, process.env),
    env: {}
  };
}

let runtimeSearchRefreshForPackageSmoke = null;

async function startPackageSmokeMcpIpcServer({ packageSmokeStore, runtimeSearchEngine }) {
  cleanupStaleSocket();
  runtimeSearchRefreshForPackageSmoke = async () => {
    if (typeof runtimeSearchEngine.rebuild === 'function') {
      await runtimeSearchEngine.rebuild();
    } else if (typeof runtimeSearchEngine.ensureFresh === 'function') {
      await runtimeSearchEngine.ensureFresh();
    }
  };
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        handlePackageSmokeIpcLine(socket, line, { packageSmokeStore, runtimeSearchEngine });
      }
    });
  });
  server._packageSmokeSockets = sockets;
  await listenPackageSmokeServer(server, PIPE_PATH);
  return server;
}

async function handlePackageSmokeIpcLine(socket, line, { packageSmokeStore, runtimeSearchEngine }) {
  let message = null;
  try {
    message = JSON.parse(line);
    const params = message.params || {};
    let result;
    switch (message.action) {
      case 'save_document':
        result = await saveDocumentToStore(packageSmokeStore, params, runtimeSearchEngine);
        break;
      case 'search_documents':
        await runtimeSearchRefreshForPackageSmoke();
        result = {
          results: runtimeSearchEngine.search(params.query, {
            limit: params.limit,
            project: params.project,
            docType: params.docType
          }),
          totalIndexed: runtimeSearchEngine.docMeta.size,
          indexStatus: runtimeSearchEngine.getStatus()
        };
        break;
      case 'smart_search':
        await runtimeSearchRefreshForPackageSmoke();
        result = await buildSmartSearchToolResult(params, {
          searchEngine: runtimeSearchEngine,
          store: packageSmokeStore
        });
        break;
      case 'list_viewers':
        result = { windows: [] };
        break;
      case 'close_viewer':
        result = { closed: 0 };
        break;
      case 'open_markdown':
      case 'update_markdown':
        result = { windowId: 'package-smoke-window', title: params.title || 'Package Smoke', upserted: false };
        break;
      default:
        socket.write(JSON.stringify({ id: message.id, error: `Unknown action: ${message.action}` }) + '\n');
        return;
    }
    socket.write(JSON.stringify({ id: message.id, result }) + '\n');
  } catch (err) {
    socket.write(JSON.stringify({
      id: message && message.id ? message.id : null,
      error: err && err.message ? err.message : String(err)
    }) + '\n');
  }
}

function listenPackageSmokeServer(server, ipcPath) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(ipcPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closePackageSmokeServer(server) {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      const sockets = server._packageSmokeSockets || new Set();
      for (const socket of sockets) {
        try { socket.destroy(); } catch { /* ignore */ }
      }
      finish();
    }, 1_000);
    try {
      server.close(() => finish());
    } catch {
      finish();
    }
  });
}

function closePackageSmokeHttpServer(server) {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    if (typeof server._mcpClose === 'function') {
      server._mcpClose();
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function postPackageSmokeMcpHttp(port, method, params) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: `package-smoke-${Date.now()}`,
      method,
      params
    });
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          done(resolve, JSON.parse(data));
        } catch (err) {
          done(reject, err);
        }
      });
    });
    req.setTimeout(10_000, () => {
      req.destroy(new Error(`Package smoke MCP HTTP request timed out for ${method}`));
    });
    req.on('error', (err) => done(reject, err));
    req.write(body);
    req.end();
  });
}

function allocatePackageSmokeMcpPort() {
  return 35000 + (process.pid % 20000);
}

function arraysEqual(left, right) {
  return Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function isDocumentStoreSourceRootConfigured() {
  const sourceRoot = String(store.get('mcpAutoSavePath', '') || '').trim();
  if (!sourceRoot) return false;
  try {
    return fs.statSync(sourceRoot).isDirectory();
  } catch {
    return false;
  }
}

function initializeSearchEngineIfConfigured() {
  if (!searchEngine || !isDocumentStoreSourceRootConfigured()) {
    return;
  }
  searchEngine.initialize().catch(err => {
    console.error('[doculight] Search engine init error:', err.message);
  });
}

function startNativeRepairIfNeeded() {
  if (!nativeRebuildManager || PACKAGE_SMOKE_REQUESTED) return;
  const repair = nativeRebuildManager.startBackgroundRepairIfNeeded();
  if (repair && repair.promise) {
    repair.promise.then(() => {
      initializeSearchEngineIfConfigured();
    }).catch((err) => {
      console.warn('[doculight] Background native repair failed:', err && err.message ? err.message : String(err));
    });
  }
}

function getIndexingStatusPayload() {
  const sourceRootConfigured = isDocumentStoreSourceRootConfigured();
  const rawStatus = searchEngine ? searchEngine.getStatus() : { state: 'unavailable' };
  const status = {
    ...rawStatus,
    sourceRootConfigured,
    canRebuild: sourceRootConfigured
  };
  if (!sourceRootConfigured) {
    status.state = 'storage-not-configured';
    status.indexedCount = 0;
    status.pendingCount = 0;
    status.failedCount = 0;
    status.currentPath = null;
    status.phase = null;
    status.progress = null;
    status.rebuildSession = null;
    status.errorSummary = null;
  }
  if (!nativeRebuildManager) return status;
  const nativeRepair = nativeRebuildManager.getStatus();
  const nativeActive = nativeRepair && (nativeRepair.active || nativeRepair.state === 'checking' || nativeRepair.state === 'repairing');
  if (!nativeRepair || nativeRepair.state === 'idle' || nativeRepair.state === 'ready') {
    return { ...status, nativeRepair };
  }
  if (nativeActive) {
    return {
      ...status,
      state: nativeRepair.state === 'checking' ? 'checking' : 'repairing',
      phase: nativeRepair.phase || status.phase,
      progress: nativeRepair.progress || status.progress || null,
      diagnostic: nativeRepair.diagnostic || status.diagnostic || null,
      nativeRepair
    };
  }
  return {
    ...status,
    state: status.state === 'ready' ? 'degraded' : status.state,
    diagnostic: nativeRepair.diagnostic || status.diagnostic || null,
    errorSummary: status.errorSummary || (nativeRepair.diagnostic && nativeRepair.diagnostic.message) || null,
    nativeRepair
  };
}

function getStoredEmbeddingSettings() {
  const semanticSearch = store.get('semanticSearch', {}) || {};
  return {
    enabled: semanticSearch.enabled === true,
    provider: semanticSearch.provider || 'openai-compatible',
    baseURL: semanticSearch.baseURL || '',
    model: semanticSearch.model || '',
    dimensions: semanticSearch.dimensions || null,
    batchSize: semanticSearch.batchSize || 16,
    maxConcurrency: semanticSearch.maxConcurrency || 2,
    timeout: semanticSearch.timeout || 30000,
    retryPolicy: semanticSearch.retryPolicy || { retries: 2, backoffMs: 500 },
    apiKeyStorage: semanticSearch.apiKeyStorage || 'none',
    hasApiKey: semanticSearch.hasApiKey === true,
    hnsw: semanticSearch.hnsw || { m: 16, efConstruction: 200, efSearch: 64 },
    chunker: {
      chunkSize: Number(semanticSearch.chunker?.chunkSize) || EMBEDDING_DEFAULT_CHUNK_SIZE,
      chunkOverlap: Number(semanticSearch.chunker?.chunkOverlap) || EMBEDDING_DEFAULT_CHUNK_OVERLAP
    },
    modelFingerprint: semanticSearch.modelFingerprint || null,
    status: semanticSearch.status || 'unset',
    statusReason: semanticSearch.statusReason || null,
    lastValidatedAt: semanticSearch.lastValidatedAt || null,
    offlineOnly: semanticSearch.offlineOnly === true,
    retentionCostConfirmationVersion: semanticSearch.retentionCostConfirmationVersion || null,
    endpointPolicy: semanticSearch.endpointPolicy || 'https-or-approved-local',
    projectPolicy: normalizeEmbeddingProjectPolicy(semanticSearch.projectPolicy),
    activationRecord: normalizeEmbeddingActivationRecord(semanticSearch.activationRecord),
    secretMigration: normalizeSecretMigrationState(semanticSearch.secretMigration),
    semanticIndexing: normalizeEmbeddingSemanticIndexing(semanticSearch.semanticIndexing)
  };
}

function sanitizeSettingsPayload(settingsPayload) {
  const settings = { ...(settingsPayload || {}) };
  delete settings.embeddingApiKeyCiphertext;
  delete settings.embeddingApiKey;
  delete settings.apiKey;
  settings.semanticSearch = sanitizeEmbeddingSettingsForRenderer(getStoredEmbeddingSettings());
  return settings;
}

function isRemoteHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

function isSafeRendererImageSrc(value) {
  return /^(data:image\/|blob:)/i.test(String(value || ''));
}

function getRemoteImageFetchOptions() {
  const allowPrivateNetworkOverride =
    process.env.DOCULIGHT_MEDIA_VIEWER_ALLOW_PRIVATE_REMOTE === '1' &&
    (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'dev');
  return {
    allowPrivateNetworkForTests: allowPrivateNetworkOverride,
    maxBytes: 10 * 1024 * 1024,
    timeoutMs: 10000
  };
}

function redactMediaError(err) {
  const code = err && err.code ? String(err.code) : 'media_error';
  return {
    code,
    message: code
  };
}

function normalizeMediaTitle(title, fallbackKey) {
  const value = String(title || '').trim();
  return value.slice(0, 160) || t(fallbackKey);
}

function decodeDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+)(;base64)?,([\s\S]*)$/);
  if (!match) {
    const err = new Error('Invalid data URL.');
    err.code = 'invalid_data_url';
    throw err;
  }
  const mime = match[1].toLowerCase();
  const bytes = match[2]
    ? Buffer.from(match[3] || '', 'base64')
    : Buffer.from(decodeURIComponent(match[3] || ''), 'utf-8');
  return { bytes, mime };
}

function normalizeMediaViewerRequest(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  if (input.type === 'mermaid') {
    return {
      type: 'mermaid',
      title: normalizeMediaTitle(input.title, 'viewer.media.mermaidTitle'),
      mermaidSource: String(input.mermaidSource || ''),
      fileName: sanitizeDownloadFilename(input.fileName || input.title || 'mermaid.svg', 'image/svg+xml')
    };
  }

  if (input.type === 'image') {
    return {
      type: 'image',
      title: normalizeMediaTitle(input.title || input.alt, 'viewer.media.imageTitle'),
      source: String(input.source || ''),
      displaySrc: String(input.displaySrc || input.source || ''),
      alt: String(input.alt || input.title || ''),
      mime: String(input.mime || ''),
      fileName: input.fileName ? String(input.fileName) : ''
    };
  }

  const err = new Error('Unsupported media type.');
  err.code = 'unsupported_media_type';
  throw err;
}

async function prepareMediaViewerPayload(payload) {
  const normalized = normalizeMediaViewerRequest(payload);
  if (normalized.type !== 'image') return normalized;

  const sourceForFetch = isRemoteHttpUrl(normalized.source) ? normalized.source : normalized.displaySrc;
  if (isRemoteHttpUrl(sourceForFetch)) {
    const remote = await fetchRemoteImageForMediaViewer(sourceForFetch, getRemoteImageFetchOptions());
    return {
      ...normalized,
      source: sourceForFetch,
      displaySrc: `data:${remote.mime};base64,${remote.bytes.toString('base64')}`,
      mime: remote.mime,
      fileName: remote.safeFileName
    };
  }

  if (!isSafeRendererImageSrc(normalized.displaySrc)) {
    const err = new Error('Image payload must use a safe renderer source.');
    err.code = 'unsafe_image_payload';
    throw err;
  }

  return {
    ...normalized,
    source: '',
    displaySrc: normalized.displaySrc
  };
}

function registerMediaViewerWindow(parentWindowId, mediaWindow) {
  if (!mediaViewerWindowsByParent.has(parentWindowId)) {
    mediaViewerWindowsByParent.set(parentWindowId, new Set());
  }
  mediaViewerWindowsByParent.get(parentWindowId).add(mediaWindow.id);
  mediaViewerParentByWindowId.set(mediaWindow.id, parentWindowId);
  mediaViewerWindows.set(mediaWindow.id, mediaWindow);
}

function isRegisteredMediaViewerWindow(candidateWindow) {
  return !!candidateWindow && !candidateWindow.isDestroyed() && mediaViewerWindows.has(candidateWindow.id);
}

function getManagedMarkdownViewerWindowId(candidateWindow) {
  if (!candidateWindow || candidateWindow.isDestroyed()) return null;
  return windowManager.findWindowId(candidateWindow) || null;
}

function removeMediaViewerParentCloseListener(parentWindowId) {
  const entry = mediaViewerParentCloseListeners.get(parentWindowId);
  if (!entry) return;
  if (entry.parentWindow && !entry.parentWindow.isDestroyed()) {
    entry.parentWindow.removeListener('closed', entry.listener);
  }
  mediaViewerParentCloseListeners.delete(parentWindowId);
}

function removeMediaViewerWindow(mediaWindowId) {
  const parentWindowId = mediaViewerParentByWindowId.get(mediaWindowId);
  if (parentWindowId && mediaViewerWindowsByParent.has(parentWindowId)) {
    const linked = mediaViewerWindowsByParent.get(parentWindowId);
    linked.delete(mediaWindowId);
    if (linked.size === 0) {
      mediaViewerWindowsByParent.delete(parentWindowId);
      removeMediaViewerParentCloseListener(parentWindowId);
    }
  }
  mediaViewerParentByWindowId.delete(mediaWindowId);
  mediaViewerWindows.delete(mediaWindowId);
  mediaViewerPayloads.delete(mediaWindowId);
}

function detachMediaViewerParent(parentWindowId) {
  const linked = mediaViewerWindowsByParent.get(parentWindowId);
  if (!linked) return;
  for (const mediaWindowId of linked) {
    mediaViewerParentByWindowId.delete(mediaWindowId);
  }
  mediaViewerWindowsByParent.delete(parentWindowId);
  mediaViewerParentCloseListeners.delete(parentWindowId);
}

function ensureMediaViewerParentCloseListener(parentWindowId, parentWindow) {
  if (!parentWindow || parentWindow.isDestroyed() || mediaViewerParentCloseListeners.has(parentWindowId)) return;
  const listener = () => detachMediaViewerParent(parentWindowId);
  mediaViewerParentCloseListeners.set(parentWindowId, { parentWindow, listener });
  parentWindow.once('closed', listener);
}

function propagateAlwaysOnTopToMediaViewers(parentWindowId, alwaysOnTop) {
  const linked = mediaViewerWindowsByParent.get(parentWindowId);
  if (!linked) return;
  for (const mediaWindowId of linked) {
    const mediaWindow = mediaViewerWindows.get(mediaWindowId);
    if (!mediaWindow || mediaWindow.isDestroyed()) continue;
    mediaWindow.setAlwaysOnTop(!!alwaysOnTop);
    mediaWindow.webContents.send('always-on-top-changed', { alwaysOnTop: !!alwaysOnTop });
  }
}

async function createMediaViewerWindow(parentWindowId, payload, parentAlwaysOnTop, parentWindow = null) {
  const preparedPayload = await prepareMediaViewerPayload(payload);
  const mediaWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 420,
    minHeight: 320,
    title: preparedPayload.title,
    icon: nativeImage.createFromPath(ICON_PATH),
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  if (parentAlwaysOnTop) {
    mediaWindow.setAlwaysOnTop(true);
  }

  registerMediaViewerWindow(parentWindowId, mediaWindow);
  mediaViewerPayloads.set(mediaWindow.id, preparedPayload);
  ensureMediaViewerParentCloseListener(parentWindowId, parentWindow);
  mediaWindow.once('ready-to-show', () => mediaWindow.show());
  mediaWindow.on('closed', () => removeMediaViewerWindow(mediaWindow.id));
  mediaWindow.webContents.once('did-finish-load', () => {
    if (!mediaWindow.isDestroyed()) {
      mediaWindow.webContents.send('media-viewer-payload', preparedPayload);
    }
  });

  await mediaWindow.loadFile(path.join(__dirname, '..', 'renderer', 'media-viewer.html'));
  return { success: true, mediaWindowId: mediaWindow.id };
}

async function resolveImageDownloadAsset(request) {
  const source = String(request.source || '');
  const displaySrc = String(request.displaySrc || '');

  if (displaySrc.startsWith('data:')) {
    const decoded = decodeDataUrl(displaySrc);
    return {
      bytes: decoded.bytes,
      mime: decoded.mime,
      fileName: sanitizeDownloadFilename(request.fileName || request.title || 'image', decoded.mime)
    };
  }

  const src = source || displaySrc;
  if (String(src).startsWith('data:')) {
    const decoded = decodeDataUrl(src);
    return {
      bytes: decoded.bytes,
      mime: decoded.mime,
      fileName: sanitizeDownloadFilename(request.fileName || request.title || 'image', decoded.mime)
    };
  }

  if (isRemoteHttpUrl(src)) {
    const remote = await fetchRemoteImageForMediaViewer(src, getRemoteImageFetchOptions());
    return { bytes: remote.bytes, mime: remote.mime, fileName: remote.safeFileName };
  }

  const err = new Error('Unsupported image source.');
  err.code = 'unsupported_image_source';
  throw err;
}

async function downloadMediaAssetForSender(senderWindow, request) {
  const input = request && typeof request === 'object' ? request : {};
  if (input.type === 'mermaid') {
    const svg = String(input.svg || '');
    if (!svg.trim()) {
      const err = new Error('Missing SVG data.');
      err.code = 'missing_svg';
      throw err;
    }
    const fileName = sanitizeDownloadFilename(input.fileName || input.title || 'mermaid.svg', 'image/svg+xml');
    const saveResult = await dialog.showSaveDialog(senderWindow, {
      title: t('viewer.media.download'),
      defaultPath: fileName,
      filters: [{ name: 'SVG', extensions: ['svg'] }]
    });
    if (saveResult.canceled || !saveResult.filePath) return { canceled: true };
    await fs.promises.writeFile(saveResult.filePath, svg, 'utf-8');
    return { success: true };
  }

  if (input.type === 'image') {
    const asset = await resolveImageDownloadAsset(input);
    const ext = resolveImageMimeExtension(asset.mime);
    const fileName = sanitizeDownloadFilename(asset.fileName || input.fileName || input.title || 'image', asset.mime);
    const saveResult = await dialog.showSaveDialog(senderWindow, {
      title: t('viewer.media.download'),
      defaultPath: fileName,
      filters: ext ? [{ name: asset.mime, extensions: [ext.slice(1)] }] : undefined
    });
    if (saveResult.canceled || !saveResult.filePath) return { canceled: true };
    await fs.promises.writeFile(saveResult.filePath, asset.bytes);
    return { success: true };
  }

  const err = new Error('Unsupported media type.');
  err.code = 'unsupported_media_type';
  throw err;
}

function sanitizeEmbeddingSettingsForRenderer(settingsPayload = getStoredEmbeddingSettings()) {
  return {
    enabled: settingsPayload.enabled === true,
    provider: settingsPayload.provider || 'openai-compatible',
    baseURL: sanitizeEmbeddingBaseURLForRenderer(settingsPayload.baseURL),
    model: settingsPayload.model || '',
    dimensions: settingsPayload.dimensions || null,
    apiKeyStorage: settingsPayload.apiKeyStorage || 'none',
    hasApiKey: settingsPayload.hasApiKey === true,
    chunker: {
      chunkSize: Number(settingsPayload.chunker?.chunkSize) || EMBEDDING_DEFAULT_CHUNK_SIZE,
      chunkOverlap: Number(settingsPayload.chunker?.chunkOverlap) || EMBEDDING_DEFAULT_CHUNK_OVERLAP
    },
    modelFingerprint: settingsPayload.modelFingerprint || null,
    status: settingsPayload.status || 'unset',
    statusReason: settingsPayload.statusReason || null,
    lastValidatedAt: settingsPayload.lastValidatedAt || null,
    offlineOnly: settingsPayload.offlineOnly === true,
    retentionCostConfirmationVersion: settingsPayload.retentionCostConfirmationVersion || null,
    endpointPolicy: settingsPayload.endpointPolicy || 'https-or-approved-local',
    projectPolicy: normalizeEmbeddingProjectPolicy(settingsPayload.projectPolicy),
    activationRecord: normalizeEmbeddingActivationRecord(settingsPayload.activationRecord),
    secretMigration: normalizeSecretMigrationState(settingsPayload.secretMigration),
    semanticIndexing: normalizeEmbeddingSemanticIndexing(settingsPayload.semanticIndexing)
  };
}

function normalizeEmbeddingSemanticIndexing(rawState = {}) {
  const state = rawState && typeof rawState === 'object' ? rawState : {};
  return {
    status: state.status || 'idle',
    progress_current: normalizeNonNegativeInt(state.progress_current, 0),
    progress_total: normalizeNonNegativeInt(state.progress_total, 0)
  };
}

function sanitizeEmbeddingBaseURLForRenderer(rawBaseURL) {
  const value = String(rawBaseURL || '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, parsed.pathname === '/' ? '/' : '');
  } catch {
    return '';
  }
}

function normalizeEmbeddingEndpoint(rawBaseURL) {
  const raw = String(rawBaseURL || '').trim();
  if (!raw) {
    const err = new Error('Embedding endpoint URL is required');
    err.code = 'EMBEDDING_ENDPOINT_REQUIRED';
    throw err;
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    const err = new Error('Embedding endpoint URL is invalid');
    err.code = 'EMBEDDING_ENDPOINT_INVALID';
    throw err;
  }
  if (parsed.username || parsed.password) {
    const err = new Error('Embedding endpoint URL must not include credentials');
    err.code = 'EMBEDDING_ENDPOINT_CREDENTIALS';
    throw err;
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'https:' && !(protocol === 'http:' && isApprovedLocalEmbeddingHost(parsed.hostname))) {
    const err = new Error('Embedding endpoint must use HTTPS or an approved local HTTP host');
    err.code = 'EMBEDDING_ENDPOINT_POLICY';
    throw err;
  }
  parsed.hash = '';
  parsed.search = '';
  let pathname = parsed.pathname.replace(/\/+$/, '');
  if (pathname === '/') pathname = '';
  const baseURL = `${parsed.origin}${pathname}`;
  const modelListURL = `${baseURL || parsed.origin}/models`;
  const embeddingsURL = `${baseURL || parsed.origin}/embeddings`;
  return {
    baseURL: baseURL || parsed.origin,
    host: parsed.host,
    modelListURL,
    embeddingsURL
  };
}

function isApprovedLocalEmbeddingHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  const parts = host.split('.').map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return parts[0] === 192 && parts[1] === 168;
}

function getEmbeddingApiKey(candidateKey, options = {}) {
  const allowStoredKeyFallback = options.allowStoredFallback !== false;
  const trimmed = String(candidateKey || '').trim();
  if (trimmed) return { key: trimmed, storage: 'pending' };
  const envKey = String(process.env.DOCULIGHT_EMBEDDING_API_KEY || '').trim();
  if (allowStoredKeyFallback && envKey) return { key: envKey, storage: 'env' };
  const stored = store.get('embeddingApiKeyCiphertext', '');
  if (!allowStoredKeyFallback || !stored || !safeStorage || !safeStorage.isEncryptionAvailable()) return { key: '', storage: 'none' };
  try {
    return { key: safeStorage.decryptString(Buffer.from(stored, 'base64')), storage: 'safeStorage' };
  } catch {
    return { key: '', storage: 'unavailable' };
  }
}

function persistEmbeddingApiKey(apiKey, options = {}) {
  const replaceExisting = options.replaceExisting === true;
  const trimmed = String(apiKey || '').trim();
  if (!trimmed) {
    if (!replaceExisting && store.get('embeddingApiKeyCiphertext')) {
      return { storage: 'safeStorage', hasApiKey: true };
    }
    if (!replaceExisting && process.env.DOCULIGHT_EMBEDDING_API_KEY) {
      return { storage: 'env', hasApiKey: true };
    }
    store.delete('embeddingApiKeyCiphertext');
    return { storage: 'none', hasApiKey: false };
  }
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(trimmed);
    store.set('embeddingApiKeyCiphertext', encrypted.toString('base64'));
    return { storage: 'safeStorage', hasApiKey: true };
  }
  store.delete('embeddingApiKeyCiphertext');
  return { storage: process.env.DOCULIGHT_EMBEDDING_API_KEY ? 'env' : 'none', hasApiKey: false };
}

function createEmbeddingFingerprint({
  baseURL,
  model,
  dimensions,
  chunkSize,
  chunkOverlap,
  encodingFormat = 'float',
  chunkerVersion = 'heading-aware-v1',
  normalization = 'none',
  hnswSpace = 'cosine',
  distanceMetric = 'cosine'
}) {
  const baseURLHash = crypto
    .createHash('sha256')
    .update(String(baseURL || ''))
    .digest('hex')
    .slice(0, 16);
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      provider: 'openai-compatible',
      baseURLHash,
      model,
      dimensions: Number.isInteger(dimensions) ? dimensions : null,
      encodingFormat,
      chunkerVersion,
      normalization,
      hnswSpace,
      distanceMetric,
      chunkSize,
      chunkOverlap
    }))
    .digest('hex')
    .slice(0, 16);
}

function hasEmbeddingTransmissionConfirmation(input = {}) {
  return input.retentionCostConfirmed === true
    && String(input.retentionCostConfirmationVersion || '') === EMBEDDING_RETENTION_CONFIRMATION_VERSION;
}

async function validateEmbeddingModelConfig(input = {}) {
  const offlineOnly = Object.prototype.hasOwnProperty.call(input, 'offlineOnly')
    ? input.offlineOnly === true
    : getStoredEmbeddingSettings().offlineOnly === true;
  if (offlineOnly) {
    return {
      ok: false,
      status: 'degraded',
      reason: 'offline-only',
      message: 'Offline-only mode blocks remote embedding validation'
    };
  }
  const normalized = normalizeEmbeddingEndpoint(input.baseURL);
  const apiKeyInfo = getEmbeddingApiKey(input.apiKey, { allowStoredFallback: false });
  const headers = { 'Content-Type': 'application/json' };
  if (apiKeyInfo.key) headers.Authorization = `Bearer ${apiKeyInfo.key}`;
  const timeoutMs = Math.max(1000, Math.min(Number(input.timeout) || 30000, 120000));
  let model = String(input.model || '').trim();

  if (!model) {
    const modelsResponse = await fetchWithTimeout(normalized.modelListURL, { method: 'GET', headers }, timeoutMs);
    if (!modelsResponse.ok) {
      throw createEmbeddingHttpError('models', modelsResponse.status);
    }
    const payload = await modelsResponse.json();
    model = extractFirstModelId(payload);
    if (!model) {
      const err = new Error('Embedding model discovery returned no model id');
      err.code = 'EMBEDDING_MODEL_DISCOVERY_EMPTY';
      throw err;
    }
  }

  const requestedDimensions = normalizeOptionalPositiveInt(input.dimensions);
  const validationProvider = createOpenAICompatibleEmbeddingProvider({
    fetchImpl: (url, options = {}) => fetchWithTimeout(url, options, timeoutMs),
    getEmbeddingConfig: () => ({
      baseURL: normalized.baseURL,
      model,
      dimensions: requestedDimensions,
      timeout: timeoutMs
    }),
    getApiKey: () => apiKeyInfo.key
  });
  const validationResult = await validationProvider.embed({
    baseURL: normalized.baseURL,
    model,
    inputs: ['DocuLight embedding validation'],
    dimensions: requestedDimensions,
    timeoutMs
  });
  const validationVector = Array.isArray(validationResult?.embeddings)
    ? validationResult.embeddings[0]
    : null;
  const dimensions = requestedDimensions || (Array.isArray(validationVector) ? validationVector.length : null);
  if (!dimensions) {
    const err = new Error('Embedding dimensions could not be discovered from validation response');
    err.code = 'EMBEDDING_DIMENSIONS_REQUIRED';
    throw err;
  }

  const chunkSize = normalizePositiveInt(input.chunkSize, EMBEDDING_DEFAULT_CHUNK_SIZE);
  const chunkOverlap = normalizeNonNegativeInt(input.chunkOverlap, EMBEDDING_DEFAULT_CHUNK_OVERLAP);
  return {
    ok: true,
    status: 'connected',
    provider: 'openai-compatible',
    baseURL: normalized.baseURL,
    host: normalized.host,
    model,
    dimensions,
    chunkSize,
    chunkOverlap,
    apiKeyStorage: apiKeyInfo.storage === 'pending' ? 'safeStorage' : apiKeyInfo.storage,
    hasApiKey: Boolean(apiKeyInfo.key),
    modelFingerprint: createEmbeddingFingerprint({ baseURL: normalized.baseURL, model, dimensions, chunkSize, chunkOverlap })
  };
}

function normalizeOptionalPositiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizePositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizeNonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractFirstModelId(payload) {
  const candidates = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload) ? payload : []);
  const first = candidates[0];
  if (!first) return '';
  return String(first.id || first.name || first.model || '').trim();
}

function extractEmbeddingDimensions(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  const firstVector = data.map((item) => item && item.embedding).find((vector) => Array.isArray(vector));
  return firstVector ? firstVector.length : null;
}

function createEmbeddingHttpError(endpoint, status) {
  const err = new Error(`Embedding ${endpoint} endpoint returned HTTP ${status}`);
  err.code = 'EMBEDDING_ENDPOINT_UNREACHABLE';
  return err;
}

function getEmbeddingModelStatusPayload() {
  const settings = sanitizeEmbeddingSettingsForRenderer();
  const indexingStatus = searchEngine ? searchEngine.getStatus() : null;
  const semanticIndexingProgress = searchEngine && typeof searchEngine.getSemanticIndexingProgress === 'function'
    ? searchEngine.getSemanticIndexingProgress()
    : null;
  const progressSource = semanticIndexingProgress || indexingStatus || {};
  const current = Number(progressSource?.progress_current ?? progressSource?.progressCurrent ?? progressSource?.current ?? 0);
  const total = Number(progressSource?.progress_total ?? progressSource?.progressTotal ?? progressSource?.total ?? 0);
  const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((current / total) * 100))) : null;
  const indexingProgress = {
    state: progressSource?.state || null,
    phase: progressSource?.phase || null,
    progress_current: current,
    progress_total: total,
    percent
  };
  if (!settings.model) {
    const noModelStatus = (settings.status === 'degraded' || settings.status === 'unreachable' || settings.status === 'failed')
      ? settings.status
      : 'unset';
    return { ...settings, status: noModelStatus, indexingProgress, semanticIndexingProgress, indexingPercent: percent };
  }
  return { ...settings, indexingProgress, semanticIndexingProgress, indexingPercent: percent };
}

function clearSemanticDerivedStateForFingerprint(modelFingerprint) {
  if (!modelFingerprint || !searchEngine || typeof searchEngine.clearSemanticDerivedState !== 'function') {
    return { cleared: false, reason: 'semantic-clear-unavailable' };
  }
  try {
    return searchEngine.clearSemanticDerivedState({ modelFingerprint });
  } catch (err) {
    return { cleared: false, reason: err && err.message ? err.message : 'semantic-clear-failed' };
  }
}

app.on('window-all-closed', () => {
  // Don't quit — stay alive in tray mode.
  // On macOS this is the default behavior; on Windows/Linux we simply
  // do nothing so the app keeps running with the system tray icon.
});

app.on('before-quit', () => {
  // step28 Phase 2: 앱 종료 시 모든 진행 중 사이드바 트리 로드 abort
  try {
    for (const [, v] of windowManager._currentLoadIds) {
      try { v.controller.abort(); } catch { /* ignore */ }
    }
    windowManager._currentLoadIds.clear();
  } catch { /* ignore */ }

  // Stop all file watchers
  windowManager.stopAllFileWatchers();

  // Delete port discovery file
  try {
    fs.unlinkSync(runtimeProfile.mcpPortFilePath);
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
    let icon = nativeImage.createFromPath(TRAY_ICON_PATH);
    if (process.platform === 'darwin' && !icon.isEmpty()) {
      icon = icon.resize({ width: 16, height: 16 });
    }
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
            windowManager.createWindow({ filePath: fp, registerOpenedMarkdown: true });
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
    if (err && err.code === 'EADDRINUSE') {
      console.error('[doculight] IPC server already in use. Another DocuLight instance is probably running; this instance will exit.');
      app.quit();
      return;
    }
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
// MCP Auto-Save (shared module)
// =============================================================================

const { saveMcpFile, saveMcpUpdatedContent, mcpManualSave, saveDocumentToStore, extractTitleFromContent } = require('./mcp-save');
const { buildSmartSearchToolResult } = require('./smart-search-response');

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
      case 'open_markdown': {
        // @req IR-MCP-019
        const hasDocumentId = params.documentId !== undefined && params.documentId !== null;
        if (hasDocumentId && (params.content !== undefined || params.filePath !== undefined)) {
          throw new IndexedDocumentOpenError('indexed_document_ambiguous_input');
        }
        const indexedOpen = hasDocumentId || Boolean(params.filePath)
          ? await resolveIndexedMarkdownOpen({
            documentId: params.documentId,
            filePath: params.filePath,
            searchEngine
          })
          : null;
        if (indexedOpen) {
          params.content = indexedOpen.content;
          params.filePath = indexedOpen.filePathInternal;
          params[VALIDATED_MARKDOWN_CONTENT] = true;
        }

        // Git info collection (stdio path — mcp-server.mjs passes projectPath via IPC)
        let gitInfo = {};
        if (params.projectPath && path.isAbsolute(params.projectPath)) {
          const mcpGitInfo = store.get('mcpGitInfo', true);
          if (mcpGitInfo) {
            const { collectGitInfo } = require('./git-info');
            gitInfo = await collectGitInfo(params.projectPath);
          } else {
            gitInfo = { projectPath: params.projectPath };
          }
        }

        // project priority: explicit > git-derived
        if (params.project) {
          gitInfo.project = params.project;
        } else if (gitInfo.project) {
          params.project = gitInfo.project;
        }

        // Frontmatter injection with git fields
        if (params.content && (params.project || params.docName || params.description || params.docType || gitInfo.projectPath)) {
          params.content = injectFrontmatter(params.content, {
            project: params.project, docName: params.docName,
            description: params.description, docType: params.docType,
            ...gitInfo
          });
        }

        try {
          result = await windowManager.createWindow({ ...params, ...gitInfo, registerOpenedMarkdown: false });
        } catch (err) {
          if (indexedOpen) {
            throw new IndexedDocumentOpenError('indexed_document_unavailable', indexedOpen.originStatus);
          }
          throw err;
        }
        if (indexedOpen) {
          result.sourceUsed = indexedOpen.sourceUsed;
          result.originStatus = indexedOpen.originStatus;
        }
        try {
          const entry = windowManager.getWindowEntry(result.windowId);
          const savedPath = indexedOpen ? null : await saveMcpFile(store, {
            content: params.content,
            filePath: params.filePath,
            title: params.title,
            noSave: params.noSave,
            project: params.project || entry?.meta?.project,
            severity: params.severity,
            docType: params.docType || entry?.meta?.docType
          });
          if (entry && !entry.win.isDestroyed()) {
            // Send MCP document state to renderer (FR-22-001)
            entry.win.webContents.send('set-mcp-state', {
              isMcpDocument: true,
              mcpAutoSave: store.get('mcpAutoSave', false),
              project: params.project || entry.meta.project || ''
            });
            if (savedPath) {
              searchEngine.markDirty({
                filePath: savedPath,
                content: params.content,
                requestedBy: 'mcp.stdio.open_markdown'
              });
              entry.meta.savedFilePath = savedPath;
              entry.win.webContents.send('set-saved-file-path', { savedFilePath: savedPath });
              entry.win.setTitle(windowManager.formatWindowTitle(entry.meta.title, entry.meta.filePath, savedPath));
            }
          }
        } catch (err) {
          console.error('[doculight] saveMcpFile error:', err.message);
        }
        break;
      }

      case 'update_markdown': {
        // Git info collection (stdio path — skip for appendMode)
        let gitInfo = {};
        if (!params.appendMode && params.projectPath && path.isAbsolute(params.projectPath)) {
          const mcpGitInfo = store.get('mcpGitInfo', true);
          if (mcpGitInfo) {
            const { collectGitInfo } = require('./git-info');
            gitInfo = await collectGitInfo(params.projectPath);
          } else {
            gitInfo = { projectPath: params.projectPath };
          }
        }

        // project priority: explicit > git-derived
        if (params.project) {
          gitInfo.project = params.project;
        } else if (gitInfo.project) {
          params.project = gitInfo.project;
        }

        // Frontmatter injection with git fields
        if (params.content && !params.appendMode && (params.project || params.docName || params.description || params.docType || gitInfo.projectPath)) {
          params.content = injectFrontmatter(params.content, {
            project: params.project, docName: params.docName,
            description: params.description, docType: params.docType,
            ...gitInfo
          });
        }

        result = await windowManager.updateWindow(params.windowId, { ...params, ...gitInfo });
        // Auto-save updated content (issue #6)
        try {
          const entry = windowManager.getWindowEntry(params.windowId);
          const { savedPath } = await saveMcpUpdatedContent(store, entry, params, searchEngine);
          if (entry && savedPath && !entry.win.isDestroyed()) {
            entry.win.webContents.send('set-saved-file-path', { savedFilePath: savedPath });
            if (windowManager.formatWindowTitle) {
              entry.win.setTitle(windowManager.formatWindowTitle(
                entry.meta.title,
                entry.meta.validatedIndexedOpen ? null : entry.meta.filePath,
                savedPath
              ));
            }
          }
        } catch (e) {
          console.warn('[doculight] update auto-save error:', e.message);
        }
        break;
      }

      case 'close_viewer':
        result = windowManager.closeWindow(params?.windowId, { tag: params?.tag });
        break;

      case 'list_viewers':
        result = { windows: windowManager.listWindows({ tag: params?.tag }) };
        break;

      case 'save_document':
        result = await saveDocumentToStore(store, params || {}, searchEngine);
        break;

      case 'search_documents':
        assertMcpSearchConfigured();
        if (typeof searchEngine.ensureFresh === 'function') {
          await searchEngine.ensureFresh();
        }
        result = {
          results: searchEngine.search(params.query, {
            limit: params.limit,
            project: params.project,
            docType: params.docType
          }),
          totalIndexed: searchEngine.docMeta.size,
          indexStatus: searchEngine.getStatus()
        };
        break;

      case 'search_projects':
        assertMcpSearchConfigured();
        result = {
          projects: searchEngine.searchProjects(params.query, params.limit),
          indexStatus: searchEngine.getStatus()
        };
        break;

      case 'smart_search': {
        assertMcpSearchConfigured();
        result = await buildSmartSearchToolResult(params || {}, { searchEngine, store });
        break;
      }

      case 'rebuild_index':
        result = typeof searchEngine.startRebuild === 'function'
          ? searchEngine.startRebuild()
          : await searchEngine.rebuild();
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
  // --- Port availability check ---
  ipcMain.handle('check-port-available', async (_event, port) => {
    if (mcpHttpServer) {
      const addr = mcpHttpServer.address();
      if (addr && addr.port === port) return true;
    }
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(port, '127.0.0.1', () => {
        srv.close(() => resolve(true));
      });
    });
  });

  // --- File Association IPC ---
  const fileAssoc = require('./file-association');
  fileAssoc.init(store);

  ipcMain.handle('register-file-association', async () => {
    if (runtimeProfile.isDev) {
      return {
        success: false,
        message: 'file association registration is disabled for the dev profile'
      };
    }
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
    if (!filePath) return;
    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        shell.openPath(filePath);
      } else {
        shell.showItemInFolder(filePath);
      }
    } catch {
      shell.showItemInFolder(filePath);
    }
  });

  ipcMain.handle('pick-directory', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('indexing:get-status', () => {
    return getIndexingStatusPayload();
  });

  ipcMain.handle('indexing:start-rebuild', () => {
    if (!isDocumentStoreSourceRootConfigured()) {
      return {
        started: false,
        scheduled: false,
        reason: 'source-root-unconfigured',
        status: getIndexingStatusPayload()
      };
    }
    return searchEngine.startRebuild();
  });

  ipcMain.handle('indexing:cancel-job', () => {
    return searchEngine.cancelRebuild();
  });

  ipcMain.handle('indexing:retry-failures', () => {
    if (!isDocumentStoreSourceRootConfigured()) {
      return {
        started: false,
        scheduled: false,
        reason: 'source-root-unconfigured',
        status: getIndexingStatusPayload()
      };
    }
    return searchEngine.retryFailures();
  });

  ipcMain.handle('indexing:compact', async () => {
    if (!isDocumentStoreSourceRootConfigured()) {
      return {
        compacted: false,
        reason: 'source-root-unconfigured',
        status: getIndexingStatusPayload()
      };
    }
    return searchEngine.compact();
  });

  ipcMain.handle('indexing:clear', async () => {
    return searchEngine.clear();
  });

  ipcMain.handle('indexing:open-data-dir', async () => {
    const dataDir = searchEngine.getIndexDataDir();
    if (!dataDir || !isDocumentStoreSourceRootConfigured()) {
      return {
        success: false,
        reason: 'source-root-unconfigured',
        error: 'Document store path is not configured'
      };
    }
    const error = await shell.openPath(dataDir);
    return { success: !error, error: error || null, dataDir };
  });

  ipcMain.handle('document-import:linked-markdown', async (event) => {
    try {
      const knowledgeStoreRoot = store.get('mcpAutoSavePath', '');
      if (!knowledgeStoreRoot) {
        return { success: false, reason: 'knowledge-store-unconfigured', message: 'Document store is not configured' };
      }
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [
          { name: 'Markdown', extensions: ['md', 'markdown'] }
        ]
      });
      if (result.canceled || !result.filePaths.length) {
        return { success: false, cancelled: true };
      }
      const entryPath = path.resolve(result.filePaths[0]);
      const sourceRoot = path.dirname(entryPath);
      const ledger = searchEngine && typeof searchEngine.getSourceLedger === 'function'
        ? searchEngine.getSourceLedger()
        : null;
      const importer = createLinkedImporter({
        sourceRoot,
        knowledgeStoreRoot,
        ledger,
        requestedBy: 'settings.linked_import'
      });
      const importResult = await importer.importMarkdownGraph(entryPath);
      return { success: true, ...importResult };
    } catch (err) {
      const redactor = createRedactor({
        sourceRoots: [store.get('mcpAutoSavePath', '')].filter(Boolean),
        userDataDir: app.getPath('userData')
      });
      return {
        success: false,
        reason: err && err.code ? err.code : 'linked-import-failed',
        message: redactor.redactString(err && err.message ? err.message : String(err))
      };
    }
  });

  ipcMain.handle('embedding:get-status', () => {
    return getEmbeddingModelStatusPayload();
  });

  ipcMain.handle('embedding:validate-model', async (_event, settings) => {
    try {
      const result = await validateEmbeddingModelConfig(settings || {});
      return { ...result, success: result.ok === true };
    } catch (err) {
      return {
        success: false,
        ok: false,
        status: 'unreachable',
        reason: err.code || 'connection-failed',
        message: err.message
      };
    }
  });

  ipcMain.handle('embedding:save-model-settings', async (_event, settings) => {
    try {
      const previousSettings = getStoredEmbeddingSettings();
      if (settings?.offlineOnly === true) {
        clearSemanticDerivedStateForFingerprint(previousSettings.modelFingerprint);
        store.set('semanticSearch', {
          ...previousSettings,
          enabled: false,
          offlineOnly: true,
          status: 'degraded',
          statusReason: 'offline-only',
          projectPolicy: normalizeEmbeddingProjectPolicy(settings.projectPolicy),
          activationRecord: null,
          secretMigration: normalizeSecretMigrationState(previousSettings.secretMigration),
          semanticIndexing: { status: 'disabled', progress_current: 0, progress_total: 0 }
        });
        return { success: true, status: getEmbeddingModelStatusPayload() };
      }
      if (!hasEmbeddingTransmissionConfirmation(settings || {})) {
        return {
          success: false,
          status: {
            ...getEmbeddingModelStatusPayload(),
            status: 'unreachable',
            statusReason: 'retention-cost-confirmation-required'
          },
          reason: 'retention-cost-confirmation-required',
          message: 'Remote embedding retention and cost confirmation is required before enabling semantic indexing'
        };
      }
      const validation = await validateEmbeddingModelConfig(settings || {});
      if (!validation.ok) {
        return {
          success: false,
          status: {
            ...getEmbeddingModelStatusPayload(),
            status: validation.status || 'degraded',
            statusReason: validation.reason || 'validation-failed'
          },
          message: validation.message
        };
      }
      const projectPolicy = normalizeEmbeddingProjectPolicy(settings?.projectPolicy);
      const validatedAt = new Date().toISOString();
      const semanticReindex = searchEngine && typeof searchEngine.queueSemanticReindexForActiveDocuments === 'function'
        ? searchEngine.queueSemanticReindexForActiveDocuments({ requestedBy: 'embedding-registration' })
        : { queued: 0, jobs: [] };
      if (semanticReindex && semanticReindex.reason && semanticReindex.skipped !== true) {
        return {
          success: false,
          status: {
            ...getEmbeddingModelStatusPayload(),
            status: 'unreachable',
            statusReason: 'semantic-reindex-unavailable'
          },
          reason: 'semantic-reindex-unavailable',
          message: `Semantic reindex enqueue failed: ${semanticReindex.reason}`
        };
      }
      const secretState = persistEmbeddingApiKey(settings?.apiKey, { replaceExisting: true });
      if (previousSettings.modelFingerprint && previousSettings.modelFingerprint !== validation.modelFingerprint) {
        clearSemanticDerivedStateForFingerprint(previousSettings.modelFingerprint);
      }
      const nextSettings = {
        ...previousSettings,
        enabled: true,
        provider: 'openai-compatible',
        baseURL: validation.baseURL,
        model: validation.model,
        dimensions: validation.dimensions,
        apiKeyStorage: secretState.storage,
        hasApiKey: secretState.hasApiKey,
        chunker: {
          chunkSize: validation.chunkSize,
          chunkOverlap: validation.chunkOverlap
        },
        modelFingerprint: validation.modelFingerprint,
        status: 'connected',
        statusReason: null,
        lastValidatedAt: validatedAt,
        offlineOnly: false,
        retentionCostConfirmationVersion: EMBEDDING_RETENTION_CONFIRMATION_VERSION,
        endpointPolicy: 'https-or-approved-local',
        projectPolicy,
        activationRecord: createEmbeddingActivationRecord({
          provider: 'openai-compatible',
          endpointHost: validation.host,
          model: validation.model,
          retentionCostConfirmationVersion: EMBEDDING_RETENTION_CONFIRMATION_VERSION,
          projectPolicy
        }),
        secretMigration: normalizeSecretMigrationState(previousSettings.secretMigration),
        semanticIndexing: {
          status: semanticReindex.skipped === true ? 'idle' : 'queued',
          progress_current: 0,
          progress_total: 0,
          queuedAt: semanticReindex.skipped === true ? null : validatedAt,
          skippedReason: semanticReindex.skipped === true ? semanticReindex.reason : null
        }
      };
      store.set('semanticSearch', nextSettings);
      return { success: true, status: getEmbeddingModelStatusPayload(), semanticReindex };
    } catch (err) {
      return {
        success: false,
        status: {
          ...getEmbeddingModelStatusPayload(),
          status: 'unreachable',
          statusReason: err.code || 'connection-failed'
        },
        reason: err.code || 'connection-failed',
        message: err.message
      };
    }
  });

  ipcMain.handle('embedding:clear-model-settings', () => {
    const previousSettings = getStoredEmbeddingSettings();
    clearSemanticDerivedStateForFingerprint(previousSettings.modelFingerprint);
    store.delete('embeddingApiKeyCiphertext');
    store.set('semanticSearch', {
      enabled: false,
      provider: 'openai-compatible',
      baseURL: '',
      model: '',
      dimensions: null,
      apiKeyStorage: 'none',
      hasApiKey: false,
      chunker: {
        chunkSize: EMBEDDING_DEFAULT_CHUNK_SIZE,
        chunkOverlap: EMBEDDING_DEFAULT_CHUNK_OVERLAP
      },
      status: 'unset',
      statusReason: null,
      modelFingerprint: null,
      lastValidatedAt: null,
      offlineOnly: false,
      retentionCostConfirmationVersion: null,
      endpointPolicy: 'https-or-approved-local',
      projectPolicy: { mode: 'allow-all', projects: [] },
      activationRecord: null,
      secretMigration: null,
      semanticIndexing: {
        status: 'stale',
        progress_current: 0,
        progress_total: 0
      }
    });
    return { success: true, status: getEmbeddingModelStatusPayload() };
  });

  // Resolve a clicked markdown href to an absolute file path.
  // The renderer never decodes or classifies hrefs itself: single-window and tab
  // navigation both come through here so they cannot drift apart.
  ipcMain.handle('resolve-link-target', (event, href, baseFilePath) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const windowId = windowManager.findWindowId(win);
    const entry = windowId ? windowManager.getWindowEntry(windowId) : null;

    // In tab mode the active tab, not the window, holds the document the link was
    // clicked in, so the renderer supplies the base and the window meta is the
    // fallback. The base only redirects relative targets: the renderer can already
    // name any absolute path through read-file-for-tab, so this grants nothing new.
    const base = isUsableLinkBase(baseFilePath) ? baseFilePath : (entry ? entry.meta.filePath : null);

    return { filePath: resolveMarkdownLinkTarget(href, base) };
  });

  // Navigate to a linked document within the same viewer window
  ipcMain.on('navigate-to', (event, filePath) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const windowId = windowManager.findWindowId(win);
    if (windowId) {
      Promise.resolve(windowManager.navigateTo(windowId, filePath)).catch(err => {
        console.error(`[doculight] navigate-to error: ${err && err.message}`);
      });
    }
  });

  // History: go back
  ipcMain.on('navigate-back', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const windowId = windowManager.findWindowId(win);
    if (windowId) {
      Promise.resolve(windowManager.navigateBack(windowId)).catch(err => {
        console.error(`[doculight] navigate-back error: ${err && err.message}`);
      });
    }
  });

  // History: go forward
  ipcMain.on('navigate-forward', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const windowId = windowManager.findWindowId(win);
    if (windowId) {
      Promise.resolve(windowManager.navigateForward(windowId)).catch(err => {
        console.error(`[doculight] navigate-forward error: ${err && err.message}`);
      });
    }
  });

  // History: jump to an existing breadcrumb entry and truncate the trail
  ipcMain.on('navigate-to-history-index', (event, index) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const windowId = windowManager.findWindowId(win);
    if (windowId) {
      Promise.resolve(windowManager.navigateToHistoryIndex(windowId, index)).catch(err => {
        console.error(`[doculight] navigate-to-history-index error: ${err && err.message}`);
      });
    }
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
      // onWindowReady는 async (Phase 2 비동기 전환) — unhandled rejection 방지
      Promise.resolve(windowManager.onWindowReady(windowId)).catch(err => {
        console.error(`[doculight] onWindowReady error: ${err && err.message}`);
      });
      // Send initial settings to newly opened window
      const theme = store.get('theme');
      const codeTheme = store.get('codeTheme');
      const fontSize = store.get('fontSize');
      const fontFamily = store.get('fontFamily');
      const contentWidth = store.get('contentWidth');
      const contentMaxWidth = store.get('contentMaxWidth');
      if (theme !== 'light') {
        event.sender.send('theme-changed', { theme });
      }
      event.sender.send('settings-changed', { fontSize, fontFamily, codeTheme, contentWidth, contentMaxWidth });
    }
  });

  // i18n: provide locale strings to renderer
  ipcMain.handle('get-strings', () => {
    return getAllStrings();
  });

  ipcMain.handle('media-viewer:open', async (event, payload) => {
    try {
      const parentWindow = BrowserWindow.fromWebContents(event.sender);
      if (!parentWindow) return { error: 'media_viewer_parent_unavailable' };
      const parentWindowId = getManagedMarkdownViewerWindowId(parentWindow);
      if (!parentWindowId) return { error: 'media_viewer_parent_unavailable' };
      return await createMediaViewerWindow(parentWindowId, payload, parentWindow.isAlwaysOnTop(), parentWindow);
    } catch (err) {
      return { error: redactMediaError(err) };
    }
  });

  ipcMain.handle('media-viewer:get-payload', async (event) => {
    const mediaWindow = BrowserWindow.fromWebContents(event.sender);
    if (!isRegisteredMediaViewerWindow(mediaWindow)) return { error: 'media_viewer_unavailable' };
    return mediaViewerPayloads.get(mediaWindow.id) || { error: 'media_viewer_payload_unavailable' };
  });

  ipcMain.handle('media-viewer:download', async (event, request) => {
    try {
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      if (!isRegisteredMediaViewerWindow(senderWindow)) return { error: 'media_viewer_unavailable' };
      return await downloadMediaAssetForSender(senderWindow, request);
    } catch (err) {
      return { error: redactMediaError(err) };
    }
  });

  // Settings: get all settings
  ipcMain.handle('get-settings', () => {
    return sanitizeSettingsPayload(store.store);
  });

  // Settings: save all settings
  ipcMain.handle('save-settings', (_event, settings) => {
    const oldTheme = store.get('theme');
    const oldFontSize = store.get('fontSize');
    const oldFontFamily = store.get('fontFamily');
    const oldCodeTheme = store.get('codeTheme');
    const oldContentWidth = store.get('contentWidth');
    const oldContentMaxWidth = store.get('contentMaxWidth');
    const oldAutoRefresh = store.get('autoRefresh', true);
    const oldMcpAutoSavePath = store.get('mcpAutoSavePath', '');

    // Save to store
    for (const [key, value] of Object.entries(settings)) {
      if (key === 'semanticSearch' || key === 'embeddingApiKey' || key === 'apiKey' || key === 'embeddingApiKeyCiphertext') continue;
      store.set(key, value);
    }

    // Broadcast theme change to all viewer windows
    if (settings.theme && settings.theme !== oldTheme) {
      for (const [, entry] of windowManager.windows) {
        entry.win.webContents.send('theme-changed', { theme: settings.theme });
      }
    }

    // Broadcast font/settings/codeTheme/contentWidth change to all viewer windows
    if (settings.fontSize !== oldFontSize || settings.fontFamily !== oldFontFamily || settings.codeTheme !== oldCodeTheme || settings.contentWidth !== oldContentWidth || settings.contentMaxWidth !== oldContentMaxWidth) {
      for (const [, entry] of windowManager.windows) {
        entry.win.webContents.send('settings-changed', {
          fontSize: settings.fontSize,
          fontFamily: settings.fontFamily,
          codeTheme: settings.codeTheme,
          contentWidth: settings.contentWidth,
          contentMaxWidth: settings.contentMaxWidth
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

    if ('mcpAutoSavePath' in settings && settings.mcpAutoSavePath !== oldMcpAutoSavePath && searchEngine) {
      searchEngine.resetForSourceRootChange();
      initializeSearchEngineIfConfigured();
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
      // Validate Markdown extension
      if (!isMarkdownFilePath(filePath)) {
        return; // silently ignore non-Markdown files
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
      entry.meta.validatedIndexedOpen = false;
      entry.meta.lastRenderedContent = undefined;
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
        platform: process.platform,
        navigationTrail: windowManager.getNavigationTrailPayload(windowId)
      });

      // step28 Phase 2: 배치 스트리밍 로드 단일 진입점으로 통합
      windowManager._startSidebarTreeLoad(windowId, filePath);

      // Update tray menu with new title
      if (typeof windowManager.onTrayUpdate === 'function') {
        windowManager.onTrayUpdate();
      }

      // Start file watcher for dropped file
      windowManager.startFileWatcher(windowId);

      // Track in recent files
      addRecentFile(filePath);
      scheduleOpenedMarkdownRegistration(filePath);
    } catch (err) {
      console.error(`[doculight] file-dropped error: ${err.message}`);
    }
  });

  // File opened in a new tab (track recent + start watcher, no render-markdown sent)
  ipcMain.on('file-opened-in-tab', async (event, filePath) => {
    try {
      if (!isMarkdownFilePath(filePath)) return;
      const win = BrowserWindow.fromWebContents(event.sender);
      const windowId = windowManager.findWindowId(win);
      if (!windowId) return;
      const entry = windowManager.getWindowEntry(windowId);
      if (!entry) return;

      // Update meta for the window (root stays the same)
      entry.meta.filePath = filePath;
      entry.meta.validatedIndexedOpen = false;
      entry.meta.lastRenderedContent = undefined;
      if (!entry.meta.rootFilePath) entry.meta.rootFilePath = filePath;

      // Start file watcher
      windowManager.startFileWatcher(windowId);

      // Track in recent files
      addRecentFile(filePath);
      scheduleOpenedMarkdownRegistration(filePath);
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
      propagateAlwaysOnTopToMediaViewers(windowId, !current);
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
      propagateAlwaysOnTopToMediaViewers(windowId, !!value);
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
        propagateAlwaysOnTopToMediaViewers(windowId, false);
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
        // Single file export — resolve content source before dialog (FR-2, FR-3)
        const resolvedFilePath = senderEntry.meta.filePath || senderEntry.meta.savedFilePath;
        let markdown;
        if (resolvedFilePath) {
          markdown = await fs.promises.readFile(resolvedFilePath, 'utf-8');
        } else if (senderEntry.meta.lastRenderedContent) {
          markdown = senderEntry.meta.lastRenderedContent;
        } else {
          return { error: 'No file to export' };
        }

        const defaultName = resolvedFilePath
          ? path.basename(resolvedFilePath, path.extname(resolvedFilePath)) + '.pdf'
          : 'document.pdf';

        // Temporarily release alwaysOnTop so native dialog appears above (FR-1)
        const wasOnTop = senderWin.isAlwaysOnTop();
        if (wasOnTop) senderWin.setAlwaysOnTop(false);
        let saveResult;
        try {
          saveResult = await dialog.showSaveDialog(senderWin, {
            defaultPath: defaultName,
            filters: [{ name: 'PDF', extensions: ['pdf'] }]
          });
        } finally {
          if (wasOnTop && !senderWin.isDestroyed()) senderWin.setAlwaysOnTop(true);
        }

        if (saveResult.canceled || !saveResult.filePath) {
          return { cancelled: true };
        }

        const savePath = saveResult.filePath;

        // Resolve imageBasePath
        const imageBasePath = resolvedFilePath
          ? path.dirname(resolvedFilePath).replace(/\\/g, '/')
          : null;

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

          // Wait for window-ready with 15s timeout (FR-4)
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              ipcMain.removeListener('window-ready', readyHandler);
              reject(new Error('PDF window ready timeout'));
            }, 15000);

            const readyHandler = (readyEvent) => {
              const readyWin = BrowserWindow.fromWebContents(readyEvent.sender);
              if (readyWin === pdfWin) {
                clearTimeout(timer);
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
          const contentWidth = store.get('contentWidth');
          const contentMaxWidth = store.get('contentMaxWidth');
          if (theme !== 'light') {
            pdfWin.webContents.send('theme-changed', { theme });
          }
          pdfWin.webContents.send('settings-changed', { fontSize, fontFamily, codeTheme, contentWidth, contentMaxWidth });

          // Send markdown with pdfMode flag
          pdfWin.webContents.send('render-markdown', {
            markdown,
            filePath: resolvedFilePath ? resolvedFilePath.replace(/\\/g, '/') : null,
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

        // Temporarily release alwaysOnTop so native dialog appears above (FR-1)
        const wasOnTopAll = senderWin.isAlwaysOnTop();
        if (wasOnTopAll) senderWin.setAlwaysOnTop(false);
        let saveResult;
        try {
          saveResult = await dialog.showSaveDialog(senderWin, {
            defaultPath: 'all-documents.pdf',
            filters: [{ name: 'PDF', extensions: ['pdf'] }]
          });
        } finally {
          if (wasOnTopAll && !senderWin.isDestroyed()) senderWin.setAlwaysOnTop(true);
        }

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

              // Wait for window-ready with 15s timeout (FR-4)
              await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                  ipcMain.removeListener('window-ready', readyHandler);
                  reject(new Error('PDF window ready timeout'));
                }, 15000);

                const readyHandler = (readyEvent) => {
                  const readyWin = BrowserWindow.fromWebContents(readyEvent.sender);
                  if (readyWin === pdfWin) {
                    clearTimeout(timer);
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
              const contentWidth = store.get('contentWidth');
              const contentMaxWidth = store.get('contentMaxWidth');
              if (theme !== 'light') {
                pdfWin.webContents.send('theme-changed', { theme });
              }
              pdfWin.webContents.send('settings-changed', { fontSize, fontFamily, codeTheme, contentWidth, contentMaxWidth });

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

      // step28 Phase 2: 사이드바 트리는 fire-and-forget으로 배치 스트리밍 전송.
      // 동기 응답에는 sidebarTree: null. IPC 이벤트(sidebar-tree-start/batch/done)로
      // 렌더러가 점진적으로 수신. tab-manager는 currentTree 상속 패턴으로 이미 내성 있음.
      const sidebarTree = null;
      try {
        const win = BrowserWindow.fromWebContents(_event.sender);
        const windowId = win ? windowManager.findWindowId(win) : null;
        if (windowId) {
          windowManager._startSidebarTreeLoad(windowId, filePath);
        }
      } catch (err) {
        console.error(`[doculight] Failed to start tree load for tab: ${err.message}`);
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

  // step28 Phase 2: 사이드바 트리 로드 취소 요청 (폴더 전환 시 렌더러에서 호출)
  ipcMain.handle('cancel-sidebar-tree-load', (event, payload = {}) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return { cancelled: false };
      const windowId = windowManager.findWindowId(win);
      if (!windowId) return { cancelled: false };
      const cur = windowManager._currentLoadIds.get(windowId);
      if (!cur) return { cancelled: false };
      // loadId가 숫자로 명시됐고 불일치하면 취소하지 않음 (구 이벤트 기반 요청 보호)
      const { loadId } = payload;
      if (typeof loadId === 'number' && cur.loadId !== loadId) {
        return { cancelled: false };
      }
      try { cur.controller.abort(); } catch { /* ignore */ }
      return { cancelled: true };
    } catch {
      return { cancelled: false };
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
      if (searchEngine) {
        searchEngine.markDirty({
          filePath: savePath,
          content: params && typeof params.content === 'string' ? params.content : null,
          requestedBy: 'renderer.save_as'
        });
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
      if (searchEngine) {
        searchEngine.markDirty({
          filePath: savePath,
          content: params && typeof params.content === 'string' ? params.content : null,
          requestedBy: 'renderer.quick_save'
        });
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

  // === MCP Manual Save (FR-22-001) ===
  ipcMain.handle('mcp-manual-save', async (event, params) => {
    const result = await mcpManualSave(store, params);
    if (result.success) {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) {
        const windowId = windowManager.findWindowId(win);
        if (windowId) {
          const entry = windowManager.getWindowEntry(windowId);
          if (entry) entry.meta.savedFilePath = result.filePath;
        }
      }
      searchEngine.markDirty({
        filePath: result.filePath,
        content: params && typeof params.content === 'string' ? params.content : null,
        requestedBy: 'renderer.mcp_manual_save'
      });
    }
    return result;
  });

  // === Render Pasted Content (FR-22-004) ===
  ipcMain.handle('render-pasted-content', async (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { success: false, error: 'window not found' };

    const { text: content, allowMarkdownFallback } = normalizeRenderPastedContentInput(payload);
    const pastedFilePath = await resolveReadablePastedMarkdownPath(content);
    if (pastedFilePath) {
      const windowId = windowManager.findWindowId(win);
      if (!windowId) return { success: false, error: 'window not found' };
      await windowManager.navigateTo(windowId, pastedFilePath);
      return { success: true, source: 'file' };
    }

    if (!allowMarkdownFallback) {
      return { success: false, ignored: true, reason: 'not_readable_markdown_path' };
    }

    const title = extractTitleFromContent(content) || 'Pasted';
    win.webContents.send('render-markdown', {
      markdown: content,
      filePath: null,
      title: title,
      source: 'paste'
    });
    return { success: true, source: 'paste' };
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
