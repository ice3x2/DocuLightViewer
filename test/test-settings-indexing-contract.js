'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const preload = fs.readFileSync(path.join(root, 'src/main/preload.js'), 'utf-8');
const main = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf-8');
const settingsHtml = fs.readFileSync(path.join(root, 'src/renderer/settings.html'), 'utf-8');
const settingsJs = fs.readFileSync(path.join(root, 'src/renderer/settings.js'), 'utf-8');
const settingsCss = fs.readFileSync(path.join(root, 'src/renderer/settings.css'), 'utf-8');
const { SearchEngine } = require('../src/main/search-engine');

const apiNames = [
  'getIndexingStatus',
  'startIndexingRebuild',
  'cancelIndexingJob',
  'retryIndexingFailures',
  'compactSearchIndex',
  'openIndexDataDir'
];

for (const name of apiNames) {
  assert(preload.includes(`${name}:`), `preload exposes ${name}`);
  assert(settingsJs.includes(`window.doclight.${name}`), `settings renderer calls ${name}`);
}

assert(preload.includes('clearSearchIndex:'), 'preload retains legacy clearSearchIndex IPC API');

const ipcChannels = [
  'indexing:get-status',
  'indexing:start-rebuild',
  'indexing:cancel-job',
  'indexing:retry-failures',
  'indexing:compact',
  'indexing:clear',
  'indexing:open-data-dir'
];

for (const channel of ipcChannels) {
  assert(main.includes(`'${channel}'`), `main process registers ${channel}`);
}

assert(main.includes('registerOpenedMarkdown'), 'settings schema includes opened Markdown registration option');
assert(settingsHtml.includes('id="registerOpenedMarkdown-checkbox"'), 'settings UI contains opened Markdown registration checkbox');
assert(settingsJs.includes('registerOpenedMarkdown'), 'settings renderer persists opened Markdown registration option');

const statusEngine = new SearchEngine({
  get(key, defaultValue) {
    if (key === 'mcpAutoSavePath') return path.join(root, 'tmp-index-contract');
    return defaultValue;
  }
});
statusEngine.markDirty();
const statusPayload = statusEngine.getStatus();
for (const field of ['state', 'indexedCount', 'pendingCount', 'failedCount', 'currentPath', 'phase', 'lastIndexedTime', 'errorSummary']) {
  assert(Object.prototype.hasOwnProperty.call(statusPayload, field), `indexing status payload includes ${field}`);
}
assert.strictEqual(
  statusPayload.state,
  'stale',
  'dirty uninitialized search index reports stale/rebuild-required instead of uninitialized'
);

for (const id of [
  'settings-title',
  'indexing-status',
  'indexing-manage-btn',
  'indexing-management-view',
  'indexing-back-btn',
  'indexing-rebuild-btn',
  'indexing-cancel-btn',
  'indexing-retry-btn',
  'indexing-compact-btn',
  'indexing-open-dir-btn'
]) {
  assert(settingsHtml.includes(`id="${id}"`), `settings UI contains ${id}`);
}

assert(!settingsHtml.includes('id="indexing-clear-btn"'), 'settings UI no longer exposes a delete search index button');
assert(!settingsJs.includes('clearSearchIndex()'), 'settings renderer no longer calls clearSearchIndex from the indexing management view');
assert(!settingsJs.includes("confirm(t('settings.indexingClearConfirm'))"), 'settings renderer no longer shows a delete index confirmation');

assert(settingsCss.includes('.indexing-actions'), 'settings CSS includes indexing action layout');
assert(settingsCss.includes('.indexing-management-view'), 'settings CSS includes full indexing management view layout');
assert(settingsCss.includes('.indexing-message-stack'), 'settings CSS includes a stacked indexing message area');
assert(settingsCss.includes('.indexing-management-view .hint'), 'settings CSS forces management hints to render as blocks');
assert(settingsCss.includes('.indexing-action-item'), 'settings CSS includes described indexing action rows');
assert(settingsCss.includes('padding-bottom: 32px'), 'indexing management view keeps bottom breathing room below back button');
assert(settingsJs.includes('setSettingsTitle'), 'settings renderer changes the visible title when entering/leaving indexing management');
assert(settingsJs.includes('showIndexingManagementView'), 'settings renderer can open indexing management view');
assert(settingsJs.includes('showMainSettingsView'), 'settings renderer can return to main settings view');
assert(settingsJs.includes("setSettingsTitle('settings.indexingManage')"), 'indexing management view title replaces generic Settings heading');
assert(settingsJs.includes("setSettingsTitle('settings.heading')"), 'main settings view restores generic Settings heading');
assert(settingsJs.includes('formatIndexingDiagnostic'), 'settings renderer formats indexing diagnostics before display');
assert(settingsJs.includes('formatIndexingActionResult'), 'settings renderer surfaces action failure and scheduled results');
assert(settingsJs.includes('result.started === false'), 'settings renderer treats failed rebuild start as an incomplete action');
assert(settingsJs.includes('result.scheduled === false'), 'settings renderer treats failed rebuild scheduling as an incomplete action');
assert(settingsJs.includes('formatIndexingDisplayPath'), 'settings renderer formats current indexing paths for display');
assert(settingsJs.includes('formatLinkedImportMessage'), 'settings renderer formats linked import errors before display');
assert(settingsJs.includes('settings.indexingNativeModuleMismatch'), 'native module mismatch is rendered as a localized user-facing message');
assert(settingsJs.includes('nativeRepair'), 'settings renderer reads native repair status from indexing status payload');
assert(settingsJs.includes('settings.indexingNativeRepairing'), 'settings renderer renders native repair progress text');
assert(/id="mcpAutoSave-checkbox"[^>]*disabled/.test(settingsHtml), 'auto-save checkbox starts disabled until a document store path is configured');
assert(/id="indexing-manage-btn"[^>]*disabled/.test(settingsHtml), 'search index management button starts disabled until a document store path is configured');
assert(settingsJs.includes('let savedDocumentStorePath'), 'settings renderer tracks the saved document store path separately from unsaved input');
assert(settingsJs.includes('function hasDocumentStorePath'), 'settings renderer centralizes document store path availability checks');
assert(settingsJs.includes('function hasSavedDocumentStorePath'), 'settings renderer only allows index management for the saved document store path');
assert(settingsJs.includes('mcpAutoSaveCheckbox.disabled = !hasPath'), 'settings renderer disables auto-save when no document store path is configured');
assert(settingsJs.includes('if (!hasPath) mcpAutoSaveCheckbox.checked = false'), 'settings renderer unchecks auto-save when no document store path is configured');
assert(!settingsJs.includes('mcpAutoSaveCheckbox.checked = hasPath'), 'settings renderer enables auto-save without forcing the user opt-in checkbox on');
assert(settingsJs.includes('indexingManageBtn.disabled = !hasSavedPath'), 'settings renderer disables search index management until the current path is saved');
assert(/function showIndexingManagementView\(\)\s*{[\s\S]{0,180}if \(!hasSavedDocumentStorePath\(\)\) return;/.test(settingsJs), 'settings renderer prevents entering index management without a saved document store path');
assert(/const sourceRootConfigured\s*=/.test(main), 'main process computes document store source-root availability for indexing status');
assert(/canRebuild:\s*sourceRootConfigured/.test(main), 'main indexing status exposes whether rebuild is currently allowed');
assert(/fs\.statSync\([^)]*\)\.isDirectory\(\)/.test(main), 'main process treats only existing directories as configured document store roots');
assert(settingsJs.includes('indexingCancelBtn.disabled = busy || rebuildActive || !active || nativeRepairActive'), 'settings renderer does not expose indexing cancel during native repair or full rebuild');
assert(settingsJs.includes('const showPhase'), 'technical phase text is hidden unless indexing is actively running');
assert(settingsJs.includes('let indexingStatusRequest = null'), 'settings renderer tracks an in-flight indexing status request');
assert(settingsJs.includes('if (indexingStatusRequest) return indexingStatusRequest'), 'settings renderer prevents overlapping indexing status polling');
assert(settingsJs.includes('let indexingActionRequest = null'), 'settings renderer tracks an in-flight indexing action request');
assert(settingsJs.includes('if (indexingActionRequest) return indexingActionRequest'), 'settings renderer prevents overlapping indexing actions');
assert(settingsJs.includes('isIndexingWorkerActive'), 'settings renderer centralizes active worker state detection');
assert(settingsJs.includes("'compacting'") && settingsJs.includes("'clearing'"), 'settings renderer treats compacting/clearing worker states as active');
assert(settingsJs.includes('setIndexingActionsBusy'), 'settings renderer disables indexing action controls while an action is in flight');
assert(/phaseParts\.push\(formatIndexingDisplayPath\(status\.currentPath\)\)/.test(settingsJs), 'currentPath is display-formatted before rendering');
assert(/formatLinkedImportMessage\(\(result && result\.message\)/.test(settingsJs), 'linked import result errors are sanitized before rendering');
assert(settingsJs.includes('confirm(t(\'settings.indexingCompactConfirm\'))'), 'compact index requires confirmation');
assert(
  /indexingCancelBtn\.disabled\s*=\s*busy\s*\|\|\s*rebuildActive\s*\|\|\s*!active\s*\|\|\s*nativeRepairActive/.test(settingsJs),
  'settings renderer disables the stop-indexing button while full rebuild is active'
);
assert(
  /searchEngine\.resetForSourceRootChange\(\);\s*initializeSearchEngineIfConfigured\(\);/.test(main),
  'saving a newly configured document store reinitializes search index status after source-root reset'
);
assert(
  !/function initializeSearchEngineIfConfigured\(\)[\s\S]{0,220}mcpAutoSave['"],\s*false/.test(main),
  'search index status initialization depends on the configured document store path, not the MCP auto-save toggle'
);
assert(settingsJs.includes('ACTIVE_INDEXING_POLL_MS'), 'settings renderer defines active indexing polling cadence');
assert(settingsJs.includes('IDLE_INDEXING_POLL_MS'), 'settings renderer defines idle indexing polling cadence');
assert(settingsJs.includes('scheduleIndexingStatusPoll'), 'settings renderer schedules adaptive indexing status polling');
assert(/const ACTIVE_INDEXING_POLL_MS\s*=\s*500/.test(settingsJs), 'active indexing status polling runs every 500ms');
assert(/const IDLE_INDEXING_POLL_MS\s*=\s*3000/.test(settingsJs), 'idle indexing status polling remains every 3000ms');
assert(!/setInterval\s*\(\s*function\s*\(\)\s*\{\s*refreshIndexingStatus\(\)/.test(settingsJs), 'settings renderer no longer polls indexing status through the global 3000ms interval');
assert(settingsJs.includes('status.rebuildSession'), 'settings renderer reads rebuildSession counts');
assert(settingsJs.includes('rebuildSession.indexedCount'), 'settings renderer renders rebuild-session indexed count from zero');
assert(settingsJs.includes('rebuildSession.pendingCount'), 'settings renderer renders rebuild-session pending count');
assert(!settingsCss.includes('background: #24292e;'), 'search index manage button no longer uses the black custom background');
assert(/\.indexing-manage-button[\s\S]*var\(--button-secondary-bg\)/.test(settingsCss), 'search index manage button uses the normal secondary button background');
assert(/\.indexing-manage-button[\s\S]*font-size:\s*12px;/.test(settingsCss), 'search index manage button uses the same font size as the embedding register button');
assert(/\.indexing-manage-button[\s\S]*font-weight:\s*400;/.test(settingsCss), 'search index manage button is not visually heavier than the embedding register button');
assert(/\.indexing-manage-button[\s\S]*margin-top:\s*12px;/.test(settingsCss), 'search index manage button is spaced away from the opened Markdown unavailable hint');

for (const locale of ['en', 'ko', 'ja', 'es']) {
  const file = path.join(root, `src/locales/${locale}.json`);
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  for (const key of [
    'settings.indexing',
    'settings.indexingStatus',
    'settings.indexingRebuild',
    'settings.indexingCancel',
    'settings.indexingRetry',
    'settings.indexingCompact',
    'settings.indexingClear',
    'settings.indexingOpenDir',
    'settings.indexingManage',
    'settings.indexingManageHint',
    'settings.indexingBack',
    'settings.indexingSummaryHint',
    'settings.indexingRebuildDescription',
    'settings.indexingCancelDescription',
    'settings.indexingRetryDescription',
    'settings.indexingCompactDescription',
    'settings.indexingClearDescription',
    'settings.indexingOpenDirDescription',
    'settings.linkedImportDescription',
    'settings.indexingNativeModuleMismatch',
    'settings.indexingNativeRepairing',
    'settings.indexingNativeRepairFailed',
    'settings.indexingActionNotCompleted',
    'settings.indexingActionScheduled',
    'settings.indexingActionCompleted',
    'settings.indexingActionCompletedWithBackup',
    'settings.indexingClearConfirm',
    'settings.indexingCompactConfirm',
    'settings.indexingBackupWarning'
  ]) {
    assert(Object.prototype.hasOwnProperty.call(data, key), `${locale} locale contains ${key}`);
  }
  for (const key of [
    'settings.registerOpenedMarkdown',
    'settings.registerOpenedMarkdownHint',
    'settings.registerOpenedMarkdownUnavailable'
  ]) {
    assert(Object.prototype.hasOwnProperty.call(data, key), `${locale} locale contains ${key}`);
  }
  assert(!/Back up and delete|백업한 뒤 삭제합니다/.test(data['settings.indexingClearDescription']), `${locale} clear description avoids unconditional backup wording`);
  assert(!/개발 환경에서는 Electron용 native 모듈|make a manual copy from the index folder first if needed/.test(data['settings.indexingNativeModuleMismatch'] + data['settings.indexingBackupWarning']), `${locale} diagnostic copy stays concise`);
}

(async () => {
  const { TOOLS } = await import('../src/main/mcp-http.mjs');
  const names = TOOLS.map((tool) => tool.name);
  for (const forbidden of ['getIndexingStatus', 'startIndexingRebuild', 'cancelIndexingJob', 'retryIndexingFailures', 'compactSearchIndex', 'clearSearchIndex', 'openIndexDataDir', 'registerOpenedMarkdown']) {
    assert(!names.includes(forbidden), `HTTP MCP tools/list does not expose ${forbidden}`);
  }
  console.log('test-settings-indexing-contract: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
