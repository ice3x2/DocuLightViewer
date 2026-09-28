'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { collect, verify } = require('../scripts/release-evidence');

// @req OPS-ARCH-009 AC-8 OPS-ARCH-010 AC-8 OPS-ARCH-012 AC-4 OPS-ARCH-013 AC-9 IR-APP-013 AC-13
const sha = 'a'.repeat(40);
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-release-evidence-'));
const artifacts = path.join(fixture, 'artifacts');
const targets = [
  ['win32', 'x64', 'windows-x64', 'portable'],
  ['darwin', 'arm64', 'macos-arm64', 'app'],
  ['linux', 'x64', 'linux-x64', 'appimage']
];
const hash = 'b'.repeat(64);
const metrics = { samples: ['status', 'focus', 'close', 'cancel'].map((kind) => ({ kind, ms: 5 })),
  byKind: Object.fromEntries(['status', 'focus', 'close'].map((kind) =>
    [kind, { count: 1, p95: 5, p99: 5, max: 5 }])),
  cancelMs: 5, heartbeatGaps: [10, 10], workerMarker: true };

function smoke(platform, arch, selectedChecksum, kind) {
  return { ok: true, packagedCliStdio: { status: 'passed' },
    workerNative: { betterSqlite3: { state: 'loaded', moduleVersion: '12.11.1' },
      hnswlibNode: { state: 'native_unavailable', moduleVersion: '3.0.0' }, electronAbi: '123' },
    nativeOwner: { version: 'package-native-owner.v1', artifactKind: kind,
      directExecutable: true,
      baseCommit: sha, selectedAppSha256: selectedChecksum, sourceHash: hash,
      sourceHashScope: 'r3-source-files', sourceFileCount: 10, fixtureSha256: hash,
      runtime: { isPackaged: true, profile: 'default', isolatedUserData: true,
        electronAbi: '123' }, owner: { workerThreadId: 1, openCount: 2,
        ledgerOpenThreadId: 1, keywordOpenThreadId: 1 }, main: { writableOpenCount: 0 },
      flow: { saved: true, indexed: true, searchFound: true, opened: true, closed: true,
        activeStatusSeen: true, cancelAccepted: true, cancelledFileRetained: true,
        failedSaveRetained: true, retryableIntentPresent: true },
      lifecycle: { exited: true, exitCode: 0, appProcessGone: true,
        handleReleased: true, profileRemoved: true }, responsiveness: metrics } };
}

const crypto = require('crypto');
const checksum = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
try {
  for (const [platform, arch, name, kind] of targets) {
    const input = path.join(fixture, name);
    const evidence = path.join(artifacts, `${name}-release-evidence`);
    const packages = path.join(artifacts, `${name}-artifacts`);
    fs.mkdirSync(input);
    fs.mkdirSync(packages, { recursive: true });
    const selected = path.join(input, `selected-${kind}`);
    const extension = platform === 'win32' ? 'exe' : platform === 'darwin' ? 'zip' : 'AppImage';
    const prefix = platform === 'win32' ? 'DocuLight-Portable' : 'DocuLight';
    const packagePath = path.join(packages, `${prefix}-${name}.${extension}`);
    fs.writeFileSync(selected, `selected ${name}`);
    if (platform === 'darwin') {
      execFileSync('python', ['-c',
        'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); z.write(sys.argv[2],"DocuLight.app/Contents/MacOS/DocuLight"); z.close()',
        packagePath, selected]);
    } else {
      fs.copyFileSync(selected, packagePath);
    }
    const smokePath = path.join(input, 'smoke.json');
    const policyPath = path.join(input, 'policy.json');
    fs.writeFileSync(smokePath, JSON.stringify(smoke(platform, arch, checksum(selected), kind)));
    fs.writeFileSync(policyPath, JSON.stringify({ current: { platform, arch },
      releaseGating: [{ platform, arch, status: 'smoked' }],
      bestEffort: [
        { platform: 'win32', arch: 'arm64', status: 'skipped', reason: 'no arm64 smoke runner' },
        { platform: 'darwin', arch: 'x64', status: 'skipped', reason: 'no Intel smoke runner' },
        { platform: 'linux', arch: 'arm64', status: 'skipped', reason: 'no arm64 smoke runner' }
      ] }));
    const report = collect({ platform, arch, sha, package: packagePath, selected,
      smoke: smokePath, policy: policyPath, out: evidence });
    assert.strictEqual(report.native.sqliteVersion, '12.11.1', 'native module version recorded');
  }
  const input = { sha, artifacts };
  assert.strictEqual(verify(input), true, 'all three exact SHA/package/smoke reports pass');
  const windows = path.join(artifacts, 'windows-x64-release-evidence');
  const windowsManifest = path.join(windows, 'manifest.json');
  const original = fs.readFileSync(windowsManifest);
  const change = (mutate) => {
    const report = JSON.parse(original);
    mutate(report);
    fs.writeFileSync(windowsManifest, JSON.stringify(report));
    assert.throws(() => verify(input));
    fs.writeFileSync(windowsManifest, original);
  };
  change((report) => { report.sha = 'c'.repeat(40); });
  change((report) => { report.package.sha256 = hash; });
  change((report) => { report.package.name = 'DocuLight-macos-arm64.zip'; });
  change((report) => { report.artifact = 'macos-arm64'; });
  change((report) => { report.abi.electron = '999'; });
  change((report) => { report.abi.worker = '999'; });
  change((report) => { report.native.hnsw = 'loaded'; });
  change((report) => { report.responsiveness.status.max = 0; });
  for (const name of ['windows-x64', 'linux-x64']) {
    const dir = path.join(artifacts, `${name}-release-evidence`);
    const manifestPath = path.join(dir, 'manifest.json');
    const smokePath = path.join(dir, 'smoke.json');
    const oldManifest = fs.readFileSync(manifestPath);
    const oldSmoke = fs.readFileSync(smokePath);
    const forgedSmoke = JSON.parse(oldSmoke);
    forgedSmoke.nativeOwner.selectedAppSha256 = hash;
    fs.writeFileSync(smokePath, JSON.stringify(forgedSmoke));
    const forgedManifest = JSON.parse(oldManifest);
    forgedManifest.selectedExecutableSha256 = hash;
    forgedManifest.smokeSha256 = checksum(smokePath);
    fs.writeFileSync(manifestPath, JSON.stringify(forgedManifest));
    assert.throws(() => verify(input), `${name} selected executable must match uploaded package`);
    fs.writeFileSync(manifestPath, oldManifest);
    fs.writeFileSync(smokePath, oldSmoke);
  }
  const macManifestPath = path.join(artifacts, 'macos-arm64-release-evidence', 'manifest.json');
  const macPackagePath = path.join(artifacts, 'macos-arm64-artifacts', 'DocuLight-macos-arm64.zip');
  const oldMacManifest = fs.readFileSync(macManifestPath);
  const oldMacPackage = fs.readFileSync(macPackagePath);
  execFileSync('python', ['-c',
    'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("DocuLight.app/Contents/MacOS/DocuLight",b"different executable"); z.close()',
    macPackagePath]);
  const forgedMacManifest = JSON.parse(oldMacManifest);
  forgedMacManifest.package.sha256 = checksum(macPackagePath);
  forgedMacManifest.packages[0].sha256 = forgedMacManifest.package.sha256;
  fs.writeFileSync(macManifestPath, JSON.stringify(forgedMacManifest));
  assert.throws(() => verify(input), 'macOS selected executable must be inside uploaded ZIP');
  fs.writeFileSync(macManifestPath, oldMacManifest);
  fs.writeFileSync(macPackagePath, oldMacPackage);
  const windowsPolicy = path.join(windows, 'policy.json');
  const oldPolicy = fs.readFileSync(windowsPolicy);
  fs.writeFileSync(windowsPolicy, JSON.stringify({ ...JSON.parse(oldPolicy), bestEffort: [] }));
  const emptyBestEffort = JSON.parse(original);
  emptyBestEffort.policySha256 = checksum(windowsPolicy);
  fs.writeFileSync(windowsManifest, JSON.stringify(emptyBestEffort));
  assert.throws(() => verify(input), 'empty best-effort skipped report fails');
  fs.writeFileSync(windowsManifest, original);
  fs.writeFileSync(windowsPolicy, oldPolicy);
  const changePolicy = (mutate, message) => {
    const policy = JSON.parse(oldPolicy);
    mutate(policy);
    fs.writeFileSync(windowsPolicy, JSON.stringify(policy));
    const report = JSON.parse(original);
    report.policySha256 = checksum(windowsPolicy);
    fs.writeFileSync(windowsManifest, JSON.stringify(report));
    assert.throws(() => verify(input), message);
    fs.writeFileSync(windowsManifest, original);
    fs.writeFileSync(windowsPolicy, oldPolicy);
  };
  changePolicy((policy) => { policy.bestEffort.pop(); },
    'missing Linux arm64 best-effort row fails');
  changePolicy((policy) => { policy.bestEffort[1].arch = 'arm64'; },
    'wrong macOS architecture fails');
  changePolicy((policy) => { policy.bestEffort[0].status = 'built_skipped_smoke'; },
    'best-effort smoke status must be explicitly skipped');
  const unexpected = path.join(artifacts, 'windows-x64-artifacts', 'DocuLight-Setup-extra.exe');
  fs.writeFileSync(unexpected, 'unreported release package');
  assert.throws(() => verify(input), 'unreported uploaded package fails');
  fs.unlinkSync(unexpected);
  const windowsSmoke = path.join(windows, 'smoke.json');
  const originalSmoke = fs.readFileSync(windowsSmoke);
  const wrongKind = JSON.parse(originalSmoke);
  wrongKind.nativeOwner.artifactKind = 'unpacked';
  fs.writeFileSync(windowsSmoke, JSON.stringify(wrongKind));
  const wrongKindManifest = JSON.parse(original);
  wrongKindManifest.smokeSha256 = checksum(windowsSmoke);
  fs.writeFileSync(windowsManifest, JSON.stringify(wrongKindManifest));
  assert.throws(() => verify(input), 'unpacked smoke cannot stand in for direct portable');
  fs.writeFileSync(windowsManifest, original);
  fs.writeFileSync(windowsSmoke, originalSmoke);
  fs.unlinkSync(windowsSmoke);
  assert.throws(() => verify(input), 'missing smoke JSON fails');
  fs.writeFileSync(windowsSmoke, originalSmoke);
  fs.rmSync(path.join(artifacts, 'linux-x64-release-evidence'), { recursive: true });
  assert.throws(() => verify(input), 'missing required platform artifact fails');
  console.log('test-release-evidence-contract: all assertions passed');
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
