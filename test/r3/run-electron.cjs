'use strict';
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { sourceHash, validateRoot, PREPARE, electronAppEnv, electronExitCode } = require('./runtime.cjs');

const cases = [require('./cases/harness-self.cjs'), require('./cases/s06.cjs')];
const name = process.argv.length === 4 && process.argv[2] === '--scenario' ? process.argv[3] : '';
const names = cases.map(item => item.name);
if (new Set(names).size !== names.length || !names.includes(name)) {
  console.error(`SETUP_ERROR missing, unknown, or duplicate scenario; Usage: --scenario NAME; available: ${names.join(', ')}`);
  process.exitCode = 2;
} else {
  const root = process.env.DOCULIGHT_R3_ELECTRON_ROOT || '';
  const check = validateRoot(root, 'electron', sourceHash());
  if (!check.ok) {
    console.error(`SETUP_ERROR ${check.reason}; prepare: ${PREPARE}`);
    process.exitCode = 2;
  } else {
    try {
      const executable = createRequire(path.join(root, 'package.json'))('electron');
      const child = spawnSync(executable, [path.join(root, 'test/r3/electron-main.cjs'), '--scenario', name], {
        cwd: root,
        env: electronAppEnv({ ...process.env, DOCULIGHT_R3_ELECTRON_ROOT: root, DOCULIGHT_R3_SOURCE_HASH: check.manifest.sourceHash }),
        encoding: 'utf8', timeout: 60000
      });
      if (child.stdout) process.stdout.write(child.stdout);
      if (child.stderr) process.stderr.write(child.stderr);
      const exitCode = electronExitCode(child, name);
      if (exitCode === 2) console.error(`SETUP_ERROR Electron scenario ${name} did not finish with an exact positive PASS marker`);
      process.exitCode = exitCode;
    } catch (error) {
      console.error(`SETUP_ERROR Electron executable unavailable: ${error.message}; prepare: ${PREPARE}`);
      process.exitCode = 2;
    }
  }
}
