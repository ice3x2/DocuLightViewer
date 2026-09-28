'use strict';

const assert = require('assert');
const { validateNativeOwnerEvidence } = require('./helpers/package-native-owner-evidence');

// @req FR-DOC-019 AC-10 IR-APP-013 AC-13 OPS-ARCH-009 AC-2 OPS-ARCH-010 AC-3
const valid = {
  version: 'package-native-owner.v1', artifactKind: 'portable', directExecutable: true,
  selectedAppSha256: 'a'.repeat(64), sourceHash: 'b'.repeat(64),
  sourceHashScope: 'r3-source-files', sourceFileCount: 100,
  fixtureSha256: 'c'.repeat(64),
  runtime: { isPackaged: true, profile: 'default', isolatedUserData: true, electronAbi: '128' },
  owner: { workerThreadId: 4, ledgerOpenThreadId: 4, keywordOpenThreadId: 4, openCount: 2 },
  main: { writableOpenCount: 0 },
  flow: { saved: true, indexed: true, searchFound: true, opened: true, closed: true,
    activeStatusSeen: true, cancelAccepted: true, cancelledFileRetained: true,
    failedSaveRetained: true, retryableIntentPresent: true },
  lifecycle: { exited: true, exitCode: 0, appProcessGone: true,
    handleReleased: true, profileRemoved: true }
};
assert.doesNotThrow(() => validateNativeOwnerEvidence(valid));
assert.throws(() => validateNativeOwnerEvidence({ ...valid, main: { writableOpenCount: 1 } }), /main writable/);
assert.throws(() => validateNativeOwnerEvidence({ ...valid, owner: { ...valid.owner, keywordOpenThreadId: 1 } }), /owner SQLite/);
assert.throws(() => validateNativeOwnerEvidence({ ...valid, lifecycle: { ...valid.lifecycle, profileRemoved: false } }), /profile removal/);
assert.throws(() => validateNativeOwnerEvidence({ ...valid, lifecycle: { ...valid.lifecycle, exitCode: null } }), /child exit/);
assert.throws(() => validateNativeOwnerEvidence({ ...valid, sourceHashScope: 'nine-files' }), /full source/);
assert.throws(() => validateNativeOwnerEvidence({ ...valid, flow: { ...valid.flow, searchFound: false } }), /owner search/);
assert.throws(() => validateNativeOwnerEvidence({ ...valid, flow: { ...valid.flow, cancelAccepted: false } }), /active owner/);
assert.throws(() => validateNativeOwnerEvidence({ ...valid, flow: { ...valid.flow, retryableIntentPresent: false } }), /retained save/);
console.log('test-package-native-owner-evidence: all assertions passed');
