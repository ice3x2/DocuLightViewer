'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');
const { app, BrowserWindow } = require('electron');
if (process.argv.at(-1) === 's07') {
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
}
const { run } = require('./dispatch.cjs');
const { createFixture } = require('./fixtures.cjs');
const { validateRoot, PREPARE } = require('./runtime.cjs');

const cases = [require('./cases/harness-self.cjs'), require('./cases/s06.cjs'), require('./cases/s07-electron.cjs'), require('./cases/s21.cjs')];
const name = process.argv.length >= 4 && process.argv.at(-2) === '--scenario' ? process.argv.at(-1) : '';
const root = process.env.DOCULIGHT_R3_ELECTRON_ROOT || '';
let fixture;
app.whenReady().then(async () => {
  const result = await run(cases, name, {
    write: line => console.error(line),
    async setup() {
      const check = validateRoot(root, 'electron', process.env.DOCULIGHT_R3_SOURCE_HASH);
      if (!check.ok) throw new Error(`${check.reason}; prepare: ${PREPARE}`);
      if (check.manifest.abi !== process.versions.modules) throw new Error('Electron ABI changed; prepare runtime again');
      const Database = createRequire(path.join(root, 'package.json'))('better-sqlite3');
      fixture = createFixture({ Database });
      return { fixture };
    },
    async cleanup() {
      if (fixture) fixture.close();
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
    }
  });
  app.exit(result.exitCode);
}).catch(error => { console.error(`SETUP_ERROR ${error.message}`); app.exit(2); });
