'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// @req IR-APP-013 AC-13 REL-DOC-007 AC-2 REL-DOC-009 AC-4
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg09-incomplete-exit-'));
try {
  const reportPath = path.join(dir, 'report.json');
  const script = `const fs=require('fs');
    const { registerIncompleteReportExitGuard }=require(${JSON.stringify(path.resolve(__dirname,
      '../scripts/run-p0-release-canaries.js'))});
    const report={status:'running',samples:[{sample:1},{sample:2},{sample:3}],failures:[]};
    const write=()=>fs.writeFileSync(${JSON.stringify(reportPath)},JSON.stringify(report));
    write();
    registerIncompleteReportExitGuard(report,write);
    new Promise(()=>{});`;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000,
    windowsHide: true });
  assert.strictEqual(child.status, 1, 'early process exit is nonzero');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.strictEqual(report.status, 'failed');
  assert.strictEqual(report.samples.length, 3, 'partial samples remain immutable');
  assert.deepStrictEqual(report.failures, [{ code: 'early_process_exit', completedSamples: 3 }]);
  console.log('test-pg09-incomplete-exit-contract: all assertions passed');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
