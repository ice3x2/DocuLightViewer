'use strict';

const assert = require('assert');

// @req FR-DOC-019 AC-10 IR-APP-013 AC-13 OPS-ARCH-009 AC-2 OPS-ARCH-010 AC-3
function validateNativeOwnerEvidence(evidence) {
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
  assert(evidence.lifecycle.exited === true && evidence.lifecycle.exitCode === 0,
    'real child exit with zero status');
  assert(evidence.lifecycle.appProcessGone === true, 'actual app process exits');
  assert(evidence.lifecycle.handleReleased, 'app releases handles');
  assert(evidence.lifecycle.profileRemoved, 'isolated profile removal');
}

module.exports = { validateNativeOwnerEvidence };
