'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const net = require('net');
const path = require('path');

const root = path.resolve(__dirname, '..');
const preflightScript = path.join(root, 'scripts', 'check-doculight-runtime-free.js');

function pipeName(label) {
  const suffix = `doculight-preflight-${process.pid}-${Date.now()}-${label}`;
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${suffix}`
    : path.join(require('os').tmpdir(), `${suffix}.sock`);
}

function withServer(pipePath, fn) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.end();
    });

    server.once('error', reject);
    server.listen(pipePath, async () => {
      try {
        resolve(await fn());
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

function runPreflight(args, env) {
  return spawnSync(process.execPath, [preflightScript, ...args], {
    cwd: root,
    env: {
      ...process.env,
      DOCULIGHT_IPC_CHECK_TIMEOUT_MS: '250',
      ...env
    },
    encoding: 'utf-8',
    windowsHide: true
  });
}

(async () => {
  const packagedPipe = pipeName('packaged');
  const devPipe = pipeName('dev');

  await withServer(packagedPipe, async () => {
    const result = runPreflight(['--profile=dev'], {
      DOCULIGHT_IPC_PATH: packagedPipe,
      DOCULIGHT_DEV_IPC_PATH: devPipe
    });

    assert.strictEqual(
      result.status,
      0,
      `dev preflight ignores stale packaged DOCULIGHT_IPC_PATH; stderr=${result.stderr}`
    );
  });

  await withServer(devPipe, async () => {
    const result = runPreflight(['--profile=dev'], {
      DOCULIGHT_IPC_PATH: packagedPipe,
      DOCULIGHT_DEV_IPC_PATH: devPipe
    });

    assert.notStrictEqual(result.status, 0, 'dev preflight fails when the dev IPC pipe is occupied');
    assert(
      result.stderr.includes(devPipe),
      'dev preflight reports the dev IPC pipe, not the stale packaged pipe'
    );
  });

  await withServer(packagedPipe, async () => {
    const result = runPreflight([], {
      DOCULIGHT_IPC_PATH: packagedPipe,
      DOCULIGHT_DEV_IPC_PATH: devPipe
    });

    assert.notStrictEqual(result.status, 0, 'default preflight still honors DOCULIGHT_IPC_PATH');
    assert(
      result.stderr.includes(packagedPipe),
      'default preflight reports the configured default IPC pipe'
    );
  });

  console.log('test-runtime-profile-preflight-contract: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
