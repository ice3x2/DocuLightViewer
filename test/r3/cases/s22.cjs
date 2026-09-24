'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { BrowserWindow } = require('electron');
const { OwnerWorkerController } = require('../../../src/main/search-owner-controller');
const { publishSave } = require('../../../src/main/index-ingress-store');
const { largeMarkdownFixture, MAX_SAVE_BYTES, TARGET_BYTES } = require('../large-markdown-fixture.cjs');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const SAMPLE_COUNTS = Object.freeze({ status: 50, focus: 25, close: 25, cancel: 1 });
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];

function waitForWorkerStatus(owner, predicate, deadlineMs, label) {
  const current = owner.getStatus();
  if (predicate(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { owner.worker.off('message', receive); reject(new Error(`missing ${label} worker marker`)); }, deadlineMs);
    function receive(message) {
      if (message.tag !== 'STATUS' || !predicate(message.snapshot)) return;
      clearTimeout(timer);
      owner.worker.off('message', receive);
      resolve(message.snapshot);
    }
    owner.worker.on('message', receive);
  });
}

// @req REL-DOC-007 IR-APP-013 FR-DOC-019 IR-APP-010
module.exports = {
  name: 's22',
  async run({ fixture, assert }) {
    const storeRoot = path.join(fixture.root, 's22-store');
    const ingressRoot = path.join(fixture.root, 's22-ingress');
    fs.mkdirSync(storeRoot);
    fs.mkdirSync(ingressRoot);
    const owner = new OwnerWorkerController({
      ledgerPath: path.join(fixture.root, 's22-ledger.sqlite3'),
      keywordPath: path.join(fixture.root, 's22-keyword.sqlite3'),
      sourceRoot: storeRoot, ingressRoot, deriveDocuments: true,
      keywordTokenizerProvider: 'basic'
    });
    let finished = false;
    let heartbeat;
    const windows = [];
    try {
      const ready = await owner.start();
      assert(ready.audit.openCount === 2 && ready.audit.ledgerOpenThreadId === ready.threadId
        && ready.audit.keywordOpenThreadId === ready.threadId, 'one worker opens both SQLite databases');
      await waitForWorkerStatus(owner, value => value.migrationComplete && value.recoveryComplete, 5000, 'recovery-ready');
      const save = async (name, bytes, operation = 'save_document') => {
        const published = await publishSave({ storeRoot, ingressRoot,
          sourceRelativeLocator: name, operation, sourceId: 's22-source',
          rootFingerprint: sha(path.resolve(storeRoot)), contentBytes: bytes,
          contentHash: sha(bytes), provenance: { aliases: [], metadata: {} } });
        return owner.acceptPublishedSave({ intentId: published.intentId });
      };
      const warmBytes = Buffer.from('# Prior committed document\nprioruniquekey searchable content.\n');
      const warmTerminal = waitForWorkerStatus(owner, value => value.phase === 'completed'
        && value.jobId?.startsWith('job_'), 10000, 'warm-up terminal');
      const warmAck = await save('prior.md', warmBytes);
      assert(warmAck.accepted && warmAck.indexing?.jobId, 'warm-up save receives durable worker ACK');
      const warmed = await warmTerminal;
      assert(warmed.jobId === warmAck.indexing.jobId, 'warm-up is excluded after its own terminal marker');
      const prior = await owner.query('query_keyword', { query: 'prioruniquekey' });
      assert(prior.length > 0, 'prior committed keyword index is searchable before large job');
      const fixtureData = largeMarkdownFixture();
      assert(fixtureData.byteLength >= TARGET_BYTES - 256 && fixtureData.byteLength < MAX_SAVE_BYTES,
        'deterministic realistic Markdown approaches the supported 10 MiB save limit');
      for (let i = 0; i < SAMPLE_COUNTS.close; i += 1) {
        windows.push(new BrowserWindow({ show: false, width: 200, height: 120 }));
      }
      const focused = new BrowserWindow({ show: true, width: 240, height: 160 });
      windows.push(focused);
      const activeMarker = waitForWorkerStatus(owner, value => value.active === true
        && value.phase === 'index_document', 10000, 'active document indexing');
      const saveStart = performance.now();
      const accepted = await save('large.md', fixtureData.bytes);
      const saveMs = performance.now() - saveStart;
      assert(accepted.accepted && accepted.indexing?.jobId, 'save has a durable worker ACK');
      const active = await activeMarker.catch(() => {
        assert(false, 'real document job emits an active worker indexing marker');
      });
      assert(active.active && active.phase === 'index_document'
        && active.jobId === accepted.indexing.jobId, 'real document job emits active marker for ACKed job');
      const terminalMarker = waitForWorkerStatus(owner, value => value.jobId === accepted.indexing.jobId
        && value.phase === 'completed', 45000, 'large-document completed terminal');
      const samples = [];
      const heartbeatGaps = [];
      const activeStart = performance.now();
      let lastBeat = activeStart;
      heartbeat = setInterval(() => {
        const now = performance.now();
        heartbeatGaps.push(now - lastBeat);
        lastBeat = now;
      }, 10);
      const firstProgress = await waitForWorkerStatus(owner, value => value.jobId === accepted.indexing.jobId
        && value.active && value.progress?.total > 1 && value.progress.current > 0,
      15000, 'first real chunk progress').catch(() => {
        assert(false, 'large document worker exposes a real chunk progress marker');
      });
      for (let i = 0; i < SAMPLE_COUNTS.status; i += 1) {
        const threshold = i === SAMPLE_COUNTS.status - 1 ? firstProgress.progress.total
          : i === SAMPLE_COUNTS.status - 2 ? firstProgress.progress.total - 1
            : Math.max(1, Math.floor((i + 1) * (firstProgress.progress.total - 2) / (SAMPLE_COUNTS.status - 1)));
        const progress = await waitForWorkerStatus(owner, value => value.jobId === accepted.indexing.jobId
          && value.active && value.progress?.current >= threshold && value.progress?.total === firstProgress.progress.total,
        15000, `chunk progress ${threshold}`).catch(() => {
          assert(false, 'all latency samples have event-gated real chunk progress');
        });
        const start = performance.now();
        const status = await owner.query('get_status', {}, `s22-status-${i}`);
        const end = performance.now();
        samples.push({ kind: 'status', ms: end - start, startMs: start - activeStart,
          endMs: end - activeStart, active: status.active, jobId: status.jobId,
          workerProgress: progress.progress.current });
        if (i % 2 === 0) {
          const focusStart = performance.now();
          focused.focus();
          const focusEnd = performance.now();
          samples.push({ kind: 'focus', ms: focusEnd - focusStart,
            startMs: focusStart - activeStart, endMs: focusEnd - activeStart,
            active: owner.getStatus().active, jobId: owner.getStatus().jobId });
          const closing = windows.shift();
          const closeStart = performance.now();
          closing.close();
          const closeEnd = performance.now();
          samples.push({ kind: 'close', ms: closeEnd - closeStart,
            startMs: closeStart - activeStart, endMs: closeEnd - activeStart,
            active: owner.getStatus().active, jobId: owner.getStatus().jobId });
        }
      }
      const terminal = await terminalMarker;
      const activeEnd = performance.now();
      clearInterval(heartbeat);
      heartbeat = null;
      const heartbeatTickCount = heartbeatGaps.length;
      heartbeatGaps.push(activeEnd - lastBeat);
      assert(heartbeatGaps.length === heartbeatTickCount + 1
        && Math.abs(heartbeatGaps.at(-1) - (activeEnd - lastBeat)) < 0.1,
      'main heartbeat includes the terminal interval');
      assert(terminal.jobId === accepted.indexing.jobId,
        'real supported-upper-bound document reaches worker completion');
      assert(samples.length === 100 && samples.filter(value => value.kind === 'status').length === SAMPLE_COUNTS.status
        && samples.filter(value => value.kind === 'focus').length === SAMPLE_COUNTS.focus
        && samples.filter(value => value.kind === 'close').length === SAMPLE_COUNTS.close
        && samples.every(value => value.active && value.jobId === accepted.indexing.jobId),
      'all predeclared close/focus/status samples overlap the ACKed worker job');
      const byKind = Object.fromEntries(['status', 'focus', 'close'].map(kind => {
        const values = samples.filter(value => value.kind === kind).map(value => value.ms);
        return [kind, { p95: percentile(values, .95), p99: percentile(values, .99),
          max: Math.max(...values) }];
      }));
      const heartbeatMax = Math.max(...heartbeatGaps);
      console.error(`S22_SPAN ${JSON.stringify({ activeWindowMs: activeEnd - activeStart,
        lastSampleEndMs: samples.at(-1).endMs, heartbeatCount: heartbeatGaps.length,
        heartbeatMax, byKind })}`);
      assert(heartbeatGaps.length >= 2 && activeEnd - activeStart >= 1000
        && samples.at(-1).endMs >= (activeEnd - activeStart) * .75
        && Object.values(byKind).every(value =>
        Number.isFinite(value.p95) && value.p95 <= 250 && value.p99 <= 500 && value.max <= 1000)
        && heartbeatMax <= 250,
      'event-spanning latency and main heartbeat bounds hold');
      const indexedQueryStart = performance.now();
      const indexed = await owner.query('query_keyword', { query: 's22fullindexproof' });
      const indexedQueryMs = performance.now() - indexedQueryStart;
      assert(indexed.length > 0, 'completed large document is keyword searchable');
      const cancelBytes = Buffer.concat([fixtureData.bytes,
        Buffer.from('Cancelled revision marker: s22cancelledrevision.\n')]);
      const cancelActive = waitForWorkerStatus(owner, value => value.active
        && value.phase === 'index_document' && value.jobId !== accepted.indexing.jobId,
      10000, 'cancel revision active');
      const cancelTerminal = waitForWorkerStatus(owner, value => value.phase === 'cancelled'
        && value.jobId !== accepted.indexing.jobId, 15000, 'cancel revision terminal');
      const cancelAck = await save('large.md', cancelBytes, 'update');
      assert(cancelAck.accepted && cancelAck.indexing?.jobId
        && cancelAck.indexing.jobId !== accepted.indexing.jobId,
      'updated large Markdown receives a second durable ACK');
      const cancelActiveStatus = await cancelActive;
      assert(cancelActiveStatus.jobId === cancelAck.indexing.jobId,
        'cancel targets the second active large-document revision');
      const cancelStart = performance.now();
      const cancel = await owner.cancel(cancelAck.indexing.jobId, 's22-cancel');
      const cancelMs = performance.now() - cancelStart;
      assert(cancel.cancelled && cancelMs <= 1000,
        'active real document cancellation receives a bounded worker-owned receipt');
      const cancelled = await cancelTerminal;
      assert(cancelled.jobId === cancelAck.indexing.jobId,
        'cancelled large document revision reaches terminal worker status');
      assert(sha(fs.readFileSync(path.join(storeRoot, 'large.md'))) === sha(cancelBytes),
        'cancel leaves published large Markdown bytes unchanged');
      const priorQueryStart = performance.now();
      const after = await owner.query('query_keyword', { query: 's22fullindexproof' });
      const priorQueryAfterCancelMs = performance.now() - priorQueryStart;
      assert(after.length > 0, 'cancel retains prior committed large-document index');
      const metrics = { sourceHash: process.env.DOCULIGHT_R3_SOURCE_HASH,
        node: process.version, electron: process.versions.electron, abi: process.versions.modules,
        platform: process.platform, arch: process.arch,
        fixtureBytes: fixtureData.byteLength, fixtureSha256: fixtureData.sha256,
        cancelledRevisionBytes: cancelBytes.length, cancelledRevisionSha256: sha(cancelBytes),
        warmJobId: warmAck.indexing.jobId, jobId: accepted.indexing.jobId,
        cancelJobId: cancelAck.indexing.jobId, workerThreadId: ready.threadId,
        workerOpenAudit: ready.audit, expectedSampleCounts: SAMPLE_COUNTS,
        samples, byKind, saveMs, indexedQueryMs, priorQueryAfterCancelMs, cancelMs,
        heartbeatGaps, heartbeatMax, activeWindowMs: activeEnd - activeStart,
        markers: { warmTerminal: true, saveAck: true, active: true,
          firstChunkProgress: true, fullIndexTerminal: true, cancelActive: true,
          cancelledTerminal: true, savedFilePreserved: true, priorCommittedIndexPreserved: true } };
      console.error(`S22_METRICS ${JSON.stringify(metrics)}`);
      finished = true;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      for (const window of windows) if (!window.isDestroyed()) window.destroy();
      if (!finished && owner.worker) await owner.worker.terminate();
      await owner.shutdown();
    }
  }
};
