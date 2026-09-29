'use strict';

// @req OPS-ARCH-013 AC-1 AC-6 AC-7 AC-8 (partial Windows package evidence)
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { sourceHash } = require('./r3/runtime.cjs');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const ps = script => execFileSync('powershell', ['-NoProfile', '-Command', script],
  { encoding: 'utf8', windowsHide: true, timeout: 8000 }).trim();

async function until(label, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await pause(100);
  }
  throw new Error(`CLI_SETUP_TIMEOUT ${label}`);
}

function processInfo(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const json = ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if($p){$p | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress}`);
  return json ? JSON.parse(json) : null;
}

function directChildren(pid) {
  const json = ps(`@(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${pid}' | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress`);
  if (!json) return [];
  const parsed = JSON.parse(json);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function owningPortPid(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const value = ps(`$c=Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if($c){$c.OwningProcess}`);
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function cliProcessAudit(pid) {
  const json = ps(`$p=Get-Process -Id ${pid} -ErrorAction Stop; $m=@($p.Modules | Where-Object { $_.ModuleName -match 'better_sqlite3|hnswlib|search-index-worker' } | ForEach-Object { $_.ModuleName }); @{windowHandle=$p.MainWindowHandle.ToInt64(); nativeModules=$m} | ConvertTo-Json -Compress`);
  return JSON.parse(json);
}

function hideOwnedWindow(pid) {
  const result = ps(`$p=Get-Process -Id ${pid} -ErrorAction Stop; $h=$p.MainWindowHandle; if($h -ne [IntPtr]::Zero){ Add-Type -Namespace DocuLightCliTest -Name Window -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);'; [DocuLightCliTest.Window]::ShowWindow($h,0) | Out-Null; 'hidden' } else { 'no-window-handle' }`);
  return result === 'hidden';
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

function launchCli(packageExe, env) {
  const asarEntry = path.join(path.dirname(packageExe), 'resources', 'app.asar',
    'src', 'main', 'index.js');
  const child = spawn(packageExe, [asarEntry, '--mcp-stdio'], {
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });
  const pending = new Map();
  const output = { validJsonRpc: 0, otherLines: 0, stderrBytes: 0,
    autoLaunchAttemptLogged: false, configuredLaunchLogged: false, spawnFailureLogged: false };
  let buffer = '';
  let closed = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) { output.otherLines += 1; continue; }
      let message;
      try { message = JSON.parse(line); } catch { output.otherLines += 1; continue; }
      if (message?.jsonrpc !== '2.0') { output.otherLines += 1; continue; }
      output.validJsonRpc += 1;
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message); }
    }
  });
  child.stderr.on('data', chunk => {
    const text = String(chunk);
    output.stderrBytes += Buffer.byteLength(chunk);
    if (text.includes('attempting auto-launch')) output.autoLaunchAttemptLogged = true;
    if (text.includes('Launching configured')) output.configuredLaunchLogged = true;
    if (text.includes('Failed to spawn')) output.spawnFailureLogged = true;
  });
  child.on('close', () => {
    closed = true;
    if (buffer.length > 0) output.otherLines += 1;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('CLI closed before MCP reply'));
    }
    pending.clear();
  });
  let nextId = 0;
  function request(method, params, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); },
        timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async function initialize() {
    const response = await request('initialize', {
      protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: 'doculight-cli-autolaunch-test', version: '0.0.0' }
    });
    assert(response.result, 'packaged CLI initializes MCP');
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', method: 'notifications/initialized', params: {}
    })}\n`);
    const list = await request('tools/list', {});
    assert.equal(list.result?.tools?.length, 8, 'packaged CLI retains exact eight-tool surface');
  }
  async function close() {
    if (!child.stdin.destroyed) child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await new Promise(resolve => {
      if (closed) return resolve();
      const timer = setTimeout(resolve, 5000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
    assert(closed && (child.exitCode !== null || child.signalCode !== null),
      'owned CLI process and stdio streams close');
  }
  return { child, output, request, initialize, close };
}

function tempRoot() {
  const provided = process.env.DOCULIGHT_CLI_TEST_TEMP_ROOT;
  if (!provided || !path.isAbsolute(provided) || !fs.existsSync(provided))
    throw new Error('SETUP_ERROR provide an existing absolute DOCULIGHT_CLI_TEST_TEMP_ROOT');
  return path.resolve(provided);
}

async function main() {
  if (process.platform !== 'win32') throw new Error('SETUP_ERROR Windows package required');
  const packageExe = process.env.DOCULIGHT_R3_PACKAGED_EXE || '';
  const asar = path.join(path.dirname(packageExe), 'resources', 'app.asar');
  if (!path.isAbsolute(packageExe) || !fs.existsSync(packageExe) || !fs.existsSync(asar))
    throw new Error('SETUP_ERROR use direct unpacked packaged executable with app.asar');
  const root = tempRoot();
  const fixture = fs.mkdtempSync(path.join(root, 'cli-autolaunch-'));
  const appData = path.join(fixture, 'appData');
  const userData = path.join(appData, 'DocuLight-dev');
  const pipe = `\\\\.\\pipe\\doculight-cli-auto-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const packageDigest = sha(fs.readFileSync(packageExe));
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const testTreeDirty = Boolean(execFileSync('git', ['status', '--porcelain'],
    { encoding: 'utf8' }).trim());
  const ownedCli = [];
  let launchedAppPid = null;
  let ownedAppPid = null;
  let evidence;
  try {
    fs.mkdirSync(userData, { recursive: true });
    const port = await freePort();
    fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ mcpPort: port }));
    // The CLI selects the missing default endpoint; the test-owned child uses
    // the isolated dev runtime because another default-profile app may be open.
    const baseEnv = { ...process.env, APPDATA: appData,
      DOCULIGHT_MCP_PROFILE: 'default', DOCULIGHT_PROFILE: 'dev',
      DOCULIGHT_IPC_PATH: pipe, DOCULIGHT_DEV_IPC_PATH: pipe,
      DOCULIGHT_DEV_USER_DATA_DIR: userData, DOCLIGHT_APP_PATH: packageExe };
    delete baseEnv.DOCULIGHT_MCP_IPC_PATH;
    delete baseEnv.DOCULIGHT_PACKAGE_SMOKE;
    const cli = launchCli(packageExe, baseEnv);
    ownedCli.push(cli);
    await cli.initialize();
    let callOutcome = null;
    let maxDirectChildren = 0;
    let childExecutable = null;
    let childCommandHasStdio = null;
    const call = cli.request('tools/call', { name: 'list_viewers', arguments: {} })
      .then(value => { callOutcome = { value }; return callOutcome; },
        error => { callOutcome = { error }; return callOutcome; });
    try {
      launchedAppPid = await until('auto-launched app HTTP port', 15000, async () => {
        if (callOutcome?.error) throw callOutcome.error;
        const children = directChildren(cli.child.pid);
        maxDirectChildren = Math.max(maxDirectChildren, children.length);
        if (children.length) {
          childExecutable = path.basename(children[0].ExecutablePath || '');
          childCommandHasStdio = String(processInfo(children[0].ProcessId)?.CommandLine || '')
            .includes('--mcp-stdio');
        }
        const portFile = path.join(userData, 'mcp-port');
        if (!fs.existsSync(portFile) || Number(fs.readFileSync(portFile, 'utf8')) !== port) return null;
        return owningPortPid(port);
      });
    } catch (error) {
      throw new Error(`${error.message}; callIsError=${callOutcome?.value?.result?.isError}; maxChildren=${maxDirectChildren}; childExecutable=${childExecutable}; childHasStdioArg=${childCommandHasStdio}; launchLogged=${cli.output.autoLaunchAttemptLogged}; configuredLaunch=${cli.output.configuredLaunchLogged}; spawnFailure=${cli.output.spawnFailureLogged}; userDataEntries=${JSON.stringify(fs.readdirSync(userData))}`);
    }
    const appInfo = processInfo(launchedAppPid);
    assert(appInfo && path.resolve(appInfo.ExecutablePath) === path.resolve(packageExe),
      'only the selected package owns the new app port');
    assert.equal(appInfo.ParentProcessId, cli.child.pid, 'CLI launches exactly one direct app child');
    ownedAppPid = launchedAppPid;
    const hiddenAfterReady = hideOwnedWindow(ownedAppPid);
    assert.equal(maxDirectChildren, 1, 'one test-owned app child appears during auto-launch');
    assert(!String(appInfo.CommandLine).includes('--mcp-stdio')
      && !String(appInfo.CommandLine).includes('ELECTRON_RUN_AS_NODE'),
    'auto-launched child uses normal app arguments');
    const result = await call;
    if (result.error) throw result.error;
    assert(result.value.result?.isError !== true, 'CLI reaches its auto-launched app');
    const cliAudit = cliProcessAudit(cli.child.pid);
    assert.equal(cliAudit.windowHandle, 0, 'CLI process has no visible main window');
    assert.deepEqual(cliAudit.nativeModules, [], 'CLI process loads no app native modules');
    assert.equal(cli.output.otherLines, 0, 'CLI stdout contains only newline-delimited JSON-RPC');
    assert.equal(hiddenAfterReady, true, 'test-owned app window is hidden after readiness');
    assert.notEqual(launchedAppPid, cli.child.pid, 'app HTTP server belongs to a distinct PID');
    assert.equal(directChildren(cli.child.pid).filter(child =>
      path.resolve(child.ExecutablePath || '') === path.resolve(packageExe)).length, 1,
    'CLI has one packaged app child, without recursive launch');
    const noLaunch = [];
    for (const [kind, extraEnv] of [
      ['dev', { DOCULIGHT_MCP_PROFILE: 'dev', DOCULIGHT_DEV_IPC_PATH: pipe + '-missing-dev' }],
      ['explicit', { DOCULIGHT_MCP_IPC_PATH: pipe + '-missing-explicit' }]
    ]) {
      const missing = launchCli(packageExe, { ...baseEnv, ...extraEnv });
      ownedCli.push(missing);
      await missing.initialize();
      const reply = await missing.request('tools/call',
        { name: 'list_viewers', arguments: {} });
      const text = JSON.stringify(reply);
      assert(reply.result?.isError === true
        && text.includes(`[REDACTED_MCP_IPC:${kind}]`)
        && !text.includes(extraEnv.DOCULIGHT_MCP_IPC_PATH || extraEnv.DOCULIGHT_DEV_IPC_PATH),
      `${kind} missing endpoint returns a redacted MCP error`);
      assert.equal(directChildren(missing.child.pid).length, 0,
        `${kind} missing endpoint does not launch an app child`);
      noLaunch.push({ kind, redactedError: true, childCount: 0 });
      await missing.close();
    }
    evidence = { sourceCommit, sourceHash: sourceHash(), testTreeDirty,
      platform: process.platform, arch: process.arch, packageSha256: packageDigest,
      packageBuildProvenance: 'unverified', exactSourcePackage: false,
      cliPid: cli.child.pid, appPid: launchedAppPid,
      cliLaunchMode: 'windows-electron-as-node-asar-entry',
      appCommandLineSha256: sha(String(appInfo.CommandLine)),
      appParentIsCli: true, appArgsNormal: true, appWindowHiddenAfterReady: hiddenAfterReady,
      normalAppWindowMayAppearBriefly: true, cliMainWindowHandleZero: true,
      cliAppNativeDllsLoadedAtProbe: [], cliProviderJsImportsAudited: false,
      appHttpPortOwnedByDifferentPid: true,
      directAppChildCountAtReady: 1, recursiveCliDescendantObserved: false,
      cliStdoutJsonRpcOnly: null,
      cliJsonRpcMessageCount: null, noLaunch,
      cliMcpProfile: 'default', autoLaunchedRuntimeProfileInferred: 'dev',
      defaultProfileMissingIpcVerified: false,
      auditReady: false, outcome: 'package-provenance-unverified-cli-autolaunch-observed' };
  } finally {
    const appPids = new Set(ownedAppPid ? [ownedAppPid] : []);
    for (const cli of ownedCli) {
      for (const child of directChildren(cli.child.pid)) {
        if (child.ExecutablePath
          && path.resolve(child.ExecutablePath) === path.resolve(packageExe))
          appPids.add(child.ProcessId);
      }
    }
    for (const pid of appPids) {
      const info = processInfo(pid);
      if (info && path.resolve(info.ExecutablePath) === path.resolve(packageExe))
        process.kill(pid);
    }
    for (const cli of ownedCli) await cli.close();
    for (const pid of appPids) await until('owned app exit', 10000,
      () => !processInfo(pid));
    const relative = path.relative(root, fixture);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) throw new Error('unsafe fixture cleanup target');
    fs.rmSync(fixture, { recursive: true, force: true });
  }
  for (const cli of ownedCli)
    assert.equal(cli.output.otherLines, 0, 'complete CLI stdout contains only JSON-RPC lines');
  evidence.cliStdoutJsonRpcOnly = true;
  evidence.cliJsonRpcMessageCount = ownedCli[0].output.validJsonRpc;
  evidence.cleanupCompleted = true;
  evidence.testExitCode = 0;
  const artifact = path.join(root, `s34-cli-${evidence.sourceHash.slice(0, 12)}-${Date.now()}.json`);
  fs.writeFileSync(artifact, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  console.log(`S34_CLI_ARTIFACT ${path.basename(artifact)} sha256=${sha(fs.readFileSync(artifact))}`);
  console.log(`S34_CLI_EVIDENCE ${JSON.stringify(evidence)}`);
  console.log('test-packaged-cli-autolaunch-product: PASS');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
