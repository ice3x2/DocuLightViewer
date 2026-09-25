'use strict';
const vm = require('node:vm');

function recordProductIpcChannels(source) {
  const start = source.indexOf('function registerIpcHandlers() {');
  if (start < 0) throw Error('product registerIpcHandlers function missing');
  const closing = /\r?\n}\r?\n/.exec(source.slice(start));
  if (!closing) throw Error('product registerIpcHandlers closing brace missing');
  const end = start + closing.index + closing[0].indexOf('}') + 1;
  const channels = { handled: [], events: [] };
  const ipcMain = {
    handle: (name, callback) => { if (typeof callback !== 'function') throw Error('invalid product IPC handler'); channels.handled.push(name); },
    on: (name, callback) => { if (typeof callback !== 'function') throw Error('invalid product IPC listener'); channels.events.push(name); }
  };
  const registrations = {
    './file-association': { init: () => {} },
    './renderer-save-handlers': { registerRendererSaveHandlers: () => {} }
  };
  const context = {
    ipcMain,
    require: id => {
      if (!registrations[id]) throw Error(`unexpected registration dependency: ${id}`);
      return registrations[id];
    },
    store: {}, dialog: {}, BrowserWindow: {}, windowManager: {}, searchEngine: {}
  };
  vm.runInNewContext(`${source.slice(start, end)}\nregisterIpcHandlers();`, context, { timeout: 1000 });
  return channels;
}

module.exports = { recordProductIpcChannels };
