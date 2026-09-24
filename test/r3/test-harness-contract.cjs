'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { run } = require('./dispatch.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFixture } = require('./fixtures.cjs');
const { validateRoot, electronAppEnv, refreshSnapshot, sourceFiles, safeTempRoot, loadCase, validElectronPass, electronExitCode, runBoundedNode } = require('./runtime.cjs');
const { spawnSync } = require('node:child_process');

const cases = [
  { name: 'harness-self', async run(context) { context.assert(true); } }
];

test('missing and unknown names print usage and fail setup', async () => {
  for (const name of ['', 'absent']) {
    const lines = [];
    const result = await run(cases, name, { write: line => lines.push(line) });
    assert.equal(result.exitCode, 2);
    assert.match(lines.join('\n'), /SETUP_ERROR.*harness-self/);
  }
});

test('duplicate registration fails setup before any case runs', async () => {
  let called = false;
  const lines = [];
  const result = await run([...cases, { name: 'harness-self', run() { called = true; } }], 'harness-self', { write: line => lines.push(line) });
  assert.equal(result.exitCode, 2);
  assert.equal(called, false);
  assert.match(lines.join('\n'), /SETUP_ERROR.*duplicate/);
});

test('setup and assertion failures carry different terminal markers', async () => {
  for (const [failure, code, marker] of [
    [new Error('fixture failed'), 2, 'SETUP_ERROR'],
    [new assert.AssertionError({ message: 'behavior failed' }), 1, 'ASSERTION_FAIL']
  ]) {
    const lines = [];
    const result = await run([{ name: 'case', async run() { throw failure; } }], 'case', { write: line => lines.push(line) });
    assert.equal(result.exitCode, code);
    assert.match(lines.at(-1), new RegExp(marker));
  }
});

test('focused success reports positive assertions and PASS last', async () => {
  const lines = [];
  const result = await run(cases, 'harness-self', { write: line => lines.push(line) });
  assert.equal(result.exitCode, 0);
  assert.equal(result.assertions, 1);
  assert.match(lines.at(-1), /PASS.*assertions=1/);
});

test('fixture owns real Markdown and SQLite and cleans only its temp directory', async () => {
  const neighbor = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-neighbor-'));
  const sentinel = path.join(neighbor, 'keep');
  fs.writeFileSync(sentinel, 'keep');
  const fixture = createFixture({ Database: require('better-sqlite3') });
  try {
    assert.ok(fixture, 'fixture must be created');
    assert.ok(fixture.root.startsWith(os.tmpdir()));
    assert.equal(fs.readFileSync(fixture.markdownPath, 'utf8'), '# R3 fixture\n');
    assert.equal(fixture.db.prepare('select 1 as value').get().value, 1);
  } finally {
    if (fixture) fixture.close();
    if (fixture) assert.equal(fs.existsSync(fixture.root), false);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
    fs.rmSync(neighbor, { recursive: true });
  }
});

test('root preflight rejects missing and stale manifest without loading native modules', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-preflight-'));
  try {
    assert.equal(validateRoot('', 'node', 'source-hash').ok, false);
    assert.equal(validateRoot(root, 'node', 'source-hash').ok, false);
    fs.writeFileSync(path.join(root, 'r3-manifest.json'), JSON.stringify({ sourceHash: 'old', runtime: 'node' }));
    assert.equal(validateRoot(root, 'node', 'source-hash').ok, false);
    fs.writeFileSync(path.join(root, 'r3-manifest.json'), JSON.stringify({ sourceHash: 'source-hash', runtime: 'node' }));
    assert.equal(validateRoot(root, 'node', 'source-hash').ok, true);
    assert.equal(validateRoot(root, 'electron', 'source-hash').ok, false);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('CLI rejects unknown and missing names with available names', () => {
  for (const [file, flag] of [['run-node.cjs', '--case'], ['run-electron.cjs', '--scenario']]) {
    for (const args of [[], [flag, 'absent']]) {
      const result = spawnSync(process.execPath, [path.join(__dirname, file), ...args], { encoding: 'utf8' });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /SETUP_ERROR.*available: harness-self/);
    }
  }
});

test('prepare requires two distinct absolute temporary roots', () => {
  for (const args of [[], ['--node-root', '.', '--electron-root', '.']]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'prepare-runtime.cjs'), ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /SETUP_ERROR.*--node-root.*--electron-root/);
  }
});

test('cleanup failure overrides success and cannot leave PASS terminal marker', async () => {
  const lines = [];
  const result = await run(cases, 'harness-self', {
    write: line => lines.push(line),
    async cleanup() { throw new Error('close failed'); }
  });
  assert.equal(result.exitCode, 2);
  assert.match(lines.at(-1), /^SETUP_ERROR cleanup/);
  assert.equal(lines.some(line => line.startsWith('PASS')), false);
});

test('Electron app launch removes inherited run-as-node mode', () => {
  const env = electronAppEnv({ ELECTRON_RUN_AS_NODE: '1', OTHER: 'kept' });
  assert.equal(Object.hasOwn(env, 'ELECTRON_RUN_AS_NODE'), false);
  assert.equal(env.OTHER, 'kept');
});

test('source-only refresh keeps dependency install and updates snapshot manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-refresh-'));
  try {
    fs.mkdirSync(path.join(root, 'node_modules'));
    const marker = path.join(root, 'node_modules', 'install-marker');
    fs.writeFileSync(marker, 'installed');
    const before = fs.statSync(marker).mtimeMs;
    fs.writeFileSync(path.join(root, 'package.json'), 'old source');
    fs.writeFileSync(path.join(root, 'r3-manifest.json'), JSON.stringify({ runtime: 'node', sourceHash: 'old', dependencyHash: 'same', abi: '137', files: ['package.json'] }));
    assert.equal(refreshSnapshot(root, 'node', ['package.json'], 'new', 'same'), true);
    assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), fs.readFileSync(path.join(__dirname, '../..', 'package.json'), 'utf8'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'r3-manifest.json'), 'utf8')).sourceHash, 'new');
    assert.equal(fs.statSync(marker).mtimeMs, before);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'installed');
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('snapshot includes untracked product source and preserves unrelated private files', () => {
  const name = `r3-probe-${process.pid}-${Date.now()}.js`;
  const product = path.join(__dirname, '../..', 'src/main', name);
  const privateName = `r3-private-${process.pid}-${Date.now()}.txt`;
  const privatePath = path.join(__dirname, '../..', privateName);
  let productCreated = false;
  let privateCreated = false;
  try {
    fs.writeFileSync(product, 'product', { flag: 'wx' });
    productCreated = true;
    fs.writeFileSync(privatePath, 'private', { flag: 'wx' });
    privateCreated = true;
    assert.equal(sourceFiles().includes(`src/main/${name}`), true);
    assert.equal(sourceFiles().includes(privateName), false);
    assert.equal(fs.readFileSync(privatePath, 'utf8'), 'private');
    assert.equal(sourceFiles().includes('test/r3/cases/harness-self.cjs'), true);
  } finally {
    if (productCreated) fs.rmSync(product);
    if (privateCreated) fs.rmSync(privatePath);
  }
});

test('Electron launcher accepts only exact positive terminal PASS for selected scenario', () => {
  for (const stderr of ['', 'PASS case=harness-self assertions=0', 'PASS case=other assertions=2', 'PASS case=harness-self assertions=2\nextra']) {
    assert.equal(validElectronPass({ status: 0, stderr }, 'harness-self'), false);
  }
  assert.equal(validElectronPass({ status: 0, stderr: 'PASS case=harness-self assertions=2\n' }, 'harness-self'), true);
});

test('Electron child exit one counts as assertion only with its assertion marker', () => {
  assert.equal(electronExitCode({ status: 1, stderr: 'Error: native load failed' }, 'harness-self'), 2);
  assert.equal(electronExitCode({ status: 1, stderr: 'ASSERTION_FAIL case=harness-self assertions=0 behavior failed\n' }, 'harness-self'), 1);
  assert.equal(electronExitCode({ status: 0, stderr: 'PASS case=harness-self assertions=3\n' }, 'harness-self'), 0);
});

test('OS-temp root validation rejects an existing junction or symlink outside temp', () => {
  const outside = fs.mkdtempSync(path.join(__dirname, '../..', 'src/main/r3-outside-'));
  const link = path.join(os.tmpdir(), `r3-link-${process.pid}-${Date.now()}`);
  let linkCreated = false;
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    linkCreated = true;
    assert.equal(safeTempRoot(link), false);
    assert.equal(safeTempRoot(path.join(link, 'nested')), false);
    assert.equal(fs.existsSync(outside), true);
  } finally {
    if (linkCreated) fs.rmSync(link);
    fs.rmSync(outside, { recursive: true });
  }
});

test('selected case module resolves dependencies from isolated snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-case-root-'));
  try {
    const caseDir = path.join(root, 'test/r3/cases');
    const depDir = path.join(root, 'node_modules/root-only-dep');
    fs.mkdirSync(caseDir, { recursive: true });
    fs.mkdirSync(depDir, { recursive: true });
    fs.writeFileSync(path.join(caseDir, 'identity.cjs'), "module.exports={name:'identity',value:require('root-only-dep')};");
    fs.writeFileSync(path.join(depDir, 'index.js'), "module.exports='isolated';");
    assert.equal(loadCase(root, 'identity').value, 'isolated');
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('Node child with a live hung case times out as SETUP_ERROR', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-hang-case-'));
  try {
    const file = path.join(root, 'hung-case.cjs');
    fs.writeFileSync(file, "setInterval(() => {}, 1000);");
    const result = runBoundedNode(process.execPath, [file], { cwd: root, timeout: 150, name: 'hung-case' });
    assert.equal(result.exitCode, 2);
    assert.match(result.marker, /^SETUP_ERROR/);
  } finally { fs.rmSync(root, { recursive: true }); }
});
