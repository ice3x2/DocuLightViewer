'use strict';

const assert = require('assert');
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];

// @req FR-DOC-019 AC-10 IR-APP-013 AC-13 OPS-ARCH-009 AC-2 OPS-ARCH-010 AC-3
function validateNativeOwnerEvidence(evidence, { requireProcessCold = false } = {}) {
  assert.strictEqual(evidence.version, 'package-native-owner.v1');
  assert.strictEqual(evidence.directExecutable, true, 'direct selected executable launch');
  assert.match(evidence.selectedAppSha256, /^[a-f0-9]{64}$/, 'selected artifact checksum');
  assert.match(evidence.sourceHash, /^[a-f0-9]{64}$/, 'source content hash');
  assert.strictEqual(evidence.sourceHashScope, 'r3-source-files', 'full source hash scope');
  assert(Number.isInteger(evidence.sourceFileCount) && evidence.sourceFileCount > 9,
    'full source file count');
  assert.match(evidence.fixtureSha256, /^[a-f0-9]{64}$/, 'fixture checksum');
  assert.strictEqual(evidence.runtime.isPackaged, true, 'packaged runtime');
  assert.strictEqual(evidence.runtime.profile, 'default', 'packaged profile');
  assert.strictEqual(evidence.runtime.isolatedUserData, true, 'isolated user data');
  assert(evidence.runtime.electronAbi, 'Electron ABI');
  if (requireProcessCold) {
    const cold = evidence.processCold;
    assert(Number.isInteger(cold?.pid) && cold.pid > 0
      && Number.isFinite(cold?.processStartEpochMs) && cold.processStartEpochMs > 0
      && /^[a-f0-9]{64}$/.test(cold?.profileToken || '')
      && Number.isFinite(cold?.workerReadyEpochMs)
      && cold.workerReadyEpochMs >= cold.processStartEpochMs
      && Number.isInteger(cold.spawnPid) && cold.spawnPid > 0,
    'process-cold PID, start time, profile token and worker-ready time');
  }
  assert(Number.isInteger(evidence.owner.workerThreadId) && evidence.owner.workerThreadId > 0
    && evidence.owner.openCount === 2
    && evidence.owner.ledgerOpenThreadId === evidence.owner.workerThreadId
    && evidence.owner.keywordOpenThreadId === evidence.owner.workerThreadId,
  'owner SQLite opens are both on one worker thread');
  assert.strictEqual(evidence.main.writableOpenCount, 0, 'main writable SQLite opens');
  assert(evidence.flow.saved && evidence.flow.indexed && evidence.flow.searchFound,
    'owner search finds the indexed fixture');
  assert(evidence.flow.opened && evidence.flow.closed, 'normal viewer open/close');
  assert(evidence.flow.activeStatusSeen && evidence.flow.cancelAccepted
    && evidence.flow.cancelledFileRetained, 'active owner status/cancel retains saved file');
  assert(evidence.flow.failedSaveRetained && evidence.flow.retryableIntentPresent,
    'retained save remains retryable after post-publish failure');
  const responsive = evidence.responsiveness;
  assert(responsive?.workerMarker === true && Array.isArray(responsive.samples)
    && Array.isArray(responsive.heartbeatGaps), 'active maintenance worker, samples and heartbeat evidence');
  for (const kind of ['status', 'focus', 'close']) {
    const result = responsive.byKind?.[kind];
    const samples = responsive.samples.filter((sample) => sample.kind === kind);
    const values = samples.map((sample) => sample.ms);
    assert(result?.count > 0 && result.count === samples.length
      && samples.every((sample) => Number.isFinite(sample.ms) && sample.ms >= 0)
      && result.p95 === percentile(values, .95) && result.p95 <= 250
      && result.p99 === percentile(values, .99) && result.p99 <= 500
      && result.max === Math.max(...values) && result.max <= 1000,
    `${kind} responsiveness samples meet the packaged bounds`);
  }
  const cancelSamples = responsive.samples.filter((sample) => sample.kind === 'cancel');
  assert(cancelSamples.length > 0 && cancelSamples.every((sample) =>
    Number.isFinite(sample.ms) && sample.ms >= 0 && sample.ms <= 1000)
    && responsive.cancelMs === Math.max(...cancelSamples.map((sample) => sample.ms)),
  'cancel responsiveness sample meets the packaged bound');
  assert(responsive.heartbeatGaps.length >= 2
    && responsive.heartbeatGaps.every((gap) => Number.isFinite(gap) && gap >= 0 && gap <= 250),
  'main heartbeat samples meet the packaged bound');
  assert(evidence.lifecycle.exited === true && evidence.lifecycle.exitCode === 0,
    'real child exit with zero status');
  assert(evidence.lifecycle.appProcessGone === true, 'actual app process exits');
  assert(evidence.lifecycle.handleReleased, 'app releases handles');
  assert(evidence.lifecycle.profileRemoved, 'isolated profile removal');
}

module.exports = { validateNativeOwnerEvidence };
