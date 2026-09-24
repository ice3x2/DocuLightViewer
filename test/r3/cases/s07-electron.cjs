'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow } = require('electron');
const { OwnerWorkerController } = require('../../../src/main/search-owner-controller');
const nodeCase = require('./s07.cjs');

function percentile(values, fraction) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil(ordered.length * fraction) - 1];
}

function waitForProgress(owner, minimum) {
  if (owner.getStatus().progress.current >= minimum) return Promise.resolve(owner.getStatus());
  return new Promise((resolve, reject) => {
    const worker = owner.worker;
    const timer = setTimeout(() => { worker.off('message', onMessage); reject(new Error('active owner progress timed out')); }, 4000);
    function onMessage(message) {
      if (message.tag !== 'STATUS' || message.snapshot?.progress?.current < minimum) return;
      clearTimeout(timer);
      worker.off('message', onMessage);
      resolve(message.snapshot);
    }
    worker.on('message', onMessage);
  });
}

module.exports = {
  name: 's07',
  async run(context) {
    await nodeCase.run(context);
    const sourceRoot = path.join(context.fixture.root, 'electron-store');
    fs.mkdirSync(sourceRoot);
    const owner = new OwnerWorkerController({
      ledgerPath: path.join(context.fixture.root, 's07-electron-ledger.sqlite3'),
      keywordPath: path.join(context.fixture.root, 's07-electron-keyword.sqlite3'),
      sourceRoot, r3SchedulerFixture: true
    });
    let lastBeat = performance.now();
    let maxGap = 0;
    const heartbeatGaps = [];
    let samplingActive = false;
    const heartbeat = setInterval(() => {
      const now = performance.now();
      if (samplingActive) {
        const gap = now - lastBeat;
        heartbeatGaps.push(gap);
        maxGap = Math.max(maxGap, gap);
      }
      lastBeat = now;
    }, 10);
    const latencies = [];
    let window;
    try {
      const ready = await owner.start();
      context.assert(ready.audit.openCount === 2, 'Electron S07 uses real two-DB owner worker');
      window = new BrowserWindow({ show: true, width: 320, height: 200 });
      const progress = new Promise(resolve => {
        const onMessage = message => {
          if (message.tag !== 'STATUS' || message.snapshot?.progress?.current !== 1) return;
          owner.worker.off('message', onMessage);
          resolve(message);
        };
        owner.worker.on('message', onMessage);
      });
      const job = owner.command('accept_save', {
        r3SchedulerUnits: 20000, r3SchedulerCpuIterations: 250000, testTarget: 'electron-revision'
      }, 'electron-job');
      job.catch(() => {});
      const first = await progress;
      const samples = [];
      const activeStart = performance.now();
      lastBeat = activeStart;
      samplingActive = true;
      for (let i = 0; i < 60; i += 1) {
        const start = performance.now();
        const snapshot = await owner.query('get_status', {}, `electron-status-${i}`);
        const end = performance.now();
        latencies.push(end - start);
        samples.push({ kind: 'status', startMs: start, endMs: end, active: snapshot.active, progress: snapshot.progress.current });
        if (i % 10 === 0) {
          const focusStart = performance.now();
          window.focus();
          const focusEnd = performance.now();
          latencies.push(focusEnd - focusStart);
          samples.push({ kind: 'focus', startMs: focusStart, endMs: focusEnd, active: owner.getStatus().active, progress: owner.getStatus().progress.current });
        }
        await waitForProgress(owner, snapshot.progress.current + 20);
      }
      const closeStart = performance.now();
      window.close();
      const closeEnd = performance.now();
      latencies.push(closeEnd - closeStart);
      samples.push({ kind: 'close', startMs: closeStart, endMs: closeEnd, active: owner.getStatus().active, progress: owner.getStatus().progress.current });
      const activeEnd = performance.now();
      samplingActive = false;
      context.assert(activeEnd - activeStart >= 300 && heartbeatGaps.length >= 2 &&
        samples.every(item => item.active) && samples.at(-1).progress >= first.snapshot.progress.current + 20,
        'Electron sample window spans sustained active owner progress and two heartbeat ticks');
      const cancelStart = performance.now();
      const cancelled = await owner.cancel('electron-revision', 'electron-cancel');
      const cancelMs = performance.now() - cancelStart;
      const done = await job;
      clearInterval(heartbeat);
      const p95 = percentile(latencies, 0.95);
      const p99 = percentile(latencies, 0.99);
      const max = Math.max(...latencies);
      context.assert(cancelled.cancelled && done.cancelled && done.current < 20000,
        'Electron cancel stops unfinished owner SQLite workload');
      context.assert(latencies.length === 67 && p95 <= 250 && p99 <= 500 && max <= 1000,
        'Electron focus/close/status latency meets S07 bounds');
      context.assert(cancelMs <= 1000 && maxGap <= 250, 'Electron cancel and main heartbeat meet S07 bounds');
      console.error(`S07_ELECTRON_MEASURE ${JSON.stringify({ sampleCount: latencies.length, samples: samples.map(item => ({ ...item, startMs: +item.startMs.toFixed(3), endMs: +item.endMs.toFixed(3) })), activeStartMs: +activeStart.toFixed(3), activeEndMs: +activeEnd.toFixed(3), latencyMs: latencies.map(x => +x.toFixed(3)), p95Ms: +p95.toFixed(3), p99Ms: +p99.toFixed(3), maxMs: +max.toFixed(3), cancelMs: +cancelMs.toFixed(3), heartbeatGapMs: heartbeatGaps.map(x => +x.toFixed(3)), heartbeatMaxGapMs: +maxGap.toFixed(3), committedUnits: done.current, totalUnits: 20000 })}`);
    } finally {
      clearInterval(heartbeat);
      if (window && !window.isDestroyed()) window.destroy();
      await owner.shutdown();
    }
  }
};
