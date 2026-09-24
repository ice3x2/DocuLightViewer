'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { threadId } = require('node:worker_threads');
const { OwnerWorkerController } = require('../../../src/main/search-owner-controller');
const { createWorkUnitScheduler } = require('../../../src/main/search-work-scheduler');

function waitForProgress(owner, minimum = 1) {
  let cancel;
  const promise = new Promise((resolve, reject) => {
    const worker = owner.worker;
    const timer = setTimeout(() => { worker.off('message', onMessage); reject(new Error('owner progress timed out')); }, 4000);
    cancel = () => { clearTimeout(timer); worker.off('message', onMessage); };
    function onMessage(message) {
      if (message.tag !== 'STATUS' || message.snapshot?.progress?.current < minimum) return;
      cancel();
      resolve(message);
    }
    worker.on('message', onMessage);
  });
  return { promise, cancel };
}

module.exports = {
  name: 's07',
  async run(context) {
    const order = [];
    const fair = createWorkUnitScheduler({ capacity: 2 });
    const completed = [];
    const firstDone = new Promise(resolve => { completed.push(resolve); });
    const secondDone = new Promise(resolve => { completed.push(resolve); });
    const makeJob = id => ({ id, runUnit() { order.push(id); return true; }, onProgress() {}, onDone() { completed.shift()(); } });
    context.assert(fair.enqueue(makeJob('first')) && fair.enqueue(makeJob('second')) && !fair.enqueue(makeJob('overflow')),
      'scheduler bounds queued work at configured capacity');
    await Promise.all([firstDone, secondDone]);
    context.assert(order.join(',') === 'first,second', 'scheduler executes accepted jobs in FIFO order');
    const turns = [];
    const rotating = createWorkUnitScheduler({ capacity: 2 });
    let a = 0;
    let b = 0;
    const rotationDone = [];
    const aDone = new Promise(resolve => rotationDone.push(resolve));
    const bDone = new Promise(resolve => rotationDone.push(resolve));
    rotating.enqueue({ id: 'a', runUnit() { turns.push('a'); return ++a === 3; }, onProgress() {},
      onDone() { rotationDone.shift()(); } });
    rotating.enqueue({ id: 'b', runUnit() { turns.push('b'); return ++b === 3; }, onProgress() {},
      onDone() { rotationDone.shift()(); } });
    await Promise.all([aDone, bDone]);
    context.assert(turns.join('') === 'ababab', 'bounded scheduler rotates queued jobs after each committed unit');
    let asyncError = null;
    const atomic = createWorkUnitScheduler();
    await new Promise(resolve => {
      atomic.enqueue({ id: 'async-unit', runUnit: () => Promise.resolve(true), onProgress() {},
        onDone() { resolve(); }, onError(error) { asyncError = error; resolve(); } });
    });
    context.assert(asyncError?.code === 'owner_async_unit', 'work unit rejects asynchronous transaction boundary');
    let callbackCalls = 0;
    const callbackScheduler = createWorkUnitScheduler({ capacity: 2 });
    const callbackFinished = new Promise(resolve => {
      callbackScheduler.enqueue({ id: 'callback-error', runUnit: () => true, onProgress() {},
        onDone() { callbackCalls += 1; if (callbackCalls === 1) throw new Error('callback failed'); } });
      callbackScheduler.enqueue({ id: 'following-job', runUnit: () => true, onProgress() {}, onDone: resolve });
    });
    await callbackFinished;
    context.assert(callbackCalls === 1, 'failed completion callback is not invoked twice');
    const root = context.fixture.root;
    const sourceRoot = path.join(root, 'store');
    fs.mkdirSync(sourceRoot);
    const saved = path.join(sourceRoot, 'saved.md');
    const imported = path.join(sourceRoot, 'imported.md');
    fs.writeFileSync(saved, '# saved\n');
    fs.writeFileSync(imported, '# imported\n');
    const owner = new OwnerWorkerController({
      ledgerPath: path.join(root, 'smart-search.sqlite3'), keywordPath: path.join(root, 'search-index.sqlite3'),
      sourceRoot, r3SchedulerFixture: true
    });
    try {
      const ready = await owner.start();
      context.assert(ready.threadId > 0 && ready.threadId !== threadId && ready.audit.openCount === 2,
        'REL-DOC-007 real owner opens both SQLite connections on sole worker');
      const progress = waitForProgress(owner);
      const job = owner.command('accept_save', { r3SchedulerUnits: 256, testTarget: 'revision-1' }, 'job-1').catch(error => error);
      const first = await Promise.race([progress.promise, job]);
      progress.cancel();
      context.assert(first.tag === 'STATUS' && first.snapshot.progress.current === 1,
        'FR-DOC-019 real owner scheduler runs first committed SQLite work unit');
      const laterProgress = waitForProgress(owner, 2);
      const flood = await Promise.all(Array.from({ length: 40 }, (_, i) =>
        owner.query('get_status', {}, `flood-status-${i}`)));
      const second = await laterProgress.promise;
      laterProgress.cancel();
      context.assert(flood.length === 40 && second.snapshot.progress.current >= 2,
        'cached status flood does not starve scheduled SQLite work');
      const started = performance.now();
      const cancelStatus = new Promise(resolve => {
        const onMessage = message => {
          if (message.tag !== 'STATUS' || message.snapshot?.phase !== 'cancel_requested') return;
          owner.worker.off('message', onMessage);
          resolve(message);
        };
        owner.worker.on('message', onMessage);
      });
      const [query, status, cancel] = await Promise.all([
        owner.query('query_keyword', { r3SchedulerCount: true }, 'query-1'),
        owner.query('get_status', {}, 'status-1'),
        owner.cancel('revision-1', 'cancel-1')
      ]);
      const latency = performance.now() - started;
      const cancellationSnapshot = await cancelStatus;
      const done = await job;
      context.assert(query.count >= 1 && query.count < 256, 'read-only query overlaps unfinished owner SQLite work');
      context.assert(status.sequence >= first.sequence && status.active, 'cached status responds during owner workload');
      context.assert(cancel.cancelled && done.cancelled && done.current < 256, 'target cancel stops at committed unit boundary');
      context.assert(cancellationSnapshot.snapshot.progress.current >= 1,
        'cancel-requested cached status retains committed progress');
      context.assert(latency <= 1000, 'query/status/cancel group stays below 1000ms');
      context.assert(fs.readFileSync(saved, 'utf8') === '# saved\n' && fs.readFileSync(imported, 'utf8') === '# imported\n',
        'cancel leaves saved and completed import files untouched');
      const absent = await owner.cancel('other-revision', 'absent');
      context.assert(absent.cancelled === false, 'cancel targets one job identity');
      console.error(`S07_MEASURE query_status_cancel_ms=${latency.toFixed(3)} committed_units=${done.current} total=256`);
    } finally {
      await owner.shutdown();
    }
  }
};
