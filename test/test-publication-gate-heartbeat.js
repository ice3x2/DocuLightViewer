'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { publishSave, withPublicationGate } = require('../src/main/index-ingress-store');
const { processIdentity, currentProcessIdentity,
  cachedCurrentProcessIdentity } = require('../src/main/process-owner-identity');

// @req IR-APP-013 AC-13 REL-DOC-007 AC-2 REL-DOC-009 AC-2
async function run() {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, 'doculight-gate-heartbeat-'));
  const storeRoot = path.join(root, 'store');
  const ingressRoot = path.join(root, 'ingress');
  fs.mkdirSync(storeRoot);
  fs.mkdirSync(ingressRoot);
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  const body = Buffer.from('# active save heartbeat\n');
  const base = { storeRoot, ingressRoot, operation: 'save_document',
    sourceId: 'src_heartbeat', rootFingerprint: sha(path.resolve(storeRoot)),
    contentBytes: body, contentHash: sha(body),
    provenance: { aliases: [], metadata: {} } };
  const ticks = [];
  const started = performance.now();
  const timer = setInterval(() => ticks.push(performance.now()), 10);
  try {
    const phases = [];
    for (const locator of ['first.md', 'second.md']) {
      const phaseStart = performance.now();
      const receipt = await publishSave({ ...base, sourceRelativeLocator: locator });
      phases.push({ locator, durationMs: performance.now() - phaseStart });
      assert(receipt.saved === true, `${locator} publishes a durable file`);
    }
    await new Promise(resolve => setTimeout(resolve, 30));
    const stopped = performance.now();
    const gaps = [ticks[0] - started,
      ...ticks.slice(1).map((tick, index) => tick - ticks[index]),
      stopped - ticks.at(-1)];
    const heartbeatMaxGapMs = Math.max(...gaps);
    console.log(JSON.stringify({ phases, heartbeatMaxGapMs, tickCount: ticks.length }));
    assert(ticks.length >= 2 && heartbeatMaxGapMs <= 250,
      `publication gate blocks main heartbeat for ${heartbeatMaxGapMs} ms`);
    let releaseHolder;
    let holderEntered;
    const entered = new Promise(resolve => { holderEntered = resolve; });
    let holderActive = false;
    const holder = withPublicationGate(ingressRoot, async () => {
      holderActive = true;
      holderEntered();
      await new Promise(resolve => { releaseHolder = resolve; });
      holderActive = false;
    });
    await entered;
    const contentionTicks = [];
    const contentionStart = performance.now();
    const contentionTimer = setInterval(() => contentionTicks.push(performance.now()), 10);
    let contenderCount = 0;
    let tookOverLiveLock = false;
    const releaseTimer = setTimeout(() => releaseHolder(), 120);
    try {
      const enter = () => {
        contenderCount += 1;
        tookOverLiveLock = holderActive;
      };
      const firstContender = withPublicationGate(ingressRoot, enter);
      const secondContender = withPublicationGate(ingressRoot, enter);
      await Promise.all([holder, firstContender, secondContender]);
    } finally {
      clearTimeout(releaseTimer);
      clearInterval(contentionTimer);
      if (releaseHolder) releaseHolder();
    }
    const contentionEnd = performance.now();
    const contentionGaps = [contentionTicks[0] - contentionStart,
      ...contentionTicks.slice(1).map((tick, index) => tick - contentionTicks[index]),
      contentionEnd - contentionTicks.at(-1)];
    const contentionHeartbeatMaxGapMs = Math.max(...contentionGaps);
    console.log(JSON.stringify({ contentionHeartbeatMaxGapMs, contenderCount,
      tookOverLiveLock }));
    assert(contentionTicks.length >= 2 && contentionHeartbeatMaxGapMs <= 250
      && contenderCount === 2 && !tookOverLiveLock,
    `held publication gate blocks heartbeat or permits takeover: ${contentionHeartbeatMaxGapMs} ms`);
    const asyncIdentity = await currentProcessIdentity();
    assert.strictEqual(cachedCurrentProcessIdentity(), asyncIdentity,
      'gate reuses the resolved current-PID identity');
    assert.strictEqual(asyncIdentity, processIdentity(process.pid),
      'async identity matches the existing synchronous recovery identity');
    if (process.platform === 'win32') assert.match(asyncIdentity, /^\d{15,20}$/,
      'Windows lock retains a real process start identity');
  } finally {
    clearInterval(timer);
    const resolved = fs.realpathSync.native(root);
    assert.strictEqual(path.dirname(resolved).toLowerCase(), tempRoot.toLowerCase());
    fs.rmSync(root, { recursive: true });
  }
}

run().then(() => console.log('test-publication-gate-heartbeat: all assertions passed'),
  error => { console.error(error.stack || String(error)); process.exitCode = 1; });
