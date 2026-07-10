'use strict';

const assert = require('assert');
const { getPackageSmokeLaunchArgs } = require('./package-smoke-launch-options');

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

console.log('test-package-smoke-launch-options: all assertions passed');
