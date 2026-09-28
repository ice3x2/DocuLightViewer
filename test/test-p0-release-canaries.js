'use strict';

const assert = require('assert');
const { validateNativeOwnerEvidence } = require('./helpers/package-native-owner-evidence');
const { validatePg04Report, sanitizeDiagnostic } = require('../scripts/run-p0-release-canaries');

// @req IR-APP-013 AC-13 OPS-ARCH-009 AC-2 OPS-ARCH-012 AC-5 REL-DOC-007 AC-2
const hash = 'a'.repeat(64);
const commitSha = 'b'.repeat(40);
const single = {
  version: 'package-native-owner.v1', directExecutable: true,
  selectedAppSha256: hash, sourceHash: hash, sourceHashScope: 'r3-source-files',
  sourceFileCount: 100, fixtureSha256: hash,
  baseCommit: commitSha, corpus: { fileCount: 3, bytes: 1000, ledgerRows: 3 },
  runtime: { isPackaged: true, profile: 'default', isolatedUserData: true, electronAbi: '130' },
  owner: { workerThreadId: 1, ledgerOpenThreadId: 1, keywordOpenThreadId: 1, openCount: 2 },
  main: { writableOpenCount: 0 },
  flow: { saved: true, indexed: true, searchFound: true, opened: true, closed: true,
    activeStatusSeen: true, cancelAccepted: true, cancelledFileRetained: true,
    failedSaveRetained: true, retryableIntentPresent: true },
  responsiveness: { workerMarker: true, heartbeatGaps: [10, 10], cancelMs: 5,
    samples: ['status', 'focus', 'close', 'cancel'].map((kind) => ({ kind, ms: 5 })),
    byKind: Object.fromEntries(['status', 'focus', 'close'].map((kind) =>
      [kind, { count: 1, p95: 5, p99: 5, max: 5 }])) },
  lifecycle: { exited: true, exitCode: 0, appProcessGone: true, handleReleased: true,
    profileRemoved: true }
};

assert.throws(() => validateNativeOwnerEvidence(single, { requireProcessCold: true }), /process-cold|PID|start time|profile token|worker-ready/i,
  'PG-04 rejects a valid warm-style owner probe with no process-cold identity');

const samples = Array.from({ length: 5 }, (_, index) => ({
  ...single, sample: index + 1,
  processCold: { pid: 100 + index, spawnPid: 100 + index,
    processStartEpochMs: 1000 + index * 1000,
    profileToken: `${index}`.repeat(64), workerReadyEpochMs: 1100 + index * 1000 },
  activeQuery: { startedAtEpochMs: 1110 + index * 1000,
    finishedAtEpochMs: 1120 + index * 1000, workerJobId: 'job-1',
    activeBefore: true, activeAfter: true, queryCompleted: true,
    queryError: false, resultCount: 0,
    savedDocumentId: 'document-1', foundDocumentId: 'document-1' },
  activeSave: { startedAtEpochMs: 1121 + index * 1000,
    finishedAtEpochMs: 1130 + index * 1000, workerJobId: 'job-1',
    activeBefore: true, activeAfter: true, saved: true,
    indexingState: 'queued', receiptJobId: 'job-2',
    receiptDocumentId: 'document-2', ledgerDocumentId: 'document-2',
    ledgerReceiptJobId: 'job-2', ledgerReceiptDocumentId: 'document-2',
    acceptanceReceiptKind: 'queued', acceptanceIntentId: hash,
    acceptedIntentId: hash, acceptanceJobId: 'job-2',
    acceptanceDocumentId: 'document-2', acceptanceSha256: hash,
    contentBytes: 64, retainedBytes: 144, ledgerBytes: 144,
    contentSha256: 'c'.repeat(64), retainedSha256: hash, ledgerSha256: hash,
    bodyMatchesInput: true, intentPersisted: false }
}));
const report = { version: 'p0-pg04.v1', samples, package: { selectedAppSha256: hash,
  sourceHash: hash, commitSha, artifactKind: 'portable', os: 'win32', arch: 'x64',
  packageBytes: 100, packageMtimeMs: 2000 } };
const provenance = { expectedSourceHash: hash, buildManifest: {
  version: 'p0-pg04-build.v1', sourceHash: hash, selectedAppSha256: hash,
  commitSha, packageBytes: 100, packageMtimeMs: 2000, recordedAtEpochMs: 2100 } };
assert.doesNotThrow(() => validatePg04Report(report), 'five distinct cold packaged samples pass');
assert.throws(() => validatePg04Report({ ...report, samples: [
  { ...samples[0], activeSave: { ...samples[0].activeSave,
    bodyMatchesInput: false } }, ...samples.slice(1)] }), /active save/i,
  'saved Markdown body must equal the input after frontmatter injection');
assert.throws(() => validatePg04Report({ ...report, samples: [
  { ...samples[0], activeSave: { ...samples[0].activeSave,
    ledgerSha256: 'd'.repeat(64) } }, ...samples.slice(1)] }), /active save/i,
  'saved bytes and hash must equal the accepted ledger record');
assert.throws(() => validatePg04Report({ ...report, samples: [
  { ...samples[0], activeSave: { ...samples[0].activeSave,
    ledgerReceiptJobId: 'wrong-job' } }, ...samples.slice(1)] }), /active save/i,
  'queued receipt must identify the durable ledger job');
assert.throws(() => validatePg04Report({ ...report, samples: [
  { ...samples[0], activeSave: { ...samples[0].activeSave,
    acceptanceReceiptKind: null } }, ...samples.slice(1)] }), /active save/i,
  'missing durable queued acceptance receipt fails');
assert.throws(() => validatePg04Report({ ...report, samples: [
  { ...samples[0], activeSave: { ...samples[0].activeSave,
    acceptanceSha256: 'd'.repeat(64) } }, ...samples.slice(1)] }), /active save/i,
  'acceptance receipt content hash must match retained Markdown');
assert.throws(() => validatePg04Report({ ...report, samples: [
  { ...samples[0], activeSave: null }, ...samples.slice(1)] }), /active save/i,
  'missing second save during active owner job fails PG-04');
assert.throws(() => validatePg04Report(report, { ...provenance,
  expectedSourceHash: 'c'.repeat(64) }), /source hash|frozen/i,
  'self-consistent but wrong source hash cannot pass the frozen source');
assert.throws(() => validatePg04Report(report, { ...provenance,
  buildManifest: { ...provenance.buildManifest, selectedAppSha256: 'c'.repeat(64) } }),
/manifest|package checksum/i, 'self-consistent package evidence cannot bypass the build manifest');
for (const secret of ['C:\\Users\\alice\\doc.md', '\\\\host\\share\\doc.md',
  '/opt/project/doc.md', '//nas/share/doc.md', 'api_key=rawsecret',
  'https://user:password@example.test/v1']) {
  assert(!sanitizeDiagnostic(`failure ${secret}`).includes(secret),
    `diagnostic removes ${secret} before artifact or stderr output`);
}
assert.throws(() => validatePg04Report({ ...report, samples: [
  { ...samples[0], activeQuery: null }, ...samples.slice(1)] }), /active query/i,
  'missing query during active worker fails PG-04');
assert.throws(() => validatePg04Report({ ...report, samples: [
  { ...samples[0], activeQuery: { ...samples[0].activeQuery,
    queryCompleted: false } }, ...samples.slice(1)] }),
/active query/i, 'incomplete query during active worker fails PG-04');
assert.throws(() => validatePg04Report({ ...report, samples: [
  { ...samples[0], activeQuery: { ...samples[0].activeQuery,
    startedAtEpochMs: samples[0].processCold.workerReadyEpochMs - 1 } }, ...samples.slice(1)] }),
/active query/i, 'query before active worker marker fails PG-04');
assert.throws(() => validatePg04Report({ ...report, samples: samples.slice(1) }), /five|sample/i);
assert.throws(() => validatePg04Report({ ...report, samples: [samples[0],
  { ...samples[1], processCold: samples[0].processCold }, ...samples.slice(2)] }), /PID|profile|distinct/i);
const slow = structuredClone(report);
slow.samples[4].responsiveness.samples[0].ms = 1001;
assert.throws(() => validatePg04Report(slow), /status|threshold|sample/i,
  'one outlier fails, never best-of selection');

console.log('test-p0-release-canaries: all assertions passed');
