'use strict';

// @req FR-DOC-019 REL-DOC-007
function createWorkUnitScheduler({ capacity = 32 } = {}) {
  const pending = [];
  let active = null;
  let scheduled = false;

  function schedule() {
    if (scheduled || (!active && pending.length === 0)) return;
    scheduled = true;
    setImmediate(runNextUnit);
  }

  function runNextUnit() {
    scheduled = false;
    if (!active) active = pending.shift() || null;
    if (!active) return;
    const job = active;
    if (job.cancelRequested) {
      active = null;
      job.onDone(true);
      schedule();
      return;
    }
    let done;
    try {
      // runUnit is synchronous: each caller owns one complete transaction.
      done = job.runUnit();
      if (done && typeof done.then === 'function') {
        const error = new Error('work unit must finish synchronously');
        error.code = 'owner_async_unit';
        throw error;
      }
    } catch (error) {
      active = null;
      if (job.onError) job.onError(error);
      else job.onDone(false, error);
      schedule();
      return;
    }
    try {
      job.onProgress();
      if (done || job.cancelRequested) {
        active = null;
        job.onDone(Boolean(job.cancelRequested));
      } else {
        active = null;
        pending.push(job);
      }
    } catch (error) {
      active = null;
      if (job.onError) job.onError(error);
    }
    schedule();
  }

  return {
    enqueue(job) {
      if (pending.length + Number(Boolean(active)) >= capacity ||
          typeof job?.id !== 'string' || typeof job.runUnit !== 'function' ||
          typeof job.onDone !== 'function' || typeof job.onProgress !== 'function' ||
          active?.id === job.id || pending.some(item => item.id === job.id)) return false;
      pending.push(job);
      schedule();
      return true;
    },
    cancel(id) {
      const job = active?.id === id ? active : pending.find(item => item.id === id);
      if (!job) return false;
      job.cancelRequested = true;
      schedule();
      return true;
    },
    get active() { return active; }
  };
}

module.exports = { createWorkUnitScheduler };
