'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { validateNativeOwnerEvidence } = require('./package-native-owner-evidence');
const { sourceFiles, sourceHash } = require('../r3/runtime.cjs');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
async function runPackageNativeOwnerSmoke({ appPath, artifactKind, root }) {
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
    fixtureSha256: sha256(content), runtime: {}, owner: {}, main: {}, flow: {}, lifecycle: {}
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
  try {
    await until('normal packaged app IPC', 45000, async () =>
      (await privateAction(ipcPath, 'r3_test_runtime_identity').catch(() => null))?.result);
    const identity = (await privateAction(ipcPath, 'r3_test_runtime_identity')).result;
    evidence.runtime = { isPackaged: identity?.isPackaged, profile: identity?.profile,
      isolatedUserData: path.resolve(identity?.userDataDir || '') === path.resolve(userData),
      electronAbi: identity?.electronAbi };
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
      await privateAction(ipcPath, 'close_viewer', { windowId }, 20000);
      evidence.flow.closed = await until('viewer close', 10000, async () => {
        const viewers = await privateAction(ipcPath, 'list_viewers');
        return !viewers.result?.windows?.some((item) => item.windowId === windowId);
      });
      const status = await privateAction(ipcPath, 'r3_test_settings_status');
      evidence.flow.activeStatusSeen = evidence.flow.activeStatusSeen
        && status.result?.sourceRootConfigured === true;
      const cancelled = await privateAction(ipcPath, 'r3_test_settings_cancel');
      evidence.flow.cancelAccepted = cancelled.result?.cancelled === true;
      if (evidence.flow.cancelAccepted) {
        const terminalCancel = await privateAction(ipcPath, 'r3_test_owner_wait_terminal',
          { jobId: activePayload.indexing.jobId, phase: 'cancelled' }, 20000);
        evidence.flow.cancelAccepted = terminalCancel.result?.phase === 'cancelled';
      }
      const activePath = path.join(storeRoot, activePayload.sourceRelativePath);
      evidence.flow.cancelledFileRetained = fs.existsSync(activePath)
        && fs.readFileSync(activePath, 'utf8').includes(activeMarker);
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
    safeRemoveFixture(fixtureRoot);
    evidence.lifecycle.profileRemoved = !fs.existsSync(fixtureRoot);
    try { validateNativeOwnerEvidence(evidence); }
    catch (error) { error.evidence = evidence; throw error; }
    return evidence;
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

module.exports = { runPackageNativeOwnerSmoke };
