'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// @req FR-DOC-019 AC-6,AC-10
async function run() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s23d-finalization-'));
  const scenarioDir = path.join(fixture, 'a', 'b', 'c');
  const artifactDir = path.join(fixture, 'docs', 'analysis');
  fs.mkdirSync(scenarioDir, { recursive: true });
  fs.mkdirSync(artifactDir, { recursive: true });
  const sourceHash = 'a'.repeat(64);
  const event = (role, type, readOnly, threadId) => ({ sourceHash, pid: 101,
    threadId, role, type, dbBasename: 'smart-search.sqlite3', readOnly, caller: ['fixture.js:1:1'] });
  const events = [event('main', 'open', true, 0), event('owner', 'open', false, 1),
    event('owner', 'write', false, 1), event('main', 'open', false, 0)];
  const scenario = path.join(__dirname, 'r3', 'scenarios', 's23d.cjs');
  const script = fs.readFileSync(scenario, 'utf8');
  const sandbox = {
    module: { exports: {} }, __dirname: scenarioDir, process, console: { error() {} },
    require(request) {
      if (request === './s26.cjs') return { async run() {
        fs.writeFileSync(process.env.DOCULIGHT_S23D_PRODUCT_TRACE,
          `${events.map(item => JSON.stringify(item)).join('\n')}\n`);
        fs.writeFileSync(process.env.DOCULIGHT_S23D_ROUTE_EVIDENCE,
          JSON.stringify({ sourceHash, runs: [{ pid: 101 }], secondaryPids: [], publicToolsCalled: 8 }));
        return {};
      } };
      if (request === './s23d-extra.cjs') return { async runExtra() {
        return { runs: [], writerExpectedPids: [], outcomes: {},
          attemptedRoute: 'complete', attemptedOutcome: 'passed' };
      } };
      if (request === 'node:child_process') return { execFileSync: () => 'b'.repeat(40) };
      return require(request);
    }
  };
  try {
    vm.runInNewContext(script, sandbox, { filename: scenario });
    await assert.rejects(sandbox.module.exports.run({ sourceHash, assert: assert.ok }),
      /only long owner writes|one writable owner/);
    const summaryFile = fs.readdirSync(artifactDir)
      .find(name => name.endsWith('.json') && !name.endsWith('-routes.json'));
    assert(summaryFile, 'failure summary is preserved');
    const summary = JSON.parse(fs.readFileSync(path.join(artifactDir, summaryFile), 'utf8'));
    assert.equal(summary.status, 'scenario_failed');
    assert.equal(summary.attemptedRoute, 'writer-boundary');
    assert.equal(summary.attemptedOutcome, 'failed');
    const raw = fs.readFileSync(path.join(artifactDir, summary.rawJsonl));
    assert.equal(summary.rawSha256, crypto.createHash('sha256').update(raw).digest('hex'));
  } finally {
    delete process.env.DOCULIGHT_S23D_PRODUCT_TRACE;
    delete process.env.DOCULIGHT_S23D_ROUTE_EVIDENCE;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

run().then(() => console.log('test-s23d-audit-finalization: all assertions passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
