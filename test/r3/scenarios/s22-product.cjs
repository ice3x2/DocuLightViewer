'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { largeMarkdownFixture } = require('../large-markdown-fixture.cjs');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const counts = Object.freeze({ status: 50, focus: 25, close: 25, cancel: 1 });
const limits = Object.freeze({ p95: 250, p99: 500, max: 1000, cancel: 1000, heartbeat: 250 });
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];

function privateAction(ipcPath, action, params = {}, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(ipcPath);
    let body = '';
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('private IPC deadline exceeded')));
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

async function until(label, deadlineMs, attempt) {
  const deadline = performance.now() + deadlineMs;
  while (performance.now() < deadline) {
    const value = await attempt();
    if (value) return value;
    await pause(20);
  }
  throw new Error(`S22_PRODUCT_TIMEOUT ${label}`);
}

function processCommandLine(pid) {
  if (process.platform !== 'win32') return execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' }).trim();
  const safePid = Number(pid);
  if (!Number.isSafeInteger(safePid) || safePid <= 0) throw new Error('invalid owned PID');
  return execFileSync('powershell', ['-NoProfile', '-Command',
    `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${safePid}').CommandLine`],
  { encoding: 'utf8', windowsHide: true }).trim();
}

function waitForExit(child, deadlineMs) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('owned Electron did not exit')), deadlineMs);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}

async function openExternal(executable, root, env, filePath, packaged, userData) {
  const args = packaged ? [`--user-data-dir=${userData}`, filePath]
    : [root, '--profile=dev', filePath];
  const child = spawn(executable, args, { cwd: root, env,
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  if (await waitForExit(child, 15000) !== 0) throw new Error('S22 external open failed');
}

function report(samples) {
  return Object.fromEntries(['status', 'focus', 'close'].map(kind => {
    const values = samples.filter(sample => sample.kind === kind).map(sample => sample.ms);
    return [kind, { count: values.length, p95: percentile(values, .95),
      p99: percentile(values, .99), max: Math.max(...values) }];
  }));
}

// @req REL-DOC-007 IR-APP-013 AC-13 FR-DOC-019 IR-APP-010
module.exports = { name: 's22-product', async run({ executable, root, sourceHash, packaged, assert }) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s22-product-'));
  const appData = path.join(fixture, 'appData');
  const userData = packaged ? path.join(appData, 'DocuLight') : path.join(fixture, 'userData');
  const store = path.join(fixture, 'store');
  const external = path.join(fixture, 'external');
  for (const dir of [userData, store, external]) fs.mkdirSync(dir, { recursive: true });
  const ipcPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\doculight-s22-product-${crypto.randomBytes(8).toString('hex')}`
    : path.join(fixture, 'ipc.sock');
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    mcpAutoSave: true, mcpAutoSavePath: store, mcpSaveSubDir: '', mcpGitInfo: false,
    registerOpenedMarkdown: true
  }));
  const large = largeMarkdownFixture();
  const revised = Buffer.concat([large.bytes, Buffer.from('Cancelled revision marker: s22cancelledrevision.\n')]);
  const sourceFile = path.join(external, 'large.md');
  fs.writeFileSync(sourceFile, large.bytes);
  const evidence = { sourceHash, packaged: Boolean(packaged),
    packagedExecutableSha256: packaged ? sha(fs.readFileSync(executable)) : null,
    packagedAsarSha256: packaged ? sha(fs.readFileSync(path.join(path.dirname(executable), 'resources', 'app.asar'))) : null,
    fixtureBytes: large.byteLength, fixtureSha256: large.sha256,
    revisedBytes: revised.length, revisedSha256: sha(revised),
    node: process.version, electron: require(path.join(root, 'node_modules/electron/package.json')).version,
    platform: process.platform, arch: process.arch, counts, limits,
    samples: [], heartbeatClock: 'electron-main', heartbeatTicks: [], heartbeatGaps: [], markers: {} };
  let child;
  try {
    assert(large.byteLength === 10484650 && large.sha256 === '98ef6b7bcb96965ba5a455d040b864dfc88a1c3b90e044e65c21043f3783d5b6'
      && revised.length === 10484699 && sha(revised) === '2bfff4a19d7ae5b22c5d4089b378310e37fe37ee336f8d59e23d4614ead486b1',
    'S22 exact real large fixture and second revision hashes');
    const env = packaged
      ? { ...process.env, APPDATA: appData, DOCULIGHT_PROFILE: 'default',
        DOCULIGHT_IPC_PATH: ipcPath, DOCULIGHT_R3_TEST_LIFECYCLE: '1', DOCULIGHT_LOCALE: 'en' }
      : { ...process.env, DOCULIGHT_PROFILE: 'dev', DOCULIGHT_DEV_USER_DATA_DIR: userData,
        DOCULIGHT_DEV_IPC_PATH: ipcPath, DOCULIGHT_R3_TEST_LIFECYCLE: '1', DOCULIGHT_LOCALE: 'en' };
    delete env.ELECTRON_RUN_AS_NODE;
    if (packaged) {
      delete env.DOCULIGHT_DEV_USER_DATA_DIR;
      delete env.DOCULIGHT_DEV_IPC_PATH;
    }
    const args = packaged ? [`--user-data-dir=${userData}`, '--r3-test-lifecycle']
      : [root, '--profile=dev', '--r3-test-lifecycle'];
    child = spawn(executable, args, { cwd: root, env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    await until('product Settings ready', 20000, async () => {
      if (child.exitCode !== null) throw new Error(`product exited ${child.exitCode}: ${output.slice(-1000)}`);
      return (await privateAction(ipcPath, 'r3_test_settings_probe').catch(() => null))?.result?.ready;
    });
    const runtimeIdentity = await privateAction(ipcPath, 'r3_test_runtime_identity');
    assert(runtimeIdentity.result?.isPackaged === Boolean(packaged)
      && runtimeIdentity.result?.profile === (packaged ? 'default' : 'dev')
      && path.resolve(runtimeIdentity.result.userDataDir) === path.resolve(userData),
    'product main reports its runtime identity and isolated profile');
    evidence.runtimeIdentity = { isPackaged: runtimeIdentity.result.isPackaged,
      profile: runtimeIdentity.result.profile, isolatedUserData: true };
    const commandLine = processCommandLine(child.pid);
    assert(commandLine.includes(path.basename(executable))
      && commandLine.includes(packaged ? '--r3-test-lifecycle' : root),
      'owned Electron PID and command line inspected');
    evidence.ownedPid = child.pid;
    evidence.ownedCommandLineSha256 = sha(commandLine);
    const warm = await privateAction(ipcPath, 'save_document', {
      content: '# S22 warm document\n\nprioruniquekey searchable content.\n'
    }, 15000);
    const warmPayload = JSON.parse(warm.result?.content?.[0]?.text || 'null');
    assert(warmPayload?.saved === true && warmPayload.indexing?.state === 'queued'
      && typeof warmPayload.indexing.jobId === 'string',
    `product save returns a durable worker ACK before large-document measurement (${JSON.stringify(warm).slice(0, 400)})`);
    const warmTerminal = await privateAction(ipcPath, 'r3_test_owner_wait_terminal',
      { jobId: warmPayload.indexing.jobId, phase: 'completed' }, 30000);
    assert(warmTerminal.result?.jobId === warmPayload.indexing.jobId,
      'warm-up worker terminal is excluded from measurements');
    evidence.warmJobId = warmPayload.indexing.jobId;
    const workerAudit = await privateAction(ipcPath, 'r3_test_owner_open_audit');
    assert(workerAudit.result?.openCount === 2
      && workerAudit.result.ledgerOpenThreadId === workerAudit.result.workerThreadId
      && workerAudit.result.keywordOpenThreadId === workerAudit.result.workerThreadId,
    'same-session owner audit places both SQLite opens on one worker thread');
    evidence.workerOpenAudit = workerAudit.result;
    const viewerIds = [];
    for (let i = 0; i < 1; i += 1) {
      const opened = await privateAction(ipcPath, 'open_markdown', {
        content: `# S22 viewer ${i}`, noSave: true, foreground: false
      }, 15000);
      assert(opened.result?.windowId,
        `product viewer request returns an ID (${i}: ${JSON.stringify(opened).slice(0, 300)})`);
      viewerIds.push(opened.result.windowId);
    }
    const activePromise = until('worker active ACK', 30000, async () => {
      const response = await privateAction(ipcPath, 'r3_test_owner_snapshot').catch(() => null);
      return response?.result?.active && response.result.phase === 'index_document'
        && response.result.jobId ? response.result : null;
    }).then(value => ({ value }), error => ({ error }));
    const saveStart = performance.now();
    await openExternal(executable, root, env, sourceFile, packaged, userData);
    evidence.saveMs = performance.now() - saveStart;
    const activeResult = await activePromise;
    if (activeResult.error) throw activeResult.error;
    const active = activeResult.value;
    evidence.jobId = active.jobId;
    evidence.markers.activeAck = true;
    const mainHeartbeatStart = await privateAction(ipcPath, 'r3_test_main_heartbeat_start',
      { jobId: active.jobId });
    assert(mainHeartbeatStart.result?.started === true
      && mainHeartbeatStart.result.clock === 'electron-main',
    'Electron main heartbeat starts for the active owner job');
    const mainSqliteBefore = await privateAction(ipcPath, 'r3_test_main_sqlite_snapshot');
    assert(mainSqliteBefore.result?.writableOpenCount === 0
      && mainSqliteBefore.result.ledgerAllocated === false,
    'product main has no writable SQLite owner while large indexing is active');
    evidence.mainSqliteBefore = mainSqliteBefore.result;
    const terminalPromise = privateAction(ipcPath, 'r3_test_owner_wait_terminal',
      { jobId: active.jobId, phase: 'completed' }, 300000)
      .then(value => ({ value }), error => ({ error }));
    const activeStart = performance.now();
    let lastProgress = 0;
    const progressTotal = active.progress?.total > 1 ? active.progress.total
      : (await until('worker progress total', 15000, async () => {
      const response = await privateAction(ipcPath, 'r3_test_owner_snapshot').catch(() => null);
      return response?.result?.jobId === active.jobId && response.result.progress?.total > 1
        ? response.result.progress.total : null;
    }));
    evidence.progressTotal = progressTotal;
    for (let i = 0; i < counts.status; i += 1) {
      const target = Math.max(lastProgress + 1,
        Math.floor((i + 1) * (progressTotal - 1) / counts.status));
      const progress = await until(`worker progress sample ${i}`, 15000, async () => {
        const response = await privateAction(ipcPath, 'r3_test_owner_snapshot').catch(() => null);
        const value = response?.result;
        if (value?.jobId !== active.jobId || !value.active || !value.progress?.total) return null;
        const current = value.progress.current;
        if (current < target || current <= lastProgress) return null;
        return value;
      });
      lastProgress = progress.progress.current;
      const begin = performance.now();
      const status = await privateAction(ipcPath, 'r3_test_settings_status');
      const end = performance.now();
      assert(status.result?.sourceRootConfigured === true,
        'real Settings renderer and preload return status during active worker job');
      const statusPost = await privateAction(ipcPath, 'r3_test_owner_snapshot');
      assert(statusPost.result?.active === true && statusPost.result.jobId === active.jobId,
        'Settings status sample ends while the same owner job remains active');
      evidence.samples.push({ kind: 'status', ms: end - begin, startMs: begin - activeStart,
        endMs: end - activeStart, progress: lastProgress, jobId: active.jobId,
        postMarkerAtMs: performance.now() - activeStart, postProgress: statusPost.result.progress?.current });
      if (i % 2 === 0) {
        if (viewerIds.length === 0) {
          const opened = await privateAction(ipcPath, 'open_markdown', {
            content: `# S22 replacement viewer ${i}`, noSave: true, foreground: false
          }, 15000);
          assert(opened.result?.windowId, 'replacement product viewer request returns an ID');
          viewerIds.push(opened.result.windowId);
        }
        const focusId = viewerIds.at(-1);
        const focusWatch = await privateAction(ipcPath, 'r3_test_viewer_event_watch',
          { windowId: focusId, event: 'focus' });
        assert(typeof focusWatch.result?.token === 'string',
          'focus completion observer is armed before the normal product request');
        const focusStart = performance.now();
        const focused = await privateAction(ipcPath, 'update_markdown',
          { windowId: focusId, foreground: true, noSave: true });
        const focusEvent = await privateAction(ipcPath, 'r3_test_viewer_event_wait',
          { token: focusWatch.result.token });
        const focusEnd = performance.now();
        assert(focused.result?.title && focusEvent.result?.completed === true
          && focusEvent.result.event === 'focus',
        'normal update_markdown focus request reaches the focus completion event');
        const focusPost = await privateAction(ipcPath, 'r3_test_owner_snapshot');
        assert(focusPost.result?.active === true && focusPost.result.jobId === active.jobId,
          'viewer focus sample ends while the same owner job remains active');
        evidence.samples.push({ kind: 'focus', ms: focusEnd - focusStart,
          startMs: focusStart - activeStart, endMs: focusEnd - activeStart, progress: lastProgress,
          postMarkerAtMs: performance.now() - activeStart, postProgress: focusPost.result.progress?.current });
        const closeId = viewerIds.shift();
        const closeWatch = await privateAction(ipcPath, 'r3_test_viewer_event_watch',
          { windowId: closeId, event: 'closed' });
        assert(typeof closeWatch.result?.token === 'string',
          'close completion observer is armed before the normal product request');
        const closeStart = performance.now();
        const closed = await privateAction(ipcPath, 'close_viewer', { windowId: closeId });
        const closeEvent = await privateAction(ipcPath, 'r3_test_viewer_event_wait',
          { token: closeWatch.result.token });
        const closeEnd = performance.now();
        assert(closed.result?.closed === 1 && closeEvent.result?.completed === true
          && closeEvent.result.event === 'closed',
        'normal close_viewer request reaches the closed completion event');
        const closePost = await privateAction(ipcPath, 'r3_test_owner_snapshot');
        assert(closePost.result?.active === true && closePost.result.jobId === active.jobId,
          'viewer close sample ends while the same owner job remains active');
        evidence.samples.push({ kind: 'close', ms: closeEnd - closeStart,
          startMs: closeStart - activeStart, endMs: closeEnd - activeStart, progress: lastProgress,
          postMarkerAtMs: performance.now() - activeStart, postProgress: closePost.result.progress?.current });
      }
    }
    const terminalResult = await terminalPromise;
    if (terminalResult.error) throw terminalResult.error;
    const terminal = terminalResult.value.result;
    const activeEnd = performance.now();
    const mainHeartbeatStop = await privateAction(ipcPath, 'r3_test_main_heartbeat_stop',
      { jobId: active.jobId }, 15000);
    const mainHeartbeat = mainHeartbeatStop.result;
    assert(mainHeartbeat?.clock === 'electron-main' && mainHeartbeat.jobId === active.jobId
      && mainHeartbeat.activeAtStart === true && mainHeartbeat.overflow === false
      && Number.isFinite(mainHeartbeat.startedAt) && Number.isFinite(mainHeartbeat.stoppedAt)
      && Array.isArray(mainHeartbeat.ticks) && mainHeartbeat.ticks.length >= 2,
    'Electron main heartbeat stream spans the active owner job');
    evidence.heartbeatTicks = mainHeartbeat.ticks;
    evidence.heartbeatGaps = [mainHeartbeat.ticks[0] - mainHeartbeat.startedAt,
      ...mainHeartbeat.ticks.slice(1).map((tick, i) => tick - mainHeartbeat.ticks[i]),
      mainHeartbeat.stoppedAt - mainHeartbeat.ticks.at(-1)];
    assert(evidence.heartbeatGaps.length === mainHeartbeat.ticks.length + 1
      && evidence.heartbeatGaps.every(gap => Number.isFinite(gap) && gap >= 0),
    'Electron main heartbeat includes the terminal tail and ordered timestamps');
    evidence.activeWindowMs = activeEnd - activeStart;
    evidence.markers.fullIndexTerminal = terminal.jobId === active.jobId;
    evidence.byKind = report(evidence.samples);
    assert(evidence.samples.length === 100 && evidence.byKind.status.count === 50
      && evidence.byKind.focus.count === 25 && evidence.byKind.close.count === 25,
    'all 50/25/25 product samples are present');
    assert(evidence.samples.at(-1).endMs >= evidence.activeWindowMs * .75,
      'product samples span the active worker interval');
    assert(Object.values(evidence.byKind).every(value => value.p95 <= limits.p95
      && value.p99 <= limits.p99 && value.max <= limits.max)
      && Math.max(...evidence.heartbeatGaps) <= limits.heartbeat,
    'product latency percentiles, maximum, and heartbeat meet S22 bounds');
    const mainSqliteAfter = await privateAction(ipcPath, 'r3_test_main_sqlite_snapshot');
    evidence.mainSqliteAfter = mainSqliteAfter.result;
    assert(mainSqliteAfter.result?.writableOpenCount === 0
      && mainSqliteAfter.result.ledgerAllocated === false
      && mainSqliteAfter.result.keywordReadOnly !== false,
    'product main remains free of writable SQLite after product status, focus, and close samples');
    const queryStart = performance.now();
    const committed = await privateAction(ipcPath, 'search_documents', { query: 's22fullindexproof' }, 15000);
    evidence.indexedQueryMs = performance.now() - queryStart;
    assert(committed.result?.results?.length > 0, 'large document keyword index is committed');
    fs.writeFileSync(sourceFile, revised);
    const revisedActivePromise = until('revised active ACK', 30000, async () => {
      const response = await privateAction(ipcPath, 'r3_test_owner_snapshot').catch(() => null);
      return response?.result?.active && response.result.phase === 'index_document'
        && response.result.jobId !== active.jobId ? response.result : null;
    }).then(value => ({ value }), error => ({ error }));
    await openExternal(executable, root, env, sourceFile, packaged, userData);
    const revisedActiveResult = await revisedActivePromise;
    if (revisedActiveResult.error) throw revisedActiveResult.error;
    const revisedActive = revisedActiveResult.value;
    evidence.cancelJobId = revisedActive.jobId;
    const cancelTerminalPromise = privateAction(ipcPath, 'r3_test_owner_wait_terminal',
      { jobId: revisedActive.jobId, phase: 'cancelled' }, 30000)
      .then(value => ({ value }), error => ({ error }));
    const cancelStart = performance.now();
    const cancel = await privateAction(ipcPath, 'r3_test_settings_cancel');
    evidence.cancelMs = performance.now() - cancelStart;
    assert(cancel.result?.cancelled === true && evidence.cancelMs <= limits.cancel,
      'real Settings cancel IPC returns a bounded worker-owned receipt');
    const cancelledResult = await cancelTerminalPromise;
    if (cancelledResult.error) throw cancelledResult.error;
    const cancelled = cancelledResult.value.result;
    assert(cancelled?.jobId === revisedActive.jobId && cancelled?.phase === 'cancelled',
      'revised worker job emits a cancelled terminal status');
    evidence.markers.cancelledTerminal = true;
    const priorQueryStart = performance.now();
    const preserved = await privateAction(ipcPath, 'search_documents', { query: 's22fullindexproof' }, 15000);
    evidence.priorQueryAfterCancelMs = performance.now() - priorQueryStart;
    assert(sha(fs.readFileSync(sourceFile)) === sha(revised)
      && preserved.result?.results?.length > 0,
    'cancel preserves revised source and prior committed keyword generation');
    evidence.markers.sourcePreserved = true;
    evidence.markers.committedPreserved = true;
    const quit = await privateAction(ipcPath, 'r3_test_graceful_quit');
    assert(quit.result?.accepted && await waitForExit(child, 10000) === 0,
      'owned Electron exits after evidence collection');
  } finally {
    if (child && child.exitCode === null) {
      const commandLine = processCommandLine(child.pid);
      if (commandLine.includes(path.basename(executable))
        && commandLine.includes(packaged ? '--r3-test-lifecycle' : root)) child.kill();
    }
    const artifact = path.resolve(__dirname,
      `../../../docs/analysis/2026-09-25-s22-product-${sourceHash}-${process.pid}-samples.json`);
    fs.writeFileSync(artifact, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
    console.error(`S22_PRODUCT_ARTIFACT ${artifact}`);
  }
} };
