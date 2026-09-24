'use strict';

const assert = require('node:assert/strict');
const { createSettingsStatusPoller } = require('../src/renderer/settings-status-poller');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fakeScheduler() {
  const timers = new Map();
  let nextId = 1;
  return {
    setTimeoutFn(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeoutFn(id) { timers.delete(id); },
    pending() { return [...timers.entries()].map(([id, timer]) => ({ id, ...timer })); },
    fire(id) {
      const timer = timers.get(id);
      assert.ok(timer, 'scheduled timer exists');
      timers.delete(id);
      return timer.callback();
    }
  };
}

(async () => {
  let embeddingCalls = 0;
  const forbiddenEmbedding = () => { embeddingCalls++; throw Error('embedding status was requested'); };

  const scheduler = fakeScheduler();
  const first = deferred();
  let calls = 0;
  const poller = createSettingsStatusPoller({
    refreshIndexingStatus: () => { calls++; return first.promise; },
    refreshEmbeddingStatus: forbiddenEmbedding,
    isActive: status => Boolean(status && status.active),
    activeDelayMs: 500, idleDelayMs: 3000, ...scheduler
  });
  const cycle = poller.start();
  assert.strictEqual(poller.pollNow(), cycle, 'overlapping polls share one cycle');
  assert.equal(calls, 1, 'indexing refresh is single flight');
  assert.equal(embeddingCalls, 0, 'embedding status is never requested');
  assert.equal(scheduler.pending().length, 0, 'in-flight cycle schedules no timer');
  first.resolve({ active: true });
  await cycle;
  assert.deepEqual(scheduler.pending().map(timer => timer.delay), [500], 'active cycle schedules one 500ms timer');
  poller.stop();
  assert.equal(scheduler.pending().length, 0, 'stop clears pending timer');
  await poller.pollNow();
  assert.equal(calls, 1, 'post-stop poll cannot call indexing again');

  const recoveryScheduler = fakeScheduler();
  let recoveryCalls = 0;
  const recovery = createSettingsStatusPoller({
    refreshIndexingStatus() {
      recoveryCalls++;
      return recoveryCalls === 1 ? Promise.reject(Error('synthetic indexing failure')) : Promise.resolve({ active: false });
    },
    refreshEmbeddingStatus: forbiddenEmbedding,
    isActive: status => Boolean(status && status.active),
    activeDelayMs: 500, idleDelayMs: 3000, ...recoveryScheduler
  });
  await recovery.start();
  assert.deepEqual(recoveryScheduler.pending().map(timer => timer.delay), [3000], 'rejection schedules one recovery timer');
  await recoveryScheduler.fire(recoveryScheduler.pending()[0].id);
  assert.equal(recoveryCalls, 2, 'next cycle retries rejected indexing request');
  assert.deepEqual(recoveryScheduler.pending().map(timer => timer.delay), [3000], 'retry leaves one idle timer');
  recovery.stop();
  assert.equal(recoveryScheduler.pending().length, 0, 'recovery stop clears timer');

  const stopScheduler = fakeScheduler();
  const pending = deferred();
  let stopCalls = 0;
  const stopped = createSettingsStatusPoller({
    refreshIndexingStatus: () => { stopCalls++; return pending.promise; },
    refreshEmbeddingStatus: forbiddenEmbedding,
    isActive: () => true,
    activeDelayMs: 500, idleDelayMs: 3000, ...stopScheduler
  });
  const stoppedCycle = stopped.start();
  stopped.stop();
  pending.resolve({ active: true });
  await stoppedCycle;
  assert.equal(stopScheduler.pending().length, 0, 'in-flight resolution after stop schedules no timer');
  assert.equal(stopCalls, 1, 'stop during flight does not duplicate indexing');
  await stopped.pollNow();
  assert.equal(stopCalls, 1, 'post-stop poll remains inert');

  const hungScheduler = fakeScheduler();
  const hung = deferred();
  let hungCalls = 0;
  const hungPoller = createSettingsStatusPoller({
    refreshIndexingStatus: () => { hungCalls++; return hung.promise; },
    refreshEmbeddingStatus: forbiddenEmbedding,
    isActive: () => true,
    activeDelayMs: 500, idleDelayMs: 3000, ...hungScheduler
  });
  const hungCycle = hungPoller.start();
  assert.strictEqual(hungPoller.pollNow(), hungCycle, 'hung refresh coalesces later polls');
  await Promise.resolve();
  assert.equal(hungScheduler.pending().length, 0, 'hung cycle creates no timer backlog');
  assert.equal(hungCalls, 1, 'hung refresh remains single flight');
  hungPoller.stop();
  hung.resolve({ active: true });
  await hungCycle;
  assert.equal(hungScheduler.pending().length, 0, 'stopped hung cycle cannot schedule after resolution');
  assert.equal(embeddingCalls, 0, 'all indexing-only scenarios avoid embedding IPC');
  console.log('test-settings-status-poller-contract: all assertions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
