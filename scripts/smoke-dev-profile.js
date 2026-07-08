'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const net = require('net');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');

function makeIpcPath(label) {
  const safeLabel = String(label).replace(/[^a-z0-9_-]/gi, '-');
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\doculight-dev-smoke-${process.pid}-${safeLabel}`
    : path.join(os.tmpdir(), `doculight-dev-smoke-${process.pid}-${safeLabel}.sock`);
}

function withIpcFixture(ipcPath, fn) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end());
    server.once('error', reject);
    server.listen(ipcPath, async () => {
      try {
        resolve(await fn());
      } catch (err) {
        reject(err);
      } finally {
        server.close();
        if (process.platform !== 'win32') {
          try { require('fs').unlinkSync(ipcPath); } catch { /* ignore */ }
        }
      }
    });
  });
}

function runNodeScript(scriptName, args = [], env = {}) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', scriptName), ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    windowsHide: true
  });
}

async function main() {
  const packagedPipe = makeIpcPath('packaged');
  const devPipe = makeIpcPath('dev');

  await withIpcFixture(packagedPipe, async () => {
    const preflight = runNodeScript('check-doculight-runtime-free.js', ['--profile=dev'], {
      DOCULIGHT_IPC_PATH: packagedPipe,
      DOCULIGHT_DEV_IPC_PATH: devPipe,
      DOCULIGHT_IPC_CHECK_TIMEOUT_MS: '250'
    });

    assert.strictEqual(
      preflight.status,
      0,
      `dev preflight should pass while packaged IPC fixture is active: ${preflight.stderr}`
    );

    const result = runNodeScript('run-dev.js', ['--dry-run'], {
      DOCULIGHT_IPC_PATH: packagedPipe,
      DOCULIGHT_DEV_IPC_PATH: devPipe
    });

    assert.strictEqual(result.status, 0, `dev profile dry-run exits successfully: ${result.stderr}`);

    const plan = JSON.parse(result.stdout);
    assert.strictEqual(plan.profile, 'dev', 'dev smoke selects the dev profile');
    assert.strictEqual(plan.ipcPath, devPipe, 'dev smoke selects the dev IPC endpoint while packaged fixture is active');
    assert.notStrictEqual(plan.ipcPath, packagedPipe, 'dev smoke does not reuse the packaged IPC endpoint');
    assert(String(plan.userDataDir).toLowerCase().includes('doculight-dev'), 'dev smoke uses dev userData');
    assert(String(plan.indexDataDir).startsWith(plan.userDataDir), 'dev index data is under dev userData');
    assert(String(plan.mcpPortFilePath).startsWith(plan.userDataDir), 'dev MCP port file is under dev userData');
    assert(plan.electronArgs.includes('--profile=dev'), 'dev smoke launches Electron with --profile=dev');
  });

  console.log('smoke-dev-profile: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
