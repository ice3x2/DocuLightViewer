'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { validateNativeOwnerEvidence } = require('./package-native-owner-evidence');
const { parseFrontmatter } = require('../../src/main/frontmatter');
const { sourceFiles, sourceHash } = require('../r3/runtime.cjs');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];

function privateAction(ipcPath, action, params = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(ipcPath);
    let body = '';
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('package owner IPC timeout')));
    socket.once('connect', () => socket.write(`${JSON.stringify({ id: crypto.randomUUID(), action, params })}\n`));
    socket.on('data', (chunk) => {
      body += chunk;
      const end = body.indexOf('\n');
      if (end < 0) return;
      socket.end();
      try { resolve(JSON.parse(body.slice(0, end))); } catch (error) { reject(error); }
    });
    socket.once('error', reject);
  });
}

function awaitWithReferencedTimeout(promise, label, timeoutMs) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function armOwnerTerminalWatch(action, ipcPath, jobId) {
  const armed = await action(ipcPath, 'r3_test_owner_terminal_watch_arm',
    { jobId, phase: 'cancelled' });
  assert(typeof armed.result?.token === 'string' && armed.result.jobId === jobId,
    'bounded terminal observer is armed before cancel');
  return { token: armed.result.token,
    wait: async () => (await awaitWithReferencedTimeout(action(ipcPath,
      'r3_test_owner_terminal_watch_wait', { token: armed.result.token }, 20000),
    'owner terminal event', 35000)).result };
}

function readDurableCancelledJob(userData, jobId) {
  const Database = require('better-sqlite3');
  const ledger = new Database(path.join(userData, 'index', 'smart-search.sqlite3'),
    { readonly: true, fileMustExist: true });
  try {
    const job = ledger.prepare(`SELECT job_id, status, phase, cancel_requested
      FROM index_jobs WHERE job_id = ?`).get(jobId);
    return job ? { jobId: job.job_id, status: job.status, phase: job.phase,
      cancelRequested: Boolean(job.cancel_requested) } : null;
  } finally { ledger.close(); }
}

async function until(label, durationMs, probe) {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`package native owner timeout: ${label}`);
}

function safeRemoveFixture(fixtureRoot) {
  const temp = fs.realpathSync(os.tmpdir());
  const resolved = fs.realpathSync(fixtureRoot);
  assert.strictEqual(path.dirname(resolved).toLowerCase(), temp.toLowerCase(), 'fixture is a direct OS temp child');
  assert(path.basename(resolved).startsWith('doculight-native-owner-'), 'fixture has the expected private prefix');
  fs.rmSync(resolved, { recursive: true });
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

// @req FR-DOC-019 AC-10 IR-APP-013 AC-13 OPS-ARCH-009 AC-2 OPS-ARCH-010 AC-3
async function runPackageNativeOwnerSmoke({ appPath, artifactKind, root, requireProcessCold = false, onActive }) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-native-owner-'));
  const userData = path.join(fixtureRoot, 'user-data');
  const storeRoot = path.join(fixtureRoot, 'store');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(storeRoot, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    mcpAutoSave: true, mcpAutoSavePath: storeRoot, mcpSaveSubDir: '', mcpGitInfo: false
  }));
  const ipcPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\doculight-native-owner-${crypto.randomBytes(8).toString('hex')}`
    : path.join(fixtureRoot, 'ipc.sock');
  const marker = `packageowner${crypto.randomBytes(10).toString('hex')}`;
  const content = `# Packaged Native Owner\n\n${marker} searchable fixture\n`;
  const evidence = {
    version: 'package-native-owner.v1', artifactKind, directExecutable: true,
    selectedAppSha256: sha256(fs.readFileSync(appPath)),
    baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
    sourceHash: sourceHash(), sourceHashScope: 'r3-source-files',
    sourceFileCount: sourceFiles().length,
    fixtureSha256: sha256(content), runtime: {}, owner: {}, main: {}, flow: {}, lifecycle: {},
    responsiveness: { samples: [], heartbeatGaps: [], workerMarker: false }
  };
  const env = { ...process.env, DOCULIGHT_PROFILE: 'default',
    DOCULIGHT_DEFAULT_USER_DATA_DIR: userData, DOCULIGHT_IPC_PATH: ipcPath,
    DOCULIGHT_R3_TEST_LIFECYCLE: '1', DOCULIGHT_LOCALE: 'en', APPDATA: fixtureRoot };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(appPath, [`--user-data-dir=${userData}`, '--r3-test-lifecycle'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-2048); });
  child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-2048); });
  let quitAccepted = false;
  let appPid = null;
  let activeProbe = null;
  try {
    await until('normal packaged app IPC', 45000, async () =>
      (await privateAction(ipcPath, 'r3_test_runtime_identity').catch(() => null))?.result);
    const identity = (await privateAction(ipcPath, 'r3_test_runtime_identity')).result;
    appPid = identity?.pid;
    evidence.runtime = { isPackaged: identity?.isPackaged, profile: identity?.profile,
      isolatedUserData: path.resolve(identity?.userDataDir || '') === path.resolve(userData),
      electronAbi: identity?.electronAbi };
    evidence.processCold = { pid: identity?.pid, spawnPid: child.pid,
      processStartEpochMs: identity?.processStartEpochMs,
      profileToken: sha256(path.resolve(userData)),
      commandLineRedacted: '[PACKAGED_APP] --user-data-dir=[PROFILE] --r3-test-lifecycle' };
    assert(Number.isInteger(identity?.pid) && identity.pid > 0,
      'runtime identity names the actual packaged app process');
    const saved = await privateAction(ipcPath, 'save_document', { content }, 20000);
    const payload = JSON.parse(saved.result?.content?.[0]?.text || 'null');
    assert(payload?.saved === true && typeof payload?.indexing?.jobId === 'string',
      'normal packaged app returns a durable owner indexing receipt');
    evidence.flow.saved = true;
    const terminal = await privateAction(ipcPath, 'r3_test_owner_wait_terminal',
      { jobId: payload.indexing.jobId, phase: 'completed' }, 60000);
    evidence.flow.indexed = terminal.result?.jobId === payload.indexing.jobId
      && terminal.result?.phase === 'completed';
    const audit = (await privateAction(ipcPath, 'r3_test_owner_open_audit')).result;
    evidence.owner = { workerThreadId: audit?.workerThreadId,
      ledgerOpenThreadId: audit?.ledgerOpenThreadId,
      keywordOpenThreadId: audit?.keywordOpenThreadId, openCount: audit?.openCount };
    const found = await privateAction(ipcPath, 'search_documents', { query: marker, limit: 5 }, 20000);
    evidence.flow.searchFound = found.result?.results?.some((item) =>
      item.documentId === payload.documentId || item.filePath?.endsWith(payload.sourceRelativePath.replace(/\//g, path.sep))) === true;
    const faultEnabled = await privateAction(ipcPath, 'r3_test_set_save_fault', { fault: 'post_publish' });
    assert(faultEnabled.result?.enabled === true, 'packaged app enables isolated post-publish fault');
    const faultMarker = `${marker}fault`;
    const faultSave = await privateAction(ipcPath, 'save_document', {
      content: `# Retained after indexing failure\n\n${faultMarker}\n`, title: 'Retained fault fixture'
    }, 20000);
    const faultPayload = JSON.parse(faultSave.result?.content?.[0]?.text || 'null');
    await privateAction(ipcPath, 'r3_test_set_save_fault', { fault: null });
    const retainedPath = path.join(storeRoot, faultPayload?.sourceRelativePath || '');
    evidence.flow.failedSaveRetained = faultPayload?.saved === true
      && faultPayload?.indexing?.state === 'enqueue_failed'
      && !faultPayload?.indexing?.jobId
      && faultPayload?.warnings?.some((item) => item.code === 'index_enqueue_failed'
        && item.retryable === true)
      && fs.existsSync(retainedPath) && fs.readFileSync(retainedPath, 'utf8').includes(faultMarker);
    const intentDir = fs.readdirSync(fixtureRoot).find((name) => name.startsWith('.doculight-save-intents-'));
    evidence.flow.retryableIntentPresent = Boolean(intentDir) && fs.readdirSync(path.join(fixtureRoot, intentDir))
      .filter((name) => name.endsWith('.intent.json'))
      .some((name) => {
        const bytes = fs.readFileSync(path.join(fixtureRoot, intentDir, name), 'utf8');
        const intent = JSON.parse(bytes);
        return intent.sourceRelativeLocator === faultPayload.sourceRelativePath
          && !bytes.includes(faultMarker);
      });
    const opened = await privateAction(ipcPath, 'open_markdown', {
      content: '# Owner smoke viewer', noSave: true, foreground: false
    }, 20000);
    const windowId = opened.result?.windowId;
    evidence.flow.opened = typeof windowId === 'string' && windowId.length > 0;
    if (evidence.flow.opened) {
      let completedImport = null;
      if (onActive) {
        const importRoot = path.join(fixtureRoot, 'linked-import');
        fs.mkdirSync(importRoot);
        const entryBytes = Buffer.from('# PG-09 import\n\n[Completed](./completed.md)\n');
        const linkedBytes = Buffer.from(`# Completed import\n\n${marker}imported\n`);
        const importEntry = path.join(importRoot, 'entry.md');
        fs.writeFileSync(importEntry, entryBytes);
        fs.writeFileSync(path.join(importRoot, 'completed.md'), linkedBytes);
        const imported = await privateAction(ipcPath, 'r3_test_settings_import',
          { filePath: importEntry }, 30000);
        completedImport = { completed: imported.result?.success === true
          && imported.result.counts?.imported === 2,
          retainedAfterCancel: false, sha256: sha256(linkedBytes),
          entrySha256: sha256(entryBytes) };
        assert(completedImport.completed, 'PG-09 Settings linked import completes before cancel');
      }
      const activeMarker = `${marker}active`;
      const activeContent = `# Active owner\n\n${activeMarker}\n${'activeownerword '.repeat(270000)}`;
      const activeSave = await privateAction(ipcPath, 'save_document', {
        content: activeContent, title: 'Active owner fixture'
      }, 30000);
      const activePayload = JSON.parse(activeSave.result?.content?.[0]?.text || 'null');
      assert(activePayload?.saved === true && activePayload?.indexing?.jobId,
        'packaged app queues a durable long owner document job');
      const active = await until('active packaged owner document', 10000, async () => {
        const state = (await privateAction(ipcPath, 'r3_test_owner_snapshot')).result;
        return state?.active && state?.phase === 'index_document'
          && state.jobId === activePayload.indexing.jobId ? state : null;
      });
      evidence.flow.activeStatusSeen = Boolean(active);
      evidence.responsiveness.workerMarker = Number.isInteger(audit?.workerThreadId)
        && audit.workerThreadId > 0 && active.jobId === activePayload.indexing.jobId;
      const activeAudit = onActive
        ? (await privateAction(ipcPath, 'r3_test_owner_open_audit')).result : null;
      evidence.processCold.workerReadyEpochMs = Date.now();
      const heartbeatStart = await privateAction(ipcPath, 'r3_test_main_heartbeat_start',
        { jobId: activePayload.indexing.jobId });
      assert(heartbeatStart.result?.started === true, 'main heartbeat starts during active owner job');
      const measure = async (kind, action, params) => {
        const start = performance.now();
        const response = await privateAction(ipcPath, action, params);
        const end = performance.now();
        evidence.responsiveness.samples.push({ kind, ms: end - start,
          startMonoMs: start, endMonoMs: end });
        return response;
      };
      for (let i = 0; i < 3; i += 1) {
        const sampled = await measure('status', 'r3_test_settings_status');
        assert(sampled.result?.sourceRootConfigured === true, 'cached Settings status is available');
      }
      const beforeQuery = (await privateAction(ipcPath, 'r3_test_owner_snapshot')).result;
      const queryStartedAt = Date.now();
      const activeQuery = await privateAction(ipcPath, 'search_documents', { query: marker, limit: 5 });
      const queryFinishedAt = Date.now();
      const afterQuery = (await privateAction(ipcPath, 'r3_test_owner_snapshot')).result;
      evidence.activeQuery = {
        startedAtEpochMs: queryStartedAt, finishedAtEpochMs: queryFinishedAt,
        workerJobId: activePayload.indexing.jobId,
        activeBefore: beforeQuery?.active === true && beforeQuery.jobId === activePayload.indexing.jobId,
        activeAfter: afterQuery?.active === true && afterQuery.jobId === activePayload.indexing.jobId,
        queryCompleted: Array.isArray(activeQuery.result?.results),
        queryError: Boolean(activeQuery.error || activeQuery.result?.isError),
        resultCount: Array.isArray(activeQuery.result?.results) ? activeQuery.result.results.length : null,
        savedDocumentId: payload.documentId,
        foundDocumentId: activeQuery.result?.results?.find((item) =>
          item.documentId === payload.documentId)?.documentId || null
      };
      assert(evidence.activeQuery.activeBefore && evidence.activeQuery.activeAfter
        && evidence.activeQuery.queryCompleted && !evidence.activeQuery.queryError,
      'packaged query completes while the same owner job remains active');
      const beforeSave = (await privateAction(ipcPath, 'r3_test_owner_snapshot')).result;
      const secondContent = `# Active save overlap\n\n${marker}second\n`;
      const saveStartedAt = Date.now();
      const secondResponse = await privateAction(ipcPath, 'save_document', {
        content: secondContent, title: 'Active overlap fixture'
      }, 20000);
      const saveFinishedAt = Date.now();
      const afterSave = (await privateAction(ipcPath, 'r3_test_owner_snapshot')).result;
      const secondPayload = JSON.parse(secondResponse.result?.content?.[0]?.text || 'null');
      evidence.activeSave = { startedAtEpochMs: saveStartedAt,
        finishedAtEpochMs: saveFinishedAt, workerJobId: activePayload.indexing.jobId,
        activeBefore: beforeSave?.active === true && beforeSave.jobId === activePayload.indexing.jobId,
        activeAfter: afterSave?.active === true && afterSave.jobId === activePayload.indexing.jobId,
        ownerBeforePhase: beforeSave?.phase || null,
        ownerAfterPhase: afterSave?.phase || null,
        ownerBeforeJobId: beforeSave?.jobId || null,
        ownerAfterJobId: afterSave?.jobId || null,
        saved: secondPayload?.saved === true, indexingState: secondPayload?.indexing?.state,
        receiptJobId: secondPayload?.indexing?.jobId,
        responseIsError: secondResponse.result?.isError === true || Boolean(secondResponse.error),
        responseErrorCode: /^[a-z][a-z0-9_]{0,63}$/.test(
          secondPayload?.error?.code || secondResponse.error || '')
          ? (secondPayload?.error?.code || secondResponse.error) : null,
        responseDiagnosticCode: /^[a-z][a-z0-9_]{0,63}$/.test(secondPayload?.error?.message || '')
          ? secondPayload.error.message : null,
        receiptDocumentId: secondPayload?.documentId || null,
        contentBytes: Buffer.byteLength(secondContent), contentSha256: sha256(secondContent) };
      const secondFile = fs.readdirSync(storeRoot).filter(name => name.endsWith('.md'))
        .map(name => path.join(storeRoot, name))
        .find(file => fs.readFileSync(file, 'utf8').includes(`${marker}second`));
      const secondFileHash = secondFile ? sha256(fs.readFileSync(secondFile)) : null;
      const privateIntentDir = fs.readdirSync(fixtureRoot)
        .find(name => name.startsWith('.doculight-save-intents-'));
      const intentFiles = privateIntentDir
        ? fs.readdirSync(path.join(fixtureRoot, privateIntentDir))
          .filter(name => name.endsWith('.intent.json')) : [];
      evidence.activeSave.publicationLockPresent = Boolean(privateIntentDir)
        && fs.existsSync(path.join(fixtureRoot, privateIntentDir, '.publication.lock'));
      evidence.activeSave.publicationRecoveryGatePresent = Boolean(privateIntentDir)
        && fs.existsSync(path.join(fixtureRoot, privateIntentDir, '.publication.lock.recovery'));
      evidence.activeSave.published = Boolean(secondFile);
      evidence.activeSave.intentPersisted = intentFiles.some(name => {
        const intent = JSON.parse(fs.readFileSync(path.join(fixtureRoot, privateIntentDir, name), 'utf8'));
        return intent.contentHash === secondFileHash;
      });
      assert(evidence.activeSave.activeBefore && evidence.activeSave.activeAfter
        && evidence.activeSave.saved && evidence.activeSave.receiptJobId,
      'second save receives durable receipt while same owner job stays active');
      activeProbe = onActive ? onActive({ fixtureRoot, userData,
        workerJobId: activePayload.indexing.jobId }) : null;
      if (activeProbe) {
        evidence.pg09HelperStarted = true;
        evidence.pg09HelperPid = activeProbe.helperPid;
      }
      if (activeProbe) await awaitWithReferencedTimeout(activeProbe.started,
        'PG-09 direct I/O start', 40000);
      if (activeProbe) {
        const sampled = await measure('status', 'r3_test_settings_status');
        assert(sampled.result?.sourceRootConfigured === true,
          'cached Settings status remains available under direct I/O');
      }
      const measureViewer = async (kind, action, event, params) => {
        const watch = await privateAction(ipcPath, 'r3_test_viewer_event_watch', { windowId, event });
        assert(watch.result?.token, `${kind} completion observer is armed`);
        const start = performance.now();
        const response = await privateAction(ipcPath, action, params);
        const completion = await privateAction(ipcPath, 'r3_test_viewer_event_wait',
          { token: watch.result.token });
        const end = performance.now();
        evidence.responsiveness.samples.push({ kind, ms: end - start,
          startMonoMs: start, endMonoMs: end });
        assert(completion.result?.completed === true && completion.result.event === event,
          `${kind} completion event is observed`);
        return response;
      };
      const focused = await measureViewer('focus', 'update_markdown', 'focus',
        { windowId, foreground: true, noSave: true });
      assert(focused.result?.title, 'viewer focus succeeds during active owner job');
      const closed = await measureViewer('close', 'close_viewer', 'closed', { windowId });
      assert(closed.result?.closed === 1, 'viewer close succeeds during active owner job');
      evidence.flow.closed = await until('viewer close', 10000, async () => {
        const viewers = await privateAction(ipcPath, 'list_viewers');
        return !viewers.result?.windows?.some((item) => item.windowId === windowId);
      });
      const status = await privateAction(ipcPath, 'r3_test_settings_status');
      evidence.flow.activeStatusSeen = evidence.flow.activeStatusSeen
        && status.result?.sourceRootConfigured === true;
      const beforeCancel = activeProbe
        ? (await privateAction(ipcPath, 'r3_test_owner_snapshot')).result : null;
      const beforeCancelAudit = activeProbe
        ? (await privateAction(ipcPath, 'r3_test_owner_open_audit')).result : null;
      const terminalWatch = activeProbe
        ? await armOwnerTerminalWatch(privateAction, ipcPath, activePayload.indexing.jobId) : null;
      const cancelRequestedAtEpochMs = Date.now();
      const cancelled = await measure('cancel', 'r3_test_settings_cancel');
      evidence.flow.cancelAccepted = cancelled.result?.cancelled === true;
      evidence.cancelObservation = { cancelRequestedAtEpochMs,
        requestedJobId: activePayload.indexing.jobId,
        watcherToken: terminalWatch?.token || null,
        cancelResponseAccepted: evidence.flow.cancelAccepted };
      if (activeProbe) {
        evidence.pg09 = await awaitWithReferencedTimeout(activeProbe.completion,
          'PG-09 direct I/O completion', 40000);
        evidence.pg09.scheduler.helperActiveBefore = activeAudit?.ownerActiveJobCount === 1
          && activeAudit.ownerActiveJobId === activePayload.indexing.jobId;
        evidence.pg09.scheduler.helperActiveAfter = beforeCancel?.active === true
          && beforeCancel.jobId === activePayload.indexing.jobId;
        evidence.pg09.scheduler.ownerWorkerCount = beforeCancelAudit?.ownerWorkerCount;
        evidence.pg09.scheduler.legacyActiveWorkerCount = beforeCancelAudit?.legacyActiveWorkerCount;
        evidence.pg09.scheduler.checkerWorkerCount = beforeCancelAudit?.checkerWorkerCount;
        evidence.pg09.scheduler.ownerActiveJobCount = beforeCancelAudit?.ownerActiveJobCount;
        evidence.pg09.scheduler.ownerActiveJobId = beforeCancelAudit?.ownerActiveJobId;
        evidence.pg09.scheduler.ownerWorkerThreadId = beforeCancelAudit?.workerThreadId;
        evidence.pg09.linkedImport = completedImport;
      }
      const heartbeatStop = await privateAction(ipcPath, 'r3_test_main_heartbeat_stop',
        { jobId: activePayload.indexing.jobId });
      const heartbeat = heartbeatStop.result;
      assert(heartbeat?.clock === 'electron-main' && heartbeat.activeAtStart === true
        && heartbeat.overflow === false && Array.isArray(heartbeat.ticks)
        && heartbeat.ticks.length > 0, 'main heartbeat spans active owner samples');
      evidence.responsiveness.heartbeatGaps = [heartbeat.ticks[0] - heartbeat.startedAt,
        ...heartbeat.ticks.slice(1).map((tick, i) => tick - heartbeat.ticks[i]),
        heartbeat.stoppedAt - heartbeat.ticks.at(-1)];
      evidence.responsiveness.byKind = Object.fromEntries(['status', 'focus', 'close'].map((kind) => {
        const values = evidence.responsiveness.samples.filter((sample) => sample.kind === kind)
          .map((sample) => sample.ms);
        return [kind, { count: values.length, p95: percentile(values, .95),
          p99: percentile(values, .99), max: Math.max(...values) }];
      }));
      evidence.responsiveness.cancelMs = evidence.responsiveness.samples.find((sample) =>
        sample.kind === 'cancel').ms;
      if (evidence.flow.cancelAccepted) {
        let terminalCancel = null;
        try {
          terminalCancel = terminalWatch ? await terminalWatch.wait()
            : (await privateAction(ipcPath, 'r3_test_owner_wait_terminal',
              { jobId: activePayload.indexing.jobId, phase: 'cancelled' }, 20000)).result;
        } catch { /* recorded as missing terminal, not a substituted PASS */ }
        const afterTerminal = (await privateAction(ipcPath, 'r3_test_owner_snapshot')
          .catch(() => null))?.result;
        Object.assign(evidence.cancelObservation, {
          terminalJobId: terminalCancel?.jobId || null,
          terminalPhase: terminalCancel?.phase || null,
          snapshotJobId: afterTerminal?.jobId || null,
          snapshotPhase: afterTerminal?.phase || null,
          nextOwnerJobId: afterTerminal?.jobId !== activePayload.indexing.jobId
            ? afterTerminal?.jobId || null : null });
        evidence.flow.cancelAccepted = terminalCancel?.jobId === activePayload.indexing.jobId
          && terminalCancel?.phase === 'cancelled';
      }
      const activePath = path.join(storeRoot, activePayload.sourceRelativePath);
      evidence.flow.cancelledFileRetained = fs.existsSync(activePath)
        && fs.readFileSync(activePath, 'utf8').includes(activeMarker);
      if (completedImport) {
        completedImport.retainedAfterCancel =
          fs.existsSync(path.join(storeRoot, 'entry.md'))
          && fs.existsSync(path.join(storeRoot, 'completed.md'))
          && sha256(fs.readFileSync(path.join(storeRoot, 'entry.md')))
            === completedImport.entrySha256
          && sha256(fs.readFileSync(path.join(storeRoot, 'completed.md')))
            === completedImport.sha256;
        evidence.flow.completedImportRetained = completedImport.retainedAfterCancel;
      }
      const secondPath = path.join(storeRoot, secondPayload.sourceRelativePath);
      const retainedBytes = fs.readFileSync(secondPath);
      evidence.activeSave.retainedBytes = retainedBytes.length;
      evidence.activeSave.retainedSha256 = sha256(retainedBytes);
      evidence.activeSave.bodyMatchesInput = parseFrontmatter(retainedBytes.toString('utf8')).body
        === secondContent;
    }
    const main = (await privateAction(ipcPath, 'r3_test_main_sqlite_snapshot')).result;
    evidence.main = { writableOpenCount: main?.writableOpenCount,
      sqliteOpenCalls: main?.sqliteOpenCalls };
    quitAccepted = (await privateAction(ipcPath, 'r3_test_graceful_quit')).result?.accepted === true;
    await until('normal packaged app IPC release', 20000, async () => {
      const response = await privateAction(ipcPath, 'list_viewers', {}, 500).catch(() => null);
      return !response;
    });
    await until('actual packaged app process exit', 20000, async () =>
      child.exitCode !== null && !processIsAlive(identity.pid));
    evidence.lifecycle.exited = true;
    evidence.lifecycle.exitCode = child.exitCode;
    evidence.lifecycle.appProcessGone = true;
    evidence.lifecycle.handleReleased = true;
    const Database = require('better-sqlite3');
    const ledger = new Database(path.join(userData, 'index', 'smart-search.sqlite3'),
      { readonly: true, fileMustExist: true });
    try { evidence.corpus = { fileCount: fs.readdirSync(storeRoot).filter((name) => name.endsWith('.md')).length,
      bytes: fs.readdirSync(storeRoot).filter((name) => name.endsWith('.md'))
        .reduce((sum, name) => sum + fs.statSync(path.join(storeRoot, name)).size, 0),
      ledgerRows: ledger.prepare('SELECT COUNT(*) AS count FROM sources').get().count };
      if (evidence.activeSave?.receiptDocumentId) {
        const row = ledger.prepare(`SELECT document_id, content_hash, content_byte_length,
          accepted_intent_id
          FROM documents WHERE document_id = ?`).get(evidence.activeSave.receiptDocumentId);
        evidence.activeSave.ledgerDocumentId = row?.document_id || null;
        evidence.activeSave.ledgerBytes = row?.content_byte_length ?? null;
        evidence.activeSave.ledgerSha256 = row?.content_hash?.replace(/^sha256:/, '') || null;
        evidence.activeSave.acceptedIntentId = row?.accepted_intent_id || null;
        const job = ledger.prepare(`SELECT job_id, document_id FROM index_jobs
          WHERE job_id = ?`).get(evidence.activeSave.receiptJobId);
        evidence.activeSave.ledgerReceiptJobId = job?.job_id || null;
        evidence.activeSave.ledgerReceiptDocumentId = job?.document_id || null;
        const acceptance = ledger.prepare(`SELECT intent_id, receipt_kind, job_id,
          document_id, content_hash FROM save_intent_acceptances
          WHERE job_id = ? AND document_id = ?`).get(evidence.activeSave.receiptJobId,
          evidence.activeSave.receiptDocumentId);
        evidence.activeSave.acceptanceIntentId = acceptance?.intent_id || null;
        evidence.activeSave.acceptanceReceiptKind = acceptance?.receipt_kind || null;
        evidence.activeSave.acceptanceJobId = acceptance?.job_id || null;
        evidence.activeSave.acceptanceDocumentId = acceptance?.document_id || null;
        evidence.activeSave.acceptanceSha256 = acceptance?.content_hash?.replace(/^sha256:/, '') || null;
      }
    }
    finally { ledger.close(); }
    if (evidence.cancelObservation?.requestedJobId)
      evidence.cancelObservation.durableJob = readDurableCancelledJob(userData,
        evidence.cancelObservation.requestedJobId);
    if (!activeProbe || evidence.pg09?.scheduler?.helperProcessGone === true)
      safeRemoveFixture(fixtureRoot);
    evidence.lifecycle.profileRemoved = !fs.existsSync(fixtureRoot);
    try { validateNativeOwnerEvidence(evidence, { requireProcessCold }); }
    catch (error) { error.evidence = evidence; throw error; }
    return evidence;
  } catch (error) {
    error.evidence = evidence;
    throw error;
  } finally {
    if (activeProbe) {
      try {
        const completedProbe = await awaitWithReferencedTimeout(activeProbe.completion,
          'PG-09 direct I/O cleanup', 40000);
        if (!evidence.pg09) evidence.pg09 = completedProbe;
      } catch (error) {
        evidence.pg09ProbeDiagnostic = typeof error?.code === 'string'
          ? error.code : 'helper_completion_failed';
      }
      if (evidence.cancelObservation?.requestedJobId
        && !Object.hasOwn(evidence.cancelObservation, 'durableJob')) {
        try { evidence.cancelObservation.durableJob = readDurableCancelledJob(userData,
          evidence.cancelObservation.requestedJobId); }
        catch (error) { evidence.cancelObservation.durableJobDiagnostic =
          typeof error?.code === 'string' ? error.code : 'durable_job_read_failed'; }
      }
    }
    if (!quitAccepted) {
      await privateAction(ipcPath, 'r3_test_graceful_quit', {}, 1000).catch(() => null);
    }
    if (child.exitCode === null) child.kill();
    if (Number.isInteger(appPid) && processIsAlive(appPid)) {
      await until('owned app exit', 3000, async () => !processIsAlive(appPid)).catch(() => null);
      if (processIsAlive(appPid)) {
        try { process.kill(appPid); } catch { /* process exited between check and signal */ }
      }
    }
    if (fs.existsSync(fixtureRoot) && (!Number.isInteger(appPid) || !processIsAlive(appPid))
      && (!activeProbe || evidence.pg09?.scheduler?.helperProcessGone === true)) {
      safeRemoveFixture(fixtureRoot);
    }
  }
}

module.exports = { runPackageNativeOwnerSmoke, armOwnerTerminalWatch,
  readDurableCancelledJob, awaitWithReferencedTimeout };
