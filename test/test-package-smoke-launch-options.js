'use strict';

const assert = require('assert');
const {
  getPackageSmokeLaunchArgs,
  getPackageSmokeCliStdioArgs
} = require('../src/main/package-smoke-launch-options');

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

console.log('test-package-smoke-launch-options: all assertions passed');
