'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const STATUS_FILENAME = 'native-rebuild-status.json';

// @req OPS-ARCH-010
function isNativeModuleVersionMismatch(message) {
  const value = String(message || '');
  return /NODE_MODULE_VERSION|compiled against a different Node\.js version|better_sqlite3\.node|hnswlib-node\.node/i.test(value);
}

// @req SEC-DOC-003
function sanitizeDiagnosticMessage(message) {
  return String(message || '')
    .replace(/\\\\\?\\[A-Za-z]:\\[^\r\n'"`]+/g, '[local path]')
    .replace(/[A-Za-z]:\\[^\r\n'"`]+/g, '[local path]')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' ');
}

function normalizeProgress(progress, fallback = { current: 0, total: 0 }) {
  const raw = progress && typeof progress === 'object' ? progress : {};
  const current = Math.max(0, Number(raw.current) || 0);
  const total = Math.max(0, Number(raw.total) || 0);
  if (total === 0 && fallback) return { ...fallback };
  return { current: Math.min(current, total), total };
}

function normalizeProbeResult(rawResult = {}) {
  const result = rawResult && typeof rawResult === 'object' ? rawResult : {};
  return {
    betterSqlite3: normalizeModuleProbe(result.betterSqlite3, true),
    hnswlibNode: normalizeModuleProbe(result.hnswlibNode, false)
  };
}

function normalizeModuleProbe(rawProbe, required) {
  const probe = rawProbe && typeof rawProbe === 'object' ? rawProbe : {};
  const state = probe.state || (required ? 'native_unavailable' : 'optional_missing');
  return {
    state,
    message: sanitizeDiagnosticMessage(probe.message || ''),
    required: required === true
  };
}

function needsRepair(probe) {
  return Object.values(probe).some((item) => isNativeModuleVersionMismatch(item && item.message));
}

function hasRequiredFailure(probe) {
  return probe.betterSqlite3 && probe.betterSqlite3.state !== 'loaded';
}

function createDefaultProbe() {
  const result = {};
  try {
    require('better-sqlite3');
    result.betterSqlite3 = { state: 'loaded' };
  } catch (err) {
    result.betterSqlite3 = {
      state: 'native_unavailable',
      message: err && err.message ? err.message : String(err)
    };
  }

  try {
    const { loadHnswlib } = require('./hnsw-index');
    const hnsw = loadHnswlib();
    result.hnswlibNode = hnsw && hnsw.available
      ? { state: 'loaded' }
      : { state: 'native_unavailable', message: hnsw && hnsw.reason ? hnsw.reason : 'hnswlib-node unavailable' };
  } catch (err) {
    result.hnswlibNode = {
      state: 'optional_missing',
      message: err && err.message ? err.message : String(err)
    };
  }

  return result;
}

class NativeRebuildManager {
  // @req OPS-ARCH-010
  constructor(options = {}) {
    this.rootDir = options.rootDir || path.resolve(__dirname, '..', '..');
    this.statusDir = options.statusDir || path.join(this.rootDir, '.doculight-runtime');
    this.execPath = options.execPath || process.execPath;
    this.isPackaged = options.isPackaged === true;
    this.spawnProcess = options.spawnProcess || spawn;
    this.probeNativeModules = typeof options.probeNativeModules === 'function'
      ? options.probeNativeModules
      : createDefaultProbe;
    this.statusFile = path.join(this.statusDir, STATUS_FILENAME);
    this.child = null;
    this.inFlight = null;
    this.status = {
      active: false,
      state: 'idle',
      phase: null,
      progress: { current: 0, total: 0 },
      diagnostic: null,
      probe: null
    };
  }

  // @req OPS-ARCH-010
  startBackgroundRepairIfNeeded() {
    if (this.inFlight) {
      return { scheduled: true, reason: 'repair-in-progress', status: this.getStatus(), promise: this.inFlight };
    }

    this._setStatus({
      active: true,
      state: 'checking',
      phase: 'probe',
      progress: { current: 0, total: 2 },
      diagnostic: null
    });

    const probe = normalizeProbeResult(this.probeNativeModules());
    if (!needsRepair(probe)) {
      this._setStatus({
        active: false,
        state: hasRequiredFailure(probe) ? 'failed' : 'ready',
        phase: 'probe',
        progress: { current: 1, total: 1 },
        diagnostic: hasRequiredFailure(probe)
          ? { code: 'native_unavailable', message: probe.betterSqlite3.message || 'Required SQLite native module is unavailable' }
          : null,
        probe
      });
      return { scheduled: false, reason: hasRequiredFailure(probe) ? 'native-unavailable' : 'native-ready', status: this.getStatus() };
    }

    if (this.isPackaged) {
      this._setStatus({
        active: false,
        state: 'failed',
        phase: 'probe',
        progress: { current: 0, total: 1 },
        diagnostic: {
          code: 'native_reinstall_required',
          message: 'Search database module does not match this app runtime. Reinstall the app to repair native modules.'
        },
        probe
      });
      return { scheduled: false, reason: 'native-reinstall-required', status: this.getStatus() };
    }

    const scriptPath = path.join(this.rootDir, 'scripts', 'rebuild-electron-native.js');
    if (!fs.existsSync(scriptPath)) {
      this._setStatus({
        active: false,
        state: 'failed',
        phase: 'start',
        progress: { current: 0, total: 1 },
        diagnostic: {
          code: 'native_rebuild_script_missing',
          message: 'Native rebuild helper script is missing'
        },
        probe
      });
      return { scheduled: false, reason: 'native-rebuild-script-missing', status: this.getStatus() };
    }

    fs.mkdirSync(this.statusDir, { recursive: true });
    this._writeStatusFile({
      active: true,
      state: 'repairing',
      phase: 'start',
      progress: { current: 0, total: 2 },
      diagnostic: null,
      probe
    });
    this._setStatus({
      active: true,
      state: 'repairing',
      phase: 'start',
      progress: { current: 0, total: 2 },
      diagnostic: null,
      probe
    });

    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DOCULIGHT_NATIVE_REBUILD_STATUS_FILE: this.statusFile
    };
    let child = null;
    try {
      child = this.spawnProcess(this.execPath, [scriptPath], {
        cwd: this.rootDir,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      const diagnostic = {
        code: 'native_rebuild_spawn_failed',
        message: sanitizeDiagnosticMessage(err && err.message ? err.message : String(err))
      };
      this._setStatus({
        active: false,
        state: 'failed',
        phase: 'start',
        progress: { current: 0, total: 2 },
        diagnostic,
        probe
      });
      return { scheduled: false, reason: 'native-rebuild-spawn-failed', status: this.getStatus() };
    }
    this.child = child;

    this.inFlight = new Promise((resolve, reject) => {
      child.on('error', (err) => {
        this.child = null;
        const diagnostic = {
          code: 'native_rebuild_spawn_failed',
          message: sanitizeDiagnosticMessage(err && err.message ? err.message : String(err))
        };
        this._setStatus({
          active: false,
          state: 'failed',
          phase: 'start',
          progress: { current: 0, total: 2 },
          diagnostic,
          probe
        });
        this.inFlight = null;
        reject(err);
      });
      child.on('exit', (code) => {
        this.child = null;
        const fileStatus = this._readStatusFile();
        if (code === 0) {
          this._setStatus({
            ...fileStatus,
            active: false,
            state: 'ready',
            phase: 'completed',
            progress: { current: 2, total: 2 },
            diagnostic: null,
            probe
          });
          this.inFlight = null;
          resolve(this.getStatus());
          return;
        }
        const diagnostic = fileStatus.diagnostic || {
          code: 'native_rebuild_failed',
          message: `Native rebuild exited with code ${code}`
        };
        this._setStatus({
          ...fileStatus,
          active: false,
          state: 'failed',
          phase: fileStatus.phase || 'failed',
          progress: normalizeProgress(fileStatus.progress, { current: 0, total: 2 }),
          diagnostic,
          probe
        });
        this.inFlight = null;
        reject(new Error(diagnostic.message || 'Native rebuild failed'));
      });
    });
    this.inFlight.catch(() => {});

    return { scheduled: true, reason: 'native-repair-started', status: this.getStatus(), promise: this.inFlight };
  }

  // @req OPS-ARCH-010
  getStatus() {
    if (this.status.state === 'repairing') {
      const fileStatus = this._readStatusFile();
      if (fileStatus && fileStatus.state) {
        return this._publicStatus({
          ...this.status,
          ...fileStatus,
          probe: this.status.probe
        });
      }
    }
    return this._publicStatus(this.status);
  }

  _setStatus(status) {
    this.status = {
      ...this.status,
      ...status,
      progress: normalizeProgress(status.progress, this.status.progress),
      diagnostic: status.diagnostic ? {
        code: status.diagnostic.code || 'native_rebuild',
        message: sanitizeDiagnosticMessage(status.diagnostic.message || status.diagnostic.code || '')
      } : null
    };
  }

  _readStatusFile() {
    try {
      if (!fs.existsSync(this.statusFile)) return {};
      const data = JSON.parse(fs.readFileSync(this.statusFile, 'utf-8'));
      return this._normalizeStatusFile(data);
    } catch {
      return {};
    }
  }

  _writeStatusFile(status) {
    try {
      fs.writeFileSync(this.statusFile, JSON.stringify(status, null, 2), 'utf-8');
    } catch {
      // Settings can still show in-memory state if the status file cannot be written.
    }
  }

  _normalizeStatusFile(status) {
    const raw = status && typeof status === 'object' ? status : {};
    return {
      active: raw.active === true,
      state: raw.state || this.status.state,
      phase: raw.phase || this.status.phase,
      progress: normalizeProgress(raw.progress, this.status.progress),
      diagnostic: raw.diagnostic ? {
        code: raw.diagnostic.code || 'native_rebuild',
        message: sanitizeDiagnosticMessage(raw.diagnostic.message || raw.diagnostic.code || '')
      } : null
    };
  }

  _publicStatus(status) {
    return {
      active: status.active === true,
      state: status.state || 'idle',
      phase: status.phase || null,
      progress: normalizeProgress(status.progress, { current: 0, total: 0 }),
      diagnostic: status.diagnostic || null,
      probe: status.probe || null
    };
  }
}

function createNativeRebuildManager(options = {}) {
  return new NativeRebuildManager(options);
}

module.exports = {
  NativeRebuildManager,
  createNativeRebuildManager,
  isNativeModuleVersionMismatch,
  sanitizeDiagnosticMessage,
  STATUS_FILENAME
};
