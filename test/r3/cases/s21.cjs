'use strict';

const path = require('node:path');
const { BrowserWindow, ipcMain } = require('electron');
const { SearchEngine } = require('../../../src/main/search-engine');
const { composeIndexingStatusPayload } = require('../../../src/main/ledger-status-registry');

// @req IR-APP-013 IR-APP-010 FR-APP-006 FR-APP-007 FR-DOC-019 REL-DOC-009
module.exports = {
  name: 's21',
  async run({ assert }) {
    const strings = require('../../../src/locales/en.json');
    let snapshot = { state: 'ready', ledgerState: 'READY', ledgerCode: 'ledger_ready',
      ledgerPhase: null, ledgerProgress: 0, sourceRootConfigured: true };
    let cancelCount = 0;
    let retryCount = 0;
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
    let saveResult = { success: true, filePath: 'C:\\store\\note.md', indexingState: 'enqueue_failed',
      warningCode: 'indexing_ingress_capacity' };
    const handlers = {
      'get-strings': () => ({ strings, locale: 'en' }),
      'get-settings': () => ({ mcpAutoSavePath: 'C:\\store' }),
      'indexing:get-status': () => snapshot,
      'get-file-association-status': () => ({ registered: false }),
      'check-port-available': () => true,
      'indexing:cancel-job': () => { cancelCount += 1; return SearchEngine.prototype.cancelRebuild.call(legacyEngine); },
      'indexing:retry-failures': () => { retryCount += 1; return SearchEngine.prototype.retryFailures.call(legacyEngine); },
      'quick-save': () => saveResult
    };
    for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);
    const win = new BrowserWindow({ show: true, webPreferences: {
      preload: path.join(__dirname, '../../../src/main/preload.js'), contextIsolation: true, nodeIntegration: false
    } });
    try {
      await win.loadFile(path.join(__dirname, '../../../src/renderer/settings.html'));
      await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 50))');
      const inspect = () => win.webContents.executeJavaScript(`({
        text: document.getElementById('indexing-status').textContent,
        role: document.getElementById('indexing-status').getAttribute('role'),
        live: document.getElementById('indexing-status').getAttribute('aria-live'),
        atomic: document.getElementById('indexing-status').getAttribute('aria-atomic'),
        alert: document.getElementById('indexing-error').getAttribute('role'),
        diagnostic: document.getElementById('indexing-error').textContent,
        retryDisabled: document.getElementById('indexing-retry-btn').disabled,
        cancelDisabled: document.getElementById('indexing-cancel-btn').disabled,
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
      const at100 = await announcementCount();
      await update({ heartbeatAt: 'still later', ledgerProgress: 100 });
      assert(await announcementCount() === at100, 'terminal 100% does not repeat on heartbeat');
      await update({ ledgerState: 'READY_KEYWORD_DEGRADED', state: 'degraded', ledgerCode: 'keyword_index_unavailable',
        ledgerCondition: 'indexing_ingress_capacity', ledgerProgress: 0 });
      view = await inspect();
      assert(/deferred|capacity/i.test(view.text) && !/saved|save failed/i.test(view.text),
        'status-only capacity guidance does not invent a document save receipt');
      await update({ ledgerState: 'CORRUPT_DEGRADED', ledgerCode: 'ledger_recovery_required', ledgerCondition: null });
      view = await inspect();
      assert(view.retryDisabled && view.alert === null, 'recovery state does not offer unsupported legacy retry');
      await win.webContents.executeJavaScript('document.getElementById("indexing-retry-btn").click()');
      assert(retryCount === 0, 'disabled canonical retry does not invoke the legacy rebuild IPC');
      await update({ ledgerState: 'OWNER_EXIT_BLOCKED', ledgerCode: 'ledger_owner_exit_blocked', ledgerCondition: null });
      view = await inspect();
      assert(view.alert === 'alert' && /restart|support/i.test(view.text), 'unrecoverable ledger state exposes localized restart/support alert');
      await update({ ledgerState: 'CHECKING', state: 'checking', ledgerCode: 'ledger_checking' });
      view = await inspect();
      assert(view.cancelDisabled, 'checking does not offer unsupported legacy cancel');
      await win.webContents.executeJavaScript('document.getElementById("indexing-cancel-btn").click()');
      assert(cancelCount === 0, 'disabled canonical cancel does not invoke the legacy cancel IPC');
      legacyRebuildActive = true;
      await update(composeIndexingStatusPayload({ state: 'rebuilding', failedCount: 0,
        rebuildSession: { active: true, indexedCount: 0, pendingCount: 1 } }, { state: 'ready' }, true));
      view = await inspect();
      assert(/rebuild/i.test(view.text) && !/ready/i.test(view.text),
        'active legacy rebuild is announced ahead of parallel owner READY');
      await update({ ledgerCondition: 'indexing_ingress_capacity' });
      view = await inspect();
      assert(/rebuild/i.test(view.text) && /deferred/i.test(view.text) && !/saved/i.test(view.text),
        'active legacy copy retains a concurrent owner capacity condition without inventing a save');
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
      assert(!view.cancelDisabled, 'non-rebuild active legacy worker retains supported cancel');
      await win.webContents.executeJavaScript('document.getElementById("indexing-cancel-btn").focus(); document.getElementById("indexing-cancel-btn").click()');
      await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 30))');
      view = await inspect();
      assert(cancelCount === 1 && view.focus === 'indexing-cancel-btn',
        'non-rebuild cancel reaches real SearchEngine.cancelRebuild and preserves focus');
      legacyWorkerActive = false;
      await update(composeIndexingStatusPayload({ state: 'degraded', rebuildSession: null, failedCount: 1 },
        { state: 'ready' }, true));
      view = await inspect();
      assert(!view.retryDisabled, 'real-shaped mixed payload preserves legacy failed-file retry');
      await win.webContents.executeJavaScript('document.getElementById("indexing-retry-btn").click()');
      await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 30))');
      view = await inspect();
      assert(retryCount === 1 && /could not be completed/i.test(view.diagnostic),
        'legacy retry routes to SearchEngine.retryFailures and leaves not-started result visible');
      await win.loadFile(path.join(__dirname, '../../../src/renderer/viewer.html'));
      await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 50))');
      win.webContents.send('render-markdown', { markdown: '# Saved note', source: 'paste' });
      await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 30))');
      const triggerQuickSave = () => win.webContents.executeJavaScript(`new Promise(resolve => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, altKey: true, bubbles: true }));
        setTimeout(() => resolve(document.querySelector('.viewer-toast')?.textContent || ''), 40);
      })`);
      let toast = await triggerQuickSave();
      assert(/saved/i.test(toast) && /deferred/i.test(toast) && /note\.md/i.test(toast) && !/save failed/i.test(toast),
        'viewer keeps saved success distinct from capacity-deferred indexing');
      saveResult = { success: true, filePath: 'C:\\store\\note.md', indexingState: 'queued' };
      toast = await triggerQuickSave();
      assert(/saved/i.test(toast) && /queued/i.test(toast) && /note\.md/i.test(toast),
        'viewer shows queued indexing and retains saved path');
    } finally {
      win.destroy();
      for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
    }
  }
};
