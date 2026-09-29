'use strict';

// @req OPS-ARCH-012 (partial live coexistence evidence; see artifact flags)
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { sourceHash, validateRoot } = require('./r3/runtime.cjs');
const { resolveRuntimeProfile } = require('../src/main/runtime-profile');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const within = (file, root) => {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
};

function privateAction(ipcPath, action, params = {}, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(ipcPath);
    let body = '';
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('private IPC timeout')));
    socket.on('connect', () => socket.write(`${JSON.stringify({
      id: crypto.randomUUID(), action, params
    })}\n`));
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

async function until(label, deadlineMs, probe) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await pause(50);
  }
  throw new Error(`PROFILE_SETUP_TIMEOUT ${label}`);
}

function spawnApp(executable, args, cwd, env) {
  const child = spawn(executable, args, {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  child.output = '';
  child.stdout.on('data', chunk => { child.output += chunk; });
  child.stderr.on('data', chunk => { child.output += chunk; });
  return child;
}

function waitForExit(child, deadlineMs) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('owned app did not exit')), deadlineMs);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function safeFixtureRoot() {
  const provided = process.env.DOCULIGHT_PROFILE_TEST_TEMP_ROOT;
  if (!provided || !path.isAbsolute(provided))
    throw new Error('SETUP_ERROR provide an existing absolute DOCULIGHT_PROFILE_TEST_TEMP_ROOT');
  const root = path.resolve(provided);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory())
    throw new Error('SETUP_ERROR profile temp root does not exist');
  return root;
}

async function main() {
  const electronRoot = process.env.DOCULIGHT_R3_ELECTRON_ROOT || '';
  const packagedExe = process.env.DOCULIGHT_R3_PACKAGED_EXE || '';
  const currentHash = sourceHash();
  const check = validateRoot(electronRoot, 'electron', currentHash);
  if (!check.ok) throw new Error(`SETUP_ERROR Electron snapshot: ${check.reason}`);
  if (!path.isAbsolute(packagedExe) || !fs.existsSync(packagedExe))
    throw new Error('SETUP_ERROR provide a direct packaged executable');
  const asar = path.join(path.dirname(packagedExe), 'resources', 'app.asar');
  if (!fs.existsSync(asar) && !/Portable.*\.exe$/i.test(packagedExe))
    throw new Error('SETUP_ERROR selected executable is not a packaged app');
  const sourceExe = createRequire(path.join(electronRoot, 'package.json'))('electron');
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const testTreeDirty = Boolean(execFileSync('git', ['status', '--porcelain'], {
    encoding: 'utf8'
  }).trim());
  const packageDigest = sha(fs.readFileSync(packagedExe));
  const tempRoot = safeFixtureRoot();
  const fixture = fs.mkdtempSync(path.join(tempRoot, 'profile-coexistence-'));
  const appData = path.join(fixture, 'appData');
  const defaultUserData = path.join(appData, 'DocuLight');
  const devUserData = path.join(appData, 'DocuLight-dev');
  const defaultStore = path.join(fixture, 'default-store');
  const devStore = path.join(fixture, 'dev-store');
  const defaultIpc = process.platform === 'win32'
    ? `\\\\.\\pipe\\doculight-profile-default-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
    : path.join(fixture, 'default.sock');
  const devIpc = process.platform === 'win32'
    ? `\\\\.\\pipe\\doculight-profile-dev-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
    : path.join(fixture, 'dev.sock');
  const owned = [];
  let evidence;
  try {
    for (const dir of [defaultUserData, devUserData, defaultStore, devStore])
      fs.mkdirSync(dir, { recursive: true });
    const defaultPort = await freePort();
    const devPort = await freePort();
    assert.notEqual(defaultPort, devPort, 'live profiles use distinct MCP ports');
    for (const [userData, store, port] of [
      [defaultUserData, defaultStore, defaultPort], [devUserData, devStore, devPort]
    ]) fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
      mcpAutoSave: true, mcpAutoSavePath: store, mcpSaveSubDir: '', mcpPort: port
    }));
    const baseEnv = { ...process.env, APPDATA: appData, DOCULIGHT_R3_TEST_LIFECYCLE: '1',
      DOCULIGHT_LOCALE: 'en' };
    delete baseEnv.ELECTRON_RUN_AS_NODE;
    delete baseEnv.DOCULIGHT_PACKAGE_SMOKE;
    const defaultEnv = { ...baseEnv, DOCULIGHT_PROFILE: 'default',
      DOCULIGHT_IPC_PATH: defaultIpc };
    const devEnv = { ...baseEnv, DOCULIGHT_PROFILE: 'dev',
      DOCULIGHT_DEV_USER_DATA_DIR: devUserData, DOCULIGHT_DEV_IPC_PATH: devIpc };
    delete devEnv.DOCULIGHT_IPC_PATH;
    const defaultArgs = [`--user-data-dir=${defaultUserData}`, '--r3-test-lifecycle'];
    const devArgs = [electronRoot, '--profile=dev', '--r3-test-lifecycle'];
    const packaged = spawnApp(packagedExe, defaultArgs, electronRoot, defaultEnv);
    owned.push(packaged);
    const dev = spawnApp(sourceExe, devArgs, electronRoot, devEnv);
    owned.push(dev);
    const expected = [
      { child: packaged, ipc: defaultIpc, userData: defaultUserData, profile: 'default',
        port: defaultPort, env: defaultEnv, store: defaultStore, marker: 'profiledefaultneedle' },
      { child: dev, ipc: devIpc, userData: devUserData, profile: 'dev',
        port: devPort, env: devEnv, store: devStore, marker: 'profiledevneedle' }
    ];
    for (const item of expected) {
      const identity = await until(`${item.profile} product identity`, 30000, async () => {
        if (item.child.exitCode !== null)
          throw new Error(`${item.profile} exited before IPC ready with code ${item.child.exitCode}`);
        return (await privateAction(item.ipc, 'r3_test_runtime_identity').catch(() => null))?.result;
      });
      assert.equal(identity.profile, item.profile);
      assert.equal(identity.isPackaged, item.profile === 'default');
      assert.equal(path.resolve(identity.userDataDir), path.resolve(item.userData));
      item.pid = identity.pid;
      item.portObserved = await until(`${item.profile} MCP discovery`, 15000, () => {
        const file = path.join(item.userData, 'mcp-port');
        return fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : null;
      });
      assert.equal(item.portObserved, item.port);
      const profile = resolveRuntimeProfile({
        profileName: item.profile, platform: process.platform, env: item.env,
        appDataDir: appData, defaultUserDataDir: defaultUserData
      });
      assert.equal(path.resolve(profile.indexDataDir), path.resolve(path.join(item.userData, 'index')));
      assert.equal(path.resolve(profile.nativeRebuildStatusFile),
        path.resolve(path.join(item.userData, 'native-rebuild', 'native-rebuild-status.json')));
      item.nativeStatusFile = profile.nativeRebuildStatusFile;
      const saved = await privateAction(item.ipc, 'save_document', {
        content: `# ${item.profile} profile proof\n\n${item.marker}\n`
      });
      const body = JSON.parse(saved.result?.content?.[0]?.text || 'null');
      assert.equal(body?.saved, true, `${item.profile} save is accepted by its own process`);
      assert.equal(body.indexing?.state, 'queued');
      assert.equal(typeof body.indexing.jobId, 'string');
      assert(fs.existsSync(path.join(item.store, body.sourceRelativePath)),
        `${item.profile} Markdown stays in its own store`);
      await until(`${item.profile} source ledger`, 15000,
        () => fs.existsSync(path.join(profile.indexDataDir, 'smart-search.sqlite3')));
      const terminal = await privateAction(item.ipc, 'r3_test_owner_wait_terminal',
        { jobId: body.indexing.jobId, phase: 'completed' }, 30000);
      assert.equal(terminal.result?.jobId, body.indexing.jobId);
    }
    assert.notEqual(expected[0].pid, expected[1].pid, 'two main processes coexist');
    assert.notEqual(defaultIpc, devIpc, 'private IPC endpoints differ');
    assert.notEqual(expected[0].portObserved, expected[1].portObserved, 'MCP discoveries differ');
    assert.notEqual(path.resolve(expected[0].nativeStatusFile),
      path.resolve(expected[1].nativeStatusFile), 'native status paths differ');
    for (const item of expected) {
      const own = await until(`${item.profile} own indexed marker`, 15000, async () => {
        const response = await privateAction(item.ipc, 'search_documents', { query: item.marker });
        return response.result?.results?.length > 0 ? response : null;
      });
      const other = expected.find(candidate => candidate !== item);
      const foreign = await privateAction(item.ipc, 'search_documents', { query: other.marker });
      const results = [...own.result.results, ...(foreign.result?.results || [])];
      assert(results.length > 0 && results.every(result => within(result.filePath, item.store)
        && fs.readFileSync(result.filePath, 'utf8').includes(item.marker)
        && !fs.readFileSync(result.filePath, 'utf8').includes(other.marker)),
      `${item.profile} indexed files contain its own marker and exclude the other profile marker`);
    }
    for (const item of expected) {
      const duplicate = spawnApp(item.profile === 'default' ? packagedExe : sourceExe,
        item.profile === 'default' ? defaultArgs : devArgs, electronRoot, item.env);
      owned.push(duplicate);
      assert.equal(await waitForExit(duplicate, 20000), 0,
        `${item.profile} duplicate exits through the same-profile lock`);
      assert.equal((await privateAction(item.ipc, 'r3_test_runtime_identity')).result?.pid,
        item.pid, `${item.profile} primary survives its duplicate`);
    }
    for (const item of expected) {
      assert.equal((await privateAction(item.ipc, 'r3_test_graceful_quit')).result?.accepted, true);
      assert.equal(await waitForExit(item.child, 15000), 0);
    }
    evidence = { sourceHash: currentHash, sourceCommit, testTreeDirty,
      platform: process.platform,
      arch: process.arch, packageSha256: packageDigest,
      packageBuildProvenance: 'unverified', exactSourcePackage: false,
      packagedExecutable: path.basename(packagedExe), profiles: expected.map(item => ({
        profile: item.profile, pid: item.pid, port: item.portObserved,
        userDataSeparated: true, indexLedgerFileObserved: true,
        indexSearchIsolated: true, nativeStatusPathDerivedSeparated: true,
        nativeStatusFileObserved: fs.existsSync(item.nativeStatusFile),
        discoveryFileObserved: true, duplicateExited: true, gracefulExit: true
      })), crossProfileCoexistenceObserved: true,
      npmDevLaunchObserved: false, defaultPortIsolationObserved: false,
      cliEndpointSelectionObserved: false,
      auditReady: false,
      outcome: 'package-provenance-unverified-coexistence-observed' };
  } finally {
    let allExited = true;
    for (const child of owned) {
      if (child.exitCode === null) child.kill();
      try { await waitForExit(child, 5000); }
      catch { allExited = false; }
    }
    const relative = path.relative(path.resolve(tempRoot), path.resolve(fixture));
    if (allExited && relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      try { fs.rmSync(fixture, { recursive: true, force: true }); }
      catch (error) { throw new Error(`profile fixture cleanup failed: ${error.code}`); }
    }
    if (!allExited) throw new Error('owned product did not exit; fixture retained');
  }
  evidence.cleanupCompleted = true;
  evidence.testExitCode = 0;
  const artifactPath = path.join(tempRoot,
    `s34-profile-${currentHash.slice(0, 12)}-${Date.now()}.json`);
  fs.writeFileSync(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  console.log(`S34_PROFILE_ARTIFACT ${path.basename(artifactPath)} sha256=${sha(fs.readFileSync(artifactPath))}`);
  console.log(`S34_PROFILE_EVIDENCE ${JSON.stringify(evidence)}`);
  console.log('test-profile-coexistence-product: PASS');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
