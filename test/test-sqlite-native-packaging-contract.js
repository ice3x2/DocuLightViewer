'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const builderYaml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf-8');
const mainSource = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf-8');
const electronRebuildScriptPath = path.join(root, 'scripts', 'rebuild-electron-native.js');
const electronRebuildScript = fs.existsSync(electronRebuildScriptPath)
  ? fs.readFileSync(electronRebuildScriptPath, 'utf-8')
  : '';
const runtimeFreeCheckScriptPath = path.join(root, 'scripts', 'check-doculight-runtime-free.js');
const runtimeFreeCheckScript = fs.existsSync(runtimeFreeCheckScriptPath)
  ? fs.readFileSync(runtimeFreeCheckScriptPath, 'utf-8')
  : '';
const devLauncherScriptPath = path.join(root, 'scripts', 'run-dev.js');
const devLauncherScript = fs.existsSync(devLauncherScriptPath)
  ? fs.readFileSync(devLauncherScriptPath, 'utf-8')
  : '';
const mcpBundleScript = packageJson.scripts['bundle:mcp'] || '';

function collectFiles(dir, predicate) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(fullPath, predicate));
    } else if (entry.isFile() && predicate(fullPath)) {
      out.push(fullPath);
    }
  }
  return out;
}

assert(
  packageJson.dependencies && Object.prototype.hasOwnProperty.call(packageJson.dependencies, 'better-sqlite3'),
  'better-sqlite3 is declared as a runtime dependency'
);

assert(
  builderYaml.includes('node_modules/better-sqlite3/**'),
  'electron-builder asarUnpack includes the better-sqlite3 native module tree'
);

assert(
  mcpBundleScript.includes('--external:better-sqlite3'),
  'MCP esbuild bundle keeps better-sqlite3 external'
);

assert(
  packageJson.scripts['rebuild:native:node'].includes('npm rebuild')
    && packageJson.scripts['rebuild:native:node'].includes('better-sqlite3'),
  'Node-side native rebuild script includes better-sqlite3 after electron-builder mutates native ABI'
);

assert(
  packageJson.scripts['rebuild:native:electron']
    && packageJson.scripts['rebuild:native:electron'].includes('rebuild-electron-native.js'),
  'Electron-side native rebuild script exists for dev/start Electron ABI'
);

assert(
  fs.existsSync(electronRebuildScriptPath)
    && electronRebuildScript.includes('@electron/rebuild')
    && electronRebuildScript.includes('better-sqlite3')
    && electronRebuildScript.includes('hnswlib-node')
    && electronRebuildScript.includes('native_unavailable degraded mode')
    && electronRebuildScript.includes('electron/package.json')
    && electronRebuildScript.includes('DOCULIGHT_NATIVE_REBUILD_STATUS_FILE'),
  'Electron-side native rebuild helper targets required better-sqlite3 and optional HNSW Electron ABI with background status reporting'
);

assert.strictEqual(
  packageJson.scripts.dev,
  'node scripts/run-dev.js',
  'dev script uses the profile-aware Node launcher'
);

assert(
  !Object.prototype.hasOwnProperty.call(packageJson.scripts, 'predev') || !packageJson.scripts.predev,
  'predev lifecycle is removed so npm run dev does not duplicate runtime preflight or native rebuild'
);

assert(
  fs.existsSync(devLauncherScriptPath)
    && devLauncherScript.includes('check-doculight-runtime-free.js')
    && devLauncherScript.includes('rebuild-electron-native.js')
    && devLauncherScript.includes("require('electron')")
    && devLauncherScript.includes('DOCULIGHT_NATIVE_REBUILD_STATUS_FILE')
    && devLauncherScript.includes('--profile=dev')
    && devLauncherScript.includes('shell: false'),
  'dev launcher runs profile-aware preflight, one Electron native rebuild, and local Electron without shell resolution'
);

assert(
  packageJson.scripts.prestart
    && packageJson.scripts.prestart.includes('check:runtime-free')
    && !packageJson.scripts.prestart.includes('rebuild:native:electron'),
  'prestart keeps the existing runtime preflight without adding dev-only Electron rebuild'
);

assert.strictEqual(
  packageJson.scripts['check:runtime-free'],
  'node scripts/check-doculight-runtime-free.js',
  'runtime-free preflight check script is exposed'
);

assert(
  fs.existsSync(runtimeFreeCheckScriptPath)
    && runtimeFreeCheckScript.includes('DOCULIGHT_IPC_PATH')
    && runtimeFreeCheckScript.includes('DOCULIGHT_DEV_IPC_PATH')
    && runtimeFreeCheckScript.includes('--profile')
    && runtimeFreeCheckScript.includes('doculight-ipc')
    && runtimeFreeCheckScript.includes('Close the existing DocuLight instance')
    && runtimeFreeCheckScript.includes('finish(1)')
    && runtimeFreeCheckScript.includes('process.exit(exitCode)'),
  'runtime-free preflight check fails before Electron launch when an existing IPC server is active'
);

for (const hook of ['postbuild', 'postbuild:win', 'postbuild:mac', 'postbuild:linux']) {
  assert(
    packageJson.scripts[hook] === 'npm run repair:package:native && npm run rebuild:native:node',
    `${hook} repairs packaged Electron ABI before restoring local Node ABI for better-sqlite3`
  );
}

assert.strictEqual(
  packageJson.scripts['smoke:package'],
  'node test/package-smoke.js',
  'package smoke script exists for packaged native SQLite verification'
);

assert(
  packageJson.scripts['smoke:dev-profile'] === 'node scripts/smoke-dev-profile.js',
  'dev-profile smoke script exists for packaged/dev runtime isolation verification'
);

const resolveProfileIndex = mainSource.indexOf('resolveRuntimeProfile(');
const setUserDataIndex = mainSource.indexOf("app.setPath('userData'");
const storeIndex = mainSource.indexOf('new Store(');
const singleInstanceIndex = mainSource.indexOf('requestSingleInstanceLock');

assert(
  resolveProfileIndex >= 0
    && setUserDataIndex >= 0
    && storeIndex >= 0
    && singleInstanceIndex >= 0
    && resolveProfileIndex < storeIndex
    && setUserDataIndex < storeIndex
    && setUserDataIndex < singleInstanceIndex,
  'runtime profile resolves and applies dev userData before Store creation and single-instance lock'
);

assert(
  mainSource.includes('runtimeProfile.ipcPath')
    && mainSource.includes('runtimeProfile.indexDataDir')
    && mainSource.includes('runtimeProfile.nativeRebuildStatusDir')
    && mainSource.includes('runtimeProfile.mcpPortFilePath'),
  'main process uses runtime profile paths for IPC, search index, native status, and MCP port discovery'
);

assert(
  mainSource.includes('!runtimeProfile.isDev && store.get(\'fileAssociation\'') &&
    mainSource.includes('runtimeProfile.isDev') &&
    mainSource.includes('file association registration is disabled for the dev profile'),
  'dev profile cannot register or re-register packaged OS file associations'
);

assert(
  mainSource.includes("err.code === 'EADDRINUSE'")
    && mainSource.includes('Another DocuLight instance is probably running')
    && mainSource.includes('app.quit()'),
  'IPC named-pipe EADDRINUSE is reported as a duplicate instance and exits cleanly'
);

for (const relativePath of ['src/main/mcp-server.mjs', 'src/main/mcp-http.mjs']) {
  const content = fs.readFileSync(path.join(root, relativePath), 'utf-8');
  assert(
    !content.includes("require('better-sqlite3')") && !content.includes('from "better-sqlite3"') && !content.includes("from 'better-sqlite3'"),
    `${relativePath} does not directly import better-sqlite3`
  );
}

const rendererBoundaryFiles = [
  path.join(root, 'src', 'main', 'preload.js'),
  path.join(root, 'src', 'main', 'mcp-server.mjs'),
  ...collectFiles(path.join(root, 'src', 'renderer'), (filePath) => /\.(js|html|css)$/.test(filePath))
];

for (const filePath of rendererBoundaryFiles) {
  const relativePath = path.relative(root, filePath).replace(/\\/g, '/');
  const content = fs.readFileSync(filePath, 'utf-8');
  assert(!content.includes('garu-ko'), `${relativePath} does not directly import garu-ko`);
}

console.log('test-sqlite-native-packaging-contract: all assertions passed');
