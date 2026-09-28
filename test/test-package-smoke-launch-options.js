'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  getPackageSmokeLaunchArgs,
  getPackageSmokeCliStdioArgs
} = require('../src/main/package-smoke-launch-options');
const { selectPackageSmokeArtifact } = require('./helpers/package-smoke-artifact');

assert.deepStrictEqual(
  getPackageSmokeLaunchArgs('linux', { GITHUB_ACTIONS: 'true' }),
  ['--package-smoke', '--no-sandbox'],
  'GitHub Actions Linux smoke launch disables the unavailable SUID sandbox'
);
assert.deepStrictEqual(
  getPackageSmokeLaunchArgs('linux', { GITHUB_ACTIONS: 'false' }),
  ['--package-smoke'],
  'local Linux smoke launch keeps the sandbox enabled'
);
assert.deepStrictEqual(
  getPackageSmokeLaunchArgs('win32', { GITHUB_ACTIONS: 'true' }),
  ['--package-smoke'],
  'Windows smoke launch never receives a Linux sandbox flag'
);
assert.deepStrictEqual(
  getPackageSmokeCliStdioArgs('linux', { GITHUB_ACTIONS: 'true' }),
  ['--mcp-stdio', '--no-sandbox'],
  'GitHub Actions Linux CLI smoke launch disables the unavailable SUID sandbox'
);
assert.deepStrictEqual(
  getPackageSmokeCliStdioArgs('linux', { GITHUB_ACTIONS: 'false' }),
  ['--mcp-stdio'],
  'local Linux CLI smoke launch keeps the sandbox enabled'
);

// @req OPS-ARCH-009 AC-2 OPS-ARCH-010 AC-3 OPS-ARCH-013 AC-9
const workspace = path.resolve(__dirname, '..');
const portable = path.join(workspace, 'dist', 'DocuLight-Portable-1.0.6.exe');
assert.deepStrictEqual(
  selectPackageSmokeArtifact(['--app', portable, '--artifact-kind', 'portable'], 'win32', workspace),
  { appPath: portable, artifactKind: 'portable', unpackedNativeRoot: null },
  'explicit portable selection launches exactly that artifact and cannot borrow an unpacked native tree'
);
assert.throws(
  () => selectPackageSmokeArtifact(['--app', path.join(workspace, 'dist', 'win-unpacked', 'DocuLight.exe'), '--artifact-kind', 'portable'], 'win32', workspace),
  /portable artifact required/,
  'portable selection rejects an unpacked executable'
);
assert.throws(
  () => selectPackageSmokeArtifact(['--app', portable, '--artifact-kind', 'unpacked'], 'win32', workspace),
  /unpacked artifact required/,
  'unpacked selection rejects a portable executable'
);
assert.throws(
  () => selectPackageSmokeArtifact(['--app', portable], 'win32', workspace),
  /artifact-kind is required/,
  'explicit app selection requires an artifact kind'
);
assert.strictEqual(
  selectPackageSmokeArtifact([], 'win32', workspace).appPath,
  path.join(workspace, 'dist', 'win-unpacked', 'DocuLight.exe'),
  'no-argument smoke keeps unpacked compatibility'
);
const appImage = path.join(workspace, 'dist', 'DocuLight-1.0.6-x86_64.AppImage');
assert.deepStrictEqual(
  selectPackageSmokeArtifact(['--app', appImage, '--artifact-kind', 'appimage'], 'linux', workspace),
  { appPath: appImage, artifactKind: 'appimage', unpackedNativeRoot: null },
  'explicit Linux AppImage selection launches the selected artifact directly'
);
const extractedMac = path.join(workspace, 'tmp', 'extracted', 'DocuLight.app',
  'Contents', 'MacOS', 'DocuLight');
assert.deepStrictEqual(
  selectPackageSmokeArtifact(['--app', extractedMac, '--artifact-kind', 'app'], 'darwin', workspace),
  { appPath: extractedMac, artifactKind: 'app', unpackedNativeRoot: path.join(workspace,
    'tmp', 'extracted', 'DocuLight.app', 'Contents', 'Resources', 'app.asar.unpacked') },
  'explicit extracted macOS app selection derives native resources from that app'
);
assert.throws(() => selectPackageSmokeArtifact(['--app'], 'win32', workspace),
  /Unknown package smoke option/, 'missing --app value is rejected');
const missingPortable = path.join(workspace, 'dist', 'DocuLight-Portable-missing.exe');
const missingLaunch = spawnSync(process.execPath, [path.join(__dirname, 'package-smoke.js'),
  '--app', missingPortable, '--artifact-kind', 'portable'], {
  cwd: workspace, encoding: 'utf8', timeout: 5000, windowsHide: true
});
assert.strictEqual(missingLaunch.status, 1, 'missing selected artifact exits nonzero');
assert.match(`${missingLaunch.stdout}${missingLaunch.stderr}`, /packaged app exists at the expected packaged output path/,
  'missing selected artifact fails before any fallback to unpacked output');

console.log('test-package-smoke-launch-options: all assertions passed');
