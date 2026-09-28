'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Module = require('module');

const root = path.resolve(__dirname, '..');
const reportPath = path.join(root, 'docs', 'analysis', '2026-09-29-s30-native-abi-negative.json');
const nativePackage = path.join(root, 'dist', 'win-unpacked', 'resources',
  'app.asar.unpacked', 'node_modules', 'better-sqlite3');

if (process.argv[2] === '--probe') {
  process.env.NODE_PATH = path.join(root, 'node_modules');
  Module._initPaths();
  try {
    const Database = require(nativePackage);
    const db = new Database(':memory:');
    db.close();
    process.stderr.write('NATIVE_ABI_UNEXPECTED_SUCCESS\n');
    process.exitCode = 2;
  } catch (error) {
    const versions = [...String(error.message).matchAll(/NODE_MODULE_VERSION (\d+)/g)]
      .map(match => match[1]);
    if (versions.length >= 2 && versions[1] === process.versions.modules) {
      process.stderr.write(`NODE_MODULE_VERSION_MISMATCH packaged=${versions[0]} host=${versions[1]}\n`);
      process.exitCode = 1;
    } else {
      process.stderr.write(`NATIVE_ABI_OTHER_ERROR code=${/^[A-Z0-9_]+$/.test(error.code || '')
        ? error.code : 'UNKNOWN'}\n`);
      process.exitCode = 2;
    }
  }
} else {
  assert.strictEqual(process.platform, 'win32', 'Windows packaged ABI negative control');
  assert(fs.existsSync(nativePackage), 'packaged native package exists');
  const child = spawnSync(process.execPath, [__filename, '--probe'], {
    cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true
  });
  assert.strictEqual(child.status, 1, 'Node host rejects Electron ABI native module');
  assert.strictEqual(child.stdout, '', 'negative control writes no stdout');
  assert.match(child.stderr, /^NODE_MODULE_VERSION_MISMATCH packaged=\d+ host=\d+\r?\n$/,
    'controlled raw stderr records bounded ABI mismatch without local paths');
  const report = {
    version: 'package-native-abi-negative.v1',
    command: 'node test/test-package-native-abi-negative.js --probe',
    exitCode: child.status,
    rawStderrRedacted: child.stderr.trim(),
    nodeHostAbi: process.versions.modules,
    outcome: 'expected-negative-control'
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log('test-package-native-abi-negative: expected mismatch recorded');
}
