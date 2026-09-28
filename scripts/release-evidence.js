'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { validateNativeOwnerEvidence } = require('../test/helpers/package-native-owner-evidence');

const targets = Object.freeze([
  { platform: 'win32', arch: 'x64', name: 'windows-x64' },
  { platform: 'darwin', arch: 'arm64', name: 'macos-arm64' },
  { platform: 'linux', arch: 'x64', name: 'linux-x64' }
]);
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const shaPattern = /^[a-f0-9]{40}$/;
const releaseAssetPattern = Object.freeze({
  win32: /^DocuLight-(?:Setup|Portable)-.*\.exe$/,
  darwin: /^DocuLight-.*\.zip$/,
  linux: /^DocuLight-.*\.(?:AppImage|deb)$/
});
const macExecutableMember = 'DocuLight.app/Contents/MacOS/DocuLight';

function macExecutableSha256(zipPath) {
  const script = [
    'import hashlib,sys,zipfile',
    'with zipfile.ZipFile(sys.argv[1]) as archive:',
    '  member=sys.argv[2]',
    '  assert archive.namelist().count(member)==1, "expected one packaged app executable"',
    '  digest=hashlib.sha256()',
    '  with archive.open(member) as stream:',
    '    for chunk in iter(lambda:stream.read(1024*1024),b""): digest.update(chunk)',
    '  print(digest.hexdigest())'
  ].join('\n');
  return execFileSync(process.platform === 'win32' ? 'python' : 'python3',
    ['-c', script, zipPath, macExecutableMember], { encoding: 'utf8' }).trim();
}

function assertSelectedPackageChecksum(target, packagePath, selectedChecksum) {
  const packagedChecksum = target.platform === 'darwin'
    ? macExecutableSha256(packagePath) : sha256(packagePath);
  assert.strictEqual(selectedChecksum, packagedChecksum,
    `${target.name} selected executable matches uploaded package bytes`);
}

function packageFiles(directory, target) {
  return fs.readdirSync(directory).filter((name) => releaseAssetPattern[target.platform].test(name))
    .sort().map((name) => ({ name, sha256: sha256(path.join(directory, name)) }));
}

function options(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i += 2) {
    assert(/^--[a-z-]+$/.test(args[i]) && args[i + 1], 'named option and value required');
    parsed[args[i].slice(2)] = args[i + 1];
  }
  return parsed;
}

// @req OPS-ARCH-009 AC-8 OPS-ARCH-010 AC-8 OPS-ARCH-012 AC-4 OPS-ARCH-013 AC-9 IR-APP-013 AC-13
function validateSmoke(smoke, policy, target, sha, selectedChecksum) {
  assert.strictEqual(smoke.ok, true, 'package smoke must pass');
  assert.strictEqual(smoke.nativeOwner?.baseCommit, sha, 'package smoke owner commit SHA');
  validateNativeOwnerEvidence(smoke.nativeOwner);
  assert.strictEqual(smoke.nativeOwner?.selectedAppSha256, selectedChecksum,
    'direct selected executable checksum');
  assert.strictEqual(smoke.nativeOwner?.directExecutable, true, 'direct package executable smoke');
  const expectedKind = { win32: 'portable', darwin: 'app', linux: 'appimage' }[target.platform];
  assert.strictEqual(smoke.nativeOwner?.artifactKind, expectedKind,
    'required package kind is directly smoked');
  assert(smoke.nativeOwner?.runtime?.electronAbi, 'Electron ABI evidence');
  assert.strictEqual(smoke.nativeOwner?.runtime?.isolatedUserData, true, 'isolated profile evidence');
  assert.strictEqual(smoke.nativeOwner?.main?.writableOpenCount, 0, 'main SQLite writer boundary');
  assert.strictEqual(smoke.nativeOwner?.flow?.activeStatusSeen, true, 'active status sample');
  assert.strictEqual(smoke.nativeOwner?.flow?.cancelAccepted, true, 'active cancel sample');
  assert.strictEqual(smoke.nativeOwner?.flow?.closed, true, 'active close sample');
  assert.strictEqual(smoke.packagedCliStdio?.status, 'passed', 'packaged CLI smoke');
  assert.strictEqual(smoke.workerNative?.betterSqlite3?.state, 'loaded', 'SQLite native state');
  assert(smoke.workerNative.betterSqlite3.moduleVersion &&
    (smoke.workerNative.electronAbi || smoke.workerNative.nodeAbi),
  'SQLite module version and worker ABI evidence');
  assert(['loaded', 'native_unavailable'].includes(smoke.workerNative?.hnswlibNode?.state),
    'HNSW native state');
  assert.strictEqual(smoke.nativeOwner?.responsiveness?.workerMarker, true,
    'active maintenance worker marker');
  for (const kind of ['status', 'focus', 'close']) {
    const metric = smoke.nativeOwner.responsiveness.byKind?.[kind];
    assert(metric?.count > 0 && metric.p95 <= 250 && metric.p99 <= 500 && metric.max <= 1000,
      `${kind} responsiveness sample`);
  }
  assert(smoke.nativeOwner.responsiveness.cancelMs <= 1000, 'cancel responsiveness sample');
  assert(smoke.nativeOwner.responsiveness.heartbeatGaps?.length >= 2
    && smoke.nativeOwner.responsiveness.heartbeatGaps.every((gap) => gap >= 0 && gap <= 250),
  'main heartbeat sample');
  assert.strictEqual(policy.current?.platform, target.platform, 'smoke policy platform');
  assert.strictEqual(policy.current?.arch, target.arch, 'smoke policy architecture');
  assert(policy.releaseGating?.some((item) => item.platform === target.platform
    && item.arch === target.arch && item.status === 'smoked'), 'required platform smoke policy');
  const expectedBestEffort = ['darwin:x64', 'linux:arm64', 'win32:arm64'];
  assert(Array.isArray(policy.bestEffort) && policy.bestEffort.length === expectedBestEffort.length
    && policy.bestEffort.every((item) => item.status === 'skipped'
      && typeof item.reason === 'string' && item.reason.trim())
    && JSON.stringify(policy.bestEffort.map((item) => `${item.platform}:${item.arch}`).sort())
      === JSON.stringify(expectedBestEffort),
  'best-effort skipped reason reports');
}

function collect(input) {
  const target = targets.find((item) => item.platform === input.platform && item.arch === input.arch);
  assert(target && shaPattern.test(input.sha), 'required platform and exact commit SHA');
  assert(fs.existsSync(input.package) && fs.existsSync(input.selected), 'package and selected executable exist');
  const smoke = readJson(input.smoke);
  const policy = readJson(input.policy);
  const selectedChecksum = sha256(input.selected);
  validateSmoke(smoke, policy, target, input.sha, selectedChecksum);
  assertSelectedPackageChecksum(target, input.package, selectedChecksum);
  const packageName = path.basename(input.package);
  assert(!/[\\/]/.test(packageName), 'single package artifact name');
  const packages = packageFiles(input['package-dir'] || path.dirname(input.package), target);
  assert(packages.some((item) => item.name === packageName), 'direct smoked package is uploaded');
  fs.mkdirSync(input.out, { recursive: true });
  const manifest = {
    schema: 'doculight-release-evidence.v1', sha: input.sha,
    platform: target.platform, arch: target.arch, artifact: target.name,
    package: { name: packageName, sha256: sha256(input.package) },
    packages,
    selectedExecutableSha256: selectedChecksum,
    smokeSha256: sha256(input.smoke), policySha256: sha256(input.policy),
    abi: { electron: smoke.nativeOwner.runtime.electronAbi,
      worker: smoke.workerNative.electronAbi || smoke.workerNative.nodeAbi },
    native: { sqlite: smoke.workerNative.betterSqlite3.state,
      sqliteVersion: smoke.workerNative.betterSqlite3.moduleVersion,
      hnsw: smoke.workerNative.hnswlibNode.state,
      hnswVersion: smoke.workerNative.hnswlibNode.moduleVersion },
    profileIsolated: true, packagedCli: smoke.packagedCliStdio.status,
    responsiveness: smoke.nativeOwner.responsiveness.byKind
  };
  fs.copyFileSync(input.smoke, path.join(input.out, 'smoke.json'));
  fs.copyFileSync(input.policy, path.join(input.out, 'policy.json'));
  fs.writeFileSync(path.join(input.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function verify(input) {
  assert(shaPattern.test(input.sha), 'exact SHA required');
  const packageNames = new Set();
  for (const target of targets) {
    const dir = path.join(input.artifacts, `${target.name}-release-evidence`);
    const manifest = readJson(path.join(dir, 'manifest.json'));
    const smokePath = path.join(dir, 'smoke.json');
    const policyPath = path.join(dir, 'policy.json');
    assert.strictEqual(manifest.schema, 'doculight-release-evidence.v1', 'release report schema');
    assert.strictEqual(manifest.sha, input.sha, `${target.name} exact SHA`);
    assert.strictEqual(manifest.platform, target.platform, `${target.name} platform`);
    assert.strictEqual(manifest.arch, target.arch, `${target.name} architecture`);
    assert.strictEqual(manifest.artifact, target.name, `${target.name} unique artifact identity`);
    assert.strictEqual(path.basename(manifest.package?.name || ''), manifest.package?.name,
      `${target.name} package artifact basename`);
    const packageDir = path.join(input.artifacts, `${target.name}-artifacts`);
    const actualPackages = packageFiles(packageDir, target);
    assert.deepStrictEqual(actualPackages, manifest.packages, `${target.name} all package checksums`);
    assert(manifest.packages.some((item) => item.name === manifest.package.name
      && item.sha256 === manifest.package.sha256), `${target.name} direct package checksum`);
    for (const item of manifest.packages) {
      assert(!packageNames.has(item.name), 'package artifact name collision');
      packageNames.add(item.name);
    }
    assert.strictEqual(sha256(smokePath), manifest.smokeSha256, `${target.name} smoke checksum`);
    assert.strictEqual(sha256(policyPath), manifest.policySha256, `${target.name} policy checksum`);
    const packagePath = path.join(packageDir, manifest.package.name);
    assert.strictEqual(sha256(packagePath), manifest.package.sha256, `${target.name} package checksum`);
    assertSelectedPackageChecksum(target, packagePath, manifest.selectedExecutableSha256);
    const smoke = readJson(smokePath);
    validateSmoke(smoke, readJson(policyPath), target, input.sha, manifest.selectedExecutableSha256);
    const workerNative = smoke.workerNative;
    assert(manifest.abi?.electron && manifest.abi?.worker, `${target.name} ABI report`);
    assert.strictEqual(manifest.abi?.electron, smoke.nativeOwner.runtime.electronAbi,
      `${target.name} Electron ABI report`);
    assert.strictEqual(manifest.abi?.worker, workerNative.electronAbi || workerNative.nodeAbi,
      `${target.name} worker ABI report`);
    assert.strictEqual(manifest.native?.sqlite, workerNative.betterSqlite3.state,
      `${target.name} SQLite native report`);
    assert.strictEqual(manifest.native?.hnsw, workerNative.hnswlibNode.state,
      `${target.name} HNSW native report`);
    assert.strictEqual(manifest.native.sqliteVersion, workerNative.betterSqlite3.moduleVersion,
      `${target.name} SQLite version report`);
    assert.strictEqual(manifest.native.hnswVersion, workerNative.hnswlibNode.moduleVersion,
      `${target.name} HNSW version report`);
    assert.deepStrictEqual(manifest.responsiveness, smoke.nativeOwner.responsiveness.byKind,
      `${target.name} responsiveness report`);
    assert.strictEqual(manifest.profileIsolated, smoke.nativeOwner.runtime.isolatedUserData,
      `${target.name} isolated profile report`);
    assert.strictEqual(manifest.packagedCli, smoke.packagedCliStdio.status,
      `${target.name} packaged CLI report`);
  }
  return true;
}

if (require.main === module) {
  try {
    const command = process.argv[2];
    const input = options(process.argv.slice(3));
    if (command === 'collect') collect(input);
    else if (command === 'verify') verify(input);
    else throw new Error('collect or verify required');
    console.log(`release-evidence ${command}: passed`);
  } catch (error) {
    console.error(`release-evidence: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { collect, verify };
