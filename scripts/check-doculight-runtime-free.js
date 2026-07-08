'use strict';

const net = require('net');
const {
  resolveRuntimeProfile
} = require('../src/main/runtime-profile');

// Supports default DOCULIGHT_IPC_PATH and dev-scoped DOCULIGHT_DEV_IPC_PATH
// selection through --profile=dev / DOCULIGHT_PROFILE=dev. The resolver keeps
// the legacy doculight-ipc default for packaged/start compatibility.
const runtimeProfile = resolveRuntimeProfile({
  argv: process.argv.slice(2),
  env: process.env,
  platform: process.platform
});
const IPC_PATH = runtimeProfile.ipcPath;
const TIMEOUT_MS = Math.max(100, Number(process.env.DOCULIGHT_IPC_CHECK_TIMEOUT_MS || 1200));

let settled = false;

function finish(exitCode) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  socket.destroy();
  process.exit(exitCode);
}

const socket = net.connect(IPC_PATH);
const timer = setTimeout(() => {
  console.error(`[doculight] Existing IPC check timed out for ${IPC_PATH}.`);
  console.error('[doculight] DocuLight may already be running or the IPC pipe may be stuck. Close any existing DocuLight/Electron process, then run npm run dev again.');
  finish(1);
}, TIMEOUT_MS);

socket.on('connect', () => {
  console.error(`[doculight] Existing DocuLight IPC server is already listening on ${IPC_PATH}.`);
  console.error('[doculight] Close the existing DocuLight instance from the tray, or stop the old Electron process, then run npm run dev again.');
  finish(1);
});

socket.on('error', (err) => {
  const code = err && err.code ? err.code : '';
  if (code === 'ENOENT' || code === 'ECONNREFUSED') {
    finish(0);
    return;
  }
  console.warn(`[doculight] Existing IPC check could not verify ${IPC_PATH} (${code || err.message}); continuing with Electron single-instance lock.`);
  finish(0);
});
