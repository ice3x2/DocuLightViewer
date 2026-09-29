'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { BrowserWindow, ipcMain } = require('electron');
const { SearchEngine } = require('../../../src/main/search-engine');
const { STATES, fromOwnerSnapshot, composeIndexingStatusPayload } = require('../../../src/main/ledger-status-registry');
const { registerRendererSaveHandlers } = require('../../../src/main/renderer-save-handlers');
const { readPendingSave } = require('../../../src/main/index-ingress-store');
const { OwnerWorkerController } = require('../../../src/main/search-owner-controller');
const { SourceLedgerStore } = require('../../../src/main/source-ledger-store');
const stringsLoader = require('../../../src/main/strings');

// @req IR-APP-013 IR-APP-010 FR-APP-006 FR-APP-007 FR-DOC-019 REL-DOC-009
module.exports = {
  name: 's21',
  async run({ assert }) {
    const begunAt = Date.now();
    const phase = label => console.error(`S21_PHASE ${label} elapsedMs=${Date.now() - begunAt}`);
    const priorLocaleEnv = process.env.DOCULIGHT_LOCALE;
    const productSource = fs.readFileSync(path.join(__dirname, '../../../src/main/index.js'), 'utf8');
    const localeStart = productSource.indexOf('const _langOverride = (() => {');
    const localeEnd = productSource.indexOf('})();', localeStart);
    assert(localeStart >= 0 && localeEnd > localeStart, 'actual product locale selector is present');
    const productLocale = (argv, env) => vm.runInNewContext(
      `${productSource.slice(localeStart, localeEnd + 5)}\n_langOverride`,
      { process: { argv, env } });
    stringsLoader.init('en');
    const saveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s21b-'));
    const documentRoot = path.join(saveRoot, 'documents');
    const ingressRoot = path.join(saveRoot, 'intents');
    fs.mkdirSync(documentRoot);
    fs.mkdirSync(ingressRoot);
    let locale = 'en';
    const localeStrings = Object.fromEntries(['ko', 'en', 'ja', 'es'].map(code =>
      [code, require(`../../../src/locales/${code}.json`)]));
    let snapshot = { state: 'ready', ledgerState: 'READY', ledgerCode: 'ledger_ready',
      ledgerPhase: null, ledgerProgress: 0, sourceRootConfigured: true };
    let cancelCount = 0;
    let retryCount = 0;
    let ownerCancelCount = 0;
    let checkerCancelCount = 0;
    let ownerRetryCount = 0;
    let ownerActionMode = false;
    let ownerSnapshot = { state: 'ready', active: false };
    let ownerCancelHandler = null;
    let legacyRebuildActive = false;
    let legacyWorkerActive = false;
    const legacyWorker = {
      isActive: () => legacyWorkerActive,
      cancelActiveJob: () => ({ cancelled: true, jobId: 'legacy-index-job' })
    };
    const legacyEngine = {
      getIndexingWorkerController: () => legacyWorkerActive ? legacyWorker : null,
      getStatus: () => snapshot,
      get _rebuildPromise() { return legacyRebuildActive ? Promise.resolve() : null; },
      _cancelRequested: false,
      startRebuild: () => ({ started: false, status: snapshot })
    };
    let saveAcceptance = { accepted: false, indexingState: 'enqueue_failed',
      warnings: [{ code: 'indexing_ingress_capacity' }] };
    let realSaveOwner;
    let lastSaveReply;
    let publishedIntent;
    let realQuickSave;
    let realQuickSaveCalls = 0;
    let realSaveAs;
    let realSaveAsCompletions = 0;
    let saveAsDialogGate = null;
    let localizedCapacityReply = null;
    const saveStore = { get(key, fallback) { return ({ mcpAutoSavePath: documentRoot,
      lastSaveAsDirectory: documentRoot })[key] ?? fallback; }, set() {} };
    const saveSearch = { ownerController: { config: { ingressRoot },
      async acceptPublishedSave(input) {
        publishedIntent = readPendingSave({ storeRoot: documentRoot, ingressRoot,
          intentId: input.intentId });
        if (saveAcceptance === null) throw new Error('owner unavailable');
        return saveAcceptance;
      } } };
    registerRendererSaveHandlers({ ipcMain: { handle(name, handler) {
      if (name === 'quick-save') realQuickSave = handler;
      if (name === 'save-as') realSaveAs = handler;
    } }, dialog: { async showSaveDialog() {
      if (saveAsDialogGate) await saveAsDialogGate;
      return { canceled: false, filePath: path.join(documentRoot, 'dialog-capacity.md') };
    } },
    BrowserWindow, windowManager: {}, store: saveStore,
    searchEngine: saveSearch });
    const handlers = {
      'get-strings': () => stringsLoader.getAll(),
      'get-settings': () => ({ mcpAutoSavePath: 'C:\\store' }),
      'indexing:get-status': () => snapshot,
      'get-file-association-status': () => ({ registered: false }),
      'check-port-available': () => true,
      'indexing:cancel-job': event => ownerActionMode
        ? ownerCancelHandler(event)
        : (cancelCount += 1, SearchEngine.prototype.cancelRebuild.call(legacyEngine)),
      'indexing:retry-failures': () => ownerActionMode
        ? (ownerRetryCount += 1, { started: true, scheduled: true, jobId: 'owner-retry', status: snapshot })
        : (retryCount += 1, SearchEngine.prototype.retryFailures.call(legacyEngine)),
      'quick-save': async (...args) => {
        if (localizedCapacityReply) lastSaveReply = localizedCapacityReply;
        else {
          realQuickSaveCalls += 1;
          lastSaveReply = await realQuickSave(...args);
        }
        return lastSaveReply;
      },
      'save-as': async (...args) => {
        lastSaveReply = await realSaveAs(...args);
        realSaveAsCompletions += 1;
        return lastSaveReply;
      }
    };
    for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);
    const win = new BrowserWindow({ show: true, webPreferences: {
      preload: path.join(__dirname, '../../../src/main/preload.js'), contextIsolation: true, nodeIntegration: false
    } });
    try {
      const product = fs.readFileSync(path.join(__dirname, '../../../src/main/index.js'), 'utf8');
      const cancelStart = product.indexOf("ipcMain.handle('indexing:cancel-job'");
      const cancelEnd = product.indexOf("ipcMain.handle('indexing:retry-failures'", cancelStart);
      const actualHandlers = new Map();
      vm.runInNewContext(product.slice(cancelStart, cancelEnd), {
        ipcMain: { handle: (name, handler) => actualHandlers.set(name, handler) },
        settingsIndexingWindow: () => win,
        saveDocumentOwner: {
          getStatus: () => ownerSnapshot,
          cancelRetryCheck: async () => { checkerCancelCount += 1; return { cancelled: true }; },
          cancel: async () => { ownerCancelCount += 1; return { cancelled: true }; }
        },
        searchEngine: legacyEngine,
        require: () => ({ fromOwnerSnapshot }),
        isDocumentStoreSourceRootConfigured: () => true,
        getIndexingStatusPayload: () => snapshot
      });
      ownerCancelHandler = actualHandlers.get('indexing:cancel-job');
      assert(typeof ownerCancelHandler === 'function', 'actual private Settings cancel handler is registered');
      await win.loadFile(path.join(__dirname, '../../../src/renderer/settings.html'));
      phase('settings-loaded');
      await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 50))');
      const inspect = () => win.webContents.executeJavaScript(`({
        text: document.getElementById('indexing-status').textContent,
        role: document.getElementById('indexing-status').getAttribute('role'),
        live: document.getElementById('indexing-status').getAttribute('aria-live'),
        atomic: document.getElementById('indexing-status').getAttribute('aria-atomic'),
        alert: document.getElementById('indexing-error').getAttribute('role'),
        diagnostic: document.getElementById('indexing-error').textContent,
        retryDisabled: document.getElementById('indexing-retry-btn').disabled,
        retryCheckDisabled: document.getElementById('indexing-retry-check-btn').disabled,
        retryCheckDescription: document.getElementById('indexing-retry-check-btn').parentElement.querySelector('small').textContent,
        cancelDisabled: document.getElementById('indexing-cancel-btn').disabled,
        rebuildDisabled: document.getElementById('indexing-rebuild-btn').disabled,
        compactDisabled: document.getElementById('indexing-compact-btn').disabled,
        manageDisabled: document.getElementById('indexing-manage-btn').disabled,
        openDirDisabled: document.getElementById('indexing-open-dir-btn').disabled,
        storePathDisabled: document.getElementById('mcpAutoSavePath-input').disabled,
        storeBrowseDisabled: document.getElementById('mcpAutoSavePath-browse-btn').disabled,
        focus: document.activeElement.id
      })`);
      const update = async next => {
        snapshot = { ...snapshot, ...next };
        await win.webContents.executeJavaScript('document.getElementById("indexing-manage-btn").click()');
        await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 30))');
      };
      let view = await inspect();
      assert(view.role === 'status' && view.live === 'polite' && view.atomic === 'true', 'Settings ledger live region has required ARIA contract');
      await win.webContents.executeJavaScript(`window.__s21Announcements = [];
        new MutationObserver(() => window.__s21Announcements.push(document.getElementById('indexing-status').textContent))
          .observe(document.getElementById('indexing-status'), { childList: true, characterData: true, subtree: true });`);
      await update({ ledgerState: 'READY_MAINTENANCE_PENDING', ledgerCode: 'maintenance_pending', state: 'ready' });
      view = await inspect();
      assert(/pending/i.test(view.text) && view.cancelDisabled, 'queued indexing is distinct from completion');
      await update({ ledgerState: 'KEYWORD_REPAIRING', ledgerCode: 'keyword_repair_in_progress',
        state: 'ready', ledgerProgress: 21 });
      view = await inspect();
      assert(view.text.includes('21%') && view.cancelDisabled, 'keyword repair does not offer unsupported legacy cancel');
      const announcementCount = () => win.webContents.executeJavaScript('window.__s21Announcements.length');
      const at21 = await announcementCount();
      await update({ ledgerProgress: 25, heartbeatAt: 'later' });
      assert(await announcementCount() === at21, 'heartbeat and same 10% bucket do not announce');
      await update({ ledgerProgress: 31 });
      assert(await announcementCount() === at21 + 1, 'new 10% bucket announces once');
      await update({ ledgerState: 'READY', ledgerCode: 'ledger_ready', state: 'ready', ledgerProgress: 100 });
      view = await inspect();
      assert(view.text.includes('100%') && view.cancelDisabled, 'completed indexing announces terminal progress once and disables cancel');
      phase('settings-announcements');
      const at100 = await announcementCount();
      await update({ heartbeatAt: 'still later', ledgerProgress: 100 });
      assert(await announcementCount() === at100, 'terminal 100% does not repeat on heartbeat');
      await update({ ledgerState: 'READY_KEYWORD_DEGRADED', state: 'degraded', ledgerCode: 'keyword_index_unavailable',
        ledgerCondition: 'indexing_ingress_capacity', ledgerProgress: 0 });
      view = await inspect();
      assert(view.text.includes(localeStrings.en['settings.ledger.saveCapacity'])
        && !/indexing deferred|document saved/i.test(view.text),
        `Settings capacity status explains new saves fail without inventing a save receipt: ${JSON.stringify(view.text)}`);
      await update({ ledgerState: 'CORRUPT_DEGRADED', ledgerCode: 'ledger_recovery_required', ledgerCondition: null });
      view = await inspect();
      assert(view.retryDisabled && view.alert === null, 'recovery state does not offer unsupported legacy retry');
      assert(!view.retryCheckDisabled, 'corrupt source state offers a distinct health check');
      assert(/health check/i.test(view.retryCheckDescription)
        && !/failed documents/i.test(view.retryCheckDescription),
      'retry-check has its own localized health guidance, separate from failed-document retry');
      await win.webContents.executeJavaScript('document.getElementById("indexing-retry-btn").click()');
      assert(retryCount === 0, 'disabled canonical retry does not invoke the legacy rebuild IPC');
      await update({ ledgerState: 'OWNER_EXIT_BLOCKED', ledgerCode: 'ledger_owner_exit_blocked', ledgerCondition: null });
      view = await inspect();
      assert(view.alert === 'alert' && /restart|support/i.test(view.text), 'unrecoverable ledger state exposes localized restart/support alert');
      ownerActionMode = true;
      ownerSnapshot = { state: 'CHECKING', active: true, phase: 'health_check' };
      await update({ ledgerState: 'CHECKING', state: 'checking', ledgerCode: 'ledger_checking' });
      view = await inspect();
      assert(!view.cancelDisabled && view.retryCheckDisabled, 'checking offers safe cancel and blocks duplicate health check');
      await win.webContents.executeJavaScript('document.getElementById("indexing-cancel-btn").click()');
      await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 30))');
      assert(cancelCount === 0 && checkerCancelCount === 1,
        'checking cancel targets the ephemeral checker rather than legacy cancel');
      ownerActionMode = false;
      legacyRebuildActive = true;
      await update(composeIndexingStatusPayload({ state: 'rebuilding', failedCount: 0,
        rebuildSession: { active: true, indexedCount: 0, pendingCount: 1 } }, { state: 'ready' }, true));
      view = await inspect();
      assert(/rebuild/i.test(view.text)
        && view.text.indexOf(localeStrings.en['settings.ledger.state.READY']) > view.text.search(/rebuild/i),
        'active legacy rebuild is announced ahead of parallel owner READY');
      assert(view.rebuildDisabled && view.compactDisabled,
        'active legacy rebuild blocks maintenance actions despite parallel owner READY');
      await update({ ledgerCondition: 'indexing_ingress_capacity' });
      view = await inspect();
      assert(/rebuild/i.test(view.text)
        && view.text.includes(localeStrings.en['settings.ledger.saveCapacity'])
        && !/document saved/i.test(view.text),
        'active legacy copy retains capacity save-failure guidance');
      await update({ ledgerCondition: null });
      view = await inspect();
      assert(view.cancelDisabled, 'full legacy rebuild keeps the baseline safe-cancel guard');
      await win.webContents.executeJavaScript('document.getElementById("indexing-cancel-btn").focus(); document.getElementById("indexing-cancel-btn").click()');
      await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 30))');
      assert(cancelCount === 0 && legacyEngine._cancelRequested === false,
        'full rebuild does not invoke the private legacy cancel handler');
      legacyRebuildActive = false;
      legacyWorkerActive = true;
      await update(composeIndexingStatusPayload({ state: 'indexing', failedCount: 0, rebuildSession: null,
        indexingWorker: { active: true, kind: 'index' } }, { state: 'ready' }, true));
      view = await inspect();
      assert(view.cancelDisabled, 'legacy worker with owner READY cannot enable Cancel outside AC-15 states');
      await win.webContents.executeJavaScript('document.getElementById("indexing-cancel-btn").focus(); document.getElementById("indexing-cancel-btn").click()');
      await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 30))');
      view = await inspect();
      assert(cancelCount === 0,
        'legacy worker outside AC-15 states cannot reach the private Cancel handler');
      legacyWorkerActive = false;
      phase('settings-legacy-actions');
      await update(composeIndexingStatusPayload({ state: 'degraded', rebuildSession: null, failedCount: 1 },
        { state: 'ready' }, true));
      view = await inspect();
      assert(!view.retryDisabled, 'real-shaped mixed payload preserves legacy failed-file retry');
      await win.webContents.executeJavaScript('document.getElementById("indexing-retry-btn").click()');
      await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 30))');
      view = await inspect();
      assert(retryCount === 1 && /could not be completed/i.test(view.diagnostic),
        'legacy retry routes to SearchEngine.retryFailures and leaves not-started result visible');
      ownerActionMode = true;
      ownerSnapshot = { state: 'rebuilding', active: true, kind: 'rebuild', jobId: 'owner-job', phase: 'scan' };
      await update(composeIndexingStatusPayload({ state: 'ready', indexingWorker: null,
        failedCount: 0, rebuildSession: null },
      ownerSnapshot, true));
      view = await inspect();
      assert(/rebuild/i.test(view.text) && view.cancelDisabled,
        'owner full rebuild uses canonical keyword repair but keeps visible Stop disabled');
      await win.webContents.executeJavaScript('document.getElementById("indexing-cancel-btn").focus(); document.getElementById("indexing-cancel-btn").click()');
      await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 30))');
      assert(ownerCancelCount === 0, 'owner full rebuild Stop does not invoke private cancel');
      const directRebuildCancel = await win.webContents.executeJavaScript('window.doclight.cancelIndexingJob()');
      assert(directRebuildCancel.cancelled === false && ownerCancelCount === 0,
        'direct private Cancel rejects full rebuild despite keyword repair state');
      ownerSnapshot = { state: 'indexing', active: true, phase: 'index_document', jobId: 'owner-document' };
      await update(composeIndexingStatusPayload({ state: 'ready', indexingWorker: null,
        failedCount: 1, rebuildSession: null },
      ownerSnapshot, true));
      view = await inspect();
      assert(!view.cancelDisabled, 'owner document indexing offers supported private Cancel');
      assert(view.retryDisabled, 'retained failed count does not enable Retry during an active owner document job');
      await win.webContents.executeJavaScript('document.getElementById("indexing-cancel-btn").focus(); document.getElementById("indexing-cancel-btn").click()');
      await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 30))');
      view = await inspect();
      assert(ownerCancelCount === 1 && view.focus === 'indexing-cancel-btn',
        'owner document cancel uses private IPC and preserves focus');
      ownerSnapshot = { state: 'indexing', active: true, phase: 'ann', jobId: 'owner-ann' };
      await update(composeIndexingStatusPayload({ state: 'ready', indexingWorker: null,
        failedCount: 0, rebuildSession: null }, ownerSnapshot, true));
      view = await inspect();
      assert(!view.cancelDisabled, 'ANN_BUILDING offers the AC-15 safe private Cancel action');
      await win.webContents.executeJavaScript('document.getElementById("indexing-cancel-btn").focus(); document.getElementById("indexing-cancel-btn").click()');
      await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 30))');
      view = await inspect();
      assert(ownerCancelCount === 2 && view.focus === 'indexing-cancel-btn',
        'ANN_BUILDING Cancel targets its owner job and retains focus');
      ownerSnapshot = { state: 'clearing', active: true, kind: 'clear', jobId: 'owner-clear', phase: 'scan' };
      await update(composeIndexingStatusPayload({ state: 'ready', indexingWorker: null,
        failedCount: 0, rebuildSession: null },
      ownerSnapshot, true));
      view = await inspect();
      assert(view.cancelDisabled, 'owner clear cannot use Cancel outside the P0 safe-cancel matrix');
      await win.webContents.executeJavaScript('document.getElementById("indexing-cancel-btn").click()');
      assert(ownerCancelCount === 2, 'owner clear does not invoke private cancel from Settings');
      const directClearCancel = await win.webContents.executeJavaScript('window.doclight.cancelIndexingJob()');
      assert(directClearCancel.cancelled === false && ownerCancelCount === 2,
        'direct private Settings cancel rejects owner clear without touching the job');
      await update(composeIndexingStatusPayload({ state: 'ready', indexingWorker: null,
        failedCount: 0, rebuildSession: null }, { state: 'stale', active: false, phase: 'failed' }, true));
      view = await inspect();
      assert(!view.retryDisabled, 'owner keyword degradation offers supported private retry');
      await win.webContents.executeJavaScript('document.getElementById("indexing-retry-btn").focus(); document.getElementById("indexing-retry-btn").click()');
      await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 30))');
      view = await inspect();
      assert(ownerRetryCount === 1 && view.focus === 'indexing-retry-btn',
        `owner degraded retry uses private IPC and preserves focus (calls=${ownerRetryCount}, focus=${view.focus})`);
      phase('settings-owner-actions');
      await update({ ledgerState: 'NOT_CONFIGURED', ledgerCode: STATES.NOT_CONFIGURED,
        state: 'storage-not-configured', sourceRootConfigured: false });
      view = await inspect();
      assert(view.manageDisabled && view.openDirDisabled
        && !view.storePathDisabled && !view.storeBrowseDisabled,
      'unconfigured Settings keeps the store configuration controls available and blocks index actions');
      await win.loadFile(path.join(__dirname, '../../../src/renderer/viewer.html'));
      phase('viewer-loaded');
      await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 50))');
      win.webContents.send('render-markdown', { markdown: '# Saved note', source: 'paste' });
      await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 30))');
      const triggerSaveShortcut = (key, modifiers, unrelatedMutation = false) => win.webContents.executeJavaScript(`new Promise(resolve => {
        const previousToast = document.querySelector('.viewer-toast');
        const observer = new MutationObserver(() => {
          const toast = document.querySelector('.viewer-toast');
          if (!toast || toast === previousToast || !toast.textContent) return;
          clearTimeout(deadline);
          observer.disconnect();
          resolve(toast.textContent);
        });
        observer.observe(document.body, { childList: true, subtree: true });
        const deadline = setTimeout(() => { observer.disconnect(); resolve(''); }, 3000);
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: ${JSON.stringify(key)}, ...${JSON.stringify(modifiers)}, bubbles: true
        }));
        if (${unrelatedMutation}) {
          const unrelated = document.createElement('span');
          document.body.appendChild(unrelated);
          unrelated.remove();
        }
      })`);
      const triggerQuickSave = () => triggerSaveShortcut('s', { ctrlKey: true, altKey: true });
      const triggerSaveAs = unrelatedMutation => triggerSaveShortcut('S',
        { ctrlKey: true, shiftKey: true }, unrelatedMutation);
      for (let index = 0; index < 1024; index += 1)
        fs.writeFileSync(path.join(ingressRoot, `${String(index).padStart(4, '0')}.intent.json`), 'x');
      let toast = await triggerQuickSave();
      assert(toast === localeStrings.en['viewer.saveCapacityFailed'],
        `viewer shows localized save failure at real ingress capacity: ${JSON.stringify(toast)}`);
      assert(lastSaveReply.success === false && lastSaveReply.errorCode === 'indexing_ingress_capacity'
        && !lastSaveReply.indexingState && !lastSaveReply.jobId
        && fs.readdirSync(documentRoot).length === 0,
      'full private ingress rejects real quick-save before Markdown publication');
      const verifiedCapacityReply = { ...lastSaveReply };
      let releaseSaveAsDialog;
      saveAsDialogGate = new Promise(resolve => { releaseSaveAsDialog = resolve; });
      const saveAsCompletionsBefore = realSaveAsCompletions;
      let saveAsToastResolved = false;
      const saveAsToastPending = triggerSaveAs(true).then(value => {
        saveAsToastResolved = true;
        return value;
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      const prematureToast = saveAsToastResolved;
      releaseSaveAsDialog();
      saveAsDialogGate = null;
      const saveAsToast = await saveAsToastPending;
      assert(!prematureToast && realSaveAsCompletions === saveAsCompletionsBefore + 1,
        'save-as feedback waits for its own completed IPC and newly created toast');
      assert(saveAsToast === localeStrings.en['viewer.saveCapacityFailed']
        && lastSaveReply.success === false
        && lastSaveReply.errorCode === 'indexing_ingress_capacity'
        && !lastSaveReply.indexingState && !lastSaveReply.jobId
        && fs.readdirSync(documentRoot).length === 0,
      'selected save-as path reaches actual viewer feedback and rejects before publication');
      phase('capacity-save-and-save-as');
      for (let index = 0; index < 1024; index += 1)
        fs.unlinkSync(path.join(ingressRoot, `${String(index).padStart(4, '0')}.intent.json`));
      saveAcceptance = null;
      toast = await triggerQuickSave();
      assert(/saved/i.test(toast) && /indexing could not be queued/i.test(toast) && toast.includes(documentRoot)
        && !/save failed/i.test(toast) && lastSaveReply.indexingState === 'enqueue_failed',
      `post-publication owner failure still reports Saved with separate indexing failure: ${JSON.stringify(toast)}`);
      assert(publishedIntent?.published === true && fs.readFileSync(path.join(documentRoot,
        publishedIntent.sourceRelativeLocator), 'utf8').includes('# Saved note'),
      'post-publication owner failure retains Markdown and its durable retry intent');
      saveAcceptance = { accepted: true, indexingState: 'queued',
        indexing: { state: 'queued', jobId: 'job-s21b-committed' } };
      toast = await triggerQuickSave();
      assert(/saved/i.test(toast) && /queued/i.test(toast) && toast.includes(documentRoot),
        'viewer shows queued indexing and retains saved path');
      const ledgerPath = path.join(saveRoot, 'ledger.sqlite');
      const keywordPath = path.join(saveRoot, 'keyword.sqlite');
      const ledger = new SourceLedgerStore({ dbPath: ledgerPath });
      ledger.initialize();
      ledger.open().exec(`CREATE TRIGGER s21b_fail_job BEFORE INSERT ON index_jobs
        BEGIN SELECT RAISE(ABORT, 's21b owner transaction fault'); END`);
      ledger.close();
      realSaveOwner = new OwnerWorkerController({ ledgerPath, keywordPath,
        sourceRoot: documentRoot, ingressRoot, keywordTokenizerProvider: 'basic',
        deriveDocuments: false, r3SkipStartupReplay: true });
      await realSaveOwner.start();
      saveSearch.ownerController = realSaveOwner;
      win.webContents.send('render-markdown', { markdown: '# Saved through real failed owner', source: 'paste' });
      await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 30))');
      toast = await triggerQuickSave();
      assert(lastSaveReply.success === true && lastSaveReply.indexingState === 'enqueue_failed'
        && !Object.hasOwn(lastSaveReply, 'jobId') && /saved/i.test(toast)
        && /indexing could not be queued/i.test(toast)
        && fs.readFileSync(lastSaveReply.filePath, 'utf8').includes('# Saved through real failed owner'),
      'real owner transaction fault after publication leaves viewer Saved and omits jobId');
      const failedHash = crypto.createHash('sha256').update(fs.readFileSync(lastSaveReply.filePath)).digest('hex');
      const failedIntent = fs.readdirSync(ingressRoot).filter(name => name.endsWith('.intent.json'))
        .map(name => readPendingSave({ storeRoot: documentRoot, ingressRoot,
          intentId: name.slice(0, 64) }))
        .find(intent => intent?.published === true && intent.contentHash === failedHash);
      assert(failedIntent?.sourceRelativeLocator === path.basename(lastSaveReply.filePath),
      'real owner transaction failure retains the published retry intent for the saved viewer file');
      phase('owner-fault-and-save-feedback');
      const localeEvidence = [];
      const realCallsBeforeLocaleReplay = realQuickSaveCalls;
      localizedCapacityReply = verifiedCapacityReply;
      try {
      for (const code of ['ko', 'en', 'ja', 'es']) {
        locale = code;
        process.env.DOCULIGHT_LOCALE = code.toUpperCase();
        const selected = productLocale(['electron', 'app'], process.env);
        assert(selected === code, `${code} DOCULIGHT_LOCALE reaches the product locale selector`);
        stringsLoader.init(selected);
        assert(stringsLoader.getAll().locale === code,
          `${code} actual Electron strings loader selects the requested locale`);
        snapshot = { state: 'ready', ledgerState: 'READY', ledgerCode: STATES.READY,
          ledgerOwnerActive: false, sourceRootConfigured: true, failedCount: 0 };
        await win.loadFile(path.join(__dirname, '../../../src/renderer/settings.html'));
        await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 50))');
        await win.webContents.executeJavaScript('document.getElementById("indexing-manage-btn").click()');
        await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 30))');
        const stateView = await inspect();
        assert(stateView.text.includes(localeStrings[code]['settings.ledger.state.READY'])
          && stateView.role === 'status' && stateView.live === 'polite' && stateView.atomic === 'true',
        `${code} real Settings renderer uses its localized live status`);
        localeEvidence.push({ locale: code, mode: 'verified-reply-rendering',
          text: stateView.text, role: stateView.role,
          live: stateView.live, atomic: stateView.atomic, focus: stateView.focus });
        snapshot = { ...snapshot, ledgerCondition: 'indexing_ingress_capacity' };
        await win.webContents.executeJavaScript('document.getElementById("indexing-manage-btn").click()');
        await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 30))');
        const capacityState = await inspect();
        assert(capacityState.text.includes(localeStrings[code]['settings.ledger.state.READY'])
          && capacityState.text.includes(localeStrings[code]['settings.ledger.saveCapacity']),
          `${code} Settings renders both state and historical capacity failure notice`);
        localeEvidence[localeEvidence.length - 1].capacityStatus = capacityState.text;
        snapshot = { ...snapshot, ledgerCondition: null };
        await win.loadFile(path.join(__dirname, '../../../src/renderer/viewer.html'));
        win.webContents.send('render-markdown', { markdown: '# Localized capacity save', source: 'paste' });
        await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 30))');
        const documentCount = fs.readdirSync(documentRoot).length;
        const capacityToast = await triggerQuickSave();
        assert(capacityToast === localeStrings[code]['viewer.saveCapacityFailed']
          && lastSaveReply.success === false
          && lastSaveReply.errorCode === 'indexing_ingress_capacity'
          && fs.readdirSync(documentRoot).length === documentCount
          && realQuickSaveCalls === realCallsBeforeLocaleReplay,
        `${code} viewer renders the verified capacity reply without a new ingress call`);
        localeEvidence[localeEvidence.length - 1].capacityToast = capacityToast;
      }
      } finally {
        localizedCapacityReply = null;
      }
      console.error(`S21B_LOCALE_SNAPSHOTS ${JSON.stringify(localeEvidence)}`);
      phase('four-locale-snapshots');
      const explicit = productLocale(['electron', 'app', 'locale', 'ja'],
        { DOCULIGHT_LOCALE: 'ko' });
      stringsLoader.init(explicit);
      assert(explicit === 'ja' && stringsLoader.getAll().locale === 'ja',
        'explicit locale keyword takes precedence over DOCULIGHT_LOCALE');
    } finally {
      if (priorLocaleEnv === undefined) delete process.env.DOCULIGHT_LOCALE;
      else process.env.DOCULIGHT_LOCALE = priorLocaleEnv;
      if (realSaveOwner) await realSaveOwner.shutdown();
      win.destroy();
      for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
    }
  }
};
