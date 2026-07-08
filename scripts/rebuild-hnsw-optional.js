'use strict';

const { spawnSync } = require('child_process');

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npmCommand, ['rebuild', 'hnswlib-node'], {
  stdio: 'inherit',
  shell: false
});

if (result.status !== 0) {
  console.warn('[doculight] Optional hnswlib-node rebuild failed; semantic HNSW will use native_unavailable degraded mode until the native toolchain is available.');
}
