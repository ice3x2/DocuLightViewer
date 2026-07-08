'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const nodeCommand = process.execPath;

function runElectronRebuild() {
  const scriptPath = path.join(root, 'scripts', 'rebuild-electron-native.js');
  const result = spawnSync(nodeCommand, [scriptPath], {
    cwd: root,
    stdio: 'inherit',
    shell: false
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function currentPlatformDestination() {
  if (process.platform === 'win32') {
    return process.arch === 'arm64'
      ? path.join(root, 'dist', 'win-arm64-unpacked', 'resources', 'app.asar.unpacked')
      : path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar.unpacked');
  }
  if (process.platform === 'darwin') {
    return process.arch === 'arm64'
      ? path.join(root, 'dist', 'mac-arm64', 'DocuLight.app', 'Contents', 'Resources', 'app.asar.unpacked')
      : path.join(root, 'dist', 'mac', 'DocuLight.app', 'Contents', 'Resources', 'app.asar.unpacked');
  }
  return path.join(root, 'dist', 'linux-unpacked', 'resources', 'app.asar.unpacked');
}

function copyNativeModule(packageName, relativeNativePath, { optional = false } = {}) {
  const source = path.join(root, 'node_modules', packageName, relativeNativePath);
  const destinationRoot = currentPlatformDestination();
  const destination = path.join(destinationRoot, 'node_modules', packageName, relativeNativePath);
  if (!fs.existsSync(destinationRoot)) {
    console.log(`[doculight] Packaged app directory not found for ${process.platform}/${process.arch}; skipping native repair.`);
    return;
  }
  if (!fs.existsSync(source)) {
    if (optional) {
      console.warn(`[doculight] Optional ${packageName} native module not found after Electron rebuild; package will use native_unavailable degraded mode.`);
      return;
    }
    throw new Error(`Required native module source not found: ${source}`);
  }
  if (!fs.existsSync(destination)) {
    if (optional) {
      console.warn(`[doculight] Optional packaged ${packageName} native target not found; package will use native_unavailable degraded mode.`);
      return;
    }
    throw new Error(`Required packaged native module target not found: ${destination}`);
  }
  fs.copyFileSync(source, destination);
  console.log(`[doculight] Repaired packaged ${packageName} native module: ${path.relative(root, destination)}`);
}

function main() {
  runElectronRebuild();
  copyNativeModule('better-sqlite3', path.join('build', 'Release', 'better_sqlite3.node'));
  copyNativeModule('hnswlib-node', path.join('build', 'Release', 'hnswlib-node.node'), { optional: true });
  console.log('[doculight] Packaged native repair completed.');
}

try {
  main();
} catch (err) {
  console.error('[doculight] Packaged native repair failed:');
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
}
