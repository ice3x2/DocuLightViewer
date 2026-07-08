'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const builderYml = fs.existsSync(path.join(root, 'electron-builder.yml'))
  ? fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf-8')
  : '';
const releaseWorkflow = fs.existsSync(path.join(root, '.github/workflows/release.yml'))
  ? fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf-8')
  : '';
const clientProfileFixturePath = path.join(root, 'test/fixtures/wave2-client-profile-oracles.json');
const clientProfileFixture = fs.existsSync(clientProfileFixturePath)
  ? JSON.parse(fs.readFileSync(clientProfileFixturePath, 'utf-8'))
  : null;
const bundleSource = fs.existsSync(path.join(root, 'src/main/mcp-server.bundle.mjs'))
  ? fs.readFileSync(path.join(root, 'src/main/mcp-server.bundle.mjs'), 'utf-8')
  : '';
const packageSmoke = fs.existsSync(path.join(root, 'test/package-smoke.js'))
  ? fs.readFileSync(path.join(root, 'test/package-smoke.js'), 'utf-8')
  : '';
const optionalHnswRebuild = fs.existsSync(path.join(root, 'scripts/rebuild-hnsw-optional.js'))
  ? fs.readFileSync(path.join(root, 'scripts/rebuild-hnsw-optional.js'), 'utf-8')
  : '';
const hnswIndexSource = fs.existsSync(path.join(root, 'src/main/hnsw-index.js'))
  ? fs.readFileSync(path.join(root, 'src/main/hnsw-index.js'), 'utf-8')
  : '';
const hnswIndex = require('../src/main/hnsw-index');

function wave2Assert(condition, message) {
  assert(condition, `Wave 2 package smoke contract: ${message}`);
}

wave2Assert(
  packageJson.scripts && packageJson.scripts['test:wave2'] && packageJson.scripts['test:wave2'].includes('test-wave2-package-contract.js'),
  'test:wave2 script includes the Wave 2 package contract'
);

wave2Assert(
  packageJson.optionalDependencies && Object.prototype.hasOwnProperty.call(packageJson.optionalDependencies, 'hnswlib-node'),
  'package smoke declares hnswlib-node as the selected optional Wave 2 HNSW native dependency'
);

wave2Assert(
  packageJson.scripts['bundle:mcp'] && packageJson.scripts['bundle:mcp'].includes('--external:hnswlib-node'),
  'MCP bundle keeps hnswlib-node external'
);

wave2Assert(
  optionalHnswRebuild.includes('hnswlib-node') && optionalHnswRebuild.includes('native_unavailable'),
  'native rebuild script attempts optional hnswlib-node rebuild'
);

wave2Assert(
  packageJson.scripts['rebuild:native:node'] && packageJson.scripts['rebuild:native:node'].includes('rebuild-hnsw-optional.js'),
  'native rebuild uses a best-effort hnswlib-node helper'
);

wave2Assert(
  builderYml.includes('node_modules/hnswlib-node/**'),
  'electron-builder asarUnpack includes hnswlib-node native module tree'
);

wave2Assert(
  hnswIndexSource.includes("require('hnswlib-node')") && hnswIndexSource.indexOf("require('hnswlib-node')") > hnswIndexSource.indexOf('function loadHnswlib'),
  'HNSW wrapper lazy-loads hnswlib-node behind loadHnswlib'
);

const forcedUnavailable = hnswIndex.loadHnswlib({ forceUnavailable: true });
wave2Assert(
  forcedUnavailable && forcedUnavailable.available === false && forcedUnavailable.reason === 'native_unavailable',
  'HNSW wrapper reports native_unavailable degraded state'
);

class FakeHierarchicalNSW {
  constructor() {
    this.points = [];
  }

  initIndex(maxElements) {
    this.maxElements = maxElements;
  }

  setEf(efSearch) {
    this.efSearch = efSearch;
  }

  addPoint(vector, label) {
    this.points.push({ vector, label });
  }

  searchKnn(vector, limit) {
    if (limit > this.points.length) {
      throw new Error(`searchKnn limit ${limit} exceeds inserted points ${this.points.length}`);
    }
    return {
      neighbors: this.points.slice(0, limit).map((point) => point.label),
      distances: this.points.slice(0, limit).map((_, index) => index)
    };
  }
}

const fakeIndex = hnswIndex.createHnswIndex({
  dimensions: 2,
  maxElements: 100,
  HierarchicalNSW: FakeHierarchicalNSW
});
fakeIndex.init(100);
fakeIndex.addPoint([1, 0], 101);
fakeIndex.addPoint([0, 1], 202);
fakeIndex.markDeleted(101);
const fakeSearch = fakeIndex.search([0, 1], 20);
wave2Assert(
  fakeSearch.ok === true && fakeSearch.labels.length === 1 && fakeSearch.labels[0] === 202,
  'HNSW search caps native k by known memberships and filters tombstones'
);

wave2Assert(
  hnswIndexSource.includes('redactString'),
  'HNSW native load diagnostics use shared redaction'
);

for (const hnswTerm of [
  'markDeleted',
  'tombstones',
  'compactionRecommended',
  'compactionThreshold',
  'writeIndexAtomic',
  'atomic_swap_failed'
]) {
  wave2Assert(hnswIndexSource.includes(hnswTerm), `HNSW wrapper supports ${hnswTerm}`);
}

wave2Assert(
  packageSmoke.includes('optional_missing') && packageSmoke.includes('hnswlib-node'),
  'package smoke treats missing optional hnswlib-node as diagnosable degraded state'
);

wave2Assert(!bundleSource.includes('hnswlib-node'), 'generated MCP bundle does not contain direct hnswlib-node import text');

wave2Assert(
  releaseWorkflow.includes('npm run smoke:package'),
  'release workflow runs package smoke as a release gate'
);
wave2Assert(
  releaseWorkflow.includes('DOCULIGHT_PACKAGE_SMOKE_REPORT_DIR') &&
    releaseWorkflow.includes('windows-package-smoke') &&
    releaseWorkflow.includes('macos-package-smoke') &&
    releaseWorkflow.includes('linux-package-smoke'),
  'release workflow uploads package smoke reports for Windows, macOS, and Linux'
);

wave2Assert(clientProfileFixture && Array.isArray(clientProfileFixture.oracles), 'client-profile fixture oracle file exists');

const requiredProfiles = ['codex', 'claude_code', 'opencode', 'openclo', 'hermes', 'small_local', 'frontier_model'];
const requiredIntentIds = [
  'save_only_generated_markdown',
  'visible_open_update',
  'legacy_keyword_search',
  'read_only_smart_search',
  'diagnostics_request',
  'forbidden_recursive_import',
  'forbidden_reindex_control',
  'broken_relative_link_diagnostics',
  'wrong_mode_self_correction'
];
const requiredOracleFields = [
  'clientProfile',
  'prompt',
  'expectedToolName',
  'rejectedToolNames',
  'expectedMinimalArguments',
  'expectedEnvelopeShape',
  'expectedErrorShape',
  'expectedDiagnostics',
  'expectedRedactions',
  'outputCaps'
];
const capCeilings = {
  resultsLength: 50,
  snippetTextChars: 480,
  headingPathLength: 8,
  headingPathItemChars: 120,
  warningsLength: 5,
  diagnosticsWarningsLength: 10,
  diagnosticStatusItems: 16,
  traceItems: 10,
  scoreDetailFields: 8,
  defaultSerializedBytes: 65536,
  diagnosticSerializedBytes: 131072
};
const smartSearchAllowedMinimalArgumentKeys = new Set([
  'query',
  'mode',
  'limit',
  'filters',
  'linkedTo',
  'linkedFrom',
  'includeSnippets',
  'includeScores',
  'includeTrace',
  'includeDiagnostics',
  'allowDegraded'
]);
const profileSet = new Set(clientProfileFixture.oracles.map((item) => item.clientProfile));
for (const profile of requiredProfiles) {
  wave2Assert(profileSet.has(profile), `client-profile fixture covers ${profile}`);
}
const intentSet = new Set(clientProfileFixture.oracles.map((item) => item.intentId));
for (const intentId of requiredIntentIds) {
  wave2Assert(intentSet.has(intentId), `client-profile fixture covers ${intentId}`);
}
for (const oracle of clientProfileFixture.oracles) {
  for (const field of requiredOracleFields) {
    wave2Assert(Object.prototype.hasOwnProperty.call(oracle, field), `oracle ${oracle.intentId || oracle.clientProfile} declares ${field}`);
  }
  wave2Assert(typeof oracle.prompt === 'string' && oracle.prompt.length > 10, 'oracle prompt is explicit');
  wave2Assert(Array.isArray(oracle.rejectedToolNames), 'oracle rejectedToolNames is an array');
  wave2Assert(Array.isArray(oracle.expectedRedactions), 'oracle expectedRedactions is an array');
  if (oracle.expectedToolName === 'smart_search') {
    for (const key of Object.keys(oracle.expectedMinimalArguments || {})) {
      wave2Assert(smartSearchAllowedMinimalArgumentKeys.has(key), `smart_search oracle ${oracle.intentId} uses schema-valid top-level argument ${key}`);
    }
  }
  for (const [key, ceiling] of Object.entries(capCeilings)) {
    wave2Assert(Number.isFinite(oracle.outputCaps[key]), `oracle ${oracle.intentId} declares numeric cap ${key}`);
    wave2Assert(oracle.outputCaps[key] <= ceiling, `oracle ${oracle.intentId} cap ${key} stays below SRS ceiling`);
  }
}

wave2Assert(
  packageSmoke.includes('wave2-client-profile-oracles.json') &&
    packageSmoke.includes('expectedToolName') &&
    packageSmoke.includes('expectedRedactions') &&
    packageSmoke.includes('defaultSerializedBytes'),
  'package smoke loads client-profile golden oracles and numeric caps'
);

wave2Assert(
  packageSmoke.includes('package-smoke-platform-policy.v1') &&
    packageSmoke.includes('releaseGating') &&
    packageSmoke.includes('bestEffort') &&
    packageSmoke.includes('built_skipped_smoke'),
  'package smoke emits release-gating and best-effort platform coverage reports'
);

console.log('test-wave2-package-contract: all assertions passed');
