'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { validateNativeOwnerEvidence } = require('../test/helpers/package-native-owner-evidence');
const { runPackageNativeOwnerSmoke } = require('../test/helpers/package-native-owner-smoke');
const { sourceFiles, sourceHash } = require('../test/r3/runtime.cjs');

const root = path.resolve(__dirname, '..');
const sha256File = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const planPath = path.join(root, 'docs', 'analysis', 'p0-pg04-rerun-plan.json');
const manifestPath = path.join(root, 'dist', 'p0-pg04-build-manifest.json');
const pg09ManifestPath = path.join(root, 'dist', 'p0-pg09-build-manifest.json');

function sanitizeDiagnostic(value) {
  return String(value || '').slice(0, 500)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/?#\s@]+@/gi, '$1[REDACTED]@')
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>]+/g, '[REDACTED_PATH]')
    .replace(/\\\\[^\\/\s]+[\\/][^\s"'<>]+/g, '[REDACTED_PATH]')
    .replace(/(^|[\s"'=])\/{1,2}[^\/\s"'<>]+(?:\/[^\s"'<>]+)+/g,
      '$1[REDACTED_PATH]')
    .replace(/\/(?:Users|home|tmp|temp|var|private|mnt|Volumes|Work)\b[^\s"'<>]*/g,
      '[REDACTED_PATH]')
    .replace(/(api[_-]?key|token|password|bearer)=([^\s"'&]+)/gi, '$1=[REDACTED]');
}

function expectedSourceHash() {
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  assert.match(plan.frozenSourceHash, /^[a-f0-9]{64}$/, 'frozen source hash in rerun plan');
  return plan.frozenSourceHash;
}

function currentPackageEvidence(appPath, artifactKind) {
  const stat = fs.statSync(appPath);
  return { selectedAppSha256: sha256File(appPath), sourceHash: sourceHash(),
    commitSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root,
      encoding: 'utf8', windowsHide: true }).trim(), artifactKind,
    os: process.platform, arch: process.arch, nodeVersion: process.version,
    nodeAbi: process.versions.modules, packageBytes: stat.size,
    packageMtimeMs: stat.mtimeMs,
    nativeVersions: { betterSqlite3: require('../node_modules/better-sqlite3/package.json').version,
      hnswlibNode: fs.existsSync(path.join(root, 'node_modules', 'hnswlib-node', 'package.json'))
        ? require('../node_modules/hnswlib-node/package.json').version : null } };
}

function recordBuildManifest(appPath, artifactKind, destination = manifestPath) {
  assert(fs.existsSync(appPath) && fs.statSync(appPath).isFile(), 'packaged app file required');
  const evidence = currentPackageEvidence(appPath, artifactKind);
  assert.strictEqual(evidence.sourceHash,
    destination === pg09ManifestPath ? sourceHash() : expectedSourceHash(),
  'frozen source hash mismatch');
  const newestSourceMtimeMs = Math.max(...sourceFiles().map(file =>
    fs.statSync(path.join(root, file)).mtimeMs));
  assert(evidence.packageMtimeMs >= newestSourceMtimeMs,
    'fresh package build must follow all source edits');
  const manifest = { version: 'p0-pg04-build.v1',
    sourceHash: evidence.sourceHash, selectedAppSha256: evidence.selectedAppSha256,
    commitSha: evidence.commitSha, packageBytes: evidence.packageBytes,
    packageMtimeMs: evidence.packageMtimeMs, newestSourceMtimeMs,
    recordedAtEpochMs: Date.now() };
  fs.writeFileSync(destination, JSON.stringify(manifest, null, 2));
  return manifest;
}

// @req IR-APP-013 AC-13 REL-DOC-007 AC-2 OPS-ARCH-009 AC-2 OPS-ARCH-012 AC-5
function validatePackageProvenance(packageEvidence, { expectedSourceHash, buildManifest } = {}) {
  assert.match(expectedSourceHash, /^[a-f0-9]{64}$/, 'frozen expected source hash required');
  assert.strictEqual(packageEvidence.sourceHash, expectedSourceHash, 'frozen source hash mismatch');
  assert.strictEqual(buildManifest?.version, 'p0-pg04-build.v1', 'fresh build manifest required');
  assert.strictEqual(buildManifest.sourceHash, expectedSourceHash, 'build manifest source hash mismatch');
  assert.strictEqual(buildManifest.selectedAppSha256, packageEvidence.selectedAppSha256,
    'build manifest package checksum mismatch');
  assert.strictEqual(buildManifest.commitSha, packageEvidence.commitSha,
    'build manifest commit SHA mismatch');
  assert.strictEqual(buildManifest.packageBytes, packageEvidence.packageBytes,
    'build manifest package size mismatch');
  assert.strictEqual(buildManifest.packageMtimeMs, packageEvidence.packageMtimeMs,
    'build manifest package modification time mismatch');
  assert(Number.isFinite(buildManifest.recordedAtEpochMs)
    && buildManifest.recordedAtEpochMs >= buildManifest.packageMtimeMs,
  'fresh build manifest recording time required');
  if (Number.isFinite(buildManifest.newestSourceMtimeMs)) {
    assert(buildManifest.packageMtimeMs >= buildManifest.newestSourceMtimeMs,
      'fresh package build must follow source edits');
  }
}

function validatePg04Report(report, provenance) {
  assert.strictEqual(report.version, 'p0-pg04.v1');
  assert(Array.isArray(report.samples) && report.samples.length === 5, 'five raw samples required');
  if (provenance) validatePackageProvenance(report.package, provenance);
  assert.match(report.package?.selectedAppSha256, /^[a-f0-9]{64}$/);
  assert.match(report.package?.sourceHash, /^[a-f0-9]{64}$/);
  assert.match(report.package?.commitSha, /^[a-f0-9]{40}$/);
  assert(['portable', 'app', 'appimage'].includes(report.package?.artifactKind), 'direct packaged artifact required');
  const pids = new Set();
  const profiles = new Set();
  for (const [index, sample] of report.samples.entries()) {
    assert.strictEqual(sample.sample, index + 1, 'sample order is retained');
    validateNativeOwnerEvidence(sample, { requireProcessCold: true });
    assert.strictEqual(sample.selectedAppSha256, report.package.selectedAppSha256, 'exact package checksum');
    assert.strictEqual(sample.sourceHash, report.package.sourceHash, 'exact source hash');
    assert.strictEqual(sample.baseCommit, report.package.commitSha, 'exact commit SHA');
    const query = sample.activeQuery;
    assert(query?.activeBefore === true && query.activeAfter === true
      && query.queryCompleted === true && query.queryError === false
      && Number.isInteger(query.resultCount) && query.resultCount >= 0
      && typeof query.workerJobId === 'string' && query.workerJobId.length > 0
      && Number.isFinite(query.startedAtEpochMs)
      && query.startedAtEpochMs >= sample.processCold.workerReadyEpochMs
      && Number.isFinite(query.finishedAtEpochMs)
      && query.finishedAtEpochMs >= query.startedAtEpochMs
      && typeof query.savedDocumentId === 'string' && query.savedDocumentId.length > 0,
    'active query follows worker marker and completes without error during maintenance');
    const save = sample.activeSave;
    assert(save?.activeBefore === true && save.activeAfter === true
      && save.saved === true && save.indexingState === 'queued'
      && typeof save.receiptJobId === 'string' && save.receiptJobId.length > 0
      && typeof save.workerJobId === 'string' && save.workerJobId.length > 0
      && Number.isFinite(save.startedAtEpochMs)
      && save.startedAtEpochMs >= sample.processCold.workerReadyEpochMs
      && Number.isFinite(save.finishedAtEpochMs)
      && save.finishedAtEpochMs >= save.startedAtEpochMs
      && Number.isInteger(save.contentBytes) && save.contentBytes > 0
      && save.bodyMatchesInput === true
      && typeof save.receiptDocumentId === 'string' && save.receiptDocumentId.length > 0
      && save.ledgerDocumentId === save.receiptDocumentId
      && save.ledgerReceiptJobId === save.receiptJobId
      && save.ledgerReceiptDocumentId === save.receiptDocumentId
      && save.acceptanceReceiptKind === 'queued'
      && /^[a-f0-9]{64}$/.test(save.acceptanceIntentId)
      && save.acceptedIntentId === save.acceptanceIntentId
      && save.acceptanceJobId === save.receiptJobId
      && save.acceptanceDocumentId === save.receiptDocumentId
      && Number.isInteger(save.retainedBytes) && save.retainedBytes > 0
      && save.retainedBytes === save.ledgerBytes
      && /^[a-f0-9]{64}$/.test(save.contentSha256)
      && /^[a-f0-9]{64}$/.test(save.retainedSha256)
      && save.retainedSha256 === save.ledgerSha256
      && save.retainedSha256 === save.acceptanceSha256,
    'active save follows worker marker and its body, retained file and ledger match the durable receipt');
    assert(Number.isInteger(sample.corpus?.fileCount) && sample.corpus.fileCount > 0
      && Number.isInteger(sample.corpus?.bytes) && sample.corpus.bytes > 0
      && Number.isInteger(sample.corpus?.ledgerRows) && sample.corpus.ledgerRows > 0,
    'corpus and ledger size evidence');
    pids.add(sample.processCold.pid);
    profiles.add(sample.processCold.profileToken);
  }
  assert(pids.size === 5 && profiles.size === 5, 'five distinct process-cold PID and profile tokens');
  const byKind = {};
  for (const kind of ['status', 'focus', 'close']) {
    const values = report.samples.flatMap(sample => sample.responsiveness.samples
      .filter(entry => entry.kind === kind).map(entry => entry.ms));
    assert(values.length >= 5 && values.every(value => Number.isFinite(value) && value >= 0),
      `${kind} raw samples required`);
    byKind[kind] = { count: values.length, p95: percentile(values, .95),
      p99: percentile(values, .99), max: Math.max(...values) };
    assert(byKind[kind].p95 <= 250 && byKind[kind].p99 <= 500 && byKind[kind].max <= 1000,
      `${kind} PG-04 threshold`);
  }
  const cancels = report.samples.flatMap(sample => sample.responsiveness.samples
    .filter(entry => entry.kind === 'cancel').map(entry => entry.ms));
  const gaps = report.samples.flatMap(sample => sample.responsiveness.heartbeatGaps);
  assert(cancels.length === 5 && cancels.every(value => Number.isFinite(value) && value <= 1000),
    'every cancel sample PG-04 threshold');
  assert(gaps.length >= 10 && gaps.every(value => Number.isFinite(value) && value <= 250),
    'main heartbeat PG-04 threshold');
  return { byKind, cancelMax: Math.max(...cancels), heartbeatGapMax: Math.max(...gaps) };
}

// @req IR-APP-013 AC-13 REL-DOC-007 AC-2 REL-DOC-009 AC-4 OPS-ARCH-009 AC-2
function validatePg09Sample(sample) {
  assert(sample.runtime?.isPackaged === true && sample.runtime.electronAbi,
    'PG-09 packaged runtime and Electron ABI required');
  assert(sample.processCold?.commandLineRedacted
    === '[PACKAGED_APP] --user-data-dir=[PROFILE] --r3-test-lifecycle'
    && sample.pg09?.scheduler?.helperCommand
    === '[PYTHON_EXECUTABLE] [PG09_HELPER] [FIXTURE] [PROFILE]'
    && /^[a-f0-9]{64}$/.test(sample.pg09.scheduler.helperExecutableSha256),
  'PG-09 owned PID command lines must be recorded without private paths');
  assert(Number.isInteger(sample.owner?.workerThreadId) && sample.owner.workerThreadId > 0
    && sample.owner.ledgerOpenThreadId === sample.owner.workerThreadId
    && sample.owner.keywordOpenThreadId === sample.owner.workerThreadId
    && sample.main?.writableOpenCount === 0
    && sample.responsiveness?.workerMarker === true,
  'PG-09 active single owner worker required');
  assert(sample.flow?.activeStatusSeen && sample.flow?.cancelAccepted
    && sample.flow?.cancelledFileRetained && sample.flow?.failedSaveRetained
    && sample.flow?.retryableIntentPresent && sample.flow?.completedImportRetained
    && sample.pg09?.linkedImport?.completed === true
    && sample.pg09.linkedImport.retainedAfterCancel === true
    && /^[a-f0-9]{64}$/.test(sample.pg09.linkedImport.sha256)
    && sample.activeSave?.activeBefore
    && sample.activeSave?.activeAfter && sample.activeSave?.saved
    && sample.activeSave?.indexingState === 'queued',
  'PG-09 durable saved files and active maintenance required');
  const kinds = new Set(sample.responsiveness?.samples?.map(entry => entry.kind));
  assert(['status', 'focus', 'close', 'cancel'].every(kind => kinds.has(kind))
    && sample.responsiveness.heartbeatGaps?.length > 0
    && sample.responsiveness.heartbeatGaps.every(gap => Number.isFinite(gap) && gap <= 250),
  'PG-09 foreground samples and heartbeat required');
  const scheduler = sample.pg09?.scheduler;
  assert(scheduler?.ownerWorkerCount === 1
    && scheduler.legacyActiveWorkerCount === 0
    && scheduler.checkerWorkerCount === 0
    && scheduler.ownerActiveJobCount === 1
    && scheduler.ownerWorkerThreadId === sample.owner.workerThreadId
    && scheduler.ownerActiveJobId === scheduler.workerJobId
    && scheduler.helperActiveBefore === true && scheduler.helperActiveAfter === true
    && Number.isInteger(scheduler.helperPid) && scheduler.helperPid > 0
    && scheduler.helperExitCode === 0
    && scheduler.helperProcessGone === true
    && scheduler.ioStartMarkerReceived === true
    && scheduler.ioFinishMarkerReceived === true
    && Number.isFinite(scheduler.ioStartMonoMs)
    && Number.isFinite(scheduler.ioEndMonoMs)
    && scheduler.ioEndMonoMs > scheduler.ioStartMonoMs
    && Number.isFinite(scheduler.mainHeartbeatMaxMs)
    && scheduler.mainHeartbeatMaxMs <= 250,
  'PG-09 single-worker scheduler overlap required');
  const cancel = sample.cancelObservation;
  assert(Number.isFinite(cancel?.cancelRequestedAtEpochMs)
    && typeof cancel.watcherToken === 'string' && cancel.watcherToken.length > 0
    && cancel.requestedJobId === scheduler.workerJobId
    && cancel.terminalJobId === scheduler.workerJobId
    && cancel.terminalPhase === 'cancelled'
    && cancel.durableJob?.jobId === scheduler.workerJobId
    && cancel.durableJob.status === 'cancelled'
    && cancel.durableJob.cancelRequested === true,
  'PG-09 armed terminal observer and durable cancelled job required');
  for (const kind of ['status', 'focus', 'close', 'cancel']) {
    assert(sample.responsiveness.samples.some(entry => entry.kind === kind
      && Number.isFinite(entry.startMonoMs) && Number.isFinite(entry.endMonoMs)
      && entry.endMonoMs >= entry.startMonoMs
      && entry.startMonoMs < scheduler.ioEndMonoMs
      && entry.endMonoMs > scheduler.ioStartMonoMs),
    `PG-09 ${kind} must overlap direct I/O on common monotonic clock`);
  }
  const io = sample.pg09?.unbufferedSameVolumeIo;
  assert(io?.status === 'pass' && io.semantics === 'FILE_FLAG_NO_BUFFERING'
    && io.bufferAligned === true && io.offsetsAligned === true
    && io.sourceVolumeToken && io.outputVolumeToken === io.sourceVolumeToken
    && io.profileVolumeToken === io.sourceVolumeToken
    && io.filesystem === 'NTFS'
    && Number.isInteger(io.fixtureBytes) && io.fixtureBytes > 0
    && io.bytesRead === io.fixtureBytes && io.bytesWritten >= io.fixtureBytes
    && /^[a-f0-9]{64}$/.test(io.fixtureSha256)
    && io.outputSha256 === io.fixtureSha256,
  'PG-09 direct unbuffered same-volume I/O required; unsupported is failure');
}

function shouldStopPg09Collection(sample) {
  return sample?.pg09?.scheduler?.helperProcessGone === false
    || (sample?.pg09HelperStarted === true
      && sample?.pg09?.scheduler?.helperProcessGone !== true);
}

function runDirectIo({ fixtureRoot, userData, workerJobId }) {
  const helper = path.join(__dirname, 'pg09-direct-io.py');
  const pythonExe = execFileSync('py', ['-3.14', '-c', 'import sys; print(sys.executable)'], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
  assert(fs.existsSync(pythonExe) && fs.statSync(pythonExe).isFile(),
    'PG-09 resolved Python executable required');
  const child = spawn(pythonExe, [helper, fixtureRoot, userData], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let lines = '';
  let stderr = '';
  let ioStartMonoMs = null;
  let ioEndMonoMs = null;
  let readyResolve;
  const started = new Promise(resolve => { readyResolve = resolve; });
  const completion = new Promise(resolve => {
    let timedOut = false;
    let settled = false;
    let grace;
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (grace) clearTimeout(grace);
      if (ioStartMonoMs === null) readyResolve(false);
      let io;
      try { io = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)); }
      catch { io = { status: 'unsupported', reason: 'invalid_helper_output' }; }
      if (timedOut) io = { status: 'unsupported', reason: 'helper_timeout' };
      let helperProcessGone = false;
      if (Number.isInteger(child.pid)) {
        try { process.kill(child.pid, 0); }
        catch (error) { helperProcessGone = error.code === 'ESRCH'; }
      }
      resolve({ scheduler: {
        workerJobId, helperPid: child.pid, helperExitCode: code,
        helperExecutableSha256: sha256File(pythonExe),
        helperProcessGone, ioStartMonoMs, ioEndMonoMs,
        ioStartMarkerReceived: ioStartMonoMs !== null,
        ioFinishMarkerReceived: ioEndMonoMs !== null, timedOut,
        helperActiveBefore: true, helperActiveAfter: false,
        helperCommand: '[PYTHON_EXECUTABLE] [PG09_HELPER] [FIXTURE] [PROFILE]',
        helperDiagnostic: sanitizeDiagnostic(stderr) },
      unbufferedSameVolumeIo: io });
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      if (Number.isInteger(child.pid) && child.exitCode === null) child.kill();
      grace = setTimeout(() => {
        if (Number.isInteger(child.pid) && child.exitCode === null) child.kill();
        finish(null);
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }, 2000);
    }, 30000);
    child.stdout.on('data', chunk => {
      const part = chunk.toString();
      stdout = (stdout + part).slice(-4096);
      lines += part;
      while (lines.includes('\n')) {
        const line = lines.slice(0, lines.indexOf('\n'));
        lines = lines.slice(lines.indexOf('\n') + 1);
        try {
          const phase = JSON.parse(line).phase;
          if (phase === 'direct_io_started' && ioStartMonoMs === null) {
            ioStartMonoMs = performance.now();
            readyResolve(true);
          }
          if (phase === 'direct_io_finished' && ioEndMonoMs === null)
            ioEndMonoMs = performance.now();
        } catch { /* final output becomes a failed helper result */ }
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.once('error', error => { stderr = sanitizeDiagnostic(error.message); finish(null); });
    child.once('close', code => finish(code));
  });
  return { started, completion, helperPid: child.pid };
}

function windowsSystemEvidence() {
  let powerSchemeGuid = null;
  try {
    const output = execFileSync('powercfg', ['/getactivescheme'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000 });
    powerSchemeGuid = output.match(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/i)?.[0] || null;
  } catch { /* absence is retained as null and fails review rather than inferred */ }
  return { runner: 'local-windows-x64', platform: process.platform,
    arch: process.arch, cpuModel: os.cpus()[0]?.model || null,
    cpuLogicalCount: os.cpus().length, ramBytes: os.totalmem(),
    powerSchemeGuid };
}

function registerIncompleteReportExitGuard(report, write) {
  const onExit = () => {
    if (report.status !== 'running') return;
    report.status = 'failed';
    report.failures.push({ code: 'early_process_exit', completedSamples: report.samples.length });
    try { write(); } catch { /* report may be unavailable during forced teardown */ }
    process.exitCode = 1;
  };
  process.on('exit', onExit);
  return () => process.off('exit', onExit);
}

function parseArgs(args) {
  const parsed = { samples: 5, requirePackaged: false, pg04Only: false,
    pg09Only: false, requireWindowsSystemCanary: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--samples') parsed.samples = Number(args[++i]);
    else if (args[i] === '--require-packaged') parsed.requirePackaged = true;
    else if (args[i] === '--pg04-only') parsed.pg04Only = true;
    else if (args[i] === '--pg09-only') parsed.pg09Only = true;
    else if (args[i] === '--require-windows-system-canary') parsed.requireWindowsSystemCanary = true;
    else if (args[i] === '--app') parsed.app = args[++i];
    else if (args[i] === '--out') parsed.out = args[++i];
    else throw new Error(`Unknown PG-04 option: ${args[i]}`);
  }
  assert(parsed.samples === 5 && parsed.requirePackaged
    && (parsed.pg04Only !== parsed.pg09Only)
    && (!parsed.pg09Only || parsed.requireWindowsSystemCanary),
    'five packaged samples and exactly one PG-04 or Windows PG-09 mode required');
  return parsed;
}

async function run(args = process.argv.slice(2)) {
  if (args.includes('--record-build-manifest') || args.includes('--record-pg09-build-manifest')) {
    const pg09Build = args.includes('--record-pg09-build-manifest');
    const filtered = args.filter(arg => arg !== '--record-build-manifest'
      && arg !== '--record-pg09-build-manifest');
    assert(filtered.length === 0, 'build manifest command takes no other options');
    const appPath = path.join(root, 'dist',
      `DocuLight-Portable-${require('../package.json').version}.exe`);
    recordBuildManifest(appPath, 'portable', pg09Build ? pg09ManifestPath : manifestPath);
    console.log(JSON.stringify({ status: 'recorded',
      manifest: path.basename(pg09Build ? pg09ManifestPath : manifestPath) }));
    return 0;
  }
  const options = parseArgs(args);
  if (options.pg09Only) assert(process.platform === 'win32' && process.arch === 'x64',
    'PG-09 requires Windows x64');
  const packageVersion = require('../package.json').version;
  const defaultApp = process.platform === 'win32'
    ? path.join(root, 'dist', `DocuLight-Portable-${packageVersion}.exe`)
    : null;
  const appPath = path.resolve(options.app || process.env.DOCULIGHT_PG04_APP || defaultApp || '');
  assert(fs.existsSync(appPath) && fs.statSync(appPath).isFile(), 'exact packaged app file required');
  const artifactKind = process.platform === 'win32' ? 'portable'
    : process.platform === 'darwin' ? 'app' : 'appimage';
  const packageEvidence = currentPackageEvidence(appPath, artifactKind);
  const selectedManifestPath = options.pg09Only ? pg09ManifestPath : manifestPath;
  const provenance = { expectedSourceHash: options.pg09Only ? sourceHash() : expectedSourceHash(),
    buildManifest: JSON.parse(fs.readFileSync(selectedManifestPath, 'utf8')) };
  validatePackageProvenance(packageEvidence, provenance);
  const newestSourceMtimeMs = Math.max(...sourceFiles().map(file =>
    fs.statSync(path.join(root, file)).mtimeMs));
  assert(packageEvidence.packageMtimeMs >= newestSourceMtimeMs
    && provenance.buildManifest.newestSourceMtimeMs === newestSourceMtimeMs,
  'fresh package build manifest predates no source edits');
  const report = { version: options.pg09Only ? 'p0-pg09.v1' : 'p0-pg04.v1',
    status: 'running', package: packageEvidence,
    ...(options.pg09Only ? { system: windowsSystemEvidence() } : {}),
    buildManifestSha256: sha256File(selectedManifestPath), samples: [], failures: [] };
  const out = path.resolve(options.out || path.join(root, 'docs', 'analysis',
    `p0-${options.pg09Only ? 'pg09' : 'pg04'}-${process.platform}-${process.arch}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const reportFd = fs.openSync(out, 'wx');
  const write = () => {
    const bytes = Buffer.from(JSON.stringify(report, null, 2));
    fs.ftruncateSync(reportFd, 0);
    fs.writeSync(reportFd, bytes, 0, bytes.length, 0);
    fs.fsyncSync(reportFd);
  };
  write();
  registerIncompleteReportExitGuard(report, write);
  for (let sample = 1; sample <= 5; sample++) {
    let captured;
    try {
      captured = { ...await runPackageNativeOwnerSmoke({
        appPath, artifactKind, root, requireProcessCold: true,
        onActive: options.pg09Only ? runDirectIo : undefined }), sample };
    } catch (error) {
      captured = { ...(error.evidence || {}), sample, failed: true };
      report.failures.push({ sample, code: 'sample_failed',
        message: sanitizeDiagnostic(error.message || error) });
    }
    report.samples.push(captured);
    if (options.pg09Only && shouldStopPg09Collection(captured)) {
      captured.failed = true;
      report.collectionStoppedAfterSample = sample;
      report.failures.push({ sample, code: 'owned_helper_exit_unconfirmed',
        ownedHelperPid: captured.pg09?.scheduler?.helperPid || captured.pg09HelperPid || null,
        message: 'Owned PG-09 interpreter exit was not confirmed; collection stopped.',
        diagnostic: sanitizeDiagnostic(captured.pg09?.scheduler?.helperDiagnostic) });
      write();
      break;
    }
    write();
  }
  try {
    report.aggregate = validatePg04Report({ ...report, version: 'p0-pg04.v1' }, provenance);
    if (options.pg09Only) {
      assert(report.system?.powerSchemeGuid && report.system?.cpuLogicalCount > 0
        && report.system?.ramBytes > 0, 'PG-09 Windows runner power, CPU and RAM required');
      for (const sample of report.samples) {
        sample.pg09.scheduler.mainHeartbeatMaxMs = Math.max(...sample.responsiveness.heartbeatGaps);
        validatePg09Sample(sample);
      }
      report.scheduler = 'pass';
      report.unbufferedSameVolumeIo = 'pass';
    }
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.failures.push({ code: options.pg09Only ? 'pg09_contract_failed' : 'pg04_contract_failed',
      message: sanitizeDiagnostic(error.message || error) });
  }
  write();
  fs.closeSync(reportFd);
  console.log(JSON.stringify({ status: report.status, report: path.basename(out),
    aggregate: report.aggregate || null, failures: report.failures }));
  return report.status === 'passed' ? 0 : 1;
}

if (require.main === module) run().then(code => { process.exitCode = code; }, error => {
  console.error(sanitizeDiagnostic(error.message || error)); process.exitCode = 1;
});

module.exports = { validatePg04Report, validatePg09Sample, shouldStopPg09Collection,
  validatePackageProvenance, registerIncompleteReportExitGuard,
  sanitizeDiagnostic, parseArgs, run };
