'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf-8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf-8'));
const prepareJob = workflow.slice(workflow.indexOf('  prepare:'), workflow.indexOf('  build-windows:'));
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
assertWorkflow((workflow.match(/run: npm run test:release-regression/g) || []).length === 3, 'every release platform runs the complete release regression gate');
assertWorkflow(!prepareJob.includes('git tag') && !prepareJob.includes('git push origin'), 'prepare job never publishes a tag before build and test gates pass');
assertWorkflow(packageJson.scripts['test:release-regression'].includes('npm run test:wave1'), 'release regression gate includes Settings wiring coverage from Wave 1');
assertWorkflow(packageJson.scripts['test:release-regression'].includes('npm run test:wave2'), 'release regression gate includes Wave 2 storage and hotfix contracts');
assertWorkflow(packageJson.scripts['test:release-regression'].includes('test-search-index-worker-contract.js'), 'release regression gate includes real worker/controller wiring coverage');
assertWorkflow(packageJson.scripts['test:release-regression'].includes('test-search-index-worker-benchmark-contract.js'), 'release regression gate includes REL-DOC-007 responsiveness benchmark coverage');
assertWorkflow(packageJson.version === '1.0.6', 'non-ASCII link navigation release uses the approved v1.0.6 identity instead of moving an existing release tag');
assertWorkflow(packageLock.version === packageJson.version && packageLock.packages[''].version === packageJson.version, 'package manifest and lockfile release versions match');
const releaseNotePath = path.join(root, 'docs', 'release-note', `v${packageJson.version}.md`);
assertWorkflow(fs.existsSync(releaseNotePath), 'hotfix release has a version-matched release note');
for (const [platform, job, buildCommand, smokeCommand] of [
  ['Windows', windowsJob, 'run: npm run build:win', 'run: npm run smoke:package'],
  ['macOS', macosJob, 'run: npm run build:mac', 'run: npm run smoke:package'],
  ['Linux', linuxJob, 'run: npm run build:linux', 'run: xvfb-run --auto-servernum npm run smoke:package']
]) {
  const electronRuntimeIndex = job.indexOf('run: npm rebuild electron');
  const buildIndex = job.indexOf(buildCommand);
  const regressionIndex = job.indexOf('run: npm run test:release-regression');
  const smokeIndex = job.indexOf(smokeCommand);
  assertWorkflow(
    electronRuntimeIndex >= 0 && buildIndex > electronRuntimeIndex && regressionIndex > buildIndex && smokeIndex > regressionIndex,
    `${platform} installs the Electron test runtime before build, then runs release regression after native ABI restoration and before package smoke`
  );
}
const verifyTagIndex = workflow.indexOf('- name: Verify or create release tag');
const releaseActionIndex = workflow.indexOf('uses: softprops/action-gh-release@v2');
assertWorkflow(workflow.includes("- 'v*.*.*'") && !workflow.includes("- '*.*.*'"), 'release trigger accepts only canonical v-prefixed version tags');
assertWorkflow(prepareJob.includes('GITHUB_REF_NAME') && prepareJob.includes('EXPECTED_TAG="v$VERSION"'), 'prepare derives and validates the canonical package version tag on tag-push events');
assertWorkflow(prepareJob.includes('if [ "$GITHUB_REF_NAME" != "$EXPECTED_TAG" ]'), 'tag-push package-version mismatch fails before platform builds');
assertWorkflow(prepareJob.includes('TAG="$GITHUB_REF_NAME"') && prepareJob.includes('echo "tag=$TAG"'), 'tag-push release output preserves the triggering tag instead of silently substituting another tag');
assertWorkflow(verifyTagIndex > workflow.indexOf('  release:'), 'release job owns tag verification/creation after all build jobs succeed');
assertWorkflow(verifyTagIndex < releaseActionIndex, 'release tag provenance is checked before publishing GitHub Release assets');
assertWorkflow(!workflow.slice(verifyTagIndex, workflow.indexOf('- uses: actions/download-artifact@v4')).includes("if: github.event_name == 'workflow_dispatch'"), 'release tag SHA provenance is checked for both tag-push and workflow-dispatch events');
assertWorkflow(workflow.includes('git rev-list -n 1 "$TAG"'), 'existing release tag SHA is resolved explicitly');
assertWorkflow(workflow.includes('"$TAG_SHA" != "$GITHUB_SHA"'), 'existing release tag must point to the exact hotfix commit');
assertWorkflow(workflow.includes('if [ "$GITHUB_EVENT_NAME" = "workflow_dispatch" ]'), 'only workflow-dispatch may create a missing release tag');
assertWorkflow(workflow.includes('Release tag $TAG does not exist for push event'), 'tag-push provenance check rejects a missing trigger tag instead of creating it');
assertWorkflow(workflow.includes('exit 1'), 'tag provenance mismatch fails the release instead of silently reusing an old tag');

console.log('test-release-workflow-contract: all assertions passed');
