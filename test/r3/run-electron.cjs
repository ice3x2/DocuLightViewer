'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { sourceRoot, sourceHash, validateRoot, PREPARE, electronAppEnv, electronExitCode } = require('./runtime.cjs');

const cases = [require('./cases/harness-self.cjs'), require('./cases/s06.cjs'), require('./cases/s07-electron.cjs'), require('./cases/s21.cjs'), require('./cases/s22.cjs'), require('./cases/s24-electron.cjs'), require('./scenarios/s26.cjs')];
const name = process.argv.length === 4 && process.argv[2] === '--scenario' ? process.argv[3] : '';
const names = cases.map(item => item.name);
if (new Set(names).size !== names.length || !names.includes(name)) {
  console.error(`SETUP_ERROR missing, unknown, or duplicate scenario; Usage: --scenario NAME; available: ${names.join(', ')}`);
  process.exitCode = 2;
} else {
  const root = process.env.DOCULIGHT_R3_ELECTRON_ROOT || '';
  const check = validateRoot(root, 'electron', sourceHash());
  if (!check.ok) {
    console.error(`SETUP_ERROR ${check.reason}; prepare: ${PREPARE}`);
    process.exitCode = 2;
  } else {
    try {
      const executable = createRequire(path.join(root, 'package.json'))('electron');
      if (name === 's26') {
        const { run } = require('./dispatch.cjs');
        run(cases, name, { setup: async () => ({ executable, root, sourceHash: check.manifest.sourceHash }) })
          .then(result => { process.exitCode = result.exitCode; });
        return;
      }
      const child = spawnSync(executable, [path.join(root, 'test/r3/electron-main.cjs'), '--scenario', name], {
        cwd: root,
        env: electronAppEnv({ ...process.env, DOCULIGHT_R3_ELECTRON_ROOT: root, DOCULIGHT_R3_SOURCE_HASH: check.manifest.sourceHash }),
        encoding: 'utf8', timeout: 60000
      });
      if (child.stdout) process.stdout.write(child.stdout);
      let stderr = child.stderr || '';
      let metricsPresent = name !== 's22';
      if (name === 's22') {
        const line = stderr.split(/\r?\n/).find(item => item.startsWith('S22_METRICS '));
        if (line) {
          const metrics = JSON.parse(line.slice('S22_METRICS '.length));
          if (metrics.sourceHash === check.manifest.sourceHash) {
            const artifact = path.join(sourceRoot, 'docs/analysis/2026-09-25-s22-large-document-samples.json');
            fs.writeFileSync(artifact, `${JSON.stringify(metrics, null, 2)}\n`);
            console.error(`S22_ARTIFACT ${artifact}`);
            metricsPresent = true;
          }
          stderr = stderr.split(/\r?\n/).filter(item => item !== line).join('\n');
        }
      }
      if (stderr) process.stderr.write(stderr);
      const exitCode = metricsPresent ? electronExitCode(child, name) : 2;
      if (exitCode === 2) console.error(`SETUP_ERROR Electron scenario ${name} did not finish with an exact positive PASS marker`);
      process.exitCode = exitCode;
    } catch (error) {
      console.error(`SETUP_ERROR Electron executable unavailable: ${error.message}; prepare: ${PREPARE}`);
      process.exitCode = 2;
    }
  }
}
