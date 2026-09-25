(function() {
  'use strict';

  // === i18n ===
  let _strings = {};

  function t(key, vars) {
    let str = _strings[key];
    if (str === undefined) return key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      }
    }
    return str;
  }

  async function initI18n() {
    try {
      const { strings } = await window.doclight.getStrings();
      _strings = strings;
    } catch {
      _strings = {};
    }
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const translated = t(key);
      if (translated !== key) {
        el.textContent = translated;
      }
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      const translated = t(key);
      if (translated !== key) {
        el.setAttribute('title', translated);
      }
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      const translated = t(key);
      if (translated !== key) {
        el.setAttribute('placeholder', translated);
      }
    });
  }

  const DEFAULTS = {
    theme: 'light',
    fontSize: 16,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    contentWidth: '900px',
    contentMaxWidth: '900px',
    codeTheme: 'github',
    mcpPort: 32580,
    defaultWindowSize: 'auto',
    autoRefresh: true,
    enableTabs: false,
    mcpAutoSave: false,
    mcpAutoSavePath: '',
    registerOpenedMarkdown: false,
    mcpSaveSubDir: '',
    mcpGitInfo: true,
    showDocNav: true
  };

  const VALIDATION = {
    fontSize: { min: 8, max: 32 },
    mcpPort: { min: 1, max: 65535 }
  };

  // DOM elements
  const saveBtn = document.getElementById('save-button');
  const resetBtn = document.getElementById('reset-button');
  const saveMessage = document.getElementById('save-message');
  const settingsTitleEl = document.getElementById('settings-title');
  const mcpAddressEl = document.getElementById('mcp-address');
  const mcpCopyToast = document.getElementById('mcp-copy-toast');
  const settingsMainView = document.getElementById('settings-main-view');
  const indexingManagementView = document.getElementById('indexing-management-view');
  const indexingManageBtn = document.getElementById('indexing-manage-btn');
  const indexingBackBtn = document.getElementById('indexing-back-btn');
  const indexingStatusEl = document.getElementById('indexing-status');
  const indexingIndexedCountEl = document.getElementById('indexing-indexed-count');
  const indexingPendingCountEl = document.getElementById('indexing-pending-count');
  const indexingFailedCountEl = document.getElementById('indexing-failed-count');
  const indexingPhaseEl = document.getElementById('indexing-phase');
  const indexingErrorEl = document.getElementById('indexing-error');
  const indexingRebuildBtn = document.getElementById('indexing-rebuild-btn');
  const indexingCancelBtn = document.getElementById('indexing-cancel-btn');
  const indexingRetryBtn = document.getElementById('indexing-retry-btn');
  const indexingCompactBtn = document.getElementById('indexing-compact-btn');
  const indexingOpenDirBtn = document.getElementById('indexing-open-dir-btn');
  const registerOpenedMarkdownCheckbox = document.getElementById('registerOpenedMarkdown-checkbox');
  const registerOpenedMarkdownUnavailable = document.getElementById('registerOpenedMarkdown-unavailable');
  const linkedImportBtn = document.getElementById('linked-import-btn');
  const linkedImportStatusEl = document.getElementById('linked-import-status');
  let indexingStatusRequest = null;
  let indexingActionRequest = null;
  let lastIndexingStatus = null;
  let lastLedgerAnnouncement = null;
  let indexingActionNotice = null;
  let savedDocumentStorePath = '';
  const ACTIVE_INDEXING_POLL_MS = 500;
  const IDLE_INDEXING_POLL_MS = 3000;
  let settingsStatusPoller = null;

  const fields = {
    theme: document.getElementById('theme-select'),
    fontSize: document.getElementById('fontSize-input'),
    fontFamily: document.getElementById('fontFamily-input'),
    contentWidth: document.getElementById('contentWidth-input'),
    contentMaxWidth: document.getElementById('contentMaxWidth-input'),
    codeTheme: document.getElementById('codeTheme-select'),
    mcpPort: document.getElementById('mcpPort-input'),
    defaultWindowSize: document.getElementById('defaultWindowSize-select')
  };

  // CSS length validation and normalization
  function normalizeCssLength(value) {
    var trimmed = (value || '').trim();
    if (trimmed === '') return '';
    if (/^\d+\.?\d*$/.test(trimmed)) {
      if (parseFloat(trimmed) < 0) return null;
      return trimmed + 'px';
    }
    var match = trimmed.match(/^(\d+\.?\d*)(px|%|em|rem|vw|vh|vmin|vmax|ch|ex|cm|mm|in|pt|pc)$/i);
    if (!match) return null;
    if (parseFloat(match[1]) < 0) return null;
    return match[1] + match[2].toLowerCase();
  }

  // Blur validation for CSS length fields
  ['contentWidth', 'contentMaxWidth'].forEach(function(key) {
    var el = fields[key];
    if (!el) return;
    el.setAttribute('data-prev', DEFAULTS[key]);
    el.addEventListener('blur', function() {
      var normalized = normalizeCssLength(el.value);
      if (normalized === null) {
        el.value = el.getAttribute('data-prev') || DEFAULTS[key];
      } else {
        el.value = normalized;
        el.setAttribute('data-prev', normalized);
      }
    });
  });

  // Load settings from main process
  async function loadSettings() {
    try {
      const settings = await window.doclight.getSettings();
      populateForm(settings);
    } catch (err) {
      console.error('Failed to load settings:', err);
      populateForm(DEFAULTS);
    }
  }

  function updateMcpAddress(port) {
    if (mcpAddressEl) {
      mcpAddressEl.textContent = 'http://localhost:' + port + '/mcp';
    }
  }

  function showMcpCopyToast() {
    mcpCopyToast.textContent = t('settings.mcpCopied');
    mcpCopyToast.classList.add('show');
    setTimeout(() => {
      mcpCopyToast.classList.remove('show');
    }, 2000);
  }

  // Populate form fields
  function populateForm(settings) {
    savedDocumentStorePath = settings.mcpAutoSavePath || '';
    for (const [key, element] of Object.entries(fields)) {
      if (element) {
        element.value = settings[key] !== undefined ? settings[key] : DEFAULTS[key];
        if (key === 'contentWidth' || key === 'contentMaxWidth') {
          element.setAttribute('data-prev', element.value);
        }
      }
    }
    const autoRefreshEl = document.getElementById('autoRefresh-checkbox');
    if (autoRefreshEl) autoRefreshEl.checked = settings.autoRefresh !== undefined ? settings.autoRefresh : DEFAULTS.autoRefresh;
    const enableTabsEl = document.getElementById('enableTabs-checkbox');
    if (enableTabsEl) enableTabsEl.checked = settings.enableTabs !== undefined ? settings.enableTabs : DEFAULTS.enableTabs;
    const showDocNavEl = document.getElementById('showDocNav-checkbox');
    if (showDocNavEl) showDocNavEl.checked = settings.showDocNav !== undefined ? settings.showDocNav : DEFAULTS.showDocNav;
    const mcpAutoSaveEl = document.getElementById('mcpAutoSave-checkbox');
    if (mcpAutoSaveEl) mcpAutoSaveEl.checked = settings.mcpAutoSave !== undefined ? settings.mcpAutoSave : DEFAULTS.mcpAutoSave;
    const mcpAutoSavePathEl = document.getElementById('mcpAutoSavePath-input');
    if (mcpAutoSavePathEl) mcpAutoSavePathEl.value = settings.mcpAutoSavePath || '';
    if (registerOpenedMarkdownCheckbox) {
      registerOpenedMarkdownCheckbox.checked = settings.registerOpenedMarkdown !== undefined
        ? settings.registerOpenedMarkdown
        : DEFAULTS.registerOpenedMarkdown;
    }
    const mcpSaveSubDirEl = document.getElementById('mcpSaveSubDir-input');
    if (mcpSaveSubDirEl) mcpSaveSubDirEl.value = settings.mcpSaveSubDir || '';
    const mcpGitInfoEl = document.getElementById('mcpGitInfo-checkbox');
    if (mcpGitInfoEl) mcpGitInfoEl.checked = settings.mcpGitInfo !== undefined ? settings.mcpGitInfo : DEFAULTS.mcpGitInfo;
    updateAutoSavePathState();
    updateMcpAddress(settings.mcpPort !== undefined ? settings.mcpPort : DEFAULTS.mcpPort);
  }

  // Collect and validate form values
  function collectFormValues() {
    const values = {};
    for (const [key, element] of Object.entries(fields)) {
      if (!element) continue;

      if (element.type === 'number') {
        let val = parseInt(element.value, 10);
        const rules = VALIDATION[key];
        if (rules) {
          if (isNaN(val) || val < rules.min || val > rules.max) {
            val = DEFAULTS[key];
            element.value = val;
          }
        }
        values[key] = val;
      } else {
        values[key] = element.value || DEFAULTS[key];
      }
    }

    // Validate contentWidth / contentMaxWidth
    ['contentWidth', 'contentMaxWidth'].forEach(function(key) {
      var el = fields[key];
      if (!el) return;
      var normalized = normalizeCssLength(values[key]);
      if (normalized === null) {
        normalized = el.getAttribute('data-prev') || DEFAULTS[key];
        el.value = normalized;
      }
      values[key] = normalized;
      el.setAttribute('data-prev', normalized);
    });

    // Validate theme
    if (!['light', 'dark'].includes(values.theme)) {
      values.theme = DEFAULTS.theme;
      fields.theme.value = DEFAULTS.theme;
    }

    // Validate fontFamily
    if (!values.fontFamily || values.fontFamily.trim() === '') {
      values.fontFamily = DEFAULTS.fontFamily;
      fields.fontFamily.value = DEFAULTS.fontFamily;
    }

    // Validate defaultWindowSize
    if (!['auto', 's', 'm', 'l', 'f'].includes(values.defaultWindowSize)) {
      values.defaultWindowSize = DEFAULTS.defaultWindowSize;
      fields.defaultWindowSize.value = DEFAULTS.defaultWindowSize;
    }

    const autoRefreshEl = document.getElementById('autoRefresh-checkbox');
    values.autoRefresh = autoRefreshEl ? autoRefreshEl.checked : DEFAULTS.autoRefresh;
    const enableTabsEl = document.getElementById('enableTabs-checkbox');
    values.enableTabs = enableTabsEl ? enableTabsEl.checked : DEFAULTS.enableTabs;
    const showDocNavEl = document.getElementById('showDocNav-checkbox');
    values.showDocNav = showDocNavEl ? showDocNavEl.checked : DEFAULTS.showDocNav;
    const mcpAutoSaveEl = document.getElementById('mcpAutoSave-checkbox');
    const mcpAutoSavePathEl = document.getElementById('mcpAutoSavePath-input');
    values.mcpAutoSavePath = mcpAutoSavePathEl ? mcpAutoSavePathEl.value.trim() : DEFAULTS.mcpAutoSavePath;
    values.mcpAutoSave = Boolean(values.mcpAutoSavePath) && (mcpAutoSaveEl ? mcpAutoSaveEl.checked : true);
    values.registerOpenedMarkdown = registerOpenedMarkdownCheckbox && !registerOpenedMarkdownCheckbox.disabled
      ? registerOpenedMarkdownCheckbox.checked
      : DEFAULTS.registerOpenedMarkdown;
    const mcpSaveSubDirEl = document.getElementById('mcpSaveSubDir-input');
    values.mcpSaveSubDir = mcpSaveSubDirEl ? mcpSaveSubDirEl.value.trim() : DEFAULTS.mcpSaveSubDir;
    const mcpGitInfoEl = document.getElementById('mcpGitInfo-checkbox');
    values.mcpGitInfo = mcpGitInfoEl ? mcpGitInfoEl.checked : DEFAULTS.mcpGitInfo;

    return values;
  }

  // MCP port input → update address live + availability check
  const mcpPortStatusEl = document.getElementById('mcp-port-status');
  let portCheckTimer = null;

  async function checkPortStatus(port) {
    try {
      const available = await window.doclight.checkPortAvailable(port);
      if (mcpPortStatusEl) {
        mcpPortStatusEl.textContent = available
          ? t('settings.portAvailable')
          : t('settings.portUnavailable');
        mcpPortStatusEl.className = 'hint ' + (available ? 'port-available' : 'port-unavailable');
      }
    } catch (err) {
      console.error('Port check failed:', err);
    }
  }

  fields.mcpPort.addEventListener('input', () => {
    const port = parseInt(fields.mcpPort.value, 10);
    if (fields.mcpPort.value.trim() === '') {
      if (mcpPortStatusEl) {
        mcpPortStatusEl.textContent = t('settings.portEmpty');
        mcpPortStatusEl.className = 'hint port-unavailable';
      }
      return;
    }
    if (isNaN(port) || port < 1 || port > 65535) {
      if (mcpPortStatusEl) {
        mcpPortStatusEl.textContent = t('settings.portInvalidRange');
        mcpPortStatusEl.className = 'hint port-unavailable';
      }
      return;
    }
    updateMcpAddress(port);
    if (portCheckTimer) clearTimeout(portCheckTimer);
    portCheckTimer = setTimeout(() => checkPortStatus(port), 300);
  });

  // MCP address click → copy to clipboard
  if (mcpAddressEl) {
    mcpAddressEl.addEventListener('click', () => {
      const addr = mcpAddressEl.textContent;
      navigator.clipboard.writeText(addr).then(() => {
        showMcpCopyToast();
      }).catch(err => {
        console.error('Failed to copy MCP address:', err);
      });
    });
  }

  // Show save message
  function showSaveMessage() {
    saveMessage.classList.remove('hidden');
    setTimeout(() => {
      saveMessage.classList.add('hidden');
    }, 2000);
  }

  function setSettingsTitle(key) {
    if (settingsTitleEl) settingsTitleEl.textContent = t(key);
  }

  function showIndexingManagementView() {
    if (!hasSavedDocumentStorePath()) return;
    setSettingsTitle('settings.indexingManage');
    if (settingsMainView) settingsMainView.classList.add('hidden');
    if (indexingManagementView) indexingManagementView.classList.remove('hidden');
    refreshIndexingStatus();
  }

  function showMainSettingsView() {
    setSettingsTitle('settings.heading');
    if (indexingManagementView) indexingManagementView.classList.add('hidden');
    if (settingsMainView) settingsMainView.classList.remove('hidden');
  }

  function formatIndexingDiagnostic(message) {
    const raw = String(message || '').trim();
    if (!raw) return '';
    if (/NODE_MODULE_VERSION|better_sqlite3\.node|better-sqlite3/i.test(raw)) {
      return t('settings.indexingNativeModuleMismatch');
    }
    return raw
      .replace(/\\\\\?\\[A-Za-z]:\\[^\r\n'"`]+/g, '[local path]')
      .replace(/[A-Za-z]:\\[^\r\n'"`]+/g, '[local path]')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(' ');
  }

  function formatIndexingDisplayPath(filePath) {
    const value = String(filePath || '').trim();
    if (!value) return '';
    if (!/[\\/]/.test(value) && !/^[A-Za-z]:/.test(value)) return value;
    const normalized = value.replace(/[\\/]+$/, '');
    const parts = normalized.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '[local path]';
  }

  function setIndexingDiagnostic(message, type) {
    if (!indexingErrorEl) return;
    const formatted = formatIndexingDiagnostic(message);
    indexingErrorEl.textContent = formatted;
    indexingErrorEl.classList.toggle('visible', Boolean(formatted));
    indexingErrorEl.classList.toggle('notice', type === 'notice' && Boolean(formatted));
  }

  function formatIndexingActionResult(result) {
    if (!result || typeof result !== 'object') return null;
    if (result.scheduled === true) {
      return { type: 'notice', message: t('settings.indexingActionScheduled') };
    }
    const failed = result.success === false ||
      result.started === false ||
      result.scheduled === false ||
      result.compacted === false ||
      result.cleared === false ||
      result.cancelled === false;
    if (failed) {
      const reason = ['compact-rebuild-required', 'compact-deferred'].includes(result.reason)
        ? t('settings.indexingCompactRebuildRequired')
        : formatIndexingDiagnostic(result.message || result.error || result.reason || 'not-available');
      return {
        type: 'error',
        message: t('settings.indexingActionNotCompleted', { reason })
      };
    }
    if (result.backupPath) {
      return { type: 'notice', message: t('settings.indexingActionCompletedWithBackup') };
    }
    if (result.success === true || result.compacted === true || result.cleared === true || result.cancelled === true) {
      return { type: 'notice', message: t('settings.indexingActionCompleted') };
    }
    return null;
  }

  function formatLinkedImportMessage(message) {
    return formatIndexingDiagnostic(message) || t('settings.linkedImportFailed');
  }

  function isNativeRepairActive(nativeRepair) {
    return nativeRepair && (nativeRepair.active === true || nativeRepair.state === 'checking' || nativeRepair.state === 'repairing');
  }

  function formatProgressPercent(progress) {
    if (!progress || typeof progress !== 'object') return null;
    const total = Number(progress.total) || 0;
    if (total <= 0) return null;
    const current = Math.max(0, Math.min(Number(progress.current) || 0, total));
    return Math.round((current / total) * 100);
  }

  function isIndexingWorkerActive(state) {
    return ['rebuilding', 'indexing', 'queued', 'compacting', 'clearing', 'checking', 'repairing'].includes(state);
  }

  function isFullRebuildActive(status, state) {
    const worker = status && status.indexingWorker;
    const rebuildSession = status && status.rebuildSession;
    return state === 'rebuilding' ||
      Boolean(rebuildSession && rebuildSession.active) ||
      Boolean(worker && worker.active && worker.kind === 'rebuild');
  }

  function setIndexingActionsBusy(busy) {
    for (const button of [indexingRebuildBtn, indexingCancelBtn, indexingRetryBtn, indexingCompactBtn, indexingOpenDirBtn]) {
      if (button) button.disabled = Boolean(busy) && button !== document.activeElement;
    }
  }

  function isSettingsStatusActive(status) {
    const pollState = status && status.state ? status.state : 'unknown';
    return isIndexingWorkerActive(pollState) || isNativeRepairActive(status && status.nativeRepair);
  }

  function renderIndexingStatus(status) {
    if (!status || !indexingStatusEl) return;
    const statusKey = [status.state || '', status.ledgerState || '', status.ledgerCode || ''].join('|');
    if (indexingActionNotice && indexingActionNotice.statusKey !== statusKey) indexingActionNotice = null;
    lastIndexingStatus = status;
    const rebuildSession = status.rebuildSession || null;
    const nativeRepair = status.nativeRepair || null;
    const nativeRepairActive = isNativeRepairActive(nativeRepair);
    const nativeRepairFailed = nativeRepair && nativeRepair.state === 'failed';
    const state = nativeRepairActive
      ? (nativeRepair.state === 'checking' ? 'checking' : 'repairing')
      : (status.state || 'unknown');
    const ledgerState = typeof status.ledgerState === 'string' ? status.ledgerState : null;
    const ledgerCode = typeof status.ledgerCode === 'string' ? status.ledgerCode : '';
    const ledgerPercent = Number.isFinite(status.ledgerProgress)
      ? Math.max(0, Math.min(100, status.ledgerProgress)) : null;
    const legacyActive = nativeRepairActive || state === 'clearing' || isFullRebuildActive(status, state) ||
      Boolean(status.indexingWorker && status.indexingWorker.active);
    const displayPercent = legacyActive ? formatProgressPercent(status.progress) : ledgerPercent;
    const bucket = displayPercent === null ? '' : (displayPercent === 100 ? 100 : Math.floor(displayPercent / 10) * 10);
    const recoveryRequired = ['CORRUPT_DEGRADED', 'CHECKER_EXIT_BLOCKED',
      'OWNER_EXIT_BLOCKED', 'ROLLBACK_REQUIRED'].includes(ledgerState);
    const stateLabelKey = status.ledgerCondition === 'indexing_ingress_capacity'
      ? 'settings.ledger.deferred' : 'settings.ledger.state.' + ledgerState;
    const label = legacyActive
      ? t('settings.indexingStatus', { state: t('settings.legacyState.' + state) })
      : ledgerState ? t(stateLabelKey) : t('settings.indexingStatus', { state });
    const condition = legacyActive && status.ledgerCondition === 'indexing_ingress_capacity'
      ? ' ' + t('settings.ledger.deferred') : '';
    const announcement = label + (bucket !== '' ? ' ' + t('settings.ledger.progress', { percent: displayPercent }) : '') + condition;
    const announcementKey = `${legacyActive ? state : ledgerState || state}|${ledgerCode}|${status.ledgerCondition || ''}|${bucket}`;
    if (announcementKey !== lastLedgerAnnouncement) {
      indexingStatusEl.textContent = announcement;
      lastLedgerAnnouncement = announcementKey;
    }
    indexingStatusEl.className = 'status-indicator ' + (state === 'degraded' || state === 'failed' || nativeRepairFailed ? 'error' : 'info');
    if (indexingErrorEl) {
      const unrecoverable = ['CHECKER_EXIT_BLOCKED', 'OWNER_EXIT_BLOCKED', 'ROLLBACK_REQUIRED'].includes(ledgerState);
      if (unrecoverable) indexingErrorEl.setAttribute('role', 'alert');
      else indexingErrorEl.removeAttribute('role');
    }
    if (indexingIndexedCountEl) indexingIndexedCountEl.textContent = String(rebuildSession ? rebuildSession.indexedCount : (status.indexedCount || 0));
    if (indexingPendingCountEl) indexingPendingCountEl.textContent = String(rebuildSession ? rebuildSession.pendingCount : (status.pendingCount || 0));
    if (indexingFailedCountEl) indexingFailedCountEl.textContent = String(status.failedCount || 0);
    if (indexingPhaseEl) {
      const showPhase = isIndexingWorkerActive(state) || nativeRepairActive;
      if (showPhase) {
        const phaseParts = [];
        if (nativeRepairActive) {
          const percent = formatProgressPercent(nativeRepair.progress);
          phaseParts.push(t('settings.indexingNativeRepairing', {
            percent: percent === null ? 0 : percent,
            phase: nativeRepair.phase || state
          }));
        } else {
          const percent = formatProgressPercent(status.progress);
          if (percent !== null) phaseParts.push(`${percent}%`);
          if (status.phase) phaseParts.push(status.phase);
          if (status.currentPath) phaseParts.push(formatIndexingDisplayPath(status.currentPath));
          if (status.lastIndexedTime) phaseParts.push(status.lastIndexedTime);
        }
        indexingPhaseEl.textContent = phaseParts.join(' | ');
      } else {
        indexingPhaseEl.textContent = '';
      }
    }
    if (indexingErrorEl) {
      const nativeDiagnostic = nativeRepairFailed && nativeRepair.diagnostic
        ? t('settings.indexingNativeRepairFailed', {
            reason: formatIndexingDiagnostic(nativeRepair.diagnostic.message || nativeRepair.diagnostic.code)
          })
        : '';
      setIndexingDiagnostic(nativeDiagnostic || (recoveryRequired ? t('settings.ledger.recoveryHelp') : '') || status.errorSummary || '');
      if (indexingActionNotice) setIndexingDiagnostic(indexingActionNotice.message, indexingActionNotice.type);
    }
    const active = isIndexingWorkerActive(state) || nativeRepairActive;
    const rebuildActive = isFullRebuildActive(status, state);
    const sourceRootConfigured = status.sourceRootConfigured !== false;
    const legacyCancelAvailable = !nativeRepairActive && !rebuildActive &&
      (state === 'clearing' || Boolean(status.indexingWorker && status.indexingWorker.active && status.indexingWorker.kind !== 'rebuild'));
    const legacyRetryAvailable = !active && sourceRootConfigured && (status.failedCount || 0) > 0;
    if (indexingManageBtn) indexingManageBtn.disabled = !sourceRootConfigured || !hasSavedDocumentStorePath();
    const busy = Boolean(indexingActionRequest);
    if (indexingCancelBtn) indexingCancelBtn.disabled = (busy && indexingCancelBtn !== document.activeElement) || !legacyCancelAvailable;
    if (indexingRebuildBtn) indexingRebuildBtn.disabled = busy || (ledgerState
      ? !['READY', 'READY_KEYWORD_ONLY', 'READY_KEYWORD_DEGRADED', 'READY_MAINTENANCE_PENDING'].includes(ledgerState)
      : active || !sourceRootConfigured);
    if (indexingRetryBtn) indexingRetryBtn.disabled = busy || !legacyRetryAvailable;
    if (indexingCompactBtn) indexingCompactBtn.disabled = busy || (ledgerState
      ? !['READY', 'READY_KEYWORD_ONLY', 'READY_MAINTENANCE_PENDING'].includes(ledgerState)
      : active || !sourceRootConfigured);
    if (indexingOpenDirBtn) indexingOpenDirBtn.disabled = busy || !sourceRootConfigured;
  }

  async function refreshIndexingStatus() {
    if (!window.doclight.getIndexingStatus) return;
    if (indexingStatusRequest) return indexingStatusRequest;
    indexingStatusRequest = (async () => {
      try {
        const status = await window.doclight.getIndexingStatus();
        renderIndexingStatus(status);
        return status;
      } catch (err) {
        setIndexingDiagnostic(err.message);
        return null;
      } finally {
        indexingStatusRequest = null;
      }
    })();
    return indexingStatusRequest;
  }

  async function runIndexingAction(action) {
    if (indexingActionRequest) return indexingActionRequest;
    setIndexingActionsBusy(true);
    indexingActionRequest = (async () => {
      try {
        const result = await action();
        renderIndexingStatus(result && result.status ? result.status : await window.doclight.getIndexingStatus());
        const actionResult = formatIndexingActionResult(result);
        if (actionResult && actionResult.message) {
          indexingActionNotice = {
            ...actionResult,
            statusKey: [lastIndexingStatus.state || '', lastIndexingStatus.ledgerState || '', lastIndexingStatus.ledgerCode || ''].join('|')
          };
          setIndexingDiagnostic(actionResult.message, actionResult.type);
        }
      } catch (err) {
        setIndexingDiagnostic(err.message);
      } finally {
        indexingActionRequest = null;
        if (lastIndexingStatus) {
          renderIndexingStatus(lastIndexingStatus);
        } else {
          setIndexingActionsBusy(false);
        }
      }
    })();
    return indexingActionRequest;
  }

  // Save handler
  saveBtn.addEventListener('click', async () => {
    const settings = collectFormValues();
    try {
      await window.doclight.saveSettings(settings);
      savedDocumentStorePath = settings.mcpAutoSavePath || '';
      updateAutoSavePathState();
      await refreshIndexingStatus();
      showSaveMessage();
    } catch (err) {
      console.error('Failed to save settings:', err);
    }
  });

  // Reset handler
  resetBtn.addEventListener('click', async () => {
    if (!confirm(t('settings.resetConfirm'))) return;

    populateForm(DEFAULTS);
    try {
      await window.doclight.saveSettings(DEFAULTS);
      savedDocumentStorePath = DEFAULTS.mcpAutoSavePath || '';
      updateAutoSavePathState();
      showSaveMessage();
    } catch (err) {
      console.error('Failed to reset settings:', err);
    }
  });

  if (indexingManageBtn) {
    indexingManageBtn.addEventListener('click', showIndexingManagementView);
  }
  if (indexingBackBtn) {
    indexingBackBtn.addEventListener('click', showMainSettingsView);
  }

  if (indexingRebuildBtn) {
    indexingRebuildBtn.addEventListener('click', () => runIndexingAction(() => window.doclight.startIndexingRebuild()));
  }
  if (indexingCancelBtn) {
    indexingCancelBtn.addEventListener('click', () => runIndexingAction(() => window.doclight.cancelIndexingJob()));
  }
  if (indexingRetryBtn) {
    indexingRetryBtn.addEventListener('click', () => runIndexingAction(() => window.doclight.retryIndexingFailures()));
  }
  if (indexingCompactBtn) {
    indexingCompactBtn.addEventListener('click', () => {
      if (!confirm(t('settings.indexingCompactConfirm'))) return;
      runIndexingAction(() => window.doclight.compactSearchIndex());
    });
  }
  if (indexingOpenDirBtn) {
    indexingOpenDirBtn.addEventListener('click', () => runIndexingAction(() => window.doclight.openIndexDataDir()));
  }
  if (linkedImportBtn) {
    linkedImportBtn.addEventListener('click', async () => {
      if (!window.doclight.importLinkedMarkdown) return;
      linkedImportBtn.disabled = true;
      if (linkedImportStatusEl) linkedImportStatusEl.textContent = t('settings.processing');
      try {
        const result = await window.doclight.importLinkedMarkdown();
        if (result && result.cancelled) {
          if (linkedImportStatusEl) linkedImportStatusEl.textContent = '';
          return;
        }
        if (!result || result.success === false) {
          if (linkedImportStatusEl) linkedImportStatusEl.textContent = formatLinkedImportMessage((result && result.message) || t('settings.linkedImportFailed'));
          return;
        }
        const counts = result.counts || {};
        if (linkedImportStatusEl) {
          linkedImportStatusEl.textContent = t(result.unconfirmedCount > 0
            ? 'settings.linkedImportUnconfirmed' : 'settings.linkedImportComplete', {
            imported: counts.imported || 0,
            updated: counts.updated || 0,
            existing: counts.existing || 0,
            skipped: counts.skipped || 0,
            unconfirmed: result.unconfirmedCount || 0
          });
        }
        await refreshIndexingStatus();
      } catch (err) {
        if (linkedImportStatusEl) linkedImportStatusEl.textContent = t('settings.errorPrefix', { message: formatLinkedImportMessage(err.message) });
      } finally {
        linkedImportBtn.disabled = false;
      }
    });
  }

  // ==========================================================================
  // File Association
  // ==========================================================================
  const fileAssocCheckbox = document.getElementById('fileAssociation-checkbox');
  const fileAssocHint = document.getElementById('file-assoc-hint');
  const fileAssocStatusEl = document.getElementById('file-assoc-status');
  const openDefaultAppsBtn = document.getElementById('open-default-apps-btn');

  function showFileAssocStatus(type, message) {
    fileAssocStatusEl.className = 'status-indicator ' + type;
    fileAssocStatusEl.textContent = message;
    fileAssocStatusEl.classList.remove('hidden');
    if (type === 'success') {
      setTimeout(() => {
        fileAssocStatusEl.classList.add('hidden');
      }, 3000);
    }
  }

  async function initFileAssociation() {
    try {
      const status = await window.doclight.getFileAssociationStatus();

      if (!status.supported) {
        fileAssocCheckbox.disabled = true;
        fileAssocHint.textContent = t('settings.unsupported');
        return;
      }

      fileAssocCheckbox.checked = status.registered || status.settingValue;

      // Platform-specific hints
      if (status.platform === 'darwin') {
        fileAssocHint.textContent = t('settings.hintMac');
        openDefaultAppsBtn.classList.remove('hidden');
      } else if (status.platform === 'win32') {
        fileAssocHint.textContent = t('settings.hintWindows');
        openDefaultAppsBtn.classList.remove('hidden');
      } else {
        fileAssocHint.textContent = t('settings.hintLinux');
      }
    } catch (err) {
      console.error('Failed to load file association status:', err);
      fileAssocCheckbox.disabled = true;
      fileAssocHint.textContent = t('settings.cannotCheckStatus');
    }
  }

  fileAssocCheckbox.addEventListener('change', async () => {
    fileAssocCheckbox.disabled = true;
    showFileAssocStatus('info', t('settings.processing'));
    try {
      const result = fileAssocCheckbox.checked
        ? await window.doclight.registerFileAssociation()
        : await window.doclight.unregisterFileAssociation();
      if (result.success) {
        showFileAssocStatus('success', result.message);
      } else {
        fileAssocCheckbox.checked = !fileAssocCheckbox.checked; // revert
        showFileAssocStatus('error', result.message);
      }
    } catch (err) {
      fileAssocCheckbox.checked = !fileAssocCheckbox.checked; // revert
      showFileAssocStatus('error', t('settings.errorPrefix', { message: err.message }));
    } finally {
      fileAssocCheckbox.disabled = false;
    }
  });

  openDefaultAppsBtn.addEventListener('click', () => {
    window.doclight.openDefaultAppsSettings();
  });

  // === MCP Auto Save ===
  const mcpAutoSaveCheckbox = document.getElementById('mcpAutoSave-checkbox');
  const mcpAutoSavePathInput = document.getElementById('mcpAutoSavePath-input');
  const mcpAutoSavePathBrowseBtn = document.getElementById('mcpAutoSavePath-browse-btn');

  function hasDocumentStorePath() {
    return Boolean(mcpAutoSavePathInput && mcpAutoSavePathInput.value.trim());
  }

  function hasSavedDocumentStorePath() {
    const currentPath = mcpAutoSavePathInput ? mcpAutoSavePathInput.value.trim() : '';
    return Boolean(savedDocumentStorePath && currentPath && currentPath === savedDocumentStorePath);
  }

  function updateAutoSavePathState() {
    // Path input is always enabled (manual save uses it even when auto-save is off)
    const hasPath = hasDocumentStorePath();
    const hasSavedPath = hasSavedDocumentStorePath();
    if (mcpAutoSaveCheckbox) {
      mcpAutoSaveCheckbox.disabled = !hasPath;
      if (!hasPath) mcpAutoSaveCheckbox.checked = false;
    }
    if (indexingManageBtn) {
      indexingManageBtn.disabled = !hasSavedPath;
    }
    if (registerOpenedMarkdownCheckbox) {
      registerOpenedMarkdownCheckbox.disabled = !hasPath;
      if (!hasPath) registerOpenedMarkdownCheckbox.checked = false;
    }
    if (registerOpenedMarkdownUnavailable) {
      registerOpenedMarkdownUnavailable.classList.toggle('hidden', hasPath);
    }
  }

  if (mcpAutoSaveCheckbox) {
    mcpAutoSaveCheckbox.addEventListener('change', updateAutoSavePathState);
  }
  if (mcpAutoSavePathInput) {
    mcpAutoSavePathInput.addEventListener('input', updateAutoSavePathState);
  }

  if (mcpAutoSavePathBrowseBtn) {
    mcpAutoSavePathBrowseBtn.addEventListener('click', async () => {
      try {
        const dir = await window.doclight.pickDirectory();
        if (dir && mcpAutoSavePathInput) {
          mcpAutoSavePathInput.value = dir;
          updateAutoSavePathState();
        }
      } catch (err) {
        console.error('Failed to pick directory:', err);
      }
    });
  }

  // === Subdirectory Format Help Modal ===
  const subdirHelpBtn = document.getElementById('mcpSaveSubDir-help-btn');
  const subdirHelpModal = document.getElementById('subdir-help-modal');
  if (subdirHelpBtn && subdirHelpModal) {
    const helpBody = document.getElementById('subdir-help-body');
    subdirHelpBtn.addEventListener('click', function () {
      if (helpBody) helpBody.textContent = t('settings.mcpSaveSubDirHelpContent');
      subdirHelpModal.classList.remove('hidden');
    });
    var closeBtn = subdirHelpModal.querySelector('.modal-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', function () { subdirHelpModal.classList.add('hidden'); });
    subdirHelpModal.addEventListener('click', function (ev) {
      if (ev.target === subdirHelpModal) subdirHelpModal.classList.add('hidden');
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !subdirHelpModal.classList.contains('hidden')) {
        subdirHelpModal.classList.add('hidden');
      }
    });
  }

  // Load on startup
  document.addEventListener('DOMContentLoaded', async () => {
    await initI18n();
    setSettingsTitle('settings.heading');
    document.title = t('settings.pageTitle');
    await loadSettings();
    settingsStatusPoller = window.createSettingsStatusPoller({
      refreshIndexingStatus,
      isActive: isSettingsStatusActive,
      activeDelayMs: ACTIVE_INDEXING_POLL_MS,
      idleDelayMs: IDLE_INDEXING_POLL_MS
    });
    await settingsStatusPoller.start();
    initFileAssociation();
    // Check port availability immediately on load
    const initialPort = parseInt(fields.mcpPort.value, 10);
    if (!isNaN(initialPort) && initialPort >= 1024 && initialPort <= 65535) {
      checkPortStatus(initialPort);
    }
  });

  window.addEventListener('beforeunload', () => {
    if (settingsStatusPoller) settingsStatusPoller.stop();
  });
})();
