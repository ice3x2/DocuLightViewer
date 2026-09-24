'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sourceRoot, sourceFiles, sourceHash, dependencyHash, refreshSnapshot, safeTempRoot, PREPARE } = require('./runtime.cjs');

const args = process.argv.slice(2);
const nodeRoot = args.length === 4 && args[0] === '--node-root' ? args[1] : '';
const electronRoot = args.length === 4 && args[2] === '--electron-root' ? args[3] : '';
if (!safeTempRoot(nodeRoot) || !safeTempRoot(electronRoot) || path.resolve(nodeRoot) === path.resolve(electronRoot)) {
  console.error(`SETUP_ERROR use distinct absolute OS-temp roots; ${PREPARE}`);
  process.exitCode = 2;
} else {
  try {
    const files = sourceFiles();
    const hash = sourceHash(files);
    const deps = dependencyHash();
    for (const [runtime, root] of [['node', nodeRoot], ['electron', electronRoot]]) {
      const reused = fs.existsSync(root) && fs.readdirSync(root).length > 0;
      if (reused && !refreshSnapshot(root, runtime, files, hash, deps)) throw new Error(`${runtime} dependency/runtime changed; choose fresh empty OS-temp roots`);
      if (!reused) {
        fs.mkdirSync(root, { recursive: true });
        for (const file of files) {
          const destination = path.join(root, file);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.copyFileSync(path.join(sourceRoot, file), destination);
        }
        const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        command(npm, ['ci', '--ignore-scripts'], root);
        if (runtime === 'node') command(npm, ['rebuild', 'better-sqlite3'], root);
      }
      if (runtime === 'electron' && !reused) {
        const installedElectron = path.join(root, 'node_modules/electron');
        const sourceElectron = path.join(sourceRoot, 'node_modules/electron');
        if (!fs.existsSync(path.join(installedElectron, 'path.txt'))) {
          const install = spawnSync(process.execPath, [path.join(installedElectron, 'install.js')], { cwd: root, stdio: 'inherit' });
          if (!fs.existsSync(path.join(installedElectron, 'path.txt')) && fs.existsSync(path.join(sourceElectron, 'path.txt'))) {
            const expected = require(path.join(installedElectron, 'package.json')).version;
            const sourceVersion = require(path.join(sourceElectron, 'package.json')).version;
            if (expected !== sourceVersion) throw new Error('cached Electron version differs from lockfile');
            fs.cpSync(path.join(sourceElectron, 'dist'), path.join(installedElectron, 'dist'), { recursive: true });
            fs.copyFileSync(path.join(sourceElectron, 'path.txt'), path.join(installedElectron, 'path.txt'));
            console.error('Electron installer unavailable; restored matching executable from verified local package cache');
          } else if (!fs.existsSync(path.join(installedElectron, 'path.txt'))) throw new Error('Electron executable installation failed');
        }
        command(process.execPath, ['scripts/rebuild-electron-native.js'], root);
      }
      const abi = runtime === 'node' ? process.versions.modules : probeElectron(root);
      probeSqlite(root, runtime);
      fs.writeFileSync(path.join(root, 'r3-manifest.json'), JSON.stringify({
        runtime, sourceHash: hash, snapshotSha256: hash, dependencyHash: deps, files, abi,
        nodeVersion: process.version,
        electronVersion: require(path.join(root, 'node_modules/electron/package.json')).version,
        platform: process.platform, arch: process.arch
      }, null, 2));
      console.log(`PREPARED runtime=${runtime} root=${root} sourceHash=${hash} abi=${abi}`);
    }
  } catch (error) {
    console.error(`SETUP_ERROR ${error.message}`);
    process.exitCode = 2;
  }
}

function command(file, commandArgs, cwd) {
  const child = spawnSync(file, commandArgs, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && file.endsWith('.cmd') });
  if (child.status !== 0) throw new Error(`${file} ${commandArgs.join(' ')} failed (${child.status ?? child.error?.message})`);
}

function probeElectron(root) {
  const executable = require(path.join(root, 'node_modules/electron'));
  const child = spawnSync(executable, ['-p', 'process.versions.modules'], {
    cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8'
  });
  if (child.status !== 0) throw new Error(`Electron ABI probe failed (${child.status})`);
  return child.stdout.trim();
}

function probeSqlite(root, runtime) {
  const code = "const Database=require('better-sqlite3');const db=new Database(':memory:');if(db.prepare('select 1 as x').get().x!==1)process.exit(1);db.close()";
  if (runtime === 'node') command(process.execPath, ['-e', code], root);
  else {
    const executable = require(path.join(root, 'node_modules/electron'));
    const child = spawnSync(executable, ['-e', code], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
    if (child.status !== 0) throw new Error('Electron SQLite ABI probe failed');
  }
}
