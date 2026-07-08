'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  buildProfileEnv,
  resolveRuntimeProfile
} = require('../src/main/runtime-profile');

const root = path.resolve(__dirname, '..');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: options.env || process.env,
    stdio: options.stdio || 'inherit',
    shell: false,
    windowsHide: false
  });
  return result.status == null ? 1 : result.status;
}

function main() {
  const userArgs = process.argv.slice(2);
  const dryRun = userArgs.includes('--dry-run');
  const forwardedArgs = userArgs.filter((arg) => arg !== '--dry-run');
  const profile = resolveRuntimeProfile({
    argv: ['node', 'scripts/run-dev.js', '--dev', '--profile=dev', ...forwardedArgs],
    env: {
      ...process.env,
      DOCULIGHT_PROFILE: 'dev'
    },
    platform: process.platform
  });
  const env = buildProfileEnv(profile, process.env);
  env.DOCULIGHT_NATIVE_REBUILD_STATUS_FILE = profile.nativeRebuildStatusFile;
  const preflightArgs = [path.join(root, 'scripts', 'check-doculight-runtime-free.js'), '--profile=dev'];
  const rebuildArgs = [path.join(root, 'scripts', 'rebuild-electron-native.js')];
  const electronArgs = ['.', '--dev', '--profile=dev', ...forwardedArgs];

  fs.mkdirSync(profile.nativeRebuildStatusDir, { recursive: true });

  if (dryRun) {
    process.stdout.write(`${JSON.stringify({
      profile: profile.name,
      userDataDir: profile.userDataDir,
      ipcPath: profile.ipcPath,
      indexDataDir: profile.indexDataDir,
      nativeRebuildStatusFile: profile.nativeRebuildStatusFile,
      mcpPortFilePath: profile.mcpPortFilePath,
      preflightArgs,
      rebuildArgs,
      electronArgs
    }, null, 2)}\n`);
    return;
  }

  let status = run(process.execPath, preflightArgs, { env });
  if (status !== 0) process.exit(status);

  status = run(process.execPath, rebuildArgs, { env });
  if (status !== 0) process.exit(status);

  const electronPath = require('electron');
  status = run(electronPath, electronArgs, { env });
  process.exit(status);
}

main();
