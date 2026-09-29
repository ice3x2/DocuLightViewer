'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { saveDocumentToStore, mcpManualSave } = require('../src/main/mcp-save');
const { registerRendererSaveHandlers } = require('../src/main/renderer-save-handlers');
const { composeIndexingStatusPayload } = require('../src/main/ledger-status-registry');
const stringsLoader = require('../src/main/strings');

// @req IR-APP-013 AC-4 AC-6 FR-DOC-019 AC-3 REL-DOC-009 AC-4 AC-5
async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s21b-capacity-'));
  const documentRoot = path.join(root, 'documents');
  const ingressRoot = path.join(root, 'intents');
  fs.mkdirSync(documentRoot);
  fs.mkdirSync(ingressRoot);
  try {
    stringsLoader.init('en');
    for (let i = 0; i < 1024; i += 1)
      fs.writeFileSync(path.join(ingressRoot, `${String(i).padStart(4, '0')}.intent.json`), 'x');
    const settings = { mcpAutoSave: true,
      mcpAutoSavePath: documentRoot, lastSaveAsDirectory: documentRoot,
      userDataPath: root };
    const store = { get(key, fallback) { return settings[key] ?? fallback; },
      set(key, value) { settings[key] = value; } };
    const searchEngine = { saveDocumentIngressRoot: ingressRoot };
    const mcp = await saveDocumentToStore(store, {
      content: '# New document that cannot be saved\n', title: 'capacity-rejected'
    }, searchEngine);
    const body = JSON.parse(mcp.content[0].text);
    assert.equal(mcp.isError, true, 'full private ingress rejects the product save');
    assert.equal(body.saved, false);
    assert.equal(body.error.code, 'write_failed', 'MCP keeps its canonical save failure');
    assert.equal(body.error.message, require('../src/locales/en.json')['viewer.saveCapacityFailed'],
      'MCP capacity failure uses the existing English strings payload');
    assert.match(body.error.message, /capacity|full/i, 'failure explains the capacity condition');
    assert.match(body.error.message, /save failed|not saved|could not be saved/i,
      'MCP makes clear that no document was saved');
    assert.match(body.error.message, /retry|free space/i, 'MCP gives recovery guidance');
    assert(!body.indexing && !body.jobId, 'failed save claims no indexing acceptance');
    assert.deepEqual(fs.readdirSync(documentRoot), [], 'no Markdown is published');
    assert.equal(searchEngine.saveIngressAtCapacity, true,
      'real pre-intent rejection records a cached capacity condition for Settings');
    assert.equal(composeIndexingStatusPayload({ state: 'ready' }, { state: 'ready' }, true,
      searchEngine.saveIngressAtCapacity).ledgerCondition, 'indexing_ingress_capacity',
    'Settings payload reports the real capacity condition');
    const mainSource = fs.readFileSync(path.join(__dirname, '../src/main/index.js'), 'utf8');
    const statusStart = mainSource.indexOf('function getIndexingStatusPayload() {');
    const statusEnd = mainSource.indexOf('function sanitizeSettingsPayload(', statusStart);
    assert(statusStart >= 0 && statusEnd > statusStart, 'actual main status producer is available');
    searchEngine.getStatus = () => ({ state: 'ready' });
    const productStatus = vm.runInNewContext(
      `${mainSource.slice(statusStart, statusEnd)}\ngetIndexingStatusPayload`, {
        searchEngine, saveDocumentOwner: null, nativeRebuildManager: null,
        isDocumentStoreSourceRootConfigured: () => true,
        require: () => ({ composeIndexingStatusPayload })
      });
    assert.equal(productStatus().ledgerCondition, 'indexing_ingress_capacity',
      'actual product status uses the cached condition after real ingress rejection');
    const { createToolHandlers } = await import('../src/main/mcp-http.mjs');
    const http = await createToolHandlers({}, store, searchEngine).save_document({
      content: '# HTTP document that cannot be saved\n', title: 'http-capacity'
    });
    const httpBody = JSON.parse(http.content[0].text);
    assert.equal(http.isError, true, 'HTTP save_document returns a tool error at capacity');
    assert.equal(httpBody.saved, false);
    assert.equal(httpBody.error.code, 'write_failed');
    assert(!httpBody.indexing && !httpBody.jobId);
    assert.deepEqual(fs.readdirSync(documentRoot), [], 'HTTP capacity rejects before publication');

    const handlers = new Map();
    registerRendererSaveHandlers({ ipcMain: { handle(name, callback) { handlers.set(name, callback); } },
      dialog: { async showSaveDialog() { return { canceled: false,
        filePath: path.join(documentRoot, 'dialog-capacity.md') }; } },
      BrowserWindow: { fromWebContents() { return null; } }, windowManager: {}, store, searchEngine });
    const renderer = await handlers.get('quick-save')(null, {
      content: '# Viewer document that cannot be saved\n', defaultFileName: 'viewer-capacity.md'
    });
    assert.equal(renderer.success, false, 'viewer save also fails before publication');
    assert.equal(renderer.errorCode, 'indexing_ingress_capacity',
      'private IPC carries a stable code for localized capacity guidance');
    assert(!renderer.indexingState && !renderer.jobId && !renderer.filePath);
    assert.deepEqual(fs.readdirSync(documentRoot), [], 'viewer failure publishes no Markdown');
    const saveAs = await handlers.get('save-as')({ sender: {} }, {
      content: '# Dialog document that cannot be saved\n', defaultFileName: 'dialog-capacity.md'
    });
    assert.equal(saveAs.success, false, 'save-as dialog selection fails before publication');
    assert.equal(saveAs.errorCode, 'indexing_ingress_capacity');
    assert(!saveAs.indexingState && !saveAs.jobId && !saveAs.filePath);
    assert.deepEqual(fs.readdirSync(documentRoot), [], 'save-as publishes no Markdown at capacity');
    const manual = await mcpManualSave(store,
      { content: '# Manual viewer save cannot be published\n', title: 'manual-capacity' }, searchEngine);
    assert.deepEqual(manual, { success: false, errorKey: 'viewer.saveCapacityFailed' },
      'MCP viewer manual save uses the localized capacity failure guidance');
    assert.deepEqual(fs.readdirSync(documentRoot), [], 'MCP manual save publishes no Markdown at capacity');
    for (const locale of ['ko', 'en', 'ja', 'es']) {
      const strings = require(`../src/locales/${locale}.json`);
      assert(strings['viewer.saveCapacityFailed']
        && strings['viewer.saveCapacityFailed'] !== strings['viewer.indexingDeferred'],
      `${locale} distinguishes save failure from deferred indexing`);
      const historical = { ko: /마지막|최근/, en: /last|previous/i,
        ja: /前回|直近/, es: /último|última|anterior/i };
      assert(historical[locale].test(strings['settings.ledger.saveCapacity']),
        `${locale} Settings capacity copy describes the last failed save, not current capacity`);
      stringsLoader.init(locale);
      const localizedSave = await saveDocumentToStore(store,
        { content: '# Localized capacity failure\n' }, searchEngine);
      assert.equal(JSON.parse(localizedSave.content[0].text).error.message,
        strings['viewer.saveCapacityFailed'],
      `${locale} MCP save_document capacity error uses the existing strings payload`);
    }
    stringsLoader.init('en');
    for (let i = 0; i < 1024; i += 1)
      fs.unlinkSync(path.join(ingressRoot, `${String(i).padStart(4, '0')}.intent.json`));
    const resumed = await saveDocumentToStore(store, { content: '# Capacity cleared\n' }, searchEngine);
    assert.notEqual(resumed.isError, true, 'save resumes after space becomes available');
    assert.equal(searchEngine.saveIngressAtCapacity, false,
      'successful publication clears stale Settings capacity guidance');
    assert.equal(productStatus().ledgerCondition, null,
      'actual product status clears stale capacity guidance after a successful save');
    for (let i = 0; i < 1024; i += 1)
      fs.writeFileSync(path.join(ingressRoot, `${String(i).padStart(4, '0')}.intent.json`), 'x');
    const oldRootFull = await saveDocumentToStore(store, { content: '# Old store full again\n' }, searchEngine);
    assert.equal(oldRootFull.isError, true);
    assert.equal(productStatus().ledgerCondition, 'indexing_ingress_capacity');
    const newDocumentRoot = path.join(root, 'new-documents');
    fs.mkdirSync(newDocumentRoot);
    let releaseOldSave;
    let oldSaveEntered;
    const oldSaveAtOwner = new Promise(resolve => { oldSaveEntered = resolve; });
    const oldSaveBarrier = new Promise(resolve => { releaseOldSave = resolve; });
    searchEngine.getSaveDocumentOwner = async () => {
      oldSaveEntered();
      await oldSaveBarrier;
      return null;
    };
    const delayedOldSave = saveDocumentToStore(store,
      { content: '# Old root save finishing after store switch\n' }, searchEngine);
    await oldSaveAtOwner;
    const settingsStart = mainSource.indexOf("  ipcMain.handle('save-settings'");
    const settingsEnd = mainSource.indexOf('  // Zoom in', settingsStart);
    assert(settingsStart >= 0 && settingsEnd > settingsStart, 'actual save-settings IPC handler is available');
    let saveSettingsHandler;
    let resets = 0;
    searchEngine.resetForSourceRootChange = () => { resets += 1; };
    vm.runInNewContext(mainSource.slice(settingsStart, settingsEnd), {
      ipcMain: { handle(_name, callback) { saveSettingsHandler = callback; } },
      store, searchEngine, windowManager: { windows: new Map() },
      initializeSearchEngineIfConfigured() {}
    });
    const switched = saveSettingsHandler(null, { mcpAutoSavePath: newDocumentRoot });
    assert.equal(switched.success, true);
    assert.equal(resets, 1, 'root switch resets the search engine once');
    assert.equal(productStatus().ledgerCondition, null,
      'new healthy store does not inherit old store capacity before any save');
    releaseOldSave();
    const lateOldFailure = await delayedOldSave;
    assert.equal(lateOldFailure.isError, true, 'old-root in-flight save still fails at old-root capacity');
    assert.equal(productStatus().ledgerCondition, null,
      'old-root late failure cannot relatch the new root capacity condition');
    assert.deepEqual(fs.readdirSync(newDocumentRoot), [], 'root switch itself publishes no Markdown');
    const concurrentRoot = path.join(root, 'concurrent-documents');
    const concurrentIngress = path.join(root, 'concurrent-intents');
    fs.mkdirSync(concurrentRoot);
    fs.mkdirSync(concurrentIngress);
    for (let i = 0; i < 1024; i += 1)
      fs.writeFileSync(path.join(concurrentIngress, `${String(i).padStart(4, '0')}.intent.json`), 'x');
    saveSettingsHandler(null, { mcpAutoSavePath: concurrentRoot });
    searchEngine.saveDocumentIngressRoot = concurrentIngress;
    let releaseOlderSave;
    let olderSaveEntered;
    const olderEntered = new Promise(resolve => { olderSaveEntered = resolve; });
    const olderGate = new Promise(resolve => { releaseOlderSave = resolve; });
    let ownerCalls = 0;
    searchEngine.getSaveDocumentOwner = async () => {
      ownerCalls += 1;
      if (ownerCalls === 1) { olderSaveEntered(); await olderGate; }
      return null;
    };
    const olderSave = saveDocumentToStore(store, { content: '# Older overlapping save\n' }, searchEngine);
    await olderEntered;
    const newerFailure = await saveDocumentToStore(store,
      { content: '# Newer save rejected at capacity\n' }, searchEngine);
    assert.equal(newerFailure.isError, true);
    assert.equal(productStatus().ledgerCondition, 'indexing_ingress_capacity');
    fs.unlinkSync(path.join(concurrentIngress, '0000.intent.json'));
    releaseOlderSave();
    const olderSuccess = await olderSave;
    assert.notEqual(olderSuccess.isError, true, 'older save uses the one freed slot');
    assert.equal(productStatus().ledgerCondition, 'indexing_ingress_capacity',
      'older completion does not erase the newer failed save notice');
    console.log('test-s21b-save-capacity: PASS');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
