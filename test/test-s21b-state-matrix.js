'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { STATES, fromOwnerSnapshot, composeIndexingStatusPayload } = require('../src/main/ledger-status-registry');
const { OwnerWorkerController } = require('../src/main/search-owner-controller');

// @req IR-APP-013 AC-2 AC-3 AC-11 AC-14 AC-15 AC-16 FR-APP-006 FR-APP-007 IR-APP-005
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/settings.js'), 'utf8');
const start = source.indexOf('  function renderIndexingStatus(status) {');
const end = source.indexOf('  async function refreshIndexingStatus()', start);
assert(start >= 0 && end > start, 'actual Settings render function is available for the matrix');
const renderSource = `${source.slice(start, end)}\nrenderIndexingStatus`;
const diagnosticStart = source.indexOf('  function formatIndexingDiagnostic(message) {');
const diagnosticEnd = source.indexOf('  function formatIndexingDisplayPath(', diagnosticStart);
assert(diagnosticStart >= 0 && diagnosticEnd > diagnosticStart,
  'actual Settings diagnostic redactor is available for the matrix');
const diagnosticSource = `${source.slice(diagnosticStart, diagnosticEnd)}\nformatIndexingDiagnostic`;
const readyActions = new Set(['READY', 'READY_KEYWORD_ONLY', 'READY_MAINTENANCE_PENDING']);
const cancelActions = new Set(['CHECKING', 'KEYWORD_REPAIRING', 'ANN_BUILDING']);
const retryCheckActions = new Set(['CORRUPT_DEGRADED', 'INTERRUPTED']);
const restartGuidance = new Set(['CHECKER_EXIT_PENDING', 'CHECKER_EXIT_BLOCKED',
  'OWNER_EXIT_PENDING', 'OWNER_EXIT_BLOCKED', 'INTERRUPTED']);
const supportGuidance = new Set(['CHECKER_EXIT_BLOCKED', 'OWNER_EXIT_BLOCKED',
  'ROLLBACK_REQUIRED']);
const guidanceWords = {
  ko: { restart: /다시 시작|재시작/, support: /지원팀/ },
  en: { restart: /restart/i, support: /support/i },
  ja: { restart: /再起動/, support: /サポート/ },
  es: { restart: /reinici/i, support: /soporte/i }
};
const configureRecoveryWords = {
  ko: /문서 저장소를 설정/,
  en: /set a document store/i,
  ja: /文書ストアを設定/,
  es: /Configure un almacén de documentos/i
};
const futurePhase = new Set(['BACKING_UP', 'BACKUP_RECOVERING', 'MIGRATION_BLOCKED', 'MIGRATING',
  'VERIFYING_FULL', 'VERIFYING_KEYWORD_ISOLATED', 'RESTORE_FINALIZING', 'RESTORING', 'ROLLBACK_REQUIRED']);
const element = () => ({ _textContent: '', textWrites: 0,
  get textContent() { return this._textContent; },
  set textContent(value) { this._textContent = value; this.textWrites += 1; },
  disabled: false, className: '', attributes: {},
  setAttribute(name, value) { this.attributes[name] = value; },
  removeAttribute(name) { delete this.attributes[name]; },
  classList: { toggle() {} } });
const locales = ['ko', 'en', 'ja', 'es'];
const sourceStates = ['ready', 'rebuilding', 'indexing', 'queued', 'compacting', 'clearing',
  'degraded', 'stale', 'uninitialized', 'unavailable', 'native-checking', 'native-repairing'];
const safeRebuildStatus = composeIndexingStatusPayload({ state: 'stale',
  errorSummary: 'Search index requires an explicit rebuild from Settings.' }, null, true);
assert.equal(safeRebuildStatus.errorSummary, 'index_rebuild_required',
  'known safe rebuild guidance becomes a canonical diagnostic code');
let cells = 0;
let actionCells = 0;
for (const locale of locales) {
  const strings = require(`../src/locales/${locale}.json`);
  const diagnosticFormatter = vm.runInNewContext(diagnosticSource,
    { t: key => strings[key] || key });
  assert.equal(diagnosticFormatter('index_rebuild_required'), strings['settings.indexingRebuildDescription'],
    `${locale} canonical rebuild diagnostic resolves through localized strings`);
  assert.equal(diagnosticFormatter('native_reinstall_required'), strings['settings.indexingNativeModuleMismatch'],
    `${locale} native repair code resolves through localized strings`);
  for (const [reason, key] of [
    ['job-in-progress', 'settings.indexingActionBusy'],
    ['check-not-available', 'settings.indexingCheckUnavailable'],
    ['open-failed', 'settings.indexingOpenDirFailed']
  ]) {
    assert.equal(diagnosticFormatter(reason), strings[key],
      `${locale} private ${reason} reason resolves through localized strings`);
  }
  assert(!/rebuild|reconstruction|reconstrucci[oó]n|再作成|다시 만들기/i.test(
    strings['settings.indexingCancelDescription']),
  `${locale} Cancel guidance does not promise stopping a disabled rebuild`);
  for (const [ledgerState] of Object.entries(STATES)) {
    const label = strings[`settings.ledger.state.${ledgerState}`];
    assert(label && !label.includes('undefined'), `${locale}/${ledgerState} has localized guidance`);
    assert.equal(guidanceWords[locale].restart.test(label), restartGuidance.has(ledgerState),
      `${locale}/${ledgerState} restart guidance matches the P0 matrix`);
    assert.equal(guidanceWords[locale].support.test(label), supportGuidance.has(ledgerState),
      `${locale}/${ledgerState} support guidance matches the P0 matrix`);
    assert.equal(configureRecoveryWords[locale].test(label), ledgerState === 'NOT_CONFIGURED',
      `${locale}/${ledgerState} index-health configure guidance is exclusive to NOT_CONFIGURED`);
  }
  for (const [ledgerState, ledgerCode] of Object.entries(STATES)) {
    for (const sourceState of sourceStates) {
      const nodes = Object.fromEntries(['indexingStatusEl', 'indexingErrorEl', 'indexingIndexedCountEl',
        'indexingPendingCountEl', 'indexingFailedCountEl', 'indexingPhaseEl', 'indexingManageBtn',
        'indexingCancelBtn', 'indexingRebuildBtn', 'indexingRetryBtn', 'indexingRetryCheckBtn',
        'indexingCompactBtn', 'indexingOpenDirBtn'].map(name => [name, element()]));
      const context = { ...nodes, document: { activeElement: null },
        indexingActionNotice: null, indexingActionRequest: null, lastLedgerAnnouncement: null,
        lastIndexingStatus: null,
        t(key, vars) { let value = strings[key] || key;
          for (const [name, replacement] of Object.entries(vars || {}))
            value = value.replaceAll(`{${name}}`, String(replacement));
          return value; },
        isNativeRepairActive: repair => repair?.active === true,
        isIndexingWorkerActive: value => ['rebuilding', 'indexing', 'queued', 'compacting',
          'clearing', 'checking', 'repairing'].includes(value),
        isFullRebuildActive: status => status.rebuildSession?.active === true,
        formatProgressPercent: () => null,
        formatIndexingDisplayPath: value => path.basename(value),
        setIndexingDiagnostic(message) { nodes.indexingErrorEl.textContent = context.formatIndexingDiagnostic(message); },
        hasSavedDocumentStorePath: () => true };
      context.formatIndexingDiagnostic = vm.runInNewContext(diagnosticSource, context);
      const render = vm.runInNewContext(renderSource, context);
      const owner = { state: ledgerState, active: cancelActions.has(ledgerState),
        phase: ledgerState === 'ANN_BUILDING' ? 'ann' : 'index_document', jobId: 'job-matrix' };
      const canonical = fromOwnerSnapshot(owner, true);
      assert.equal(canonical.ledgerCode, ledgerCode, `${ledgerState} maps to its unique code`);
      const nativeState = sourceState.startsWith('native-') ? sourceState.slice(7) : null;
      const publicState = nativeState ? 'ready' : sourceState;
      const publicStatus = { state: publicState, indexedCount: 0, pendingCount: 0,
        failedCount: 0, indexingWorker: ['indexing', 'queued', 'compacting'].includes(sourceState)
          ? { active: true, kind: sourceState === 'compacting' ? 'compact' : 'index' } : null,
        rebuildSession: sourceState === 'rebuilding' ? { active: true, indexedCount: 0, pendingCount: 1 } : null,
        nativeRepair: nativeState ? { state: nativeState, active: true } : null,
        errorSummary: 'C:\\private\\s21b-secret\\ledger.sqlite3',
        sourceRelativePath: 's21b-secret/ledger.sqlite3',
        failedFiles: [{ filePath: 'C:\\private\\s21b-secret\\failed.md',
          error: 'C:\\private\\s21b-secret\\failed.md' }] };
      const status = composeIndexingStatusPayload(publicStatus, owner, true);
      assert(!JSON.stringify(status).includes('s21b-secret')
        && !Object.hasOwn(status, 'sourceRelativePath'),
      `${locale}/${ledgerState}/${sourceState} private status payload redacts paths before IPC`);
      render(status);
      const legacyActive = Boolean(nativeState) || ['rebuilding', 'indexing', 'queued',
        'compacting', 'clearing'].includes(sourceState);
      assert.equal(context.lastIndexingStatus.ledgerCode, ledgerCode,
        `${locale}/${ledgerState}/${sourceState} keeps the canonical code parallel to public state`);
      assert(nodes.indexingStatusEl.textContent.includes(legacyActive
        ? strings[`settings.legacyState.${nativeState || sourceState}`]
        : strings[`settings.ledger.state.${ledgerState}`]),
      `${locale}/${ledgerState}/${sourceState} renders the expected translated status`);
      assert.equal(nodes.indexingManageBtn.disabled, false,
        `${locale}/${ledgerState}/${sourceState} configured store keeps Settings open`);
      assert.equal(nodes.indexingOpenDirBtn.disabled, false,
        `${locale}/${ledgerState}/${sourceState} configured store can open diagnostic folder`);
      actionCells += 2;
      if (!legacyActive) {
        const p0Actions = {
          rebuild: [nodes.indexingRebuildBtn, readyActions.has(ledgerState)
            || ledgerState === 'READY_KEYWORD_DEGRADED'],
          compact: [nodes.indexingCompactBtn, readyActions.has(ledgerState)],
          cancel: [nodes.indexingCancelBtn, cancelActions.has(ledgerState)],
          retryCheck: [nodes.indexingRetryCheckBtn, retryCheckActions.has(ledgerState)],
          keywordRetry: [nodes.indexingRetryBtn, ledgerState === 'READY_KEYWORD_DEGRADED']
        };
        for (const [action, [button, allowed]] of Object.entries(p0Actions)) {
          assert.equal(button.disabled, !allowed,
            `${locale}/${ledgerState}/P0 ${action} action disposition`);
          actionCells += 1;
        }
      } else {
        for (const [action, button] of Object.entries({ rebuild: nodes.indexingRebuildBtn,
          compact: nodes.indexingCompactBtn, keywordRetry: nodes.indexingRetryBtn,
          retryCheck: nodes.indexingRetryCheckBtn })) {
          assert.equal(button.disabled, true,
            `${locale}/${ledgerState}/${sourceState} blocks ${action} during active native or public work`);
          actionCells += 1;
        }
        const safeCancel = cancelActions.has(ledgerState)
          && !['rebuilding', 'clearing', 'native-checking', 'native-repairing'].includes(sourceState);
        assert.equal(nodes.indexingCancelBtn.disabled, !safeCancel,
          `${locale}/${ledgerState}/${sourceState} permits Cancel only in the three AC-15 states`);
        actionCells += 1;
      }
      if (futurePhase.has(ledgerState) && !legacyActive) {
        assert(nodes.indexingRebuildBtn.disabled && nodes.indexingCompactBtn.disabled
          && nodes.indexingRetryCheckBtn.disabled && nodes.indexingCancelBtn.disabled,
        `${ledgerState} P1-only state dispatches no P0 Settings maintenance action`);
      }
      assert.equal(context.document.activeElement, null, 'render does not move focus');
      assert(!nodes.indexingErrorEl.textContent.includes('s21b-secret'),
        `${locale}/${ledgerState}/${sourceState} diagnostic does not expose the private path`);
      if (!legacyActive) {
        const announced = nodes.indexingStatusEl.textWrites;
        render({ ...status, heartbeatAt: 'later' });
        assert.equal(nodes.indexingStatusEl.textWrites, announced,
          `${locale}/${ledgerState} heartbeat-only polling does not announce`);
        render({ ...status, ledgerProgress: 21 });
        assert.equal(nodes.indexingStatusEl.textWrites, announced + 1,
          `${locale}/${ledgerState} new progress bucket announces once`);
        render({ ...status, ledgerProgress: 25, heartbeatAt: 'still later' });
        assert.equal(nodes.indexingStatusEl.textWrites, announced + 1,
          `${locale}/${ledgerState} same 10% bucket does not announce`);
        render({ ...status, ledgerProgress: 31 });
        assert.equal(nodes.indexingStatusEl.textWrites, announced + 2,
          `${locale}/${ledgerState} next 10% bucket announces once`);
        render({ ...status, ledgerProgress: 100 });
        render({ ...status, ledgerProgress: 100, heartbeatAt: 'terminal heartbeat' });
        assert.equal(nodes.indexingStatusEl.textWrites, announced + 3,
          `${locale}/${ledgerState} terminal 100% announces once`);
        const nextState = ledgerState === 'READY' ? 'READY_KEYWORD_ONLY' : 'READY';
        render({ ...status, ledgerState: nextState, ledgerCode: STATES[nextState],
          ledgerProgress: 100 });
        assert.equal(nodes.indexingStatusEl.textWrites, announced + 4,
          `${locale}/${ledgerState} canonical state/code transition announces once`);
        render({ ...status, ledgerCondition: 'indexing_ingress_capacity', ledgerProgress: 100 });
        assert(nodes.indexingStatusEl.textContent.includes(strings[`settings.ledger.state.${ledgerState}`])
          && nodes.indexingStatusEl.textContent.includes(strings['settings.ledger.saveCapacity']),
        `${locale}/${ledgerState} keeps the state label alongside historical capacity guidance`);
        const beforeCapacityTransition = nodes.indexingStatusEl.textWrites;
        render({ ...status, ledgerState: nextState, ledgerCode: STATES[nextState],
          ledgerCondition: 'indexing_ingress_capacity', ledgerProgress: 100 });
        assert(nodes.indexingStatusEl.textContent.includes(strings[`settings.ledger.state.${nextState}`])
          && nodes.indexingStatusEl.textContent.includes(strings['settings.ledger.saveCapacity'])
          && nodes.indexingStatusEl.textWrites === beforeCapacityTransition + 1,
        `${locale}/${ledgerState} capacity warning does not mask the next state announcement`);
      }
      cells += 1;
    }
  }
}
assert.equal(cells, 1440, '30 states x 12 public/native source states x 4 locales are covered');
assert.equal(actionCells, 10080, '30 states x 4 locales x 12 source-state P0 actions and folder controls are covered');
assert.equal(new Set(Object.values(STATES)).size, 30, 'canonical code collisions are zero');
let overlapCells = 0;
for (const locale of locales) {
  const strings = require(`../src/locales/${locale}.json`);
  for (const ledgerState of Object.keys(STATES)) {
    for (const nativeState of ['checking', 'repairing']) {
      for (const sourceState of ['rebuilding', 'indexing', 'queued', 'compacting', 'clearing']) {
        const nodes = Object.fromEntries(['indexingStatusEl', 'indexingErrorEl',
          'indexingIndexedCountEl', 'indexingPendingCountEl', 'indexingFailedCountEl',
          'indexingPhaseEl', 'indexingManageBtn', 'indexingCancelBtn',
          'indexingRebuildBtn', 'indexingRetryBtn', 'indexingRetryCheckBtn',
          'indexingCompactBtn', 'indexingOpenDirBtn'].map(name => [name, element()]));
        const context = { ...nodes, document: { activeElement: null },
          indexingActionNotice: null, indexingActionRequest: null,
          lastLedgerAnnouncement: null, lastIndexingStatus: null,
          t(key, vars) { let value = strings[key] || key;
            for (const [name, replacement] of Object.entries(vars || {}))
              value = value.replaceAll(`{${name}}`, String(replacement));
            return value; },
          isNativeRepairActive: repair => repair?.active === true,
          isIndexingWorkerActive: value => ['rebuilding', 'indexing', 'queued',
            'compacting', 'clearing', 'checking', 'repairing'].includes(value),
          isFullRebuildActive: status => status.rebuildSession?.active === true,
          formatProgressPercent: () => null,
          formatIndexingDisplayPath: value => path.basename(value),
          setIndexingDiagnostic() {}, hasSavedDocumentStorePath: () => true };
        const render = vm.runInNewContext(renderSource, context);
        const owner = { state: ledgerState, active: cancelActions.has(ledgerState),
          phase: 'index_document', jobId: 'job-overlap' };
        const sourceStatus = { state: sourceState,
          nativeRepair: { active: true, state: nativeState },
          indexingWorker: ['indexing', 'queued', 'compacting'].includes(sourceState)
            ? { active: true, kind: sourceState === 'compacting' ? 'compact' : 'index' } : null,
          rebuildSession: sourceState === 'rebuilding' ? { active: true } : null };
        const overlapStatus = composeIndexingStatusPayload(sourceStatus, owner, true);
        render(overlapStatus);
        assert(nodes.indexingStatusEl.textContent.includes(strings[`settings.legacyState.${nativeState}`]),
          `${locale}/${ledgerState}/${nativeState}+${sourceState} native status wins`);
        for (const button of [nodes.indexingCancelBtn, nodes.indexingRebuildBtn,
          nodes.indexingRetryBtn, nodes.indexingRetryCheckBtn, nodes.indexingCompactBtn]) {
          assert.equal(button.disabled, true,
            `${locale}/${ledgerState}/${nativeState}+${sourceState} blocks maintenance overlap`);
        }
        const initialWrites = nodes.indexingStatusEl.textWrites;
        render({ ...overlapStatus, ledgerProgress: 21 });
        assert(nodes.indexingStatusEl.textContent.includes(strings[`settings.ledger.state.${ledgerState}`])
          && nodes.indexingStatusEl.textContent.includes(strings['settings.ledger.progress'].replace('{percent}', '21'))
          && nodes.indexingStatusEl.textWrites === initialWrites + 1,
        `${locale}/${ledgerState}/${nativeState}+${sourceState} announces ledger progress under active legacy work`);
        render({ ...overlapStatus, ledgerProgress: 25 });
        assert.equal(nodes.indexingStatusEl.textWrites, initialWrites + 1,
          `${locale}/${ledgerState}/${nativeState}+${sourceState} same ledger bucket stays quiet`);
        render({ ...overlapStatus, ledgerProgress: 31 });
        assert.equal(nodes.indexingStatusEl.textWrites, initialWrites + 2,
          `${locale}/${ledgerState}/${nativeState}+${sourceState} next ledger bucket announces`);
        render({ ...overlapStatus, ledgerProgress: 100 });
        render({ ...overlapStatus, ledgerProgress: 100, heartbeatAt: 'later' });
        assert.equal(nodes.indexingStatusEl.textWrites, initialWrites + 3,
          `${locale}/${ledgerState}/${nativeState}+${sourceState} terminal ledger progress once`);
        const nextLedger = ledgerState === 'READY' ? 'READY_KEYWORD_ONLY' : 'READY';
        render({ ...overlapStatus, ledgerState: nextLedger, ledgerCode: STATES[nextLedger], ledgerProgress: 100 });
        assert(nodes.indexingStatusEl.textContent.includes(strings[`settings.ledger.state.${nextLedger}`])
          && nodes.indexingStatusEl.textWrites === initialWrites + 4,
        `${locale}/${ledgerState}/${nativeState}+${sourceState} announces parallel ledger state transition`);
        overlapCells += 1;
      }
    }
  }
}
assert.equal(overlapCells, 1200, '30 ledger x 2 native x 5 legacy indexing x 4 locales overlap');
const viewerSource = fs.readFileSync(path.join(__dirname, '../src/renderer/viewer.js'), 'utf8');
const viewerStart = viewerSource.indexOf('  function showSaveFeedback(result) {');
const viewerEnd = viewerSource.indexOf('  async function handleDeleteAutoSaved()', viewerStart);
assert(viewerStart >= 0 && viewerEnd > viewerStart, 'actual viewer save feedback is available');
async function checkViewerFeedback() {
  const outcomes = [
    { result: { success: false, error: 'ingress_capacity', errorCode: 'indexing_ingress_capacity' },
      expected: strings => strings['viewer.saveCapacityFailed'] },
    { result: { success: true, filePath: 'saved.md', indexingState: 'enqueue_failed' },
      expected: strings => `${strings['viewer.savedToast']}: saved.md. ${strings['viewer.indexingRetryable']}` },
    { result: { success: true, filePath: 'saved.md', indexingState: 'queued' },
      expected: strings => `${strings['viewer.savedToast']}: saved.md. ${strings['viewer.indexingQueued']}` },
    { result: { success: true, filePath: 'saved.md', warningCode: 'indexing_ingress_capacity' },
      expected: strings => `${strings['viewer.savedToast']}: saved.md. ${strings['viewer.indexingDeferred']}` },
    { result: { success: true, filePath: 'saved.md' },
      expected: strings => `${strings['viewer.savedToast']}: saved.md` }
  ];
  let feedbackCells = 0;
  for (const locale of locales) {
    const strings = require(`../src/locales/${locale}.json`);
    for (const outcome of outcomes) {
      for (const route of ['saveAs', 'quickSave']) {
        let shown = '';
        const context = { document: { title: 'Fixture', getElementById: () => ({ hasChildNodes: () => true }) },
          currentFilePath: null, originalContent: '# Fixture', saveAsFilePath: null,
          t: key => strings[key], showViewerToast: text => { shown = text; },
          window: { doclight: { [route]: async () => outcome.result } } };
        vm.runInNewContext(viewerSource.slice(viewerStart, viewerEnd), context);
        await context[route === 'saveAs' ? 'handleSaveAs' : 'handleQuickSave']();
        assert.equal(shown, outcome.expected(strings),
          `${locale}/${route}/${outcome.result.errorCode || outcome.result.indexingState || outcome.result.warningCode || 'saved'} viewer feedback`);
        feedbackCells += 1;
      }
    }
  }
  assert.equal(feedbackCells, 40, 'four locales x two viewer save routes x five save outcomes');
  return feedbackCells;
}
const mainSource = fs.readFileSync(path.join(__dirname, '../src/main/index.js'), 'utf8');
const statusStart = mainSource.indexOf('function getIndexingStatusPayload() {');
const statusEnd = mainSource.indexOf('function sanitizeSettingsPayload(', statusStart);
assert(statusStart >= 0 && statusEnd > statusStart, 'actual main status composer is available');
for (const nativeState of ['checking', 'failed', 'ready']) {
  const rawNative = { active: nativeState === 'checking', state: nativeState,
    phase: 'probe', progress: { current: 1, total: 2 },
    diagnostic: { code: 'native_unavailable',
      message: 'Cannot load /tmp/private/s21b-secret/ledger.sqlite3?token=rawsecret' },
    probe: { betterSqlite3: { state: 'native_unavailable',
      message: 'authorization: Bearer rawsecret /tmp/private/s21b-secret/probe.node' } } };
  const context = { searchEngine: { getStatus: () => ({ state: 'ready' }) },
    saveDocumentOwner: null, nativeRebuildManager: { getStatus: () => rawNative },
    isDocumentStoreSourceRootConfigured: () => true,
    require: () => require('../src/main/ledger-status-registry') };
  const getStatus = vm.runInNewContext(`${mainSource.slice(statusStart, statusEnd)}\ngetIndexingStatusPayload`, context);
  const privateStatus = getStatus();
  assert(!JSON.stringify(privateStatus).includes('s21b-secret')
    && !JSON.stringify(privateStatus).includes('rawsecret')
    && !Object.hasOwn(privateStatus.nativeRepair, 'probe'),
  `${nativeState} native repair status is sanitized after final composition`);
  assert.equal(privateStatus.nativeRepair.diagnostic.code, 'native_unavailable',
    `${nativeState} keeps the permitted diagnostic code`);
}
async function checkPrivateDisposition() {
  const feedbackCells = await checkViewerFeedback();
  const maintenanceStart = mainSource.indexOf('  const isIndexingWorkActive = status =>');
  const maintenanceEnd = mainSource.indexOf('  privateIndexMaintenance = startOwnerIndexMaintenance;', maintenanceStart);
  assert(maintenanceStart >= 0 && maintenanceEnd > maintenanceStart,
    'actual private maintenance dispatcher is available');
  const cancelStart = mainSource.indexOf("  ipcMain.handle('indexing:cancel-job'");
  const cancelEnd = mainSource.indexOf("  ipcMain.handle('indexing:retry-failures'", cancelStart);
  assert(cancelStart >= 0 && cancelEnd > cancelStart, 'actual private cancel handler is available');
  const retryCheckStart = mainSource.indexOf("  ipcMain.handle('indexing:retry-check'");
  const retryCheckEnd = mainSource.indexOf('  const futurePhaseIndexingAction =', retryCheckStart);
  assert(retryCheckStart >= 0 && retryCheckEnd > retryCheckStart,
    'actual private retry-check handler is available');
  const futureStart = mainSource.indexOf('  const futurePhaseIndexingAction = event =>');
  const futureEnd = mainSource.indexOf("  ipcMain.handle('indexing:compact'", futureStart);
  assert(futureStart >= 0 && futureEnd > futureStart,
    'P0 future-phase private dispatcher returns a result without owner work');
  const futureHandlers = new Map();
  let futureState = 'READY';
  vm.runInNewContext(mainSource.slice(futureStart, futureEnd), {
    ipcMain: { handle(name, handler) { futureHandlers.set(name, handler); } },
    settingsIndexingWindow: () => true,
    getIndexingStatusPayload: () => ({ ledgerState: futureState })
  });
  assert.equal(futureHandlers.size, 4, 'exactly four P1-only private routes are guarded');
  let privateCells = 0;
  const openDirStart = mainSource.indexOf("  ipcMain.handle('indexing:open-data-dir'");
  const openDirEnd = mainSource.indexOf("  ipcMain.handle('document-import:linked-markdown'", openDirStart);
  assert(openDirStart >= 0 && openDirEnd > openDirStart,
    'actual private open-data-dir dispatcher is available');
  for (const [ledgerState] of Object.entries(STATES)) {
    futureState = ledgerState;
    const ownerStatus = { state: ledgerState, active: cancelActions.has(ledgerState),
      phase: ledgerState === 'ANN_BUILDING' ? 'ann' : 'index_document', jobId: 'job-matrix' };
    const dispatched = [];
    const owner = { getStatus: () => ownerStatus,
      command: async (_type, payload) => { dispatched.push(payload.operation);
        return payload.operation === 'retry_check' ? { started: true, scheduled: true }
          : { started: true, scheduled: true, jobId: 'job-matrix' }; },
      cancel: async () => ({ cancelled: true }),
      cancelRetryCheck: async () => ({ cancelled: true }) };
    let publicStatus = { ledgerState, state: 'ready' };
    let configured = true;
    const context = { isDocumentStoreSourceRootConfigured: () => configured,
      searchEngine: { getSaveDocumentOwner: async () => owner,
        cancelRebuild: () => ({ cancelled: false }) },
      store: { get: () => 'configured-store' },
      getIndexingStatusPayload: () => publicStatus,
      require: () => ({ fromOwnerSnapshot }),
      saveDocumentOwner: owner, settingsIndexingWindow: () => true,
      ipcMain: { handle(_name, handler) { context.cancelHandler = handler; } } };
    const maintenanceFunctions = vm.runInNewContext(`${mainSource.slice(maintenanceStart, maintenanceEnd)}\n({ startOwnerIndexMaintenance, isIndexingWorkActive })`, context);
    context.isIndexingWorkActive = maintenanceFunctions.isIndexingWorkActive;
    const maintenance = maintenanceFunctions.startOwnerIndexMaintenance;
    for (const operation of ['rebuild', 'retry', 'compact', 'clear']) {
      const reply = await maintenance(operation);
      const allowed = (operation === 'compact' || operation === 'clear')
        ? readyActions.has(ledgerState)
        : readyActions.has(ledgerState) || ledgerState === 'READY_KEYWORD_DEGRADED';
      assert.equal(reply.started, allowed, `${ledgerState}/P0 ${operation} private dispatch`);
      assert.equal(reply.scheduled, allowed, `${ledgerState}/P0 ${operation} acceptance`);
      if (!allowed) assert(!reply.jobId, `${ledgerState}/P0 ${operation} denial has no jobId`);
      privateCells += 1;
    }
    configured = false;
    for (const operation of ['rebuild', 'retry', 'compact', 'clear']) {
      const before = dispatched.length;
      const denied = await maintenance(operation);
      assert(denied.started === false && denied.scheduled === false && !denied.jobId
        && dispatched.length === before,
      `${ledgerState}/unconfigured private ${operation} starts no work`);
      privateCells += 1;
    }
    configured = true;
    assert.equal(dispatched.length,
      ['rebuild', 'retry', 'compact', 'clear'].filter(operation =>
        operation === 'compact' || operation === 'clear'
          ? readyActions.has(ledgerState)
          : readyActions.has(ledgerState) || ledgerState === 'READY_KEYWORD_DEGRADED').length,
    `${ledgerState} denied operations start no owner work`);
    if (readyActions.has(ledgerState) || ledgerState === 'READY_KEYWORD_DEGRADED') {
      for (const busy of [{ state: 'rebuilding' },
        { state: 'checking', nativeRepair: { active: true, state: 'checking' } }]) {
        publicStatus = { ledgerState, ...busy };
        const before = dispatched.length;
        const reply = await maintenance('rebuild');
        assert(reply.started === false && reply.scheduled === false && !reply.jobId
          && dispatched.length === before,
        `${ledgerState}/${busy.state} direct private rebuild denies concurrent public/native work`);
        privateCells += 1;
      }
      publicStatus = { ledgerState, state: 'ready' };
    }
    vm.runInNewContext(mainSource.slice(cancelStart, cancelEnd), context);
    const cancelReply = await context.cancelHandler({});
    assert.equal(cancelReply.cancelled, cancelActions.has(ledgerState),
      `${ledgerState}/P0 safe private Cancel disposition`);
    privateCells += 1;
    vm.runInNewContext(mainSource.slice(retryCheckStart, retryCheckEnd), context);
    const beforeCheck = dispatched.length;
    const retryCheckReply = await context.cancelHandler({});
    const checkAllowed = retryCheckActions.has(ledgerState);
    assert(retryCheckReply.started === checkAllowed && retryCheckReply.scheduled === checkAllowed
      && (checkAllowed ? dispatched.length === beforeCheck + 1 : dispatched.length === beforeCheck)
      && (!checkAllowed || !retryCheckReply.jobId),
    `${ledgerState}/P0 direct retry-check admission and no durable jobId`);
    privateCells += 1;
    configured = false;
    const beforeUnconfiguredCheck = dispatched.length;
    const noStoreCheck = await context.cancelHandler({});
    assert(noStoreCheck.started === false && noStoreCheck.scheduled === false
      && !noStoreCheck.jobId && dispatched.length === beforeUnconfiguredCheck,
    `${ledgerState}/unconfigured private retry-check starts no work`);
    configured = true;
    privateCells += 1;
    if (checkAllowed) {
      for (const busy of [{ state: 'rebuilding' },
        { state: 'checking', nativeRepair: { active: true, state: 'checking' } }]) {
        publicStatus = { ledgerState, ...busy };
        const before = dispatched.length;
        const reply = await context.cancelHandler({});
        assert(reply.started === false && reply.scheduled === false && !reply.jobId
          && dispatched.length === before,
        `${ledgerState}/${busy.state} direct retry-check denies concurrent public/native work`);
        privateCells += 1;
      }
      publicStatus = { ledgerState, state: 'ready' };
    }
    for (const sourceState of sourceStates) {
      const native = sourceState.startsWith('native-');
      const sourceBusy = ['rebuilding', 'indexing', 'queued', 'compacting', 'clearing',
        'native-checking', 'native-repairing'].includes(sourceState);
      publicStatus = { ledgerState, state: native ? 'ready' : sourceState,
        nativeRepair: native ? { active: true, state: sourceState.slice(7) } : null };
      for (const operation of ['rebuild', 'retry', 'compact', 'clear']) {
        const before = dispatched.length;
        const reply = await maintenance(operation);
        const allowed = !sourceBusy && (operation === 'compact' || operation === 'clear'
          ? readyActions.has(ledgerState)
          : readyActions.has(ledgerState) || ledgerState === 'READY_KEYWORD_DEGRADED');
        assert.equal(reply.started, allowed,
          `${ledgerState}/${sourceState}/private ${operation} source-dependent disposition`);
        assert.equal(dispatched.length, before + Number(allowed),
          `${ledgerState}/${sourceState}/private ${operation} owner dispatch count`);
        privateCells += 1;
      }
      const beforeCheck = dispatched.length;
      const reply = await context.cancelHandler({});
      const allowedCheck = !sourceBusy && retryCheckActions.has(ledgerState);
      assert.equal(reply.started, allowedCheck,
        `${ledgerState}/${sourceState}/private retry-check source-dependent disposition`);
      assert.equal(dispatched.length, beforeCheck + Number(allowedCheck),
        `${ledgerState}/${sourceState}/private retry-check dispatch count`);
      privateCells += 1;
    }
    publicStatus = { ledgerState, state: 'ready' };
    const actualOwner = new OwnerWorkerController({});
    actualOwner.snapshot = { state: ledgerState, active: false };
    for (const futureOperation of ['backup', 'migrate', 'restore', 'restore_health_ack']) {
      await assert.rejects(actualOwner.command('manage_index', { operation: futureOperation }),
        error => error.code === 'owner_invalid_manage_index_payload',
        `${ledgerState}/P0 ${futureOperation} is denied before owner work`);
      privateCells += 1;
    }
    for (const futureOperation of ['backup', 'migrate', 'restore', 'restore-health-ack']) {
      const reply = futureHandlers.get(`indexing:${futureOperation}`)({});
      assert.equal(reply.started, false, `${ledgerState}/P0 ${futureOperation} never starts`);
      assert.equal(reply.scheduled, false, `${ledgerState}/P0 ${futureOperation} is not accepted`);
      assert.equal(reply.reason, 'future_phase', `${ledgerState}/P0 ${futureOperation} reason`);
      assert(!reply.jobId, `${ledgerState}/P0 ${futureOperation} has no jobId`);
      privateCells += 1;
    }
    let opened = 0;
    let fromSettings = false;
    let shellError = '';
    const openContext = { ipcMain: { handle(_name, handler) { openContext.handler = handler; } },
      searchEngine: { getIndexDataDir: () => 'internal-index-dir' },
      settingsIndexingWindow: () => fromSettings,
      isDocumentStoreSourceRootConfigured: () => configured,
      shell: { async openPath() { opened += 1; return shellError; } } };
    vm.runInNewContext(mainSource.slice(openDirStart, openDirEnd), openContext);
    const viewerFolder = await openContext.handler({ sender: { viewer: true } });
    assert.deepEqual(JSON.parse(JSON.stringify(viewerFolder)),
      { success: false, reason: 'settings-only', error: null },
    `${ledgerState}/viewer cannot open or read the private index location`);
    assert.equal(opened, 0, `${ledgerState}/viewer starts no shell work`);
    fromSettings = true;
    configured = false;
    const noStoreFolder = await openContext.handler({});
    assert.deepEqual(JSON.parse(JSON.stringify(noStoreFolder)),
      { success: false, reason: 'source-root-unconfigured',
        error: 'Document store path is not configured' },
      `${ledgerState}/unconfigured folder action starts no shell work`);
    assert.equal(opened, 0);
    configured = true;
    const folder = await openContext.handler({});
    assert.deepEqual(JSON.parse(JSON.stringify(folder)),
      { success: true, reason: null, error: null },
      `${ledgerState}/configured folder action opens the diagnostic location`);
    assert.equal(opened, 1);
    shellError = 'Cannot open C:\\private\\internal-index-dir';
    const failedFolder = await openContext.handler({});
    assert.deepEqual(JSON.parse(JSON.stringify(failedFolder)),
      { success: false, reason: 'open-failed', error: 'open-failed' },
    `${ledgerState}/folder failure does not return a private index location`);
    privateCells += 4;
  }
  assert.equal(privateCells, 2502, 'private P0/future, source-state, and source-configuration action dispositions are covered');
  console.log(`test-s21b-state-matrix: PASS statusCells=${cells} overlapCells=${overlapCells} actionCells=${actionCells} privateCells=${privateCells} feedbackCells=${feedbackCells} release=P0`);
}
checkPrivateDisposition().catch(error => { console.error(error); process.exitCode = 1; });
