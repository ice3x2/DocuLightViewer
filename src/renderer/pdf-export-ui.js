// src/renderer/pdf-export-ui.js — PDF export modal module
(function () {
  'use strict';

  let modal = null;
  let isModalOpen = false;
  let previousFocus = null;
  let progressCleanup = null;

  function init() {
    const exportBtn = document.getElementById('btn-export-pdf');
    modal = document.getElementById('pdf-modal');

    if (!exportBtn || !modal) return;

    exportBtn.addEventListener('click', () => {
      openModal();
    });

    // Save button
    const saveBtn = modal.querySelector('.pdf-save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', handleSave);
    }

    // Cancel/Close button
    const cancelBtn = modal.querySelector('.pdf-cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        handleCancel();
      });
    }

    // Close on overlay click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeModal();
      }
    });

    // Handle pdfMode for hidden PDF rendering windows
    if (window.doclight && window.doclight.onRenderMarkdown) {
      // This is handled in the render-markdown listener in viewer.js
    }
  }

  function openModal() {
    if (!modal || isModalOpen) return;
    isModalOpen = true;
    previousFocus = document.activeElement;

    // Check if content-only mode (no sidebar tree)
    const hasTree = window.DocuLight && window.DocuLight.state && window.DocuLight.state.sidebarTree;
    const allRadio = modal.querySelector('#pdf-scope-all');
    if (allRadio) {
      allRadio.disabled = !hasTree;
      if (!hasTree) {
        const currentRadio = modal.querySelector('#pdf-scope-current');
        if (currentRadio) currentRadio.checked = true;
      }
    }

    // Reset progress
    const progressContainer = modal.querySelector('.pdf-progress-container');
    if (progressContainer) progressContainer.classList.add('hidden');
    const progressBar = modal.querySelector('.pdf-progress-fill');
    if (progressBar) progressBar.style.width = '0%';
    const progressText = modal.querySelector('.pdf-progress-text');
    if (progressText) progressText.textContent = '';

    // Show save/cancel, hide "done" state
    const saveBtn = modal.querySelector('.pdf-save-btn');
    const cancelBtn = modal.querySelector('.pdf-cancel-btn');
    if (saveBtn) { saveBtn.disabled = false; saveBtn.classList.remove('hidden'); }
    if (cancelBtn) cancelBtn.textContent = getCancelLabel();

    modal.classList.remove('hidden');

    // Focus trap
    const firstFocusable = modal.querySelector('input, button, select');
    if (firstFocusable) firstFocusable.focus();

    // Register progress listener
    if (window.doclight && window.doclight.onExportProgress) {
      progressCleanup = window.doclight.onExportProgress((data) => {
        updateProgress(data);
      });
    }
  }

  function closeModal() {
    if (!modal) return;
    isModalOpen = false;
    modal.classList.add('hidden');

    // Cleanup progress listener
    if (progressCleanup) {
      progressCleanup();
      progressCleanup = null;
    }

    // Restore focus
    if (previousFocus && previousFocus.focus) {
      previousFocus.focus();
    }
    previousFocus = null;
  }

  async function handleSave() {
    const scopeEl = modal.querySelector('input[name="pdf-scope"]:checked');
    const pageSizeEl = modal.querySelector('#pdf-page-size');
    if (!scopeEl || !pageSizeEl) return;

    const scope = scopeEl.value;
    const pageSize = pageSizeEl.value;

    // Disable save button during export
    const saveBtn = modal.querySelector('.pdf-save-btn');
    if (saveBtn) saveBtn.disabled = true;

    // Show progress for batch
    if (scope === 'all') {
      const progressContainer = modal.querySelector('.pdf-progress-container');
      if (progressContainer) progressContainer.classList.remove('hidden');
    }

    try {
      const result = await window.doclight.exportPdf({ scope, pageSize });

      if (result.error) {
        console.error('[doculight] PDF export error:', result.error);
        if (saveBtn) saveBtn.disabled = false;
        return;
      }

      if (result.cancelled) {
        closeModal();
        return;
      }

      if (result.success) {
        // Show completion message briefly then close
        const progressText = modal.querySelector('.pdf-progress-text');
        const t = window.DocuLight && window.DocuLight.fn && window.DocuLight.fn.t;
        if (progressText) {
          progressText.textContent = t ? t('viewer.exportComplete') : 'Export complete';
        }
        setTimeout(() => {
          closeModal();
        }, 2000);
      }
    } catch (err) {
      console.error('[doculight] PDF export error:', err);
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  function handleCancel() {
    if (isExporting()) {
      // Cancel ongoing export
      if (window.doclight && window.doclight.cancelExport) {
        window.doclight.cancelExport();
      }
    }
    closeModal();
  }

  function isExporting() {
    const saveBtn = modal ? modal.querySelector('.pdf-save-btn') : null;
    return saveBtn && saveBtn.disabled;
  }

  function updateProgress(data) {
    if (!modal) return;
    const progressContainer = modal.querySelector('.pdf-progress-container');
    const progressBar = modal.querySelector('.pdf-progress-fill');
    const progressText = modal.querySelector('.pdf-progress-text');

    if (progressContainer) progressContainer.classList.remove('hidden');
    if (progressBar) {
      const pct = data.total > 0 ? (data.current / data.total * 100) : 0;
      progressBar.style.width = pct + '%';
    }
    if (progressText) {
      progressText.textContent = `${data.current}/${data.total} - ${data.fileName || ''}`;
    }
  }

  function getCancelLabel() {
    const t = window.DocuLight && window.DocuLight.fn && window.DocuLight.fn.t;
    return t ? t('viewer.exportCancel') : 'Cancel';
  }

  function isActive() {
    return isModalOpen;
  }

  // Register module
  if (!window.__docuLightModules) window.__docuLightModules = [];
  window.__docuLightModules.push({
    name: 'pdfExportUi',
    init: init,
    isActive: isActive,
    openModal: openModal,
    closeModal: closeModal
  });
})();
