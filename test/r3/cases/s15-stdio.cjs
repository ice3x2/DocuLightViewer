'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { saveMcpFile, saveMcpUpdatedContent } = require('../../../src/main/mcp-save');
const { readPendingSave } = require('../../../src/main/index-ingress-store');

async function runStdioEntry(root, entry, context) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const label = path.basename(entry).includes('bundle') ? 'bundle' : 'source';
  const storeRoot = path.join(root, `${label}-documents`);
  const ingressRoot = path.join(root, `${label}-private`);
  fs.mkdirSync(storeRoot);
  fs.mkdirSync(ingressRoot);
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\doculight-s15-${process.pid}-${crypto.randomUUID()}`
    : path.join(root, `${label}.sock`);
  const store = { get(key, fallback) { return ({ mcpAutoSave: true,
    mcpAutoSavePath: storeRoot, mcpSaveSubDir: '' })[key] ?? fallback; } };
  const calls = [];
  let failOwner = false;
  const searchEngine = { ownerController: { config: { ingressRoot }, async acceptPublishedSave(input) {
    calls.push(input);
    const intent = readPendingSave({ storeRoot, ingressRoot, intentId: input.intentId });
    context.assert(intent?.published === true, `${label} stdio owner sees published intent`);
    if (failOwner) throw new Error('owner failed after publish');
    return { accepted: true, desiredRevision: calls.length, indexingState: 'queued',
      indexing: { state: 'queued', jobId: `job-${label}-${calls.length}` } };
  } }, markDirty() { throw new Error('legacy duplicate enqueue'); } };
  const windows = new Map();
  const signals = [];
  let mainDispatchCalls = 0;
  const windowId = `${label}-window-1`;
  const windowManager = {
    async createWindow(params) {
      const createdId = windows.size ? `${label}-readonly-${windows.size + 1}` : windowId;
      const meta = { title: params.title || 'Untitled',
        lastRenderedContent: params.content, filePath: params.filePath || null };
      const win = { isDestroyed: () => false,
        webContents: { send(channel, value) {
          if (channel === 'set-saved-file-path') signals.push({ windowId: createdId, ...value });
        } }, setTitle(value) { win.title = value; } };
      windows.set(createdId, { meta, win });
      return { windowId: createdId, title: meta.title };
    },
    async updateWindow(id, params) {
      const existing = windows.get(id);
      existing.meta.lastRenderedContent = params.content;
      if (params.title) existing.meta.title = params.title;
      return { title: existing.meta.title };
    },
    getWindowEntry(id) { return windows.get(id); },
    formatWindowTitle(title) { return title; }
  };
  const mainSource = fs.readFileSync(path.join(__dirname, '../../../src/main/index.js'), 'utf8');
  const dispatchStart = mainSource.indexOf('async function handleIpcMessage(');
  const dispatchEnd = mainSource.indexOf('// PDF Export Helpers', dispatchStart);
  if (dispatchStart < 0 || dispatchEnd < 0) throw new Error('main IPC dispatch not found');
  const dispatchSource = mainSource.slice(dispatchStart, mainSource.lastIndexOf('// =============================================================================', dispatchEnd));
  const dispatchContext = { path, fs, console, store, searchEngine, windowManager,
    saveMcpFile, saveMcpUpdatedContent,
    VALIDATED_MARKDOWN_CONTENT: Symbol('validated'),
    resolveIndexedMarkdownOpen: async ({ documentId }) => documentId === 'doc-readonly'
      ? { content: '# Read only\n', filePathInternal: path.join(storeRoot, 'readonly.md'),
        sourceUsed: 'indexed_copy', originStatus: 'unavailable' } : null,
    injectFrontmatter: require('../../../src/main/frontmatter').injectFrontmatter };
  vm.runInNewContext(`${dispatchSource}\nthis.dispatch = handleIpcMessage;`, dispatchContext,
    { filename: 'src/main/index.js' });
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        mainDispatchCalls += 1;
        void dispatchContext.dispatch(socket, message);
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry],
    cwd: path.resolve(__dirname, '../../..'), env: { ...process.env,
      DOCULIGHT_MCP_IPC_PATH: endpoint, DOCLIGHT_APP_PATH: path.join(root, 'no-app') } });
  const client = new Client({ name: `s15-${label}`, version: '0.0.0' });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(tool => tool.name).sort();
    context.assert(names.length === 8 && names.includes('open_markdown') && names.includes('update_markdown'),
      `${label} stdio exposes exact eight tools`);
    const opened = await client.callTool({ name: 'open_markdown',
      arguments: { content: `# ${label} open\n`, title: 'Visible title' } });
    context.assert(opened.content[0].text.includes(`windowId: ${windowId}`)
      && opened.content[0].text.includes('title: Visible title') && calls.length === 1,
    `${label} real stdio open forwards IPC and keeps visible window identity`);
    const updated = await client.callTool({ name: 'update_markdown',
      arguments: { windowId, content: `# ${label} update\n`, title: 'Updated title' } });
    const savedPath = windows.get(windowId).meta.savedFilePath;
    context.assert(updated.content[0].text.includes(`Updated window ${windowId}`)
      && updated.content[0].text.includes('title: Updated title')
      && fs.readFileSync(savedPath, 'utf8') === `# ${label} update\n`
      && calls.length === 2 && signals.length === 2,
    `${label} real stdio update retains window/path and publishes once`);
    failOwner = true;
    const failure = await client.callTool({ name: 'update_markdown',
      arguments: { windowId, content: `# ${label} retained\n` } });
    const privateIntent = readPendingSave({ storeRoot, ingressRoot, intentId: calls[2].intentId });
    context.assert(failure.isError !== true && failure.content[0].text.includes(`Updated window ${windowId}`)
      && !failure.content[0].text.includes('jobId:')
      && windows.get(windowId).meta.title === 'Updated title'
      && windows.get(windowId).meta.savedFilePath === savedPath
      && fs.readFileSync(savedPath, 'utf8') === `# ${label} retained\n`
      && privateIntent?.published === true && calls.length === 3 && signals.length === 3,
    `${label} post-publication owner failure retains file, window, path signal, and retryable intent`);
    context.assert(mainDispatchCalls === 3,
      `${label} open and updates execute the actual main IPC dispatch entrypoint`);
    const beforeReadonly = fs.readdirSync(ingressRoot).filter(name => name.endsWith('.intent.json')).length;
    const readonly = await client.callTool({ name: 'open_markdown',
      arguments: { documentId: 'doc-readonly', title: 'Read only title' } });
    context.assert(readonly.isError !== true && readonly.content[0].text.includes('sourceUsed: indexed_copy')
      && calls.length === 3 && signals.length === 3
      && fs.readdirSync(ingressRoot).filter(name => name.endsWith('.intent.json')).length === beforeReadonly
      && !fs.existsSync(path.join(storeRoot, 'readonly.md')),
    `${label} documentId open creates no file, intent, or owner job`);
  } finally {
    await client.close();
    await new Promise(resolve => server.close(resolve));
    if (process.platform !== 'win32') { try { fs.unlinkSync(endpoint); } catch {} }
  }
}

module.exports = { runStdioEntry };
