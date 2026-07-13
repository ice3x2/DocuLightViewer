'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const modulePath = path.join(__dirname, '..', 'src', 'renderer', 'settings-status-poller.js');
assert(fs.existsSync(modulePath), 'Settings status poller is implemented as a testable runtime module');
const { createSettingsStatusPoller } = require(modulePath);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createFakeScheduler() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeoutFn(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeoutFn(id) {
      timers.delete(id);
    },
    pending() {
      return Array.from(timers.entries()).map(([id, timer]) => ({ id, ...timer }));
    },
    fire(id) {
      const timer = timers.get(id);
      assert(timer, `timer ${id} exists`);
      timers.delete(id);
      return timer.callback();
    }
  };
}

(async () => {
  const scheduler = createFakeScheduler();
  const indexingFirst = deferred();
  const embeddingFirst = deferred();
  let indexingCalls = 0;
  let embeddingCalls = 0;

  const poller = createSettingsStatusPoller({
    refreshIndexingStatus() {
      indexingCalls += 1;
      return indexingFirst.promise;
    },
    refreshEmbeddingStatus() {
      embeddingCalls += 1;
      return embeddingFirst.promise;
    },
    isActive(status) {
      return Boolean(status && status.active);
    },
    activeDelayMs: 500,
    idleDelayMs: 3000,
    setTimeoutFn: scheduler.setTimeoutFn,
    clearTimeoutFn: scheduler.clearTimeoutFn
  });

  const firstCycle = poller.start();
  const overlappingCycle = poller.pollNow();
  assert.strictEqual(firstCycle, overlappingCycle, 'overlapping poll requests share the same cycle Promise');
  assert.strictEqual(indexingCalls, 1, 'overlapping cycle calls indexing IPC exactly once');
  assert.strictEqual(embeddingCalls, 1, 'overlapping cycle calls embedding IPC exactly once');
  assert.strictEqual(scheduler.pending().length, 0, 'no next timer is scheduled while requests are in flight');

  indexingFirst.resolve({ active: true });
  embeddingFirst.resolve({ status: 'connected' });
  await firstCycle;
  assert.deepStrictEqual(scheduler.pending().map((timer) => timer.delay), [500], 'active status schedules exactly one 500ms timer');

  poller.stop();
  assert.strictEqual(scheduler.pending().length, 0, 'stop/unload clears the pending timer');
  await poller.pollNow();
  assert.strictEqual(indexingCalls, 1, 'stopped poller does not call indexing IPC again');
  assert.strictEqual(embeddingCalls, 1, 'stopped poller does not call embedding IPC again');

  const recoveryScheduler = createFakeScheduler();
  let recoveryIndexingCalls = 0;
  let recoveryEmbeddingCalls = 0;
  const recoveryPoller = createSettingsStatusPoller({
    refreshIndexingStatus() {
      recoveryIndexingCalls += 1;
      if (recoveryIndexingCalls === 1) return Promise.reject(new Error('synthetic indexing IPC failure'));
      return Promise.resolve({ active: false });
    },
    refreshEmbeddingStatus() {
      recoveryEmbeddingCalls += 1;
      return Promise.resolve({ status: 'unset' });
    },
    isActive(status) {
      return Boolean(status && status.active);
    },
    activeDelayMs: 500,
    idleDelayMs: 3000,
    setTimeoutFn: recoveryScheduler.setTimeoutFn,
    clearTimeoutFn: recoveryScheduler.clearTimeoutFn
  });

  await recoveryPoller.start();
  assert.deepStrictEqual(recoveryScheduler.pending().map((timer) => timer.delay), [3000], 'rejected indexing IPC still schedules exactly one recovery timer');
  const recoveryTimer = recoveryScheduler.pending()[0];
  await recoveryScheduler.fire(recoveryTimer.id);
  assert.strictEqual(recoveryIndexingCalls, 2, 'next timer retries indexing IPC after rejection');
  assert.strictEqual(recoveryEmbeddingCalls, 2, 'next timer refreshes embedding status with the retry');
  assert.deepStrictEqual(recoveryScheduler.pending().map((timer) => timer.delay), [3000], 'retry cycle leaves exactly one idle timer');
  recoveryPoller.stop();

  const stopDuringFlightScheduler = createFakeScheduler();
  const stopIndexing = deferred();
  const stopEmbedding = deferred();
  let stopIndexingCalls = 0;
  let stopEmbeddingCalls = 0;
  const stopDuringFlightPoller = createSettingsStatusPoller({
    refreshIndexingStatus() {
      stopIndexingCalls += 1;
      return stopIndexing.promise;
    },
    refreshEmbeddingStatus() {
      stopEmbeddingCalls += 1;
      return stopEmbedding.promise;
    },
    isActive: () => true,
    activeDelayMs: 500,
    idleDelayMs: 3000,
    setTimeoutFn: stopDuringFlightScheduler.setTimeoutFn,
    clearTimeoutFn: stopDuringFlightScheduler.clearTimeoutFn
  });
  const stoppedCycle = stopDuringFlightPoller.start();
  stopDuringFlightPoller.stop();
  stopIndexing.resolve({ active: true });
  stopEmbedding.resolve({ status: 'connected' });
  await stoppedCycle;
  assert.strictEqual(stopDuringFlightScheduler.pending().length, 0, 'an in-flight cycle that resolves after unload schedules no timer');
  assert.strictEqual(stopIndexingCalls, 1, 'stop during flight does not duplicate indexing IPC');
  assert.strictEqual(stopEmbeddingCalls, 1, 'stop during flight does not duplicate embedding IPC');

  const hangingScheduler = createFakeScheduler();
  const hangingIndexing = deferred();
  let hangingIndexingCalls = 0;
  let completedEmbeddingCalls = 0;
  const hangingPoller = createSettingsStatusPoller({
    refreshIndexingStatus() {
      hangingIndexingCalls += 1;
      return hangingIndexing.promise;
    },
    refreshEmbeddingStatus() {
      completedEmbeddingCalls += 1;
      return Promise.resolve({ status: 'connected' });
    },
    isActive: () => true,
    activeDelayMs: 500,
    idleDelayMs: 3000,
    setTimeoutFn: hangingScheduler.setTimeoutFn,
    clearTimeoutFn: hangingScheduler.clearTimeoutFn
  });
  const hangingCycle = hangingPoller.start();
  assert.strictEqual(hangingPoller.pollNow(), hangingCycle, 'a hung IPC keeps later polls coalesced into the same cycle');
  await Promise.resolve();
  assert.strictEqual(completedEmbeddingCalls, 1, 'the non-hanging peer IPC completes once');
  assert.strictEqual(hangingScheduler.pending().length, 0, 'a hung IPC cannot create a timer backlog');
  hangingPoller.stop();
  hangingIndexing.resolve({ active: true });
  await hangingCycle;
  assert.strictEqual(hangingScheduler.pending().length, 0, 'stopping a hung cycle prevents post-resolution scheduling');
  assert.strictEqual(hangingIndexingCalls, 1, 'hung indexing IPC remains single-flight');

  console.log('test-settings-status-poller-contract: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
