'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const {
  createNativeRebuildManager,
  isNativeModuleVersionMismatch
} = require('../src/main/native-rebuild-manager');

async function main() {
  assert.strictEqual(
    isNativeModuleVersionMismatch('The module was compiled against NODE_MODULE_VERSION 137 but this runtime requires NODE_MODULE_VERSION 130'),
    true,
    'NODE_MODULE_VERSION diagnostics are recognized as native ABI mismatch'
  );
  assert.strictEqual(
    isNativeModuleVersionMismatch('plain sqlite query failure'),
    false,
    'ordinary SQLite errors are not treated as native ABI mismatch'
  );

  const healthy = createNativeRebuildManager({
    rootDir: path.resolve(__dirname, '..'),
    isPackaged: false,
    probeNativeModules: () => ({
      betterSqlite3: { state: 'loaded' },
      hnswlibNode: { state: 'loaded' }
    }),
    spawnProcess: () => {
      throw new Error('healthy native runtime must not spawn rebuild');
    }
  });
  const healthyStart = healthy.startBackgroundRepairIfNeeded();
  assert.strictEqual(healthyStart.scheduled, false, 'healthy native runtime does not schedule repair');
  assert.strictEqual(healthy.getStatus().state, 'ready', 'healthy native runtime reports ready');

  const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-native-repair-contract-'));
  const spawnCalls = [];
  let child = null;
  const repairing = createNativeRebuildManager({
    rootDir: path.resolve(__dirname, '..'),
    statusDir,
    execPath: 'C:\\fake\\electron.exe',
    isPackaged: false,
    probeNativeModules: () => ({
      betterSqlite3: {
        state: 'native_unavailable',
        message: 'better_sqlite3.node was compiled against NODE_MODULE_VERSION 137'
      },
      hnswlibNode: { state: 'loaded' }
    }),
    spawnProcess: (command, args, options) => {
      child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      spawnCalls.push({ command, args, options });
      return child;
    }
  });

  const repairStart = repairing.startBackgroundRepairIfNeeded();
  assert.strictEqual(repairStart.scheduled, true, 'native ABI mismatch schedules repair in the background');
  assert.strictEqual(repairing.getStatus().state, 'repairing', 'scheduled native repair reports repairing');
  assert.strictEqual(spawnCalls.length, 1, 'native repair spawns exactly one background process');
  assert.strictEqual(spawnCalls[0].command, 'C:\\fake\\electron.exe', 'native repair uses the configured Electron executable');
  assert(spawnCalls[0].args.some((item) => item.endsWith('scripts\\rebuild-electron-native.js') || item.endsWith('scripts/rebuild-electron-native.js')), 'native repair runs rebuild-electron-native.js');
  assert.strictEqual(spawnCalls[0].options.env.ELECTRON_RUN_AS_NODE, '1', 'native repair runs Electron as a Node-compatible script host');
  assert(spawnCalls[0].options.env.DOCULIGHT_NATIVE_REBUILD_STATUS_FILE, 'native repair provides a status file path');

  fs.writeFileSync(spawnCalls[0].options.env.DOCULIGHT_NATIVE_REBUILD_STATUS_FILE, JSON.stringify({
    state: 'repairing',
    phase: 'better-sqlite3',
    progress: { current: 1, total: 2 },
    message: 'Rebuilding better-sqlite3'
  }), 'utf-8');
  const progressStatus = repairing.getStatus();
  assert.strictEqual(progressStatus.phase, 'better-sqlite3', 'native repair status reads the helper status file phase');
  assert.deepStrictEqual(progressStatus.progress, { current: 1, total: 2 }, 'native repair status reads helper progress');

  child.emit('exit', 0);
  await repairStart.promise;
  assert.strictEqual(repairing.getStatus().state, 'ready', 'completed native repair reports ready');

  const packaged = createNativeRebuildManager({
    rootDir: path.resolve(__dirname, '..'),
    isPackaged: true,
    probeNativeModules: () => ({
      betterSqlite3: {
        state: 'native_unavailable',
        message: 'NODE_MODULE_VERSION mismatch'
      }
    }),
    spawnProcess: () => {
      throw new Error('packaged app must not run electron-rebuild in place');
    }
  });
  const packagedStart = packaged.startBackgroundRepairIfNeeded();
  assert.strictEqual(packagedStart.scheduled, false, 'packaged native mismatch does not run in-place rebuild');
  assert.strictEqual(packaged.getStatus().state, 'failed', 'packaged native mismatch reports failed repair status');
  assert.strictEqual(packaged.getStatus().diagnostic.code, 'native_reinstall_required', 'packaged mismatch tells the user to reinstall');

  fs.rmSync(statusDir, { recursive: true, force: true });
  console.log('test-native-rebuild-manager-contract: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
