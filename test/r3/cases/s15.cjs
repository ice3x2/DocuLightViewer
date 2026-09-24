'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { saveMcpFile, saveMcpUpdatedContent, mcpManualSave } = require('../../../src/main/mcp-save');
const { readPendingSave } = require('../../../src/main/index-ingress-store');
const { registerRendererSaveHandlers } = require('../../../src/main/renderer-save-handlers');
const { OwnerWorkerController } = require('../../../src/main/search-owner-controller');
const { SourceLedgerStore } = require('../../../src/main/source-ledger-store');
const { runStdioEntry } = require('./s15-stdio.cjs');

// @req FR-DOC-019 FR-DOC-035 IR-MCP-018 IR-MCP-019 REL-DOC-009 SEC-DOC-003
module.exports = { async run(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s15-'));
  const storeRoot = path.join(root, 'documents');
  const ingressRoot = path.join(root, 'private');
  fs.mkdirSync(storeRoot);
  fs.mkdirSync(ingressRoot);
  let lastDir = storeRoot;
  const store = { get(key, fallback) { return ({ mcpAutoSave: true, mcpAutoSavePath: storeRoot,
    mcpSaveSubDir: '', userDataPath: root, lastSaveAsDirectory: lastDir })[key] ?? fallback; },
  set(key, value) { if (key === 'lastSaveAsDirectory') lastDir = value; } };
  const calls = [];
  const ownerController = { config: { ingressRoot }, async acceptPublishedSave(input) {
    calls.push(input);
    const intent = readPendingSave({ storeRoot, ingressRoot, intentId: input.intentId });
    context.assert(intent?.published === true && fs.existsSync(path.join(storeRoot, intent.sourceRelativeLocator)),
      'owner receives only after durable intent and file publication');
    return { accepted: true, desiredRevision: calls.length, indexingState: 'queued',
      indexing: { state: 'queued', jobId: `job-${calls.length}` } };
  } };
  const searchEngine = { ownerController, markDirty(input) {
    if (input.filePath === path.join(root, 'external.md')) return;
    throw new Error('duplicate legacy enqueue');
  } };
  try {
    const saved = await saveMcpFile(store, { content: '# Open\n', title: 'Open' }, searchEngine);
    context.assert(Boolean(saved) && calls.length === 1, 'content-only open uses durable ingress once');
    context.assert(readPendingSave({ storeRoot, ingressRoot, intentId: calls[0].intentId }).provenance.aliases.length === 0,
      'content-only open has no invented original path');
    const entry = { meta: { savedFilePath: saved, lastRenderedContent: '# Update one\n', title: 'Open' } };
    await saveMcpUpdatedContent(store, entry, {}, searchEngine);
    entry.meta.lastRenderedContent = '# Update two\n';
    await saveMcpUpdatedContent(store, entry, {}, searchEngine);
    context.assert(calls.length === 3 && fs.readFileSync(saved, 'utf8') === '# Update two\n',
      'two updates publish latest bytes through one owner acceptance each');
    context.assert(calls.every(call => call.desiredRevision === undefined),
      'producer never allocates desiredRevision');
    const acceptKeys = ['contentHash', 'intentId', 'operation', 'provenance', 'rootFingerprint',
      'sourceId', 'sourceRelativeLocator'];
    context.assert(calls.every(call => JSON.stringify(Object.keys(call).sort()) === JSON.stringify(acceptKeys)),
      'configured-root producer sends exactly seven private owner fields and no raw root paths');
    const manual = await mcpManualSave(store, { content: '# Manual\n', title: 'Manual' }, searchEngine);
    context.assert(manual.success === true && calls.length === 4,
      'renderer manual save uses same durable ingress');
    const handlers = new Map();
    const rendererWin = {};
    const rendererEntry = { meta: { savedFilePath: null, title: 'Renderer title' } };
    registerRendererSaveHandlers({ ipcMain: { handle(name, handler) { handlers.set(name, handler); } },
      dialog: { async showSaveDialog() { return { canceled: false,
        filePath: path.join(storeRoot, 'chosen.md') }; } },
      BrowserWindow: { fromWebContents() { return rendererWin; } },
      windowManager: { findWindowId(win) { return win === rendererWin ? 'renderer-1' : null; },
        getWindowEntry(id) { return id === 'renderer-1' ? rendererEntry : null; } },
      store, searchEngine });
    const saveAs = await handlers.get('save-as')({ sender: {} }, { content: '# Chosen\n' });
    context.assert(saveAs.success === true && calls.length === 5
      && fs.readFileSync(saveAs.filePath, 'utf8') === '# Chosen\n',
    'renderer save-as IPC preserves chosen file and publishes one durable intent');
    const quick = await handlers.get('quick-save')({}, { defaultFileName: 'chosen.md', content: '# Quick\n' });
    context.assert(quick.success === true && calls.length === 6
      && fs.readFileSync(quick.filePath, 'utf8') === '# Quick\n',
    'renderer quick-save IPC updates chosen file through durable owner');
    const { createToolHandlers } = await import(pathToFileURL(path.join(__dirname,
      '../../../src/main/mcp-http.mjs')).href);
    const entries = new Map();
    const windowManager = {
      async createWindow(params) {
        const windowId = `window-${entries.size + 1}`;
        entries.set(windowId, { meta: { title: params.title || 'HTTP',
          lastRenderedContent: params.content }, win: { isDestroyed: () => false,
          webContents: { send() {} }, setAlwaysOnTop() {} } });
        return { windowId, title: params.title || 'HTTP' };
      },
      getWindowEntry(id) { return entries.get(id); },
      async updateWindow(id, params) {
        const entry = entries.get(id);
        entry.meta.lastRenderedContent = params.content;
        return { windowId: id, title: entry.meta.title };
      }
    };
    const http = createToolHandlers(windowManager, store, searchEngine);
    const opened = await http.open_markdown({ content: '# HTTP open\n', title: 'HTTP' });
    context.assert(opened.content[0].text.includes('windowId: window-1') && calls.length === 7,
      'HTTP open entrypoint preserves windowId and reaches durable owner once');
    await http.update_markdown({ windowId: 'window-1', content: '# HTTP update\n' });
    context.assert(calls.length === 8
      && fs.readFileSync(entries.get('window-1').meta.savedFilePath, 'utf8') === '# HTTP update\n',
    'HTTP update entrypoint publishes latest window bytes once');
    const externalPath = path.join(root, 'external.md');
    fs.writeFileSync(externalPath, '# Before\n');
    const externalEntry = { meta: { savedFilePath: externalPath,
      lastRenderedContent: '# After\n', title: 'External' } };
    try { await saveMcpUpdatedContent(store, externalEntry, {}, searchEngine); }
    catch { /* persistence assertion below defines the expected behavior */ }
    context.assert(fs.readFileSync(externalPath, 'utf8') === '# After\n',
      'existing externally chosen save path remains editable pending S16 registration');
    context.assert(typeof handlers.get('mcp-manual-save') === 'function',
      'renderer manual-save IPC entrypoint is registered with shared save handlers');
    const manualIpc = await handlers.get('mcp-manual-save')({ sender: {} },
      { content: '# Manual IPC\n', title: 'Manual IPC' });
    context.assert(manualIpc.success === true && calls.length === 10
      && rendererEntry.meta.savedFilePath === manualIpc.filePath
      && fs.readFileSync(manualIpc.filePath, 'utf8') === '# Manual IPC\n',
    'registered renderer manual-save IPC keeps file path and window metadata after one durable owner call');
    ownerController.acceptPublishedSave = async input => { calls.push(input); throw new Error('owner unavailable'); };
    const failedManualIpc = await handlers.get('mcp-manual-save')({ sender: {} },
      { content: '# Manual retained\n', title: 'Retained' });
    const failedManualIntent = readPendingSave({ storeRoot, ingressRoot,
      intentId: calls.at(-1).intentId });
    context.assert(failedManualIpc.success === true && calls.length === 11
      && rendererEntry.meta.title === 'Renderer title'
      && rendererEntry.meta.savedFilePath === failedManualIpc.filePath
      && fs.readFileSync(failedManualIpc.filePath, 'utf8') === '# Manual retained\n'
      && failedManualIntent?.published === true,
    'manual IPC owner failure retains file, window metadata, and private retry intent');
    const failed = await saveMcpFile(store, { content: '# Failed enqueue\n', title: 'Retained' }, searchEngine);
    context.assert(Boolean(failed) && fs.existsSync(failed) && calls.length === 12,
      'saved file survives owner acceptance failure');
    const beforeUnavailable = fs.readdirSync(ingressRoot).filter(name => name.endsWith('.intent.json')).length;
    const unavailableSearch = { saveDocumentIngressRoot: ingressRoot,
      async getSaveDocumentOwner() { throw new Error('owner start failed'); },
      markDirty() { throw new Error('legacy enqueue while owner unavailable'); } };
    const unavailablePath = await saveMcpFile(store, { content: '# Owner unavailable\n',
      title: 'Unavailable' }, unavailableSearch);
    context.assert(Boolean(unavailablePath) && fs.readFileSync(unavailablePath, 'utf8') === '# Owner unavailable\n'
      && fs.readdirSync(ingressRoot).filter(name => name.endsWith('.intent.json')).length === beforeUnavailable + 1,
    'owner unavailable still publishes body-free durable intent and final file without legacy enqueue');
    const blockedIngress = path.join(root, 'blocked-ingress');
    fs.writeFileSync(blockedIngress, 'not a directory');
    const beforeBlocked = fs.readdirSync(storeRoot, { recursive: true }).filter(name => name.endsWith('.md')).length;
    const blockedPath = await saveMcpFile(store, { content: '# No ingress\n', title: 'Blocked' },
      { saveDocumentIngressRoot: blockedIngress,
        async getSaveDocumentOwner() { throw new Error('owner start failed'); },
        markDirty() { throw new Error('legacy enqueue with no safe ingress'); } });
    context.assert(blockedPath === null
      && fs.readdirSync(storeRoot, { recursive: true }).filter(name => name.endsWith('.md')).length === beforeBlocked,
    'unsafe ingress fails before file publication and does not use legacy enqueue');
    const realRoot = path.join(root, 'real-documents');
    const realIngress = path.join(root, 'real-private');
    fs.mkdirSync(realRoot);
    fs.mkdirSync(realIngress);
    const realOwner = new OwnerWorkerController({ ledgerPath: path.join(root, 'real-ledger.sqlite'),
      keywordPath: path.join(root, 'real-keyword.sqlite'), sourceRoot: realRoot,
      ingressRoot: realIngress, keywordTokenizerProvider: 'basic', deriveDocuments: false });
    try {
      await realOwner.start();
      const replies = [];
      const realSearch = { ownerController: { config: realOwner.config,
        async acceptPublishedSave(input) {
          const reply = await realOwner.acceptPublishedSave(input);
          replies.push(reply);
          return reply;
        } }, markDirty() { throw new Error('duplicate legacy enqueue'); } };
      const realStore = { get(key, fallback) { return ({ mcpAutoSave: true,
        mcpAutoSavePath: realRoot, mcpSaveSubDir: '' })[key] ?? fallback; } };
      const realPath = await saveMcpFile(realStore, { content: '# Real open\n', title: 'Real' }, realSearch);
      const realEntry = { meta: { savedFilePath: realPath,
        lastRenderedContent: '# Real update one\n', title: 'Real' } };
      await saveMcpUpdatedContent(realStore, realEntry, {}, realSearch);
      realEntry.meta.lastRenderedContent = '# Real update two\n';
      await saveMcpUpdatedContent(realStore, realEntry, {}, realSearch);
      context.assert(replies.length === 3 && replies.every(reply => reply.accepted
        && reply.indexingState === 'queued' && Boolean(reply.indexing.jobId)),
      'real owner commits a durable job before each producer ACK');
      context.assert(replies[0].documentId === replies[1].documentId
        && replies[1].documentId === replies[2].documentId
        && replies[0].desiredRevision < replies[1].desiredRevision
        && replies[1].desiredRevision < replies[2].desiredRevision
        && fs.readFileSync(realPath, 'utf8') === '# Real update two\n',
      'real owner preserves document identity and latest desired revision after two updates');
      const ledger = new SourceLedgerStore({ dbPath: path.join(root, 'real-ledger.sqlite') });
      try {
        const row = ledger.open().prepare(`SELECT desired_revision, desired_content_hash, current_job_id
          FROM documents WHERE document_id = ?`).get(replies[2].documentId);
        context.assert(row.desired_revision === replies[2].desiredRevision
          && row.desired_content_hash === `sha256:${crypto.createHash('sha256').update('# Real update two\n').digest('hex')}`
          && row.current_job_id === replies[2].indexing.jobId,
        'persisted owner document points to latest requested revision, file hash, and job');
      } finally { ledger.close(); }
      const rename = fs.renameSync;
      let denied = false;
      realEntry.meta.lastRenderedContent = '# Real update after busy read\n';
      try {
        fs.renameSync = function (from, to) {
          if (!denied && to === realPath) {
            denied = true;
            throw Object.assign(new Error('temporarily busy'), { code: 'EPERM' });
          }
          return rename.call(this, from, to);
        };
        try { await saveMcpUpdatedContent(realStore, realEntry, {}, realSearch); }
        catch { /* final file assertion below defines retry behavior */ }
      } finally { fs.renameSync = rename; }
      context.assert(denied && fs.readFileSync(realPath, 'utf8') === '# Real update after busy read\n'
        && replies.at(-1).accepted === true,
      'temporary Windows reader contention retries atomic replacement without losing latest save');
    } finally { await realOwner.shutdown(); }
    await runStdioEntry(root, path.join(__dirname, '../../../src/main/mcp-server.mjs'), context);
    await runStdioEntry(root, path.join(__dirname, '../../../src/main/mcp-server.bundle.mjs'), context);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
} };
