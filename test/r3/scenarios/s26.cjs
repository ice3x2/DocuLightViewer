'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { largeMarkdownFixture } = require('../large-markdown-fixture.cjs');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(label, deadlineMs, attempt) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const result = await attempt();
    if (result) return result;
    await pause(50);
  }
  throw new Error(`S26_SETUP_TIMEOUT ${label}`);
}

async function eventually(deadlineMs, attempt, intervalMs = 50) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const result = await attempt();
    if (result) return result;
    await pause(intervalMs);
  }
  return null;
}

function processCommandLine(pid) {
  if (process.platform !== 'win32') return execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' }).trim();
  const safePid = Number(pid);
  if (!Number.isSafeInteger(safePid) || safePid <= 0) throw new Error('invalid owned PID');
  const line = execFileSync('powershell', ['-NoProfile', '-Command',
    `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${safePid}').CommandLine`], { encoding: 'utf8' }).trim();
  return line;
}

function rpc(port, method, params = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params });
    const req = http.request({ hostname: '127.0.0.1', port, path: '/mcp', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('MCP response deadline exceeded')));
    req.end(body);
  });
}

async function tool(port, name, args) {
  const response = await rpc(port, 'tools/call', { name, arguments: args });
  if (response.error || response.result?.isError) throw new Error(`product MCP ${name} failed: ${JSON.stringify(response)}`);
  return response.result;
}
const searchText = result => String(result?.content?.[0]?.text || '');
const hasSearchHit = (result, marker) => /^Found [1-9][0-9]* result/.test(searchText(result))
  && searchText(result).includes(marker);

function privateAction(ipcPath, action, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(ipcPath);
    let body = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('private IPC deadline exceeded')));
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: crypto.randomUUID(), action, params })}\n`));
    socket.on('data', chunk => {
      body += chunk;
      const end = body.indexOf('\n');
      if (end < 0) return;
      socket.end();
      try { resolve(JSON.parse(body.slice(0, end))); } catch (error) { reject(error); }
    });
    socket.on('error', reject);
  });
}

function ledgerSnapshot(executable, root, ledgerPath) {
  const code = `const D=require('better-sqlite3');const db=new D(process.env.DOCULIGHT_R3_LEDGER_READ_PATH,{readonly:true,fileMustExist:true});
    const docs=db.prepare('SELECT document_id,relative_path,desired_revision,completed_revision,dirty,project,category,document_tags_json,metadata_json FROM documents').all();
    const aliases=db.prepare('SELECT document_id,origin_lexical_path_internal,origin_path_internal,canonical_path_hash FROM document_source_aliases').all();
    const jobs=db.prepare('SELECT job_id AS jobId,document_id,status FROM index_jobs').all();
    console.log(JSON.stringify({docs,aliases,jobs}));db.close();`;
  const result = spawnSync(executable, ['-e', code], { cwd: root, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DOCULIGHT_R3_LEDGER_READ_PATH: ledgerPath } });
  if (result.status !== 0) throw new Error(`S26_SETUP_LEDGER_READ ${result.stderr || result.error?.message}`);
  return JSON.parse(result.stdout.trim());
}

function waitForExit(child, deadlineMs) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('S26_SETUP_TIMEOUT product exit')), deadlineMs);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}

async function openExternal(executable, root, env, filePath) {
  const child = spawn(executable, [root, '--profile=dev', filePath], { cwd: root, env,
    stdio: ['ignore', 'pipe', 'pipe'] });
  const code = await waitForExit(child, 10000);
  if (code !== 0) throw new Error(`S26_SETUP_OPEN_EXTERNAL exit=${code}`);
}

function redactedCommandLine(commandLine, root) {
  return commandLine.replaceAll(path.resolve(root), '<R3_ELECTRON_ROOT>')
    .replaceAll(root, '<R3_ELECTRON_ROOT>');
}

// @req FR-DOC-019 FR-DOC-033 FR-DOC-035 DR-DOC-014 IR-MCP-018 IR-APP-013
module.exports = { name: 's26', async run({ executable, root, sourceHash, assert }) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s26-'));
  const userData = path.join(fixture, 'userData');
  const store = path.join(fixture, 'store');
  const externalA = path.join(fixture, 'external-A');
  const externalB = path.join(fixture, 'external-B');
  for (const dir of [userData, store, externalA]) fs.mkdirSync(dir);
  fs.symlinkSync(externalA, externalB, process.platform === 'win32' ? 'junction' : 'dir');
  const ipcPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\doculight-s26-${crypto.randomBytes(8).toString('hex')}`
    : path.join(fixture, 'ipc.sock');
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    mcpAutoSave: true, mcpAutoSavePath: store, mcpSaveSubDir: '', mcpGitInfo: false,
    registerOpenedMarkdown: true
  }));
  const marker = `s26${crypto.randomBytes(8).toString('hex')}`;
  const oldQuery = 'zzzxq';
  const newQuery = 'qqqjz';
  const old = `${oldQuery}${crypto.randomBytes(8).toString('hex')}`;
  const newer = `${newQuery}${crypto.randomBytes(8).toString('hex')}`;
  const firstBytes = Buffer.from(`---\nproject: s26-project\ncategory: s26-category\ndocumentTags: [s26-tag]\n---\n# S26 original\n\n${old}\n`);
  fs.writeFileSync(path.join(externalA, 'source.md'), firstBytes);
  const externalAFile = path.join(externalA, 'source.md');
  const externalBFile = path.join(externalB, 'source.md');
  const evidence = { sourceHash, marker, oldMarker: old, newMarker: newer,
    oldQuery, newQuery,
    fixtureSeed: marker, firstSha256: sha(firstBytes),
    firstBytes: firstBytes.length, electronVersion: require(path.join(root, 'node_modules/electron/package.json')).version,
    nodeVersion: process.version, platform: process.platform, arch: process.arch, runs: [] };
  let child;
  try {
    const env = { ...process.env, DOCULIGHT_PROFILE: 'dev',
      DOCULIGHT_DEV_USER_DATA_DIR: userData, DOCULIGHT_DEV_IPC_PATH: ipcPath,
      DOCULIGHT_R3_TEST_LIFECYCLE: '1', DOCULIGHT_LOCALE: 'en' };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(executable, [root, '--profile=dev', '--r3-test-lifecycle'], { cwd: root, env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const port = await until('cold product MCP readiness', 20000, async () => {
      if (child.exitCode !== null) throw new Error(`cold product exited ${child.exitCode}: ${output.slice(-1500)}`);
      const portFile = path.join(userData, 'mcp-port');
      if (!fs.existsSync(portFile)) return null;
      const discovered = Number(fs.readFileSync(portFile, 'utf8'));
      if (!Number.isInteger(discovered)) return null;
      try { return (await rpc(discovered, 'ping')).result ? discovered : null; } catch { return null; }
    });
    const commandLine = processCommandLine(child.pid);
    assert(commandLine.includes(path.basename(executable)) && commandLine.includes(root),
      'S26 app-owned Electron PID and full command line inspected');
    evidence.runs.push({ pid: child.pid, commandLine: redactedCommandLine(commandLine, root),
      commandLineSha256: sha(commandLine), port });
    const listed = (await rpc(port, 'tools/list')).result.tools;
    assert(listed.map(item => item.name).join(',') ===
      'open_markdown,update_markdown,close_viewer,list_viewers,search_documents,search_projects,save_document,smart_search',
    'S26 real product exposes exact eight-tool MCP surface');
    const saved = await tool(port, 'save_document', { content: `# S26 control\n\n${marker}seed\n`,
      title: 'S26 lifecycle', project: 's26-project', category: 's26-category', documentTags: ['s26-tag'] });
    const payload = JSON.parse(saved.content[0].text);
    assert(payload.saved === true && payload.documentId && payload.sourceRelativePath
      && payload.indexing?.state === 'queued' && typeof payload.indexing.jobId === 'string'
      && payload.indexing.jobId.startsWith('job_') && payload.indexing.queued === undefined,
    'S26 product file save returns a separate durable owner indexing ACK and diagnostic jobId');
    evidence.documentId = payload.documentId;
    evidence.sourceRelativePath = payload.sourceRelativePath;
    evidence.controlSave = { saved: payload.saved, indexingState: payload.indexing.state,
      jobId: payload.indexing.jobId };
    let lastSearch;
    const seedFound = await eventually(15000, async () => {
      const result = await tool(port, 'search_documents', { query: `${marker}seed` });
      lastSearch = result;
      return hasSearchHit(result, `${marker}seed`) ? true : null;
    });
    if (!seedFound) evidence.seedSearchText = searchText(lastSearch).replaceAll(fixture, '<S26_TEMP>');
    assert(seedFound, 'S26 product keyword search retrieves saved control bytes');
    const ledgerPath = path.join(userData, 'index', 'smart-search.sqlite3');
    const controlTerminal = ledgerSnapshot(executable, root, ledgerPath).jobs
      .find(job => job.jobId === payload.indexing.jobId);
    assert(controlTerminal?.status === 'completed',
      'S26 durable queued save reaches a separate terminal indexing job');
    evidence.controlSave.terminalStatus = controlTerminal.status;
    await openExternal(executable, root, env, externalAFile);
    const opened = await until('opened original indexed', 15000, async () => {
      const snapshot = ledgerSnapshot(executable, root, ledgerPath);
      return snapshot.docs.find(doc => doc.relative_path.startsWith('.opened/') && doc.completed_revision > 0) || null;
    });
    evidence.openedDocumentId = opened.document_id;
    const oldIndexed = await tool(port, 'search_documents', { query: oldQuery });
    assert(hasSearchHit(oldIndexed, old), 'S26 first-run public keyword search finds OLD original');
    await openExternal(executable, root, env, externalBFile);
    const aliases = await until('two original aliases', 15000, async () => {
      const snapshot = ledgerSnapshot(executable, root, ledgerPath);
      const rows = snapshot.aliases.filter(alias => alias.document_id === opened.document_id);
      return rows.length === 2 ? rows : null;
    });
    assert(aliases.some(alias => alias.origin_lexical_path_internal === externalAFile)
      && aliases.some(alias => alias.origin_lexical_path_internal === externalBFile)
      && aliases.every(alias => alias.origin_path_internal === fs.realpathSync.native(externalAFile)
        && alias.canonical_path_hash === sha(process.platform === 'win32'
          ? path.resolve(externalAFile).toLowerCase() : path.resolve(externalAFile))),
    'S26 two lexical originals preserve one canonical origin and document ID');
    evidence.aliasCanonicalHash = aliases[0].canonical_path_hash;
    const openedViewer = await tool(port, 'open_markdown', { documentId: opened.document_id,
      foreground: false });
    assert(JSON.stringify(openedViewer).includes('sourceUsed: origin')
      && !JSON.stringify(openedViewer).includes(externalAFile),
    'S26 indexed original opens through real viewer handler with redacted public payload');
    const viewerId = /windowId: ([^\s]+)/.exec(searchText(openedViewer))?.[1];
    assert(viewerId, 'S26 real open_markdown returns a viewer identity');
    assert((await tool(port, 'list_viewers', {})).content?.length > 0,
      'S26 real list_viewers route is available');
    await tool(port, 'update_markdown', { windowId: viewerId,
      content: `# S26 viewer update\n\n${marker}viewer\n`, noSave: true, foreground: false });
    assert((await tool(port, 'search_projects', {})).content?.length > 0,
      'S26 real search_projects route is available');
    assert((await tool(port, 'smart_search', { query: marker })).content?.length > 0,
      'S26 real smart_search route is available');
    await tool(port, 'close_viewer', { windowId: viewerId });
    evidence.publicToolsCalled = 8;
    const settingsReady = await privateAction(ipcPath, 'r3_test_settings_probe');
    assert(settingsReady.result?.ready === true, 'S26 real Settings renderer and preload are ready');
    const importRoot = path.join(fixture, 'linked-import');
    fs.mkdirSync(importRoot);
    const entryBytes = Buffer.from('# Import entry\n\n[Completed](./completed.md)\n[Missing](./missing.md)\n');
    const completedBytes = Buffer.from(`# Completed import\n\n${marker}imported\n`);
    const importEntry = path.join(importRoot, 'entry.md');
    fs.writeFileSync(importEntry, entryBytes);
    fs.writeFileSync(path.join(importRoot, 'completed.md'), completedBytes);
    const imported = await privateAction(ipcPath, 'r3_test_settings_import', { filePath: importEntry });
    if (!(imported.result?.success === true && imported.result.counts?.imported === 2
      && imported.result.counts?.missing >= 1 && !JSON.stringify(imported.result).includes(importRoot))) {
      const ownerAtFailure = await privateAction(ipcPath, 'r3_test_owner_snapshot').catch(() => null);
      const settingsAtFailure = await privateAction(ipcPath, 'r3_test_settings_status').catch(() => null);
      evidence.linkedImportFailure = {
        success: imported.result?.success === true,
        counts: imported.result?.counts || null,
        reasonCode: /^[a-z0-9_-]{1,80}$/.test(imported.result?.reason || '')
          ? imported.result.reason : null,
        containsRawImportRoot: JSON.stringify(imported.result).includes(importRoot),
        owner: ownerAtFailure?.result ? { state: ownerAtFailure.result.state,
          phase: ownerAtFailure.result.phase, active: ownerAtFailure.result.active,
          diagnosticCode: ownerAtFailure.result.diagnostic?.code || null } : null,
        settings: settingsAtFailure?.result ? { state: settingsAtFailure.result.state,
          ledgerState: settingsAtFailure.result.ledgerState,
          phase: settingsAtFailure.result.phase } : null
      };
    }
    assert(imported.result?.success === true && imported.result.counts?.imported === 2
      && imported.result.counts?.missing >= 1
      && !JSON.stringify(imported.result).includes(importRoot),
    'S26 Settings import preserves two completed files and redacted partial missing count');
    assert(sha(fs.readFileSync(path.join(store, 'entry.md'))) === sha(entryBytes)
      && sha(fs.readFileSync(path.join(store, 'completed.md'))) === sha(completedBytes),
    'S26 partial linked import keeps completed contained files');
    evidence.importCounts = imported.result.counts;
    evidence.importedEntrySha256 = sha(entryBytes);
    evidence.importedCompletedSha256 = sha(completedBytes);
    const containedPath = path.join(store, 'contained-open.md');
    const containedBytes = Buffer.from(`# S26 contained open\n\n${marker}contained\n`);
    fs.writeFileSync(containedPath, containedBytes);
    await openExternal(executable, root, env, containedPath);
    const contained = await eventually(10000, () => {
      const snapshot = ledgerSnapshot(executable, root, ledgerPath);
      return snapshot.docs.find(doc => doc.relative_path === 'contained-open.md') || null;
    });
    assert(contained?.document_id && sha(fs.readFileSync(containedPath)) === sha(containedBytes),
      'S26 contained viewer open adopts under owner without rewriting the file');
    evidence.containedDocumentId = contained.document_id;
    const large = largeMarkdownFixture();
    const updatedText = large.bytes.toString('utf8').slice(0, 2_000_000)
      .replace('title: S22 large document\ncategory: engineering\ndocumentTags: [performance, 색인]',
        'project: s26-project\ncategory: s26-category\ndocumentTags: [s26-tag]')
      .replace('s22fullindexproof', newer);
    const updatedBytes = Buffer.from(updatedText);
    assert(updatedBytes.length < 10 * 1024 * 1024 && !updatedText.includes(old),
      'S26 NEW revision is within supported save bound and excludes OLD');
    fs.writeFileSync(externalAFile, updatedBytes);
    await openExternal(executable, root, env, externalAFile);
    const active = await until('owner active NEW revision', 15000, async () => {
      const response = await privateAction(ipcPath, 'r3_test_owner_snapshot');
      return response.result?.active && response.result?.phase === 'index_document' ? response.result : null;
    });
    evidence.cancelJobId = active.jobId;
    const settingsStatus = await privateAction(ipcPath, 'r3_test_settings_status');
    assert(settingsStatus.result?.sourceRootConfigured === true,
      'S26 Settings status uses real renderer bridge during active owner job');
    const cancel = await privateAction(ipcPath, 'r3_test_settings_cancel');
    assert(cancel.result?.cancelled === true,
      'S26 Settings cancel targets the active owner document job');
    const cancelledSnapshot = await eventually(15000, () => {
      const snapshot = ledgerSnapshot(executable, root, ledgerPath);
      return snapshot.jobs.some(job => job.document_id === opened.document_id && job.status === 'cancelled')
        ? snapshot : null;
    });
    assert(cancelledSnapshot, 'S26 cancelled owner job is durable before shutdown');
    const copyPath = path.join(store, opened.relative_path);
    assert(sha(fs.readFileSync(copyPath)) === sha(updatedBytes)
      && sha(fs.readFileSync(externalAFile)) === sha(updatedBytes),
    'S26 cancel preserves published store copy and external original bytes');
    const pending = cancelledSnapshot.docs.find(doc => doc.document_id === opened.document_id);
    assert(pending?.desired_revision >= 2 && pending.dirty === 1,
      'S26 cancelled NEW revision remains pending and retryable');
    evidence.newSha256 = sha(updatedBytes);
    evidence.newBytes = updatedBytes.length;
    evidence.storeCopySha256AfterCancel = sha(fs.readFileSync(copyPath));
    evidence.externalSha256AfterCancel = sha(fs.readFileSync(externalAFile));
    evidence.pendingRevision = pending.desired_revision;
    evidence.cancelledJobCount = cancelledSnapshot.jobs.filter(job => job.document_id === opened.document_id
      && job.status === 'cancelled').length;
    console.error('S26_FIRST_RUN_COMPLETE');
    const quit = await privateAction(ipcPath, 'r3_test_graceful_quit');
    assert(quit.result?.accepted === true, 'S26 owned product accepts graceful quit after process identity inspection');
    const exited = await waitForExit(child, 10000);
    assert(exited === 0, 'S26 exact owned Electron PID exits through app.quit');
    child = spawn(executable, [root, '--profile=dev', '--r3-test-lifecycle'], { cwd: root, env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let restartOutput = '';
    child.stdout.on('data', chunk => { restartOutput += chunk; });
    child.stderr.on('data', chunk => { restartOutput += chunk; });
    const restartPort = await until('restarted product MCP readiness', 20000, async () => {
      if (child.exitCode !== null) throw new Error(`restarted product exited ${child.exitCode}: ${restartOutput.slice(-1500)}`);
      const portFile = path.join(userData, 'mcp-port');
      if (!fs.existsSync(portFile)) return null;
      const discovered = Number(fs.readFileSync(portFile, 'utf8'));
      if (!Number.isInteger(discovered)) return null;
      try { return (await rpc(discovered, 'ping')).result ? discovered : null; } catch { return null; }
    });
    const restartCommandLine = processCommandLine(child.pid);
    assert(child.pid !== evidence.runs[0].pid && restartCommandLine.includes(path.basename(executable))
      && restartCommandLine.includes(root), 'S26 restart uses a distinct inspected app-owned Electron PID');
    evidence.runs.push({ pid: child.pid,
      commandLine: redactedCommandLine(restartCommandLine, root),
      commandLineSha256: sha(restartCommandLine), port: restartPort });
    const recoveryStart = performance.now();
    const recovered = await eventually(60000, async () => {
      const snapshot = ledgerSnapshot(executable, root, ledgerPath);
      const doc = snapshot.docs.find(item => item.document_id === opened.document_id);
      if (!doc || doc.completed_revision !== pending.desired_revision || doc.dirty !== 0) return null;
      const found = await tool(restartPort, 'search_documents', { query: newQuery });
      return hasSearchHit(found, newer) ? snapshot : null;
    }, 2000);
    if (!recovered) {
      evidence.restartOwnerStatus = (await privateAction(ipcPath, 'r3_test_owner_snapshot')).result;
      evidence.restartLogTail = restartOutput.slice(-1000).replaceAll(fixture, '<S26_TEMP>');
      evidence.restartLedger = ledgerSnapshot(executable, root, ledgerPath).docs
        .find(doc => doc.document_id === opened.document_id);
    }
    assert(recovered, 'S26 restart resumes pending latest revision and indexes NEW marker');
    evidence.restartRecoveryMs = performance.now() - recoveryStart;
    const oldResult = await tool(restartPort, 'search_documents', { query: oldQuery });
    evidence.oldSearchText = searchText(oldResult).replaceAll(fixture, '<S26_TEMP>');
    assert(!searchText(oldResult).includes(old),
      'S26 latest public keyword result contains no OLD revision marker');
    const recoveredDoc = recovered.docs.find(doc => doc.document_id === opened.document_id);
    const recoveredAliases = recovered.aliases.filter(alias => alias.document_id === opened.document_id);
    const controlAliases = recovered.aliases.filter(alias => alias.document_id === payload.documentId);
    const importedIds = new Set(imported.result.imported.map(item => item.documentId));
    assert(recoveredAliases.length === 2 && controlAliases.length === 0
      && recoveredDoc.project === 's26-project' && recoveredDoc.category === 's26-category'
      && JSON.parse(recoveredDoc.document_tags_json).includes('s26-tag')
      && sha(fs.readFileSync(copyPath)) === sha(updatedBytes),
    'S26 restart retains same document ID, both provenance aliases, metadata, and saved bytes');
    assert(importedIds.size === 2
      && recovered.docs.filter(doc => importedIds.has(doc.document_id)).length === 2
      && sha(fs.readFileSync(path.join(store, 'completed.md'))) === sha(completedBytes),
    'S26 partial import keeps completed document IDs and bytes through restart');
    evidence.recoveredRevision = recoveredDoc.completed_revision;
    evidence.recoveredAliasCount = recoveredAliases.length;
    evidence.recoveredStoreCopySha256 = sha(fs.readFileSync(copyPath));
    evidence.recoveredExternalSha256 = sha(fs.readFileSync(externalAFile));
    evidence.recoveredJobStates = recovered.jobs.filter(job => job.document_id === opened.document_id)
      .map(job => job.status);
    const compactRoute = await privateAction(ipcPath, 'r3_test_settings_compact');
    assert(compactRoute.result?.compacted === false
      && compactRoute.result.started === false
      && compactRoute.result.reason === 'compact-rebuild-required',
      'S26 Settings compact truthfully defers physical work for legacy auto_vacuum NONE');
    const privateRebuild = await privateAction(ipcPath, 'rebuild_index');
    const privateOwner = await privateAction(ipcPath, 'r3_test_owner_snapshot');
    assert(privateRebuild.result && (privateRebuild.result.started !== true
      || (privateRebuild.result.scheduled === true
        && privateRebuild.result.jobId === privateOwner.result?.jobId
        && privateOwner.result?.kind === 'rebuild')),
      'S26 private rebuild_index cannot start a short-worker job outside the owner');
    const retryRoute = await privateAction(ipcPath, 'r3_test_settings_retry');
    assert(retryRoute.result && (retryRoute.result.started === true
      ? retryRoute.result.scheduled === true && Boolean(retryRoute.result.jobId)
      : retryRoute.result.scheduled === false && Boolean(retryRoute.result.reason)),
      'S26 Settings retry reports a durable owner job or an explicit rejection');
    const rebuildRoute = await privateAction(ipcPath, 'r3_test_settings_rebuild');
    assert(rebuildRoute.result && (rebuildRoute.result.started === true
      ? rebuildRoute.result.scheduled === true && Boolean(rebuildRoute.result.jobId)
      : rebuildRoute.result.scheduled === false && Boolean(rebuildRoute.result.reason)),
      'S26 Settings rebuild reports a durable owner job or an explicit rejection');
    const clearRoute = await privateAction(ipcPath, 'r3_test_settings_clear');
    assert(clearRoute.result?.cleared === false && (clearRoute.result.started === true
      ? clearRoute.result.scheduled === true && Boolean(clearRoute.result.jobId)
      : clearRoute.result.scheduled === false && Boolean(clearRoute.result.reason)),
      'S26 confirmed Settings clear reports a durable owner job or an explicit rejection');
    const finalSettingsStatus = await privateAction(ipcPath, 'r3_test_settings_status');
    assert(finalSettingsStatus.result?.sourceRootConfigured === true,
      'S26 Settings status remains available after maintenance actions');
    evidence.settingsMaintenance = Object.fromEntries([
      ['compact', compactRoute.result], ['privateRebuild', privateRebuild.result],
      ['retry', retryRoute.result],
      ['rebuild', rebuildRoute.result], ['clear', clearRoute.result]
    ].map(([name, value]) => [name, { started: value.started === true,
      scheduled: value.scheduled === true, compacted: value.compacted === true,
      cleared: value.cleared === true, reason: value.reason || null }]));
    console.error('S26_RESTART_RECOVERED');
    const secondQuit = await privateAction(ipcPath, 'r3_test_graceful_quit');
    assert(secondQuit.result?.accepted === true && await waitForExit(child, 10000) === 0,
      'S26 restarted app exits gracefully by inspected PID');
    console.error('S26_ALL_ASSERTIONS_REACHED');
  } finally {
    if (child && child.exitCode === null) {
      const commandLine = processCommandLine(child.pid);
      if (commandLine.includes(path.basename(executable)) && commandLine.includes(root)) child.kill();
    }
    const artifact = path.resolve(__dirname, '../../../docs/analysis/2026-09-25-s26-electron-integration-samples.json');
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, `${JSON.stringify(evidence, null, 2)}\n`);
    console.error(`S26_EVIDENCE ${JSON.stringify(evidence)}`);
  }
} };
