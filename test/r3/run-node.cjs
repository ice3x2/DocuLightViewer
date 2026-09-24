'use strict';
const path = require('node:path');
const { sourceHash, validateRoot, runBoundedNode, PREPARE } = require('./runtime.cjs');

const cases = ['harness-self', 's04'];
const name = process.argv.length === 4 && process.argv[2] === '--case' ? process.argv[3] : '';
if (new Set(cases).size !== cases.length || !cases.includes(name)) {
  console.error(`SETUP_ERROR missing, unknown, or duplicate case; Usage: --case NAME; available: ${cases.join(', ')}`);
  process.exitCode = 2;
} else {
  const root = process.env.DOCULIGHT_R3_NODE_ROOT || '';
  const check = validateRoot(root, 'node', sourceHash());
  if (!check.ok || check.manifest.abi !== process.versions.modules) {
    console.error(`SETUP_ERROR ${check.reason || 'Node ABI changed'}; prepare: ${PREPARE}`);
    process.exitCode = 2;
  } else {
    const result = runBoundedNode(process.execPath, [path.join(root, 'test/r3/node-main.cjs'), '--case', name], {
      cwd: root,
      env: { ...process.env, DOCULIGHT_R3_NODE_ROOT: root, DOCULIGHT_R3_SOURCE_HASH: check.manifest.sourceHash },
      name
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.marker) console.error(result.marker);
    process.exitCode = result.exitCode;
  }
}
