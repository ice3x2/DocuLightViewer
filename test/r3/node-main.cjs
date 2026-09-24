'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');
const { run } = require('./dispatch.cjs');
const { createFixture } = require('./fixtures.cjs');
const { validateRoot, loadCase, PREPARE } = require('./runtime.cjs');

const name = process.argv.length === 4 && process.argv[2] === '--case' ? process.argv[3] : '';
const root = process.env.DOCULIGHT_R3_NODE_ROOT || '';
let fixture;
let selectedCase;
run(['harness-self', 's04', 's05', 's06', 's07', 's08'].map(name => ({ name, async run(context) { return selectedCase.run(context); } })), name, {
  write: line => console.error(line),
  async setup() {
    const check = validateRoot(root, 'node', process.env.DOCULIGHT_R3_SOURCE_HASH);
    if (!check.ok) throw new Error(`${check.reason}; prepare: ${PREPARE}`);
    if (check.manifest.abi !== process.versions.modules) throw new Error('Node ABI changed; prepare runtime again');
    selectedCase = loadCase(root, name);
    const Database = createRequire(path.join(root, 'package.json'))('better-sqlite3');
    fixture = createFixture({ Database });
    return { fixture };
  },
  async cleanup() { if (fixture) fixture.close(); }
}).then(result => { process.exitCode = result.exitCode; });
