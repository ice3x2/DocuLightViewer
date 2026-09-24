'use strict';
const path = require('node:path');
const { BrowserWindow, ipcMain } = require('electron');

// @req FR-APP-013 AC-1 AC-2 AC-3 AC-6
module.exports = { name: 's24', async run({ assert }) {
  const strings = require('../../../src/locales/en.json');
  const handlers = {
    'get-strings': () => ({ strings, locale: 'en' }),
    'get-settings': () => ({ mcpAutoSavePath: 'C:\\notes' }),
    'indexing:get-status': () => ({ state: 'ready', ledgerState: 'READY', ledgerCode: 'ledger_ready', sourceRootConfigured: true }),
    'get-file-association-status': () => ({ supported: true, registered: false }),
    'check-port-available': () => true
  };
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);
  const win = new BrowserWindow({ show: true, webPreferences: {
    preload: path.join(__dirname, '../../../src/main/preload.js'), contextIsolation: true, nodeIntegration: false
  } });
  try {
    await win.loadFile(path.join(__dirname, '../../../src/renderer/settings.html'));
    await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 100))');
    const state = await win.webContents.executeJavaScript(`({
      registration: document.querySelector('[id^="embedding-"]'),
      bridge: ['getEmbeddingModelStatus','validateEmbeddingModel','saveEmbeddingModelSettings','clearEmbeddingModelSettings']
        .filter(name => typeof window.doclight[name] === 'function'),
      heading: document.getElementById('settings-title').textContent,
      indexing: document.getElementById('indexing-status').textContent,
      mainVisible: !document.getElementById('settings-main-view').classList.contains('hidden')
    })`);
    assert(state.registration === null, 'real Settings DOM has no embedding controls');
    assert(state.bridge.length === 0, 'real isolated renderer exposes no embedding bridge');
    assert(state.mainVisible && state.heading && state.indexing, 'Settings loads with localized indexing state');
  } finally {
    win.destroy();
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
  }
} };
