(function() {
  'use strict';

  const DEFAULTS = {
    theme: 'light',
    fontSize: 16,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    codeTheme: 'github',
    mcpPort: 52580,
    defaultWindowSize: 'auto'
  };

  const VALIDATION = {
    fontSize: { min: 8, max: 32 },
    mcpPort: { min: 1024, max: 65535 }
  };

  // DOM elements
  const saveBtn = document.getElementById('save-button');
  const resetBtn = document.getElementById('reset-button');
  const saveMessage = document.getElementById('save-message');

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

  // Populate form fields
  function populateForm(settings) {
    for (const [key, element] of Object.entries(fields)) {
      if (element) {
        element.value = settings[key] !== undefined ? settings[key] : DEFAULTS[key];
      }
    }
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

    return values;
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
    if (!confirm('모든 설정을 기본값으로 초기화하시겠습니까?')) return;

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
        fileAssocHint.textContent = '빌드된 앱에서만 사용 가능합니다';
        return;
      }

      fileAssocCheckbox.checked = status.registered || status.settingValue;

      // Platform-specific hints
      if (status.platform === 'darwin') {
        fileAssocHint.textContent = '등록 후 시스템 설정에서 기본 앱을 선택해야 합니다';
        openDefaultAppsBtn.classList.remove('hidden');
      } else if (status.platform === 'win32') {
        fileAssocHint.textContent = '등록 후 "연결 프로그램"에서 DocuLight를 선택할 수 있습니다';
        openDefaultAppsBtn.classList.remove('hidden');
      } else {
        fileAssocHint.textContent = 'XDG MIME 기반으로 등록됩니다';
      }
    } catch (err) {
      console.error('Failed to load file association status:', err);
      fileAssocCheckbox.disabled = true;
      fileAssocHint.textContent = '상태를 확인할 수 없습니다';
    }
  }

  fileAssocCheckbox.addEventListener('change', async () => {
    fileAssocCheckbox.disabled = true;
    showFileAssocStatus('info', '처리 중...');
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
      showFileAssocStatus('error', `오류: ${err.message}`);
    } finally {
      fileAssocCheckbox.disabled = false;
    }
  });

  openDefaultAppsBtn.addEventListener('click', () => {
    window.doclight.openDefaultAppsSettings();
  });

  // Load on startup
  document.addEventListener('DOMContentLoaded', () => {
    loadSettings();
    initFileAssociation();
  });
})();
