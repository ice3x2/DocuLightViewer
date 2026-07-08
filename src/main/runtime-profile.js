'use strict';

const os = require('os');
const path = require('path');

const PROFILE_DEFAULT = 'default';
const PROFILE_DEV = 'dev';
const NATIVE_REBUILD_STATUS_FILENAME = 'native-rebuild-status.json';

function normalizeProfileName(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized === PROFILE_DEFAULT || normalized === 'packaged') return PROFILE_DEFAULT;
  if (normalized === PROFILE_DEV || normalized === 'development') return PROFILE_DEV;
  return PROFILE_DEFAULT;
}

function parseArgValue(argv, name) {
  const args = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || '');
    if (arg === name && args[index + 1]) return String(args[index + 1]);
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return '';
}

function hasDevFlag(argv) {
  const args = Array.isArray(argv) ? argv : [];
  return args.some((arg) => String(arg || '') === '--dev');
}

function resolveProfileName({ argv = [], env = {}, profileName = '' } = {}) {
  if (profileName) return normalizeProfileName(profileName);

  const argvProfile = parseArgValue(argv, '--profile');
  if (argvProfile) return normalizeProfileName(argvProfile);

  if (env.DOCULIGHT_PROFILE) return normalizeProfileName(env.DOCULIGHT_PROFILE);
  if (env.DOCULIGHT_RUNTIME_PROFILE) return normalizeProfileName(env.DOCULIGHT_RUNTIME_PROFILE);
  if (hasDevFlag(argv)) return PROFILE_DEV;

  return PROFILE_DEFAULT;
}

function defaultIpcPath(platform = process.platform) {
  return platform === 'win32'
    ? '\\\\.\\pipe\\doculight-ipc'
    : '/tmp/doculight-ipc.sock';
}

function devIpcPath(platform = process.platform) {
  return platform === 'win32'
    ? '\\\\.\\pipe\\doculight-ipc-dev'
    : '/tmp/doculight-ipc-dev.sock';
}

function resolveAppDataDir({ env = process.env, platform = process.platform, appDataDir = '' } = {}) {
  if (appDataDir) return appDataDir;
  if (env.DOCULIGHT_APP_DATA_DIR) return env.DOCULIGHT_APP_DATA_DIR;

  const home = env.USERPROFILE || env.HOME || os.homedir();
  if (platform === 'win32') return env.APPDATA || path.join(home, 'AppData', 'Roaming');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  return env.XDG_CONFIG_HOME || path.join(home, '.config');
}

function resolveDefaultUserDataDir({ env = process.env, appDataDir = '', defaultUserDataDir = '' } = {}) {
  if (defaultUserDataDir) return defaultUserDataDir;
  if (env.DOCULIGHT_DEFAULT_USER_DATA_DIR) return env.DOCULIGHT_DEFAULT_USER_DATA_DIR;
  return path.join(appDataDir, 'DocuLight');
}

function resolveDevUserDataDir({ env = process.env, appDataDir = '', devUserDataDir = '' } = {}) {
  if (devUserDataDir) return devUserDataDir;
  if (env.DOCULIGHT_DEV_USER_DATA_DIR) return env.DOCULIGHT_DEV_USER_DATA_DIR;
  return path.join(appDataDir, 'DocuLight-dev');
}

function resolveRuntimeProfile(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const name = resolveProfileName(options);
  const appDataDir = resolveAppDataDir({ env, platform, appDataDir: options.appDataDir });
  const defaultUserDataDir = resolveDefaultUserDataDir({
    env,
    appDataDir,
    defaultUserDataDir: options.defaultUserDataDir
  });
  const userDataDir = name === PROFILE_DEV
    ? resolveDevUserDataDir({ env, appDataDir, devUserDataDir: options.devUserDataDir })
    : defaultUserDataDir;
  const ipcPath = name === PROFILE_DEV
    ? (env.DOCULIGHT_DEV_IPC_PATH || devIpcPath(platform))
    : (env.DOCULIGHT_IPC_PATH || defaultIpcPath(platform));

  return {
    name,
    isDev: name === PROFILE_DEV,
    appName: name === PROFILE_DEV ? 'DocuLight Dev' : 'DocuLight',
    appUserModelId: name === PROFILE_DEV ? 'com.doculight.app.dev' : 'com.doculight.app',
    appDataDir,
    userDataDir,
    shouldSetUserData: name === PROFILE_DEV,
    sessionDataDir: name === PROFILE_DEV ? path.join(userDataDir, 'session') : '',
    ipcPath,
    mcpPortDefault: name === PROFILE_DEV ? 32581 : 32580,
    mcpPortFilePath: path.join(userDataDir, 'mcp-port'),
    indexDataDir: path.join(userDataDir, 'index'),
    nativeRebuildStatusDir: path.join(userDataDir, 'native-rebuild'),
    nativeRebuildStatusFile: path.join(userDataDir, 'native-rebuild', NATIVE_REBUILD_STATUS_FILENAME)
  };
}

function resolveMcpIpcPath(options = {}) {
  const env = options.env || process.env;
  if (env.DOCULIGHT_MCP_IPC_PATH) return env.DOCULIGHT_MCP_IPC_PATH;

  const explicitProfile = env.DOCULIGHT_MCP_PROFILE || env.DOCULIGHT_PROFILE || env.DOCULIGHT_RUNTIME_PROFILE;
  if (explicitProfile) {
    return resolveRuntimeProfile({
      ...options,
      profileName: explicitProfile,
      env
    }).ipcPath;
  }

  if (env.DOCULIGHT_IPC_PATH) return env.DOCULIGHT_IPC_PATH;
  return resolveRuntimeProfile({ ...options, env, profileName: PROFILE_DEFAULT }).ipcPath;
}

function buildProfileEnv(profile, baseEnv = process.env) {
  const env = { ...baseEnv };
  env.DOCULIGHT_PROFILE = profile.name;
  env.DOCULIGHT_RUNTIME_PROFILE = profile.name;
  env.DOCULIGHT_RUNTIME_USER_DATA_DIR = profile.userDataDir;
  env.DOCULIGHT_RUNTIME_IPC_PATH = profile.ipcPath;
  env.DOCULIGHT_NATIVE_REBUILD_STATUS_FILE = profile.nativeRebuildStatusFile;

  if (profile.isDev) {
    env.DOCULIGHT_DEV_IPC_PATH = profile.ipcPath;
    delete env.DOCULIGHT_IPC_PATH;
  } else {
    env.DOCULIGHT_IPC_PATH = profile.ipcPath;
  }

  return env;
}

module.exports = {
  PROFILE_DEFAULT,
  PROFILE_DEV,
  NATIVE_REBUILD_STATUS_FILENAME,
  normalizeProfileName,
  resolveProfileName,
  resolveRuntimeProfile,
  resolveMcpIpcPath,
  buildProfileEnv,
  defaultIpcPath,
  devIpcPath
};
