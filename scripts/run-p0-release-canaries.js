'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { validateNativeOwnerEvidence } = require('../test/helpers/package-native-owner-evidence');
const { runPackageNativeOwnerSmoke } = require('../test/helpers/package-native-owner-smoke');
const { sourceFiles, sourceHash } = require('../test/r3/runtime.cjs');

const root = path.resolve(__dirname, '..');
const sha256File = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const planPath = path.join(root, 'docs', 'analysis', 'p0-pg04-rerun-plan.json');
const manifestPath = path.join(root, 'dist', 'p0-pg04-build-manifest.json');

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
      hnswlibNode: require('../node_modules/hnswlib-node/package.json').version } };
}

function recordBuildManifest(appPath, artifactKind) {
  assert(fs.existsSync(appPath) && fs.statSync(appPath).isFile(), 'packaged app file required');
  const evidence = currentPackageEvidence(appPath, artifactKind);
  assert.strictEqual(evidence.sourceHash, expectedSourceHash(), 'frozen source hash mismatch');
  const newestSourceMtimeMs = Math.max(...sourceFiles().map(file =>
    fs.statSync(path.join(root, file)).mtimeMs));
  assert(evidence.packageMtimeMs >= newestSourceMtimeMs,
    'fresh package build must follow all source edits');
  const manifest = { version: 'p0-pg04-build.v1',
    sourceHash: evidence.sourceHash, selectedAppSha256: evidence.selectedAppSha256,
    commitSha: evidence.commitSha, packageBytes: evidence.packageBytes,
    packageMtimeMs: evidence.packageMtimeMs, newestSourceMtimeMs,
    recordedAtEpochMs: Date.now() };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
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
      && save.retainedBytes === save.contentBytes
      && /^[a-f0-9]{64}$/.test(save.contentSha256)
      && save.retainedSha256 === save.contentSha256,
    'active save follows worker marker and retains bytes with a durable receipt');
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

function parseArgs(args) {
  const parsed = { samples: 5, requirePackaged: false, pg04Only: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--samples') parsed.samples = Number(args[++i]);
    else if (args[i] === '--require-packaged') parsed.requirePackaged = true;
    else if (args[i] === '--pg04-only') parsed.pg04Only = true;
    else if (args[i] === '--app') parsed.app = args[++i];
    else if (args[i] === '--out') parsed.out = args[++i];
    else throw new Error(`Unknown PG-04 option: ${args[i]}`);
  }
  assert(parsed.samples === 5 && parsed.requirePackaged && parsed.pg04Only,
    'PG-04 requires --samples 5 --require-packaged --pg04-only');
  return parsed;
}

async function run(args = process.argv.slice(2)) {
  if (args.includes('--record-build-manifest')) {
    const filtered = args.filter(arg => arg !== '--record-build-manifest');
    assert(filtered.length === 0, 'build manifest command takes no other options');
    const appPath = path.join(root, 'dist',
      `DocuLight-Portable-${require('../package.json').version}.exe`);
    recordBuildManifest(appPath, 'portable');
    console.log(JSON.stringify({ status: 'recorded', manifest: path.basename(manifestPath) }));
    return 0;
  }
  const options = parseArgs(args);
  const packageVersion = require('../package.json').version;
  const defaultApp = process.platform === 'win32'
    ? path.join(root, 'dist', `DocuLight-Portable-${packageVersion}.exe`)
    : null;
  const appPath = path.resolve(options.app || process.env.DOCULIGHT_PG04_APP || defaultApp || '');
  assert(fs.existsSync(appPath) && fs.statSync(appPath).isFile(), 'exact packaged app file required');
  const artifactKind = process.platform === 'win32' ? 'portable'
    : process.platform === 'darwin' ? 'app' : 'appimage';
  const packageEvidence = currentPackageEvidence(appPath, artifactKind);
  const provenance = { expectedSourceHash: expectedSourceHash(),
    buildManifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')) };
  validatePackageProvenance(packageEvidence, provenance);
  const newestSourceMtimeMs = Math.max(...sourceFiles().map(file =>
    fs.statSync(path.join(root, file)).mtimeMs));
  assert(packageEvidence.packageMtimeMs >= newestSourceMtimeMs
    && provenance.buildManifest.newestSourceMtimeMs === newestSourceMtimeMs,
  'fresh package build manifest predates no source edits');
  const report = { version: 'p0-pg04.v1', status: 'running', package: packageEvidence,
    buildManifestSha256: sha256File(manifestPath), samples: [], failures: [] };
  const out = path.resolve(options.out || path.join(root, 'docs', 'analysis',
    `p0-pg04-${process.platform}-${process.arch}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const reportFd = fs.openSync(out, 'wx');
  const write = () => {
    const bytes = Buffer.from(JSON.stringify(report, null, 2));
    fs.ftruncateSync(reportFd, 0);
    fs.writeSync(reportFd, bytes, 0, bytes.length, 0);
    fs.fsyncSync(reportFd);
  };
  write();
  for (let sample = 1; sample <= 5; sample++) {
    try {
      report.samples.push({ ...await runPackageNativeOwnerSmoke({
        appPath, artifactKind, root, requireProcessCold: true }), sample });
    } catch (error) {
      report.samples.push({ ...(error.evidence || {}), sample, failed: true });
      report.failures.push({ sample, code: 'sample_failed',
        message: sanitizeDiagnostic(error.message || error) });
    }
    write();
  }
  try {
    report.aggregate = validatePg04Report(report, provenance);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.failures.push({ code: 'pg04_contract_failed',
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

module.exports = { validatePg04Report, validatePackageProvenance,
  sanitizeDiagnostic, parseArgs, run };
