'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf-8');
}

function windowAssert(condition, message) {
  assert(condition, `IR-APP-012 media viewer window contract: ${message}`);
}

const preload = read('src/main/preload.js');
const main = read('src/main/index.js');

for (const apiName of ['openMediaViewer', 'onMediaViewerPayload', 'getMediaViewerPayload', 'downloadMediaAsset']) {
  windowAssert(preload.includes(`${apiName}:`), `preload exposes ${apiName}`);
}

for (const channel of [
  'media-viewer:open',
  'media-viewer:download',
  'media-viewer:get-payload',
  'media-viewer-payload'
]) {
  windowAssert(main.includes(`'${channel}'`) || main.includes(`"${channel}"`), `main process registers or sends ${channel}`);
}

windowAssert(main.includes('createMediaViewerWindow'), 'main process has a dedicated media viewer BrowserWindow factory');
windowAssert(main.includes('mediaViewerWindowsByParent'), 'main process tracks media viewer windows by parent viewer id');
windowAssert(main.includes('mediaViewerParentByWindowId'), 'main process can remove media viewer entries when a media window closes');
windowAssert(main.includes('mediaViewerPayloads'), 'main process stores media viewer payloads for late renderer retrieval');
windowAssert(main.includes('propagateAlwaysOnTopToMediaViewers'), 'main process propagates always-on-top changes to linked media viewers');
windowAssert(main.includes('removeMediaViewerWindow'), 'main process cleans media viewer registry on close');
windowAssert(main.includes('detachMediaViewerParent'), 'main process can detach a closed parent without closing media viewers');
windowAssert(main.includes('mediaViewerParentCloseListeners'), 'main process tracks one parent close listener per parent viewer');
windowAssert(main.includes('ensureMediaViewerParentCloseListener'), 'main process deduplicates parent close listener registration');
windowAssert(main.includes('removeMediaViewerParentCloseListener'), 'main process removes stale parent close listeners when all linked media viewers close');
windowAssert(main.includes("parentWindow.once('closed'") || main.includes('parentWindow.once("closed"'), 'media viewer registry detaches when the parent viewer closes');
windowAssert(main.includes('function isRegisteredMediaViewerWindow'), 'main process can validate registered media viewer callers');
windowAssert(main.includes('function getManagedMarkdownViewerWindowId'), 'main process can validate managed Markdown viewer callers');

const createMediaStart = main.indexOf('function createMediaViewerWindow');
const createMediaEnd = main.indexOf('async function resolveImageDownloadAsset', createMediaStart);
const createMediaBlock = main.slice(createMediaStart, createMediaEnd > createMediaStart ? createMediaEnd : main.length);

windowAssert(createMediaBlock.includes('new BrowserWindow'), 'media viewer uses BrowserWindow');
windowAssert(createMediaBlock.includes('media-viewer.html'), 'media viewer loads the dedicated HTML entry point');
windowAssert(createMediaBlock.includes('mediaViewerPayloads.set'), 'media viewer stores payload before loading the renderer');
windowAssert(createMediaBlock.includes("icon: nativeImage.createFromPath(ICON_PATH)") || createMediaBlock.includes('icon: nativeImage.createFromPath(ICON_PATH)'), 'media viewer uses the DocuLight window icon');
windowAssert(createMediaBlock.includes("backgroundColor: '#ffffff'") || createMediaBlock.includes('backgroundColor: "#ffffff"'), 'media viewer native background is white');
windowAssert(createMediaBlock.includes('preload: path.join(__dirname, \'preload.js\')') || createMediaBlock.includes('preload: path.join(__dirname, "preload.js")'), 'media viewer uses the local preload bridge');
windowAssert(createMediaBlock.includes('contextIsolation: true'), 'media viewer enables contextIsolation');
windowAssert(createMediaBlock.includes('nodeIntegration: false'), 'media viewer disables nodeIntegration');
windowAssert(createMediaBlock.includes('sandbox: true'), 'media viewer enables sandbox');
windowAssert(!/parent\s*:/.test(createMediaBlock), 'media viewer is not created as an Electron child window');
windowAssert(!/parentWindow\.close\(/.test(createMediaBlock), 'parent close cleanup does not close independent media viewers');
windowAssert(!createMediaBlock.includes("parentWindow.once('closed'"), 'media viewer factory delegates parent close listener registration to the deduplicating helper');

const openHandlerStart = main.indexOf("ipcMain.handle('media-viewer:open'");
const openHandlerEnd = main.indexOf("ipcMain.handle('media-viewer:get-payload'", openHandlerStart);
const openHandlerBlock = main.slice(openHandlerStart, openHandlerEnd > openHandlerStart ? openHandlerEnd : openHandlerStart + 900);
windowAssert(openHandlerBlock.includes('getManagedMarkdownViewerWindowId'), 'media-viewer:open validates that the caller is a managed Markdown viewer window');
windowAssert(!openHandlerBlock.includes('`window-${parentWindow.id}`'), 'media-viewer:open does not invent fallback parent ids for unmanaged windows');

const getPayloadHandlerStart = main.indexOf("ipcMain.handle('media-viewer:get-payload'");
const getPayloadHandlerEnd = main.indexOf("ipcMain.handle('media-viewer:download'", getPayloadHandlerStart);
const getPayloadHandlerBlock = main.slice(getPayloadHandlerStart, getPayloadHandlerEnd > getPayloadHandlerStart ? getPayloadHandlerEnd : getPayloadHandlerStart + 700);
windowAssert(getPayloadHandlerBlock.includes('isRegisteredMediaViewerWindow'), 'media-viewer:get-payload rejects callers that are not registered media viewer windows');

const downloadHandlerStart = main.indexOf("ipcMain.handle('media-viewer:download'");
const downloadHandlerEnd = main.indexOf('// Settings: get all settings', downloadHandlerStart);
const downloadHandlerBlock = main.slice(downloadHandlerStart, downloadHandlerEnd > downloadHandlerStart ? downloadHandlerEnd : downloadHandlerStart + 900);
windowAssert(downloadHandlerBlock.includes('isRegisteredMediaViewerWindow'), 'media-viewer:download rejects callers that are not registered media viewer windows');

const pinBlockStart = main.indexOf('propagateAlwaysOnTopToMediaViewers');
const pinBlock = pinBlockStart >= 0 ? main.slice(pinBlockStart, pinBlockStart + 1600) : '';
windowAssert(pinBlock.includes('setAlwaysOnTop'), 'pin propagation applies setAlwaysOnTop to linked media viewers');
windowAssert(pinBlock.includes('isDestroyed'), 'pin propagation ignores destroyed media windows');

for (const handlerName of ['toggle-always-on-top', 'set-always-on-top', 'release-always-on-top']) {
  const idx = main.indexOf(`'${handlerName}'`);
  const block = idx >= 0 ? main.slice(idx, idx + 900) : '';
  windowAssert(block.includes('propagateAlwaysOnTopToMediaViewers'), `${handlerName} propagates pin state to media viewers`);
}

console.log('PASS: IR-APP-012 media viewer window static contract');
