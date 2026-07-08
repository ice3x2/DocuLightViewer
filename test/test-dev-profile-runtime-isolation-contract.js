'use strict';

const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');
let runtimeProfile = null;

try {
  runtimeProfile = require(path.join(root, 'src', 'main', 'runtime-profile'));
} catch {
  runtimeProfile = null;
}

assert(runtimeProfile, 'runtime-profile module exists');

const {
  resolveRuntimeProfile,
  resolveMcpIpcPath,
  buildProfileEnv
} = runtimeProfile;

assert.strictEqual(typeof resolveRuntimeProfile, 'function', 'resolveRuntimeProfile is exported');
assert.strictEqual(typeof resolveMcpIpcPath, 'function', 'resolveMcpIpcPath is exported');
assert.strictEqual(typeof buildProfileEnv, 'function', 'buildProfileEnv is exported');

function normalize(value) {
  return String(value || '').replace(/\\/g, '/').toLowerCase();
}

const defaultUserDataDir = 'C:\\Users\\tester\\AppData\\Roaming\\DocuLight';
const appDataDir = 'C:\\Users\\tester\\AppData\\Roaming';
const packagedPipe = '\\\\.\\pipe\\doculight-packaged-test';
const devOverridePipe = '\\\\.\\pipe\\doculight-dev-override-test';

const defaultProfile = resolveRuntimeProfile({
  argv: ['electron', '.'],
  env: { DOCULIGHT_IPC_PATH: packagedPipe },
  platform: 'win32',
  appDataDir,
  defaultUserDataDir
});

assert.strictEqual(defaultProfile.name, 'default', 'default profile is selected without dev flags');
assert.strictEqual(defaultProfile.appUserModelId, 'com.doculight.app', 'default profile preserves packaged AppUserModelID');
assert.strictEqual(defaultProfile.ipcPath, packagedPipe, 'default profile preserves legacy DOCULIGHT_IPC_PATH override');
assert.strictEqual(defaultProfile.mcpPortDefault, 32580, 'default profile preserves MCP base port 32580');
assert.strictEqual(defaultProfile.userDataDir, defaultUserDataDir, 'default profile uses Electron default userData');
assert.strictEqual(defaultProfile.indexDataDir, path.join(defaultUserDataDir, 'index'), 'default index dir is under default userData');
assert.strictEqual(defaultProfile.nativeRebuildStatusDir, path.join(defaultUserDataDir, 'native-rebuild'), 'default native status dir is under default userData');
assert.strictEqual(defaultProfile.mcpPortFilePath, path.join(defaultUserDataDir, 'mcp-port'), 'default MCP discovery file is under default userData');

const devProfile = resolveRuntimeProfile({
  argv: ['electron', '.', '--dev', '--profile=dev'],
  env: {
    DOCULIGHT_IPC_PATH: packagedPipe,
    DOCULIGHT_DEV_IPC_PATH: devOverridePipe
  },
  platform: 'win32',
  appDataDir,
  defaultUserDataDir
});

assert.strictEqual(devProfile.name, 'dev', 'dev profile is selected by dev flags');
assert.strictEqual(devProfile.appName, 'DocuLight Dev', 'dev profile has an app name suffix');
assert.strictEqual(devProfile.appUserModelId, 'com.doculight.app.dev', 'dev profile has an AppUserModelID suffix');
assert.strictEqual(devProfile.ipcPath, devOverridePipe, 'dev profile ignores stale DOCULIGHT_IPC_PATH and uses dev-scoped IPC override');
assert.strictEqual(devProfile.mcpPortDefault, 32581, 'dev profile uses a separate MCP base port');
assert.notStrictEqual(normalize(devProfile.userDataDir), normalize(defaultProfile.userDataDir), 'dev userData differs from default userData');
assert(normalize(devProfile.userDataDir).includes('doculight-dev'), 'dev userData uses a suffix directory');
assert.strictEqual(devProfile.indexDataDir, path.join(devProfile.userDataDir, 'index'), 'dev index dir is under dev userData');
assert.strictEqual(devProfile.nativeRebuildStatusDir, path.join(devProfile.userDataDir, 'native-rebuild'), 'dev native status dir is under dev userData');
assert.strictEqual(devProfile.mcpPortFilePath, path.join(devProfile.userDataDir, 'mcp-port'), 'dev MCP discovery file is under dev userData');
assert.strictEqual(devProfile.sessionDataDir, path.join(devProfile.userDataDir, 'session'), 'dev session data is under dev userData');

for (const key of ['userDataDir', 'indexDataDir', 'nativeRebuildStatusDir', 'mcpPortFilePath']) {
  assert.notStrictEqual(
    normalize(devProfile[key]),
    normalize(defaultProfile[key]),
    `${key} is isolated between default and dev profiles`
  );
}

assert.strictEqual(
  resolveMcpIpcPath({
    env: {
      DOCULIGHT_MCP_PROFILE: 'dev',
      DOCULIGHT_IPC_PATH: packagedPipe,
      DOCULIGHT_DEV_IPC_PATH: devOverridePipe
    },
    platform: 'win32',
    appDataDir,
    defaultUserDataDir
  }),
  devOverridePipe,
  'DOCULIGHT_MCP_PROFILE=dev is not defeated by stale DOCULIGHT_IPC_PATH'
);

assert.strictEqual(
  resolveMcpIpcPath({
    env: {
      DOCULIGHT_MCP_IPC_PATH: '\\\\.\\pipe\\doculight-explicit-mcp',
      DOCULIGHT_MCP_PROFILE: 'dev',
      DOCULIGHT_DEV_IPC_PATH: devOverridePipe
    },
    platform: 'win32',
    appDataDir,
    defaultUserDataDir
  }),
  '\\\\.\\pipe\\doculight-explicit-mcp',
  'DOCULIGHT_MCP_IPC_PATH remains the explicit MCP override'
);

const devEnv = buildProfileEnv(devProfile, { EXISTING: '1' });
assert.strictEqual(devEnv.EXISTING, '1', 'profile env preserves existing env values');
assert.strictEqual(devEnv.DOCULIGHT_PROFILE, 'dev', 'profile env includes DOCULIGHT_PROFILE');
assert.strictEqual(devEnv.DOCULIGHT_DEV_IPC_PATH, devProfile.ipcPath, 'profile env includes dev-scoped IPC path');
assert.strictEqual(
  devEnv.DOCULIGHT_NATIVE_REBUILD_STATUS_FILE,
  path.join(devProfile.nativeRebuildStatusDir, 'native-rebuild-status.json'),
  'profile env includes dev native rebuild status file'
);

console.log('test-dev-profile-runtime-isolation-contract: all assertions passed');
