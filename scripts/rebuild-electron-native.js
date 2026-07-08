'use strict';

const fs = require('fs');
const path = require('path');

const STATUS_FILE = process.env.DOCULIGHT_NATIVE_REBUILD_STATUS_FILE || '';

function sanitizeMessage(message) {
  return String(message || '')
    .replace(/\\\\\?\\[A-Za-z]:\\[^\r\n'"`]+/g, '[local path]')
    .replace(/[A-Za-z]:\\[^\r\n'"`]+/g, '[local path]')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' ');
}

function writeStatus(patch) {
  if (!STATUS_FILE) return;
  try {
    fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      active: true,
      state: 'repairing',
      heartbeatAt: new Date().toISOString(),
      ...patch
    }, null, 2), 'utf-8');
  } catch {
    // Console output remains the fallback for direct CLI usage.
  }
}

async function rebuildModule(rebuild, options, moduleName, { optional = false } = {}) {
  const label = optional ? `optional ${moduleName}` : moduleName;
  try {
    writeStatus({
      phase: moduleName,
      progress: { current: options.completedSteps, total: options.totalSteps },
      message: `Rebuilding ${label}`
    });
    console.log(`[doculight] Rebuilding ${label} for Electron ${options.electronVersion}...`);
    await rebuild({
      buildPath: options.buildPath,
      electronVersion: options.electronVersion,
      force: true,
      onlyModules: [moduleName]
    });
    options.completedSteps += 1;
    writeStatus({
      phase: moduleName,
      progress: { current: options.completedSteps, total: options.totalSteps },
      message: `Rebuilt ${label}`
    });
    console.log(`[doculight] Electron ${label} rebuild completed.`);
    return true;
  } catch (err) {
    if (!optional) throw err;
    const message = err && err.message ? err.message : String(err);
    options.completedSteps += 1;
    writeStatus({
      phase: moduleName,
      progress: { current: options.completedSteps, total: options.totalSteps },
      diagnostic: {
        code: 'optional_native_rebuild_failed',
        message: sanitizeMessage(message)
      },
      message: `Optional ${moduleName} rebuild failed`
    });
    console.warn(`[doculight] Optional hnswlib-node Electron rebuild failed; semantic HNSW will use native_unavailable degraded mode until the native toolchain is available. ${message}`);
    return false;
  }
}

async function main() {
  const { rebuild } = require('@electron/rebuild');
  const electronVersion = require('electron/package.json').version;
  const buildPath = path.resolve(__dirname, '..');
  const options = { buildPath, electronVersion, totalSteps: 2, completedSteps: 0 };

  writeStatus({
    phase: 'start',
    progress: { current: 0, total: options.totalSteps },
    message: `Starting Electron native rebuild for ${electronVersion}`
  });
  await rebuildModule(rebuild, options, 'better-sqlite3');
  await rebuildModule(rebuild, options, 'hnswlib-node', { optional: true });
  writeStatus({
    active: false,
    state: 'ready',
    phase: 'completed',
    progress: { current: options.totalSteps, total: options.totalSteps },
    message: 'Electron native rebuild completed'
  });
  console.log('[doculight] Electron native rebuild completed.');
}

main().catch((err) => {
  const message = err && err.stack ? err.stack : String(err);
  writeStatus({
    active: false,
    state: 'failed',
    phase: 'failed',
    diagnostic: {
      code: err && err.code ? err.code : 'native_rebuild_failed',
      message: sanitizeMessage(message)
    },
    message: 'Electron native rebuild failed'
  });
  console.error('[doculight] Electron native rebuild failed:');
  console.error(message);
  process.exit(1);
});
