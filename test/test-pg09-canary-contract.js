'use strict';

const assert = require('assert');
const { validatePg09Sample, shouldStopPg09Collection } = require('../scripts/run-p0-release-canaries');

// @req IR-APP-013 AC-13 REL-DOC-007 AC-2 REL-DOC-009 AC-4 OPS-ARCH-009 AC-2
assert.strictEqual(typeof validatePg09Sample, 'function', 'PG-09 sample validator exists');
const good = {
  runtime: { isPackaged: true, electronAbi: '130' },
  owner: { workerThreadId: 3, ledgerOpenThreadId: 3, keywordOpenThreadId: 3 },
  main: { writableOpenCount: 0 },
  flow: { activeStatusSeen: true, cancelAccepted: true, cancelledFileRetained: true,
    failedSaveRetained: true, retryableIntentPresent: true, completedImportRetained: true },
  processCold: { pid: 123, workerReadyEpochMs: 1000,
    commandLineRedacted: '[PACKAGED_APP] --user-data-dir=[PROFILE] --r3-test-lifecycle' },
  activeSave: { activeBefore: true, activeAfter: true, saved: true, indexingState: 'queued' },
  cancelObservation: { cancelRequestedAtEpochMs: 1000, requestedJobId: 'job-a',
    watcherToken: 'watch-1', terminalJobId: 'job-a', terminalPhase: 'cancelled',
    nextOwnerJobId: 'job-b', durableJob: { jobId: 'job-a', status: 'cancelled',
      cancelRequested: true } },
  responsiveness: { workerMarker: true, heartbeatGaps: [50, 60],
    samples: ['status', 'focus', 'close', 'cancel'].map((kind, index) => ({ kind, ms: 10,
      startMonoMs: 110 + index * 20, endMonoMs: 120 + index * 20 })) },
  pg09: { scheduler: { ownerWorkerCount: 1, legacyActiveWorkerCount: 0,
      checkerWorkerCount: 0, ownerActiveJobCount: 1,
      ownerWorkerThreadId: 3, ownerActiveJobId: 'job-a', workerJobId: 'job-a',
      helperActiveBefore: true, helperActiveAfter: true,
      mainHeartbeatMaxMs: 60, helperPid: 456,
      helperExitCode: 0, ioStartMonoMs: 100, ioEndMonoMs: 200,
      ioStartMarkerReceived: true, ioFinishMarkerReceived: true,
      helperExecutableSha256: 'b'.repeat(64), helperProcessGone: true,
      helperCommand: '[PYTHON_EXECUTABLE] [PG09_HELPER] [FIXTURE] [PROFILE]' },
    linkedImport: { completed: true, retainedAfterCancel: true, sha256: 'a'.repeat(64) },
    unbufferedSameVolumeIo: { status: 'pass', semantics: 'FILE_FLAG_NO_BUFFERING',
      sourceVolumeToken: 'abc', outputVolumeToken: 'abc', profileVolumeToken: 'abc',
      filesystem: 'NTFS', bufferAligned: true, offsetsAligned: true,
      bytesRead: 4096, bytesWritten: 4096,
      fixtureBytes: 4096, fixtureSha256: 'a'.repeat(64), outputSha256: 'a'.repeat(64) } }
};
assert.doesNotThrow(() => validatePg09Sample(good));
assert.strictEqual(typeof shouldStopPg09Collection, 'function',
  'PG-09 runner has an owned-helper survivor stop gate');
assert.strictEqual(shouldStopPg09Collection(good), false);
assert.strictEqual(shouldStopPg09Collection({ ...good, pg09: { ...good.pg09,
  scheduler: { ...good.pg09.scheduler, helperProcessGone: false,
    helperPid: 456, helperDiagnostic: 'helper_timeout' } } }), true,
'owned interpreter survivor must stop collection before another profile starts');
assert.strictEqual(shouldStopPg09Collection({ pg09HelperStarted: true,
  pg09HelperPid: 456, failed: true }), true,
'injected early foreground failure before helper completion evidence must stop collection');
for (const [name, changed] of Object.entries({
  missingWorker: { owner: { workerThreadId: null } },
  missingHeartbeat: { responsiveness: { ...good.responsiveness, heartbeatGaps: [] } },
  missingDirectIo: { pg09: { ...good.pg09, unbufferedSameVolumeIo: null } },
  wrongVolume: { pg09: { ...good.pg09, unbufferedSameVolumeIo: {
    ...good.pg09.unbufferedSameVolumeIo, outputVolumeToken: 'other' } } },
  unsupported: { pg09: { ...good.pg09, unbufferedSameVolumeIo: {
    ...good.pg09.unbufferedSameVolumeIo, status: 'unsupported' } } },
  hiddenWriter: { pg09: { ...good.pg09, scheduler: { ...good.pg09.scheduler, legacyActiveWorkerCount: 1 } } },
  missingHelperPid: { pg09: { ...good.pg09, scheduler: { ...good.pg09.scheduler, helperPid: null } } },
  helperFailed: { pg09: { ...good.pg09, scheduler: { ...good.pg09.scheduler, helperExitCode: 1 } } },
  missingStartMarker: { pg09: { ...good.pg09, scheduler: { ...good.pg09.scheduler, ioStartMarkerReceived: false } } },
  missingFinishMarker: { pg09: { ...good.pg09, scheduler: { ...good.pg09.scheduler, ioFinishMarkerReceived: false } } },
  helperStillAlive: { pg09: { ...good.pg09, scheduler: { ...good.pg09.scheduler, helperProcessGone: false } } },
  missingWorkerIdentity: { pg09: { ...good.pg09, scheduler: { ...good.pg09.scheduler, ownerWorkerThreadId: null } } },
  missingImport: { pg09: { ...good.pg09, linkedImport: null } },
  missingTerminalEvidence: { cancelObservation: null },
  noCancelOverlap: { responsiveness: { ...good.responsiveness, samples: good.responsiveness.samples.map(
    entry => entry.kind === 'cancel' ? { ...entry, startMonoMs: 201, endMonoMs: 211 } : entry) } },
  noStatusOverlap: { responsiveness: { ...good.responsiveness, samples: good.responsiveness.samples.map(
    entry => entry.kind === 'status' ? { ...entry, startMonoMs: 201, endMonoMs: 211 } : entry) } },
  noFocusOverlap: { responsiveness: { ...good.responsiveness, samples: good.responsiveness.samples.map(
    entry => entry.kind === 'focus' ? { ...entry, startMonoMs: 201, endMonoMs: 211 } : entry) } },
  noCloseOverlap: { responsiveness: { ...good.responsiveness, samples: good.responsiveness.samples.map(
    entry => entry.kind === 'close' ? { ...entry, startMonoMs: 201, endMonoMs: 211 } : entry) } }
})) {
  assert.throws(() => validatePg09Sample({ ...good, ...changed }), /PG-09|worker|heartbeat|volume|direct|unsupported|concurrency/i,
    `${name} must fail PG-09`);
}
console.log('test-pg09-canary-contract: all assertions passed');
