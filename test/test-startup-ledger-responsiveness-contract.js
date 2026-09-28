'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { validateNativeOwnerEvidence } = require('./helpers/package-native-owner-evidence');

// @req IR-APP-013 AC-13 OPS-ARCH-009 AC-2 OPS-ARCH-012 AC-4
const helper = fs.readFileSync(path.join(__dirname, 'helpers', 'package-native-owner-smoke.js'), 'utf8');
assert(helper.includes('r3_test_main_heartbeat_start') && helper.includes('r3_test_main_heartbeat_stop'),
  'real temp-store packaged owner fixture records main heartbeat during active maintenance');
assert(helper.includes('r3_test_viewer_event_watch') && helper.includes('r3_test_viewer_event_wait'),
  'focus and close latency includes actual viewer completion events');

const hash = 'a'.repeat(64);
const evidence = {
  version: 'package-native-owner.v1', directExecutable: true, selectedAppSha256: hash,
  sourceHash: hash, sourceHashScope: 'r3-source-files', sourceFileCount: 10, fixtureSha256: hash,
  runtime: { isPackaged: true, profile: 'default', isolatedUserData: true, electronAbi: '1' },
  owner: { workerThreadId: 1, openCount: 2, ledgerOpenThreadId: 1, keywordOpenThreadId: 1 },
  main: { writableOpenCount: 0 }, flow: { saved: true, indexed: true, searchFound: true,
    opened: true, closed: true, activeStatusSeen: true, cancelAccepted: true,
    cancelledFileRetained: true, failedSaveRetained: true, retryableIntentPresent: true },
  lifecycle: { exited: true, exitCode: 0, appProcessGone: true, handleReleased: true,
    profileRemoved: true }
};
assert.throws(() => validateNativeOwnerEvidence(evidence), /responsiveness|sample|heartbeat|worker/i,
  'missing active-maintenance samples and heartbeat fail the packaged gate');
evidence.responsiveness = { workerMarker: true, heartbeatGaps: [10, 10], cancelMs: 5,
  samples: [{ kind: 'cancel', ms: 5 }],
  byKind: Object.fromEntries(['status', 'focus', 'close'].map((kind) =>
    [kind, { count: 1, p95: 5, p99: 5, max: 5 }])) };
assert.throws(() => validateNativeOwnerEvidence(evidence), /status.*sample/i,
  'fabricated aggregate metrics without raw status/focus/close samples fail');
evidence.responsiveness.samples = ['status', 'focus', 'close', 'cancel']
  .map((kind) => ({ kind, ms: kind === 'status' || kind === 'cancel' ? 2000 : 5 }));
assert.throws(() => validateNativeOwnerEvidence(evidence), /status.*sample|cancel.*sample/i,
  'raw 2000ms status and cancel samples fail despite forged 5ms aggregates');

const reportOption = process.argv.indexOf('--report');
if (reportOption >= 0) {
  assert(process.argv[reportOption + 1], 'a package-smoke report path is required');
  const report = JSON.parse(fs.readFileSync(process.argv[reportOption + 1], 'utf8'));
  assert(report.nativeOwner?.fixtureSha256 && report.nativeOwner?.sourceHash,
    'real temp ledger/corpus fixture and source hashes are present');
  validateNativeOwnerEvidence(report.nativeOwner);
}

console.log('test-startup-ledger-responsiveness-contract: all assertions passed');
