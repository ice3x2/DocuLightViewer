'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf-8');
const windowsJob = workflow.slice(workflow.indexOf('  build-windows:'), workflow.indexOf('  build-macos:'));
const macosJob = workflow.slice(workflow.indexOf('  build-macos:'), workflow.indexOf('  build-linux:'));
const linuxJob = workflow.slice(workflow.indexOf('  build-linux:'), workflow.indexOf('  release:'));

function assertWorkflow(condition, message) {
  assert(condition, `Release workflow contract: ${message}`);
}

assertWorkflow(workflow.includes('runs-on: windows-2022'), 'Windows build pins the Visual Studio 2022 runner recognized by node-gyp');
assertWorkflow(!/^\s*run:\s+npm ci\s*$/m.test(workflow), 'native install scripts are not run during npm ci');
assertWorkflow((workflow.match(/run: npm ci --ignore-scripts/g) || []).length === 3, 'every platform installs dependencies without host-ABI native scripts');
assertWorkflow((workflow.match(/uses: actions\/setup-python@v6/g) || []).length === 3, 'every native package build provisions a supported Python runtime');
assertWorkflow((workflow.match(/python-version: '3\.11'/g) || []).length === 3, 'every native package build pins Python 3.11 for node-gyp compatibility');
assertWorkflow((workflow.match(/npm_config_python: \$\{\{ steps\.python\.outputs\.python-path \}\}/g) || []).length === 6, 'install and build steps use the provisioned Python runtime');
assertWorkflow((workflow.match(/uses: actions\/checkout@v5/g) || []).length === 5, 'checkout uses the Node 24 action runtime');
assertWorkflow((workflow.match(/uses: actions\/setup-node@v5/g) || []).length === 3, 'setup-node uses the Node 24 action runtime');
assertWorkflow(linuxJob.includes('run: xvfb-run --auto-servernum npm run smoke:package'), 'Linux package smoke runs under a virtual X server');
assertWorkflow(!windowsJob.includes('xvfb-run') && !macosJob.includes('xvfb-run'), 'virtual X is never used by Windows or macOS package smoke');

console.log('test-release-workflow-contract: all assertions passed');
