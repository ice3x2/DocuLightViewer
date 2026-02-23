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
    codeTheme: 'github',
    mcpPort: 52580,
    defaultWindowSize: 'auto',
    autoRefresh: true,
    enableTabs: false,
    mcpAutoSave: false,
    mcpAutoSavePath: ''
  };

  const VALIDATION = {
    fontSize: { min: 8, max: 32 },
    mcpPort: { min: 1024, max: 65535 }
  };

  // DOM elements
  const saveBtn = document.getElementById('save-button');
  const resetBtn = document.getElementById('reset-button');
  const saveMessage = document.getElementById('save-message');
  const mcpAddressEl = document.getElementById('mcp-address');
  const mcpCopyToast = document.getElementById('mcp-copy-toast');

  const fields = {
    theme: document.getElementById('theme-select'),
    fontSize: document.getElementById('fontSize-input'),
    fontFamily: document.getElementById('fontFamily-input'),
    codeTheme: document.getElementById('codeTheme-select'),
    mcpPort: document.getElementById('mcpPort-input'),
    defaultWindowSize: document.getElementById('defaultWindowSize-select')
  };

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
    for (const [key, element] of Object.entries(fields)) {
      if (element) {
        element.value = settings[key] !== undefined ? settings[key] : DEFAULTS[key];
      }
    }
    const autoRefreshEl = document.getElementById('autoRefresh-checkbox');
    if (autoRefreshEl) autoRefreshEl.checked = settings.autoRefresh !== undefined ? settings.autoRefresh : DEFAULTS.autoRefresh;
    const enableTabsEl = document.getElementById('enableTabs-checkbox');
    if (enableTabsEl) enableTabsEl.checked = settings.enableTabs !== undefined ? settings.enableTabs : DEFAULTS.enableTabs;
    const mcpAutoSaveEl = document.getElementById('mcpAutoSave-checkbox');
    if (mcpAutoSaveEl) mcpAutoSaveEl.checked = settings.mcpAutoSave !== undefined ? settings.mcpAutoSave : DEFAULTS.mcpAutoSave;
    const mcpAutoSavePathEl = document.getElementById('mcpAutoSavePath-input');
    if (mcpAutoSavePathEl) mcpAutoSavePathEl.value = settings.mcpAutoSavePath || '';
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
    const mcpAutoSaveEl = document.getElementById('mcpAutoSave-checkbox');
    values.mcpAutoSave = mcpAutoSaveEl ? mcpAutoSaveEl.checked : DEFAULTS.mcpAutoSave;
    const mcpAutoSavePathEl = document.getElementById('mcpAutoSavePath-input');
    values.mcpAutoSavePath = mcpAutoSavePathEl ? mcpAutoSavePathEl.value.trim() : DEFAULTS.mcpAutoSavePath;

    return values;
  }

  // MCP port input → update address live
  fields.mcpPort.addEventListener('input', () => {
    const port = parseInt(fields.mcpPort.value, 10);
    if (!isNaN(port) && port >= 1024 && port <= 65535) {
      updateMcpAddress(port);
    }
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

  // Save handler
  saveBtn.addEventListener('click', async () => {
    const settings = collectFormValues();
    try {
      await window.doclight.saveSettings(settings);
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
      showSaveMessage();
    } catch (err) {
      console.error('Failed to reset settings:', err);
    }
  });

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

  function updateAutoSavePathState() {
    const enabled = mcpAutoSaveCheckbox && mcpAutoSaveCheckbox.checked;
    const group = document.getElementById('mcpAutoSavePath-group');
    if (group) group.style.opacity = enabled ? '1' : '0.5';
    if (mcpAutoSavePathInput) mcpAutoSavePathInput.disabled = !enabled;
    if (mcpAutoSavePathBrowseBtn) mcpAutoSavePathBrowseBtn.disabled = !enabled;
  }

  if (mcpAutoSaveCheckbox) {
    mcpAutoSaveCheckbox.addEventListener('change', updateAutoSavePathState);
  }

  if (mcpAutoSavePathBrowseBtn) {
    mcpAutoSavePathBrowseBtn.addEventListener('click', async () => {
      try {
        const dir = await window.doclight.pickDirectory();
        if (dir && mcpAutoSavePathInput) mcpAutoSavePathInput.value = dir;
      } catch (err) {
        console.error('Failed to pick directory:', err);
      }
    });
  }

  // Load on startup
  document.addEventListener('DOMContentLoaded', async () => {
    await initI18n();
    document.title = t('settings.pageTitle');
    loadSettings();
    initFileAssociation();
  });
})();
