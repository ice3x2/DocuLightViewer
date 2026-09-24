'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const sourceRoot = path.resolve(__dirname, '../..');
const PREPARE = 'node test/r3/prepare-runtime.cjs --node-root <temp-node> --electron-root <temp-electron>';

function sourceFiles() {
  const tracked = execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: sourceRoot }).toString('utf8').split('\0');
  const harness = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', 'src', 'scripts', 'test', 'assets', 'build'], { cwd: sourceRoot }).toString('utf8').split('\0');
  return [...new Set([...tracked, ...harness])].filter(Boolean)
    .filter(file => !file.startsWith('docs/analysis/') && !file.startsWith('docs/plan/'))
    .filter(file => fs.existsSync(path.join(sourceRoot, file)) && fs.lstatSync(path.join(sourceRoot, file)).isFile())
    .sort();
}

function sourceHash(files = sourceFiles()) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file.replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(sourceRoot, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function dependencyHash(root = sourceRoot) {
  const hash = crypto.createHash('sha256');
  for (const file of ['package.json', 'package-lock.json']) hash.update(fs.readFileSync(path.join(root, file)));
  hash.update(`${process.platform}:${process.arch}:${process.version}`);
  return hash.digest('hex');
}

function refreshSnapshot(root, runtime, files, hash, deps) {
  const manifestPath = path.join(root, 'r3-manifest.json');
  if (!fs.existsSync(manifestPath)) return false;
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch { return false; }
  const installedDeps = manifest.dependencyHash || dependencyHash(root);
  if (manifest.runtime !== runtime || installedDeps !== deps || !fs.existsSync(path.join(root, 'node_modules'))) return false;
  for (const file of manifest.files || []) {
    if (files.includes(file) || file.startsWith('node_modules/') || file.includes('..')) continue;
    const target = path.join(root, file);
    if (fs.existsSync(target)) fs.rmSync(target);
  }
  for (const file of files) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, file), target);
  }
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, sourceHash: hash, snapshotSha256: hash, dependencyHash: deps, files }, null, 2));
  return true;
}

function validateRoot(root, runtime, hash) {
  if (!root || !path.isAbsolute(root)) return { ok: false, reason: 'root missing', prepare: PREPARE };
  const manifestPath = path.join(root, 'r3-manifest.json');
  if (!fs.existsSync(manifestPath)) return { ok: false, reason: 'manifest missing', prepare: PREPARE };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch { return { ok: false, reason: 'manifest invalid', prepare: PREPARE }; }
  if (manifest.sourceHash !== hash || manifest.runtime !== runtime) return { ok: false, reason: 'manifest stale', prepare: PREPARE };
  return { ok: true, manifest };
}

function electronAppEnv(env) {
  const childEnv = { ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  return childEnv;
}

function safeTempRoot(candidate) {
  if (!candidate || !path.isAbsolute(candidate)) return false;
  const temp = fs.realpathSync.native(require('node:os').tmpdir());
  let existing = path.resolve(candidate);
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  if (!fs.existsSync(existing)) return false;
  const canonical = path.resolve(fs.realpathSync.native(existing), path.relative(existing, path.resolve(candidate)));
  const relative = path.relative(temp, canonical);
  return Boolean(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function loadCase(root, name) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error('invalid case name');
  return require(path.join(root, 'test', 'r3', 'cases', `${name}.cjs`));
}

function validElectronPass(child, name) {
  if (child.status !== 0) return false;
  const terminal = String(child.stderr || '').trim().split(/\r?\n/).at(-1);
  const match = /^PASS case=([a-z0-9-]+) assertions=([1-9][0-9]*)$/.exec(terminal);
  return Boolean(match && match[1] === name);
}

function electronExitCode(child, name) {
  if (validElectronPass(child, name)) return 0;
  const terminal = String(child.stderr || '').trim().split(/\r?\n/).at(-1);
  if (child.status === 1 && terminal?.startsWith(`ASSERTION_FAIL case=${name} `)) return 1;
  return 2;
}

function runBoundedNode(executable, args, { cwd, env = process.env, timeout = 60000, name }) {
  const child = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout });
  const exitCode = electronExitCode(child, name);
  const marker = child.error?.code === 'ETIMEDOUT'
    ? 'SETUP_ERROR Node case deadline exceeded'
    : exitCode === 2 ? 'SETUP_ERROR Node case did not finish with an exact positive PASS marker' : '';
  return { ...child, exitCode, marker };
}

module.exports = { sourceRoot, sourceFiles, sourceHash, dependencyHash, refreshSnapshot, validateRoot, PREPARE, electronAppEnv, safeTempRoot, loadCase, validElectronPass, electronExitCode, runBoundedNode };
