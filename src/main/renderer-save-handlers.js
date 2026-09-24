'use strict';
const path = require('node:path');
const { saveRendererFile, mcpManualSave } = require('./mcp-save');

// @req FR-DOC-019 REL-DOC-009
function registerRendererSaveHandlers({ ipcMain, dialog, BrowserWindow, windowManager, store, searchEngine }) {
  ipcMain.handle('save-as', async (event, params) => {
    try {
      const parentWindow = BrowserWindow.fromWebContents(event.sender);
      const lastDir = store.get('lastSaveAsDirectory', '');
      const defaultName = params.defaultFileName || 'untitled.md';
      const defaultPath = lastDir ? path.join(lastDir, defaultName) : defaultName;
      const result = await dialog.showSaveDialog(parentWindow, {
        defaultPath, filters: [{ name: 'Markdown', extensions: ['md'] }]
      });
      if (result.canceled) return { success: false };
      const savePath = result.filePath;
      store.set('lastSaveAsDirectory', path.dirname(savePath));
      const saved = await saveRendererFile(store, savePath, params, searchEngine);
      return { success: true, filePath: savePath, indexingState: saved.indexingState, warningCode: saved.warningCode };
    } catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('quick-save', async (_event, params) => {
    try {
      const lastDir = store.get('lastSaveAsDirectory', '');
      if (!lastDir) return { success: false, reason: 'no-directory' };
      const savePath = path.join(lastDir, params.defaultFileName || 'untitled.md');
      const saved = await saveRendererFile(store, savePath, params, searchEngine);
      return { success: true, filePath: savePath, indexingState: saved.indexingState, warningCode: saved.warningCode };
    } catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('mcp-manual-save', async (event, params) => {
    const result = await mcpManualSave(store, params, searchEngine);
    if (result.success) {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) {
        const windowId = windowManager.findWindowId(win);
        if (windowId) {
          const entry = windowManager.getWindowEntry(windowId);
          if (entry) entry.meta.savedFilePath = result.filePath;
        }
      }
    }
    return result;
  });
}

module.exports = { registerRendererSaveHandlers };
